"""Phase 6 chaos/regression tests for the mobile offline-outbox design
(static/erp/mobile.js's MApp.Outbox + Sync Issues tray).

test_rpc.py already proves the base idempotency guarantee (a replayed
X-Mutation-Id with the SAME args returns the stored envelope instead of
re-running). This file proves a sharper, previously-untested corner of
that same mechanism that the outbox leans on:

rpc.py's call() caches whatever `spec.func` produces under the mutation_id
*unconditionally* -- including a business rejection ({success:false} from
a caught ValueError), not just a success. So a mutation that failed once
is "burned" under that mutation_id forever, identically to a mutation that
succeeded once. This has a real consequence for the Sync Issues tray's
manual "Retry" action: retrying a failed entry MUST mint a fresh
mutation_id, or it will just replay the original failure forever, even
after whatever caused it (a missing reason, a deleted process) is fixed.
That fix lives in offline-cache.js's outboxRetry()/mobile.js's
SyncIssues.retry() -- this file locks in the server-side behavior that
fix depends on, at the one layer this repo can exercise without a real
browser (no Playwright/browser-automation tooling is available here, so
true airplane-mode/two-tab browser tests aren't -- see PR description).
"""

from __future__ import annotations

import uuid


def _rpc(client, method, args, mutation_id):
    return client.post(
        f"/api/erp/rpc/{method}",
        json={"args": args},
        headers={"X-Mutation-Id": mutation_id},
    )


def _unique_name(prefix: str) -> str:
    return f"{prefix}-{uuid.uuid4().hex[:8]}"


def _create_item_with_stock(client, name: str, initial_stock: float = 10):
    resp = client.post(
        "/api/erp/rpc/saveItem",
        json={"args": [{"itemName": name, "itemInitialStock": initial_stock}]},
        headers={"X-Mutation-Id": str(uuid.uuid4())},
    )
    assert resp.get_json()["success"] is True


def test_replayed_mutation_id_ignores_changed_args_on_success(erp_client):
    """The exact scenario the outbox's ID-stability design leans on: a
    request reaches the server and succeeds, but its response is lost in
    transit -- the client retries under the SAME id. Even if the retry's
    args differ (e.g. mobile.js reconstructed the payload slightly
    differently), the server must return the FIRST result, not re-run
    with the new args (which could otherwise double-apply a stock
    adjustment or diverge from what was actually persisted).
    """
    name = _unique_name("ChaosStock")
    _create_item_with_stock(erp_client, name, initial_stock=20)

    mutation_id = str(uuid.uuid4())
    first = _rpc(
        erp_client,
        "adjustStockManually",
        [name, "", 15, "Physical recount"],
        mutation_id,
    )
    assert first.get_json()["success"] is True
    assert first.get_json()["data"] == {"oldCurrentStock": 20, "newCurrentStock": 15}

    # Same id, deliberately different newValue/reason -- must be ignored.
    second = _rpc(
        erp_client,
        "adjustStockManually",
        [name, "", 999, "A completely different reason"],
        mutation_id,
    )
    assert second.get_json() == first.get_json()

    listed = erp_client.post("/api/erp/rpc/getStockData", json={"args": []}).get_json()[
        "data"
    ]
    match = next(r for r in listed if r["name"] == name)
    assert match["currentStock"] == 15  # not 999 -- the replay never actually ran


def test_replayed_mutation_id_ignores_changed_args_on_business_failure(erp_client):
    """The sharper case: the FIRST call is a business rejection (missing
    reason), not a success. rpc.py's call() stores that {success:false}
    result under mutation_id just as unconditionally as a success would
    be. A second call under the SAME id with a now-valid reason must
    still come back with the original failure -- proving that a client
    which reuses a mutation_id for a manual "Retry" (rather than minting
    a fresh one) would be stuck replaying a stale rejection forever, even
    after the underlying problem is fixed. This is exactly why
    OfflineCache.outbox.retry() / MApp.SyncIssues.retry() must generate a
    new mutation_id when moving a failed entry back to pending.
    """
    name = _unique_name("ChaosRejected")
    _create_item_with_stock(erp_client, name, initial_stock=20)

    mutation_id = str(uuid.uuid4())
    first = _rpc(erp_client, "adjustStockManually", [name, "", 15, ""], mutation_id)
    first_body = first.get_json()
    assert first_body["success"] is False
    assert "reason" in first_body["message"].lower()

    # Same id, now with a valid reason -- must still return the ORIGINAL
    # failure, proving a naive same-id retry can never actually recover.
    second = _rpc(
        erp_client,
        "adjustStockManually",
        [name, "", 15, "Physical recount"],
        mutation_id,
    )
    assert second.get_json() == first_body

    # A genuinely fresh id (what a correct client-side "Retry" must mint)
    # succeeds normally against the same, still-unadjusted item.
    retry_mutation_id = str(uuid.uuid4())
    retried = _rpc(
        erp_client,
        "adjustStockManually",
        [name, "", 15, "Physical recount"],
        retry_mutation_id,
    )
    assert retried.get_json()["success"] is True


def test_two_devices_racing_the_same_item_last_write_wins_no_corruption(erp_client):
    """Simulates two phones that both queued an offline correction for the
    SAME item against stale on-screen data, then both replay once back
    online (e.g. device A's outbox flushes, then device B's). Per Round 3's
    own scope decision, adjustStockManually does an unconditional
    overwrite with no precondition check on the prior value -- so this
    isn't a design gap needing conflict detection, just last-write-wins.
    The guarantee worth locking in: both replay as ordinary, independent
    successful mutations (distinct mutation_ids) and the final stock value
    is deterministically whichever replayed last -- no crash, no silently
    dropped write, no double-application of either.
    """
    name = _unique_name("ChaosRace")
    _create_item_with_stock(erp_client, name, initial_stock=50)

    device_a_id = str(uuid.uuid4())
    device_b_id = str(uuid.uuid4())

    resp_a = _rpc(
        erp_client,
        "adjustStockManually",
        [name, "", 30, "Device A recount"],
        device_a_id,
    )
    assert resp_a.get_json()["success"] is True
    assert resp_a.get_json()["data"] == {"oldCurrentStock": 50, "newCurrentStock": 30}

    resp_b = _rpc(
        erp_client,
        "adjustStockManually",
        [name, "", 45, "Device B recount"],
        device_b_id,
    )
    assert resp_b.get_json()["success"] is True
    # Device B's replay reads whatever device A just committed as "old".
    assert resp_b.get_json()["data"] == {"oldCurrentStock": 30, "newCurrentStock": 45}

    listed = erp_client.post("/api/erp/rpc/getStockData", json={"args": []}).get_json()[
        "data"
    ]
    match = next(r for r in listed if r["name"] == name)
    assert match["currentStock"] == 45  # device B (the later replay) wins, cleanly

    history = erp_client.post(
        "/api/erp/rpc/getStockAdjustmentHistory", json={"args": []}
    ).get_json()["data"]
    reasons = [
        h["reason"]
        for h in history
        if h.get("itemName") == name or h.get("item") == name
    ]
    assert "Device A recount" in reasons
    assert (
        "Device B recount" in reasons
    )  # both writes actually landed, not one clobbering the audit trail


def test_stale_process_reference_on_replay_is_ordinary_rejection_not_crash(erp_client):
    """Item 1's scope decision (mobile.js's saveProduction catch-block
    comment) was that a stale processId referenced by a queued lot -- the
    process was deleted server-side before the offline entry replayed --
    doesn't need special detection: it should just surface as an ordinary
    {success:false}. Proves that specifically: a mutation_id minted while
    the process still existed, replayed (same id -- simulating "lost
    response, client retries automatically") after the process id no
    longer resolves, must come back as a clean business rejection with a
    real message, not a 500 or an unhandled exception.
    """
    mutation_id = str(uuid.uuid4())
    bogus_process_id = "no-such-process-" + uuid.uuid4().hex[:8]

    resp = _rpc(
        erp_client,
        "saveProduction",
        [{"processId": bogus_process_id, "assignedTo": "Someone"}],
        mutation_id,
    )
    assert resp.status_code == 200
    body = resp.get_json()
    assert body["success"] is False
    assert (
        "not found" in body["message"].lower() or "deleted" in body["message"].lower()
    )

    # A same-id replay (the outbox's automatic retry path) is just as
    # clean -- the cached rejection, not a re-run that could throw again.
    replay = _rpc(
        erp_client,
        "saveProduction",
        [{"processId": bogus_process_id, "assignedTo": "Someone"}],
        mutation_id,
    )
    assert replay.get_json() == body

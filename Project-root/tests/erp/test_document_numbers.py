"""Same-second saves must not collide.

The generated identifiers are second-resolution (PFX-YYYYMMDD-HHMMSS), so
this is not a rare edge: the CI suite runs in about two minutes and hit it on
most runs, while the same suite takes 28 minutes on a developer machine and
never did. A faster production server makes it MORE likely, and several
operators on a shop floor is exactly the load that puts two saves in one
second.

Before 042_unique_document_ids.sql the two failure modes differed. A return
was rejected with "already exists. Please use a unique return number" -- an
instruction the operator cannot act on, about a number they never chose. An
issue or a wastage raised nothing at all and wrote a second document under
the same id, which is worse: nothing surfaces until someone searches for one
and gets back two.

The clock is frozen here rather than raced, because a test that depends on
two real saves landing in the same second is a test that passes on a slow
machine for the wrong reason.
"""

from datetime import datetime
from unittest.mock import MagicMock

import pytest

from app.erp.services import document_numbers

FROZEN = datetime(2026, 9, 3, 8, 31, 11)
BASE = "RET-20260903-083111"


def _cursor(taken):
    """A cursor whose uniqueness probe reports `taken` as already used."""
    cur = MagicMock()
    state = {}

    def execute(query, params):
        state["hit"] = params[0].lower() in {t.lower() for t in taken}

    cur.execute.side_effect = execute
    cur.fetchone.side_effect = lambda: (1,) if state.get("hit") else None
    return cur


def test_free_number_is_returned_unchanged():
    """The suffix must not appear in the ordinary case."""
    got = document_numbers.next_document_number(
        _cursor(taken=[]),
        prefix="RET",
        table="return_headers",
        column="return_number",
        now=FROZEN,
    )
    assert got == BASE


def test_second_save_in_the_same_second_gets_a_distinct_number():
    got = document_numbers.next_document_number(
        _cursor(taken=[BASE]),
        prefix="RET",
        table="return_headers",
        column="return_number",
        now=FROZEN,
    )
    assert got == f"{BASE}-2"


def test_it_keeps_walking_past_several_collisions():
    got = document_numbers.next_document_number(
        _cursor(taken=[BASE, f"{BASE}-2", f"{BASE}-3"]),
        prefix="RET",
        table="return_headers",
        column="return_number",
        now=FROZEN,
    )
    assert got == f"{BASE}-4"


def test_matching_ignores_case():
    """The indexes are on lower(...), so the generator must agree with them
    -- otherwise it hands back a number the database then refuses."""
    got = document_numbers.next_document_number(
        _cursor(taken=[BASE.lower()]),
        prefix="RET",
        table="return_headers",
        column="return_number",
        now=FROZEN,
    )
    assert got == f"{BASE}-2"


def test_it_gives_up_loudly_rather_than_looping_forever():
    every = [BASE] + [
        f"{BASE}-{n}" for n in range(2, document_numbers.MAX_ATTEMPTS + 3)
    ]
    with pytest.raises(ValueError, match="Could not allocate"):
        document_numbers.next_document_number(
            _cursor(taken=every),
            prefix="RET",
            table="return_headers",
            column="return_number",
            now=FROZEN,
        )


@pytest.mark.parametrize(
    "prefix, table, column",
    [
        ("ISS", "issue_headers", "issue_id"),
        ("WST", "wastage_headers", "wastage_id"),
        ("RET", "return_headers", "return_number"),
    ],
)
def test_every_caller_gets_the_same_protection(prefix, table, column):
    """issue_id and wastage_id had neither an index nor a check before this."""
    base = document_numbers.build_base(prefix, FROZEN)
    got = document_numbers.next_document_number(
        _cursor(taken=[base]),
        prefix=prefix,
        table=table,
        column=column,
        now=FROZEN,
    )
    assert got == f"{base}-2"
    assert got.startswith(f"{prefix}-")

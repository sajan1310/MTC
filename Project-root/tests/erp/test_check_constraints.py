"""Database-level non-negativity, and what it deliberately excludes (DATA-004).

Five CHECK constraints across 50 tables meant the database enforced almost
nothing: the guards lived in Python, on the paths that happened to have them,
and anything writing by another route was unconstrained.

The interesting half of this finding is what is NOT constrained. The first
version of migration 040 constrained every quantity and amount column,
justified by production holding no negative rows. The suite rejected it
within one run, and rightly: a negative quantity is a documented correction
mechanism in this domain, and the absence of negatives in production meant
only that nobody had entered a correction recently.

So these tests pin both directions. The negative cases matter more than the
positive ones -- a constraint that quietly grows to cover quantities would
break corrections in a way that surfaces as "save failed" long after the
change that caused it.
"""

from __future__ import annotations

import psycopg2
import pytest

import database

pytestmark = pytest.mark.integration


def _constraints() -> set[str]:
    with database.get_conn() as (_conn, cur):
        cur.execute(
            """
            SELECT c.conname
            FROM pg_constraint c
            JOIN pg_class t ON t.oid = c.conrelid
            JOIN pg_namespace n ON n.oid = t.relnamespace
            WHERE n.nspname = 'erp' AND c.contype = 'c'
              AND c.conname LIKE '%_non_negative'
            """
        )
        return {row[0] for row in cur.fetchall()}


# ── They exist ───────────────────────────────────────────────────────────


def test_the_rate_and_price_constraints_are_present():
    present = _constraints()
    expected = {
        "bill_lines_base_rate_non_negative",
        "bill_lines_gst_rate_pct_non_negative",
        "bill_lines_price_non_negative",
        "contractor_rates_rate_per_unit_non_negative",
        "item_vendors_rate_non_negative",
        "po_lines_base_rate_non_negative",
        "po_lines_price_non_negative",
        "production_contractor_rate_non_negative",
        "rate_history_rate_non_negative",
        "return_lines_base_rate_non_negative",
        "return_lines_price_non_negative",
        "items_weight_per_base_unit_non_negative",
        "stock_threshold_non_negative",
    }
    assert expected <= present, sorted(expected - present)


# ── They bite ────────────────────────────────────────────────────────────


def test_a_negative_rate_is_refused_by_the_database():
    """Not by validation the caller might skip -- by the database, so a
    fixture, an admin script or a psql session is subject to it too."""
    with pytest.raises(psycopg2.errors.CheckViolation):
        with database.get_conn() as (_conn, cur):
            cur.execute(
                "INSERT INTO erp.rate_history (rate_date, item_name, vendor_name, rate) "
                "VALUES (CURRENT_DATE, 'CheckProbe', 'CheckVendor', -1)"
            )


def test_a_negative_threshold_is_refused_by_the_database():
    with pytest.raises(psycopg2.errors.CheckViolation):
        with database.get_conn() as (_conn, cur):
            cur.execute(
                "INSERT INTO erp.stock (item_name, size, threshold) "
                "VALUES ('CheckProbeItem', '', -5)"
            )


def test_zero_is_allowed():
    """>= 0, not > 0. A free item and a zero threshold are both meaningful."""
    with database.get_conn() as (_conn, cur):
        cur.execute(
            "INSERT INTO erp.rate_history (rate_date, item_name, vendor_name, rate) "
            "VALUES (CURRENT_DATE, 'CheckProbeZero', 'CheckVendor', 0) RETURNING id"
        )
        row_id = cur.fetchone()[0]
        cur.execute("DELETE FROM erp.rate_history WHERE id = %s", (row_id,))


def test_the_null_branch_is_defensive_and_currently_unreachable():
    """Each constraint is written `col IS NULL OR col >= 0`, and as it stands
    every column it covers is NOT NULL -- so that branch never fires today.

    It is kept deliberately, and this test records why rather than leaving a
    reader to wonder whether it is dead weight: nullability is decided by the
    column, not by this constraint. If one of these is later made nullable,
    or a nullable column joins the list, the `IS NULL OR` means NULL keeps
    meaning "not recorded" instead of quietly becoming a constraint
    violation. Asserting it here also means that if the columns' nullability
    ever changes, the change is visible rather than silent."""
    with database.get_conn() as (_conn, cur):
        cur.execute(
            """
            SELECT c.conname, a.attnotnull
            FROM pg_constraint c
            JOIN pg_class t ON t.oid = c.conrelid
            JOIN pg_namespace n ON n.oid = t.relnamespace
            JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = ANY (c.conkey)
            WHERE n.nspname = 'erp' AND c.contype = 'c'
              AND c.conname LIKE '%_non_negative'
            """
        )
        rows = cur.fetchall()

    assert rows, "no non-negative constraints found at all"
    nullable = [name for name, not_null in rows if not not_null]
    assert nullable == [], (
        f"these constrained columns are nullable, so the IS NULL branch is "
        f"now live and worth an explicit test: {nullable}"
    )


# ── What must stay unconstrained ─────────────────────────────────────────


@pytest.mark.parametrize(
    "constraint",
    [
        "production_qty_non_negative",
        "dispatch_lines_qty_non_negative",
        "dispatch_lines_amount_non_negative",
        "issue_lines_qty_non_negative",
        "return_lines_qty_non_negative",
        "bill_lines_qty_non_negative",
        "po_lines_qty_non_negative",
        "wastage_lines_qty_non_negative",
        "contractor_payments_amount_non_negative",
        "stock_initial_stock_non_negative",
        "warehouse_pool_available_qty_non_negative",
        "warehouse_pool_opening_qty_non_negative",
    ],
)
def test_transaction_quantities_are_deliberately_unconstrained(constraint):
    """Negative quantities are a correction/reversal mechanism here, not a
    defect -- production_service says so in as many words, and
    test_save_production_no_color_process_allows_negative_qty depends on it.
    Amounts inherit the sign because they are qty x rate.

    If someone adds one of these constraints, corrections stop saving. This
    test is the note explaining why the obvious-looking change is wrong."""
    assert constraint not in _constraints(), (
        f"{constraint} was added, but negative values are intentional here -- "
        f"see migrations/erp/040_non_negative_check_constraints.sql"
    )


def test_a_negative_stock_level_still_saves():
    """The behaviour those exclusions protect, exercised rather than asserted
    about. items_service._validate_initial_stock: "Negative allowed on
    purpose -- an over-consumed item can leave stock negative; the user
    should see and correct that, not be blocked from saving."

    The equivalent for production qty is covered end to end by
    test_production.py::test_save_production_no_color_process_allows_negative_qty,
    which goes through the RPC layer rather than writing the row directly."""
    with database.get_conn() as (_conn, cur):
        cur.execute(
            "INSERT INTO erp.stock (item_name, initial_stock) "
            "VALUES ('CheckProbeNegativeStock', -41424) RETURNING id"
        )
        row_id = cur.fetchone()[0]
        cur.execute("SELECT initial_stock FROM erp.stock WHERE id = %s", (row_id,))
        assert float(cur.fetchone()[0]) == -41424.0
        cur.execute("DELETE FROM erp.stock WHERE id = %s", (row_id,))

-- Non-negativity constraints on rates, prices and physical attributes
-- (DATA-004).
--
-- The audit counted 5 CHECK constraints across 50 tables. Nothing in the
-- database prevented a negative rate or a negative price; the only guards
-- were in Python, on the paths that happened to have them, and anything
-- writing by another route -- a fixture, an admin script, a psql session, a
-- future endpoint -- was unconstrained.
--
-- What this file does NOT constrain, and why
-- ------------------------------------------
-- Quantities. The first version of this migration constrained 41 columns
-- including every qty and amount, on the evidence that production held no
-- negative rows. That evidence was wrong -- not about the data, about what
-- the data meant. The test suite rejected it immediately:
--
--   test_save_production_no_color_process_allows_negative_qty
--   test_get_contractor_ledger_data_includes_negative_payable_correction_lot
--
-- A negative quantity is a deliberate, documented correction mechanism in
-- this domain, not a defect:
--
--   * production_service: "Zero and negative quantities are both allowed --
--     a lot can be logged as a correction/reversal"
--   * production component consumption: a negative credits stock and the
--     pool back
--   * items_service._validate_initial_stock: "Negative allowed on purpose --
--     an over-consumed item can leave stock negative; the user should see
--     and correct that, not be blocked from saving"
--   * contractors_service: a real rate against a negative qty is a
--     legitimate negative payable and must still be summed in
--
-- Amounts inherit that sign (dispatch_lines.amount is qty x rate), so they
-- are excluded too. The absence of negative rows in production meant only
-- that nobody had entered a correction recently.
--
-- Rates, prices, percentages and physical attributes carry no such meaning.
-- There is no corrective negative rate: items_service rejects a negative
-- weight outright, and stock_service's update_threshold rejects a negative
-- threshold. Those are the invariants this file moves into the database,
-- where every writer is subject to them rather than only the ones that
-- remembered.
--
-- bom_lines.qty_per_product and process_components.qty_per_unit ARE included
-- despite being named "qty": they are recipe DEFINITIONS -- how much of X
-- goes into one Y -- not transactions, and there is no correction-lot
-- concept for a definition. "-2 wheels per bicycle" has no meaning.
--
-- Verified twice: every column below has zero negative rows in production,
-- and this file was then executed against production inside a transaction
-- and rolled back, to prove it validates against the real data rather than
-- aborting the migration and, with it, the service start.
--
-- ADD CONSTRAINT IF NOT EXISTS is not available for CHECK constraints in
-- PostgreSQL, so each is guarded by a catalog lookup. Re-running is a no-op.

DO $$
DECLARE
    specs CONSTANT TEXT[][] := ARRAY[
        -- table                        column
        -- Rates, prices and percentages
        ['bill_lines',                  'base_rate'],
        ['bill_lines',                  'gst_rate_pct'],
        ['bill_lines',                  'price'],
        ['bom_additional_costs',        'rate'],
        ['bom_lines',                   'rate'],
        ['contractor_rates',            'rate_per_unit'],
        ['dispatch_headers',            'logistics_rate'],
        ['dispatch_lines',              'rate'],
        ['dispatch_plan_lines',         'rate'],
        ['issue_lines',                 'rate'],
        ['item_vendors',                'rate'],
        ['po_lines',                    'base_rate'],
        ['po_lines',                    'price'],
        ['production',                  'contractor_rate'],
        ['rate_history',                'rate'],
        ['return_lines',                'base_rate'],
        ['return_lines',                'price'],
        -- Recipe definitions, not transactions
        ['bom_lines',                   'qty_per_product'],
        ['process_components',          'qty_per_unit'],
        -- Physical attributes the service layer already rejects as negative
        ['items',                       'weight_per_base_unit'],
        ['stock',                       'threshold']
    ];
    i               INT;
    tbl             TEXT;
    col             TEXT;
    constraint_name TEXT;
BEGIN
    FOR i IN 1 .. array_length(specs, 1) LOOP
        tbl := specs[i][1];
        col := specs[i][2];
        constraint_name := tbl || '_' || col || '_non_negative';

        -- Skip a table absent from this database rather than aborting the
        -- whole migration.
        IF to_regclass('erp.' || tbl) IS NULL THEN
            RAISE NOTICE 'skipping erp.% (table absent)', tbl;
            CONTINUE;
        END IF;

        IF NOT EXISTS (
            SELECT 1
            FROM pg_constraint c
            JOIN pg_class t ON t.oid = c.conrelid
            JOIN pg_namespace n ON n.oid = t.relnamespace
            WHERE n.nspname = 'erp'
              AND t.relname = tbl
              AND c.conname = constraint_name
        ) THEN
            -- NULL passes: these columns are nullable by design and a CHECK
            -- is not the place to change that. Only an actual negative
            -- number is refused.
            EXECUTE format(
                'ALTER TABLE erp.%I ADD CONSTRAINT %I CHECK (%I IS NULL OR %I >= 0)',
                tbl, constraint_name, col, col
            );
        END IF;
    END LOOP;
END $$;

-- DATA-003: make X-Mutation-Id idempotency atomic, and bound the table.
--
-- app/erp/rpc.py did:
--     cached = get_cached_result(id)      -- SELECT
--     if cached: return cached
--     result = spec.func(*args)           -- EXECUTE
--     store_result(id, method, result)    -- INSERT ... ON CONFLICT DO NOTHING
--
-- Two requests carrying the same id concurrently both find no row, both
-- execute the method, and then ON CONFLICT DO NOTHING silently discards the
-- loser's result. The mutation ran twice; the caller is told it ran once. The
-- window is the entire method execution, which for a dispatch save is every
-- query it makes.
--
-- The fix is to CLAIM the id before executing: INSERT the row first, in
-- 'in_progress'. Whoever's INSERT succeeds owns the execution; anyone else
-- gets told the work is already happening. That requires `result` to be
-- nullable (there is no result yet at claim time) and a status to distinguish
-- "running" from "finished".
--
-- Backfill: every existing row was written by the old code AFTER its method
-- completed, so all of them are 'completed' by construction. The column
-- default plus the UPDATE below make that explicit rather than implied.

ALTER TABLE erp.rpc_mutations
    ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'completed',
    ADD COLUMN IF NOT EXISTS claimed_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

ALTER TABLE erp.rpc_mutations
    ALTER COLUMN result DROP NOT NULL;

-- Explicit, not merely defaulted: these rows predate the column.
UPDATE erp.rpc_mutations SET status = 'completed' WHERE status IS NULL;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'ck_erp_rpc_mutations_status'
    ) THEN
        ALTER TABLE erp.rpc_mutations
            ADD CONSTRAINT ck_erp_rpc_mutations_status
            CHECK (status IN ('in_progress', 'completed'));
    END IF;
END $$;

-- A completed row must actually carry its envelope, or a replay would return
-- NULL and the caller would see a success with no data. Only 'in_progress'
-- may have a null result.
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'ck_erp_rpc_mutations_result_present'
    ) THEN
        ALTER TABLE erp.rpc_mutations
            ADD CONSTRAINT ck_erp_rpc_mutations_result_present
            CHECK (status <> 'completed' OR result IS NOT NULL);
    END IF;
END $$;

-- DATA-005: the table had no pruning anywhere, so a full JSONB result
-- envelope was retained for every mutation ever performed, forever -- some of
-- them whole result sets. This index makes the retention sweep in
-- mutations.prune_old_mutations() a range scan rather than a full scan.
CREATE INDEX IF NOT EXISTS ix_erp_rpc_mutations_created_at
    ON erp.rpc_mutations (created_at);

-- Finds rows abandoned by a worker that died mid-execution (see
-- mutations.py's STALE_CLAIM_SECONDS): without this they would block their id
-- forever, because nothing else ever transitions them out of 'in_progress'.
CREATE INDEX IF NOT EXISTS ix_erp_rpc_mutations_in_progress
    ON erp.rpc_mutations (claimed_at)
    WHERE status = 'in_progress';

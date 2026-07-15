-- Mutation-idempotency infrastructure, deferred from Phase 0 until the first
-- real mutating RPC method (Phase 1a's saveUnit/saveColor/etc.).

-- Trigger-bumped row_version -- a clock-skew-free sync cursor. Attach to
-- every mutable table with:
--   CREATE TRIGGER trg_<table>_touch_row_version
--       BEFORE INSERT OR UPDATE ON erp.<table>
--       FOR EACH ROW EXECUTE FUNCTION erp.touch_row_version();
CREATE OR REPLACE FUNCTION erp.touch_row_version() RETURNS trigger AS $$
BEGIN
    NEW.row_version := nextval('erp.change_seq');
    NEW.updated_at := NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- A replayed X-Mutation-Id returns this stored envelope instead of
-- re-executing the RPC method. Both success and domain-failure envelopes are
-- cached (see app/erp/rpc.py) -- a repeat of a rejected duplicate-name save
-- should fail identically, not re-attempt.
CREATE TABLE IF NOT EXISTS erp.rpc_mutations (
    mutation_id UUID PRIMARY KEY,
    method VARCHAR(255) NOT NULL,
    result JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

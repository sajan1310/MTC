-- Lot inspection: a floor inspector checks a production lot's materials
-- against its live Production Sheet, may flag the lot for an admin, and
-- signs it off.
--
-- Kept out of erp.production on purpose. The inspection is a record ABOUT a
-- lot, and the lot's own columns already carry meaning elsewhere: only
-- status = 'Completed' credits the Warehouse Pool, the dashboard reads
-- 'In Progress' as material on the floor, and every status write rebuilds
-- the pool. An inspection that cleared a lot by changing its status would
-- move stock. So "cleared" lives here, and the lot keeps whatever status
-- its supervisor gave it. The single write inspection_service makes to
-- erp.production is the agreed one: a Pending lot becomes In Progress when
-- its first item is checked.
--
-- 053 follows the audit report's 052 (on another branch). The runner applies
-- pending files in filename order and tolerates the gap either way.

CREATE TABLE IF NOT EXISTS erp.lot_inspections (
    id               BIGSERIAL PRIMARY KEY,
    -- One inspection per lot. Lots are soft-deleted (deleted_at), so the
    -- reference can never be left dangling by a delete.
    production_id    INTEGER NOT NULL UNIQUE REFERENCES erp.production(id),
    -- in_progress: items being checked.
    -- flagged:     the inspector asked an admin to change the lot; waits for
    --              the admin to send it back.
    -- cleared:     signed off. Final; the lot's own status is untouched.
    status           VARCHAR(20) NOT NULL DEFAULT 'in_progress'
                     CHECK (status IN ('in_progress', 'flagged', 'cleared')),
    remarks          TEXT NOT NULL DEFAULT '',
    -- The live Production Sheet rows as they stood when inspection began:
    -- [{key, itemName, size, color, narration, qty, unit, fingerprint}].
    -- A row on the sheet now but not in here was ADDED since -- the "New"
    -- badge. A row in here whose fingerprint has moved was REVISED.
    baseline         JSONB NOT NULL DEFAULT '[]'::jsonb,
    flagged_at       TIMESTAMPTZ,
    flagged_by       INTEGER REFERENCES public.users(user_id),
    flagged_by_name  VARCHAR(150),
    -- An admin's answer when sending a flagged lot back for re-inspection.
    review_note      TEXT NOT NULL DEFAULT '',
    returned_at      TIMESTAMPTZ,
    returned_by      INTEGER REFERENCES public.users(user_id),
    cleared_at       TIMESTAMPTZ,
    cleared_by       INTEGER REFERENCES public.users(user_id),
    -- Name and role as they were at sign-off, so the record keeps saying who
    -- cleared the lot even after the account is renamed or its role changes.
    cleared_by_name  VARCHAR(150),
    cleared_by_role  VARCHAR(100),
    -- The sheet rows that were signed off, and -- when an admin accepted
    -- Production Sheet changes instead of re-inspecting -- the differences
    -- they accepted. NULL when nothing was acknowledged.
    cleared_sheet    JSONB,
    acknowledged     JSONB,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_by       INTEGER REFERENCES public.users(user_id),
    row_version      BIGINT,
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_by       INTEGER REFERENCES public.users(user_id)
);

CREATE INDEX IF NOT EXISTS ix_erp_lot_inspections_status
    ON erp.lot_inspections (status);

CREATE TRIGGER trg_erp_lot_inspections_touch_row_version
    BEFORE INSERT OR UPDATE ON erp.lot_inspections
    FOR EACH ROW EXECUTE FUNCTION erp.touch_row_version();

-- One row per checked sheet row. `fingerprint` is the quantity and
-- specification the check was made against: when an admin changes either,
-- the check stops counting (the item comes back unticked, badged
-- "Revised") but the row stays, because its snapshot is what lets the
-- screen say "50 -> 45". Re-checking overwrites it.
CREATE TABLE IF NOT EXISTS erp.lot_inspection_checks (
    inspection_id  BIGINT NOT NULL REFERENCES erp.lot_inspections(id) ON DELETE CASCADE,
    item_key       VARCHAR(600) NOT NULL,
    result         VARCHAR(10) NOT NULL CHECK (result IN ('pass', 'fail')),
    fingerprint    VARCHAR(600) NOT NULL,
    snapshot       JSONB NOT NULL,
    checked_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    checked_by     INTEGER REFERENCES public.users(user_id),
    row_version    BIGINT,
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (inspection_id, item_key)
);

CREATE TRIGGER trg_erp_lot_inspection_checks_touch_row_version
    BEFORE INSERT OR UPDATE ON erp.lot_inspection_checks
    FOR EACH ROW EXECUTE FUNCTION erp.touch_row_version();

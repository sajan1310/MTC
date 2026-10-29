-- A purchase order completed or cancelled by hand, from its Status dropdown.
--
-- A PO's status is derived from its bills: nothing billed is "PO Issued",
-- some is "Partially Received", all of it "Completed". There was no way to
-- say "the rest is never coming" or "this order is off". A short-supplied PO
-- sat at Partially Received for good, and a called-off one could only be
-- deleted -- either way its balance kept counting as pending in the Pending
-- Orders list, Item Master's Pending Order column, the vendor's pending
-- list, the dashboard's open POs and the overdue-PO alert, and new bills
-- kept being suggested against it.
--
-- closed_as holds the status set by hand. po_service reports it in place of
-- the derived one, and what each line is still owed moves from pendingQty
-- to shortQty, so it stops being pending everywhere. NULL is the derived
-- status, as before; reopening clears all five columns. Bills are untouched
-- either way -- what was received stays received.
--
-- The name is kept as it was at the time, so the PO keeps saying who closed
-- it after the account is renamed (as lot_inspections' cleared_by_name does).
ALTER TABLE erp.po_headers
    ADD COLUMN IF NOT EXISTS closed_as VARCHAR(20)
        CHECK (closed_as IN ('Completed', 'Cancelled')),
    ADD COLUMN IF NOT EXISTS closed_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS closed_by INTEGER REFERENCES public.users(user_id),
    ADD COLUMN IF NOT EXISTS closed_by_name VARCHAR(150),
    ADD COLUMN IF NOT EXISTS close_note TEXT NOT NULL DEFAULT '';

-- Backfill for the contractor_payable formula fix: extra_charge_amount is a
-- per-unit add-on to the Layer 1 rate (contractor_payable = (contractor_rate
-- + extra_charge_amount) * qty), not a flat per-lot amount added once
-- (contractor_rate * qty + extra_charge_amount, the bug introduced
-- alongside 031_contractor_rate_layers.sql). contractor_rate,
-- extra_charge_amount and qty are already stamped per lot, so recomputing
-- in place needs no rate-card lookups. A no-op for every lot with
-- extra_charge_amount = 0 (both formulas agree there), and covers deleted
-- lots too so a restore doesn't resurrect a stale total.
UPDATE erp.production
SET contractor_payable = (contractor_rate + extra_charge_amount) * qty
WHERE contractor_payable IS DISTINCT FROM (contractor_rate + extra_charge_amount) * qty;

-- Operator-declared "this bucket is not stock", surviving a recalculation.
--
-- 043 added erp.warehouse_pool.counts_toward_total, decided from the
-- production lot that credited the bucket: a colorBreakdown entry marked
-- countsTowardTotal false is a sub-group recorded per colour on units the
-- primary axis already counted, so its bucket is an annotation and not
-- goods. That works wherever a lot is the source of the credit.
--
-- It cannot work where there is no lot. A bucket created by Opening Stock
-- or by an inline Available Qty correction carries no colorBreakdown and
-- therefore no signal at all -- and that is exactly how the reported case
-- arose: PRC-1206 "Packing Zara IBC 24 inch 1.95 Unbranded" has zero
-- production lots, its 'Kit Bag 24"' and 'Small Kit 24"' buckets were
-- entered by hand, and nothing in the data distinguishes them from the
-- Pink / Purple / SeaGreen buckets beside them.
--
-- Inferring it from the colour NAME was measured and rejected. The client
-- has such a heuristic (production.js#_isColorGroupName: a name that does
-- not decompose into Color Master colours is a packing set), and against
-- this database it misfiles "Green" -- absent from a Color Master holding
-- 22 green variants -- which carries 4,985 real units across the mudguard
-- processes. Trading 4,985 hidden units for 1,196 correctly flagged ones
-- is the wrong direction: overstating availability is the bug being fixed,
-- but understating it silently hides stock nobody can then dispatch. The
-- same objection applies to inferring from computed colour axes, which
-- fails the same way and just as quietly.
--
-- So the remaining honest source is the operator, and this is where their
-- answer lives. It has to be its own table because erp.warehouse_pool is a
-- materialized cache that _recalculate_warehouse_pool rewrites wholesale
-- on every mutating call -- a flag stored there would survive exactly
-- until the next save. _build_warehouse_pool_buckets reads this on every
-- rebuild instead, and an explicit row here OVERRIDES the lot-derived
-- verdict in both directions: a bucket the lots imply is stock can be
-- marked an annotation, and one auto-flagged in 043 can be restored to
-- stock when the inference got it wrong. Absence means "no opinion --
-- use the lots", which is why the flag is NOT NULL here but the table is
-- sparse.
--
-- Keyed to match _build_warehouse_pool_buckets' own bucket identity
-- exactly: (output_item_name, product_tag, colour), case-insensitively,
-- and NOT process_id -- get_bucket() keys on those three, so two processes
-- writing the same output item name share one bucket and must share one
-- flag. process_id is carried for display and audit only.

CREATE TABLE IF NOT EXISTS erp.warehouse_pool_bucket_flags (
    id SERIAL PRIMARY KEY,
    output_item_name VARCHAR(255) NOT NULL,
    process_id VARCHAR(50),
    product_tag VARCHAR(50) NOT NULL DEFAULT '',
    color VARCHAR(255) NOT NULL DEFAULT '',
    counts_toward_total BOOLEAN NOT NULL,
    remarks TEXT NOT NULL DEFAULT '',
    updated_by INTEGER REFERENCES public.users(user_id),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_erp_warehouse_pool_bucket_flags_key
    ON erp.warehouse_pool_bucket_flags (
        lower(output_item_name), lower(product_tag), lower(color)
    );

-- Unit Master + the 3 tag masters (Color/Model/Process Type). Surrogate `id`
-- PK (not the name) so a soft-deleted name can be reused later -- see the
-- partial unique index on lower(name) WHERE deleted_at IS NULL below.

CREATE TABLE IF NOT EXISTS erp.units (
    id SERIAL PRIMARY KEY,
    unit_name VARCHAR(255) NOT NULL,
    family VARCHAR(100) NOT NULL,
    factor_to_base NUMERIC NOT NULL CHECK (factor_to_base > 0),
    remarks TEXT,
    row_version BIGINT,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_by INTEGER REFERENCES public.users(user_id),
    client_uuid UUID UNIQUE,
    deleted_at TIMESTAMPTZ
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_erp_units_name_ci
    ON erp.units (lower(unit_name)) WHERE deleted_at IS NULL;

CREATE TRIGGER trg_erp_units_touch_row_version
    BEFORE INSERT OR UPDATE ON erp.units
    FOR EACH ROW EXECUTE FUNCTION erp.touch_row_version();


CREATE TABLE IF NOT EXISTS erp.color_master (
    id SERIAL PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    remarks TEXT,
    row_version BIGINT,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_by INTEGER REFERENCES public.users(user_id),
    client_uuid UUID UNIQUE,
    deleted_at TIMESTAMPTZ
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_erp_color_master_name_ci
    ON erp.color_master (lower(name)) WHERE deleted_at IS NULL;

CREATE TRIGGER trg_erp_color_master_touch_row_version
    BEFORE INSERT OR UPDATE ON erp.color_master
    FOR EACH ROW EXECUTE FUNCTION erp.touch_row_version();


CREATE TABLE IF NOT EXISTS erp.model_master (
    id SERIAL PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    remarks TEXT,
    row_version BIGINT,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_by INTEGER REFERENCES public.users(user_id),
    client_uuid UUID UNIQUE,
    deleted_at TIMESTAMPTZ
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_erp_model_master_name_ci
    ON erp.model_master (lower(name)) WHERE deleted_at IS NULL;

CREATE TRIGGER trg_erp_model_master_touch_row_version
    BEFORE INSERT OR UPDATE ON erp.model_master
    FOR EACH ROW EXECUTE FUNCTION erp.touch_row_version();


CREATE TABLE IF NOT EXISTS erp.process_type_master (
    id SERIAL PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    remarks TEXT,
    row_version BIGINT,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_by INTEGER REFERENCES public.users(user_id),
    client_uuid UUID UNIQUE,
    deleted_at TIMESTAMPTZ
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_erp_process_type_master_name_ci
    ON erp.process_type_master (lower(name)) WHERE deleted_at IS NULL;

CREATE TRIGGER trg_erp_process_type_master_touch_row_version
    BEFORE INSERT OR UPDATE ON erp.process_type_master
    FOR EACH ROW EXECUTE FUNCTION erp.touch_row_version();

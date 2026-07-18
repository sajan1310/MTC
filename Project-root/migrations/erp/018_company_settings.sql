-- Company Logo, ported from Apps_Script/utils.js's saveLogo/getLogo/
-- clearLogo (wired from Script_Core.html's App.Logo). Source chunked the
-- base64 data URL across multiple PropertiesService entries because each
-- property value is capped at ~9KB -- a Postgres TEXT column has no such
-- limit, so this is stored as a single value, no chunking needed.
--
-- Singleton table (id is always 1) rather than a generic key-value
-- settings table -- this is the one piece of global app-level config the
-- source had, and a generic settings framework isn't needed for just this.

CREATE TABLE IF NOT EXISTS erp.company_settings (
    id SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
    logo_data_url TEXT,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_by INTEGER REFERENCES public.users(user_id)
);

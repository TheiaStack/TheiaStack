-- Theia-Stack — fix for firms_billing_status_check constraint
-- Required for the 'expired' status used by renewal-reminder.js.
--
-- Found live on 20 Sep 2026: the original check constraint only
-- allowed ['no_billing','pending_mandate','active','payment_failed',
-- 'cancelled'] — 'expired' was missing, which is not something any
-- code file could reveal, only the live schema itself. This was not
-- caught before shipping renewal-reminder.js; it surfaced as a
-- PostgREST 400 (constraint violation) the first time the function
-- tried to actually flip a firm to 'expired' in production.
--
-- Already run manually against the live database on 20 Sep as part of
-- fixing the error live. This file exists so the fix is on record —
-- if this database is ever rebuilt from the migration files in this
-- folder, running this one is what prevents hitting the exact same
-- error again.

ALTER TABLE firms DROP CONSTRAINT firms_billing_status_check;

ALTER TABLE firms ADD CONSTRAINT firms_billing_status_check
  CHECK (billing_status = ANY (ARRAY[
    'no_billing'::text,
    'pending_mandate'::text,
    'active'::text,
    'payment_failed'::text,
    'cancelled'::text,
    'expired'::text
  ]));

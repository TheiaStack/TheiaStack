-- Theia-Stack — Section 6, Quarterly Auto Re-Audit reminder
-- Run manually in the Supabase SQL editor before deploying
-- netlify/functions/reaudit-reminder.js.
--
-- Dedupe log for the 90-day quarterly re-audit reminder email.
-- Mirrors onboarding_emails_sent's UNIQUE-constraint-as-guard pattern,
-- but keyed to the specific audit cycle (audit_marker = the firm's
-- report_generated_at value at send time) rather than a fixed day
-- threshold — so a fresh reminder becomes eligible again automatically
-- every time a firm actually re-audits, without any extra logic.

CREATE TABLE IF NOT EXISTS reaudit_reminders_sent (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  firm_id UUID NOT NULL REFERENCES firms(id) ON DELETE CASCADE,
  audit_marker TIMESTAMPTZ NOT NULL,
  sent_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (firm_id, audit_marker)
);

-- RLS enabled with no policies — matches this project's other
-- service-role-only tables until the broader RLS design review
-- (already on the task list) happens. The Netlify function only ever
-- uses the SERVICE ROLE key, which bypasses RLS entirely, so this
-- table is simply unreachable from the anon/authenticated client in
-- the meantime — not a functional gap, a safe default.
ALTER TABLE reaudit_reminders_sent ENABLE ROW LEVEL SECURITY;

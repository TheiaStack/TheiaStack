-- Theia-Stack — Annual renewal reminder sequence
-- Run manually in the Supabase SQL editor before deploying
-- netlify/functions/renewal-reminder.js.

CREATE TABLE IF NOT EXISTS renewal_reminders_sent (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  firm_id UUID NOT NULL REFERENCES firms(id) ON DELETE CASCADE,
  threshold_key TEXT NOT NULL, -- 'day30' | 'day20' | 'day7'
  expiry_marker TIMESTAMPTZ NOT NULL, -- the firm's report_expires_at this reminder was sent for
  sent_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (firm_id, threshold_key, expiry_marker)
);

-- Scoping the UNIQUE constraint to expiry_marker (not just firm_id +
-- threshold_key) means the 30/20/7-day reminders become eligible again
-- automatically after a firm renews and report_expires_at moves to a
-- new date — same reasoning as reaudit_reminders_sent's audit_marker.

ALTER TABLE renewal_reminders_sent ENABLE ROW LEVEL SECURITY;
-- RLS enabled with no policies — service-role-only, same as
-- reaudit_reminders_sent and onboarding_emails_sent.

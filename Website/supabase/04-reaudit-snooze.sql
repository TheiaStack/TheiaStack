-- Theia-Stack — Quarterly re-audit reminder: "remind me later" snooze
-- Run manually in the Supabase SQL editor before deploying
-- reaudit-snooze.js and the updated reaudit-reminder.js.

ALTER TABLE firms
  ADD COLUMN IF NOT EXISTS reaudit_snoozed_until TIMESTAMPTZ;

-- No RLS changes needed — this column is only ever read/written by
-- Netlify functions using the SERVICE ROLE key (reaudit-reminder.js
-- reads it, reaudit-snooze.js writes it), which bypasses RLS entirely,
-- consistent with reaudit_reminders_sent from the earlier migration.

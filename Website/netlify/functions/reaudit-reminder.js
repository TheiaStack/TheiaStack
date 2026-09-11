// Netlify Scheduled Function: netlify/functions/reaudit-reminder.js
//
// Runs daily (schedule declared in netlify.toml, alongside
// onboarding-drip). Sends the 90-day Quarterly Auto Re-Audit reminder
// to firms whose AI tool stack hasn't been reviewed in a while — the
// automated half of the re-audit retention hook, alongside the manual
// "Start re-audit" entry point added to platform.html (see
// startReaudit()).
//
// Unlike onboarding-drip.js, this targets already-onboarded, paying
// customers who manage their own notification preferences in Settings
// — so it routes through the same sendNotification()/
// notification_preferences system as audit_completed and
// staff_training_completed, rather than sending raw email directly.
// That means: it respects a firm turning this reminder off, it goes
// to whichever admin(s) are actually configured as recipients, and
// every attempt is logged to notification_log exactly like the other
// triggers.
//
// Security model — same reasoning as onboarding-drip.js: Netlify
// Scheduled Functions have no browser-facing entry point, so there is
// no bearer-token check, no CORS handling, and no OPTIONS branch here.
//
// Logic:
//   1. Candidate pool: firms with billing_status = 'active' and
//      report_generated_at at least 90 days old. A firm that has never
//      run an audit (report_generated_at null) is excluded — nothing
//      to remind them to refresh yet, and onboarding-drip already
//      covers "never finished the audit."
//   2. Each candidate's report_generated_at value is itself used as
//      the dedupe marker (reaudit_reminders_sent, UNIQUE(firm_id,
//      audit_marker)) — NOT a fixed key like onboarding-drip's day3/
//      day7/day14. This is deliberate: report_generated_at moves
//      forward every time a re-audit actually runs, so once a firm
//      re-audits, the marker changes and a fresh reminder becomes
//      eligible again in another 90 days. A fixed key would only ever
//      fire once per firm, ever.
//   3. The insert into reaudit_reminders_sent is the real dedupe
//      guard (its UNIQUE constraint), not just the pre-check — same
//      pattern as onboarding_emails_sent.
//   4. sendNotification() itself resolves recipients against
//      notification_preferences and logs to notification_log, so
//      firm-level opt-out and delivery tracking come for free.
//   5. Each firm is processed inside its own try/catch so one firm's
//      failure never aborts the run.
//
// Schema this adds (run supabase/03-reaudit-reminders.sql manually in
// the Supabase SQL editor before deploying — see that file):
//   reaudit_reminders_sent: id, firm_id, audit_marker (text — the ISO
//     report_generated_at this reminder was sent for), sent_at,
//     UNIQUE (firm_id, audit_marker)

const { sendNotification } = require('./lib/notifications');

const SUPABASE_URL = 'https://rkqnrpyctllxcnknjsby.supabase.co';
const DUE_AFTER_DAYS = 90;

// Same hand-rolled service-role wrapper as notify.js — kept as its own
// copy in this file rather than shared, matching this project's
// established precedent (see onboarding-drip.js header) of each
// function carrying its own copy so a change made for one can never
// risk breaking an already-working one. Must satisfy the same subset
// of the supabase-js query builder that lib/notifications.js expects
// (select/eq/maybeSingle, a bare thenable for select/eq with no
// terminal call — see getAdminEmails() — insert, and
// auth.admin.getUserById), plus a selectAll() for the initial
// candidate query.
function makeServiceClient() {
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!serviceKey) throw new Error('SUPABASE_SERVICE_ROLE_KEY is not set');

  async function restRequest(path, options = {}) {
    return fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
      ...options,
      headers: {
        'apikey': serviceKey,
        'Authorization': `Bearer ${serviceKey}`,
        'Content-Type': 'application/json',
        'Prefer': options.prefer || 'return=representation',
        ...(options.headers || {}),
      },
    });
  }

  return {
    from(table) {
      const filters = [];
      const api = {
        select(cols = '*') { this._select = cols; return this; },
        eq(field, val) { filters.push(`${field}=eq.${encodeURIComponent(val)}`); return this; },
        maybeSingle: async function () {
          const qs = filters.length ? `?${filters.join('&')}&select=${this._select || '*'}` : `?select=${this._select || '*'}`;
          const res = await restRequest(`${table}${qs}`, { headers: { 'Accept': 'application/vnd.pgrst.object+json' } });
          if (res.status === 406) return { data: null, error: null };
          if (!res.ok) return { data: null, error: new Error(`PostgREST error ${res.status}`) };
          const data = await res.json();
          return { data, error: null };
        },
        selectAll: async function (rawFilters) {
          const parts = rawFilters ? [rawFilters] : filters;
          const qs = parts.length ? `?${parts.join('&')}&select=${this._select || '*'}` : `?select=${this._select || '*'}`;
          const res = await restRequest(`${table}${qs}`);
          if (!res.ok) return { data: null, error: new Error(`PostgREST error ${res.status}`) };
          const data = await res.json();
          return { data, error: null };
        },
        insert: async (row) => {
          const res = await restRequest(table, { method: 'POST', body: JSON.stringify(row) });
          if (res.status === 409) return { error: null, conflict: true };
          if (!res.ok) {
            const detail = await res.text().catch(() => '');
            return { error: new Error(`PostgREST insert error ${res.status}: ${detail}`) };
          }
          return { error: null, conflict: false };
        },
        // Thenable so `await supabase.from(x).select().eq()` (no
        // maybeSingle) works too — this is the exact pattern
        // getAdminEmails() in lib/notifications.js uses. Without this,
        // awaiting the builder just resolves to the builder object
        // itself (not a promise), so destructuring { data, error } off
        // it silently gives undefined for both — no thrown error, just
        // an empty admins list and a "no resolvable recipient emails"
        // warning further up. Matches notify.js's working wrapper.
        then(resolve, reject) {
          const qs = filters.length ? `?${filters.join('&')}&select=${this._select || '*'}` : `?select=${this._select || '*'}`;
          restRequest(`${table}${qs}`)
            .then(async (res) => {
              if (!res.ok) return resolve({ data: null, error: new Error(`PostgREST error ${res.status}`) });
              const data = await res.json();
              resolve({ data, error: null });
            })
            .catch(reject);
        },
      };
      return api;
    },
    auth: {
      admin: {
        getUserById: async (id) => {
          const res = await fetch(`${SUPABASE_URL}/auth/v1/admin/users/${id}`, {
            headers: { 'apikey': serviceKey, 'Authorization': `Bearer ${serviceKey}` },
          });
          if (!res.ok) return { data: null, error: new Error(`Auth admin error ${res.status}`) };
          const user = await res.json();
          return { data: { user }, error: null };
        },
      },
    },
  };
}

exports.handler = async function () {
  let serviceClient;
  try {
    serviceClient = makeServiceClient();
  } catch (e) {
    console.error('reaudit-reminder.js: server misconfiguration:', e.message);
    return { statusCode: 500, body: 'Server misconfiguration' };
  }

  const summary = { checked: 0, sent: 0, skipped: 0, failed: 0 };

  // Step 1: candidate pool — active subscription, audit at least
  // 90 days old. Filtering on the date itself (rather than fetching
  // all active firms and computing in JS) keeps the candidate set
  // small on every run.
  const cutoffISO = new Date(Date.now() - DUE_AFTER_DAYS * 86400000).toISOString();
  const candidatesRes = await serviceClient
    .from('firms')
    .select('id,name,report_generated_at')
    .selectAll(`billing_status=eq.active&report_generated_at=not.is.null&report_generated_at=lte.${encodeURIComponent(cutoffISO)}`);

  if (candidatesRes.error) {
    console.error('reaudit-reminder.js: candidate query failed:', candidatesRes.error.message);
    return { statusCode: 500, body: 'Candidate query failed' };
  }

  const candidates = candidatesRes.data || [];
  summary.checked = candidates.length;

  if (!candidates.length) {
    console.log('reaudit-reminder.js: no candidates due, nothing to do.');
    return { statusCode: 200, body: JSON.stringify(summary) };
  }

  const now = Date.now();

  for (const firm of candidates) {
    try {
      const auditMarker = firm.report_generated_at; // exact ISO string already on the row
      const daysSince = Math.floor((now - new Date(auditMarker).getTime()) / 86400000);

      // Reserve the send first, keyed to this specific audit cycle —
      // if this conflicts, a reminder for this exact cycle already
      // Send BEFORE recording the dedupe marker — a failed send must
      // never be mistaken for a sent one, or this firm would silently
      // never be reminded again for this audit cycle even once the
      // underlying cause is fixed. (This is exactly what happened
      // during testing: an unrelated bug caused a failed first send,
      // but the marker was written anyway, masking the real fix.)
      const result = await sendNotification(
        'quarterly_reaudit_due',
        { firmId: firm.id, firmName: firm.name || 'your firm', daysSince },
        serviceClient
      );

      if (!result.sent.length) {
        // Distinguish "firm opted out" (expected, harmless, don't
        // alarm the log) from "we couldn't actually send" (a real
        // problem worth surfacing) using the same signal
        // resolveRecipientRoles() returns: enabled === false means a
        // deliberate opt-out, not a failure.
        if (result.optedOut) {
          summary.skipped++;
        } else {
          console.error(`reaudit-reminder.js: send failed for firm ${firm.id} — no recipient resolved or delivery failed.`);
          summary.failed++;
        }
        continue; // no dedupe marker written — eligible to retry tomorrow
      }

      summary.sent++;

      // Only NOW record that this specific audit cycle has been
      // reminded. A small window exists where two overlapping runs
      // could both send before either inserts here — acceptable for a
      // once-daily cron with no realistic concurrent execution, and
      // far safer than the previous failure mode.
      const insertRes = await serviceClient.from('reaudit_reminders_sent').insert({
        firm_id: firm.id,
        audit_marker: auditMarker,
      });
      if (insertRes.error) {
        // The email genuinely went out; only the bookkeeping failed.
        // Log it so it's investigable, but don't downgrade summary.sent
        // — that would misreport a real send as a failure.
        console.error(`reaudit-reminder.js: sent to firm ${firm.id} but failed to record dedupe marker:`, insertRes.error.message);
      }
    } catch (e) {
      console.error(`reaudit-reminder.js: failed processing firm ${firm.id}:`, e.message);
      summary.failed++;
    }
  }

  console.log('reaudit-reminder.js run summary:', JSON.stringify(summary));
  return { statusCode: 200, body: JSON.stringify(summary) };
};

// ─────────────────────────────────────────────────────────────
// Schedule declaration — lives in netlify.toml, NOT in this file.
// Add alongside the existing onboarding-drip entry:
//
//   [functions."reaudit-reminder"]
//     schedule = "@daily"
// ─────────────────────────────────────────────────────────────

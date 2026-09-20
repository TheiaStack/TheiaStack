// Netlify Scheduled Function: netlify/functions/renewal-reminder.js
//
// Runs daily (schedule declared in netlify.toml). Two jobs, both driven
// off report_expires_at, which — since the 7 Sep fix — only ever moves
// on a confirmed GoCardless payment (see gocardless-webhook.js), so it
// can be trusted directly here with no extra logic to work around
// stale or free-audit-inflated dates:
//
//   1. Send the 30 / 20 / 7-day-before-expiry reminder sequence (Sales
//      Playbook Section 9), to any firm with billing_status = 'active'.
//   2. Once report_expires_at has actually passed, flip billing_status
//      from 'active' to 'expired' — this is what actually enforces the
//      annual model. The existing paywall (hasActiveBilling() in
//      platform.html) already checks billing_status === 'active', so
//      an expired firm is locked out of Findings/Recommendations/
//      Policy/Training exactly like a firm who never subscribed, with
//      no changes needed to the paywall itself. Re-subscribing uses
//      the same startBilling() flow as a new firm — GoCardless webhook
//      fulfilment already sets billing_status back to 'active' and
//      report_expires_at forward 12 months, unconditionally.
//
// Deliberately bypasses notification_preferences/sendNotification —
// unlike quarterly_reaudit_due, these are billing-critical notices
// about actual access being cut off, not a feature nudge a firm should
// be able to silently turn off in Settings. Sends raw via Resend,
// same pattern as onboarding-drip.js.
//
// The Day 372-post-expiry personal follow-up (Sales Playbook Section 9)
// is deliberately NOT built here — the Playbook scopes it as a manual,
// personal 2-minute email from the founder, not automation.
//
// Ordering note (learned the hard way earlier this project): the
// dedupe record is written only AFTER a confirmed successful send, not
// before — onboarding-drip.js has the opposite order (insert reserved
// before the send attempt), which means a Resend failure there would
// permanently mark that email as sent when it never went out. Flagged
// on the task list as a latent bug worth fixing there too, but not
// fixed in this session — this file uses the corrected order from the
// start, matching reaudit-reminder.js's fix from earlier today.
//
// Schema this adds (run supabase/05-renewal-reminders.sql manually in
// the Supabase SQL editor before deploying — see that file):
//   renewal_reminders_sent: id, firm_id, threshold_key, expiry_marker,
//     sent_at, UNIQUE (firm_id, threshold_key, expiry_marker)

const SUPABASE_URL = 'https://rkqnrpyctllxcnknjsby.supabase.co';

// Ordered furthest-from-expiry first — mirrors onboarding-drip.js's
// THRESHOLDS.find() idiom exactly, just counting down to a date
// instead of counting up from one. For a given firm, this finds the
// single earliest-due, not-yet-sent threshold; capped at one send per
// firm per run for the same reason onboarding-drip.js caps at one —
// so a missed run day never sends two reminders on the same day.
const THRESHOLDS = [
  { days: 30, key: 'day30' },
  { days: 20, key: 'day20' },
  { days: 7, key: 'day7' },
];

// Minimal service-role REST wrapper — own copy, matching this
// project's established precedent (see onboarding-drip.js header).
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
        update: async (patch) => {
          const qs = filters.length ? `?${filters.join('&')}` : '';
          const res = await restRequest(`${table}${qs}`, { method: 'PATCH', body: JSON.stringify(patch) });
          if (!res.ok) {
            const detail = await res.text().catch(() => '');
            return { data: null, error: new Error(`PostgREST update error ${res.status}: ${detail}`) };
          }
          const data = await res.json().catch(() => []);
          return { data, error: null };
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

const FROM_ADDRESS = 'Theia-Stack <hello@theiastack.com.au>';
const RESEND_API_URL = 'https://api.resend.com/emails';
const SITE_URL = 'https://theiastack.com.au';

function emailShell(bodyHtml) {
  return `
  <div style="font-family:'DM Sans',Arial,sans-serif;background:#F2F2F2;padding:32px;">
    <div style="max-width:480px;margin:0 auto;background:#FFFFFF;border-radius:10px;overflow:hidden;border:1px solid #D0D0D0;">
      <div style="background:#111111;padding:24px 32px;">
        <span style="font-family:Georgia,'Playfair Display',serif;color:#FFFFFF;font-size:20px;letter-spacing:-.02em;">THEIA-STACK</span>
      </div>
      <div style="padding:32px;color:#111111;">
        ${bodyHtml}
      </div>
    </div>
  </div>`;
}

function ctaButton(label, url) {
  return `<p style="margin:24px 0;">
    <a href="${url}" style="display:inline-block;background:#B83232;color:#FFFFFF;text-decoration:none;padding:12px 28px;border-radius:10px;font-size:14px;font-weight:500;">${label}</a>
  </p>`;
}

// Wording taken directly from the Sales Playbook's own renewal
// sequence (Section 9) — already written, already passed Claims
// Discipline review, reused rather than rewritten.
const TEMPLATES = {
  day30: {
    subject: 'Your AI Risk Management Report expires in 30 days',
    bodyHtml: (firmName) => `
      <p style="margin:0 0 16px;font-size:15px;line-height:1.6;">Your AI Risk Management Report for ${firmName} expires in 30 days.</p>
      <p style="margin:0 0 16px;font-size:15px;line-height:1.6;">Renew now to keep your documentation current and trigger your next quarterly audit.</p>
      ${ctaButton('Renew now', `${SITE_URL}/platform`)}
    `,
  },
  day20: {
    subject: 'Your report expires in 20 days',
    bodyHtml: (firmName) => `
      <p style="margin:0 0 16px;font-size:15px;line-height:1.6;">Your report for ${firmName} expires in 20 days.</p>
      <p style="margin:0 0 16px;font-size:15px;line-height:1.6;">Renew in one click to maintain an unbroken audit trail for your firm.</p>
      ${ctaButton('Renew now', `${SITE_URL}/platform`)}
    `,
  },
  day7: {
    subject: 'Your report expires in 7 days',
    bodyHtml: (firmName) => `
      <p style="margin:0 0 16px;font-size:15px;line-height:1.6;">Your report for ${firmName} expires in 7 days.</p>
      <p style="margin:0 0 16px;font-size:15px;line-height:1.6;">One click to renew — your updated policy and new report are generated instantly.</p>
      ${ctaButton('Renew now', `${SITE_URL}/platform`)}
    `,
  },
};

async function sendRenewalEmail(thresholdKey, toEmail, firmName) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) throw new Error('RESEND_API_KEY is not set');

  const tpl = TEMPLATES[thresholdKey];
  const html = emailShell(tpl.bodyHtml(firmName));

  const res = await fetch(RESEND_API_URL, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: FROM_ADDRESS, to: [toEmail], subject: tpl.subject, html }),
  });
  const result = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(result.message || `Resend API error: ${res.status}`);
  return result;
}

exports.handler = async function () {
  let serviceClient;
  try {
    serviceClient = makeServiceClient();
  } catch (e) {
    console.error('renewal-reminder.js: server misconfiguration:', e.message);
    return { statusCode: 500, body: 'Server misconfiguration' };
  }

  const summary = { checked: 0, reminded: 0, expired: 0, skipped: 0, failed: 0 };

  const candidatesRes = await serviceClient
    .from('firms')
    .select('id,name,report_expires_at')
    .selectAll('billing_status=eq.active&report_expires_at=not.is.null');

  if (candidatesRes.error) {
    console.error('renewal-reminder.js: candidate query failed:', candidatesRes.error.message);
    return { statusCode: 500, body: 'Candidate query failed' };
  }

  const candidates = candidatesRes.data || [];
  summary.checked = candidates.length;

  if (!candidates.length) {
    console.log('renewal-reminder.js: no candidates due, nothing to do.');
    return { statusCode: 200, body: JSON.stringify(summary) };
  }

  // Existing reminder sends for this batch, fetched once rather than
  // per-firm — same batching approach as onboarding-drip.js.
  const idList = candidates.map((f) => f.id).join(',');
  const sentRes = await serviceClient
    .from('renewal_reminders_sent')
    .select('firm_id,threshold_key,expiry_marker')
    .selectAll(`firm_id=in.(${idList})`);

  if (sentRes.error) {
    console.error('renewal-reminder.js: sent-log query failed:', sentRes.error.message);
    return { statusCode: 500, body: 'Sent-log query failed' };
  }

  const alreadySent = new Set(
    (sentRes.data || []).map((r) => `${r.firm_id}:${r.threshold_key}:${r.expiry_marker}`)
  );
  const now = Date.now();

  for (const firm of candidates) {
    try {
      const expiresAtMs = new Date(firm.report_expires_at).getTime();
      const daysUntilExpiry = Math.ceil((expiresAtMs - now) / 86400000);

      // Job 1: enforcement — the date has actually passed. Checked
      // first and unconditionally; a firm's access lapses on schedule
      // regardless of whether any reminder email happened to succeed.
      //
      // Guarded on report_expires_at matching the value just fetched,
      // not only billing_status = 'active' — without this, a renewal
      // payment landing via the GoCardless webhook in the narrow
      // window between this function's candidate fetch and this
      // update could set billing_status back to 'active' with a new
      // report_expires_at, and this write would then incorrectly
      // stomp it back to 'expired' using the stale pre-renewal read.
      if (daysUntilExpiry <= 0) {
        const updateRes = await serviceClient
          .from('firms')
          .eq('id', firm.id)
          .eq('billing_status', 'active')
          .eq('report_expires_at', firm.report_expires_at)
          .update({ billing_status: 'expired' });
        if (updateRes.error) throw updateRes.error;
        if (updateRes.data && updateRes.data.length > 0) {
          summary.expired++;
        } else {
          // Zero rows matched — the firm renewed in the narrow window
          // between the candidate fetch and this update. Correctly
          // not counted as an expiry; nothing was changed.
          summary.skipped++;
        }
        continue;
      }

      // Job 2: reminder sequence — first due-and-unsent threshold for
      // THIS expiry cycle only (expiry_marker scopes it, so a renewal
      // makes the sequence eligible again against the new date).
      const due = THRESHOLDS.find(
        (t) => daysUntilExpiry <= t.days && !alreadySent.has(`${firm.id}:${t.key}:${firm.report_expires_at}`)
      );
      if (!due) { summary.skipped++; continue; }

      const profileRes = await serviceClient
        .from('profiles')
        .select('id')
        .eq('firm_id', firm.id)
        .eq('role', 'admin')
        .maybeSingle();
      if (profileRes.error || !profileRes.data) {
        console.warn(`renewal-reminder.js: no admin profile found for firm ${firm.id}, skipping.`);
        summary.skipped++;
        continue;
      }

      const userRes = await serviceClient.auth.admin.getUserById(profileRes.data.id);
      if (userRes.error || !userRes.data || !userRes.data.user || !userRes.data.user.email) {
        console.warn(`renewal-reminder.js: could not resolve email for firm ${firm.id}, skipping.`);
        summary.skipped++;
        continue;
      }
      const toEmail = userRes.data.user.email;

      // Send BEFORE recording — see file header. A failed send must
      // never be mistaken for a sent one.
      await sendRenewalEmail(due.key, toEmail, firm.name || 'your firm');
      summary.reminded++;

      const insertRes = await serviceClient.from('renewal_reminders_sent').insert({
        firm_id: firm.id,
        threshold_key: due.key,
        expiry_marker: firm.report_expires_at,
      });
      if (insertRes.error) {
        console.error(`renewal-reminder.js: sent ${due.key} to firm ${firm.id} but failed to record dedupe marker:`, insertRes.error.message);
      }
    } catch (e) {
      console.error(`renewal-reminder.js: failed processing firm ${firm.id}:`, e.message);
      summary.failed++;
    }
  }

  console.log('renewal-reminder.js run summary:', JSON.stringify(summary));
  return { statusCode: 200, body: JSON.stringify(summary) };
};

// ─────────────────────────────────────────────────────────────
// Schedule declaration — lives in netlify.toml, NOT in this file.
// Add alongside the existing entries:
//
//   [functions."renewal-reminder"]
//     schedule = "@daily"
// ─────────────────────────────────────────────────────────────

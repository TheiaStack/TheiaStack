// Netlify Scheduled Function: netlify/functions/onboarding-drip.js
//
// Runs daily (schedule declared in netlify.toml, not in code — see
// note at the bottom of this file). Sends the Day 3 / 7 / 14 onboarding
// nudge sequence to firms that confirmed their signup email but have
// not yet completed their first audit.
//
// Security model — deliberately DIFFERENT from notify.js /
// notification-prefs.js / confirm-onboarding.js / signup.js:
//   Per Netlify's own documentation, scheduled functions cannot be
//   invoked directly via URL by an external caller — only via the
//   dashboard's "Run now" or `netlify functions:invoke` locally for
//   testing. There is no browser-facing entry point to protect here,
//   so this function carries no bearer-token verification, no CORS
//   handling, and no OPTIONS branch — none of that machinery serves
//   any purpose on a function nothing external can reach.
//
// Logic:
//   1. Fetch every firm with confirmed_at set and report_generated_at
//      still null — i.e. confirmed their email, never finished the
//      audit. This is the entire candidate pool.
//   2. For each candidate, compute days since confirmed_at. Walk the
//      thresholds [3, 7, 14] in order and find the FIRST one that is
//      both due (days since confirmed >= threshold) and not already
//      recorded in onboarding_emails_sent for that firm. Send only
//      that one email this run, then move to the next firm.
//        - Only ever sending the single earliest-due, not-yet-sent
//          email per firm per run means a firm never receives two
//          onboarding emails on the same day, even if a prior run was
//          missed (e.g. the scheduler had an outage) and multiple
//          thresholds became due at once. The next day's run picks up
//          the following threshold.
//   3. A firm with a report already generated is excluded entirely by
//      the initial query — the drip's only job is nudging firms that
//      haven't finished, and it goes silent the moment they have.
//   4. Admin email is looked up via the Auth Admin API against the
//      firm's admin profile id (profiles has no email column of its
//      own — mirrors the same lookup notify.js already does for
//      audit_completed).
//   5. The insert into onboarding_emails_sent relies on its
//      UNIQUE(firm_id, email_key) constraint as the real safeguard
//      against a duplicate send, not just the pre-check in step 2 —
//      if the insert conflicts, the email is treated as already sent
//      and skipped, not re-sent.
//   6. Each firm is processed inside its own try/catch so one firm's
//      failure (missing admin profile, Resend error, etc.) never
//      aborts the whole run. Failures are logged; the run continues
//      and finishes with a summary count.
//
// Schema relied on (confirmed via information_schema.columns and this
// project's own migration, 2 Sep 2026):
//   firms: id, name, confirmed_at (timestamptz, nullable),
//          report_generated_at (timestamptz, nullable)
//   profiles: id (= auth.users.id), firm_id, role
//   onboarding_emails_sent: id, firm_id, email_key, sent_at,
//          UNIQUE (firm_id, email_key)

const SUPABASE_URL = 'https://rkqnrpyctllxcnknjsby.supabase.co';

const THRESHOLDS = [
  { days: 3, key: 'day3' },
  { days: 7, key: 'day7' },
  { days: 14, key: 'day14' },
];

// Minimal service-role REST wrapper — same duplication precedent as
// every other function in this project (each keeps its own copy so a
// change for one can never risk breaking an already-working one).
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
          if (res.status === 406) return { data: null, error: null }; // no row found (or more than one)
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
          if (res.status === 409) return { error: null, conflict: true }; // UNIQUE violation — already sent
          if (!res.ok) {
            const detail = await res.text().catch(() => '');
            return { error: new Error(`PostgREST insert error ${res.status}: ${detail}`) };
          }
          return { error: null, conflict: false };
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

// Content grounded in the tone already established in the Sales
// Playbook's cold-email sequence: short, factual, no urgency language,
// no fabricated claims. Each is a distinct message, not a repeat of
// the same nudge with an escalating tone.
const TEMPLATES = {
  day3: {
    subject: 'Picking up your Theia-Stack audit',
    bodyHtml: (firstName, firmName) => `
      <p style="margin:0 0 16px;font-size:15px;line-height:1.6;">Hi ${firstName},</p>
      <p style="margin:0 0 16px;font-size:15px;line-height:1.6;">Your Theia-Stack account for ${firmName} is set up, but the audit hasn't been finished yet. It picks up exactly where you left off.</p>
      ${ctaButton('Continue your audit', `${SITE_URL}/login`)}
      <p style="margin:0;font-size:13px;color:#5A5A5A;line-height:1.6;">No rush — this link works whenever suits.</p>
    `,
  },
  day7: {
    subject: "What's waiting at the end of your audit",
    bodyHtml: (firstName, firmName) => `
      <p style="margin:0 0 16px;font-size:15px;line-height:1.6;">Hi ${firstName},</p>
      <p style="margin:0 0 16px;font-size:15px;line-height:1.6;">Finishing the audit for ${firmName} generates a written AI usage policy tailored to your tool list, and an AI Risk Management Report you can keep on file. Both are ready as soon as the audit is complete.</p>
      ${ctaButton('Continue your audit', `${SITE_URL}/login`)}
      <p style="margin:0;font-size:13px;color:#5A5A5A;line-height:1.6;">If now isn't the right time, the account stays open — nothing expires.</p>
    `,
  },
  day14: {
    subject: 'Leaving this here',
    bodyHtml: (firstName, firmName) => `
      <p style="margin:0 0 16px;font-size:15px;line-height:1.6;">Hi ${firstName},</p>
      <p style="margin:0 0 16px;font-size:15px;line-height:1.6;">Just closing the loop — your Theia-Stack account for ${firmName} is still there whenever it becomes a priority. No action needed from you now, and this is the last check-in on this.</p>
      ${ctaButton('Continue your audit', `${SITE_URL}/login`)}
    `,
  },
};

async function sendDripEmail(emailKey, toEmail, firstName, firmName) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) throw new Error('RESEND_API_KEY is not set');

  const tpl = TEMPLATES[emailKey];
  const html = emailShell(tpl.bodyHtml(firstName, firmName));

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
    console.error('onboarding-drip.js: server misconfiguration:', e.message);
    return { statusCode: 500, body: 'Server misconfiguration' };
  }

  const summary = { checked: 0, sent: 0, skipped: 0, failed: 0 };

  // Step 1: candidate pool — confirmed, audit not yet completed.
  const candidatesRes = await serviceClient
    .from('firms')
    .select('id,name,confirmed_at')
    .selectAll('confirmed_at=not.is.null&report_generated_at=is.null');

  if (candidatesRes.error) {
    console.error('onboarding-drip.js: candidate query failed:', candidatesRes.error.message);
    return { statusCode: 500, body: 'Candidate query failed' };
  }

  const candidates = candidatesRes.data || [];
  summary.checked = candidates.length;

  if (!candidates.length) {
    console.log('onboarding-drip.js: no candidates due, nothing to do.');
    return { statusCode: 200, body: JSON.stringify(summary) };
  }

  // Step 2: existing sends for this candidate set, fetched once rather
  // than per-firm.
  const idList = candidates.map((f) => f.id).join(',');
  const sentRes = await serviceClient
    .from('onboarding_emails_sent')
    .select('firm_id,email_key')
    .selectAll(`firm_id=in.(${idList})`);

  if (sentRes.error) {
    console.error('onboarding-drip.js: sent-log query failed:', sentRes.error.message);
    return { statusCode: 500, body: 'Sent-log query failed' };
  }

  const alreadySent = new Set((sentRes.data || []).map((r) => `${r.firm_id}:${r.email_key}`));
  const now = Date.now();

  for (const firm of candidates) {
    try {
      const confirmedAtMs = new Date(firm.confirmed_at).getTime();
      const daysSince = Math.floor((now - confirmedAtMs) / 86400000);

      // First due-and-unsent threshold only — see file header for why
      // this is capped at one per firm per run.
      const due = THRESHOLDS.find(
        (t) => daysSince >= t.days && !alreadySent.has(`${firm.id}:${t.key}`)
      );

      if (!due) { summary.skipped++; continue; }

      // Find the firm's admin profile to get a user id for the email
      // lookup. profiles has no email column of its own.
      const profileRes = await serviceClient
        .from('profiles')
        .select('id,display_name')
        .eq('firm_id', firm.id)
        .eq('role', 'admin')
        .maybeSingle();

      if (profileRes.error || !profileRes.data) {
        console.warn(`onboarding-drip.js: no admin profile found for firm ${firm.id}, skipping.`);
        summary.skipped++;
        continue;
      }

      const userRes = await serviceClient.auth.admin.getUserById(profileRes.data.id);
      if (userRes.error || !userRes.data || !userRes.data.user || !userRes.data.user.email) {
        console.warn(`onboarding-drip.js: could not resolve email for firm ${firm.id}, skipping.`);
        summary.skipped++;
        continue;
      }
      const toEmail = userRes.data.user.email;
      const firstName = (profileRes.data.display_name || '').split(' ')[0] || 'there';

      // Reserve the send first — if this conflicts, another process
      // already sent this exact email, so skip sending entirely rather
      // than risk a duplicate.
      const insertRes = await serviceClient.from('onboarding_emails_sent').insert({
        firm_id: firm.id,
        email_key: due.key,
      });
      if (insertRes.error) throw insertRes.error;
      if (insertRes.conflict) {
        console.log(`onboarding-drip.js: ${due.key} already recorded for firm ${firm.id}, skipping send.`);
        summary.skipped++;
        continue;
      }

      await sendDripEmail(due.key, toEmail, firstName, firm.name || 'your firm');
      summary.sent++;
    } catch (e) {
      console.error(`onboarding-drip.js: failed processing firm ${firm.id}:`, e.message);
      summary.failed++;
    }
  }

  console.log('onboarding-drip.js run summary:', JSON.stringify(summary));
  return { statusCode: 200, body: JSON.stringify(summary) };
};

// ─────────────────────────────────────────────────────────────
// Schedule declaration — lives in netlify.toml, NOT in this file.
// Add the following block to netlify.toml (this is the first
// scheduled function in this project, so there's nothing existing to
// merge with — just append it):
//
//   [functions."onboarding-drip"]
//     schedule = "@daily"
//
// This avoids adding the @netlify/functions npm package as a new
// dependency just to declare a schedule inline — every other function
// in this project is dependency-free, and this keeps that true.
// ─────────────────────────────────────────────────────────────

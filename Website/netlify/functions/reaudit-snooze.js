// Netlify Function: netlify/functions/reaudit-snooze.js
//
// Public GET endpoint reached by clicking "Remind me in 14 days" in the
// quarterly_reaudit_due email (see notification-templates.js). No
// session exists at this point — the person is reading an email, not
// logged into the platform — so the link itself is the credential,
// verified via link-signing.js rather than any auth check.
//
// Query params: firm (firm id), marker (the report_generated_at ISO
// string this link was generated for, URL-encoded), sig (HMAC over
// [firm, marker] — see lib/link-signing.js).
//
// The marker is checked against the firm's CURRENT report_generated_at,
// not just the signature — if the firm has already re-audited since
// this email was sent, report_generated_at has moved on and this link
// is for a stale cycle, so it's treated as a no-op rather than
// snoozing a reminder for a cycle that no longer applies. This also
// means an old email can never be replayed to snooze a future,
// unrelated cycle.
//
// Sets firms.reaudit_snoozed_until = now + 14 days. reaudit-reminder.js
// checks this before sending and skips any firm still within it.
//
// Returns a plain branded HTML confirmation page — there is nothing to
// build a JSON response for here, the person is looking at this in a
// browser tab after clicking an email link.

const SUPABASE_URL = 'https://rkqnrpyctllxcnknjsby.supabase.co';
const SNOOZE_DAYS = 14;

const { verifyLink } = require('./lib/link-signing');
const { BRAND } = require('./lib/email-shell');

function page({ heading, message, isError }) {
  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>${heading}</title></head>
<body style="margin:0; padding:0; background-color:${BRAND.offWhite}; font-family:'DM Sans', Arial, sans-serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="padding: 48px 16px;">
    <tr><td align="center">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:480px; background-color:${BRAND.white}; border-top: 3px solid ${isError ? BRAND.midGrey : BRAND.red};">
        <tr><td style="padding: 40px;">
          <span style="font-family:'Playfair Display', Georgia, serif; font-size: 20px; font-weight: 700; color:${BRAND.black};">THEIA-STACK</span>
          <h1 style="font-family:'Playfair Display', Georgia, serif; font-size: 22px; color:${BRAND.black}; margin: 24px 0 12px 0;">${heading}</h1>
          <p style="font-size: 15px; line-height: 1.6; color:${BRAND.darkGrey};">${message}</p>
          <a href="https://theiastack.com.au/platform" style="display:inline-block; margin-top: 16px; color:${BRAND.black}; text-decoration:underline; font-size: 14px;">Go to Theia-Stack &rarr;</a>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

async function updateFirm(serviceKey, firmId, patch) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/firms?id=eq.${encodeURIComponent(firmId)}`, {
    method: 'PATCH',
    headers: {
      'apikey': serviceKey,
      'Authorization': `Bearer ${serviceKey}`,
      'Content-Type': 'application/json',
      'Prefer': 'return=representation',
    },
    body: JSON.stringify(patch),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`PostgREST update error ${res.status}: ${detail}`);
  }
  const rows = await res.json();
  return rows[0] || null;
}

async function fetchFirm(serviceKey, firmId) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/firms?id=eq.${encodeURIComponent(firmId)}&select=id,report_generated_at`, {
    headers: {
      'apikey': serviceKey,
      'Authorization': `Bearer ${serviceKey}`,
      'Accept': 'application/vnd.pgrst.object+json',
    },
  });
  if (res.status === 406) return null;
  if (!res.ok) throw new Error(`PostgREST error ${res.status}`);
  return res.json();
}

exports.handler = async function (event) {
  const headers = { 'Content-Type': 'text/html; charset=utf-8' };

  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!serviceKey) {
    console.error('reaudit-snooze.js: SUPABASE_SERVICE_ROLE_KEY is not set');
    return { statusCode: 500, headers, body: page({ heading: 'Something went wrong', message: 'This link couldn\u2019t be processed right now. Please try again later, or just ignore this \u2014 nothing has changed.', isError: true }) };
  }

  const params = event.queryStringParameters || {};
  const { firm, marker, sig } = params;

  if (!firm || !marker || !sig || !verifyLink([firm, marker], sig)) {
    // Deliberately generic — this is a public, unauthenticated endpoint,
    // so the error message must not confirm or deny whether a given
    // firm id is valid.
    return { statusCode: 400, headers, body: page({ heading: 'Link not recognised', message: 'This link is invalid or has expired. If you\u2019re trying to manage your reminder preferences, you can do that anytime from Settings inside the platform.', isError: true }) };
  }

  try {
    const firmRow = await fetchFirm(serviceKey, firm);
    if (!firmRow) {
      return { statusCode: 400, headers, body: page({ heading: 'Link not recognised', message: 'This link is invalid or has expired.', isError: true }) };
    }

    // If the firm has already re-audited since this email was sent,
    // report_generated_at has moved on — this link is for a stale
    // cycle and snoozing it now would incorrectly suppress the NEXT
    // cycle's reminder too. Treat as a no-op, not an error, since
    // from the person's point of view they did nothing wrong.
    if (firmRow.report_generated_at !== marker) {
      return { statusCode: 200, headers, body: page({ heading: 'All good', message: 'Looks like you\u2019ve already re-audited since this email was sent \u2014 nothing further needed here.' }) };
    }

    const snoozeUntil = new Date(Date.now() + SNOOZE_DAYS * 86400000).toISOString();
    await updateFirm(serviceKey, firm, { reaudit_snoozed_until: snoozeUntil });

    return {
      statusCode: 200,
      headers,
      body: page({
        heading: 'Reminder snoozed',
        message: `No problem \u2014 we\u2019ll remind you again in ${SNOOZE_DAYS} days. You can also turn quarterly reminders off entirely anytime from Settings inside the platform.`,
      }),
    };
  } catch (e) {
    console.error('reaudit-snooze.js error:', e.message);
    return { statusCode: 500, headers, body: page({ heading: 'Something went wrong', message: 'This link couldn\u2019t be processed right now. Please try again later, or just ignore this \u2014 nothing has changed.', isError: true }) };
  }
};

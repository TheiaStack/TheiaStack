// Netlify function: netlify/functions/signup.js
//
// Public, UNAUTHENTICATED endpoint: self-serve firm signup (Section 3
// of the launch task list). Unlike notify.js / notification-prefs.js,
// there is no session yet at this point, so this function cannot use
// their bearer-token verifySession() pattern. Security here instead
// rests on reCAPTCHA v3 (bot/abuse gate), a server-side work-email
// domain check (free consumer domains rejected, since client-side
// checks are trivially bypassed), and the fact that the new auth user
// has no platform access until the firm actually clicks the Resend
// confirmation email and verifyOtp() succeeds client-side.
//
// Flow:
//   1. Verify reCAPTCHA v3 token, score, and action against Google's
//      siteverify endpoint before touching Supabase at all.
//   2. Validate fields and reject free-domain work emails, server-side.
//   3. supabase.auth.admin.generateLink({type:'signup', email,
//      password, data}) creates the (unconfirmed) auth user and
//      returns a hashed_token in one call. This does NOT trigger
//      Supabase's own confirmation email; only a link/token comes
//      back, which we send ourselves.
//   4. Insert firms row (billing_status: 'no_billing') + profiles row
//      (role: 'admin'), linked to the new user id.
//   5. On any failure AFTER the auth user is created, roll back by
//      deleting it via the Admin API. Never leave an orphaned auth
//      user with no firm or profile.
//   6. Email the confirmation link ourselves via Resend (branded),
//      using the same token_hash + verifyOtp()-on-load pattern already
//      used for password reset, not Supabase's default template or
//      sender. The /signup-confirm page (frontend, built separately)
//      calls verifyOtp({ token_hash, type: 'signup' }) once on load.
//
// Schema relied on (confirmed via information_schema.columns, 29 Aug 2026):
//   firms: id (default gen_random_uuid()), name, subscription_tier,
//          created_at, report_generated_at, report_expires_at,
//          gocardless_*, billing_plan, billing_status (NOT NULL,
//          default 'no_billing'), next_renewal_date
//   profiles: id (= auth.users.id, NOT NULL), firm_id, role (default
//             'admin'), display_name, permissions (jsonb, has a sane
//             default, not set explicitly here)
//
// Manual setup this function depends on (not code, flagged separately):
//   - Netlify env vars: RECAPTCHA_SECRET_KEY, RESEND_API_KEY (already
//     set), SUPABASE_SERVICE_ROLE_KEY (already set)
//   - Supabase Authentication > URL Configuration > Redirect URLs must
//     include https://theiastack.com.au/signup-confirm (and the
//     Netlify preview equivalent). generateLink's redirect_to is only
//     honoured if it is on that allowlist.

const SUPABASE_URL = 'https://rkqnrpyctllxcnknjsby.supabase.co';

const PROD_ORIGINS = [
  'https://theiastack.com.au',
  'https://www.theiastack.com.au'
];

// Free consumer email providers, rejected so the work-email domain
// check in the scoped Section 3 plan is enforced server-side, not
// just client-side. Not exhaustive; extend if a gap shows up in
// practice.
const FREE_EMAIL_DOMAINS = [
  'gmail.com', 'googlemail.com',
  'outlook.com', 'hotmail.com', 'hotmail.co.uk', 'live.com', 'live.com.au', 'msn.com',
  'yahoo.com', 'yahoo.com.au', 'yahoo.co.uk',
  'icloud.com', 'me.com', 'mac.com',
  'aol.com',
  'protonmail.com', 'proton.me',
  'zoho.com',
  'gmx.com', 'gmx.net',
  'mail.com',
  'yandex.com',
  'fastmail.com',
  'hey.com',
  'bigpond.com', 'optusnet.com.au', 'iinet.net.au', 'tpg.com.au'
];

function isAllowedOrigin(origin) {
  if (!origin) return false;
  if (PROD_ORIGINS.includes(origin)) return true;
  if (/^https:\/\/[a-z0-9-]+--theiastack\.netlify\.app$/.test(origin)) return true;
  if (/^https:\/\/theiastack\.netlify\.app$/.test(origin)) return true;
  if (/^http:\/\/localhost(:\d+)?$/.test(origin)) return true;
  return false;
}

function corsHeaders(event) {
  const origin = event.headers && (event.headers.origin || event.headers.Origin);
  const allowOrigin = isAllowedOrigin(origin) ? origin : PROD_ORIGINS[0];
  return {
    'Access-Control-Allow-Origin': allowOrigin,
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json'
  };
}

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function isFreeEmailDomain(email) {
  const at = email.lastIndexOf('@');
  if (at === -1) return true;
  const domain = email.slice(at + 1).trim().toLowerCase();
  return FREE_EMAIL_DOMAINS.includes(domain);
}

async function verifyRecaptcha(token, remoteIp) {
  const secret = process.env.RECAPTCHA_SECRET_KEY;
  if (!secret) throw new Error('RECAPTCHA_SECRET_KEY is not set');
  const params = new URLSearchParams({ secret, response: token || '' });
  if (remoteIp) params.append('remoteip', remoteIp);
  const res = await fetch('https://www.google.com/recaptcha/api/siteverify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString()
  });
  if (!res.ok) return { success: false, score: 0 };
  return res.json();
}

// Minimal service-role REST helper, same duplication precedent as
// notify.js / notification-prefs.js (each keeps its own copy rather
// than sharing a lib, so a change for one endpoint can never risk
// breaking an already-working one). This copy adds the two Admin Auth
// calls signup needs (generate_link, delete user) that neither
// existing file required.
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
        insert: async (row) => {
          const res = await restRequest(table, { method: 'POST', body: JSON.stringify(row) });
          if (!res.ok) {
            const detail = await res.text().catch(() => '');
            return { data: null, error: new Error(`PostgREST insert error ${res.status}: ${detail}`) };
          }
          const data = await res.json();
          return { data, error: null };
        },
      };
      return api;
    },
    auth: {
      admin: {
        generateLink: async (params) => {
          const res = await fetch(`${SUPABASE_URL}/auth/v1/admin/generate_link`, {
            method: 'POST',
            headers: {
              'apikey': serviceKey,
              'Authorization': `Bearer ${serviceKey}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify(params),
          });
          const body = await res.json().catch(() => ({}));
          if (!res.ok) {
            return { data: null, error: new Error(body.msg || body.error_description || body.error || `generate_link error ${res.status}`) };
          }
          return { data: body, error: null };
        },
        deleteUser: async (userId) => {
          const res = await fetch(`${SUPABASE_URL}/auth/v1/admin/users/${userId}`, {
            method: 'DELETE',
            headers: { 'apikey': serviceKey, 'Authorization': `Bearer ${serviceKey}` },
          });
          return { error: res.ok ? null : new Error(`delete user error ${res.status}`) };
        },
      },
    },
  };
}

const FROM_ADDRESS = 'Theia-Stack <hello@theiastack.com.au>';
const RESEND_API_URL = 'https://api.resend.com/emails';

async function sendConfirmationEmail(toEmail, firstName, firmName, confirmUrl) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) throw new Error('RESEND_API_KEY is not set');

  const subject = 'Confirm your Theia-Stack account';
  const html = `
  <div style="font-family:'DM Sans',Arial,sans-serif;background:#F2F2F2;padding:32px;">
    <div style="max-width:480px;margin:0 auto;background:#FFFFFF;border-radius:10px;overflow:hidden;border:1px solid #D0D0D0;">
      <div style="background:#111111;padding:24px 32px;">
        <span style="font-family:Georgia,'Playfair Display',serif;color:#FFFFFF;font-size:20px;letter-spacing:-.02em;">THEIA-STACK</span>
      </div>
      <div style="padding:32px;color:#111111;">
        <p style="margin:0 0 16px;font-size:15px;line-height:1.6;">Hi ${firstName},</p>
        <p style="margin:0 0 16px;font-size:15px;line-height:1.6;">Please confirm your email address to activate the Theia-Stack account for ${firmName} and begin your free AI compliance audit.</p>
        <p style="margin:24px 0;">
          <a href="${confirmUrl}" style="display:inline-block;background:#B83232;color:#FFFFFF;text-decoration:none;padding:12px 28px;border-radius:10px;font-size:14px;font-weight:500;">Confirm your email address</a>
        </p>
        <p style="margin:0 0 8px;font-size:13px;color:#5A5A5A;line-height:1.6;">If the button above does not work, copy this link into your browser:</p>
        <p style="margin:0;font-size:12px;color:#5A5A5A;word-break:break-all;">${confirmUrl}</p>
      </div>
    </div>
  </div>`;

  const res = await fetch(RESEND_API_URL, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: FROM_ADDRESS, to: [toEmail], subject, html }),
  });
  const result = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(result.message || `Resend API error: ${res.status}`);
  return result;
}

exports.handler = async function (event) {
  const headers = corsHeaders(event);

  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  let payload;
  try {
    payload = JSON.parse(event.body || '{}');
  } catch (e) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid JSON body' }) };
  }

  const firstName = (payload.firstName || '').trim();
  const lastName = (payload.lastName || '').trim();
  const firmName = (payload.firmName || '').trim();
  const email = (payload.email || '').trim().toLowerCase();
  const password = payload.password || '';
  const captchaToken = payload.captchaToken || '';

  if (!firstName || !lastName || !firmName || !email || !password) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'All fields are required' }) };
  }
  if (!isValidEmail(email)) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Enter a valid email address' }) };
  }
  if (isFreeEmailDomain(email)) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: "Please sign up with your firm's work email address, not a personal email provider" }) };
  }
  if (password.length < 8) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Password must be at least 8 characters' }) };
  }

  // reCAPTCHA v3: verify token, score, and action before touching
  // Supabase at all.
  try {
    const remoteIp = event.headers && (event.headers['x-nf-client-connection-ip'] || event.headers['client-ip']);
    const captchaResult = await verifyRecaptcha(captchaToken, remoteIp);
    const scoreOk = typeof captchaResult.score !== 'number' || captchaResult.score >= 0.5;
    const actionOk = !captchaResult.action || captchaResult.action === 'signup';
    if (!captchaResult.success || !scoreOk || !actionOk) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Verification failed. Please try again.' }) };
    }
  } catch (e) {
    console.error('reCAPTCHA verification error:', e.message);
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Server misconfiguration' }) };
  }

  let serviceClient;
  try {
    serviceClient = makeServiceClient();
  } catch (e) {
    console.error(e.message);
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Server misconfiguration' }) };
  }

  // Step 1: create the (unconfirmed) auth user and get a hashed_token,
  // in one call. This does NOT send Supabase's own confirmation email.
  // generateLink only returns the link/token; we send it ourselves
  // via Resend below.
  const siteUrl = PROD_ORIGINS[0];
  const linkRes = await serviceClient.auth.admin.generateLink({
    type: 'signup',
    email,
    password,
    data: { first_name: firstName, last_name: lastName, firm_name: firmName },
    redirect_to: `${siteUrl}/signup-confirm`,
  });

  if (linkRes.error || !linkRes.data || !linkRes.data.properties || !linkRes.data.properties.hashed_token) {
    const msg = (linkRes.error && linkRes.error.message) || '';
    if (/already registered|already exists/i.test(msg)) {
      return { statusCode: 409, headers, body: JSON.stringify({ error: 'An account with this email already exists. Try signing in instead.' }) };
    }
    console.error('generateLink error:', msg);
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Could not create account' }) };
  }

  const newUserId = linkRes.data.id || (linkRes.data.user && linkRes.data.user.id);
  const hashedToken = linkRes.data.properties.hashed_token;

  if (!newUserId) {
    console.error('generateLink succeeded but no user id in response:', JSON.stringify(linkRes.data));
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Could not create account' }) };
  }

  // Step 2: create the firm + profile, linked to the new user. If
  // either fails, roll back the auth user rather than leaving an
  // orphaned account with no firm.
  try {
    const firmIns = await serviceClient.from('firms').insert({
      name: firmName,
      billing_status: 'no_billing',
    });
    if (firmIns.error || !firmIns.data || !firmIns.data[0]) throw firmIns.error || new Error('Firm insert returned no row');
    const newFirmId = firmIns.data[0].id;

    const profileIns = await serviceClient.from('profiles').insert({
      id: newUserId,
      firm_id: newFirmId,
      role: 'admin',
      display_name: `${firstName} ${lastName}`,
    });
    if (profileIns.error) throw profileIns.error;
  } catch (e) {
    console.error('firm/profile creation failed, rolling back auth user:', e.message);
    await serviceClient.auth.admin.deleteUser(newUserId);
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Could not create account' }) };
  }

  // Step 3: send our own branded confirmation email via Resend, using
  // the same token_hash + verifyOtp()-on-load pattern as password
  // reset (survives link-safety scanners; Supabase's own
  // template/sender is never used).
  const confirmUrl = `${siteUrl}/signup-confirm?token_hash=${encodeURIComponent(hashedToken)}&type=signup`;
  try {
    await sendConfirmationEmail(email, firstName, firmName, confirmUrl);
  } catch (e) {
    // Account and firm already exist at this point. Do not roll back
    // over an email delivery failure; just surface it so it can be
    // resent manually.
    console.error('Confirmation email send failed:', e.message);
    return { statusCode: 200, headers, body: JSON.stringify({ ok: true, emailSent: false, warning: 'Account created but the confirmation email failed to send. Contact hello@theiastack.com.au.' }) };
  }

  return { statusCode: 200, headers, body: JSON.stringify({ ok: true, emailSent: true }) };
};

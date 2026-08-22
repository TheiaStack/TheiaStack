// Netlify function: netlify/functions/gocardless-start-billing.js
//
// Section 2, Phase 3 — kicks off the GoCardless mandate setup flow.
//
// Security model (mirrors claude.js / notify.js):
//   - Requires a valid Supabase session bearer token, verified the
//     same way as the other functions, using the ANON key against
//     /auth/v1/user.
//   - firmId is NEVER trusted from the client — it's derived
//     server-side from profiles.firm_id for the verified user.
//   - Once verified, firm reads/writes use the SERVICE ROLE client.
//
// What this does NOT do yet (Phase 4):
//   - It does not create the actual $2,990 payment or the 12x$299
//     instalment schedule. GoCardless's own guidance is explicit:
//     "Don't rely on the redirect back to your site to confirm the
//     outcome. Always use webhooks." So the mandate-only Billing
//     Request is created here, and the actual payment/instalment
//     schedule creation happens in gocardless-webhook.js once
//     GoCardless confirms (via webhook) that the mandate is active.
//     This function's job is only: create the Billing Request,
//     stash which plan the firm chose, and hand back a redirect URL.

const SUPABASE_URL = 'https://rkqnrpyctllxcnknjsby.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_7gIWX3E2pS_4UfEKJylqpw_V3CIY1b9';

const PROD_ORIGINS = [
  'https://theiastack.com.au',
  'https://www.theiastack.com.au'
];

// Sandbox vs live use different API base URLs. Defaults to sandbox —
// deliberately, since that's what we're testing against first (see
// Section 2, Phase 7 in the task list for the live cutover step).
// Set GOCARDLESS_ENVIRONMENT=live in Netlify when ready to go live.
const GOCARDLESS_ENVIRONMENT = process.env.GOCARDLESS_ENVIRONMENT || 'sandbox';
const GOCARDLESS_API_BASE = GOCARDLESS_ENVIRONMENT === 'live'
  ? 'https://api.gocardless.com'
  : 'https://api-sandbox.gocardless.com';

const VALID_PLANS = ['annual', 'monthly'];

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
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json'
  };
}

async function verifySession(authHeader) {
  if (!authHeader || !authHeader.startsWith('Bearer ')) return null;
  const token = authHeader.slice(7).trim();
  if (!token) return null;
  try {
    const res = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: { 'Authorization': `Bearer ${token}`, 'apikey': SUPABASE_ANON_KEY }
    });
    if (!res.ok) return null;
    const user = await res.json();
    return user && user.id ? user : null;
  } catch (e) {
    return null;
  }
}

// Same hand-rolled service-role REST wrapper used in notify.js /
// notification-prefs.js — kept consistent rather than introducing a
// new dependency or a new pattern.
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
  return { restRequest };
}

async function getFirm(serviceClient, userId) {
  const profileRes = await serviceClient.restRequest(
    `profiles?id=eq.${encodeURIComponent(userId)}&select=firm_id`,
    { headers: { 'Accept': 'application/vnd.pgrst.object+json' } }
  );
  if (!profileRes.ok) return null;
  const profile = await profileRes.json();
  if (!profile || !profile.firm_id) return null;

  const firmRes = await serviceClient.restRequest(
    `firms?id=eq.${encodeURIComponent(profile.firm_id)}&select=id,name,billing_status`,
    { headers: { 'Accept': 'application/vnd.pgrst.object+json' } }
  );
  if (!firmRes.ok) return null;
  const firm = await firmRes.json();
  return firm && firm.id ? firm : null;
}

// Thin GoCardless API caller — a single access token, JSON in/out,
// GoCardless-Version header pinned to the current stable version.
async function gocardlessRequest(path, body) {
  const token = process.env.GOCARDLESS_ACCESS_TOKEN;
  if (!token) throw new Error('GOCARDLESS_ACCESS_TOKEN is not set');

  const res = await fetch(`${GOCARDLESS_API_BASE}${path}`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
      'GoCardless-Version': '2015-07-06',
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch (e) { json = null; }
  return { ok: res.ok, status: res.status, json, raw: text };
}

exports.handler = async function (event) {
  const headers = corsHeaders(event);

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  const authHeader = event.headers && (event.headers.authorization || event.headers.Authorization);
  const user = await verifySession(authHeader);
  if (!user) {
    return { statusCode: 401, headers, body: JSON.stringify({ error: 'Unauthorized' }) };
  }

  let payload;
  try {
    payload = JSON.parse(event.body || '{}');
  } catch (e) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid JSON body' }) };
  }

  const plan = payload.plan;
  if (!VALID_PLANS.includes(plan)) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'plan must be "annual" or "monthly"' }) };
  }

  let serviceClient;
  let firm;
  try {
    serviceClient = makeServiceClient();
    firm = await getFirm(serviceClient, user.id);
  } catch (e) {
    console.error('Firm lookup failed:', e);
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Server misconfiguration' }) };
  }

  if (!firm) {
    return { statusCode: 404, headers, body: JSON.stringify({ error: 'No firm found for this account' }) };
  }

  if (firm.billing_status === 'active') {
    return { statusCode: 409, headers, body: JSON.stringify({ error: 'This firm already has an active subscription' }) };
  }

  // Origin used to build the redirect/exit URLs — falls back to the
  // production domain if no Origin header is present (e.g. server-
  // side test calls).
  const origin = (event.headers && (event.headers.origin || event.headers.Origin)) || PROD_ORIGINS[0];

  try {
    // Step 1: create a mandate-only Billing Request. No payment is
    // attached here — the payment / instalment schedule is created
    // by the webhook handler once the mandate is confirmed active.
    // metadata.firm_id lets the webhook correlate the eventual
    // mandate/customer back to a specific firm without needing to
    // trust anything from the client at that point either.
    const brRes = await gocardlessRequest('/billing_requests', {
      billing_requests: {
        mandate_request: {
          scheme: 'becs',
          currency: 'AUD',
        },
        metadata: {
          firm_id: firm.id,
          billing_plan: plan,
        },
      },
    });

    if (!brRes.ok || !brRes.json || !brRes.json.billing_requests) {
      console.error('GoCardless billing_requests create failed:', brRes.status, brRes.raw);
      return { statusCode: 502, headers, body: JSON.stringify({ error: 'Could not start billing setup. Please try again.' }) };
    }

    const billingRequestId = brRes.json.billing_requests.id;

    // Step 2: create the Billing Request Flow — this is what
    // produces the actual hosted URL to redirect the firm to.
    const flowRes = await gocardlessRequest('/billing_request_flows', {
      billing_request_flows: {
        redirect_uri: `${origin}/platform.html?billing=complete`,
        exit_uri: `${origin}/platform.html?billing=cancelled`,
        links: {
          billing_request: billingRequestId,
        },
      },
    });

    if (!flowRes.ok || !flowRes.json || !flowRes.json.billing_request_flows) {
      console.error('GoCardless billing_request_flows create failed:', flowRes.status, flowRes.raw);
      return { statusCode: 502, headers, body: JSON.stringify({ error: 'Could not start billing setup. Please try again.' }) };
    }

    const authorisationUrl = flowRes.json.billing_request_flows.authorisation_url;

    // Record the chosen plan and pending status against the firm now,
    // so the UI can reflect "pending" immediately. The webhook handler
    // will overwrite billing_status to 'active' once the mandate is
    // genuinely confirmed — this is just the optimistic first write.
    await serviceClient.restRequest(`firms?id=eq.${encodeURIComponent(firm.id)}`, {
      method: 'PATCH',
      prefer: 'return=minimal',
      body: JSON.stringify({ billing_plan: plan, billing_status: 'pending_mandate' }),
    });

    return { statusCode: 200, headers, body: JSON.stringify({ authorisation_url: authorisationUrl }) };

  } catch (err) {
    console.error('gocardless-start-billing error:', err);
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Upstream request failed' }) };
  }
};

// Netlify function: netlify/functions/billing-status.js
//
// Section 2, Phase 6 — read-only endpoint for the client-facing billing
// portal (platform.html Settings tab). Returns the verified user's own
// firm's billing fields so the UI can show subscription status,
// renewal date, and mandate reference.
//
// Security model (mirrors gocardless-start-billing.js / notify.js):
//   - Requires a valid Supabase session bearer token, verified against
//     /auth/v1/user using the ANON key.
//   - firmId is NEVER trusted from the client — it's derived
//     server-side from profiles.firm_id for the verified user.
//   - Firm reads use the SERVICE ROLE client, since the firms table's
//     RLS is not confirmed to allow member self-select — this avoids
//     that assumption entirely, consistent with how gocardless-start-
//     billing.js and gocardless-webhook.js already handle firm data.
//   - Read-only: no writes happen here.

const SUPABASE_URL = 'https://rkqnrpyctllxcnknjsby.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_7gIWX3E2pS_4UfEKJylqpw_V3CIY1b9';

const PROD_ORIGINS = [
  'https://theiastack.com.au',
  'https://www.theiastack.com.au'
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

async function getFirmBilling(serviceClient, userId) {
  const profileRes = await serviceClient.restRequest(
    `profiles?id=eq.${encodeURIComponent(userId)}&select=firm_id`,
    { headers: { 'Accept': 'application/vnd.pgrst.object+json' } }
  );
  if (!profileRes.ok) return null;
  const profile = await profileRes.json();
  if (!profile || !profile.firm_id) return null;

  const firmRes = await serviceClient.restRequest(
    `firms?id=eq.${encodeURIComponent(profile.firm_id)}&select=billing_status,billing_plan,gocardless_mandate_id,next_renewal_date`,
    { headers: { 'Accept': 'application/vnd.pgrst.object+json' } }
  );
  if (!firmRes.ok) return null;
  const firm = await firmRes.json();
  return firm || null;
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

  try {
    const serviceClient = makeServiceClient();
    const billing = await getFirmBilling(serviceClient, user.id);
    if (!billing) {
      return { statusCode: 404, headers, body: JSON.stringify({ error: 'No firm found for this account' }) };
    }
    return { statusCode: 200, headers, body: JSON.stringify(billing) };
  } catch (err) {
    console.error('billing-status error:', err);
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Server error' }) };
  }
};

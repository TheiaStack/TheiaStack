// Netlify function: netlify/functions/confirm-onboarding.js
//
// Authenticated, single-purpose endpoint: stamps firms.confirmed_at
// the moment a firm's account is confirmed via /signup-confirm. This
// is the anchor point for the onboarding email drip (Day 3/7/14) —
// the scheduled onboarding-drip.js function reads this column rather
// than calling the Auth Admin API per firm on every run.
//
// Security model — identical to notify.js / notification-prefs.js:
//   - Requires a valid Supabase session bearer token, verified against
//     /auth/v1/user using the ANON key. signup-confirm.html already has
//     a live session at the point it calls this, since verifyOtp()
//     just established one.
//   - firmId is NEVER trusted from the client. It's derived
//     server-side from profiles.firm_id for the verified user's id —
//     same pattern as notify.js.
//   - The actual write uses the SERVICE ROLE client, since firms has
//     no client-writable UPDATE policy (confirmed via pg_policy: only
//     firms_select_own exists, SELECT-only, scoped to
//     id = auth_firm_id()). A direct client-side write would fail
//     silently under RLS, so this endpoint exists specifically to do
//     the one write firms.confirmed_at ever needs.
//
// Idempotent by design: if confirmed_at is already set (e.g. this
// endpoint is called twice — page refresh, retry, etc.), the function
// returns success without overwriting the original timestamp. The
// FIRST confirmation moment is what matters for the drip; a later
// duplicate call must never reset the Day 0 anchor forward.
//
// Deliberately a separate file from notify.js / notification-prefs.js,
// same precedent as notification-prefs.js's own header explains — each
// endpoint keeps its own copy of the service-role wrapper so a change
// for one can never risk breaking an already-working one.

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

// Same minimal service-role REST wrapper as notify.js / notification-prefs.js
// (duplicated deliberately — see file header). Only the two query shapes
// this endpoint actually needs are implemented.
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
          if (res.status === 406) return { data: null, error: null }; // no row found
          if (!res.ok) return { data: null, error: new Error(`PostgREST error ${res.status}`) };
          const data = await res.json();
          return { data, error: null };
        },
        update: async (patch) => {
          const qs = filters.length ? `?${filters.join('&')}` : '';
          const res = await restRequest(`${table}${qs}`, { method: 'PATCH', body: JSON.stringify(patch) });
          if (!res.ok) return { error: new Error(`PostgREST update error ${res.status}`) };
          return { error: null };
        },
      };
      return api;
    },
  };
}

exports.handler = async function (event) {
  const headers = corsHeaders(event);

  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  const authHeader = event.headers && (event.headers.authorization || event.headers.Authorization);
  const user = await verifySession(authHeader);
  if (!user) {
    return { statusCode: 401, headers, body: JSON.stringify({ error: 'Unauthorized' }) };
  }

  let serviceClient;
  try {
    serviceClient = makeServiceClient();
  } catch (e) {
    console.error(e.message);
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Server misconfiguration' }) };
  }

  // Derive firmId server-side — never trust client input for this,
  // same as notify.js / notification-prefs.js.
  const profileRes = await serviceClient.from('profiles').select('firm_id').eq('id', user.id).maybeSingle();
  if (profileRes.error || !profileRes.data || !profileRes.data.firm_id) {
    return { statusCode: 403, headers, body: JSON.stringify({ error: 'No firm associated with this account' }) };
  }
  const firmId = profileRes.data.firm_id;

  try {
    // Idempotency check: only stamp confirmed_at if it isn't already
    // set. A second call (refresh, retry) must never move the Day 0
    // anchor forward.
    const firmRes = await serviceClient.from('firms').select('confirmed_at').eq('id', firmId).maybeSingle();
    if (firmRes.error) throw firmRes.error;

    if (firmRes.data && firmRes.data.confirmed_at) {
      return { statusCode: 200, headers, body: JSON.stringify({ ok: true, alreadyConfirmed: true }) };
    }

    const upd = await serviceClient.from('firms').eq('id', firmId).update({
      confirmed_at: new Date().toISOString(),
    });
    if (upd.error) throw upd.error;

    return { statusCode: 200, headers, body: JSON.stringify({ ok: true, alreadyConfirmed: false }) };
  } catch (err) {
    console.error('confirm-onboarding.js error:', err);
    // Deliberately non-fatal from the caller's perspective — see
    // signup-confirm.html's comment at the call site. The firm should
    // never be blocked from entering the platform because this
    // secondary write failed.
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Request failed', detail: err.message }) };
  }
};

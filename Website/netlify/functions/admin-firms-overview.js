// Netlify function: netlify/functions/admin-firms-overview.js
//
// Founder-only endpoint: returns a cross-firm overview (billing status,
// report status, last audit activity) for the admin analytics page.
//
// Security model — identical to notify.js / notification-prefs.js:
//   - Requires a valid Supabase session bearer token, verified against
//     /auth/v1/user using the ANON key.
//   - The caller's profile is looked up server-side and role must be
//     exactly 'admin'. This is NOT inferred from the client — a
//     non-admin firm user hitting this endpoint gets 403, even if they
//     know the URL.
//   - firms/audit_sessions are read with the SERVICE ROLE client,
//     which bypasses RLS. This is required: firms_select_own and
//     audit_sessions_select_own_firm only allow a firm to see its own
//     row (confirmed via pg_policies on 24 Aug 2026) — there is no
//     existing admin bypass in RLS, so this endpoint is the only way
//     to see cross-firm data, and it enforces its own admin check
//     before doing so.
//
// Deliberately duplicates the CORS/session/service-client helpers from
// notify.js and notification-prefs.js rather than sharing a module —
// consistent with how those two files are already structured, and
// keeps this new, less-tested endpoint from having any chance of
// affecting the two already-working ones.

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

// Same minimal service-role REST wrapper as notify.js /
// notification-prefs.js (duplicated deliberately — see file header),
// with an added .order() passthrough since this endpoint wants a
// stable, alphabetised firm list.
function makeServiceClient() {
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!serviceKey) throw new Error('SUPABASE_SERVICE_ROLE_KEY is not set');

  async function restRequest(path, options = {}) {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
      ...options,
      headers: {
        'apikey': serviceKey,
        'Authorization': `Bearer ${serviceKey}`,
        'Content-Type': 'application/json',
        'Prefer': options.prefer || 'return=representation',
        ...(options.headers || {}),
      },
    });
    return res;
  }

  return {
    from(table) {
      const filters = [];
      const api = {
        select(cols = '*') { this._select = cols; return this; },
        eq(field, val) { filters.push(`${field}=eq.${encodeURIComponent(val)}`); return this; },
        order(field, opts) {
          const dir = (opts && opts.ascending === false) ? 'desc' : 'asc';
          filters.push(`order=${field}.${dir}`);
          return this;
        },
        maybeSingle: async function () {
          const qs = filters.length ? `?${filters.join('&')}&select=${this._select || '*'}` : `?select=${this._select || '*'}`;
          const res = await restRequest(`${table}${qs}`, { headers: { 'Accept': 'application/vnd.pgrst.object+json' } });
          if (res.status === 406) return { data: null, error: null }; // no row found
          if (!res.ok) return { data: null, error: new Error(`PostgREST error ${res.status}`) };
          const data = await res.json();
          return { data, error: null };
        },
        select_all: async function () {
          const qs = filters.length ? `?${filters.join('&')}&select=${this._select || '*'}` : `?select=${this._select || '*'}`;
          const res = await restRequest(`${table}${qs}`);
          if (!res.ok) return { data: null, error: new Error(`PostgREST error ${res.status}`) };
          const data = await res.json();
          return { data, error: null };
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

  // Admin check happens server-side against the DB — never trust a
  // role claim sent by the client.
  const profileRes = await serviceClient.from('profiles').select('role').eq('id', user.id).maybeSingle();
  if (profileRes.error || !profileRes.data || profileRes.data.role !== 'admin') {
    return { statusCode: 403, headers, body: JSON.stringify({ error: 'Admin access only' }) };
  }

  try {
    const firmsRes = await serviceClient
      .from('firms')
      .select('id,name,subscription_tier,created_at,report_generated_at,report_expires_at,billing_plan,billing_status,next_renewal_date')
      .order('name')
      .select_all();
    if (firmsRes.error) throw firmsRes.error;

    const auditRes = await serviceClient
      .from('audit_sessions')
      .select('firm_id,updated_at')
      .select_all();
    if (auditRes.error) throw auditRes.error;

    const lastActivityByFirm = {};
    (auditRes.data || []).forEach((row) => {
      lastActivityByFirm[row.firm_id] = row.updated_at;
    });

    const now = Date.now();
    const firms = (firmsRes.data || []).map((f) => {
      const lastActivity = lastActivityByFirm[f.id] || null;
      const daysSinceActivity = lastActivity
        ? Math.floor((now - new Date(lastActivity).getTime()) / 86400000)
        : null;
      const daysToReportExpiry = f.report_expires_at
        ? Math.floor((new Date(f.report_expires_at).getTime() - now) / 86400000)
        : null;
      return {
        id: f.id,
        name: f.name || 'Unnamed firm',
        subscriptionTier: f.subscription_tier,
        billingPlan: f.billing_plan,
        billingStatus: f.billing_status,
        createdAt: f.created_at,
        reportGeneratedAt: f.report_generated_at,
        reportExpiresAt: f.report_expires_at,
        nextRenewalDate: f.next_renewal_date,
        lastActivityAt: lastActivity,
        daysSinceActivity,
        daysToReportExpiry,
      };
    });

    return { statusCode: 200, headers, body: JSON.stringify({ firms }) };
  } catch (err) {
    console.error('admin-firms-overview.js error:', err);
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Request failed', detail: err.message }) };
  }
};

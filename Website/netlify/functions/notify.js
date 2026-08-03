// Netlify function: netlify/functions/notify.js
//
// Authenticated notification trigger endpoint. Handles:
//   - audit_completed   (called from platform.html after genReport() succeeds)
//   - password_changed  (called from platform.html after auth.updateUser() succeeds)
//
// Security model (mirrors claude.js):
//   - Requires a valid Supabase session bearer token — verified the
//     same way claude.js verifies it, using the ANON key against
//     /auth/v1/user.
//   - firmId is NEVER trusted from the client. It's derived
//     server-side by looking up profiles.firm_id for the verified
//     user's id. This prevents a caller from triggering a
//     notification (or, worse, an expiry-date write) against a firm
//     that isn't theirs.
//   - Once the user is verified, all further reads/writes (profiles,
//     firms, notification_log, notification_preferences, and the
//     Auth Admin API for email lookup) use the SERVICE ROLE client,
//     since Auth Admin API access requires it and this function has
//     already done its own authorization check above.

const { sendNotification } = require('./lib/notifications');

const SUPABASE_URL = 'https://rkqnrpyctllxcnknjsby.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_7gIWX3E2pS_4UfEKJylqpw_V3CIY1b9';

const PROD_ORIGINS = [
  'https://theiastack.com.au',
  'https://www.theiastack.com.au'
];

// Only these two triggers are handled by this endpoint. Everything
// else either has no real hook point yet or is handled by the
// separate anonymous training-completion endpoint.
const ALLOWED_TRIGGERS = ['audit_completed', 'password_changed'];

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

// Minimal service-role client wrapper — avoids pulling in the full
// @supabase/supabase-js SDK if it's not already a project dependency.
// If @supabase/supabase-js IS already installed (likely, given the
// project uses Supabase client-side too), swap this for
// `createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)` instead —
// functionally equivalent, this hand-rolled version just avoids a
// new dependency for a small function.
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
    // Emulates the small subset of the supabase-js query builder that
    // lib/notifications.js actually uses, via direct PostgREST calls.
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
        insert: async (row) => {
          const res = await restRequest(table, { method: 'POST', body: JSON.stringify(row) });
          if (!res.ok) return { error: new Error(`PostgREST insert error ${res.status}`) };
          return { error: null };
        },
        update: async (patch) => {
          const qs = filters.length ? `?${filters.join('&')}` : '';
          const res = await restRequest(`${table}${qs}`, { method: 'PATCH', body: JSON.stringify(patch) });
          if (!res.ok) return { error: new Error(`PostgREST update error ${res.status}`) };
          return { error: null };
        },
        // Thenable so `await supabase.from(x).select().eq()` (no maybeSingle) works too
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

  let payload;
  try {
    payload = JSON.parse(event.body || '{}');
  } catch (e) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid JSON body' }) };
  }

  const { triggerKey } = payload;
  if (!ALLOWED_TRIGGERS.includes(triggerKey)) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Unknown or disallowed trigger' }) };
  }

  let serviceClient;
  try {
    serviceClient = makeServiceClient();
  } catch (e) {
    console.error(e.message);
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Server misconfiguration' }) };
  }

  // Derive firmId + firmName server-side — never trust client input for this.
  const profileRes = await serviceClient.from('profiles').select('firm_id').eq('id', user.id).maybeSingle();
  if (profileRes.error || !profileRes.data || !profileRes.data.firm_id) {
    return { statusCode: 403, headers, body: JSON.stringify({ error: 'No firm associated with this account' }) };
  }
  const firmId = profileRes.data.firm_id;

  const firmRes = await serviceClient.from('firms').select('name').eq('id', firmId).maybeSingle();
  const firmName = firmRes.data && firmRes.data.name ? firmRes.data.name : 'Your firm';

  try {
    if (triggerKey === 'audit_completed') {
      // Set report expiry data — this is the one place these fields
      // get written, always server-side. See supabase/02-firms-report-expiry.sql.
      const now = new Date();
      const expiresAt = new Date(now);
      expiresAt.setMonth(expiresAt.getMonth() + 12);
      await serviceClient.from('firms').eq('id', firmId).update({
        report_generated_at: now.toISOString(),
        report_expires_at: expiresAt.toISOString(),
      });

      const result = await sendNotification('audit_completed', { firmId, firmName }, serviceClient);
      return { statusCode: 200, headers, body: JSON.stringify(result) };
    }

    if (triggerKey === 'password_changed') {
      const result = await sendNotification('password_changed', { firmId, accountEmail: user.email }, serviceClient);
      return { statusCode: 200, headers, body: JSON.stringify(result) };
    }
  } catch (err) {
    console.error('notify.js error:', err);
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Notification failed', detail: err.message }) };
  }
};

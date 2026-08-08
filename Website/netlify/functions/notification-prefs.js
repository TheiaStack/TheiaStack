// Netlify function: netlify/functions/notification-prefs.js
//
// Authenticated read/write endpoint for the Admin Settings notification
// preferences toggle. Deliberately a SEPARATE file from notify.js rather
// than an extension of it — notify.js's audit_completed/password_changed
// paths are already confirmed working in production (5 Aug), and this
// keeps that file completely untouched.
//
// Security model — identical to notify.js:
//   - Requires a valid Supabase session bearer token, verified against
//     /auth/v1/user using the ANON key.
//   - firmId is NEVER trusted from the client. It's derived server-side
//     from profiles.firm_id for the verified user's id.
//   - All notification_preferences reads/writes use the SERVICE ROLE
//     client (same minimal hand-rolled REST wrapper as notify.js —
//     duplicated here rather than shared, again to avoid any risk of
//     touching notify.js's already-working code path).
//
// Schema this relies on (confirmed via lib/notifications.js's existing
// query shape, not guessed): notification_preferences has firm_id,
// trigger_key, recipients, enabled — queried today as
// .eq('firm_id', firmId).eq('trigger_key', triggerKey).maybeSingle(),
// which implies at most one row per (firm_id, trigger_key) pair.
//
// Only these three trigger keys are valid — must stay in sync with
// TRIGGERS in notification-templates.js.
const KNOWN_TRIGGERS = ['audit_completed', 'staff_training_completed', 'password_changed'];

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

// Same minimal service-role REST wrapper as notify.js (duplicated
// deliberately — see file header).
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

  let payload;
  try {
    payload = JSON.parse(event.body || '{}');
  } catch (e) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid JSON body' }) };
  }

  let serviceClient;
  try {
    serviceClient = makeServiceClient();
  } catch (e) {
    console.error(e.message);
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Server misconfiguration' }) };
  }

  // Derive firmId server-side — never trust client input for this,
  // same as notify.js.
  const profileRes = await serviceClient.from('profiles').select('firm_id').eq('id', user.id).maybeSingle();
  if (profileRes.error || !profileRes.data || !profileRes.data.firm_id) {
    return { statusCode: 403, headers, body: JSON.stringify({ error: 'No firm associated with this account' }) };
  }
  const firmId = profileRes.data.firm_id;

  const action = payload.action;

  try {
    if (action === 'list') {
      // Returns a merged { triggerKey: enabled } object for all known
      // triggers. Missing rows default to enabled:true (matches the
      // existing default behaviour in resolveRecipientRoles, which
      // falls back to the trigger's defaultRecipients when no override
      // row exists).
      const res = await serviceClient.from('notification_preferences').select('trigger_key,enabled').eq('firm_id', firmId).select_all();
      if (res.error) throw res.error;
      const overrides = {};
      (res.data || []).forEach((row) => { overrides[row.trigger_key] = row.enabled; });
      const merged = {};
      KNOWN_TRIGGERS.forEach((t) => { merged[t] = overrides[t] !== undefined ? overrides[t] : true; });
      return { statusCode: 200, headers, body: JSON.stringify({ preferences: merged }) };
    }

    if (action === 'update') {
      const { triggerKey, enabled } = payload;
      if (!KNOWN_TRIGGERS.includes(triggerKey) || typeof enabled !== 'boolean') {
        return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid triggerKey or enabled value' }) };
      }
      // Check-then-write rather than a PostgREST on_conflict upsert —
      // deliberate, since the exact unique-constraint name on
      // notification_preferences isn't confirmed, and this two-step
      // approach doesn't need to know it.
      const existing = await serviceClient.from('notification_preferences').select('firm_id').eq('firm_id', firmId).eq('trigger_key', triggerKey).maybeSingle();
      if (existing.error) throw existing.error;
      if (existing.data) {
        const upd = await serviceClient.from('notification_preferences').eq('firm_id', firmId).eq('trigger_key', triggerKey).update({ enabled });
        if (upd.error) throw upd.error;
      } else {
        const ins = await serviceClient.from('notification_preferences').insert({ firm_id: firmId, trigger_key: triggerKey, enabled });
        if (ins.error) throw ins.error;
      }
      return { statusCode: 200, headers, body: JSON.stringify({ ok: true }) };
    }

    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Unknown action' }) };
  } catch (err) {
    console.error('notification-prefs.js error:', err);
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Request failed', detail: err.message }) };
  }
};

// Netlify function: netlify/functions/notify-training-completion.js
//
// Handles: staff_training_completed (fires once a staff member has
// completed ALL assigned modules, not per-module)
// Called from training.html's saveCompletion(), AFTER the existing
// save_training_completion RPC call succeeds.
//
// Security model — deliberately different from notify.js, because
// staff using training.html are never authenticated (per the
// existing comment in training.html: "Legacy firm_id-only links are
// no longer supported: RLS now locks audit_sessions down for
// anonymous users, and this is the only permitted anonymous access
// path"). There is no session token to verify here.
//
// Instead, firmId is NEVER trusted from the client directly. It is
// re-derived server-side by calling the SAME get_training_session
// RPC that training.html already calls, using the trainingCode the
// client provides. This mirrors the exact trust boundary your RLS
// design already establishes: a valid trainingCode is the only
// credential anonymous callers get, and it's already proven safe
// enough to gate read access to audit_sessions — using it to gate
// this notification too is consistent with that, not a new risk.
//
// Rate-limiting note: this endpoint has no built-in rate limiting.
// Netlify's platform-level request limits provide baseline
// protection, but if abuse becomes a concern, add a check against
// notification_log (e.g. reject if the same trainingCode fired more
// than N times in an hour) — not built today, flagged as a
// follow-up if you want it.

const { sendNotification } = require('./lib/notifications');

const SUPABASE_URL = 'https://rkqnrpyctllxcnknjsby.supabase.co';

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
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json'
  };
}

async function callRpc(serviceKey, fnName, args) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${fnName}`, {
    method: 'POST',
    headers: {
      'apikey': serviceKey,
      'Authorization': `Bearer ${serviceKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(args),
  });
  if (!res.ok) return { data: null, error: new Error(`RPC ${fnName} error ${res.status}`) };
  const data = await res.json();
  return { data, error: null };
}

// Same minimal service-role client as notify.js. If these two
// functions grow further, worth extracting this into a shared
// lib/service-client.js rather than duplicating — left duplicated
// today to keep each function's dependencies obvious and reviewable.
function makeServiceClient(serviceKey) {
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
          return { data: await res.json(), error: null };
        },
        insert: async (row) => {
          const res = await restRequest(table, { method: 'POST', body: JSON.stringify(row) });
          if (!res.ok) return { error: new Error(`PostgREST insert error ${res.status}`) };
          return { error: null };
        },
        then(resolve, reject) {
          const qs = filters.length ? `?${filters.join('&')}&select=${this._select || '*'}` : `?select=${this._select || '*'}`;
          restRequest(`${table}${qs}`)
            .then(async (res) => {
              if (!res.ok) return resolve({ data: null, error: new Error(`PostgREST error ${res.status}`) });
              resolve({ data: await res.json(), error: null });
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
          return { data: { user: await res.json() }, error: null };
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

  let payload;
  try {
    payload = JSON.parse(event.body || '{}');
  } catch (e) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid JSON body' }) };
  }

  const { trainingCode, staffName, moduleNames } = payload;
  if (!trainingCode || !staffName || !Array.isArray(moduleNames) || moduleNames.length === 0) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'trainingCode, staffName, and a non-empty moduleNames array are all required' }) };
  }

  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!serviceKey) {
    console.error('SUPABASE_SERVICE_ROLE_KEY is not set');
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Server misconfiguration' }) };
  }

  // Re-derive firm_id server-side from the trainingCode via the SAME
  // RPC training.html already uses. We never trust a client-supplied
  // firm_id. This RPC is designed for anonymous callers, so it's a
  // safe operation to run with either the anon key or the service
  // key — service key used here purely for consistency with the rest
  // of the function.
  const sessionRes = await callRpc(serviceKey, 'get_training_session', { p_code: trainingCode });
  if (sessionRes.error || !sessionRes.data || !sessionRes.data.length || !sessionRes.data[0].firm_id) {
    return { statusCode: 404, headers, body: JSON.stringify({ error: 'Training session not found for this code' }) };
  }
  const firmId = sessionRes.data[0].firm_id;
  const sessionData = sessionRes.data[0].session_data || {};
  const firmName = sessionData.firmName || 'Your firm';

  const serviceClient = makeServiceClient(serviceKey);

  try {
    const result = await sendNotification('staff_training_completed', {
      firmId,
      firmName,
      staffName,
      moduleNames,
    }, serviceClient);
    return { statusCode: 200, headers, body: JSON.stringify(result) };
  } catch (err) {
    console.error('notify-training-completion.js error:', err);
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Notification failed', detail: err.message }) };
  }
};

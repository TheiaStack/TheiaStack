// Netlify function: proxies chat requests to the Anthropic API.
// Security: verifies the caller holds a valid Supabase session before
// forwarding anything, and constrains what can be sent to Anthropic.

const SUPABASE_URL = 'https://rkqnrpyctllxcnknjsby.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_7gIWX3E2pS_4UfEKJylqpw_V3CIY1b9';

const PROD_ORIGINS = [
  'https://theiastack.com.au',
  'https://www.theiastack.com.au'
];

const ALLOWED_MODELS = [
  'claude-sonnet-4-6',
  'claude-haiku-4-5-20251001'
];

const MAX_TOKENS_CEILING = 4000;
const MAX_BODY_BYTES = 40000; // generous headroom over the largest legitimate prompt

// Section 3: per-firm daily call cap. 50/day comfortably covers a heavy
// legitimate day (audit run, policy regen, quiz generation) while still
// stopping a runaway loop or misuse from racking up real spend unnoticed.
// Plain constant for now — revisit as a per-firm override only if a
// genuine firm ever needs more.
const DAILY_CALL_CAP_PER_FIRM = 50;

// Netlify preview/branch deploys look like:
//   https://deploy-preview-12--theiastack.netlify.app
//   https://main--theiastack.netlify.app
// and local dev via `netlify dev` runs on localhost.
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
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, anthropic-version',
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
      headers: {
        'Authorization': `Bearer ${token}`,
        'apikey': SUPABASE_ANON_KEY
      }
    });
    if (!res.ok) return null;
    const user = await res.json();
    return user && user.id ? user : null;
  } catch (e) {
    return null;
  }
}

// Minimal service-role client — same hand-rolled REST wrapper pattern
// already used in notify.js, kept consistent rather than introducing
// a new approach or a new dependency for two small queries.
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

// Looks up the firm_id for a verified user, same profiles.firm_id
// pattern already used in notify.js / notification-prefs.js.
async function getFirmId(serviceClient, userId) {
  const res = await serviceClient.restRequest(
    `profiles?id=eq.${encodeURIComponent(userId)}&select=firm_id`,
    { headers: { 'Accept': 'application/vnd.pgrst.object+json' } }
  );
  if (!res.ok) return null;
  const data = await res.json();
  return (data && data.firm_id) || null;
}

// Counts today's successful calls for a firm using an exact count via
// PostgREST's Prefer: count=exact header, rather than pulling rows back.
async function getTodayCallCount(serviceClient, firmId) {
  const startOfDayUtc = new Date();
  startOfDayUtc.setUTCHours(0, 0, 0, 0);
  const res = await serviceClient.restRequest(
    `llm_usage?firm_id=eq.${encodeURIComponent(firmId)}&created_at=gte.${startOfDayUtc.toISOString()}&select=id`,
    { headers: { 'Prefer': 'count=exact', 'Range': '0-0' } }
  );
  if (!res.ok) return 0; // fail open on a read error — don't block calls over a transient count failure
  const contentRange = res.headers.get('content-range'); // format: "0-0/123"
  if (!contentRange) return 0;
  const total = parseInt(contentRange.split('/')[1], 10);
  return Number.isFinite(total) ? total : 0;
}

// Fire-and-forget usage log write. Never blocks or fails the response —
// a logging failure should not take down the actual API call.
function logUsage(serviceClient, firmId, model) {
  serviceClient
    .restRequest('llm_usage', {
      method: 'POST',
      prefer: 'return=minimal',
      body: JSON.stringify({ firm_id: firmId, model }),
    })
    .catch((e) => console.error('llm_usage log failed:', e));
}

exports.handler = async function (event) {
  const headers = corsHeaders(event);

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  // Reject oversized payloads before doing any other work.
  const rawBody = event.isBase64Encoded
    ? Buffer.from(event.body || '', 'base64').toString()
    : (event.body || '');

  if (rawBody.length > MAX_BODY_BYTES) {
    return { statusCode: 413, headers, body: JSON.stringify({ error: 'Request body too large' }) };
  }

  // Require a valid Supabase session for every call — this is the gate
  // the previous version of this function was missing entirely.
  const authHeader = event.headers && (event.headers.authorization || event.headers.Authorization);
  const user = await verifySession(authHeader);
  if (!user) {
    return { statusCode: 401, headers, body: JSON.stringify({ error: 'Unauthorized' }) };
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Server misconfiguration' }) };
  }

  // Section 3: per-firm daily call cap. Resolved from profiles.firm_id
  // for the verified user, same as the notification functions. If the
  // usage check itself fails (e.g. table missing, transient DB error),
  // we fail open and let the call through rather than breaking the
  // product over a rate-limiting bug.
  let serviceClient = null;
  let firmId = null;
  try {
    serviceClient = makeServiceClient();
    firmId = await getFirmId(serviceClient, user.id);
    if (firmId) {
      const todayCount = await getTodayCallCount(serviceClient, firmId);
      if (todayCount >= DAILY_CALL_CAP_PER_FIRM) {
        return {
          statusCode: 429,
          headers,
          body: JSON.stringify({ error: 'Daily AI usage limit reached for your firm. This resets at midnight UTC — contact hello@theiastack.com.au if you need this raised.' })
        };
      }
    }
  } catch (e) {
    console.error('Usage check failed, failing open:', e);
  }

  let payload;
  try {
    payload = JSON.parse(rawBody);
  } catch (e) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid JSON body' }) };
  }

  // Constrain the model to an allowlist — a caller can no longer request
  // an arbitrary (potentially far more expensive) model.
  if (!ALLOWED_MODELS.includes(payload.model)) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Model not permitted' }) };
  }

  // Clamp max_tokens server-side regardless of what the client asked for.
  payload.max_tokens = Math.min(Number(payload.max_tokens) || 1000, MAX_TOKENS_CEILING);

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'anthropic-version': '2023-06-01',
        'x-api-key': apiKey
      },
      body: JSON.stringify(payload)
    });

    const text = await response.text();

    // Only log usage against the firm's quota for a genuinely successful
    // call — a failed/errored Anthropic call shouldn't cost the firm.
    if (response.ok && serviceClient && firmId) {
      logUsage(serviceClient, firmId, payload.model);
    }

    return { statusCode: response.status, headers, body: text };

  } catch (err) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Upstream request failed' }) };
  }
};

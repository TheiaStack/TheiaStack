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
    return { statusCode: response.status, headers, body: text };

  } catch (err) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Upstream request failed' }) };
  }
};

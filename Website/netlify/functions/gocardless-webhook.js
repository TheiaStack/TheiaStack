// Netlify function: netlify/functions/gocardless-webhook.js
//
// Section 2, Phase 4 — receives GoCardless webhook events and is the
// SOLE source of truth for whether a firm's billing is actually
// active. Per GoCardless's own guidance: "Don't rely on the redirect
// back to your site to confirm the outcome. Always use webhooks."
// gocardless-start-billing.js only creates the mandate-only Billing
// Request; everything that happens once the mandate is genuinely
// confirmed — creating the $2,990 annual payment or the 12x$299
// instalment schedule, and updating firms.billing_status — happens
// here, triggered by real GoCardless events.
//
// Security model:
//   - This endpoint has NO Supabase session to check — GoCardless
//     calls it directly, server to server. Instead, every request is
//     verified using HMAC-SHA256 over the RAW request body, keyed
//     with GOCARDLESS_WEBHOOK_SECRET, compared against the
//     Webhook-Signature header. This is GoCardless's documented
//     verification method. Requests that fail this check are
//     rejected with 498 before any payload content is read or acted
//     on, exactly as GoCardless's own docs specify.
//   - No Supabase ANON key / user auth applies here — all firm reads
//     and writes use the SERVICE ROLE client, same as the other
//     functions, since this is a trusted server-to-server call once
//     the signature has been verified.
//
// Event handling summary:
//   - billing_requests / fulfilled  → mandate is confirmed. Look up
//     the Billing Request to recover firm_id + billing_plan
//     (stashed as metadata when the request was created), store the
//     mandate/customer IDs against the firm, set billing_status to
//     'active', and create either the one-off annual payment or the
//     12x$299 instalment schedule.
//   - mandates / cancelled|failed|expired|blocked → mandate can no
//     longer be used. Set billing_status to 'cancelled' for the firm
//     matching that mandate ID.
//   - payments / failed → a scheduled payment failed. Set
//     billing_status to 'payment_failed' for the firm matching that
//     payment's mandate.
//   - Anything else is acknowledged (200) but not acted on.

const crypto = require('crypto');

const SUPABASE_URL = 'https://rkqnrpyctllxcnknjsby.supabase.co';

const GOCARDLESS_ENVIRONMENT = process.env.GOCARDLESS_ENVIRONMENT || 'sandbox';
const GOCARDLESS_API_BASE = GOCARDLESS_ENVIRONMENT === 'live'
  ? 'https://api.gocardless.com'
  : 'https://api-sandbox.gocardless.com';

// Pricing — must match Brand Bible v5 pricing exactly. In cents (AUD),
// since GoCardless amounts are always in the lowest currency unit.
const ANNUAL_AMOUNT_CENTS = 299000;   // $2,990.00
const MONTHLY_INSTALMENT_CENTS = 29900; // $299.00
const MONTHLY_INSTALMENT_COUNT = 12;

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

async function gocardlessGet(path) {
  const token = process.env.GOCARDLESS_ACCESS_TOKEN;
  const res = await fetch(`${GOCARDLESS_API_BASE}${path}`, {
    headers: {
      'Authorization': `Bearer ${token}`,
      'GoCardless-Version': '2015-07-06',
    },
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch (e) { json = null; }
  return { ok: res.ok, status: res.status, json, raw: text };
}

async function gocardlessPost(path, body) {
  const token = process.env.GOCARDLESS_ACCESS_TOKEN;
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

async function updateFirmById(serviceClient, firmId, patch) {
  return serviceClient.restRequest(`firms?id=eq.${encodeURIComponent(firmId)}`, {
    method: 'PATCH',
    prefer: 'return=minimal',
    body: JSON.stringify(patch),
  });
}

async function findFirmByMandateId(serviceClient, mandateId) {
  const res = await serviceClient.restRequest(
    `firms?gocardless_mandate_id=eq.${encodeURIComponent(mandateId)}&select=id`,
    { headers: { 'Accept': 'application/vnd.pgrst.object+json' } }
  );
  if (!res.ok) return null;
  const data = await res.json();
  return (data && data.id) || null;
}

// Builds the 12 monthly instalment dates. First charge is set 10 days
// out — a safe buffer so it isn't rejected for being before the
// mandate's next_possible_charge_date (BECS AU typically needs a few
// business days' advance notice). GoCardless will roll a date forward
// automatically if it's still too soon, so this is a sensible default
// rather than a hard requirement.
function buildMonthlyInstalmentDates() {
  const dates = [];
  const first = new Date();
  first.setUTCDate(first.getUTCDate() + 10);
  for (let i = 0; i < MONTHLY_INSTALMENT_COUNT; i++) {
    const d = new Date(first);
    d.setUTCMonth(d.getUTCMonth() + i);
    dates.push(d.toISOString().slice(0, 10)); // YYYY-MM-DD
  }
  return dates;
}

function addDaysISO(days) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// Handles a single "billing_requests" / "fulfilled" event: the
// mandate this firm's billing depends on now exists and is usable.
async function handleBillingRequestFulfilled(serviceClient, event) {
  const billingRequestId = event.links && event.links.billing_request;
  if (!billingRequestId) {
    console.error('billing_requests.fulfilled event missing links.billing_request:', event.id);
    return;
  }

  const brRes = await gocardlessGet(`/billing_requests/${billingRequestId}`);
  if (!brRes.ok || !brRes.json || !brRes.json.billing_requests) {
    console.error('Could not fetch billing_request', billingRequestId, brRes.status, brRes.raw);
    return;
  }
  const br = brRes.json.billing_requests;
  const firmId = br.metadata && br.metadata.firm_id;
  const billingPlan = br.metadata && br.metadata.billing_plan;
  const mandateId = br.mandate_request && br.mandate_request.links && br.mandate_request.links.mandate;
  const customerId = br.links && br.links.customer;

  if (!firmId || !mandateId) {
    console.error('billing_request missing firm_id metadata or mandate link:', billingRequestId);
    return;
  }

  if (billingPlan === 'annual') {
    const payRes = await gocardlessPost('/payments', {
      payments: {
        amount: ANNUAL_AMOUNT_CENTS,
        currency: 'AUD',
        links: { mandate: mandateId },
        metadata: { firm_id: firmId },
        description: 'Theia-Stack Annual Subscription',
      },
    });
    if (!payRes.ok) {
      console.error('Annual payment creation failed for firm', firmId, payRes.status, payRes.raw);
      await updateFirmById(serviceClient, firmId, {
        gocardless_mandate_id: mandateId,
        gocardless_customer_id: customerId || null,
        billing_status: 'payment_failed',
      });
      return;
    }
    await updateFirmById(serviceClient, firmId, {
      gocardless_mandate_id: mandateId,
      gocardless_customer_id: customerId || null,
      billing_status: 'active',
      next_renewal_date: addDaysISO(365),
    });
    return;
  }

  if (billingPlan === 'monthly') {
    const dates = buildMonthlyInstalmentDates();
    const instalments = dates.map((charge_date) => ({ amount: MONTHLY_INSTALMENT_CENTS, charge_date }));
    const schedRes = await gocardlessPost('/instalment_schedules', {
      instalment_schedules: {
        name: 'Theia-Stack Monthly Subscription',
        currency: 'AUD',
        total_amount: MONTHLY_INSTALMENT_CENTS * MONTHLY_INSTALMENT_COUNT,
        instalments,
        links: { mandate: mandateId },
        metadata: { firm_id: firmId },
      },
    });
    if (!schedRes.ok) {
      console.error('Instalment schedule creation failed for firm', firmId, schedRes.status, schedRes.raw);
      // The mandate itself is still valid even though the schedule
      // failed — record it so we don't lose track of a working
      // mandate, and so a retry doesn't need to redo the mandate step.
      await updateFirmById(serviceClient, firmId, {
        gocardless_mandate_id: mandateId,
        gocardless_customer_id: customerId || null,
        billing_status: 'payment_failed',
      });
      return;
    }
    await updateFirmById(serviceClient, firmId, {
      gocardless_mandate_id: mandateId,
      gocardless_customer_id: customerId || null,
      billing_status: 'active',
      next_renewal_date: dates[dates.length - 1],
    });
    return;
  }

  console.error('billing_request had no recognised billing_plan metadata:', billingRequestId, billingPlan);
}

async function handleMandateInactive(serviceClient, event) {
  const mandateId = event.links && event.links.mandate;
  if (!mandateId) return;
  const firmId = await findFirmByMandateId(serviceClient, mandateId);
  if (!firmId) return;
  await updateFirmById(serviceClient, firmId, { billing_status: 'cancelled' });
}

async function handlePaymentFailed(serviceClient, event) {
  const paymentId = event.links && event.links.payment;
  if (!paymentId) return;
  const payRes = await gocardlessGet(`/payments/${paymentId}`);
  if (!payRes.ok || !payRes.json || !payRes.json.payments) return;
  const mandateId = payRes.json.payments.links && payRes.json.payments.links.mandate;
  if (!mandateId) return;
  const firmId = await findFirmByMandateId(serviceClient, mandateId);
  if (!firmId) return;
  await updateFirmById(serviceClient, firmId, { billing_status: 'payment_failed' });
}

const MANDATE_INACTIVE_ACTIONS = ['cancelled', 'failed', 'expired', 'blocked'];

exports.handler = async function (event) {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  const secret = process.env.GOCARDLESS_WEBHOOK_SECRET;
  if (!secret) {
    console.error('GOCARDLESS_WEBHOOK_SECRET is not set');
    return { statusCode: 500, body: JSON.stringify({ error: 'Server misconfiguration' }) };
  }

  // Netlify may hand us a base64-encoded body for some content types —
  // handle both, since the signature must be computed over the exact
  // raw bytes GoCardless sent.
  const rawBody = event.isBase64Encoded
    ? Buffer.from(event.body || '', 'base64').toString('utf8')
    : (event.body || '');

  const signatureHeader = event.headers && (event.headers['webhook-signature'] || event.headers['Webhook-Signature']);
  if (!signatureHeader) {
    return { statusCode: 498, body: 'Missing signature' };
  }

  const computedSignature = crypto.createHmac('sha256', secret).update(rawBody, 'utf8').digest('hex');

  const sigBuffer = Buffer.from(signatureHeader, 'hex');
  const computedBuffer = Buffer.from(computedSignature, 'hex');
  const signaturesMatch =
    sigBuffer.length === computedBuffer.length &&
    crypto.timingSafeEqual(sigBuffer, computedBuffer);

  if (!signaturesMatch) {
    console.error('GoCardless webhook signature mismatch — rejecting.');
    return { statusCode: 498, body: 'Invalid signature' };
  }

  let payload;
  try {
    payload = JSON.parse(rawBody);
  } catch (e) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON body' }) };
  }

  const events = (payload && payload.events) || [];
  let serviceClient;
  try {
    serviceClient = makeServiceClient();
  } catch (e) {
    console.error('Service client init failed:', e);
    return { statusCode: 500, body: JSON.stringify({ error: 'Server misconfiguration' }) };
  }

  // Process sequentially and swallow individual event errors — one
  // bad event shouldn't cause GoCardless to retry the whole batch
  // (which could re-trigger already-handled events). Each handler
  // logs its own errors for visibility in the Netlify function logs.
  for (const evt of events) {
    try {
      if (evt.resource_type === 'billing_requests' && evt.action === 'fulfilled') {
        await handleBillingRequestFulfilled(serviceClient, evt);
      } else if (evt.resource_type === 'mandates' && MANDATE_INACTIVE_ACTIONS.includes(evt.action)) {
        await handleMandateInactive(serviceClient, evt);
      } else if (evt.resource_type === 'payments' && evt.action === 'failed') {
        await handlePaymentFailed(serviceClient, evt);
      }
      // All other event types are acknowledged but not acted on.
    } catch (e) {
      console.error('Error handling GoCardless event', evt && evt.id, e);
    }
  }

  return { statusCode: 200, body: JSON.stringify({ received: true }) };
};

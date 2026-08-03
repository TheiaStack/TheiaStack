// Theia-Stack — sendNotification (v2, CORRECTED against real schema)
//
// Key correction from v1: neither `profiles` nor `firms` has an email
// column (confirmed via information_schema.columns, Aug 2026). Admin
// email is resolved via the Supabase Auth Admin API
// (supabase.auth.admin.getUserById), keyed on profiles.id, which IS
// the same id as auth.users.id (confirmed by the login flow in
// platform.html: profiles.id = session.user.id).
//
// This means the `supabase` client passed into sendNotification MUST
// be created with the SERVICE ROLE key, not the anon key — the Auth
// Admin API is not available to anon/authenticated clients.

const { TRIGGERS } = require('./notification-templates');

const RESEND_API_URL = 'https://api.resend.com/emails';
const FROM_ADDRESS = 'Theia-Stack <hello@theiastack.com.au>';

/**
 * Resolves 'admin' role into actual admin email addresses for a firm,
 * via profiles (role='admin', firm_id=X) -> auth.users email lookup.
 */
async function getAdminEmails(supabase, firmId) {
  const { data: admins, error } = await supabase
    .from('profiles')
    .select('id')
    .eq('firm_id', firmId)
    .eq('role', 'admin');

  if (error) {
    console.error('Failed to fetch admin profiles:', error.message);
    return [];
  }
  if (!admins || admins.length === 0) return [];

  const emails = [];
  for (const admin of admins) {
    try {
      const { data, error: userError } = await supabase.auth.admin.getUserById(admin.id);
      if (userError || !data?.user?.email) {
        console.warn(`Could not resolve email for profile ${admin.id}:`, userError?.message);
        continue;
      }
      emails.push(data.user.email);
    } catch (e) {
      console.warn(`Auth admin lookup failed for profile ${admin.id}:`, e.message);
    }
  }
  return emails;
}

/**
 * Looks up the recipient override for a firm+trigger, falling back
 * to the template's default if none is configured.
 */
async function resolveRecipientRoles(supabase, firmId, triggerKey, defaultRecipients) {
  const { data, error } = await supabase
    .from('notification_preferences')
    .select('recipients,enabled')
    .eq('firm_id', firmId)
    .eq('trigger_key', triggerKey)
    .maybeSingle();

  if (error) {
    console.error('Failed to fetch notification preference, using default:', error.message);
    return defaultRecipients;
  }
  if (!data) return defaultRecipients;
  if (data.enabled === false) return [];
  return data.recipients && data.recipients.length ? data.recipients : defaultRecipients;
}

/**
 * Turns resolved roles into actual email addresses.
 * 'admin' -> looked up via getAdminEmails.
 * 'account_holder' -> context.accountEmail directly (no lookup — used
 *   only by password_changed, where the recipient IS the person who
 *   just acted, taken from their own verified session).
 */
async function rolesToEmails(supabase, firmId, roles, context) {
  const emails = new Set();
  for (const role of roles) {
    if (role === 'admin') {
      const adminEmails = await getAdminEmails(supabase, firmId);
      adminEmails.forEach((e) => emails.add(e));
    } else if (role === 'account_holder') {
      if (context.accountEmail) emails.add(context.accountEmail);
    }
  }
  return Array.from(emails);
}

async function sendViaResend(toEmail, subject, html) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    throw new Error('RESEND_API_KEY is not set in environment variables');
  }

  const response = await fetch(RESEND_API_URL, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ from: FROM_ADDRESS, to: [toEmail], subject, html }),
  });

  const result = await response.json();
  if (!response.ok) {
    throw new Error(result?.message || `Resend API error: ${response.status}`);
  }
  return result;
}

async function logAttempt(supabase, { firmId, triggerKey, recipientEmail, status, resendId, errorMessage }) {
  const { error } = await supabase.from('notification_log').insert({
    firm_id: firmId,
    trigger_key: triggerKey,
    recipient_email: recipientEmail,
    status,
    resend_id: resendId || null,
    error_message: errorMessage || null,
  });
  if (error) {
    console.error('Failed to write notification_log entry:', error.message);
  }
}

/**
 * Main entry point.
 * @param {string} triggerKey - 'audit_completed' | 'training_module_completed' | 'password_changed'
 * @param {object} context - must include firmId; other fields per template
 *                            (see notification-templates.js)
 * @param {object} supabase - a SERVICE ROLE Supabase client (required
 *                             for auth.admin.getUserById to work)
 * @returns {Promise<{sent: string[], failed: string[]}>}
 */
async function sendNotification(triggerKey, context, supabase) {
  const trigger = TRIGGERS[triggerKey];
  if (!trigger) {
    throw new Error(`Unknown notification trigger: ${triggerKey}`);
  }
  if (!context.firmId) {
    throw new Error('context.firmId is required for all notification triggers');
  }

  const roles = await resolveRecipientRoles(supabase, context.firmId, triggerKey, trigger.defaultRecipients);
  if (roles.length === 0) {
    return { sent: [], failed: [] };
  }

  const recipientEmails = await rolesToEmails(supabase, context.firmId, roles, context);
  if (recipientEmails.length === 0) {
    console.warn(`No resolvable recipient emails for trigger "${triggerKey}" on firm ${context.firmId}`);
    return { sent: [], failed: [] };
  }

  const subject = trigger.subject(context);
  const html = trigger.render(context);

  const sent = [];
  const failed = [];

  for (const email of recipientEmails) {
    try {
      const result = await sendViaResend(email, subject, html);
      await logAttempt(supabase, { firmId: context.firmId, triggerKey, recipientEmail: email, status: 'sent', resendId: result?.id });
      sent.push(email);
    } catch (err) {
      await logAttempt(supabase, { firmId: context.firmId, triggerKey, recipientEmail: email, status: 'failed', errorMessage: err.message });
      failed.push(email);
    }
  }

  return { sent, failed };
}

module.exports = { sendNotification };

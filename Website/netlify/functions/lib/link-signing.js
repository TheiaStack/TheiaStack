// Theia-Stack — netlify/functions/lib/link-signing.js
//
// Minimal HMAC signing for one-click links embedded in emails (e.g. the
// "remind me later" snooze link on the quarterly re-audit reminder).
// No login exists at the point someone clicks these — the signature is
// what stops the link being guessed or reused for a different firm.
//
// Deliberately scoped to exactly what one link needs: sign an ordered
// list of string fields, verify the same. Payload fields are joined
// with '|' before signing, so callers must keep field ORDER identical
// between signLink() and verifyLink() — this file does not encode
// field names, only values, to keep query strings short.
//
// Requires LINK_SIGNING_SECRET in the environment. Reused across any
// future one-click email link, not just the snooze one — pick a long
// random value once and never rotate it without expecting every
// previously-sent, not-yet-clicked link to stop verifying.

const crypto = require('crypto');

function getSecret() {
  const secret = process.env.LINK_SIGNING_SECRET;
  if (!secret) throw new Error('LINK_SIGNING_SECRET is not set');
  return secret;
}

function signLink(fields) {
  const payload = fields.join('|');
  return crypto.createHmac('sha256', getSecret()).update(payload).digest('hex');
}

// Constant-time comparison — a plain === would leak timing information
// about how many leading characters matched, which matters here since
// the whole point of the signature is to resist guessing.
function verifyLink(fields, signature) {
  if (!signature) return false;
  const expected = signLink(fields);
  const a = Buffer.from(expected, 'hex');
  const b = Buffer.from(String(signature), 'hex');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

module.exports = { signLink, verifyLink };

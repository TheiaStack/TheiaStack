// Theia-Stack — notification trigger definitions (v2, CORRECTED)
//
// Triggers are defined here only once they have a confirmed real hook
// point in the actual codebase:
//   - audit_completed        (platform.html genReport() completion)
//   - training_module_completed (training.html saveCompletion())
//   - password_changed       (platform.html Settings password change)
//   - quarterly_reaudit_due  (reaudit-reminder.js, daily Scheduled
//     Function — added Sep 2026 alongside the Quarterly Auto Re-Audit
//     entry point in platform.html)
//
// All recipients today resolve to 'admin' (or, for password_changed,
// the account holder directly via their own session email — no
// lookup needed). There is no staff-account system, so a
// 'staff_self' role is intentionally NOT used anywhere in this file.
// Do not add triggers here without a confirmed real call site —
// see SECTION-5-6-SPEC-v2.md for what's deliberately excluded and why.

const { renderEmailShell } = require('./email-shell');

const PLATFORM_URL = 'https://theiastack.com.au';

const TRIGGERS = {

  audit_completed: {
    defaultRecipients: ['admin'],
    subject: (ctx) => `Your AI Risk Management Report is ready — ${ctx.firmName}`,
    render: (ctx) => renderEmailShell({
      heading: 'Your report is ready',
      preheader: 'Your AI Risk Management Report and policy have been generated.',
      bodyHtml: `
        <p>The audit for <strong>${ctx.firmName}</strong> is complete. Your AI Risk Management Report and tailored AI usage policy are ready to view.</p>
        <p>This report is dated and valid for the information captured at date of generation.</p>
        <p>Next step: Assign staff training so completion is tracked against this report.</p>
      `,
      ctaText: 'View your report',
      ctaUrl: `${PLATFORM_URL}/platform`,
    }),
  },

  staff_training_completed: {
    // Fires once per staff member, when they finish ALL assigned
    // modules (training.html only calls the save/notify path at
    // T.completed.length === T.modules.length) — not once per module.
    defaultRecipients: ['admin'],
    subject: (ctx) => `${ctx.staffName} completed training — ${ctx.firmName}`,
    render: (ctx) => renderEmailShell({
      heading: 'Staff training completed',
      preheader: `${ctx.staffName} has completed all assigned training modules.`,
      bodyHtml: `
        <p><strong>${ctx.staffName}</strong> has completed all assigned training modules for ${ctx.firmName}:</p>
        <ul style="margin: 8px 0 0 0; padding-left: 20px;">
          ${(ctx.moduleNames || []).map((m) => `<li style="margin-bottom: 4px;">${m}</li>`).join('')}
        </ul>
        <p>This completion has been recorded against your firm's training records.</p>
      `,
      ctaText: 'View training records',
      ctaUrl: `${PLATFORM_URL}/platform`,
    }),
  },

  quarterly_reaudit_due: {
    // ctx: { firmId, firmName, daysSince }
    defaultRecipients: ['admin'],
    subject: (ctx) => `Time for your quarterly AI stack review — ${ctx.firmName}`,
    render: (ctx) => renderEmailShell({
      heading: 'Your quarterly re-audit is due',
      preheader: 'Review your AI tool list to keep your findings and policy current.',
      bodyHtml: `
        <p>It's been ${ctx.daysSince} days since ${ctx.firmName}'s AI tool stack was last reviewed on Theia-Stack.</p>
        <p>Running a fresh audit takes a few minutes, lets you update your tool list if anything's changed, and regenerates your findings, recommendations, and AI usage policy from current data. It's included in your subscription — no extra cost.</p>
      `,
      ctaText: 'Start your re-audit',
      ctaUrl: `${PLATFORM_URL}/platform`,
    }),
  },

  password_changed: {
    defaultRecipients: ['account_holder'], // resolved directly from context.accountEmail — no DB lookup
    subject: () => `Your Theia-Stack password was changed`,
    render: (ctx) => renderEmailShell({
      heading: 'Password changed',
      preheader: 'This is a security notice confirming your password was updated.',
      bodyHtml: `
        <p>This confirms the password on your Theia-Stack account (${ctx.accountEmail}) was changed.</p>
        <p>If you didn't make this change, contact us immediately at hello@theiastack.com.au.</p>
      `,
    }),
  },

};

module.exports = { TRIGGERS };

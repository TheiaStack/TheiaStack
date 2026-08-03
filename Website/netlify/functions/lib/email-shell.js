// Theia-Stack — shared branded email shell
// Brand: black / white / grey + red accent (#B83232)
// Headings: Playfair Display (web font, with Georgia serif fallback
// since most email clients strip <link> and @import for fonts —
// Gmail, Outlook desktop, and most mobile clients will render the
// fallback, not the web font. This is normal for email and not a bug.)
// Body: DM Sans (web font, sans-serif fallback)

const BRAND = {
  black: '#111111',
  darkGrey: '#2C2C2C',
  midGrey: '#5A5A5A',
  lightGrey: '#D0D0D0',
  offWhite: '#F2F2F2',
  white: '#FFFFFF',
  red: '#B83232',
};

/**
 * Renders a complete branded HTML email.
 * @param {Object} opts
 * @param {string} opts.heading - Main heading text
 * @param {string} opts.bodyHtml - Inner body HTML (paragraphs, lists etc — already-safe HTML)
 * @param {string} [opts.ctaText] - Optional button text
 * @param {string} [opts.ctaUrl] - Optional button URL
 * @param {string} [opts.preheader] - Hidden preview text shown in inbox list view
 * @returns {string} full HTML document
 */
function renderEmailShell({ heading, bodyHtml, ctaText, ctaUrl, preheader = '' }) {
  const hasCta = Boolean(ctaText && ctaUrl);
  const ctaSection = hasCta ? `
          <!-- CTA -->
          <tr>
            <td style="padding: 0 40px;">
              <table role="presentation" cellpadding="0" cellspacing="0">
                <tr>
                  <td style="padding: 8px 0 32px 0;">
                    <a href="${ctaUrl}"
                       style="display: inline-block; background-color: ${BRAND.black}; color: ${BRAND.white};
                              text-decoration: none; padding: 14px 28px; font-family: 'DM Sans', Arial, sans-serif;
                              font-size: 15px; font-weight: 600; border-radius: 2px; letter-spacing: 0.3px;">
                      ${ctaText}
                    </a>
                  </td>
                </tr>
              </table>
            </td>
          </tr>` : `
          <tr><td style="padding: 0 40px 12px 40px;"></td></tr>`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${heading}</title>
</head>
<body style="margin:0; padding:0; background-color:${BRAND.offWhite}; font-family:'DM Sans', Arial, sans-serif;">
  <div style="display:none; max-height:0; overflow:hidden; opacity:0;">${preheader}</div>

  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:${BRAND.offWhite}; padding: 32px 16px;">
    <tr>
      <td align="center">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px; background-color:${BRAND.white};">

          <!-- Header / wordmark -->
          <tr>
            <td style="padding: 32px 40px 24px 40px; border-bottom: 3px solid ${BRAND.red};">
              <span style="font-family: 'Playfair Display', Georgia, serif; font-size: 22px; font-weight: 700;
                           color: ${BRAND.black}; letter-spacing: 0.5px;">
                THEIA-STACK
              </span>
              <div style="font-family:'DM Sans', Arial, sans-serif; font-size: 11px; letter-spacing: 1.5px;
                          color: ${BRAND.midGrey}; text-transform: uppercase; margin-top: 4px;">
                AI Compliance Platform
              </div>
            </td>
          </tr>

          <!-- Body -->
          <tr>
            <td style="padding: 36px 40px 8px 40px;">
              <h1 style="font-family: 'Playfair Display', Georgia, serif; font-size: 24px; font-weight: 700;
                         color: ${BRAND.black}; margin: 0 0 20px 0; line-height: 1.3;">
                ${heading}
              </h1>
              <div style="font-family:'DM Sans', Arial, sans-serif; font-size: 15px; line-height: 1.6;
                          color: ${BRAND.darkGrey};">
                ${bodyHtml}
              </div>
            </td>
          </tr>

          ${ctaSection}

          <!-- Footer -->
          <tr>
            <td style="padding: 24px 40px 32px 40px; border-top: 1px solid ${BRAND.lightGrey};">
              <div style="font-family:'DM Sans', Arial, sans-serif; font-size: 12px; color: ${BRAND.midGrey}; line-height: 1.6;">
                Theia-Stack &middot; AI Compliance Platform<br>
                <a href="https://theiastack.com.au" style="color:${BRAND.midGrey}; text-decoration:underline;">theiastack.com.au</a>
                &middot;
                <a href="mailto:hello@theiastack.com.au" style="color:${BRAND.midGrey}; text-decoration:underline;">hello@theiastack.com.au</a>
              </div>
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

module.exports = { renderEmailShell, BRAND };

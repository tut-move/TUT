# TUT Move v79 — Password reset

Implemented:
- Forgot password link on Login.
- Generic recovery response to avoid revealing registered emails.
- Cryptographically random, SHA-256 stored reset tokens.
- 30-minute expiry and one-time use.
- New password + confirmation UI.
- All existing sessions for the account are invalidated after reset.
- Reset email sent through the official mailbox SMTP.

## Render environment variables required for real email delivery

- `SMTP_HOST=mail.privateemail.com`
- `SMTP_PORT=465`
- `SMTP_USER=info@tutmove.com`
- `SMTP_PASS=<Private Email mailbox Master/Application password>`
- `SMTP_FROM=info@tutmove.com`
- `PUBLIC_SITE_URL=https://tutmove.com`

Do not commit SMTP_PASS into source code or the ZIP.

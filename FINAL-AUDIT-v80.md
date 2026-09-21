# TUT Move v80 — final pre-upload audit

## Fixed in v80
- Removed the mobile hero single-line constraint that caused headline clipping on narrow phones.
- Added viewport-safety rules for media, grids, forms and narrow layouts.
- Completed all runtime `tr(...)` workflow strings identified by static analysis for Arabic, German, French, Spanish and Portuguese.
- Added missing password-reset and hero translations.
- Preserved the existing password-reset security design: random token, SHA-256 stored hash, 30-minute expiry, one-time use and session invalidation after reset.

## Local checks executed
- `node --check app.js`: PASS
- `node --check server.js`: PASS
- Home route: HTTP 200
- Security headers checked: X-Content-Type-Options, X-Frame-Options and Referrer-Policy present
- Registration: PASS
- Logout: PASS
- Incorrect-password rejection: PASS (401)
- Correct-password login: PASS (200)
- Forgot-password unknown-account generic response: PASS (200, no account enumeration)
- Invalid reset token rejection: PASS (400)

## Production-only checks still require the deployed environment
The ZIP intentionally contains no Render DATABASE_URL or PrivateEmail app password. Therefore real PostgreSQL persistence and real SMTP delivery cannot be executed from this local package. After upload, the final smoke test is: open the live site on a phone, switch each language, request a reset email for a real account, open the one-time link and set a new password.

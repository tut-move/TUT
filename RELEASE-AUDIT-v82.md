# TUT Move v82 release audit

## Fixed in this release
- Mobile hero no longer forces translated sentences onto a single unbreakable line.
- Home emblem presentation is clean: decorative nested frames around the large emblem are removed.
- Gold emphasis is preserved in the hero after language switching.
- About page uses the available desktop width with larger readable typography; mobile collapses safely.
- Footer legal navigation participates in the language system (AR/DE/FR/ES/PT).
- Footer wraps safely on narrow screens.
- Password recovery implementation retained: generic forgot-password response, SHA-256 token storage, 30-minute expiry, one-time token, password confirmation UI, session invalidation after reset.
- SMTP secret remains environment-only; no SMTP password was added to source.

## Checks run
- `node --check app.js`: PASS
- `node --check server.js`: PASS
- Local HTTP `/`: 200
- Local HTTP `/style.css`: 200
- Unknown-account forgot-password request: generic success response (no account enumeration)
- Production secret scan: no literal SMTP password committed by this release.

## External checks still require deployed services
Real email delivery requires the Render SMTP environment variables and a live mailbox. PostgreSQL behavior depends on the deployed `DATABASE_URL`. Real KYC and real payment-provider settlement cannot be certified from this ZIP alone.

# TUT Move urgent implementation status

## Implemented in this package
- Owner-configurable fixed USD customer and provider fees for **new** deals.
- Separate Stripe Checkout sessions for each party, with server-side webhook amount/currency/session validation.
- Ten-minute payment window measured from the first Checkout initiation; periodic expiry checks and Stripe refund requests for captured payments after timeout.
- Fee acknowledgement checkbox before redirect to Stripe in the Activity flow.
- Both fees must be confirmed before unlocking the deal.
- Existing black/gold PDF deal record updated to show two fixed USD fees.
- Existing registration, listing and verification code retained.

## IMPORTANT: NOT production-certified
- Stripe webhooks/refunds have NOT been tested against a live Stripe account.
- Refund attempts may fail and require operational follow-up. Stripe Checkout sessions may remain open after the ten-minute platform deadline; late payments should be refunded by webhook handling.
- There is no automatic refund of disputes or failed transactions outside the timeout case.
- Older deals with percentage fees are intentionally blocked from new Checkout until manually migrated.
- Document redaction, legal policies, notifications, invoice visual fidelity and end-to-end regression testing are NOT complete.
- Deployment to GitHub/Render has NOT been performed.
- Do not activate live Stripe payments until end-to-end testing, legal review and reconciliation controls are completed.

## Environment
- Node.js 20+, `npm install`, `npm start`.
- Stripe requires `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, publicly accessible `siteUrl` setting and a webhook for `checkout.session.completed`, `checkout.session.async_payment_succeeded`, and `charge.refunded`.
- For production, use a persistent PostgreSQL `DATABASE_URL` and reliable operational monitoring.
- Do not commit Stripe secrets to GitHub.

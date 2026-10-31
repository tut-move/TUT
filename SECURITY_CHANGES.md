# Security changes

- Owner dashboard HTML is now served only to an authenticated owner via `/owner-dashboard.html`.
- Public `/api/settings` no longer returns owner identity fields.
- Public `/ownership.json` no longer reveals legal entity settings.
- Public payment-policy text uses generic payment processor wording. Stripe API integration remains unchanged.
- Bundled database snapshots have been excluded from the deliverable to avoid publishing user/session data. **Do not overwrite your production database.**

## Deployment notes
- Keep DATABASE_URL configured in Render; do not deploy with the local-file fallback for production.
- Never commit `.env`, database files, or uploaded identity documents.
- Existing Git history may still contain committed database snapshots. Remove them from repository history and rotate any exposed session tokens/secrets.
- Test owner login, dashboard, fee updates, and payment flows in a staging deployment before production.
- Some payment provider branding may be mandatory in provider-hosted checkout or legal disclosures.

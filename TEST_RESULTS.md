# TUT Move test build — verification

Verified locally (Node 22): `node --check server.js`, `node --check app.js`, HTTP GET `/` 200, HTTP GET `/api/site` 200.

Important: SMTP was not available in this test container; the server now starts without it, but email features require `npm ci` to install nodemailer. Stripe live/test webhooks, refunds, database persistence on Render, identity masking, and full end-to-end user flows have NOT been verified. Do not accept live payments until Stripe test-mode scenarios and refund handling pass.

Deployment: Render Node Web Service, build command `npm ci`, start command `npm start`. Set `DATABASE_URL` for persistent Postgres and configure Stripe secrets and webhook. Configure `PUBLIC_SITE_URL` and SMTP variables for emails. Never commit secrets.

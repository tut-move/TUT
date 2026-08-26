# TUT Move v9

Official working domain: https://tutmove.com

## Run
`node server.js`

## Render
Start command: `node server.js`

## Ownership
The Owner account is created once from the app. The authoritative control of the project remains the domain registrar account, GitHub repository owner, hosting account, and production database account.

## Important before real customers
Replace the file-based database with a persistent production database, connect official KYC/document verification, and connect a marketplace payment provider before processing real money or sensitive identity documents.


Brand display updated to TUT MOVE while preserving the original gold emblem artwork.


## v23 — Persistent production database

This version supports PostgreSQL through the `DATABASE_URL` environment variable.

Production:
1. Create a PostgreSQL database on your hosting provider.
2. Add its internal connection string to the web service as `DATABASE_URL`.
3. Build command: `npm install`
4. Start command: `npm start`
5. Deploy.

On first startup, if PostgreSQL is empty, TUT Move imports the current local `data/db.json`
state once. After that, users, the owner account, listings, offers, bookings, matches,
verification metadata and owner settings are stored in PostgreSQL and survive deployments.

`/api/health` reports whether the application is using `postgresql` or `local-file`.

Note: uploaded verification document bytes still need object storage (e.g. S3-compatible
storage) before a production KYC launch. The user/account/market database is persistent in v23.


## v30 verification redesign
Verification is now role-adaptive and trip-oriented. The UI asks for minimal account information and keeps booking readiness checks in the agreed trip workflow. No production KYC provider or real payment rail is connected in this MVP.

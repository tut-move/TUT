# TUT Move — Final Recovery Package

This folder is the latest complete source package available from the project work, based on **TUT-Move-v24-official-email**, which includes the v23 PostgreSQL persistence work plus the official-email update.

## What is included
- `index.html` — application UI
- `style.css` — application styles
- `app.js` — browser-side application logic
- `server.js` — Node.js server/API and PostgreSQL integration
- `package.json` — Node dependencies and start command
- `data/db.json` — local/bootstrap data only
- `tut-emblem.png` and `founder-abdelaziz.png` — project assets
- `README.md` — project notes

## Confirmed production configuration (2026-08-24)
- Web service: Node.js on Render
- Official domain: `https://tutmove.com`
- Start command: `node server.js` / `npm start`
- PostgreSQL persistence: enabled through environment variable `DATABASE_URL`
- Application log confirmed: `TUT Move database: PostgreSQL persistent storage connected`
- Application log confirmed: `TUT Move v23 running on 10000`
- Application reached: `Your service is live`
- Owner account was successfully created and Owner Dashboard opened.
- Owner Dashboard showed platform fee `5%` and default currency `USD` at the confirmed checkpoint.

## Environment variables required
Do NOT commit secret values to GitHub.

- `DATABASE_URL` — PostgreSQL connection string from the production database provider.
- `PORT` — normally supplied by Render automatically.
- `PGSSL` — optional SSL behavior supported by the server code.

## Restore on GitHub + Render
1. Create/open the GitHub repository.
2. Upload the **contents of this folder** to the repository root (not the outer folder itself).
3. Commit the files.
4. In Render, create/connect a Node Web Service to that repository.
5. Build command: `npm install` (the previously running service also used a no-build command at one point; `npm install` is the documented v23 configuration and installs `pg`).
6. Start command: `npm start` (equivalent to `node server.js`).
7. Add `DATABASE_URL` in Render Environment using the PostgreSQL connection string.
8. Deploy.
9. Check `/api/health` and Render logs. Production should report PostgreSQL, not local-file.
10. Reconnect the custom domain `tutmove.com` if rebuilding the Render service from scratch.

## Database recovery warning
The source ZIP restores the **application**, but it cannot contain the live PostgreSQL database contents or its secret password/URL. GitHub alone cannot restore users/listings/bookings that were created after deployment.

At the confirmed checkpoint the new PostgreSQL database had the owner account and the dashboard showed 1 user, 0 open listings, 0 offers and 0 bookings. To preserve future live data, maintain a PostgreSQL backup/export separately.

The Render PostgreSQL database shown during setup was a **Free** database and displayed an expiry date of **September 23, 2026 unless upgraded to a paid instance**. Protect/upgrade/export it before that deadline.

## Known incident and fix
An earlier deploy failed with:
`Database initialization failed: Error: getaddrinfo ENOTFOUND base`

That was an incorrect database connection value. A later deployment successfully connected to PostgreSQL, so the red error visible in older Render logs is historical and not the final service state.

## Security
Never put the production `DATABASE_URL`, database password, account password, API keys, or other secrets into this ZIP/repository. Store secrets in Render Environment or another secret manager.

## New ChatGPT conversation handoff
Upload this ZIP and say:

> This is the TUT Move final recovery package. Read `RECOVERY-GUIDE.md`, `README.md`, `server.js`, `app.js`, `index.html`, `style.css`, and `package.json` before making changes. The production app was confirmed running on Render with PostgreSQL persistent storage and tutmove.com. Continue from this checkpoint; do not rebuild from scratch unless necessary.


## v25 workflow added
- Accepted offer creates a booking with TUT fee calculation.
- Payment is TEST MODE only; no real card/bank/Stripe transaction occurs.
- Pre-trip checklist: driver, licence, truck, cargo and receiver.
- Both buyer and provider must mark their side ready.
- Pickup can be confirmed only after the trip is ready.
- Delivery follows pickup and marks a simulated payout as ready.
- Real KYC/document provider and real Stripe Connect remain intentionally unconnected until legal entity/bank onboarding.

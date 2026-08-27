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

## v26 UX / language revision
- Rebuilt Offers & Bookings workflow UI to remove the crowded technical paragraph.
- Added full translations for all new workflow text in Arabic, German, French and Spanish.
- Added TUT Price Estimate as non-binding guidance; users still negotiate the final market price.
- Price estimate is an MVP guidance formula, not live market pricing and not an Uber clone.
- Real payments remain intentionally disabled.

## v27 market-pricing correction
- Removed the TUT Price Estimate and all platform-generated transport price ranges.
- TUT Move does not set or calculate transport prices.
- Final price is agreed only between the parties through offer / counter-offer / accept.
- Added a multilingual explanation of the market-pricing flow.


## v28 Offers cleanup
- Removed the duplicated booking/trip-control and large market-pricing explanation.
- Offers now uses one compact three-stage flow:
  1. Negotiate: Offer -> Counter -> Accept
  2. Secure: Payment -> Verification
  3. Transport: Pickup -> In transit -> Delivered
- TUT Move explicitly does not set the transport price.
- Added Arabic, German, French and Spanish translations for the new workflow.

## v29 Verification v1
- Built directly on v28; existing UI/features were retained.
- Added account verification submission and statuses: not submitted, pending, verified, rejected.
- Added owner review queue with approve/reject.
- Verification is manual v1; no paid KYC provider and no real payments were connected.

## v31 Verification final
- Verification simplified and compacted.
- Role-specific fields only.
- Arabic/German/French/Spanish verification translations completed.
- Arabic RTL corrected.
- Rest of site retained from v30.


## v32 Global language, date/time and responsive foundation
- Built directly on v31; marketplace logic and pricing model were not changed.
- Replaced ambiguous browser datetime typing with a canonical YYYY-MM-DD + time component.
- Dates are stored internally in ISO format and displayed according to the selected language.
- Calendar button remains available across browsers; manual typing can no longer flip DD/MM and MM/DD.
- Dynamic listing values and common market UI now translate individually instead of leaving mixed English.
- Dry Van / non-temperature transport hides temperature fields; Reefer shows them.
- Added a global desktop/tablet/mobile responsive pass and RTL-safe behavior.
- Supported UI languages remain English, Arabic, German, French and Spanish; each selected language uses the same site-wide translation system.

## v33 Dates, account deletion, Portuguese & language completion
- Load/Cargo now has two explicit date/time fields: Required pickup and Required delivery.
- Delivery must be after pickup; both are required before publishing a load request.
- Added self-service account deletion for normal marketplace users. Deletion removes that user's listings, offers, bookings, verification records and uploaded verification files. The special platform-owner account is protected.
- Added Portuguese (PT) to the language selector.
- Added full Portuguese translation coverage for the current canonical UI dictionary and filled known French/Spanish/German gaps.
- Dynamic account, offers, matches, verification and owner-dashboard UI now routes through the same translation function instead of injecting English-only labels.
- English remains the canonical source language; Arabic RTL and the existing responsive desktop/tablet/mobile foundation remain unchanged.


## v34 Language stability fix
- Built directly on v33; no pricing, booking, date, account-deletion, verification or database behavior was removed.
- Fixed the main source of mixed-language Market cards: free-form user text is no longer injected into translated summary cards.
- Market cards and the LIVE ticker now use structured, translatable resource/country/specification fields.
- User-entered free text remains stored unchanged in the database; it is not silently rewritten or mistranslated.
- Added missing Market/Post labels and common structured values for Arabic, German, French, Spanish and Portuguese.
- Changing language now forces dynamic Market, Matches, Offers, Bookings and Post fields to rerender immediately.


## v35 Strict full-site language layer
- Built on v34; no booking, verification, date, account-delete, database or pricing logic was removed.
- Added a strict site-wide translation pass for all UI chrome: headings, labels, buttons, options, placeholders, titles and ARIA labels.
- Added Portuguese to the language selector if missing.
- Arabic sets document RTL; all other languages remain LTR.
- Dynamic UI is retranslated automatically through a MutationObserver.
- User-entered free text is intentionally not silently rewritten; only the platform UI is guaranteed to follow the selected language.

## v36 Simple Entry UX + Owner Privacy
- Built on v35.
- Replaced the technical home chooser with nine plain-language user situations.
- Each choice maps internally to the existing Available/Wanted + Driver/Truck/Load/Warehouse model.
- Added direct entry for Returning Empty and Unused Truck Space without changing marketplace storage architecture.
- Owner/Admin navigation is guarded for owner accounts only.
- Removed the public MVP/KYC/payment development disclaimer from the footer.
- Added translations for the new primary choices in AR/DE/FR/ES/PT and responsive desktop/tablet/mobile styling.

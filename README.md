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


## v42 — Adaptive workflows + persistent sessions
- Driver, Transport, Truck, Warehouse and Equipment bookings now show different confirmation workflows.
- Driver deals no longer show cargo/pickup/delivery controls and do not deduct a percentage from agreed driver compensation.
- Language switching updates in place without a page reload.
- Login sessions are stored persistently and use a 30-day cookie, so refreshes, language changes and server restarts do not intentionally sign users out.
- Existing test driver bookings are normalized when loaded.


## v42 — Role-aware driver deals + durable login
- Driver bookings now show two different sides: the available driver profile and the company/request requirements.
- Driver licence/verification snapshot comes from account verification data; users no longer tick identical driver verification boxes manually.
- Driver and requester receive different confirmation wording and see the other side's relevant details.
- Old transport statuses on driver deals are normalized away.
- Browser stores an opaque session token and sends it as a Bearer fallback in addition to the secure cookie, so refresh/language changes keep the user signed in even when a browser drops the cookie.


## v44 — Complete language + counterpart workflows
- Language switching rerenders the entire current UI in place and keeps the active session.
- Durable bearer-token + cookie session survives refresh and language changes.
- Account deletion now requires the current password; typing DELETE is no longer used.
- Registration has explicit visual role cards so users know whether they joined as driver, truck/trailer owner, carrier, shipper or warehouse owner.
- Driver, warehouse, truck/trailer, equipment and cargo/transport agreements show the relevant counterpart information to both sides.
- Truck marketplace now explicitly supports truck and trailer rental/lease requests and offers.

## v47 — Verification + route correction
- Verification now collects real visible fields: legal name, government ID number/document, selfie, driver licence number/class/expiry/document, endorsements, and role-specific business/vehicle details.
- Driver licence/qualification choices are explicit clickable cards with a visible selected state.
- Every marketplace listing category now contains two required route points: pickup/start address and delivery/end address, each with its own map. This applies to drivers, trucks/trailers, loads, warehouses/storage and equipment, for both AVAILABLE and WANTED listings.
- The two addresses are stored in listing data and surfaced to counterpart views.
- Added translations for the new verification and pickup/delivery UI in Arabic, German, French, Spanish and Portuguese.

## v48 — Polished test experience
- Reworked the home screen into a clearer two-sided logistics marketplace entry.
- Added a dedicated Payments screen using the existing safe TEST MODE booking payment state.
- Added `/api/integrations/status` to show whether payment/KYC environment credentials are present without exposing secrets.
- Rebuilt account verification as a three-step, role-adaptive wizard: Identity → Qualifications → Documents.
- Preserved the existing marketplace, offers, bookings, multilingual behavior, PostgreSQL support and owner review flow.
- Real payment capture remains disabled by design. Connecting Stripe Connect or another marketplace payment provider requires provider SDK/API work, webhooks, legal/business onboarding and payout configuration.
- Production KYC still requires an official provider plus secure object storage for document bytes.


## v49 UX correction
- Founder image is now served by the Node static-file allowlist.
- Language switching rerenders in place and preserves the durable session token.
- Header navigation is reduced; Market opens resource categories.
- Home entry is simplified into I NEED / I HAVE with direct resource choices.
- Payments is removed from primary navigation but the page/logic remains available.


## v50 — Clean two-side entry + strict language pass
- Home entry is reduced to two choices: I WANT / I OFFER, with one shared resource panel below.
- Registration role cards are single-row, emoji-free choices.
- Language switching remains in-place and preserves the durable login token.
- Added a dedicated translation pack for the new home, navigation and registration UI in AR/DE/FR/ES/PT.
- Market menu layout was corrected so titles and descriptions do not run together.


## v51 — Horizontal choice cleanup
- Home entry now uses two concise side choices: I WANT / I OFFER.
- Resource choices are four horizontal single-line cards on desktop.
- Removed resource codes and explanatory text from the cards to prevent crowded/duplicated labels.

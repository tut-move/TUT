# TUT Move v78 — full pre-payment functional audit

Date: 2026-09-20

Automated isolated end-to-end audit completed against the actual Node server with a clean local database. Test accounts/data were removed before packaging.

## Result
126 checks passed, 0 failed after fixes.

## User journeys exercised
- Driver AVAILABLE and Driver WANTED
- Truck/vehicle AVAILABLE and WANTED
- Warehouse AVAILABLE and WANTED
- Storage AVAILABLE and WANTED
- Equipment AVAILABLE and WANTED
- Load/cargo AVAILABLE and WANTED
- Owner setup, owner settings and 0–100% fee control
- Registration, duplicate-email protection, login/session authorization boundaries
- Driver verification submission and owner manual review
- Listing creation, counterpart context, matching data, self-offer prevention
- Offers, counter-offers, rejection and acceptance
- Buyer/provider assignment in both AVAILABLE and WANTED directions
- Fee calculation: EUR 1,000 agreement -> EUR 50 fee at 5%, buyer total EUR 1,050, provider net EUR 1,000
- Payment blocked before required checks
- Provider blocked from authorizing buyer payment
- Buyer test payment after both sides are ready
- Transport pickup -> in transit -> delivery -> simulated payout-ready
- Pre-trip checks locked after pickup
- Notifications generated and marked read
- Listing ownership/deletion permissions
- Account deletion requires correct password
- Owner dashboard summary/statistics
- Homepage, robots.txt, sitemap.xml and all favicon/apple icon routes return HTTP 200

## Fixes made during this audit
1. Storage agreements now return the correct deal context instead of an empty warehouse context.
2. Warehouse and equipment agreements now expose the same next-step payment action as truck agreements when both sides are ready.
3. Driver agreements now expose the payment next step after driver verification and both-side confirmation.
4. Favicon routes remain explicitly served by the static allowlist.

## Deliberately not production-connected
- Real payment capture/payout provider
- External KYC/identity provider and secure production document storage

These integrations require the selected payment/KYC intermediary/provider and its production credentials/webhooks. The application remains in TEST MODE until those are connected.

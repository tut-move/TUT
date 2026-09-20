# TUT Move — Pre-launch hardening build

This build is intentionally still TEST PAYMENT ONLY. It does not enable real charges or payouts.

Changes made:
- Verification file pre-check can no longer mark a user as verified.
- Owner verification review now synchronizes the user verified state.
- Marketplace fee is frozen on an accepted booking; changing the owner setting affects future bookings only.
- Browser authentication uses the HttpOnly session cookie instead of exposing the session token to localStorage.
- Added basic login throttling (10 failed attempts / 15 minutes per client IP).
- Added baseline security response headers.
- Removed the duplicate admin user-delete route.
- Existing TEST payment/payout behavior remains unchanged.

Before real payments/KYC:
- Connect an official payment marketplace provider in sandbox first.
- Connect an official KYC/KYB provider; do not treat local document upload as official verification.
- Back up the production database before any schema migration.

# TUT Move v71 pre-launch test results

Local isolated end-to-end API test completed without using the live Render database.

Passed:
- Owner setup and authenticated sessions
- Two independent member registrations
- Listing creation
- Self-offer blocked
- Provider offer creation
- Offer sender cannot accept own offer
- Listing owner can accept offer and create booking
- 0% fee produces 0 fee, buyer total = agreed price, provider net = agreed price
- Changing owner fee after booking does not retroactively alter the existing booking
- Buyer-only test payment authorization
- Provider blocked from authorizing buyer payment
- Verification submission remains pending and does not auto-verify user
- Real payment capture remains disabled

Fix added after testing:
- `/api/verification/submit` now synchronizes the public user verificationStatus to `pending` and explicitly keeps verified=false.

Scope note:
- This is a local pre-launch functional/security smoke test. Real payment/KYC providers remain intentionally disconnected.

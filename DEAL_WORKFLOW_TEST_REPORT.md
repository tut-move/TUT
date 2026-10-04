# TUT Move Deal Workflow — Verification Report

Baseline: uploaded `TUT-main(6).zip`.
Scope: deal workflow localization + masked sensitive identifiers + post-fee contact unlock.

## Automated code checks
- PASS — commission percentage snapshotted at acceptance
- PASS — commission amount percentage-based
- PASS — Stripe checkout only after both confirmations
- PASS — contact details locked until paid
- PASS — post-payment profile includes phone + email
- PASS — ID number masked before payment
- PASS — licence number masked before payment
- PASS — ID/licence remain masked after payment
- PASS — workflow UI uses selected-language translation
- PASS — user-entered deal data not auto-translated

## Important boundary
Document images are not exposed before payment. The system shows provided/missing status plus masked ID/licence numbers. This avoids exposing an unredacted uploaded document image. Full original-document verification remains an in-person responsibility of the two parties.

## Languages
Deal workflow UI follows the existing site language selection for English, Arabic, German, French, Spanish and Portuguese. User-entered listing/offer/profile data is preserved as entered and is not machine-translated.
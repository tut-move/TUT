# TUT Move v97 — Deal completion workflow

Implemented in this build:

- Basic verification remains a mutual masked review step.
- Contact phone/email unlock after both parties choose Continue; sensitive ID/licence numbers remain masked and original files remain private.
- Added mutual underlying-payment terms: Cash, Bank Transfer, Cash / Bank Transfer, or Other agreed method; plus payment timing. Both parties must submit matching selections.
- TUT Move fee cannot open until verification decisions and payment terms are mutually confirmed.
- Only `feePayerUserId` can start Stripe Checkout. The other party sees that the fee is the responsibility of the other party, not a payment action.
- Fee percentage and amount remain locked on the deal at accepted-offer creation, so later owner fee changes affect new deals only.
- Deal-open view exposes contact details and the agreed settlement method/timing.
- Final completion still requires confirmation from both parties.
- Replaced the old plain-text PDF with a black/gold Final Deal Record. All transaction values are dynamic: parties, roles, deal type, price, fee %, fee amount, fee payer, settlement method, payment timing, terms, reference and support email.
- Final PDF remains downloadable from Completed Deals and is emailed to both parties when SMTP is configured.
- Verification file handling preserves previously uploaded files when a user edits/saves the profile without selecting replacement files. Browser upload uses FileReader and supports desktop/mobile file selection up to 3 MB per file.

Validation performed: `node --check server.js` and `node --check app.js` pass. Full runtime boot could not be executed in this isolated build environment because npm dependencies are not installed there; deployment should run `npm ci` before starting the app.

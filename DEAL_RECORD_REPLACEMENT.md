# Final Deal Record — clean replacement

- Removed the legacy inline PDF drawing implementation from `server.js`.
- Added one PDF generator in `deal-record.js`, used unchanged by both the email attachment and the authenticated download route.
- Added `deal-record-emblem.jpg`, generated from the existing project `tut-emblem.png` to avoid external PDF libraries or Render browser dependencies.
- Dynamic fields: both party identities and roles, email/phone/country, route if available in stored booking/listing/offer data, agreed price/currency, platform fees and actual statuses, payment terms, reference and UTC completion date.
- Missing route values display **Not specified** rather than invented cities. Current booking creation does not copy pickup/delivery locations; route extraction supports common fields in booking/listing/offer. Confirm actual listing schema before relying on route display.
- The existing logo asset is not identical to the winged TUTMOVE concept mockup. Replace the asset if the exact approved emblem is required.
- The PDF generator is dependency-free and produces A4 PDF with one page. Long text is truncated for layout; full legal terms should be made available separately if needed.
- PDF smoke tested with `pdfinfo` and raster rendering. Email delivery and Render production deployment were not tested because no production credentials are available.

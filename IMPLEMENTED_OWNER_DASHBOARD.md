# Owner dashboard update

- Replaced only the two lower owner dashboard sections with nine number-only cards: five role counts, visitors, registered users, completed deals, and platform revenue.
- Preserved ownership, commission, and security accordions and their save/change-password functions.
- Owner sets customer/provider fees independently and chooses USD or EUR for **new** deals. Values are fixed in the selected currency at deal creation; Stripe checkout charges in that currency. Old deals default to USD, unchanged.
- Removed the currency-position UI and explanatory yellow notice. The existing reporting currency configuration is retained internally to avoid affecting other listing defaults; the new owner selector controls commission currency.
- Visitor count is distinct browsers that load the updated app from this release forward (localStorage ID, hashed server-side). Historical visits cannot be reconstructed.
- Revenue card counts captured platform fees marked paid, grouped by currency. Mixed USD/EUR revenue is displayed separately without assuming an exchange rate. Refunds and chargebacks should be reconciled separately in production accounting.
- Role counts and completed deals use existing server records; no invented demo values.
- UI strings for new cards are translated using existing app language machinery. External Stripe checkout requires configured live/test Stripe credentials to validate end-to-end.

## Validation
`node --check server.js` and `node --check app.js` passed; local server responded to a visitor API smoke test. Test visitor data was removed from the delivered database. No live Stripe payment was made.

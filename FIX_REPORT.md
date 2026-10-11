# TUT Move targeted fixes
- Prevents periodic activity refresh from destroying and recreating unchanged deal/offer DOM every 5 seconds. Polling is non-overlapping and 12 seconds; changed deal cards retain previously expanded verification content.
- PDF shows the transaction-specific requester/provider roles under the party names and in contact details, rather than relying on account roles.
- Sensitive identifier previews only retain ASCII alphanumeric suffixes, avoiding malformed trailing characters.

## Limitations
- Document images remain intentionally fully redacted in counterparty previews: reliable selective image redaction has NOT been implemented. Never expose original identity documents to other participants.
- End-to-end Stripe and browser interaction tests require a configured deployment and test credentials; not certified for live payments.
- Historical deals may contain invalid same-party references; this patch does not fabricate replacement parties.

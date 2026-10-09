# Privacy patch status (2026-10-09)

Implemented and syntax-checked:
- Server generates a safe privacy preview for identity/licence uploads, discarding original bytes. The preview is a replacement card, NOT OCR-based selective redaction.
- Document data URL magic-byte checks; mismatched formats rejected.
- Older document uploads lacking the explicit server-generated privacy method cannot be opened via the deal photo endpoint or counted as ready.
- Driver licence uploads only accepted for the driver role. Drivers need licence details; transport companies need registration number.
- Client downscales large camera photos before upload to reduce latency, with original fallback.
- Deal verification photo endpoint requires deal membership and no-store headers; existing deal notification flow retained.

NOT implemented: reliable OCR redaction of arbitrary international documents while retaining the original document portrait/name; company vehicle document workflows; comprehensive deployment/browser tests. Do not advertise this patch as complete smart document redaction. Existing selfies remain separate and may be shared to deal participants.

Test manually in a staging deployment with synthetic data before production use. Never upload real identity documents to an unverified staging instance.

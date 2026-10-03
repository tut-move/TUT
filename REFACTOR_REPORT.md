# TUT Move v94.1 Clean v2 — Refactor Report

Baseline: TUT-CLEAN-v94.1-FINAL

## Completed
- Kept v94.1 as the sole functional baseline.
- Preserved the existing HTML structure, backend, dependencies, routes, assets, and public copy.
- Kept the prior JavaScript cleanup: duplicate/shadowed function declarations removed; no duplicate named function declarations remain.
- Consolidated the stacked late-stage v49 Hero/About CSS release overrides into one canonical public-page layout block.
- Preserved unrelated owner/admin, forgot-password, responsive safety, legal, and verification rules from the replaced CSS region.
- Removed contradictory mobile hero rules from the stacked release patches by retaining the final-release behavior.
- Updated the stylesheet cache key in index.html.

## Verification
- `node --check app.js`: PASS
- `node --check server.js`: PASS
- Duplicate HTML IDs: none detected
- Local project structure/assets preserved

## Scope note
This is a conservative refactor. Earlier CSS contains styles for many application screens and workflows; those were not deleted merely because they look old. A rule is only removed when the later canonical release block makes its replacement unambiguous.

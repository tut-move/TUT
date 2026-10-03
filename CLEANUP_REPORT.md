# TUT Move v94.1 — Clean Baseline

This package is the cleaned baseline derived only from v94.1. No files or UI changes were imported from TUT-main.

## Removed safely
- Removed 6 shadowed duplicate JavaScript function declarations from `app.js`.
- The surviving declarations are the effective/latest implementations that the browser was already using.
- Removed no production assets and no application data.

## Verified
- `node --check app.js` passes.
- `node --check server.js` passes.
- `index.html` contains no duplicate element IDs.
- Every local asset referenced by `index.html` / `style.css` exists in the package.
- Cache-buster labels for `app.js` and `style.css` now identify this baseline as `94.1-clean`.

## CSS decision
`style.css` contains historical cascade/override layers, especially around the home hero and About page. They were NOT bulk-deleted. Some earlier declarations still supply properties that later "final" blocks do not redefine, so deleting them without browser regression coverage can alter the v94 appearance. Keeping those rules is intentional for this baseline.

The next UI redesign should replace/refactor the relevant component CSS as a unit instead of appending another override block to the bottom of `style.css`.

## Baseline rule
Use this package as the source for future work. Do not copy old ZIPs, recovery HTML, audit reports, or prior release snapshots into the production root.

# Unknown-monitor grid within the Desktop lease

Research only: no production replacement or native Desktop execution. An empty right-hand 150% monitor is not solved by this document. A restriction preventing its use must not be called completion.

## Current cost

`lib/desktop-calibration.js` generates roughly 26 observations per axis (forward/reverse). Every sample in `Calibrate-DesktopGrid` takes a pre-snapshot, while `Wait-CalibrationSettled` adds 180 ms and repeated strict snapshots separated by 150 ms. Roughly 52 observations explain tens of seconds. Snap-OFF free positioning and DPI-scaled spacing guesses do not measure the real grid.

## Proposed integration, pending implementation approval

1. Prepare a durable lease containing original Hidden and file identities, original flags, full old icon identities/coordinates, physical geometry, target monitor, selected relative shape and a reserved empty probe patch with guards. All old icons on known monitors must be exact-grid. Other unknown populated areas require proof too. No safe patch means no initial mutation.
2. Keep remaining selected items hidden. Under snap OFF reveal only the first selected probe with truthful ATTRIBUTES notification. During arrival verify every old identity/coordinate. Position the probe exactly inside its patch.
3. Journal calibration intent before changing flags. A dedicated phase guard allows only the selected probe to be off-grid in the safe patch; all old icons must remain on proven grids. Do not weaken ordinary Lease-AllGrid. Enable snap, then verify actual Shell readback: every old identity/coordinate unchanged, flags exact, probe inside patch. This transition needs native proof, not an assumption.
4. Adaptive bounded pitch/origin candidates choose informative requests. Uniqueness alone is insufficient: require three neighboring cells, two plateaus, reverse repeatability, both axes, old identity/coordinate guards and physical geometry/flags consistency. Ambiguous, clipped, cross-axis or nonuniform behavior fails or falls back to the existing bounded dense sweep. Never finalize a DPI estimate as proof.
5. After proof, disable snap again. Plan the original drop anchor and selected relative shape against actual measured grid, collisions, monitor bounds and existing icons. No-fit cancels by rehiding the probe, verifying old state and restoring flags without metadata/history changes. Never scatter the shape silently or move old icons.
6. Reveal remaining selected items, normal batch placement, snap restore, exact target and old-icon verification, then metadata commit/receipt. Persist grid evidence only after complete success, bound to Explorer process/birth/window and monitor geometry/DPI; invalidate on changes.

## Interrupted-operation recovery

Before reveal the watchdog must durably know selected identities and original Hidden states. Journal phase transitions before mutations that change recovery meaning. On failure, rehide only revealed selected items using identity-bound operations, verify disappearance and every old identity/coordinate, then restore original flags. Never rewrite old positions to conceal a regression. On uncertain helper termination, do not let another actor mutate; retain unresolved recovery state. No metadata or cache commit for incomplete calibration.

Fault cases: before reveal; after reveal before snap ON; after snap ON before sampling; mid-sample; after proof before final shape plan; no-fit; remaining-item reveal; placement before commit. Inject Explorer/geometry change, identity substitution, foreign item entering patch, occupied guard, unexpected flags, nonuniform snapping and deadline. Require actual original Hidden/content/metadata and old positions, not just process termination.

## Pure synthetic evidence

Run `node tools/unknown-grid-adaptive-model-selftest.js`. No OS/filesystem calls. The bounded nearest-integer-grid model covers 84 combinations of pitch, residue and negative/positive coordinates. Average 12.49, maximum 14 observations per axis identify the exact model, including adjacent-cell/plateau/reverse evidence. Unsnapped, changing and clipped models reject.

This is NOT Windows rounding, asynchronous settling, mixed-DPI, native collision or recovery proof. First-use latency will likely remain seconds, not hundreds of milliseconds. Reducing roughly 52 to 25-28 observations halves only this portion. A persistent native session may reduce repeated Shell setup, but needs measurements. Do not shorten stability waits merely because the synthetic model passes. Valid cached evidence can enable the normal warm path afterward.

## Next isolated native CI

Separate hosted-Windows-only job, leaving production and existing fault suites intact. Generated dense shortcuts, old-cell guards and one selected probe. Discard the test algorithm's prior grid knowledge, not the independent safety observer's baseline. The observer verifies all old icons and never rewrites their positions. This proves an unknown-knowledge path on one monitor, NOT a real empty 150% monitor.

Compare existing sweep/adaptive on identical fixtures. Record every requested/observed probe coordinate, old snapshots, native call count, arrival, settling, total calibration, full first return and cached return. Require exact final flags/old identity+xy, selected shape, metadata receipt, cleanup and each fault recovery. No Refresh, false CREATE/DELETE, approximate coordinates or omitted strict checks.

Then test a genuinely disposable mixed-DPI environment with populated known 100% and empty 150% areas. Ordinary hosted runners cannot prove this configuration by claiming it. Do not install display drivers or modify the user's Desktop to manufacture evidence. Until such an isolated environment is available, state that mixed-DPI validation remains outstanding.


## Native results and rejected wait-shortening experiment (2026-11-11)

Known 100% single-display native run `9ae` passed all four comparisons and cleanup:

- Dense: 58 observations, 52.061 s; adaptive fixed-settle: 24 observations, 21.372 s.
- Reverse order: adaptive fixed-settle 21.326 s; dense 50.984 s.
- All measured grids matched native reference spacing 78 x 98, origin residues 15, 2. Old icons, flags, probe file metadata/content and cleanup passed.

This establishes adaptive observation-count reduction in that isolated configuration, not mixed-DPI support or integration with lease fault recovery.

### Fast settling rejected

Commit `ee07fa3`, CI run `42997708028`, artifact `calibration-adaptive-evidence-ee0/calibration-adaptive-ci.json`:

- Dense completed in 48.688 s (58 samples).
- Fixed-settle adaptive completed in 27.220 s (24 samples), including the extra delayed audit added for this comparison.
- Fast adaptive failed on an x-axis candidate request `(365,359)`. At 237.5893 ms, two consecutive strict snapshots accepted the probe at `(365,359)`. After the audit (286.2491 ms later, including its wait and strict read), the same Shell identity was at the real snapped position `(327,394)`.
- The six old OS icons stayed unchanged and cleanup was verified. Overall research result is FAIL, correctly caught by `delayed-readback-mismatch`.

The failure was **not stale old coordinates**: Windows temporarily exposed the newly requested free position through multiple strict snapshots before asynchronously snapping it. Requiring a change from the previous position, and retaining the internal 40 ms double snapshot, did not establish final stability. During candidate discovery, that intermediate coordinate can also be compatible with a wrong candidate grid. Two equal reads are therefore not enough.

Do not adopt fast settling, remove the delayed audit, or reinterpret cleanup success as algorithm success. Keep the fixed-settle 24-observation variant (approximately 21-27 s in these runs) as the current research candidate. Its improvement comes from fewer requests while retaining the established settle protocol, not from weakening that protocol. The fixed strategy still needs genuine 150% mixed-DPI and lease recovery tests; it is not a general guarantee against all Windows scheduling delays.

No additional wait reduction is justified by these measurements. Before another optimization, profile native pre-snapshot, repeated Shell session setup, validation and JSON/IPC separately while leaving the wait/stability protocol unchanged. Session reuse is only a possible future investigation, not a demonstrated improvement. Preserve the failed fast experiment as negative evidence; do not retry it on the user's Desktop or integrate it into production.

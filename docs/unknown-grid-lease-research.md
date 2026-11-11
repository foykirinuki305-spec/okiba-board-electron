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

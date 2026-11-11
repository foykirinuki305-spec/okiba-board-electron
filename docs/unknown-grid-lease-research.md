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


## DPI-derived pitch shortcut: deferred, alias counterexample

Using spacing * monitorDPI / viewDPI as a hypothesis only might eliminate the four candidate-discovery observations. It cannot halve the current 24-point method: retaining twenty evidence observations plus one initial XY snap gives roughly 21 points, saving only three. Failed hypotheses add cost before fallback.

More importantly, skipping candidate discrimination is unsound with the sparse evidence alone. Run `node tools/grid-pitch-hypothesis-counterexample.js` (pure, no native operations). Actual pitch 117, origin 15, center 400 can falsely validate hypothesis pitch 234, inferred origin 132. Requests 132/308/424/542/658 return 132/366/366/600/600; reverse requests repeat exactly. These appear to be three cells and two plateaus at pitch 234, but true cells 249 and 483 were skipped. Quarter-pitch offsets floor(234/4)=58 lie just inside the real half-spacing 58.5. The analogous aliases actual9/hypothesis18 and actual147/hypothesis294 also reproduce. Thus the sparse proof does not prove that its cells are adjacent without the earlier candidate discrimination.

Preserve full adaptive candidate discovery. A future hypothesis shortcut would need independent intermediate-cell/boundary tests that reject divisors/aliases, plus wrong rounding, nonuniform, unsnapped and time-varying counterexamples. Finite probes cannot establish uniformity outside the observed patch. No additional native test or production change is justified for this small possible saving now.

## Lease integration phase table (design only, no parallel implementation)

All native mutation must run in the same dedicated lease helper under the global Desktop exclusion. Do not call the ordinary calibration helper concurrently with an active lease. Existing known-grid and resident movement implementations remain untouched until ownership coordination and approval.

| Subphase | Durable intent before action | Preconditions and action | Verified exit / failure |
|---|---|---|---|
| prepare-unknown | Versioned unresolved-grid scope, original flags/icons/geometry, selected source/destination file IDs and Hidden, receipts, original drop anchor/relative shape, guarded patch | Separate scope variant; do not silently weaken existing resolved-target validation. Reserve global lease and confirm all old known-grid positions | No mutation if unsafe patch, unknown populated old area, stale identities or wrong flags |
| probe-reveal | Probe identity and original Hidden, exact allowed patch, rollback subset | Snap OFF through lease; reveal first selected item only, ATTRIBUTES, wait for appearance under old guards, place in patch | Old identities/xy unchanged and probe exact inside patch; rest remain hidden |
| probe-snap | Snap-ON intent and probe-only off-grid exception | Dedicated phase guard proves all old icons on measured grids; probe alone may be off-grid inside patch; enable snap | Actual readback old exact, probe bounded, flags exact; otherwise stop and recover, never rewrite old coordinates |
| calibration-fixed | Measurement phase and bounds, no metadata/cache permit | Fixed-settle adaptive candidate search plus complete evidence, every sample old/geometry/flags guarded | Proof obtained or bounded failure. Fast wait shortening remains rejected |
| resolve-shape | Measured proof and original placement intent, still no commit | Snap OFF; derive actual targets from measured grid, original anchor and relative shape; recheck current collisions and monitor fit | No-fit cancels without metadata/history change; no shape scattering or old-icon movement |
| reveal-place-rest | Final resolved target plan and rollback identities | Reveal remaining selected subset; normal guarded batch positioning | Full old guard plus exact selected targets |
| restore-verify | Snap restore intent | Standard final grid checks, snap ON, full exact verification | Only then may existing commit permission / receipt protocol proceed |
| commit/release | Durable metadata permit and committed receipts | Commit metadata/history once, release lease; only successful proof can become cache evidence | Cache bound to Explorer/geometry; restart invalidation rules remain |
| abort/recovery | Last durable phase, original states and revealed subset | Confirm failed helper stopped; watchdog identity-bound rehide selected subset, verify disappearance and old icons, restore flags | Uncertain termination or old-state mismatch stays unresolved. No blind toggle, duplicate mutation or old-position repair |

For resident source-to-Desktop moves, exact rename/rollback identity records must also be integrated with this state table; this document does not authorize a second competing transaction owner. Interrupted calibration must never grant metadata commit. Test every phase boundary, timeout, probe replacement, foreign patch entry, Explorer restart, no-fit, and post-commit recovery independently before enabling unknown-grid lease mode.


## Concrete code mapping for a test-only v2 prototype

No code changes authorized by this section. Do not implement one long calibration RPC. Keep production/main routing disabled. Initially support only same-path hidden files, not the separately developed resident archive transaction.

### Current constraints

- `lib/desktop-snap-lease-controller.js::validateScope` requires the target area's grid. Introduce a distinct test-only validator, not a relaxation of existing known-grid validation.
- `scripts/snap-lease.ps1::Lease-ValidateRecovery` requires all targets resolved and their count equal to records. Unknown calibration recovery must have a distinct v2 validator that permits unresolved targets only for abort.
- `Lease-SetSnap` invokes `Lease-AllGrid` before ON. Calibration requires a separate gate proving all OLD icons on measured grids with exactly one identified probe allowed off-grid inside its reserved patch. Reuse native `OkibaFolderView.SetLeaseSnap`, which verifies all current identities/positions/flags before toggling. Do not weaken the ordinary gate.
- `Lease-MarkRestored` seals the terminal restore state and prohibits subsequent OFF. Calibration ON is not terminal restoration; never call this marker during calibration.
- `lib/desktop-lease-watchdog.js::restart` currently re-adopts ordinary recovery. An interrupted unknown v2 scope needs abort-only adoption, never unverified resumption or commit.
- Ordinary helper timeout is approximately 15 seconds, while fixed adaptive takes over 21 seconds. Watchdog owner polling is queued behind native requests. A single long RPC both times out and delays owner-death processing. Use bounded sample-sized RPCs, owner checks between them, and keep native waits unchanged.

### Proposed durable v2 fields

`version:2`, `kind:'samepath-hidden-unknown-grid-ci'`, authenticated token/owner PID+birth, original Desktop/session/Explorer identity, original flags, immutable full old snapshot, complete selected records (canonical path, file ID, size, mtime, original attributes/Hidden), metadata paths and eventual receipts, target area index, unresolved original placement intent (drop anchor and selected relative offsets), guarded patch/maxSpacing, probe record identity, calibration subphase, and optional validated proof/resolved targets.

`targets` may be absent only while the v2 recovery is abort-only. Keep raw original snapshot immutable; measured grid/proof belong in separate fields or a separately validated resolved snapshot. Probe identities must refer to one selected record. Never accept arbitrary caller-supplied pitch/origin as proof. Every selected record is preserved from prepare onward, so recovery need not trust whether the last mutation reply was delivered.

### API and durable transitions

| Watchdog API / native command | Phase written before mutation | Required result |
|---|---|---|
| prepareUnknown / leasePrepareUnknown | unknown-prepared after native read-only prepare, global reservation acquired first | v2 recovery persisted before any reveal |
| revealProbe / leaseRevealProbe | probe-reveal-intent | OFF, probe-only reveal, old guards, exact bounded patch position; others hidden |
| beginCalibration / leaseBeginCalibration | probe-snap-intent | dedicated old-grid/probe-exception gate; ON, fixed settling, old exact; not terminal restored |
| calibrationSample / leaseCalibrationSample | calibrating before first sample | owner alive, query bounds/previous position checked, strict old/geometry/flags guards, existing fixed settling; one bounded sample per RPC |
| resolveCalibration / leaseResolveCalibration | resolve-intent | full candidate-search/evidence verification, actual grid and original shape plan, no-fit cancellation; no metadata permit |
| adopt resolved plan | resolved | journal stores verified proof/targets before the next mutating RPC; native state and durable recovery agree |
| placeRemaining / leasePlaceRemaining | remaining-reveal-intent | OFF, remaining reveal, normal guarded batch exact placement |
| restore/verify, commit permission, receipt/release | placed, restored, existing permitted/committed/released | existing terminal protocol only after full exact verification |
| abortUnknown / leaseAbortUnknown; adoptUnknownForAbort | aborting | original selected Hidden restored, all selected disappeared, all old exact, original flags verified; then terminal abort/release |

Adaptive query selection can run in a test controller, but native/watchdog validation must not trust its conclusion. Validate the full observations and state binding independently before resolving targets. Retain full candidate discrimination: the documented doubled-pitch counterexample rules out replacing it with a DPI hypothesis.

No per-sample fsync is required to continue an interrupted calibration, because interrupted calibration is never continued: durable `calibrating` state always recovers by abort. The original records/flags/old snapshot must already be durable. Proof and resolved targets must be durable before remaining-file mutation. A lost result between native validation and journal update remains abortable from the original records.

### Owner death, timeout and cleanup

Check pinned owner PID/birth before every sample and between queued calls. The existing 500 ms watchdog poll must remain able to run between short requests. Live-owner IPC disconnect is not permission to roll back. Confirm owner exit, or explicit abort, before recovery. If a sample times out, first confirm the old helper stopped; only then start a fresh helper and adopt v2 for abort. No second mutator while termination is uncertain.

Recovery re-reads every selected record identity/metadata. Rehide any revealed selected item using handle-bound operations, including a probe whose last coordinates are unknown; already-hidden records remain unchanged. Verify disappearance and every old identity/coordinate before restoring original flags. If the state is already original ON, verify rather than toggle. If OFF, prove old grid exact before restoring ON. If foreign state or identities prevent proof, leave the transaction unresolved with diagnostics rather than perform blind restoration. No metadata/history/cache changes before permission. Never repair old icon coordinates to hide failure.

### Implementation ownership and isolation

Potential new test-only files: unknown-v2 controller/validator and unit tests, a hosted-only driver/owner host, dedicated unknown-v2 PowerShell extension, and an independent workflow. Build a disposable copy of the needed library/scripts and apply checked anchors there; normal sources/main remain untouched and default-off. Gate entry with all three hosted-Windows environment checks plus an explicit unknown-grid CI flag. Reuse the single global lock, dedicated helper and watchdog; do not start an ordinary mutating calibration helper beside it.

Relevant integration points are controller validation/flow, client adapter methods, watchdog dispatch/journal/restart/rollback routing, and native lease request dispatch/recovery guards. Coordinate ownership before any edits to these shared files, especially the resident path. Do not blend resident rename recovery into the first unknown-grid prototype.

### Required first hosted CI cases

Success with original shape preserved; no-fit abort; occupied patch refusal before reveal; owner kill immediately after reveal, after calibration ON, mid-sample, and after proof before remaining reveal; helper hang and confirmed restart; lost replies; old icon or foreign patch changes; wrong flags; global lock contention. Assert no leaked snap-OFF state, unchanged old identities/coordinates, original selected Hidden/metadata/content after abort, unchanged metadata beforeHash without commit, expected receipt after success, terminal journal and cleanup. Preserve single-monitor versus true 150% evidence boundaries. Standard hosted 100% tests do not prove empty mixed-DPI monitor support.


### Initial prototype slice saved (not yet a native CI pass)

New research-only files: `tools/unknown-grid-lease-flow-ci.js`, `tools/unknown-grid-lease-flow-selftest.js`, `tools/unknown-grid-lease-copy-ci.js`, and `tools/unknown-grid-lease-native-ci.ps1`. The builder changes only an owned empty temporary copy of lib/scripts. It does not edit or launch the original runtime. The first slice supports prepare, probe reveal, calibration ON, one fixed-settle sample per RPC, and abort/release. Resolved-plan placement/commit and the hosted orchestration/fault driver are still unimplemented.

Pure mocks cover journal-before-mutation ordering, invalid phase, owner exit refusing further samples, lost reply preserving recovery intent, payload token override prevention, and refusal to release the global lock if native release is unverified. Generated-copy JavaScript and PowerShell parse successfully; native extension has not been executed locally or validated in hosted CI yet.

Prepare is strictly read-only with respect to Desktop/files: identity and snapshot checks plus helper-local state creation only. A transport-uncertain prepare can release reservation only under that guarantee and after the native adapter's confirmed-stop/restart handling; no reveal, flags or position mutation is allowed in prepare. Later uncertain mutations retain their durable intent and are recovered by abort. Abort marks restoration attempted before native recovery; fresh-helper abort-only adoption applies the existing conservative restoration-state check rather than blindly toggling snap after a lost restore reply.

### CI fixture recovery follow-up (9815690)

The first hosted run failed in the copy destination guard before creating the observer or executing any of the four native cases (empty events array). Canonical TEMP had a long path while the destination retained a Windows 8.3 alias. Both existing paths are now canonicalized, all owned components must have the dedicated prefix, the canonical parent must match, and junction/symlink and nonempty-copy checks remain. Cleanup uses the same guard. Pure alias/escape regressions are wired into the workflow.

Owner-death cases now pin the watchdog birth before terminating the owned owner process, then require watchdog and all reported helper PID/birth pairs to exit after the terminal journal and before checking or cleaning owned files. Unconfirmed termination sets unsafe and withholds cleanup.

Conservative abort limitation: restoreAttempted is persisted before the abort RPC. If that RPC fails before even its read-only validation, an adopted OFF state can be blocked because the persisted state cannot distinguish an unexecuted read from an attempted restoration. This is an explicit fail-closed limitation, not a successful recovery. Calibration ON itself does not set restoreAttempted or restored.

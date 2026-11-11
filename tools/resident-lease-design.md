# Resident-to-Desktop staged lease extension (NOT ENABLED)

## Status and scope

This is an engineering design, not a claim that resident moves use the new lease.
`desktop-resident-move.js` and `resident-rename-native.cs` remain disconnected from
main/watchdog. Existing legacy reservation continues to protect the old route.
Initial scope: regular, single-hardlink files; local same-volume paths; source
outside the entire Desktop tree; destination a direct Desktop child; known grid.
Directories, reparse ancestors, UNC/ADS paths and cross-volume moves are excluded
from this first extension. Unsupported routes retain their explicit legacy path.

## Findings from isolated TEMP experiments

* A directory handle opened only with FILE_READ_ATTRIBUTES did **not** prevent
  another actor from renaming the destination parent. Pin every ancestor with
  FILE_LIST_DIRECTORY | FILE_READ_ATTRIBUTES and without FILE_SHARE_DELETE.
  With that change, source/destination parent rename was rejected in the fixture.
* The source handle requests DELETE | FILE_READ_ATTRIBUTES, shares read only and
  validates volume/file ID, size, last-write and attributes. A competing source
  replacement, rename and writer are rejected while the ticket is held.
* FileRenameInfo with ReplaceIfExists=false rejects a destination created after
  the ticket opens. Source content and destination occupant remain intact.
* NORMAL is a representation of no other attributes. Hidden must compare against
  `attributes & ~NORMAL`, and restore an empty attribute set as NORMAL.
* Native rename of a Hidden-only file returned attributes=Hidden while the handle
  remained open; after closing, the fixture observed Hidden|Archive with unchanged
  ID/size/mtime. Current native code correctly refuses the stale expected record.
  **Production reconciliation of this Archive transition is not implemented.**
  The test's explicit fresh record is fixture-only, not permission to silently
  rebaseline a user's file. Before integration, either stabilize/capture the
  authorized transition while retaining a trustworthy handle or explicitly
  journal an allowed Archive-add transition after pin identity/content-metadata
  verification. Do not ignore arbitrary attribute differences. Restore original
  attributes only on rollback of our exact file.

Local results: 16 pure state-machine checks; 20 native TEMP checks (including the
Archive characterization). No actual Desktop operations. Cross-volume native
rejection and full process-death staging recovery are not yet exercised.

## One authoritative transaction, not nested independent transactions

The Node watchdog owns the global Desktop reservation, original Shell state,
source records, every staging intent, native helper lifecycle, receipt gate and
all recovery decisions in one fsynced journal. Never begin the old `stage()` and
only afterwards acquire the visual lease. Creating a supposedly hidden file on
Desktop can expose it if the user enables Show hidden items concurrently.

Proposed stages:

1. Acquire global pipe and durable pointer. Pin owner and exact Explorer session.
2. Read/validate all sources, source/destination ancestors and absent targets.
   Capture original attributes plus native identity, volume, size and mtime.
   Validate unchanged old icons, exact grid, snap ON and auto-arrange OFF.
3. Persist full `resident-prepared` recovery before any mutation. Native prepare
   must accept future destination records rather than requiring files on Desktop.
4. Guard old icons/session/flags and change only snap-to-grid OFF. Journal the
   intended transition first. Unknown outcome requires old helper stop confirmed
   before adopt/recovery; never overlap two writers.
5. For each file: persist hide intent; set Hidden on the exact pinned source;
   persist hidden state; persist rename intent; handle-based no-replace rename;
   verify actual destination identity and source absence; persist moved record.
6. While snap remains OFF, reveal/place all selected files using the official
   multi-item API. Verify exact desired positions and every old icon unchanged.
7. Verify all old icons still satisfy their original grids, unchanged geometry,
   flags and selected records. Restore snap ON; verify all selected exact again.
8. Durable prepareCommit receipt gate; main atomically changes board metadata.
   Native release requires expectedOutcome=visible and a fresh exact/record guard.
   Final receipt recheck precedes global release. No source deletion in same-volume
   case, no board write from the native adapter.

## Hidden visibility policy is not a lock

Use official live Shell state and view flags, not a registry preference alone.
Read it immediately before staging and at each guard. Its visibility result is
not a guarantee it will remain unchanged during filesystem mutation. Snap must
already be OFF before a staged destination can appear, regardless of Hidden.
The desired claim is: changing visibility cannot displace existing icons because
no snap/auto-arrange insertion is enabled; exact old positions are guarded across
all steps. **This claim still needs a hosted native race fixture**, including
Show hidden enabled just before rename and immediately after rename. If Explorer
moves old icons despite snap OFF, do not deploy this extension on that basis.
Do not write old coordinates back to make the test pass. User changes that add or
remove other visible old items invalidate the lease rather than being inferred.

## Rollback and failure behavior

Before receipt permission, recover only our pinned/recorded files. Keep snap OFF
while hiding selected destinations and moving them back. A source name occupied
by any file, replaced destination, unknown metadata, reparse/ancestor change or
unconfirmed helper shutdown is blocked, never overwrite or guessed cleanup.
Persist intent before each reverse rename and attribute restoration. Verify the
original source record, original attributes and no destination residue. Only then
restore snap under exact old-grid/session checks. Original positions are never
written. After permission, follow receipt outcomes, not an automatic source move:
owner alive waits/verified all-after finalizes; owner exited all-before rolls back;
all-after keeps destination; mixed/unknown blocks. Durable staged records are
required so watchdog/helper death between rename and reply is resolvable by ID.

## Cross-volume follow-on (not implemented)

Keep the same reservation/snap-OFF promotion boundary. Copy into an owned hidden
staging area away from Desktop, verify source/copy with the existing cross-volume
transaction, then same-volume no-replace promote the verified copy onto Desktop.
Retain source or same-volume source backup until metadata permission/commit is
confirmed. Durable journal must describe copy, stage, promotion and source backup
identities separately. Rollback must never delete an unverified destination or
source replacement. Large-file verification remains outside the short snap-OFF
window where possible, with source identity/mtime revalidated before promotion.
Cross-volume cleanup after commit is separate from visual release; warnings retain
recoverable backups rather than trigger a second metadata rollback.

## Required gates before main integration

* Resolve and test authorized Archive-add semantics, including rollback to NORMAL.
* Use a same-handle Hidden setter with exact identity/metadata validation.
* Test destination parent substitution, reparse races, hardlink additions and
  different-volume refusal using owned TEMP/native fixtures.
* Hosted-only Desktop tests: user visibility toggles, new file arriving, partial
  stage, lost native response, helper timeout/kill, owner death at each intent,
  occupied original source, board metadata races and restored settings.
* Preserve old Desktop identity/coordinates and main board layout in every test.
* Keep unknown mixed-DPI and unproven source types off this new route until their
  independent proof exists. Measure warm and cold time separately.

## Follow-up: bounded receipt prototype, not automatic reconciliation

`MoveWithReceipt` now closes the rename handle, reopens the destination with a
same-ID guard handle, pins all ancestors again, and verifies ID/volume/size/mtime.
It accepts as *observed evidence* only identical semantic attributes or an
Archive-add (NORMAL representation ignored). Every other difference throws.
The receipt preserves `before`, `after`, `originalAttributes`, `archiveAdded`
and `attributeReconciliationRequired`. The latter MUST block automatic rollback
attribute restoration when true; observing an allowed-shaped difference does not
prove which actor set it. A crash before receipt persistence still has the durable
rename intent and original record, so recovery can locate the exact file but must
not silently clear Archive based on a fresh record.

`RestoreAttributesForFixture` verifies the expected current record and updates
attributes via the same handle. The TEMP test rejects a preexisting third-party
ReadOnly edit and leaves it untouched. However, Windows provides no attribute
compare-and-swap: an attribute-only actor may modify flags between comparison and
write despite ordinary sharing exclusions. Therefore this method is explicitly
fixture-only, NOT the production adapter. It must not be wired into watchdog as
an unconditional automatic reconciliation mechanism.

24 isolated native checks currently pass. The safe initial extension can reject
or remain on the legacy route for initial files lacking Archive before staging,
if approved, because that avoids this particular rename-close Archive transition.
This is a scope restriction, not a general solution to concurrent attribute edits.
Automatic restoration under arbitrary concurrent flag changes remains unproven;
keep those cases blocked and preserve original/effective records for diagnosis.

## Archive-initial phase coordinator prototype

New `desktop-resident-lease-prototype.js` is deliberately disconnected. It embeds
`resident.inner` intents in the same outer persist callback, never a second
journal. Archive-absent/unsupported files return `unsupported, mutated:false`
before snap OFF and release the reservation, so a future caller can use its
existing legacy route rather than silently dropping the operation.

Required native adapter phases (not implemented in the production helper):
`prepareFutureDestinations` (read-only, sources still in board),
`disableSnapGuarded`, source handle-bound Hidden and no-replace move,
`revealPlace`, `restoreAndVerify`, `verifyRestoredExact`, and
`restoreOriginalAfterRollback`. `ensureRollbackOff` must distinguish an original
OFF interval from an already attempted/verified ON restoration: unexpected OFF
after restoration is an external/unknown setting change and must stay blocked.
Every current future-destination adapter is mocked. Native owner handles,
helper stop/adopt, session lifetime, actual Shell visibility races, and durable
receipt hashing remain responsibilities of the production watchdog integration,
not claims established by this pure prototype.

16 pure phase checks cover original Archive and Archive|Hidden; lost OFF, first
and second rename, placement and restore replies; journal write failure; source
name occupied by a different file; original NORMAL/dirs/reparse/cross-volume
unsupported; unexpected OFF after restore; no rollback after receipt permission;
and verified commit. No filesystem or Desktop writes occur in these tests.

Follow-up native TEMP result: 28 checks pass, including explicit initial attributes 32 and 34 round trips with no Archive reconciliation required. These remain fixture-only attribute writes, not an atomic concurrent-user attribute guarantee.

## Proposed native integration contract: one batch intent

Awaiting review; no production API is changed by this document.

New scope kind: `resident-archive-samevolume`. Items use `path` as source,
`destination` as future Desktop path, and source native `fileIdentity`.
Targets always name the destination. Keep old samepath kind/version behavior
unchanged. Resident recovery version 2 carries immutable `residentRecords` with
source/destination, native ID, volume, size, mtime, original attributes and pinned
ancestor identity expectations. Preserve one consistent native ID format: the
prototype's textual ID must not be assumed equal to OkibaFileAttributes' format.

A single fsynced reveal-intent for the whole batch suffices to locate unfinished
rename effects if the following locator is strict and the original file had one
hard link. Inspect BOTH names for every record, not just the first one found:

| Source | Destination | Result |
| --- | --- | --- |
| own ID + allowed metadata | absent | Unmoved; Hidden may have been set |
| absent | own ID + allowed metadata | Moved; Hidden may be set or cleared |
| own or foreign file | own or foreign file | blocked, never overwrite either |
| absent | absent | blocked, do not search or infer a new location |
| foreign ID or changed size/mtime/other flags | anything | blocked |

At initial prepare/reveal entry, source attributes must equal the expected
original state and destination must be absent. During adopt, only Hidden differs
from original 32/34; Archive must remain present. Validate single-link status,
all ancestor constraints and same volume each time a rename ticket is opened.
Do not mutate an initial readonly prepare. Source/native record and receipt scope
must be persisted before calling reveal. Returned helper diagnostics can list
per-file progress, but recovery must not rely on receiving that response.

Keep two separate notions in native code: destination projection for the Shell
old/new icon guard, and the locator result for filesystem integrity. Existing
Lease-ValidateRecovery assumes each destination exists, so it must not be reused
unchanged for resident preparation/adoption. Reject duplicate IDs and duplicate
source/destination paths across the whole batch, including cross-item aliases.

`leaseRevealPlace`: verify owner/session/baseline, OFF first; then handle-bound
Hidden update + no-replace rename for each source. Parent pins remain live across
the mutation. Check source ID/metadata/flags and current settings immediately
before each mutation; inspect all pairs and full old snapshot after the batch.
Only then use existing official arrival and exact multi-PIDL placement logic.
Show-hidden policy changes are never treated as proof that a hidden new file
cannot become visible; the OFF-before-promotion invariant is essential.

`leaseAdopt`: validate full durable source records and restorationState from the
current settings-phase implementation. Locate partial progress without replaying
reveal. Do not manufacture new per-file intent records from current filenames.

`leaseRollback`: moved items are hidden and renamed back without replace. Unmoved
items ALSO need original Hidden restored because failure may occur after hide but
before rename. Original source occupied is blocked even if our destination ID is
still intact. If restore was already attempted/verified, unexpected current OFF
must stay blocked; do not reset that state merely to facilitate rollback. When
already ON, consider removing/hiding own destination items without creating a new
OFF epoch, since this rollback never inserts a new Desktop file; this still needs
hosted testing. Otherwise preserve the original OFF epoch until exact old/grid
checks allow original flags restoration.

`leaseRestoreVerify` and visible `leaseRelease`: require every pair Moved, source
absent, destination native record intact, all selected visible/exact, old icons
unchanged and original flags ON. Post-release receipt checks remain mandatory.

New release outcome `source-restored` for resident abort: require every source own
ID with original attributes, every destination absent, no selected Desktop icon,
old icons exact, original flags ON. Existing `hidden` outcome continues to mean
samepath files still exist on Desktop but are hidden. Never conflate the two.
Watchdog chooses only this final outcome by kind; global reservation, owner pin,
stop-before-adopt, restorationState, receipt gate and all-before/all-after rules
remain shared.

Required hosted tests before enabling: partial stage after first hide/first and
last rename, response loss, helper kill/hang, owner death, source reoccupation,
destination substitution, no-pair/double-pair states, original Hidden true/false,
show-hidden toggled during OFF, receipt before/after/mixed, and external OFF after
verified restoration. Every test retains old PIDL+coordinates, original source
contents/attrs and board metadata evidence. No old icon coordinate write-back.


## Native initial implementation review checkpoint

The resident v2 PS/native branch now exists but main does not select it. Its
`Resident-ReleaseSources` makes two passes of full Shell snapshot/old verification,
source/destination record classification and grid/flags checks. These observations
are not a globally atomic filesystem + Shell transaction: an external user can act
after the last file check/snapshot. The release response reports verified samples,
not immunity to later user actions. No implementation may undo such external edits.

Source preflight rejects CommonDesktopDirectory and all baseline-visible old paths
or their descendants before native mutation, not only the user's Desktop tree.
Native canonical path equality rejects short-name/alternate-path aliases rather
than silently resolving them; reparse ancestors and multi-hardlink files remain
unsupported. The samepath v1 branch and legacy fallback are retained.

Hosted resident fixture currently defines nine scenarios: success from attributes
32/34, abort before/after ON restoration, failure after first hide, failure after
first rename, helper hang after first rename with confirmed stop/fresh adopt,
owner death after placement with automatic source recovery and both independent
processes exiting, and source reoccupation rejection. These definitions have NOT
been executed at this checkpoint. Show-hidden transitions and cached-destination
collision need their own hosted evidence before deployment.

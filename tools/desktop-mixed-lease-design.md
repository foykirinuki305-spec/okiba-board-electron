# Mixed lease prototype (not connected or packaged)

Scope: known-grid same-path Hidden links plus same-volume resident regular files,
original attributes 32/34. Cross-volume, folders/reparse, unknown grids remain
outside this prototype. Existing routes are not changed or declared safe by it.

## Contract

One global Desktop reservation, one authoritative watchdog journal, one snap-OFF
epoch, one group placement, one receipt permission. Never split by item mode into
separate transactions. The prototype plan checks unique native identities/paths,
complete destinations and exact relative cell offsets. Native prepare must still
revalidate the entire physical geometry, parent chain, files, old icon identities,
target boundaries and occupancy. A successful pure plan is NOT native permission.

Immutable per-item recovery:
- hidden-link: original same path, FileID, size/mtime, original attributes, Hidden.
- resident-file: original source/destination, FileID, size/mtime, attributes 32/34,
  both ancestor-chain keys, single-link same-volume proof.

Proposed native operations (not implemented):
1. prepareMixed(scope): read-only full validation and recovery records.
2. revealMixed(token): journal off-intent before OFF; native old/flags guard;
   resident stage no-replace; reveal all selected; one exact group positioning.
3. restoreVerifyMixed(token): existing restoration-state rules; entire group
   exact and all old unchanged before and after restoring original snap.
4. rollbackMixed(token): only before permit. Stop old helper first if uncertain.
   Locate resident IDs at both names; rehide samepath links; restore resident
   source with no-replace and original Hidden. Never restore old icon positions.
   Verify ALL sources/attrs/old icons before final ON and terminal release.
5. releaseMixed(token, outcome): visible success checks all selected destinations
   plus resident source absence. Aborted checks link Hidden and resident source
   restored/attrs; no partial subgroup terminal.

Permit-intent is the conservative boundary: reply loss may mean permission exists.
After it, ordinary rollback is forbidden. Existing owner-handle/receipt authority
resolves all-before, all-after or blocked. No source or metadata guesses.
A restore already attempted/verified followed by external OFF remains blocked,
not a new OFF epoch to overwrite the user's setting.

Metadata: parse raw before bytes; remove only selected link records and resident
position keys, retaining every other field. One before/after receipt and pinned
metadata identity, no bf.saveBoard reconstruction. Main/history/renderer wiring
is NOT implemented here.

## Required isolated hosted native matrix before any integration

- 1 link + 1 resident and 3+3, vertical/horizontal offsets, dense cached destination.
- ShowHidden already ON / switched after first resident stage; old icons unchanged.
- Death before OFF, after first stage, during partial reveal, after full placement,
  after ON, before/after metadata receipt, acknowledgement lost.
- Own selected changed/hardlink/source reoccupied/parent replaced: block safely.
- Existing icon identity or position changes: block, never write it back.
- Helper hang: confirmed stop, fresh helper adopt every item, one global lock held.
- Both rollback orders and mixed attrs32/34, no success unless whole group verified.
- GUI raw unknown fields and all remaining cells unchanged; one history group.

Current evidence: pure plan/metadata/phase checks only. No native mixed command,
no main route, no production dispatch or default activation.

## 8f9 rollback visibility observation and notification hypothesis

The first mixed success completed, but the next abort restored all three resident
files through native handle rename while Shell still enumerated their old Desktop
paths. Trace showed selected indices 3,4,5 on 73 polls; link indices 0,1,2 disappeared.
Native visibility wait failed after approximately 16 seconds. The subsequent OFF
adoption refusal is a conservative result of prior durable restore-attempt, not a
reason to weaken that guard.

Next CI-only change: after a successful RestoreMoved, independently locate the
pair again (original source owns exact ID/size/mtime/ancestor proof and original
attributes, destination absent). Only then send SHCNE_RENAMEITEM with old Desktop
path and new original source path. No notification for an unmoved item, uncertain
native outcome, occupied old path, changed attributes, or unknown locator error.
The official SHChangeNotify contract describes notifications of actions the app
actually performed. PATHW plus FLUSH delivers this two-path event; it does NOT
prove Explorer visibility completion. All old-position and final visibility checks
remain required. No Refresh, synthetic DELETE, or existing-icon repositioning.

Reference verified 2026-11-11:
https://learn.microsoft.com/en-us/windows/win32/api/shlobj_core/nf-shlobj_core-shchangenotify

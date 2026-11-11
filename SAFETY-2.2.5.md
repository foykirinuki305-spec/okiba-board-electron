# 2.2.5 — recognizable previews and safe Desktop returns

## Scope

Board cell geometry and the v6 data format are unchanged. Images/videos fit their
existing preview slots; normal files use Windows icons. Shortcuts are inspected
read-only for their target/custom ICO or default executable artwork. DLL resource
indices remain unsupported, with a target icon fallback.

Desktop returns have a separate strict path. Explorer-folder drops and board
intake keep their existing behavior. A group retains its relative board cells.
A drag that would overlap existing icons or leave the usable Desktop is cancelled
before files are moved, rather than wrapping, clamping or shifting the group.
Menu take-out chooses a free anchor for the same shape. The app does not turn off
Windows auto-arrange or change the user's Desktop settings on their behalf.

Only the newly returned icons are positioned. Existing icons are checked, never
forcibly restored over a user's concurrent changes. Ambiguous/changed state stops
the transaction. A helper whose termination cannot be confirmed is not raced by
a rollback; recovery locations are reported instead.

Same-volume moves use native no-replace semantics. Cross-volume regular files and
folders use verified copies, retaining the original until placement succeeds and
metadata can be committed. Failed or changed copies are not blindly deleted.
Special reparse objects and unavailable safe staging locations stop conservatively.

## Verification policy

All local GUI tests redirect board data, profile, Desktop, Downloads and shortcut
paths to fixtures. Unpackaged builds cannot run automatic cleanup without explicit
redirected cleanup folders. Actual Explorer placement tests are restricted to a
disposable GitHub-hosted Windows runner; never run them on the user's Desktop.

Upgrade tests cover saved v6 resident/link/note cells, two board sizes, home order
and theme, opening/closing and restart. Only the home application-version marker
may change during that fixture upgrade.

Final test results, exact CI revision and artifact hashes are recorded separately.

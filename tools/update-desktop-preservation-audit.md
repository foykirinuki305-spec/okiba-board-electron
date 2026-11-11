# Update and Desktop preservation audit

Read-only audit of current source; no real Desktop action performed.

## Fixed in this change

- `main.js:runVersionCleanup` now only stamps `.home.json.appVersion` through `saveHome`, preserving saved positions/theme/unknown home fields. It does not enumerate Desktop/Downloads, delete files, or replace shortcuts.
- `lib/cleanup.js:planCleanup` is an inert compatibility API returning empty action lists.
- Pure tests exercise the actual startup function with filesystem/Shell access forbidden. GUI regression now requires all redirected Desktop/Downloads fixture bytes and mtimes unchanged across update/relaunch.
- `renderer/app.js:buildCells` preserves existing saved cells; only missing cells are appended. No startup call to `persistBoard` was identified. Explicit user drag/size changes still save normally.

## Remaining guarantee gaps (not changed)

1. **Remove link:** `main.js` IPC `unlink-items` calls `lib/links.js:removeLinks -> removeLink -> unhideIfOrphaned`. Metadata is saved first, then `attrib.setHidden(path,false)` is called without the new snap lease/global reservation. When the path is on Desktop, Explorer may restore a cached position and displace existing icons before any verification. This is distinct from safe drag-out.
2. **Trash board:** `main.js` IPC `trash-board` trashes the board directory, then calls `releaseBoardLinks`; that also directly unhides orphaned originals. Failures are swallowed. There is no all-old-icon proof or transactional metadata rollback.
3. **Default drag-out remains the previous implementation:** `leaseOptIn` is test-only and defaults OFF. The ordinary `safeDesktopMove -> executeDesktop` path can reveal arrivals before verifying placement. The new research does not make this shipped path safe merely by existing in the repository.
4. **Explicit create-board-shortcut:** the existing user-invoked action can create/overwrite a same-name `.lnk`. It is not update cleanup and was not changed. No promise that arbitrary shortcut creation cannot affect Explorer layout.
5. **Installer-owned app shortcut:** NSIS `createDesktopShortcut: "always"` is unchanged, per the existing installer contract. Ordinary replacement of the installed app is supported, but this audit does not prove the installer preserves that shortcut's Explorer coordinate. Installer CI is required; app-startup preservation must not be described as a full installer/Desktop guarantee.
6. Existing `saveBoard` and renderer `persistBoard` reconstruct known board/link fields on explicit edits. This audit did not broaden data-schema preservation beyond the update stamp. Existing v6 saved coordinates remain unchanged on ordinary load/render in source and the upgrade-layout fixture.

## Scope and next step

Do not silently change unlink/trash behavior, introduce automatic old-icon restoration, or claim every Desktop mutation is protected. A future dedicated change should bring removal/deletion visibility release under the same guarded transaction (or clearly block unsupported cases) before expanding the guarantee. For now, report these exclusions with the deliverable. No further UI/deletion behavior change is included here.

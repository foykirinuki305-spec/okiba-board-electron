'use strict';
/*
 * Auto-cleanup of old versions on update (v2.2.1, Job 2).
 *
 * The user installs every new version from a chat-delivered
 * installer, so loose copies pile up: portable OkibaBoard.exe and
 * OkibaBoard-Setup-*.exe files in Desktop / Downloads, plus stale
 * .lnk shortcuts pointing at them. He can no longer tell which one
 * is current (「アプデしたらどれが最新か分からない」).
 *
 * The NSIS installer already replaces the installed body in place,
 * so this module only deals with the LOOSE files. The decision
 * logic is pure and unit-tested here; main.js does the scanning
 * (fs.readdirSync + shell.readShortcutLink), the execution and the
 * okiba.log lines.
 *
 * Rules (exact-name matches only, non-recursive, never folders):
 *   - a file named exactly `OkibaBoard.exe` in Desktop/Downloads is
 *     deleted, EXCEPT when it IS the running process's own file
 *     (portable self-run must never delete itself);
 *   - a file matching `OkibaBoard-Setup-*.exe` is deleted (same
 *     execPath exception);
 *   - a Desktop .lnk whose target basename is one of the above AND
 *     whose target is NOT the running exe: if its args carry
 *     --board-path it is a board shortcut from an older build and
 *     is HEALED (target rewritten to the current exe, args/icon
 *     kept); otherwise it is a stale app shortcut and is deleted;
 *   - shortcuts pointing anywhere else, and shortcuts already
 *     pointing at the running exe, are never touched.
 */
const path = require('path');

const PORTABLE_NAME = 'OkibaBoard.exe';
const SETUP_PREFIX = 'OkibaBoard-Setup-';
const SETUP_SUFFIX = '.exe';

function isPortableName(name) {
  return name === PORTABLE_NAME;
}

function isSetupName(name) {
  return typeof name === 'string' &&
    name.startsWith(SETUP_PREFIX) &&
    name.endsWith(SETUP_SUFFIX) &&
    name.length > SETUP_PREFIX.length + SETUP_SUFFIX.length;
}

// A loose exe file name this cleanup is responsible for.
function isAppExeName(name) {
  return isPortableName(name) || isSetupName(name);
}

// Path identity, Windows-style: resolved + case-insensitive on
// win32 (mirrors lib/links.samePath), verbatim elsewhere.
function samePath(a, b) {
  if (!a || !b) return false;
  let ra, rb;
  try { ra = path.resolve(a); } catch (e) { ra = a; }
  try { rb = path.resolve(b); } catch (e) { rb = b; }
  if (process.platform === 'win32') {
    return ra.toLowerCase() === rb.toLowerCase();
  }
  return ra === rb;
}

// Cleanup runs once per version change: the stored marker (the
// base .home.json `appVersion`) differs from the running version
// (absent marker counts as different — a pre-v2.2.1 install has
// never cleaned up).
function shouldRunCleanup(currentVersion, storedVersion) {
  if (!currentVersion) return false;
  return storedVersion !== currentVersion;
}

/*
 * Pure decision: given full-path file listings for the two folders,
 * the Desktop shortcut table and the running exe path, decide what
 * to delete and what to heal.
 *
 *   desktopFiles:   [fullPath, ...] (files only, non-recursive)
 *   downloadsFiles: [fullPath, ...]
 *   shortcuts:      [{ lnkPath, target, args, icon, iconIndex, cwd,
 *                      description }] (Desktop .lnk read-backs)
 *   execPath:       the running process's exe
 *
 * Returns { deleteFiles: [path], deleteShortcuts: [lnkPath],
 *           healShortcuts: [{ lnkPath, args, icon, iconIndex, cwd,
 *                             description }] }
 * (the heal target is always execPath — main supplies it at write
 * time, so it is not repeated in the plan).
 */
function planCleanup({ desktopFiles, downloadsFiles, shortcuts, execPath }) {
  const deleteFiles = [];
  const deleteShortcuts = [];
  const healShortcuts = [];

  for (const p of [...(desktopFiles || []), ...(downloadsFiles || [])]) {
    if (!p) continue;
    if (!isAppExeName(path.basename(p))) continue;
    if (samePath(p, execPath)) continue; // never delete ourselves
    deleteFiles.push(p);
  }

  for (const s of shortcuts || []) {
    if (!s || !s.lnkPath || !s.target) continue;
    if (!isAppExeName(path.basename(s.target))) continue;
    if (samePath(s.target, execPath)) continue; // already current
    if (typeof s.args === 'string' && s.args.includes('--board-path')) {
      healShortcuts.push({
        lnkPath: s.lnkPath,
        args: s.args,
        icon: s.icon || '',
        iconIndex: s.iconIndex || 0,
        cwd: s.cwd || '',
        description: s.description || '',
      });
    } else {
      deleteShortcuts.push(s.lnkPath);
    }
  }

  return { deleteFiles, deleteShortcuts, healShortcuts };
}

module.exports = {
  PORTABLE_NAME,
  isPortableName,
  isSetupName,
  isAppExeName,
  samePath,
  shouldRunCleanup,
  planCleanup,
};

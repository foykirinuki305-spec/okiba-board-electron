'use strict';
/*
 * Per-board desktop shortcuts (v2.1).
 *
 * The spirit mirrors Deskboard: a board IS a folder, and pointing the
 * app at a folder opens it as a board. A board shortcut is just a
 * Windows .lnk whose target is the app exe with
 *   --board-path "<abs board folder>"
 * so double-clicking it launches (or re-focuses) the app directly
 * into that board. Writing the .lnk itself is main-process work
 * (shell.writeShortcutLink); everything here is the pure, testable
 * part: argv parsing, board-path validation, routing decisions and
 * shortcut file-name planning.
 */
const fs = require('fs');
const path = require('path');
const { BOARD_FILENAME } = require('./boardfs');

const BOARD_ARG = '--board-path';

// Parse argv for --board-path. Supports both
//   --board-path <value>
//   --board-path=<value>      (what our .lnk files carry)
// Returns { boardPath, malformed, flagSeen }: malformed means the
// flag was present but carried no usable value.
function parseBoardArg(argv) {
  const args = Array.isArray(argv) ? argv : [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === BOARD_ARG) {
      const v = args[i + 1];
      if (typeof v === 'string' && v && !v.startsWith('--')) {
        return { boardPath: v, malformed: false, flagSeen: true };
      }
      return { boardPath: null, malformed: true, flagSeen: true };
    }
    if (typeof a === 'string' && a.startsWith(BOARD_ARG + '=')) {
      const v = a.slice(BOARD_ARG.length + 1);
      if (v) return { boardPath: v, malformed: false, flagSeen: true };
      return { boardPath: null, malformed: true, flagSeen: true };
    }
  }
  return { boardPath: null, malformed: false, flagSeen: false };
}

// A path counts as a board when it is an existing directory that
// either contains our board json, or is a direct child of the base
// (every real board lives there; a freshly created board may not
// have a json yet). Returns the board NAME (folder basename — the
// key the rest of the app addresses boards by) or null.
function validateBoardPath(base, boardPath) {
  if (!boardPath || typeof boardPath !== 'string') return null;
  let resolved;
  try { resolved = path.resolve(boardPath); } catch (e) { return null; }
  let st;
  try { st = fs.statSync(resolved); } catch (e) { return null; }
  if (!st.isDirectory()) return null;
  const hasJson = fs.existsSync(path.join(resolved, BOARD_FILENAME));
  let directChild = false;
  if (base) {
    try {
      directChild = path.resolve(path.dirname(resolved)) === path.resolve(base);
    } catch (e) { directChild = false; }
  }
  if (!hasJson && !directChild) return null;
  return path.basename(resolved);
}

// One routing decision used identically at first launch and on
// 'second-instance': { boardName } to open a board directly,
// { invalidBoard: true } when a board was asked for but not found,
// or both null/false for a plain home launch.
function routeFromArgv(argv, base) {
  const { boardPath, malformed, flagSeen } = parseBoardArg(argv);
  if (boardPath) {
    const name = validateBoardPath(base, boardPath);
    if (name) return { boardName: name, invalidBoard: false };
    return { boardName: null, invalidBoard: true };
  }
  if (flagSeen) {
    // Chromium detaches a two-token "--flag value" pair when it
    // forwards a second instance's command line to the running app:
    // the flag arrives bare and the value reappears as a stray
    // positional argument (observed live: [..., '--board-path',
    // '--allow-file-access-from-files', <app path>, <board path>]).
    // Recover by trying every non-switch token as a board candidate
    // — only a real board folder validates, so the app path and
    // other positionals are rejected naturally.
    const args = Array.isArray(argv) ? argv : [];
    for (const a of args) {
      if (typeof a !== 'string' || !a || a.startsWith('-')) continue;
      const name = validateBoardPath(base, a);
      if (name) return { boardName: name, invalidBoard: false };
    }
    return { boardName: null, invalidBoard: true };
  }
  return { boardName: null, invalidBoard: malformed };
}

// ------------------------------------------------------ .lnk naming
// Board names are already validated at creation time, but a shortcut
// name is derived data — sanitize defensively anyway (the Desktop is
// shared space; never produce a surprising file name).
const INVALID_CHARS = '\\/:*?"<>|';
function sanitizeShortcutName(name) {
  let s = String(name || '');
  s = [...s].filter((ch) => !INVALID_CHARS.includes(ch) && ch.charCodeAt(0) > 0x1f).join('');
  s = s.trim().replace(/[. ]+$/u, '').trim();
  return s;
}

// Decide the .lnk file name on the Desktop for a board.
// probe(relName) -> 'dir' | 'file' | null describes what already
// sits on the Desktop under that relative name. Rules (user spec):
//   - a same-name .lnk may be overwritten (writeShortcutLink
//     'create' replaces it — it is ours to refresh);
//   - a non-.lnk entry is never overwritten;
//   - if a FOLDER carries the board's plain name, fall back to
//     "name (OkibaBoard)" so the shortcut doesn't sit confusingly
//     next to a same-named folder — and likewise if a folder is
//     literally named "X.lnk".
function planShortcutFileName(boardName, probe) {
  const clean = sanitizeShortcutName(boardName) || 'ボード';
  const candidates = [clean, clean + ' (OkibaBoard)', clean + ' (OkibaBoard 2)'];
  for (const c of candidates) {
    if (probe(c) === 'dir') continue;
    if (probe(c + '.lnk') === 'dir') continue;
    return c + '.lnk';
  }
  return clean + ' (OkibaBoard 3).lnk';
}

module.exports = {
  BOARD_ARG,
  parseBoardArg,
  validateBoardPath,
  routeFromArgv,
  sanitizeShortcutName,
  planShortcutFileName,
};

'use strict';
/*
 * Linked items (v2.0 "link + hide" model).
 *
 * A linked item is a file/folder that stays at its ORIGINAL absolute
 * path — the board only stores a reference in .okiba-board.json. To
 * make it visually disappear from its home location (the user's core
 * request: 「ボードに移動したら、デスクトップからは見た目的には
 * いなくなってほしい」) the app sets the Windows Hidden attribute on
 * the original while it is linked, and clears it again when the last
 * board linking that path lets go — but ONLY if the app set it
 * (an item that was already hidden before intake keeps its state).
 *
 * The Hidden attribute is toggled with the external `attrib` command,
 * behind a small runner interface ({ readHidden, setHidden }) so the
 * unit tests can inject a stub and count calls. The real runner fails
 * SOFT: any error (non-Windows platform, attrib missing, access
 * denied) is reported as { ok:false }, never thrown — intake and
 * unlink must never be blocked by the attribute.
 *
 * Path identity: Windows paths are case-insensitive, so links are
 * matched on the resolved, lower-cased path there; on other
 * platforms the resolved path is compared verbatim.
 */
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const bf = require('./boardfs');

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

// ------------------------------------------------------------ attrib
// attrib output looks like:
//     "A            C:\\Users\\x\\file.txt"
//     "     H        C:\\Users\\x\\hidden.txt"
// The attribute letters (A/R/S/H/I, space-padded) sit BEFORE the
// path, and the line ends with the exact path we asked about. So:
// attribute field = line minus the trailing path; Hidden is set
// iff that field contains an "H" (the field holds nothing else).
function parseAttribHidden(stdout, targetPath) {
  const line = String(stdout || '').split(/\r?\n/).filter((s) => s.trim())[0];
  if (!line) return null;
  const p = String(targetPath);
  let prefix;
  if (line.toLowerCase().endsWith(p.toLowerCase())) {
    prefix = line.slice(0, line.length - p.length);
  } else {
    const idx = line.toLowerCase().indexOf(p.toLowerCase());
    if (idx < 0) return null; // unexpected shape — do not guess
    prefix = line.slice(0, idx);
  }
  if (!/^[A-Z ]*$/i.test(prefix)) return null;
  return prefix.toUpperCase().includes('H');
}

// Real runner: shells out to attrib.exe. Both operations resolve to
// { ok, hidden? } and NEVER reject.
function createAttribRunner() {
  function run(args) {
    return new Promise((resolve) => {
      try {
        execFile('attrib', args, { windowsHide: true, timeout: 5000 },
          (err, stdout) => resolve({ err, stdout: stdout || '' }));
      } catch (e) {
        resolve({ err: e, stdout: '' });
      }
    });
  }
  return {
    // -> { ok:boolean, hidden:boolean|null }
    async readHidden(targetPath) {
      if (process.platform !== 'win32') return { ok: false, hidden: null };
      const { err, stdout } = await run([targetPath]);
      if (err) return { ok: false, hidden: null };
      const hidden = parseAttribHidden(stdout, targetPath);
      return { ok: hidden !== null, hidden };
    },
    // -> { ok:boolean }
    async setHidden(targetPath, hidden) {
      if (process.platform !== 'win32') return { ok: false };
      const { err } = await run([hidden ? '+H' : '-H', targetPath]);
      return { ok: !err };
    },
  };
}

// Stub runner for tests: keeps the "filesystem attributes" in a Map
// and records every call so tests can assert +H / -H happened the
// right number of times. readHidden reports the map state (an
// unknown path reads as not-hidden, like a normal file).
function createStubAttribRunner(initial) {
  const key = (p) => (process.platform === 'win32'
    ? path.resolve(p).toLowerCase() : path.resolve(p));
  const byKey = new Map();
  for (const [p, h] of Object.entries(initial || {})) byKey.set(key(p), !!h);
  const calls = [];
  return {
    calls,
    state: byKey,
    async readHidden(targetPath) {
      calls.push({ op: 'read', path: targetPath });
      return { ok: true, hidden: !!byKey.get(key(targetPath)) };
    },
    async setHidden(targetPath, hidden) {
      calls.push({ op: hidden ? '+H' : '-H', path: targetPath });
      byKey.set(key(targetPath), !!hidden);
      return { ok: true };
    },
    isHidden(targetPath) { return !!byKey.get(key(targetPath)); },
    count(op) { return calls.filter((c) => c.op === op).length; },
  };
}

function attribRunnerFromEnv(env) {
  env = env || process.env;
  if (env.OKIBA_TEST_ATTRIB === 'stub') return createStubAttribRunner();
  return createAttribRunner();
}

// ------------------------------------------------------------ registry
function saveLoadedBoard(folder, data, links) {
  return bf.saveBoard(folder, data.positions, data.notes, data.sizePercent,
    links !== undefined ? links : data.links);
}

// How many boards under `base` currently link this path?
function countLinksTo(base, targetPath) {
  let count = 0;
  for (const boardName of bf.listBoards(base)) {
    const data = bf.loadBoard(path.join(base, boardName));
    for (const l of data.links) {
      if (samePath(l.path, targetPath)) count++;
    }
  }
  return count;
}

// Find any board under `base` (optionally excluding one board
// folder) that already links this path, and return its record.
function findLinkAnywhere(base, targetPath, exceptFolder) {
  for (const boardName of bf.listBoards(base)) {
    const folder = path.join(base, boardName);
    if (exceptFolder && path.resolve(folder) === path.resolve(exceptFolder)) continue;
    const data = bf.loadBoard(folder);
    const found = data.links.find((l) => samePath(l.path, targetPath));
    if (found) return found;
  }
  return null;
}

// Register a link on one board. Does NOT move/copy anything.
// Returns { added, duplicate, attribOk, link }.
async function addLink({ base, boardFolder, targetPath, attrib }) {
  const data = bf.loadBoard(boardFolder);
  const existing = data.links.find((l) => samePath(l.path, targetPath));
  if (existing) {
    return { added: false, duplicate: true, attribOk: true, link: existing };
  }
  // wasHidden = "Hidden was set BEFORE THE APP first touched this
  // path", so the last unlink can restore exactly the pre-intake
  // state. If another board already links the path, inherit THAT
  // record's wasHidden — the attribute may currently be on only
  // because WE set it from the other board, which must not be
  // mistaken for a pre-existing user setting.
  const prior = findLinkAnywhere(base, targetPath, boardFolder);
  let wasHidden;
  let attribOk = true;
  if (prior) {
    wasHidden = !!prior.wasHidden;
  } else {
    wasHidden = false;
    const read = await attrib.readHidden(targetPath);
    if (read.ok && read.hidden !== null) wasHidden = read.hidden;
    else if (!read.ok) attribOk = false;
    if (!wasHidden) {
      const set = await attrib.setHidden(targetPath, true);
      if (!set.ok) attribOk = false;
    }
  }
  const link = { path: targetPath, col: null, row: null, wasHidden };
  data.links.push(link);
  saveLoadedBoard(boardFolder, data, data.links);
  return { added: true, duplicate: false, attribOk, link };
}

// Clear Hidden on a path if WE set it and no board links it anymore.
// `link` is the (already removed) link record carrying wasHidden.
async function unhideIfOrphaned({ base, link, attrib }) {
  if (!link || link.wasHidden) return { unhidden: false, reason: 'was-hidden' };
  if (countLinksTo(base, link.path) > 0) return { unhidden: false, reason: 'still-linked' };
  const set = await attrib.setHidden(link.path, false);
  return { unhidden: !!set.ok, reason: set.ok ? 'cleared' : 'attrib-failed' };
}

// Remove one link from one board (+ maybe unhide). Returns
// { removed, unhidden }.
async function removeLink({ base, boardFolder, targetPath, attrib }) {
  const data = bf.loadBoard(boardFolder);
  const idx = data.links.findIndex((l) => samePath(l.path, targetPath));
  if (idx < 0) return { removed: false, unhidden: false };
  const [link] = data.links.splice(idx, 1);
  saveLoadedBoard(boardFolder, data, data.links);
  const r = await unhideIfOrphaned({ base, link, attrib });
  return { removed: true, unhidden: r.unhidden };
}

// Remove several links (multi-select / drag-out). Returns per-path
// results plus how many unhides happened.
async function removeLinks({ base, boardFolder, targetPaths, attrib }) {
  const results = [];
  for (const p of targetPaths || []) {
    results.push({ path: p, ...(await removeLink({ base, boardFolder, targetPath: p, attrib })) });
  }
  return results;
}

// A board folder is about to be deleted (trashed): after the caller
// removes the folder, call releaseBoardLinks with the links the board
// held so originals become visible again where appropriate.
async function releaseBoardLinks({ base, links, attrib }) {
  let unhidden = 0;
  for (const link of links || []) {
    const r = await unhideIfOrphaned({ base, link, attrib });
    if (r.unhidden) unhidden++;
  }
  return { unhidden };
}

// Existence/stat for rendering: a linked file moved or deleted
// externally must surface as "missing", not vanish silently.
function statLink(targetPath) {
  try {
    const st = fs.statSync(targetPath);
    return { exists: true, isDir: st.isDirectory() };
  } catch (e) {
    return { exists: false, isDir: false };
  }
}

module.exports = {
  samePath,
  parseAttribHidden,
  createAttribRunner,
  createStubAttribRunner,
  attribRunnerFromEnv,
  findLinkAnywhere,
  countLinksTo,
  addLink,
  removeLink,
  removeLinks,
  unhideIfOrphaned,
  releaseBoardLinks,
  statLink,
};

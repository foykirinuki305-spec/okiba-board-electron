'use strict';
/*
 * Drag-out MOVE completion.
 *
 * Electron's webContents.startDrag hands the real file to the OS, but
 * when the user drops it on the Desktop / in Downloads, Explorer makes
 * a COPY and the source app hears nothing back — the board original
 * would stay behind (copy semantics). To turn a Desktop/Downloads
 * drop into a real MOVE, the main process:
 *
 *   1. at drag start: records the source (path, name, size, lazily its
 *      SHA-256) and snapshots the watched folders;
 *   2. after the drag: polls the watched folders for a NEW file that
 *      provably is the dropped copy — same size AND same content hash
 *      (the name is only a tie-breaker: Explorer may add " - コピー"
 *      or " (2)", and a leaked thumbnail download would have a
 *      different size/hash, so it can never be mistaken for the copy);
 *   3. only then sends the board original to the Recycle Bin.
 *
 * No evidence -> the original is left alone (plain copy semantics).
 * Everything fs-like is injectable so tools/selftest.js can drive the
 * logic against temp dirs with a stub trash.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// ------------------------------------------------------------- snapshot
function dirSize(dir, fsImpl) {
  let total = 0;
  let names;
  try { names = fsImpl.readdirSync(dir); } catch (e) { return 0; }
  for (const name of names) {
    const full = path.join(dir, name);
    try {
      const st = fsImpl.statSync(full);
      total += st.isDirectory() ? dirSize(full, fsImpl) : st.size;
    } catch (e) { /* unreadable entry contributes 0 */ }
  }
  return total;
}

// Map dir -> Map name -> {size, isDir}.
// stableSizes: optional Map fullPath -> size for directories whose size
// was already measured for the "before" snapshot; reusing it keeps the
// per-poll snapshots cheap. Directories NOT in stableSizes (i.e. newly
// appeared ones — drop candidates) are measured fresh every time,
// because Explorer may still be copying into them.
function snapshotDirs(dirs, fsImpl, stableSizes) {
  fsImpl = fsImpl || fs;
  const snap = new Map();
  for (const dir of dirs || []) {
    const entries = new Map();
    let names = [];
    try { names = fsImpl.readdirSync(dir); } catch (e) { names = []; }
    for (const name of names) {
      const full = path.join(dir, name);
      try {
        const st = fsImpl.statSync(full);
        if (st.isDirectory()) {
          const size = stableSizes && stableSizes.has(full)
            ? stableSizes.get(full)
            : dirSize(full, fsImpl);
          entries.set(name, { size, isDir: true });
        } else {
          entries.set(name, { size: st.size, isDir: false });
        }
      } catch (e) { /* vanished mid-scan */ }
    }
    snap.set(dir, entries);
  }
  return snap;
}

// ------------------------------------------------------------- matching
function stemOf(name) {
  const ext = path.extname(name);
  return ext ? name.slice(0, -ext.length) : name;
}

// Explorer rename patterns when the dropped name already exists there:
// "name - コピー.ext", "name (2).ext", "name - Copy.ext".
function nameAffinity(srcName, candName) {
  if (candName === srcName) return true;
  const s = stemOf(srcName);
  const c = stemOf(candName);
  if (c === s) return true;
  return c.startsWith(s + ' - ') || c.startsWith(s + ' (') || c.startsWith(s + ' -');
}

// New entries (absent from the before snapshot) whose type and size
// match the source. The source itself is never a candidate, even if it
// lives inside a watched folder and was missing from the snapshot.
function findCandidates(before, after, source) {
  const out = [];
  for (const [dir, entries] of after.entries()) {
    const prev = before.get(dir) || new Map();
    for (const [name, info] of entries.entries()) {
      if (prev.has(name)) continue;
      if (info.isDir !== !!source.isDir) continue;
      if (info.size !== source.size) continue;
      const fullPath = path.join(dir, name);
      if (path.resolve(fullPath) === path.resolve(source.path)) continue;
      out.push({ dir, name, fullPath, affinity: nameAffinity(source.name, name) });
    }
  }
  return out;
}

// Exactly one match -> it. Several -> only a unique name-affinity
// match wins. Anything ambiguous returns null: never delete the
// original on a guess.
function pickMatch(matches) {
  if (!matches.length) return null;
  if (matches.length === 1) return matches[0];
  const aff = matches.filter((m) => m.affinity);
  if (aff.length === 1) return aff[0];
  return null;
}

// ---------------------------------------------------------------- hash
function hashFile(fullPath) {
  return new Promise((resolve) => {
    const h = crypto.createHash('sha256');
    let stream;
    try { stream = fs.createReadStream(fullPath); }
    catch (e) { resolve(null); return; }
    stream.on('error', () => resolve(null));
    stream.on('data', (d) => h.update(d));
    stream.on('end', () => resolve(h.digest('hex')));
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --------------------------------------------------------------- driver
// opts: { source: {path, name, size, isDir, hash?}, dirs, before?,
//         trashItem (async path->void), hashFile?, fsImpl?,
//         pollMs?, timeoutMs? }
// Resolves {moved, reason, copyPath?, error?}; never throws.
async function watchForCopy(opts) {
  const source = opts.source;
  const dirs = opts.dirs || [];
  const fsImpl = opts.fsImpl || fs;
  const hashFn = opts.hashFile || hashFile;
  const pollMs = opts.pollMs || 350;
  const timeoutMs = opts.timeoutMs || 8000;
  const before = opts.before || snapshotDirs(dirs, fsImpl);
  // Sizes of directories that already existed are stable evidence;
  // reuse them across polls instead of re-measuring the whole Desktop.
  const stableSizes = new Map();
  for (const [dir, entries] of before.entries()) {
    for (const [name, info] of entries.entries()) {
      if (info.isDir) stableSizes.set(path.join(dir, name), info.size);
    }
  }
  const deadline = Date.now() + timeoutMs;
  try {
    for (;;) {
      if (!fsImpl.existsSync(source.path)) {
        // Explorer really moved it (or it vanished another way).
        return { moved: true, reason: 'source-gone', copyPath: null };
      }
      const after = snapshotDirs(dirs, fsImpl, stableSizes);
      let cands = findCandidates(before, after, source);
      if (cands.length && hashFn && !source.isDir) {
        if (!source.hash) {
          try { source.hash = await hashFn(source.path); } catch (e) { source.hash = null; }
        }
        if (source.hash) {
          const hashed = [];
          for (const c of cands) {
            let h = null;
            try { h = await hashFn(c.fullPath); } catch (e) { h = null; }
            if (h && h === source.hash) hashed.push(c);
          }
          cands = hashed;
        }
      }
      const pick = pickMatch(cands);
      if (pick) {
        await opts.trashItem(source.path);
        return { moved: true, reason: 'copy-detected', copyPath: pick.fullPath };
      }
      if (Date.now() >= deadline) {
        return { moved: false, reason: 'timeout', copyPath: null };
      }
      await sleep(pollMs);
    }
  } catch (e) {
    return { moved: false, reason: 'error', error: String((e && e.message) || e), copyPath: null };
  }
}

module.exports = {
  dirSize, snapshotDirs, stemOf, nameAffinity,
  findCandidates, pickMatch, hashFile, watchForCopy,
};

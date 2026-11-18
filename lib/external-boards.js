'use strict';
// Separate external-board registry. Existing C boards and media are never moved.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const REGISTRY = '.external-boards.json';
const BOARD = '.okiba-board.json';
const ID = /^ext:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const key = p => process.platform === 'win32' ? p.toLowerCase() : p;
const rev = raw => crypto.createHash('sha256').update(raw === null ? 'missing\0' : 'present\0' + raw).digest('hex');
const identity = st => String(st.dev) + ':' + String(st.ino);
const inside = (p, root) => { const r = path.relative(root, p); return !r || (r !== '..' && !r.startsWith('..' + path.sep) && !path.isAbsolute(r)); };
function isExternal(id) { return typeof id === 'string' && id.startsWith('ext:'); }
function absolute(p) {
  if (typeof p !== 'string' || !path.isAbsolute(p) || p.includes('\0')) throw Error('external-path-invalid');
  const normalized = path.resolve(p);
  if (process.platform === 'win32' && (!/^[a-z]:\\/i.test(p) || /^\\\\/.test(p) || p.slice(2).includes(':'))) throw Error('external-local-path-required');
  if (key(normalized) !== key(p.replace(/[\\/]$/, '')) && key(normalized) !== key(p)) throw Error('external-path-not-canonical');
  return normalized;
}
function directory(p) {
  p = absolute(p);
  const root = path.parse(p).root, parts = path.relative(root, p).split(path.sep).filter(Boolean);
  let current = root;
  for (const part of ['', ...parts]) {
    if (part) current = path.join(current, part);
    const st = fs.lstatSync(current, { bigint: true });
    if (!st.isDirectory() || st.isSymbolicLink()) throw Error('external-reparse-or-nondirectory');
    if (key(fs.realpathSync.native(current)) !== key(current)) throw Error('external-path-alias-refused');
  }
  return { folder: p, identity: identity(fs.lstatSync(p, { bigint: true })) };
}
function plainFile(file) {
  const st = fs.lstatSync(file, { bigint: true });
  if (!st.isFile() || st.isSymbolicLink() || st.nlink !== 1n) throw Error('external-registry-not-ordinary');
}
function rawAt(file) {
  try { plainFile(file); return fs.readFileSync(file, 'utf8'); }
  catch (e) { if (e.code === 'ENOENT') return null; throw e; }
}
function validName(name) {
  if (typeof name !== 'string' || !name.trim() || name !== name.trim() || /[<>:"/\\|?*\x00-\x1f]/.test(name) || /[. ]$/.test(name) || name === '.' || name === '..' || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)) throw Error('external-name-invalid');
  return name;
}
function read(base) {
  base = directory(base).folder;
  const raw = rawAt(path.join(base, REGISTRY));
  let data;
  try { data = raw === null ? { version: 1, boards: [] } : JSON.parse(raw); } catch (_) { throw Error('external-registry-invalid'); }
  if (!data || data.version !== 1 || !Array.isArray(data.boards)) throw Error('external-registry-invalid');
  const ids = new Set(), folders = [];
  for (const b of data.boards) {
    if (!b || !ID.test(b.id) || ids.has(b.id) || b.mode !== 'resident' || typeof b.identity !== 'string') throw Error('external-registry-invalid');
    validName(b.name); const folder = absolute(b.folder);
    if (key(folder) === key(path.parse(folder).root) || inside(folder, base) || inside(base, folder) || folders.some(p => inside(p, folder) || inside(folder, p))) throw Error('external-registry-overlap');
    ids.add(b.id); folders.push(folder);
  }
  return { base, raw, data, revision: rev(raw) };
}
function describe(b) {
  const out = { id: b.id, name: b.name, folder: b.folder, mode: 'resident', external: true, missing: false };
  try {
    const d = directory(b.folder);
    if (d.identity !== b.identity) return { ...out, missing: true, invalid: true, unavailable: true, reason: 'external-directory-replaced' };
    const raw = rawAt(path.join(b.folder, BOARD));
    if (raw === null) return { ...out, missing: true, invalid: true, unavailable: true, reason: 'external-board-metadata-missing' };
    const meta = JSON.parse(raw);
    if (!meta || meta.externalBoardId !== b.id) return { ...out, missing: true, invalid: true, unavailable: true, reason: 'external-board-identity-mismatch' };
    return out;
  } catch (e) {
    return { ...out, missing: true, invalid: e.code !== 'ENOENT', unavailable: true, reason: e.code === 'ENOENT' ? 'external-directory-missing' : String(e.message || e) };
  }
}
function list(base) { return read(base).data.boards.map(describe); }
function resolve(base, id) {
  if (isExternal(id)) {
    if (!ID.test(id)) throw Error('external-id-invalid');
    const b = read(base).data.boards.find(b => b.id === id);
    if (!b) throw Error('external-board-unregistered');
    return describe(b);
  }
  validName(id); base = directory(base).folder;
  const folder = path.join(base, id);
  directory(folder);
  return { id, name: id, folder, mode: 'linked', external: false, missing: false };
}
function snapshot(base) { const r = read(base); return { revision: r.revision, boards: r.data.boards.map(describe) }; }
function writeExclusive(file, value) {
  const fd = fs.openSync(file, 'wx');
  try { fs.writeFileSync(fd, value, 'utf8'); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}
function create(base, folder, name, options = {}) {
  base = directory(base).folder; folder = absolute(folder); validName(name);
  if (inside(folder, base) || inside(base, folder) || key(folder) === key(path.parse(folder).root)) throw Error('external-board-overlap');
  const lock = path.join(base, REGISTRY + '.lock'), token = crypto.randomUUID();
  try { writeExclusive(lock, token); } catch (e) { if (e.code === 'EEXIST') throw Error('external-registry-busy'); throw e; }
  let boardCreated = false, folderCreated = false, boardRaw, folderId, tmp;
  try {
    const initial = read(base);
    if (options.expectedRevision !== undefined && options.expectedRevision !== initial.revision) throw Error('external-registry-conflict');
    if (initial.data.boards.some(b => inside(folder, b.folder) || inside(b.folder, folder))) throw Error('external-board-already-registered');
    directory(path.dirname(folder));
    try { directory(folder); } catch (e) {
      if (e.code !== 'ENOENT') throw e;
      fs.mkdirSync(folder); folderCreated = true;
    }
    folderId = directory(folder).identity;
    if (fs.readdirSync(folder).length) throw Error('external-board-not-empty');
    const id = 'ext:' + crypto.randomUUID();
    boardRaw = JSON.stringify({ version: 6, size_percent: 100, positions: {}, links: [], notes: [], externalBoardId: id }, null, 2);
    writeExclusive(path.join(folder, BOARD), boardRaw); boardCreated = true;
    const entry = { id, name, folder, mode: 'resident', identity: folderId };
    const next = JSON.stringify({ ...initial.data, boards: [...initial.data.boards, entry] }, null, 2);
    tmp = path.join(base, REGISTRY + '.tmp-' + token);
    writeExclusive(tmp, next);
    if (read(base).revision !== initial.revision) throw Error('external-registry-conflict');
    if (directory(folder).identity !== folderId || rawAt(path.join(folder, BOARD)) !== boardRaw) throw Error('external-board-changed');
    fs.renameSync(tmp, path.join(base, REGISTRY)); tmp = null;
    return { ...describe(entry), revision: rev(next) };
  } catch (e) {
    // Remove only metadata authored by this transaction, never user material.
    if (boardCreated) {
      try { if (directory(folder).identity === folderId && rawAt(path.join(folder, BOARD)) === boardRaw) fs.unlinkSync(path.join(folder, BOARD)); } catch (_) {}
    }
    if (folderCreated) { try { if (directory(folder).identity === folderId && fs.readdirSync(folder).length === 0) fs.rmdirSync(folder); } catch (_) {} }
    throw e;
  } finally {
    if (tmp) { try { fs.unlinkSync(tmp); } catch (_) {} }
    try { if (rawAt(lock) === token) fs.unlinkSync(lock); } catch (_) {}
  }
}
function updateRegistration(base, id, change, options = {}) {
  if (!ID.test(id)) throw Error('external-id-invalid');
  base = directory(base).folder;
  const lock = path.join(base, REGISTRY + '.lock'), token = crypto.randomUUID();
  try { writeExclusive(lock, token); } catch (e) { if (e.code === 'EEXIST') throw Error('external-registry-busy'); throw e; }
  let tmp;
  try {
    const initial = read(base);
    if (options.expectedRevision !== undefined && options.expectedRevision !== initial.revision) throw Error('external-registry-conflict');
    const index = initial.data.boards.findIndex(b => b.id === id);
    if (index < 0) throw Error('external-board-unregistered');
    const boards = initial.data.boards.slice(), nextEntry = change(boards[index]);
    if (nextEntry) boards[index] = nextEntry; else boards.splice(index, 1);
    const raw = JSON.stringify({ ...initial.data, boards }, null, 2);
    tmp = path.join(base, REGISTRY + '.tmp-' + token); writeExclusive(tmp, raw);
    if (read(base).revision !== initial.revision) throw Error('external-registry-conflict');
    fs.renameSync(tmp, path.join(base, REGISTRY)); tmp = null;
    return nextEntry ? { ...describe(nextEntry), revision: rev(raw) } : { removed: true, id, revision: rev(raw) };
  } finally {
    if (tmp) { try { fs.unlinkSync(tmp); } catch (_) {} }
    try { if (rawAt(lock) === token) fs.unlinkSync(lock); } catch (_) {}
  }
}
function rename(base, id, name, options) { validName(name); return updateRegistration(base, id, b => ({ ...b, name }), options); }
// Registration only. Caller owns any explicit trash/move operation.
function removeRegistration(base, id, options) { return updateRegistration(base, id, () => null, options); }
module.exports = { list, resolve, create, isExternal, snapshot, validateDirectory: directory, rename, removeRegistration, REGISTRY };

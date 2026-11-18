'use strict';
const assert = require('assert/strict'), fs = require('fs'), path = require('path'), os = require('os');
const eb = require('../lib/external-boards');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'okiba-external-unit-'));
let checks = 0;
const check = (value, label) => { assert(value, label); checks++; };
const rejects = (fn, regex) => { assert.throws(fn, regex); checks++; };
try {
  const base = path.join(root, 'boards'), outside = path.join(root, 'external'); fs.mkdirSync(base); fs.mkdirSync(outside);
  const original = path.join(base, 'same'); fs.mkdirSync(original); fs.writeFileSync(path.join(original, '.okiba-board.json'), '{"version":6,"positions":{"old":{"col":5,"row":8}}}');
  const raw = fs.readFileSync(path.join(original, '.okiba-board.json'));
  check(eb.list(base).length === 0, 'empty registry read');
  check(!fs.existsSync(path.join(base, eb.REGISTRY)), 'read does not write');
  check(eb.resolve(base, 'same').folder === original, 'legacy C exact resolution');
  const before = eb.snapshot(base);
  const a = eb.create(base, path.join(outside, 'a'), 'same', { expectedRevision: before.revision });
  check(a.external && a.mode === 'resident' && !a.missing && eb.isExternal(a.id), 'registered resident');
  check(eb.resolve(base, a.id).folder !== eb.resolve(base, 'same').folder, 'same name separate identity');
  check(eb.list(base).length === 1, 'list only external');
  check(fs.readFileSync(path.join(original, '.okiba-board.json')).equals(raw), 'legacy bytes preserved');
  rejects(() => eb.create(base, path.join(outside, 'b'), 'second', { expectedRevision: before.revision }), /conflict/);
  check(!fs.existsSync(path.join(outside, 'b')), 'stale revision creates nothing');
  rejects(() => eb.create(base, a.folder, 'duplicate'), /already-registered/);
  rejects(() => eb.create(base, path.join(a.folder, 'nested'), 'nested'), /already-registered/);
  rejects(() => eb.create(base, original, 'legacy'), /overlap/);
  rejects(() => eb.create(base, root, 'ancestor'), /overlap/);
  const occupied = path.join(outside, 'occupied'); fs.mkdirSync(occupied); fs.writeFileSync(path.join(occupied, 'keep.txt'), 'unchanged');
  rejects(() => eb.create(base, occupied, 'occupied'), /not-empty/);
  check(fs.readFileSync(path.join(occupied, 'keep.txt'), 'utf8') === 'unchanged', 'occupied material preserved');
  for (const name of ['../escape', '..', 'ext:bad', 'CON', ' trailing ', 'bad.']) rejects(() => eb.create(base, path.join(outside, 'invalid'), name), /name-invalid/);
  rejects(() => eb.resolve(base, 'ext:bad'), /id-invalid/);
  rejects(() => eb.resolve(base, 'ext:00000000-0000-0000-0000-000000000000'), /unregistered/);
  rejects(() => eb.resolve(base, '../same'), /name-invalid/);
  const lock = path.join(base, eb.REGISTRY + '.lock'); fs.writeFileSync(lock, 'other-writer');
  rejects(() => eb.create(base, path.join(outside, 'locked'), 'locked'), /busy/);
  check(fs.readFileSync(lock, 'utf8') === 'other-writer', 'foreign lock retained'); fs.unlinkSync(lock);
  const renamed = eb.rename(base, a.id, 'new display'); check(renamed.name === 'new display' && renamed.folder === a.folder, 'rename display only');
  const registry = fs.readFileSync(path.join(base, eb.REGISTRY));
  const parked = a.folder + '-parked'; fs.renameSync(a.folder, parked);
  check(eb.list(base)[0].missing && eb.resolve(base, a.id).missing, 'missing remains registered');
  check(fs.readFileSync(path.join(base, eb.REGISTRY)).equals(registry), 'missing read preserves bytes'); fs.renameSync(parked, a.folder);
  const meta = path.join(a.folder, '.okiba-board.json'), metaRaw = fs.readFileSync(meta); fs.unlinkSync(meta);
  check(eb.resolve(base, a.id).missing && eb.resolve(base, a.id).invalid, 'lost metadata blocks save'); fs.writeFileSync(meta, metaRaw);
  // Registry write failure rolls back only our newly created empty board.
  const rename = fs.renameSync; fs.renameSync = (from, to) => { if (to === path.join(base, eb.REGISTRY)) throw Error('injected registry failure'); return rename(from, to); };
  try { rejects(() => eb.create(base, path.join(outside, 'failure'), 'failure'), /injected/); } finally { fs.renameSync = rename; }
  check(!fs.existsSync(path.join(outside, 'failure')) && !fs.existsSync(lock), 'failed create rollback and unlock');
  check(fs.readFileSync(path.join(base, eb.REGISTRY)).equals(registry), 'failed update leaves old registry');
  const regpath = path.join(base, eb.REGISTRY); fs.writeFileSync(regpath, '{broken'); rejects(() => eb.list(base), /registry-invalid/); fs.writeFileSync(regpath, registry);
  // Junction/ancestor aliases must never route to a material directory.
  const alias = path.join(outside, 'alias'); fs.symlinkSync(a.folder, alias, process.platform === 'win32' ? 'junction' : 'dir');
  rejects(() => eb.validateDirectory(alias), /reparse|alias/); fs.unlinkSync(alias);
  eb.removeRegistration(base, a.id); check(eb.list(base).length === 0 && fs.readFileSync(meta).equals(metaRaw), 'unregister does not change actual board');
  check(fs.readFileSync(path.join(original, '.okiba-board.json')).equals(raw), 'legacy metadata unchanged throughout');
  console.log('external boards ' + checks + ' checks PASS; isolated fixtures only');
} finally {
  if (path.dirname(root) !== os.tmpdir() || !path.basename(root).startsWith('okiba-external-unit-')) throw Error('unsafe fixture cleanup');
  fs.rmSync(root, { recursive: true });
}

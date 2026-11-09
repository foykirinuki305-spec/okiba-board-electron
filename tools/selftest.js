'use strict';
/* Headless unit tests for lib/boardfs.js (pure fs logic).
 * Run: node tools/selftest.js  — exits non-zero on any failure. */
const fs = require('fs');
const path = require('path');
const os = require('os');
const bf = require('../lib/boardfs');

let passed = 0;
function ok(cond, label) {
  if (!cond) throw new Error('FAIL: ' + label);
  passed++;
  console.log('  ok - ' + label);
}
function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'okiba-test-')); }

function main() {
  // ---------- base resolution via env override ----------
  {
    const base = tmp();
    const env = { OKIBA_BASE: base, OKIBA_OLD_BASE: path.join(base, 'no-old') };
    ok(bf.defaultBaseDir(env) === base, 'OKIBA_BASE overrides base');
    ok(bf.oldBaseDir(env) === path.join(base, 'no-old'), 'OKIBA_OLD_BASE overrides old base');
  }

  // ---------- merge migration: legacy-only board is moved ----------
  {
    const oldB = tmp(); const newB = tmp();
    fs.mkdirSync(path.join(oldB, '古いボード'));
    fs.writeFileSync(path.join(oldB, '古いボード', 'a.txt'), 'x');
    const moved = bf.mergeLegacyBoards(oldB, newB);
    ok(moved === 1, 'merge moves legacy-only board (count=1)');
    ok(fs.existsSync(path.join(newB, '古いボード', 'a.txt')), 'merged board keeps contents');
    ok(!fs.existsSync(path.join(oldB, '古いボード')), 'merged board leaves old base');
  }

  // ---------- merge migration: board in BOTH places is untouched ----------
  {
    const oldB = tmp(); const newB = tmp();
    fs.mkdirSync(path.join(oldB, '両方'));
    fs.mkdirSync(path.join(newB, '両方'));
    fs.writeFileSync(path.join(oldB, '両方', 'old.txt'), 'old');
    fs.writeFileSync(path.join(newB, '両方', 'new.txt'), 'new');
    const moved = bf.mergeLegacyBoards(oldB, newB);
    ok(moved === 0, 'merge never overwrites (count=0)');
    ok(fs.existsSync(path.join(oldB, '両方', 'old.txt')), 'legacy copy untouched');
    ok(fs.existsSync(path.join(newB, '両方', 'new.txt')), 'new copy untouched');
  }

  // ---------- resolveBase: new base missing -> whole old base moves ----------
  {
    const root = tmp();
    const oldB = path.join(root, 'old');
    const newB = path.join(root, 'new');
    fs.mkdirSync(path.join(oldB, 'ボードA'), { recursive: true });
    const env = { OKIBA_BASE: newB, OKIBA_OLD_BASE: oldB };
    const r = bf.resolveBase(env);
    ok(r.base === newB && r.moved === 1, 'resolveBase moves whole legacy base');
    ok(fs.existsSync(path.join(newB, 'ボードA')), 'board present after resolveBase move');
  }

  // ---------- board name validation ----------
  {
    ok(bf.validateBoardName(' 動画素材 ') === '動画素材', 'name trimmed');
    let threw = false;
    try { bf.validateBoardName('a/b'); } catch (e) { threw = true; }
    ok(threw, 'invalid char rejected');
    threw = false;
    try { bf.validateBoardName('   '); } catch (e) { threw = true; }
    ok(threw, 'empty name rejected');
    threw = false;
    try { bf.validateBoardName('abc.'); } catch (e) { threw = true; }
    ok(threw, 'trailing dot rejected');
  }

  // ---------- create / rename board ----------
  {
    const base = tmp();
    ok(bf.createBoard(base, '仕事') === '仕事', 'createBoard returns name');
    ok(fs.statSync(path.join(base, '仕事')).isDirectory(), 'board folder created');
    let threw = false;
    try { bf.createBoard(base, '仕事'); } catch (e) { threw = true; }
    ok(threw, 'duplicate board rejected');
    ok(bf.renameBoard(base, '仕事', '仕事2') === '仕事2', 'renameBoard works');
    ok(bf.listBoards(base).join() === '仕事2', 'listBoards sees renamed board');
  }

  // ---------- board save/load roundtrip (v7 schema) ----------
  {
    const folder = tmp();
    bf.saveBoard(folder, { 'alpha.txt': [2, 1] },
      [{ id: 'n1', text: 'メモ本文', col: 0, row: 2 }], 125);
    const raw = JSON.parse(fs.readFileSync(path.join(folder, bf.BOARD_FILENAME), 'utf8'));
    ok(raw.version === 5 && raw.size_percent === 125, 'saved json uses v7 keys');
    ok(raw.positions['alpha.txt'].col === 2 && raw.positions['alpha.txt'].row === 1,
      'saved position is {col,row}');
    const loaded = bf.loadBoard(folder);
    ok(loaded.sizePercent === 125, 'load sizePercent');
    ok(loaded.positions['alpha.txt'][0] === 2 && loaded.positions['alpha.txt'][1] === 1,
      'load position');
    ok(loaded.notes[0].text === 'メモ本文' && loaded.notes[0].col === 0 && loaded.notes[0].row === 2,
      'load note');
  }

  // ---------- legacy: v4 size name migrates to percent ----------
  {
    const folder = tmp();
    fs.writeFileSync(path.join(folder, bf.BOARD_FILENAME),
      JSON.stringify({ version: 4, size: '大', positions: {}, notes: [] }));
    ok(bf.loadBoard(folder).sizePercent === 125, 'v4 「大」 -> 125%');
    fs.writeFileSync(path.join(folder, bf.BOARD_FILENAME),
      JSON.stringify({ version: 5, size_percent: 40, size: '大', positions: {}, notes: [] }));
    ok(bf.loadBoard(folder).sizePercent === 40, 'explicit size_percent beats legacy size');
  }

  // ---------- legacy: v3 pixel positions convert to cells ----------
  {
    const folder = tmp();
    const data = { version: 3, positions: { 'p.txt': { x: 16 + 166 * 2, y: 16 + 104 * 1 } }, notes: [] };
    fs.writeFileSync(path.join(folder, bf.BOARD_FILENAME), JSON.stringify(data));
    const cell = bf.loadBoard(folder).positions['p.txt'];
    ok(cell[0] === 2 && cell[1] === 1, 'v3 pixel position -> cell (2,1)');
  }

  // ---------- home save/load (positions + theme) ----------
  {
    const base = tmp();
    bf.saveHome(base, { 'ボード1': [2, 1] }, '紫夜');
    const home = bf.loadHome(base);
    ok(home.positions['ボード1'][0] === 2 && home.positions['ボード1'][1] === 1, 'home positions');
    ok(home.theme === '紫夜', 'home theme saved');
    bf.saveHome(base, { 'ボード1': [0, 0] }); // theme omitted -> preserved
    ok(bf.loadHome(base).theme === '紫夜', 'theme preserved on position-only save');
  }

  // ---------- intake: unique name " (2)" ----------
  {
    const folder = tmp();
    fs.writeFileSync(path.join(folder, 'a.txt'), '1');
    const dest = bf.uniqueDestination(folder, 'a.txt');
    ok(path.basename(dest) === 'a (2).txt', 'uniqueDestination adds (2) before ext');
    fs.writeFileSync(dest, '2');
    ok(path.basename(bf.uniqueDestination(folder, 'a.txt')) === 'a (3).txt', 'then (3)');
  }

  // ---------- intake: same drive move + skips ----------
  {
    const target = tmp(); const srcDir = tmp();
    const src = path.join(srcDir, 'movie.mp4');
    fs.writeFileSync(src, 'video');
    const placed = bf.placeDroppedItems([src], target);
    ok(placed.length === 1 && fs.existsSync(path.join(target, 'movie.mp4')), 'drop moves file in');
    ok(!fs.existsSync(src), 'same-drive drop removes source (move)');
    const inside = path.join(target, 'movie.mp4');
    ok(bf.placeDroppedItems([inside], target).length === 0, 'item already inside is skipped');
    ok(bf.placeDroppedItems([path.join(srcDir, 'missing.bin')], target).length === 0,
      'missing item skipped');
    const src2 = path.join(srcDir, 'movie.mp4');
    fs.writeFileSync(src2, 'video2');
    bf.placeDroppedItems([src2], target);
    ok(fs.existsSync(path.join(target, 'movie (2).mp4')), 'second same-name drop gets (2)');
  }

  // ---------- grid helpers ----------
  {
    const occupied = new Set(['0,0', '0,1']);
    const c = bf.nextFreeCell(occupied, 3);
    ok(c[0] === 0 && c[1] === 2, 'nextFreeCell fills column first');
    const cells = new Map([['a', [0, 0]], ['b', [0, 1]]]);
    const swapped = bf.moveToCell(cells, 'a', [0, 1]);
    ok(swapped === 'b' && cells.get('a')[1] === 1 && cells.get('b')[1] === 0,
      'moveToCell swaps occupant');
  }

}

// ------------------------------------------------ dropwatch (async)
const dw = require('../lib/dropwatch');

async function dropwatchMain() {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const mkPair = () => {
    const board = tmp(); const watch = tmp();
    const src = path.join(board, '素材.mp4');
    fs.writeFileSync(src, 'hello world'); // 11 bytes
    return { board, watch, src };
  };
  const runWatch = (src, watch, trashed, timeoutMs = 2500) => dw.watchForCopy({
    source: {
      path: src, name: path.basename(src),
      size: fs.statSync(src).size, isDir: false, hash: null,
    },
    dirs: [watch],
    before: dw.snapshotDirs([watch]),
    trashItem: async (p) => { trashed.push(p); fs.rmSync(p, { force: true }); },
    pollMs: 40,
    timeoutMs,
  });

  // (a) matching name+size+content appears -> original trashed (MOVE)
  {
    const { watch, src } = mkPair();
    const trashed = [];
    const promise = runWatch(src, watch, trashed);
    await sleep(120);
    fs.copyFileSync(src, path.join(watch, '素材.mp4'));
    const res = await promise;
    ok(res.moved === true && res.reason === 'copy-detected', 'dropwatch: copy detected');
    ok(trashed.length === 1 && trashed[0] === src, 'dropwatch: original trashed on copy');
    ok(!fs.existsSync(src), 'dropwatch: original gone after move completion');
  }

  // (b) nothing appears -> original kept
  {
    const { watch, src } = mkPair();
    const trashed = [];
    const res = await dw.watchForCopy({
      source: { path: src, name: '素材.mp4', size: 11, isDir: false, hash: null },
      dirs: [watch],
      before: dw.snapshotDirs([watch]),
      trashItem: async (p) => { trashed.push(p); },
      pollMs: 40, timeoutMs: 300,
    });
    ok(res.moved === false && res.reason === 'timeout', 'dropwatch: no drop -> timeout');
    ok(trashed.length === 0 && fs.existsSync(src), 'dropwatch: no drop -> original kept');
  }

  // (c) the only "new" file IS the source itself -> kept (same-path guard)
  {
    const watch = tmp();
    const src = path.join(watch, '素材.mp4'); // source inside watched dir
    fs.writeFileSync(src, 'hello world');
    const trashed = [];
    const res = await dw.watchForCopy({
      source: { path: src, name: '素材.mp4', size: 11, isDir: false, hash: null },
      dirs: [watch],
      before: new Map([[watch, new Map()]]), // crafted: source "looks new"
      trashItem: async (p) => { trashed.push(p); },
      pollMs: 40, timeoutMs: 300,
    });
    ok(res.moved === false && trashed.length === 0 && fs.existsSync(src),
      'dropwatch: source itself is never treated as its own copy');
  }

  // (d) same name but different SIZE appears -> kept
  {
    const { watch, src } = mkPair();
    const trashed = [];
    const promise = runWatch(src, watch, trashed, 600);
    await sleep(120);
    fs.writeFileSync(path.join(watch, '素材.mp4'), 'short'); // 5 bytes != 11
    const res = await promise;
    ok(res.moved === false && trashed.length === 0 && fs.existsSync(src),
      'dropwatch: size mismatch -> original kept');
  }

  // (e) same name and SIZE but different CONTENT (hash) -> kept.
  //     This is what stops a leaked thumbnail "download" (or any other
  //     same-size stranger) from being mistaken for the dropped copy.
  {
    const { watch, src } = mkPair();
    const trashed = [];
    const promise = runWatch(src, watch, trashed, 600);
    await sleep(120);
    fs.writeFileSync(path.join(watch, '素材.mp4'), 'HELLO WORLD'); // 11 bytes, other bytes
    const res = await promise;
    ok(res.moved === false && trashed.length === 0 && fs.existsSync(src),
      'dropwatch: hash mismatch -> original kept');
  }

  // (f) DIFFERENT name but same size+content -> still a move
  //     (Explorer suffixes / renamed drops: name is only a tie-breaker)
  {
    const { watch, src } = mkPair();
    const trashed = [];
    const promise = runWatch(src, watch, trashed);
    await sleep(120);
    fs.copyFileSync(src, path.join(watch, '素材 - コピー.mp4'));
    const res = await promise;
    ok(res.moved === true && trashed.length === 1 && !fs.existsSync(src),
      'dropwatch: renamed copy (same hash) completes the move');
  }

  // (g) name affinity helper
  {
    ok(dw.nameAffinity('a.mp4', 'a.mp4'), 'affinity: identical name');
    ok(dw.nameAffinity('a.mp4', 'a (2).mp4'), 'affinity: " (2)" suffix');
    ok(dw.nameAffinity('a.mp4', 'a - コピー.mp4'), 'affinity: " - コピー" suffix');
    ok(!dw.nameAffinity('a.mp4', 'ab.mp4'), 'affinity: different stem rejected');
  }
}

(async () => {
  try {
    main();
    await dropwatchMain();
    console.log('\nselftest: ' + passed + ' checks passed');
  } catch (e) {
    console.error(e.message || e);
    process.exit(1);
  }
})();

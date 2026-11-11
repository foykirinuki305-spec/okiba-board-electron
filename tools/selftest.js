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
    ok(raw.version === 6 && raw.size_percent === 125, 'saved json uses current keys (v6)');
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

  // ---------- home appVersion marker (v2.2.1 cleanup trigger) ----------
  {
    const base = tmp();
    ok(bf.loadHome(base).appVersion === null, 'appVersion absent on a fresh base');
    bf.saveHome(base, {}, '紺', '2.2.0');
    ok(bf.loadHome(base).appVersion === '2.2.0', 'appVersion roundtrips');
    bf.saveHome(base, { 'ボード1': [1, 1] }); // no version arg -> preserved
    ok(bf.loadHome(base).appVersion === '2.2.0',
      'appVersion preserved on a plain position save');
    bf.saveHome(base, {}, undefined, '2.2.1'); // the cleanup stamp
    ok(bf.loadHome(base).appVersion === '2.2.1', 'appVersion stamp overwrites');
    const raw = JSON.parse(fs.readFileSync(path.join(base, bf.HOME_FILENAME), 'utf8'));
    ok(raw.appVersion === '2.2.1' && raw.theme === '紺',
      'appVersion stored alongside theme in .home.json');
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

// ------------------------------------------------ dropmove (async)
const dm = require('../lib/dropmove');

async function dropmoveMain() {
  // ---------- resolve output parsing ----------
  {
    const d = dm.parseResolveOutput(
      JSON.stringify({ type: 'desktop', path: 'C:\\Users\\x\\Desktop' }));
    ok(d.type === 'desktop' && d.path === 'C:\\Users\\x\\Desktop', 'parse: desktop');
    const e2 = dm.parseResolveOutput('noise line\n' +
      JSON.stringify({ type: 'explorer', path: 'D:\\素材' }));
    ok(e2.type === 'explorer' && e2.path === 'D:\\素材', 'parse: explorer (last line)');
    ok(dm.parseResolveOutput('').type === 'unknown', 'parse: empty -> unknown');
    ok(dm.parseResolveOutput('not json').type === 'unknown', 'parse: garbage -> unknown');
    ok(dm.parseResolveOutput('{"type":"explorer","path":""}').type === 'unknown',
      'parse: explorer without path -> unknown');
    ok(dm.parseResolveOutput('{"type":"taskbar","path":"C:\\\\x"}').type === 'unknown',
      'parse: unrecognised type -> unknown');
  }

  // ---------- moveItemsOut: never overwrite, real move ----------
  {
    const board = tmp(); const target = tmp();
    const src = path.join(board, 'a.txt');
    fs.writeFileSync(src, 'AAA');
    fs.writeFileSync(path.join(target, 'a.txt'), 'existing');
    const r = dm.moveItemsOut([src], target);
    ok(r.moved.length === 1 && r.failed.length === 0, 'moveOut: one item moved');
    ok(!fs.existsSync(src), 'moveOut: original removed (move, not copy)');
    ok(fs.readFileSync(path.join(target, 'a.txt'), 'utf8') === 'existing',
      'moveOut: existing target file untouched');
    ok(fs.readFileSync(path.join(target, 'a (2).txt'), 'utf8') === 'AAA',
      'moveOut: landed as "a (2).txt"');
    ok(r.destinations.length === 1 &&
       path.basename(r.destinations[0]) === 'a (2).txt' &&
       fs.existsSync(r.destinations[0]),
      'moveOut: destination path reported (for icon positioning)');
    ok(Array.isArray(r.pairs) && r.pairs.length === 1 &&
       r.pairs[0].src === src && r.pairs[0].dest === r.destinations[0],
      'moveOut: src->dest pairs reported (for the move history)');
  }

  // ---------- moveItemsOut: item already inside target is skipped ----------
  {
    const target = tmp();
    const inside = path.join(target, 'b.txt');
    fs.writeFileSync(inside, 'B');
    const r = dm.moveItemsOut([inside], target);
    ok(r.skipped.length === 1 && r.moved.length === 0, 'moveOut: inside-target skipped');
    ok(fs.existsSync(inside), 'moveOut: skipped item untouched');
  }

  // ---------- moveItemsOut: missing item is a failure, nothing moves ----------
  {
    const target = tmp();
    const r = dm.moveItemsOut([path.join(target, 'nope.txt')], target);
    ok(r.moved.length === 0 && r.failed.length === 1, 'moveOut: missing -> failed, no move');
  }

  // ---------- moveItemsOut: folders move too ----------
  {
    const board = tmp(); const target = tmp();
    const dir = path.join(board, '素材フォルダ');
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'in.txt'), 'in');
    const r = dm.moveItemsOut([dir], target);
    ok(r.moved.length === 1 && fs.existsSync(path.join(target, '素材フォルダ', 'in.txt')),
      'moveOut: folder moved with contents');
    ok(!fs.existsSync(dir), 'moveOut: folder original removed');
  }

  // ---------- simulated outside release, end to end ----------
  // Resolver stubbed to a temp folder (the "Desktop"); the renderer
  // would call this after an outside pointer release. Files land in
  // the target and the board json no longer positions them.
  {
    const base = tmp(); const landing = tmp();
    const boardFolder = path.join(base, 'ボードX');
    fs.mkdirSync(boardFolder);
    const f1 = path.join(boardFolder, 'one.txt');
    const f2 = path.join(boardFolder, 'two.txt');
    fs.writeFileSync(f1, '1');
    fs.writeFileSync(f2, '2');
    bf.saveBoard(boardFolder, { 'one.txt': [0, 0], 'two.txt': [0, 1] }, [], 100);
    const resolver = dm.createResolver({
      resolve: async () => dm.parseResolveOutput(
        JSON.stringify({ type: 'desktop', path: landing })),
    });
    const target = await resolver(-50, 300); // outside the window
    ok(target.type === 'desktop' && target.path === landing, 'e2e: stub resolver resolves');
    const r = dm.moveItemsOut([f1, f2], target.path);
    ok(r.moved.length === 2, 'e2e: both files moved out');
    ok(fs.existsSync(path.join(landing, 'one.txt')) &&
       fs.existsSync(path.join(landing, 'two.txt')), 'e2e: files landed in target');
    // board cleanup mirrors the app: positions of moved items dropped
    const data = bf.loadBoard(boardFolder);
    for (const p of r.moved) delete data.positions[path.basename(p)];
    bf.saveBoard(boardFolder, data.positions, data.notes, data.sizePercent);
    const after = bf.loadBoard(boardFolder);
    ok(Object.keys(after.positions).length === 0, 'e2e: board json updated after move-out');
    const scan = bf.scanFolder(boardFolder);
    ok(scan.length === 0, 'e2e: board folder empty after move-out');
  }

  // ---------- test resolver can play a Desktop target ----------
  {
    const dir = tmp();
    const asExplorer = dm.testResolverFromEnv({ OKIBA_TEST_RESOLVER_DIR: dir });
    const t1 = await asExplorer(0, 0);
    ok(t1.type === 'explorer' && t1.path === dir, 'test resolver defaults to explorer');
    const asDesktop = dm.testResolverFromEnv({
      OKIBA_TEST_RESOLVER_DIR: dir, OKIBA_TEST_RESOLVER_TYPE: 'desktop',
    });
    const t2 = await asDesktop(0, 0);
    ok(t2.type === 'desktop' && t2.path === dir, 'test resolver can resolve desktop');
  }

  // ---------- unknown resolution moves NOTHING ----------
  {
    const board = tmp();
    const src = path.join(board, 'keep.txt');
    fs.writeFileSync(src, 'K');
    const resolver = dm.createResolver({
      resolve: async () => dm.parseResolveOutput('{"type":"unknown"}'),
    });
    const target = await resolver(10, 10);
    ok(target.type === 'unknown' && !target.path, 'e2e: unknown has no path');
    // the app only calls moveItemsOut when a path resolved
    ok(fs.existsSync(src), 'e2e: unknown target -> item stays on the board');
  }
}

// ------------------------------------------------ iconpos (sync)
const ip = require('../lib/iconpos');

function iconposMain() {
  // ---------- auto-arrange decision from a style value ----------
  {
    ok(ip.LVS_AUTOARRANGE === 0x0100, 'LVS_AUTOARRANGE is 0x0100 (commctrl.h)');
    ok(ip.isAutoArrange(0x0100) === true, 'auto-arrange: bare bit set');
    ok(ip.isAutoArrange(0x0100 | 0x0001 | 0x0200) === true,
      'auto-arrange: bit set among other style bits');
    ok(ip.isAutoArrange(0x0001 | 0x0200) === false, 'auto-arrange: bit clear');
    ok(ip.isAutoArrange(0) === false, 'auto-arrange: zero style');
    // Regression (the v1.3.0 bug): 0x1000 is LVS_OWNERDATA, and it
    // is SET in the stock desktop listview style 0x56003A40
    // (observed on a real Explorer desktop) — that style must NOT
    // be read as auto-arrange.
    ok(ip.isAutoArrange(0x1000) === false,
      'auto-arrange: LVS_OWNERDATA bit alone is not auto-arrange');
    ok(ip.isAutoArrange(0x56003A40) === false,
      'auto-arrange: stock desktop style 0x56003A40 is not auto-arrange');
    ok(ip.isAutoArrange(0x56003A40 | 0x0100) === true,
      'auto-arrange: stock desktop style + the real bit is auto-arrange');
  }

  // ---------- status note: EVERY non-ok status speaks up ----------
  {
    ok(ip.statusNoteFor({ status: 'autoarrange' }).includes('自動整列'),
      'note: auto-arrange gets the note');
    ok(ip.statusNoteFor({ status: 'ok' }) === '', 'note: success is silent');
    ok(ip.statusNoteFor(null) === '', 'note: missing result is silent');
    ok(ip.statusNoteFor({ status: 'no-item' }).includes('アイコン未検出'),
      'note: no-item says icon not found');
    ok(ip.statusNoteFor({ status: 'no-listview' }).includes('デスクトップ未検出'),
      'note: no-listview says desktop not found');
    ok(ip.statusNoteFor({ status: 'set-unverified' }).includes('固定できませんでした'),
      'note: set-unverified says position did not stick');
    ok(ip.statusNoteFor({ status: 'script-error' }).includes('エラー'),
      'note: script-error says error');
    ok(ip.statusNoteFor({ status: 'partial' }) !== '',
      'note: partial is not silent');
  }

  // ---------- screen -> client conversion ----------
  {
    const c1 = ip.screenToClient({ x: 500, y: 300 }, { x: 120, y: 40 });
    ok(c1.x === 380 && c1.y === 260, 'screenToClient: subtract the origin');
    const c2 = ip.screenToClient({ x: 10, y: 10 }, { x: 120, y: 40 });
    ok(c2.x === -110 && c2.y === -30, 'screenToClient: can go negative (multi-monitor)');
  }

  // ---------- icon text match candidates ----------
  {
    const c = ip.nameCandidates('写真 2024.jpg');
    ok(c.length === 2 && c[0] === '写真 2024.jpg' && c[1] === '写真 2024',
      'candidates: full name, then without extension');
    ok(ip.nameCandidates('フォルダ').length === 1, 'candidates: no extension -> one');
    const td = ip.nameCandidates('a.');
    ok(td.length === 2 && td[1] === 'a', 'candidates: trailing dot strips to stem');
  }

  // ---------- layout: single icon centres on the drop point ----------
  {
    const pos = ip.layoutIconPositions({
      anchor: { x: 200, y: 150 }, spacingX: 100, spacingY: 100,
      clientWidth: 1920, clientHeight: 1080, count: 1,
    });
    ok(pos.length === 1 && pos[0].x === 150 && pos[0].y === 100,
      'layout: drop point minus half spacing');
  }

  // ---------- layout: clamped into the client area ----------
  {
    const pos = ip.layoutIconPositions({
      anchor: { x: 10, y: 10 }, spacingX: 100, spacingY: 100,
      clientWidth: 1920, clientHeight: 1080, count: 1,
    });
    ok(pos[0].x === 0 && pos[0].y === 0, 'layout: top-left corner clamps to 0,0');
    const pos2 = ip.layoutIconPositions({
      anchor: { x: 5000, y: 5000 }, spacingX: 100, spacingY: 100,
      clientWidth: 800, clientHeight: 600, count: 1,
    });
    ok(pos2[0].x === 700 && pos2[0].y === 500,
      'layout: bottom-right clamps to client minus spacing');
  }

  // ---------- layout: multi-item vertical columns, desktop style ----------
  {
    // clientHeight 340, anchor y 150 -> first row at y=100, so only
    // rows y=100,200 fit before wrapping ((340-100)/100 = 2 rows).
    const pos = ip.layoutIconPositions({
      anchor: { x: 200, y: 150 }, spacingX: 100, spacingY: 100,
      clientWidth: 1920, clientHeight: 340, count: 5,
    });
    const want = [[150, 100], [150, 200], [250, 100], [250, 200], [350, 100]];
    ok(pos.length === 5 && pos.every((p, i) => p.x === want[i][0] && p.y === want[i][1]),
      'layout: fills a column, wraps to the next');
  }

  // ---------- snap-grid: actual final grid row, not raw client height ----------
  {
    const opts = { anchor:{x:420,y:100}, spacingX:78, spacingY:98,
      clientWidth:1024, clientHeight:768, count:10, gridOrigin:{x:15,y:2} };
    const positions = ip.layoutIconPositions(opts);
    ok(positions.length === 10 && positions.every(p => p.x >= 15 && p.y >= 2 && p.x+78 <= 1024 && p.y+98 <= 768),
      'snap layout: ten CI icons stay completely inside desktop');
    ok(positions[0].x === 405 && positions[0].y === 100 && positions[5].x === 405 && positions[5].y === 590 && positions[6].x === 483 && positions[6].y === 100,
      'snap layout: six safe rows then wrap (CI 1024x768 regression)');
    ok(positions.every(p => (p.x-15)%78 === 0 && (p.y-2)%98 === 0),
      'snap layout: every target is on the observed grid');
    const edge = ip.layoutIconPositions({...opts, anchor:{x:5000,y:5000},count:1});
    ok(edge[0].x === 873 && edge[0].y === 590,
      'snap layout: right/bottom clamp to final complete grid cell');
    const top = ip.layoutIconPositions({...opts, anchor:{x:-100,y:-100},count:1});
    ok(top[0].x === 15 && top[0].y === 2, 'snap layout: top/left clamps to first grid cell');
    const legacy = ip.layoutIconPositions({...opts,gridOrigin:null});
    const omitted = {...opts}; delete omitted.gridOrigin;
    ok(JSON.stringify(legacy) === JSON.stringify(ip.layoutIconPositions(omitted)) && legacy[0].x === 381 && legacy[0].y === 51 && legacy[6].y === 639 && legacy[7].x === 459,
      'snap layout: absent/null grid keeps original seven-row free-position layout');
  }

  // ---------- position output parsing ----------
  {
    const o1 = ip.parsePositionOutput('{"status":"ok","positioned":2}');
    ok(o1.status === 'ok' && o1.positioned === 2, 'parsePos: ok with count');
    const o2 = ip.parsePositionOutput('noise\n{"status":"autoarrange","positioned":0}');
    ok(o2.status === 'autoarrange', 'parsePos: autoarrange (last line)');
    ok(ip.parsePositionOutput('').status === 'script-error', 'parsePos: empty -> script-error');
    ok(ip.parsePositionOutput('junk').status === 'script-error', 'parsePos: garbage -> script-error');
    ok(ip.parsePositionOutput('{"status":"weird"}').status === 'script-error',
      'parsePos: unknown status -> script-error');
    ok(ip.parsePositionOutput('{"status":"no-item","positioned":0}').status === 'no-item',
      'parsePos: no-item passes through');
    ok(ip.parsePositionOutput('{"status":"no-listview","positioned":0}').status === 'no-listview',
      'parsePos: no-listview passes through');
    ok(ip.parsePositionOutput('{"status":"set-unverified","positioned":0}').status === 'set-unverified',
      'parsePos: set-unverified passes through');
    const timed = ip.parsePositionOutput('{"status":"ok","positioned":2,"appearMs":12,"workMs":0}');
    ok(timed.appearMs === 12 && timed.workMs === 0, 'parsePos: valid stage timings including zero');
    const invalidTiming = ip.parsePositionOutput('{"status":"ok","appearMs":-1,"workMs":"20"}');
    ok(!('appearMs' in invalidTiming) && !('workMs' in invalidTiming), 'parsePos: invalid timings ignored');
    ok(!('appearMs' in o1) && !('workMs' in o1), 'parsePos: legacy shape unchanged');
    const oErr = ip.parsePositionOutput('{"status":"script-error","positioned":0,"detail":"boom"}');
    ok(oErr.status === 'script-error' && oErr.detail === 'boom',
      'parsePos: script-error keeps its detail');
  }

  // ---------- positioner creation: injection + env stub ----------
  {
    const custom = async () => ({ status: 'partial', positioned: 1 });
    ok(ip.createPositioner({ position: custom }) === custom,
      'positioner: injected function passes through');
    const stub = ip.testPositionerFromEnv({ OKIBA_TEST_POSITIONER: 'stub' });
    ok(typeof stub === 'function', 'positioner: env stub exists when requested');
    ok(ip.testPositionerFromEnv({}) === null, 'positioner: no stub without the env flag');
    return stub(10, 20, ['a.txt', 'b.txt']).then((r) => {
      ok(r.status === 'ok' && r.positioned === 2, 'positioner: stub reports positioned count');
    });
  }
}

// ------------------------------------------------ links (async)
const ln = require('../lib/links');

async function linksMain() {
  // ---------- attrib output parsing ----------
  {
    ok(ln.parseAttribHidden('A            C:\\x\\a.txt', 'C:\\x\\a.txt') === false,
      'attrib parse: no H -> not hidden');
    ok(ln.parseAttribHidden('     H        C:\\x\\a.txt', 'C:\\x\\a.txt') === true,
      'attrib parse: H -> hidden');
    ok(ln.parseAttribHidden('A  SH        C:\\x\\a.txt', 'C:\\x\\a.txt') === true,
      'attrib parse: SH -> hidden');
    ok(ln.parseAttribHidden('', 'C:\\x\\a.txt') === null, 'attrib parse: empty -> null');
    ok(ln.parseAttribHidden('garbage output', 'C:\\x\\a.txt') === null,
      'attrib parse: unexpected shape -> null (no guessing)');
    // Codepage-mangled path bytes (what a real non-English Windows
    // returns for a Japanese file name): the attribute field must
    // still parse — the v2.0 CI failure mode.
    ok(ln.parseAttribHidden('     H        C:\\x\\???.txt', 'C:\\x\\外部素材.txt') === true,
      'attrib parse: mangled path bytes still find H');
    ok(ln.parseAttribHidden('A            C:\\x\\???.txt', 'C:\\x\\外部素材.txt') === false,
      'attrib parse: mangled path bytes, no H');
  }

  // ---------- register / duplicate / unregister with refcount ----------
  {
    const base = tmp(); const origin = tmp();
    const boardA = path.join(base, 'ボードA'); fs.mkdirSync(boardA);
    const boardB = path.join(base, 'ボードB'); fs.mkdirSync(boardB);
    const file = path.join(origin, '素材.mp4');
    fs.writeFileSync(file, 'video');
    const stub = ln.createStubAttribRunner();

    const intakeTimings = {};
    const r1 = await ln.addLink({ base, boardFolder: boardA, targetPath: file, attrib: stub, timings: intakeTimings });
    ok(['loadMs', 'registryMs', 'attribMs', 'saveMs'].every(k => Number.isFinite(intakeTimings[k]) && intakeTimings[k] >= 0), 'link: intake stage metrics are nonnegative');
    ok(r1.added && !r1.duplicate && r1.attribOk, 'link: first intake registers');
    ok(stub.count('+H') === 1, 'link: +H called exactly once at intake');
    ok(stub.isHidden(file), 'link: original is hidden after intake');
    const dataA = bf.loadBoard(boardA);
    ok(dataA.links.length === 1 && dataA.links[0].path === file &&
       dataA.links[0].wasHidden === false, 'link: recorded with wasHidden=false');
    ok(fs.existsSync(file) && !fs.existsSync(path.join(boardA, '素材.mp4')),
      'link: the file did NOT move into the board folder');

    const r2 = await ln.addLink({ base, boardFolder: boardA, targetPath: file, attrib: stub });
    ok(r2.duplicate && bf.loadBoard(boardA).links.length === 1,
      'link: duplicate intake keeps exactly one entry');
    ok(stub.count('+H') === 1, 'link: duplicate intake does not re-hide');

    const r3 = await ln.addLink({ base, boardFolder: boardB, targetPath: file, attrib: stub });
    ok(r3.added && bf.loadBoard(boardB).links[0].wasHidden === false,
      'link: second board inherits wasHidden=false (not "pre-hidden")');
    ok(stub.count('+H') === 1, 'link: second board does not call +H again');

    const u1 = await ln.removeLink({ base, boardFolder: boardA, targetPath: file, attrib: stub });
    ok(u1.removed && !u1.unhidden && stub.isHidden(file) && stub.count('-H') === 0,
      'link: removal from one of two boards keeps Hidden (refcount)');
    const u2 = await ln.removeLink({ base, boardFolder: boardB, targetPath: file, attrib: stub });
    ok(u2.removed && u2.unhidden && !stub.isHidden(file) && stub.count('-H') === 1,
      'link: last removal clears Hidden exactly once');
    ok(fs.existsSync(file), 'link: original still exists after unlink');
  }

  // ---------- a file hidden BEFORE intake keeps its state ----------
  {
    const base = tmp(); const origin = tmp();
    const board = path.join(base, 'ボード'); fs.mkdirSync(board);
    const file = path.join(origin, '秘.mp4');
    fs.writeFileSync(file, 'v');
    const stub = ln.createStubAttribRunner({ [file]: true }); // user had it hidden
    const r = await ln.addLink({ base, boardFolder: board, targetPath: file, attrib: stub });
    ok(r.added && bf.loadBoard(board).links[0].wasHidden === true,
      'link: pre-hidden file records wasHidden=true');
    ok(stub.count('+H') === 0, 'link: pre-hidden file gets no +H call');
    const u = await ln.removeLink({ base, boardFolder: board, targetPath: file, attrib: stub });
    ok(u.removed && !u.unhidden && stub.isHidden(file) && stub.count('-H') === 0,
      'link: pre-hidden file is NOT unhidden on removal');
  }

  // ---------- attrib failure never blocks intake ----------
  {
    const base = tmp(); const origin = tmp();
    const board = path.join(base, 'ボード'); fs.mkdirSync(board);
    const file = path.join(origin, 'f.txt');
    fs.writeFileSync(file, 'x');
    const deadAttrib = {
      async readHidden() { return { ok: false, hidden: null }; },
      async setHidden() { return { ok: false }; },
    };
    const r = await ln.addLink({ base, boardFolder: board, targetPath: file, attrib: deadAttrib });
    ok(r.added && !r.attribOk && bf.loadBoard(board).links.length === 1,
      'link: attrib failure still registers, flagged attribOk=false');
  }

  // ---------- missing-path state derivation ----------
  {
    const dir = tmp();
    const file = path.join(dir, 'gone.txt');
    fs.writeFileSync(file, 'x');
    ok(ln.statLink(file).exists === true, 'statLink: existing file');
    fs.rmSync(file);
    const st = ln.statLink(file);
    ok(st.exists === false && st.isDir === false, 'statLink: deleted file reads as missing');
  }

  // ---------- migration: v1.3.1 (version 5, no links) json ----------
  {
    const folder = tmp();
    fs.writeFileSync(path.join(folder, 'resident.txt'), 'r');
    fs.writeFileSync(path.join(folder, bf.BOARD_FILENAME), JSON.stringify({
      version: 5, size_percent: 80,
      positions: { 'resident.txt': { col: 2, row: 3 } },
      notes: [{ id: 'n9', text: '旧メモ', col: 0, row: 0 }],
    }));
    const loaded = bf.loadBoard(folder);
    ok(Array.isArray(loaded.links) && loaded.links.length === 0,
      'migration: pre-v2 json loads with zero links');
    ok(loaded.positions['resident.txt'][0] === 2 && loaded.positions['resident.txt'][1] === 3,
      'migration: resident positions identical');
    ok(loaded.sizePercent === 80 && loaded.notes[0].text === '旧メモ',
      'migration: percent and notes identical');
    // Saving after migration writes the v6 schema and preserves all.
    bf.saveBoard(folder, loaded.positions, loaded.notes, loaded.sizePercent, loaded.links);
    const raw = JSON.parse(fs.readFileSync(path.join(folder, bf.BOARD_FILENAME), 'utf8'));
    ok(raw.version === 6 && Array.isArray(raw.links) && raw.links.length === 0,
      'migration: save writes version 6 with empty links');
    ok(raw.positions['resident.txt'].col === 2 && raw.positions['resident.txt'].row === 3,
      'migration: positions survive the v6 save');
  }

  // ---------- v6 links roundtrip ----------
  {
    const folder = tmp();
    const link = { path: 'C:\\Users\\x\\Desktop\\動画.mp4', col: 1, row: 2, wasHidden: false };
    bf.saveBoard(folder, {}, [], 100, [link]);
    const loaded = bf.loadBoard(folder);
    ok(loaded.links.length === 1 && loaded.links[0].path === link.path &&
       loaded.links[0].col === 1 && loaded.links[0].row === 2 &&
       loaded.links[0].wasHidden === false, 'v6: link roundtrips through save/load');
    const raw = JSON.parse(fs.readFileSync(path.join(folder, bf.BOARD_FILENAME), 'utf8'));
    ok(raw.version === 6, 'v6: saved json version is 6');
  }

  // ---------- board deletion releases links (releaseBoardLinks) ----------
  {
    const base = tmp(); const origin = tmp();
    const board = path.join(base, 'ボード'); fs.mkdirSync(board);
    const file = path.join(origin, 'keep.txt');
    fs.writeFileSync(file, 'k');
    const stub = ln.createStubAttribRunner();
    await ln.addLink({ base, boardFolder: board, targetPath: file, attrib: stub });
    const held = bf.loadBoard(board).links;
    fs.rmSync(board, { recursive: true, force: true }); // the trash itself
    const rel = await ln.releaseBoardLinks({ base, links: held, attrib: stub });
    ok(rel.unhidden === 1 && !stub.isHidden(file) && fs.existsSync(file),
      'board delete: linked original unhidden and untouched');
  }

  // ---------- linked drag-out = REAL move (v2.1 moveLinkedOut) ----
  {
    const base = tmp(); const origin = tmp(); const destDir = tmp();
    const board = path.join(base, 'ボード'); fs.mkdirSync(board);
    const file = path.join(origin, '素材.mp4');
    fs.writeFileSync(file, 'data');
    const stub = ln.createStubAttribRunner();
    await ln.addLink({ base, boardFolder: board, targetPath: file, attrib: stub });
    ok(stub.isHidden(file), 'v2.1 move: intake hid the origin');
    const ops = [];
    const moveFile = (src, dir) => {
      ops.push('move:' + src);
      const dest = path.join(dir, path.basename(src));
      fs.renameSync(src, dest);
      return dest;
    };
    const tracking = {
      readHidden: (p) => stub.readHidden(p),
      setHidden: (p, h) => { ops.push((h ? '+H:' : '-H:') + p); return stub.setHidden(p, h); },
    };
    const r = await ln.moveLinkedOut({
      base, boardFolder: board, targetPath: file, destDir, attrib: tracking, moveFile,
    });
    const dest = path.join(destDir, '素材.mp4');
    ok(r.moved === true && r.dest === dest, 'v2.1 move: reported moved with destination');
    ok(ops[0] === 'move:' + file, 'v2.1 move: the REAL move happens FIRST');
    ok(ops.includes('-H:' + dest) && ops.indexOf('-H:' + dest) > 0,
      'v2.1 move: -H applied to the DESTINATION after the move');
    ok(fs.existsSync(dest) && !fs.existsSync(file), 'v2.1 move: file really relocated');
    ok(stub.isHidden(dest) === false, 'v2.1 move: destination is visible');
    ok(bf.loadBoard(board).links.length === 0, 'v2.1 move: link detached from the board');
  }
  {
    // wasHidden=true (user-hidden before intake): an explicit move
    // still lands VISIBLE — the -H ignores wasHidden on purpose.
    const base = tmp(); const origin = tmp(); const destDir = tmp();
    const board = path.join(base, 'ボード'); fs.mkdirSync(board);
    const file = path.join(origin, '隠し素材.txt');
    fs.writeFileSync(file, 'secret');
    bf.saveBoard(board, {}, [], 100, [{ path: file, col: 0, row: 0, wasHidden: true }]);
    const stub = ln.createStubAttribRunner({ [file]: true });
    ok(stub.isHidden(file), 'v2.1 move: origin starts hidden (pre-hidden)');
    const moveFile = (src, dir) => {
      const dest = path.join(dir, path.basename(src));
      fs.renameSync(src, dest);
      return dest;
    };
    const r = await ln.moveLinkedOut({
      base, boardFolder: board, targetPath: file, destDir, attrib: stub, moveFile,
    });
    ok(r.moved === true && stub.isHidden(r.dest) === false,
      'v2.1 move: wasHidden=true still lands visible (explicit move wins)');
  }
  {
    // Move failure: NOTHING else may change (link intact, still
    // hidden at the origin, no -H anywhere).
    const base = tmp(); const origin = tmp(); const destDir = tmp();
    const board = path.join(base, 'ボード'); fs.mkdirSync(board);
    const file = path.join(origin, '失敗素材.txt');
    fs.writeFileSync(file, 'stay');
    const stub = ln.createStubAttribRunner();
    await ln.addLink({ base, boardFolder: board, targetPath: file, attrib: stub });
    const callsBefore = stub.calls.length;
    const r = await ln.moveLinkedOut({
      base, boardFolder: board, targetPath: file, destDir,
      attrib: stub, moveFile: () => null,
    });
    ok(r.moved === false && r.reason === 'move-failed', 'v2.1 move: failure reported');
    ok(bf.loadBoard(board).links.length === 1, 'v2.1 move: failed move keeps the link');
    ok(fs.existsSync(file) && stub.isHidden(file),
      'v2.1 move: failed move leaves the origin hidden and in place');
    ok(stub.calls.slice(callsBefore).every((c) => c.op === 'read' || c.path === file),
      'v2.1 move: failed move performs no -H on any destination');
    const notLinked = await ln.moveLinkedOut({
      base, boardFolder: board, targetPath: path.join(origin, '無い.txt'),
      destDir, attrib: stub, moveFile: () => { throw new Error('must not be called'); },
    });
    ok(notLinked.moved === false && notLinked.reason === 'not-linked',
      'v2.1 move: unlinked path is a clean no-op');
  }
  {
    // Already inside the target (Desktop file dropped on the
    // Desktop): moveFile returns the source itself; the item still
    // detaches and becomes visible at home.
    const base = tmp(); const home = tmp();
    const board = path.join(base, 'ボード'); fs.mkdirSync(board);
    const file = path.join(home, 'デスクトップ素材.txt');
    fs.writeFileSync(file, 'desk');
    const stub = ln.createStubAttribRunner();
    await ln.addLink({ base, boardFolder: board, targetPath: file, attrib: stub });
    const r = await ln.moveLinkedOut({
      base, boardFolder: board, targetPath: file, destDir: home,
      attrib: stub, moveFile: (src) => src,
    });
    ok(r.moved === true && r.dest === file && stub.isHidden(file) === false &&
       bf.loadBoard(board).links.length === 0,
      'v2.1 move: already-at-target still detaches and lands visible');
  }
}

const sc = require('../lib/shortcut');

function shortcutMain() {
  // ---------- --board-path parsing ----------
  {
    const p = sc.parseBoardArg(['exe', '--board-path', 'C:\\OkibaBoards\\動画']);
    ok(p.boardPath === 'C:\\OkibaBoards\\動画' && !p.malformed,
      'shortcut: two-token --board-path parsed');
    const eq = sc.parseBoardArg(['exe', '--board-path=D:\\Boards\\x']);
    ok(eq.boardPath === 'D:\\Boards\\x' && !eq.malformed,
      'shortcut: --board-path=<value> parsed');
    const none = sc.parseBoardArg(['exe', '--no-sandbox']);
    ok(none.boardPath === null && !none.malformed,
      'shortcut: no flag -> no board, not malformed');
    const tail = sc.parseBoardArg(['exe', '--board-path']);
    ok(tail.boardPath === null && tail.malformed,
      'shortcut: flag with NO value is malformed');
    const flagVal = sc.parseBoardArg(['exe', '--board-path', '--other']);
    ok(flagVal.boardPath === null && flagVal.malformed,
      'shortcut: flag followed by another flag is malformed');
    const emptyEq = sc.parseBoardArg(['exe', '--board-path=']);
    ok(emptyEq.boardPath === null && emptyEq.malformed,
      'shortcut: empty = value is malformed');
    const amid = sc.parseBoardArg(['exe', '.', '--user-data-dir=/tmp/x', '--board-path', '/b/ボード', '--x']);
    ok(amid.boardPath === '/b/ボード', 'shortcut: flag found amid other args');
  }

  // ---------- board-path validation against a temp base ----------
  {
    const base = tmp();
    const boardDir = path.join(base, '素材ボード');
    fs.mkdirSync(boardDir, { recursive: true });
    ok(sc.validateBoardPath(base, boardDir) === '素材ボード',
      'shortcut: direct child of base is a board (even without json)');
    fs.writeFileSync(path.join(boardDir, bf.BOARD_FILENAME), '{}');
    ok(sc.validateBoardPath(base, boardDir) === '素材ボード',
      'shortcut: child of base WITH json is a board');

    const outside = tmp();
    const extDir = path.join(outside, '外部ボード');
    fs.mkdirSync(extDir, { recursive: true });
    ok(sc.validateBoardPath(base, extDir) === null,
      'shortcut: plain folder outside base (no json) is NOT a board');
    fs.writeFileSync(path.join(extDir, bf.BOARD_FILENAME), '{}');
    ok(sc.validateBoardPath(base, extDir) === '外部ボード',
      'shortcut: folder with board json is a board even outside base');

    const filePath = path.join(base, 'file.txt');
    fs.writeFileSync(filePath, 'x');
    ok(sc.validateBoardPath(base, filePath) === null,
      'shortcut: a file path is not a board');
    ok(sc.validateBoardPath(base, path.join(base, '存在しない')) === null,
      'shortcut: missing folder is not a board');
    ok(sc.validateBoardPath(base, base) === null,
      'shortcut: the base itself is not a board');
    ok(sc.validateBoardPath(base, '') === null && sc.validateBoardPath(base, null) === null,
      'shortcut: empty/null paths rejected');
    ok(sc.validateBoardPath(base, boardDir + path.sep) === '素材ボード',
      'shortcut: trailing separator tolerated');
  }

  // ---------- routing decisions ----------
  {
    const base = tmp();
    const boardDir = path.join(base, 'ボードA');
    fs.mkdirSync(boardDir, { recursive: true });
    const good = sc.routeFromArgv(['exe', '--board-path', boardDir], base);
    ok(good.boardName === 'ボードA' && !good.invalidBoard,
      'shortcut: valid path routes into the board');
    const plain = sc.routeFromArgv(['exe'], base);
    ok(plain.boardName === null && !plain.invalidBoard,
      'shortcut: no flag routes home quietly');
    const gone = sc.routeFromArgv(['exe', '--board-path', path.join(base, '消えた')], base);
    ok(gone.boardName === null && gone.invalidBoard,
      'shortcut: deleted board routes home WITH the not-found note');
    const malformed = sc.routeFromArgv(['exe', '--board-path'], base);
    ok(malformed.boardName === null && malformed.invalidBoard,
      'shortcut: malformed flag routes home WITH the not-found note');

    // Chromium detaches a two-token value when forwarding a second
    // instance's argv (observed live on the real handler): the flag
    // arrives bare, the value trails as the last positional. The
    // router must recover the board from the stray token — and must
    // NOT mistake the app path positional for a board.
    const appRoot = tmp(); // exists, but is not a board folder
    const detached = sc.routeFromArgv(
      ['exe', '--no-sandbox', '--user-data-dir=/tmp/x', '--board-path',
       '--allow-file-access-from-files', appRoot, boardDir], base);
    ok(detached.boardName === 'ボードA' && !detached.invalidBoard,
      'shortcut: detached second-instance argv still routes into the board');
    const detachedEq = sc.routeFromArgv(
      ['exe', '--no-sandbox', '--board-path=' + boardDir, appRoot], base);
    ok(detachedEq.boardName === 'ボードA' && !detachedEq.invalidBoard,
      'shortcut: = form survives forwarding untouched');
    const detachedGone = sc.routeFromArgv(
      ['exe', '--board-path', '--some-switch', appRoot], base);
    ok(detachedGone.boardName === null && detachedGone.invalidBoard,
      'shortcut: detached argv with NO valid board token -> not-found note');
    const p2 = sc.parseBoardArg(['exe', '--board-path', '/x']);
    ok(p2.flagSeen === true && sc.parseBoardArg(['exe']).flagSeen === false,
      'shortcut: parse reports flagSeen');
  }

  // ---------- shortcut file-name planning ----------
  {
    const empty = () => null;
    ok(sc.planShortcutFileName('動画素材', empty) === '動画素材.lnk',
      'shortcut name: plain name when the Desktop is free');
    ok(sc.planShortcutFileName('動画素材', () => 'file') === '動画素材.lnk',
      'shortcut name: existing FILES never block (only the .lnk is written)');
    const lnkExists = (n) => (n === '動画素材.lnk' ? 'file' : null);
    ok(sc.planShortcutFileName('動画素材', lnkExists) === '動画素材.lnk',
      'shortcut name: same-name .lnk is refreshed, not suffixed');
    const folderClash = (n) => (n === '動画素材' ? 'dir' : null);
    ok(sc.planShortcutFileName('動画素材', folderClash) === '動画素材 (OkibaBoard).lnk',
      'shortcut name: folder with the board name -> (OkibaBoard) suffix');
    const lnkDir = (n) => (n === '動画素材.lnk' ? 'dir' : null);
    ok(sc.planShortcutFileName('動画素材', lnkDir) === '動画素材 (OkibaBoard).lnk',
      'shortcut name: folder literally named X.lnk -> suffix');
    const bothClash = (n) => (n === '動画素材' || n === '動画素材 (OkibaBoard)' ? 'dir' : null);
    ok(sc.planShortcutFileName('動画素材', bothClash) === '動画素材 (OkibaBoard 2).lnk',
      'shortcut name: double folder clash -> second suffix');
    ok(sc.planShortcutFileName('a/b:c', empty) === 'abc.lnk',
      'shortcut name: invalid filename chars are stripped');
    ok(sc.sanitizeShortcutName('  名前.  ') === '名前',
      'shortcut name: trailing dot/spaces stripped');
  }
}

function placementMain() {
  const pl = require('../lib/placement');
  const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  console.log('\n[placement] anchored intake placement (v2.2, Job B)');
  {
    // Anchor exact: empty board, single item lands on the anchor.
    const cells = pl.placeItems({ occupied: new Set(), anchor: [2, 1], offsets: [[0, 0]], count: 1, rowsPerCol: 6 });
    ok(eq(cells, [[2, 1]]), 'placement: single item lands exactly on the anchor');
  }
  {
    // Default: no offsets -> vertical strip in drop order.
    const cells = pl.placeItems({ occupied: new Set(), anchor: [1, 0], offsets: null, count: 3, rowsPerCol: 6 });
    ok(eq(cells, [[1, 0], [1, 1], [1, 2]]), 'placement: no offsets -> vertical strip in drop order');
  }
  {
    // Explicit vertical strip preserved.
    const cells = pl.placeItems({
      occupied: new Set(), anchor: [3, 2], count: 3, rowsPerCol: 8,
      offsets: [[0, 0], [0, 1], [0, 2]],
    });
    ok(eq(cells, [[3, 2], [3, 3], [3, 4]]), 'placement: explicit vertical strip preserved');
  }
  {
    // Desktop-relative 2-column arrangement preserved exactly.
    const cells = pl.placeItems({
      occupied: new Set(), anchor: [1, 1], count: 4, rowsPerCol: 8,
      offsets: [[0, 0], [0, 1], [1, 0], [1, 1]],
    });
    ok(eq(cells, [[1, 1], [1, 2], [2, 1], [2, 2]]),
      'placement: 2-column desktop arrangement preserved');
  }
  {
    // Collision AT the anchor: forward scan (down the column).
    const cells = pl.placeItems({
      occupied: new Set(['2,1']), anchor: [2, 1], count: 1, rowsPerCol: 6,
      offsets: [[0, 0]],
    });
    ok(eq(cells, [[2, 2]]), 'placement: occupied anchor shifts to nearest free cell forward');
  }
  {
    // Collision shifts only the colliding item; neighbours keep
    // their preferred cells.
    const cells = pl.placeItems({
      occupied: new Set(['0,1']), anchor: [0, 0], count: 3, rowsPerCol: 8,
      offsets: [[0, 0], [0, 1], [0, 5]],
    });
    ok(eq(cells, [[0, 0], [0, 2], [0, 5]]),
      'placement: only the colliding item shifts forward');
  }
  {
    // A shifted item may take the NEXT item's preferred cell; the
    // next item then shifts too, but relative order is preserved.
    const cells = pl.placeItems({
      occupied: new Set(['0,0']), anchor: [0, 0], count: 2, rowsPerCol: 6,
      offsets: [[0, 0], [0, 1]],
    });
    ok(eq(cells, [[0, 1], [0, 2]]), 'placement: chain shift preserves relative order');
  }
  {
    // Capacity overflow wraps to the next column (the user's
    // acknowledged caveat).
    const cells = pl.placeItems({
      occupied: new Set(), anchor: [0, 1], count: 2, rowsPerCol: 2,
      offsets: [[0, 0], [0, 1]],
    });
    ok(eq(cells, [[0, 1], [1, 0]]), 'placement: column capacity overflow wraps to next column');
  }
  {
    // Never overwrite, never duplicate — crowded board.
    const occupied = new Set(['0,0', '0,1', '0,2', '1,0', '1,1']);
    const cells = pl.placeItems({
      occupied, anchor: [0, 0], count: 4, rowsPerCol: 3, offsets: null,
    });
    const keys = cells.map((c) => c.join(','));
    ok(new Set(keys).size === 4 && keys.every((k) => !occupied.has(k)),
      'placement: never lands on an occupied cell, never duplicates');
    ok(eq(cells, [[1, 2], [2, 0], [2, 1], [2, 2]]),
      'placement: forward scan follows the board fill order');
  }
  {
    // computeCells replicates the renderer: saved positions win,
    // position-less residents/links append in render order.
    const { cells, occupied } = pl.computeCells({
      entries: [{ name: 'a.txt' }, { name: 'b.txt' }, { name: 'c.txt' }],
      positions: { 'a.txt': [2, 0] },
      notes: [{ id: 'n1', col: 0, row: 0 }],
      links: [{ path: 'D:\\x.txt', col: null, row: null }],
      rowsPerCol: 4,
    });
    ok(eq(cells.get('file:a.txt'), [2, 0]), 'computeCells: saved resident position kept');
    ok(eq(cells.get('note:n1'), [0, 0]), 'computeCells: note cell kept');
    ok(eq(cells.get('file:b.txt'), [0, 1]), 'computeCells: position-less resident appended');
    ok(eq(cells.get('file:c.txt'), [0, 2]), 'computeCells: append order matches renderer');
    ok(eq(cells.get('link:D:\\x.txt'), [0, 3]), 'computeCells: position-less link appended last');
    ok(occupied.size === 5, 'computeCells: occupancy covers every item');
  }
  {
    // Desktop pixel positions -> grid cells -> normalised offsets.
    const res = { positions: { 'A.txt': { x: 405, y: 198 }, 'B.txt': { x: 405, y: 296 }, 'C.txt': { x: 483, y: 198 } }, sx: 78, sy: 98 };
    const cellMap = pl.cellsFromDesktopPositions(res, ['A.txt', 'B.txt', 'C.txt', 'gone.txt']);
    ok(eq(cellMap.get('A.txt'), [5, 2]) && eq(cellMap.get('B.txt'), [5, 3]) && eq(cellMap.get('C.txt'), [6, 2]),
      'desktop cells: pixels convert via icon spacing');
    ok(!cellMap.has('gone.txt'), 'desktop cells: missing icons are absent from the map');
    const plan = pl.planDesktopOffsets([
      { key: 'C.txt', cell: cellMap.get('C.txt') },
      { key: 'A.txt', cell: cellMap.get('A.txt') },
      { key: 'B.txt', cell: cellMap.get('B.txt') },
    ]);
    ok(eq(plan.order, ['A.txt', 'B.txt', 'C.txt']),
      'desktop plan: items ordered by desktop (col,row)');
    ok(eq(plan.offsets, [[0, 0], [0, 1], [1, 0]]),
      'desktop plan: offsets normalised to the top-left item');
  }
  // ---------- board extent derivation (v2.2.2, scroll expansion) --
  {
    ok(pl.EXTENT_MARGIN === 2, 'extent: slack margin is 2 rows/cols');
    const empty = pl.boardExtent({ viewportRows: 4, viewportCols: 6, cells: [] });
    ok(empty.heightRows === 6 && empty.widthCols === 8,
      'extent: empty board = viewport + slack on both axes');
    const small = pl.boardExtent({
      viewportRows: 4, viewportCols: 6, cells: [[0, 0], [2, 1]],
    });
    ok(small.heightRows === 6 && small.widthCols === 8,
      'extent: content inside the viewport does not shrink the slack');
    const tall = pl.boardExtent({
      viewportRows: 4, viewportCols: 6, cells: [[0, 0], [0, 12]],
    });
    ok(tall.heightRows === 15 && tall.widthCols === 8,
      'extent: an item at row 12 extends the height to 13 + slack');
    const wide = pl.boardExtent({
      viewportRows: 4, viewportCols: 6, cells: [[9, 0]],
    });
    ok(wide.heightRows === 6 && wide.widthCols === 12,
      'extent: an item at col 9 extends the width to 10 + slack');
  }
  {
    // With the EXTENDED height as rowsPerCol, a vertical strip
    // anchored near the new bottom fills to that bottom and only
    // then wraps — the wrap point moved with the extension.
    const cells = pl.placeItems({
      occupied: new Set(), anchor: [0, 13], count: 3, rowsPerCol: 15,
      offsets: [[0, 0], [0, 1], [0, 2]],
    });
    ok(eq(cells, [[0, 13], [0, 14], [1, 0]]),
      'placement: strip wraps at the EXTENDED bottom (rowsPerCol=15)');
    const low = pl.placeItems({
      occupied: new Set(), anchor: [0, 12], count: 1, rowsPerCol: 15,
      offsets: [[0, 0]],
    });
    ok(eq(low, [[0, 12]]), 'placement: below-viewport anchor lands exactly');
  }
  {
    // computeCells with the derived height: appends fill the
    // TALLER column before wrapping (renderer parity at the new
    // rowsPerCol the renderer now passes in placeOpts).
    const { cells } = pl.computeCells({
      entries: [{ name: 'a.txt' }, { name: 'b.txt' }, { name: 'c.txt' }],
      positions: {}, notes: [], links: [], rowsPerCol: 15,
    });
    ok(eq(cells.get('file:a.txt'), [0, 0]) &&
       eq(cells.get('file:b.txt'), [0, 1]) &&
       eq(cells.get('file:c.txt'), [0, 2]),
      'computeCells: appends run down the extended column');
  }
}

async function shellhelperMain() {
  const sh = require('../lib/shellhelper');
  console.log('\n[shellhelper] warm-helper client protocol (v2.2, Job A)');
  const fake = path.join(__dirname, 'fake-helper.js');
  const landing = tmp();
  process.env.OKIBA_FAKE_LANDING = landing;
  {
    // Two sequential + two pipelined requests, ONE process.
    const client = sh.createShellHelperClient({ command: process.execPath, args: [fake] });
    const r1 = await client.request('resolveDrop', { x: 111, y: 5 });
    ok(r1.ok && r1.result.type === 'explorer' && r1.result.path === landing && r1.result.echo === 111,
      'helper: resolveDrop answered by the fake helper');
    const r2 = await client.request('positionIcons', { x: 1, y: 2, names: ['a', 'b'] });
    ok(r2.ok && r2.result.status === 'ok' && r2.result.positioned === 2,
      'helper: positionIcons answered by the same process');
    const [p1, p2] = await Promise.all([
      client.request('resolveDrop', { x: 222, y: 5 }),
      client.request('resolveDrop', { x: 333, y: 5 }),
    ]);
    ok(p1.ok && p1.result.echo === 222 && p2.ok && p2.result.echo === 333,
      'helper: pipelined responses matched by request id');
    const st = client.stats();
    ok(st.spawns === 1, 'helper: sequential requests reuse one process (spawns==1)');
    ok(st.requests === 4 && st.ok === 4, 'helper: stats count served requests');
    client.dispose();
  }
  {
    // Timeout: a hung request fails soft and does NOT kill the
    // helper; the next request is served by the same process.
    const client = sh.createShellHelperClient({ command: process.execPath, args: [fake] });
    const hung = await client.request('hang', {}, { timeoutMs: 250 });
    ok(!hung.ok && hung.error === 'timeout', 'helper: hung request times out soft');
    const after = await client.request('resolveDrop', { x: 7, y: 7 });
    ok(after.ok && after.result.echo === 7, 'helper: request after a timeout still served');
    ok(client.stats().spawns === 1, 'helper: timeout does not restart the process');
    client.dispose();
  }
  {
    // Crash: in-flight request fails, the NEXT request lazily
    // respawns the helper and succeeds (restart-on-crash).
    const client = sh.createShellHelperClient({ command: process.execPath, args: [fake] });
    const boom = await client.request('resolveDrop', { x: 1, y: 1, boom: true });
    ok(!boom.ok, 'helper: request in flight during a crash fails');
    const next = await client.request('resolveDrop', { x: 9, y: 9 });
    ok(next.ok && next.result.echo === 9, 'helper: next request succeeds after respawn');
    ok(client.stats().spawns === 2, 'helper: crash caused exactly one respawn');
    client.dispose();
  }
  {
    // Disabled client: never spawns, requests fail soft (callers
    // fall back to the cold-spawn scripts).
    const client = sh.createShellHelperClient({ enabled: false, command: process.execPath, args: [fake] });
    const r = await client.request('resolveDrop', { x: 1, y: 1 });
    ok(!r.ok && client.stats().spawns === 0, 'helper: disabled client never spawns');
  }
  {
    // Wire escaping: Japanese names survive as \uXXXX on the line.
    const line = sh.escapeLine(JSON.stringify({ name: '素材データ.mp4' }));
    ok(!/[^\x00-\x7F]/.test(line) && JSON.parse(line).name === '素材データ.mp4',
      'helper: non-ASCII is \\u-escaped on the wire and round-trips');
  }
  {
    // cursorState (v2.2.2): the fake serves the scripted sequence,
    // one entry per request, and the last state repeats (a resting
    // cursor). This is the witness the drag pre-resolver polls.
    const seq = [{ x: 10, y: 20, lbtn: true }, { x: -40, y: 200, lbtn: false }];
    const client = sh.createShellHelperClient({
      command: process.execPath, args: [fake],
      env: { ...process.env, OKIBA_FAKE_CURSOR: JSON.stringify(seq) },
    });
    const c1 = await client.request('cursorState', {});
    ok(c1.ok && c1.result.x === 10 && c1.result.y === 20 && c1.result.lbtn === true,
      'helper: cursorState serves the scripted cursor + button state');
    const c2 = await client.request('cursorState', {});
    const c3 = await client.request('cursorState', {});
    ok(c2.ok && c2.result.x === -40 && c2.result.lbtn === false &&
       c3.ok && c3.result.x === -40,
      'helper: cursorState repeats the last scripted state once consumed');
    client.dispose();
  }
  {
    // Delayed positionIcons (v2.2.2 optimistic-UI fixture): the
    // answer still arrives, just late — the client does not care.
    const client = sh.createShellHelperClient({
      command: process.execPath, args: [fake],
      env: { ...process.env, OKIBA_FAKE_POSITION_DELAY_MS: '60' },
    });
    const r = await client.request('positionIcons', { x: 1, y: 2, names: ['a'] });
    ok(r.ok && r.result.status === 'ok' && r.result.positioned === 1,
      'helper: delayed positionIcons answer is delivered intact');
    client.dispose();
  }
  delete process.env.OKIBA_FAKE_LANDING;
}

// ------------------------------------------------ preresolve (v2.2.2)
// The drag-time pre-resolution cache (lib/preresolve.js): pure and
// clock-injected, so every rule — fire throttle, staleness,
// acceptance radius, superseded answers — is asserted by REQUEST
// COUNT and cache behaviour, never by wall-clock timing.
async function preresolveMain() {
  const pr = require('../lib/preresolve');
  console.log('\n[preresolve] drag-out pre-resolution cache (v2.2.2)');
  {
    const calls = [];
    const cache = pr.createPreResolver({
      resolve: (x, y) => { calls.push([x, y]); return { type: 'desktop', path: 'D' }; },
    });
    ok(cache.lookup(100, 100, 1000) === null, 'preresolve: empty cache misses');
    cache.observe(100, 100, 1000);
    ok(calls.length === 1, 'preresolve: first outside point fires a resolve');
    const hit = cache.lookup(105, 108, 1100);
    ok(hit && hit.target.type === 'desktop' && hit.ageMs === 100,
      'preresolve: near-point fresh lookup hits and reports its age');
    ok(cache.lookup(140, 100, 1100) === null,
      'preresolve: a far release point (>12px) misses');
    ok(cache.lookup(100, 100, 1000 + pr.MAX_AGE_MS + 1) === null,
      'preresolve: an answer older than MAX_AGE misses');
    cache.observe(102, 101, 1150); // 2.2px move, 150ms old: throttled
    ok(calls.length === 1, 'preresolve: small move within the window does not refire');
    cache.observe(102, 101, 1000 + pr.REFETCH_AFTER_MS + 1); // stale: refire
    ok(calls.length === 2, 'preresolve: the same point refires once the answer is stale');
    cache.observe(200, 200, 2000); // >= 8px jump: refire immediately
    ok(calls.length === 3, 'preresolve: a jump of >=8px refires at once');
    const latest = cache.lookup(200, 200, 2000);
    ok(latest && latest.target.type === 'desktop',
      'preresolve: the latest answer is the one served');
    cache.reset();
    ok(cache.lookup(200, 200, 2000) === null && cache.size() === 0,
      'preresolve: reset clears the cache');
  }
  {
    // Async resolver: an answer that lands AFTER a newer fire was
    // issued is superseded and must never be served.
    const pending = [];
    const cache = pr.createPreResolver({
      resolve: (x, y) => new Promise((res) => pending.push({ x, y, res })),
    });
    cache.observe(10, 10, 0);
    cache.observe(90, 90, 10); // supersedes the first fire
    ok(pending.length === 2, 'preresolve: the second point fired while the first was in flight');
    const flush = () => new Promise((r) => setImmediate(r));
    pending[1].res({ type: 'explorer', path: 'B' }); // newer lands first
    await flush();
    pending[0].res({ type: 'explorer', path: 'A' }); // stale lands late
    await flush();
    const hitB = cache.lookup(90, 90, 20);
    ok(hitB && hitB.target.path === 'B', 'preresolve: the newer answer is served');
    ok(cache.lookup(10, 10, 20) === null,
      'preresolve: the superseded late answer was dropped');
  }
  {
    // A resolver failure caches nothing: the release-time resolve
    // must still get its own chance.
    const cache = pr.createPreResolver({
      resolve: () => { throw new Error('boom'); },
    });
    cache.observe(5, 5, 0);
    ok(cache.lookup(5, 5, 0) === null && cache.size() === 0,
      'preresolve: a throwing resolver caches nothing');
  }
}

// ------------------------------------------------ cleanup (v2.2.1 Job 2)
const cu = require('../lib/cleanup');

function cleanupMain() {
  console.log('\n[update] non-destructive version stamp');
  // ---------- version gate ----------
  {
    ok(cu.shouldRunCleanup('2.2.1', null) === true, 'cleanup gate: no marker -> run (first run)');
    ok(cu.shouldRunCleanup('2.2.1', '2.2.0') === true, 'cleanup gate: version changed -> run');
    ok(cu.shouldRunCleanup('2.2.1', '2.2.1') === false, 'cleanup gate: same version -> no-op');
    ok(cu.shouldRunCleanup('', null) === false, 'cleanup gate: unknown current version -> never run');
  }
  for (const execPath of ['/apps/installed/OkibaBoard.exe','/desk/OkibaBoard.exe']) {
    const input = {desktopFiles:['/desk/OkibaBoard.exe','/desk/OkibaBoard-Setup-2.0.0.exe'], downloadsFiles:['/dl/OkibaBoard.exe'],shortcuts:[{lnkPath:'/desk/app.lnk',target:'/old/OkibaBoard.exe'},{lnkPath:'/desk/board.lnk',target:'/old/OkibaBoard.exe',args:'--board-path="C:\\boards"'}],execPath};
    const before=JSON.stringify(input),plan=cu.planCleanup(input);
    ok(plan.deleteFiles.length===0,'update: all loose executables preserved');
    ok(plan.deleteShortcuts.length===0,'update: all existing shortcuts preserved');
    ok(plan.healShortcuts.length===0,'update: no shortcut replacement/healing');
    ok(JSON.stringify(input)===before,'update: planner inputs untouched');
  }
  const source=fs.readFileSync(path.join(__dirname,'../main.js'),'utf8');
  const begin=source.indexOf('function runVersionCleanup() {'),end=source.indexOf('// ------------------------------------------------------------------- IPC',begin);
  const body=source.slice(begin,end);let saves=0;const positions={A:[7,3]};
  const denied=new Proxy({}, {get(){throw Error('update must not access filesystem or Shell');}});
  const ctx={app:{getVersion:()=> 'new'},cu,BASE:'owned-base',fs:denied,shell:denied,bf:{loadHome:()=>({positions,theme:'kept',appVersion:'old'}),saveHome:(base,pos,theme,version)=>{if(base!=='owned-base'||pos!==positions||theme!=='kept'||version!=='new')throw Error('stamp changed layout');saves++;}}};
  require('vm').runInNewContext(body+';runVersionCleanup();',ctx);
  ok(saves===1,'update startup stamps only version and preserves layout without external filesystem/Shell access');
  ctx.bf.loadHome=()=>({positions,theme:'kept',appVersion:'new'});
  require('vm').runInNewContext(body+';runVersionCleanup();',ctx);
  ok(saves===1,'same-version startup has no writes');
}
// ------------------------------------------------ move history (v2.2.1 Job 3)
const mhist = require('../lib/movehistory');

function movehistoryMain() {
  console.log('\n[movehistory] grouped move-out history (v2.2.1, Job 3)');
  const item = (name, kind) => ({
    kind: kind || 'resident',
    destPath: '/landing/' + name,
    fileName: name, col: 1, row: 2,
  });
  // ---------- record + persistence ----------
  {
    const base = tmp();
    mhist.recordItems(base, {
      boardName: 'ボードA', boardFolder: '/base/ボードA',
      items: [item('a.txt')],
    });
    ok(fs.existsSync(path.join(base, mhist.HISTORY_FILENAME)),
      'history: stored in .move-history.json under the base');
    const loaded = mhist.loadHistory(base);
    ok(loaded.length === 1 && loaded[0].boardName === 'ボードA' &&
       loaded[0].items.length === 1 && loaded[0].items[0].col === 1 &&
       loaded[0].items[0].row === 2 && loaded[0].items[0].kind === 'resident',
      'history: one group roundtrips with board, kind and cell');
  }
  // ---------- cap: newest 5 OPERATIONS (groups), not 5 files ----------
  {
    const base = tmp();
    for (let i = 1; i <= 6; i++) {
      mhist.recordItems(base, {
        id: 'g' + i, boardName: 'B', boardFolder: '/b',
        items: [item('f' + i + '.txt'), item('f' + i + 'b.txt'), item('f' + i + 'c.txt')],
      });
    }
    const loaded = mhist.loadHistory(base);
    ok(loaded.length === 5 && mhist.MAX_GROUPS === 5,
      'history: cap is the newest 5 operations');
    ok(loaded[0].id === 'g6' && loaded[4].id === 'g2',
      'history: oldest operation is pushed out, newest first');
    ok(loaded.every((g) => g.items.length === 3),
      'history: a 3-file group counts as ONE operation');
  }
  // ---------- shared operation id merges into ONE group ----------
  {
    const base = tmp();
    mhist.recordItems(base, {
      id: 'op-1', boardName: 'B', boardFolder: '/b', items: [item('linked.txt', 'linked')],
    });
    mhist.recordItems(base, {
      id: 'op-1', boardName: 'B', boardFolder: '/b', items: [item('resident.txt')],
    });
    const loaded = mhist.loadHistory(base);
    ok(loaded.length === 1 && loaded[0].items.length === 2 &&
       loaded[0].items[0].kind === 'linked' && loaded[0].items[1].kind === 'resident',
      'history: one multi-part operation (linked + resident calls) is ONE group');
  }
  // ---------- restore planning: exists partition ----------
  {
    const group = {
      id: 'x', boardName: 'B', boardFolder: '/b',
      items: [item('here.txt'), item('gone.txt', 'linked')],
    };
    const plan = mhist.planRestore(group, (p) => p.endsWith('here.txt'));
    ok(plan.restorable.length === 1 && plan.restorable[0].fileName === 'here.txt' &&
       plan.missing.length === 1 && plan.missing[0].fileName === 'gone.txt',
      'history: planRestore splits restorable vs 見つかりません');
  }
  // ---------- removal: restored items leave, empty groups vanish ----------
  {
    const base = tmp();
    mhist.recordItems(base, {
      id: 'rm', boardName: 'B', boardFolder: '/b',
      items: [item('one.txt'), item('two.txt')],
    });
    mhist.removeItems(base, 'rm', ['/landing/one.txt']);
    let loaded = mhist.loadHistory(base);
    ok(loaded.length === 1 && loaded[0].items.length === 1 &&
       loaded[0].items[0].fileName === 'two.txt',
      'history: restoring one item keeps the rest of its group');
    mhist.removeItems(base, 'rm', ['/landing/two.txt']);
    loaded = mhist.loadHistory(base);
    ok(loaded.length === 0, 'history: a group emptied by restores disappears');
    mhist.recordItems(base, { id: 'rm2', boardName: 'B', boardFolder: '/b', items: [item('z.txt')] });
    mhist.removeGroup(base, 'rm2');
    ok(mhist.loadHistory(base).length === 0, 'history: removeGroup discards a whole entry');
    ok(mhist.findGroup(base, 'rm2') === null, 'history: findGroup misses a discarded group');
  }
  // ---------- corrupted file never breaks loading ----------
  {
    const base = tmp();
    fs.writeFileSync(path.join(base, mhist.HISTORY_FILENAME), '{oops');
    ok(Array.isArray(mhist.loadHistory(base)) && mhist.loadHistory(base).length === 0,
      'history: corrupted json loads as empty');
  }
}

(async () => {
  try {
    main();
    await dropmoveMain();
    await iconposMain();
    await linksMain();
    shortcutMain();
    placementMain();
    await shellhelperMain();
    await preresolveMain();
    cleanupMain();
    movehistoryMain();
    console.log('\nselftest: ' + passed + ' checks passed');
  } catch (e) {
    console.error(e.message || e);
    process.exit(1);
  }
})();

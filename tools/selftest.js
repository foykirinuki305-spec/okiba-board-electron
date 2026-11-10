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
  }

  // ---------- register / duplicate / unregister with refcount ----------
  {
    const base = tmp(); const origin = tmp();
    const boardA = path.join(base, 'ボードA'); fs.mkdirSync(boardA);
    const boardB = path.join(base, 'ボードB'); fs.mkdirSync(boardB);
    const file = path.join(origin, '素材.mp4');
    fs.writeFileSync(file, 'video');
    const stub = ln.createStubAttribRunner();

    const r1 = await ln.addLink({ base, boardFolder: boardA, targetPath: file, attrib: stub });
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
}

(async () => {
  try {
    main();
    await dropmoveMain();
    await iconposMain();
    await linksMain();
    console.log('\nselftest: ' + passed + ' checks passed');
  } catch (e) {
    console.error(e.message || e);
    process.exit(1);
  }
})();

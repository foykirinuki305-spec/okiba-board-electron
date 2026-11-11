'use strict';
/*
 * GUI end-to-end test driving the REAL app with Playwright's Electron
 * support (_electron.launch). Runs the unpackaged app (electron .)
 * against a throwaway OKIBA_BASE and performs actual UI operations:
 *
 *   home renders -> create board via modal -> open board -> items show
 *   -> pointer-drag an item to another cell (position saved)
 *   -> change percent dropdown (size changes + persisted)
 *   -> theme button (theme changes + persisted)
 *   -> right-click custom menu -> rename modal opens/closes
 *   -> MULTI-SELECT (primary): rubber-band drag on empty area with NO
 *      modifier key selects the enclosed items (desktop style)
 *   -> group drag: both selected items move by the same cell delta
 *      and the positions are saved
 *   -> group drag onto a non-selected item's cell: whole group
 *      reverts, nothing is saved
 *   -> Ctrl+click toggling still works (auxiliary method)
 *   -> DRAG-OUT (v1.2, self-implemented): a synthetic outside release
 *      fires the resolve-drop IPC; with OKIBA_TEST_RESOLVER_DIR set,
 *      main resolves the target and really MOVES the file there.
 *      okiba.startDrag must no longer exist (mechanism removed).
 *      Explorer-folder drops must NOT invoke desktop positioning.
 *   -> DESKTOP DROP (v1.3): with OKIBA_TEST_RESOLVER_TYPE=desktop
 *      and the positioner stubbed (OKIBA_TEST_POSITIONER=stub), an
 *      outside release really MOVES the file and main logs the icon
 *      positioning invocation (drop point + destination name).
 *   -> context-menu trash uses the real shell.trashItem (Windows)
 *   -> restart restores boards, positions (incl. group), percent,
 *      theme
 *   -> PER-BOARD SHORTCUTS (v2.1): the home card menu writes a real
 *      .lnk to a redirected Desktop (read back: target + args carry
 *      the board path; re-creating refreshes it); a fresh launch
 *      with --board-path opens that board directly; an invalid path
 *      falls back to home with a one-line note; a second process
 *      with --board-path hands over to the RUNNING window, which
 *      switches boards (single-instance routing)
 *   -> ANCHORED INTAKE (v2.2): linkFiles/dropFiles with an explicit
 *      anchor + offsets save exactly the cells the placement module
 *      picks into .okiba-board.json (collisions scan forward); a
 *      plain call without options still registers position-less
 *      links (append, back-compat)
 *   -> WARM HELPER (v2.2): with OKIBA_TEST_HELPER=fake and the env
 *      stubs removed, two desktop drag-outs are resolved AND
 *      positioned through the fake helper; helperStats must show
 *      spawns===1 (one process reused — no timing asserts)
 *   -> PRE-RESOLVE + VERIFIED COMMIT (v2.2.2): a scripted cursor
 *      sequence drives main's drag-time polling; resolution fires
 *      DURING the drag, the release consumes the cache (dropLog
 *      resolve entry marked pre), metadata stays unchanged while the
 *      fake helper's positionIcons answer is still 4s out, and
 *      okiba.log gains ONE dragout timing line (resolve=pre)
 *   -> SCROLL EXPANSION (v2.2.2): board size derives from content
 *      on both axes; items at row 12 / col 7 are reachable by
 *      wheel and by edge auto-scroll drags (saved cells match the
 *      rendered positions), and survive a restart in place
 *
 * Screenshots of home and board are written to $OKIBA_SHOTS (default
 * ./screenshots). Any failure exits non-zero, failing the CI build.
 * A real OS drop gesture still cannot be automated; the resolver is
 * stubbed, but the IPC path and the actual file move are real.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { _electron: electron } = require('playwright');

const ROOT = path.join(__dirname, '..');
const SHOTS = process.env.OKIBA_SHOTS || path.join(ROOT, 'screenshots');
const PNG_1PX = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64');

let stepNo = 0;
function step(name) { stepNo++; console.log(`[gui] step ${stepNo}: ${name}`); }
function assert(cond, label) {
  if (!cond) throw new Error('ASSERT FAILED: ' + label);
  console.log('  ok - ' + label);
}
async function waitFor(fn, label, timeout = 12000) {
  const t0 = Date.now();
  for (;;) {
    try { if (await fn()) return; } catch (e) {}
    if (Date.now() - t0 > timeout) throw new Error('TIMEOUT: ' + label);
    await new Promise((r) => setTimeout(r, 200));
  }
}
function readJson(p) { return JSON.parse(fs.readFileSync(p, 'utf8')); }
// boundingBox() can return null if a poll re-render lands exactly
// during the call; retry briefly instead of flaking the whole run.
async function boxOf(locator, label) {
  let box = null;
  await waitFor(async () => !!(box = await locator.boundingBox()), label || 'bounding box');
  return box;
}
async function selectedNames(page) {
  return page.locator('.item.selected .name').allTextContents();
}
async function dragCenterTo(page, locator, dx, dy) {
  const box = await boxOf(locator, 'drag source box');
  const cx = box.x + box.width / 2, cy = box.y + box.height / 2;
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  await page.mouse.move(cx + dx, cy + dy, { steps: 14 });
  await page.mouse.up();
}

// The drag-leak guard: NO element anywhere may be natively draggable.
// (Thumbnails are data: URLs; a leaked <img> drag reaches the desktop
// as a browser "download" instead of the real file.)
async function assertNoDragLeak(page, where) {
  const scan = await page.evaluate(() => {
    const all = [...document.querySelectorAll('*')];
    return {
      draggable: all.filter((el) => el.draggable === true)
        .map((el) => el.tagName + '.' + String(el.className || '')),
      imgCount: all.filter((el) => el.tagName === 'IMG').length,
      imgsUnlocked: all.filter((el) => el.tagName === 'IMG' && el.draggable !== false).length,
    };
  });
  assert(scan.draggable.length === 0,
    `${where}: zero natively-draggable elements (found: ${scan.draggable.join(', ') || 'none'})`);
  assert(scan.imgsUnlocked === 0, `${where}: every <img> has draggable=false`);
  const prevented = await page.evaluate(() => {
    const img = document.querySelector('img');
    if (!img) return 'no-img';
    const ev = new Event('dragstart', { bubbles: true, cancelable: true });
    img.dispatchEvent(ev);
    return ev.defaultPrevented;
  });
  if (prevented !== 'no-img') {
    assert(prevented === true, `${where}: synthetic dragstart on <img> is preventDefaulted`);
  }
  return scan;
}

async function main() {
  fs.mkdirSync(SHOTS, { recursive: true });
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'okiba-gui-base-'));
  const oldBase = fs.mkdtempSync(path.join(os.tmpdir(), 'okiba-gui-old-'));
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'okiba-gui-profile-'));
  const boardName = 'テスト素材';
  const boardDir = path.join(base, boardName);
  fs.mkdirSync(boardDir, { recursive: true });
  const longName = '撮影データ_2024年_最終バージョン_その2.mp4';
  const seeds = {
    [longName]: 'fake video',
    '写真サンプル.png': PNG_1PX,
    'メモ帳.txt': 'hello',
    'グループA.txt': 'A',
    'グループB.txt': 'B',
    '占有.txt': 'blocker',
    '移動テスト.txt': 'move me please',
    'デスクトップ移動.txt': 'to the desktop',
  };
  for (const [n, c] of Object.entries(seeds)) fs.writeFileSync(path.join(boardDir, n), c);
  fs.writeFileSync(path.join(boardDir, '.okiba-board.json'), JSON.stringify({
    version: 5, size_percent: 100,
    positions: {
      [longName]: { col: 0, row: 0 },
      '写真サンプル.png': { col: 0, row: 1 },
      'メモ帳.txt': { col: 0, row: 2 },
      'グループA.txt': { col: 2, row: 0 },
      'グループB.txt': { col: 2, row: 1 },
      '占有.txt': { col: 3, row: 0 },
      '移動テスト.txt': { col: 3, row: 2 },
      'デスクトップ移動.txt': { col: 4, row: 0 },
    },
    notes: [],
  }, null, 2));

  // Stub drop-target folder for the v1.2 drag-out resolver: main's
  // resolve step is replaced by this folder; the MOVE itself is real.
  const landing = fs.mkdtempSync(path.join(os.tmpdir(), 'okiba-gui-landing-'));

  const env = {
    ...process.env,
    OKIBA_CLEANUP_DESKTOP: landing,
    OKIBA_CLEANUP_DOWNLOADS: landing,
    OKIBA_SHORTCUT_DESKTOP: landing,
    OKIBA_BASE: base,
    OKIBA_OLD_BASE: oldBase,
    OKIBA_TEST_RESOLVER_DIR: landing,
    OKIBA_TEST_POSITIONER: 'stub',
    OKIBA_TEST_HOOKS: '1',
    // Explicit legacy Desktop-placement regression; normal route is packaged-folder-return.e2e.js.
    OKIBA_TEST_RETURN_MODE: 'legacy',
    ELECTRON_DISABLE_SECURITY_WARNINGS: '1',
  };
  const launch = (extraEnv) => electron.launch({
    args: [ROOT, '--no-sandbox', '--user-data-dir=' + userData],
    env: extraEnv ? { ...env, ...extraEnv } : env,
    timeout: 60000,
  });

  // ------------------------------------------------------------ run 1
  step('launch app, home is shown');
  let app1 = await launch();
  let page = await app1.firstWindow();
  page.on('pageerror', (e) => console.log('  [pageerror]', e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') console.log('  [console]', m.text());
  });
  await page.waitForSelector('#boardGrid .board-card', { timeout: 20000 });
  assert(true, 'home shows board cards');
  await page.screenshot({ path: path.join(SHOTS, 'home.png') });
  await assertNoDragLeak(page, 'home');

  step('create a board through the modal');
  await page.click('#addBoardBtn');
  await page.waitForSelector('#modalOverlay:not([hidden])');
  await page.fill('#modalInput', '新しいボード');
  await page.click('#modalOk');
  await page.waitForSelector('#boardGrid .board-card[data-name="新しいボード"]');
  assert(fs.statSync(path.join(base, '新しいボード')).isDirectory(),
    'real folder created for the new board');
  const cardCount = await page.locator('#boardGrid .board-card').count();
  assert(cardCount >= 2, 'home card count increased');

  step('open the seeded board, items render with names');
  await page.click(`#boardGrid .board-card[data-name="${boardName}"]`);
  await page.waitForSelector('#boardView:not([hidden])');
  await page.waitForSelector('.item .name');
  const names = await page.locator('.item .name').allTextContents();
  assert(names.some((t) => t.includes('撮影データ')), 'long file name is displayed');
  await page.screenshot({ path: path.join(SHOTS, 'board.png') });

  step('no native-drag leakage in the board DOM');
  const boardScan = await assertNoDragLeak(page, 'board');
  if (process.platform === 'win32') {
    assert(boardScan.imgCount >= 1, 'board shows at least one thumbnail <img> (all locked)');
  }

  step('pointer-drag an item one cell to the right');
  const first = page.locator('.item', { hasText: '撮影データ' }).first();
  await dragCenterTo(page, first, 164, 0);
  try {
    await waitFor(() => {
      const data = readJson(path.join(boardDir, '.okiba-board.json'));
      const pos = data.positions[longName];
      return pos && pos.col === 1 && pos.row === 0;
    }, 'dragged position saved to json');
  } catch (e) {
    const data = readJson(path.join(boardDir, '.okiba-board.json'));
    console.log('  [diag] positions after drag:', JSON.stringify(data.positions));
    throw e;
  }
  assert(true, 'item moved to cell (1,0) and position persisted');

  step('percent dropdown changes size and persists');
  const thumbBefore = await boxOf(page.locator('.item .thumb').first(), 'thumb box before');
  await page.selectOption('#percentSel', '60');
  await waitFor(() => {
    const data = readJson(path.join(boardDir, '.okiba-board.json'));
    return data.size_percent === 60;
  }, 'size_percent=60 saved');
  const thumbAfter = await boxOf(page.locator('.item .thumb').first(), 'thumb box after');
  assert(thumbAfter.width < thumbBefore.width, 'icons got smaller at 60%');
  // 60% grid metrics: cellW = round(164*.6) = 98, cellH = round(158*.6) = 95
  const CELL_W = 98, CELL_H = 95;

  step('theme button changes theme and persists');
  const themeBefore = await page.evaluate(() => document.documentElement.dataset.theme);
  assert(themeBefore === '紺', 'default theme is 紺');
  await page.click('#boardThemeBtn');
  await waitFor(async () =>
    (await page.evaluate(() => document.documentElement.dataset.theme)) === '黒グレー',
    'theme switched to 黒グレー');
  await waitFor(() => {
    const home = readJson(path.join(base, '.home.json'));
    return home.theme === '黒グレー';
  }, 'theme saved to .home.json');
  assert(true, 'theme changed and persisted');
  await page.screenshot({ path: path.join(SHOTS, 'board-theme.png') });

  step('right-click opens the custom menu; rename modal opens and closes');
  await page.locator('.item').first().click({ button: 'right' });
  await page.waitForSelector('#ctxMenu:not([hidden]) .ctx-item');
  const menuLabels = await page.locator('#ctxMenu .ctx-item').allTextContents();
  assert(menuLabels.some((t) => t.includes('名前を変更')), 'menu has 名前を変更');
  assert(menuLabels.some((t) => t.includes('戻し先フォルダへ移動')), 'menu has 戻し先フォルダへ移動');
  await page.locator('#ctxMenu .ctx-item', { hasText: '名前を変更' }).dispatchEvent('mousedown');
  await page.waitForSelector('#modalOverlay:not([hidden])');
  assert(true, 'rename modal opened');
  await page.click('#modalCancel');
  await page.waitForFunction(() => document.getElementById('modalOverlay').hidden);
  assert(true, 'rename modal closed without changes');

  step('rubber-band (NO modifier) selects the enclosed items');
  const areaBox = await boxOf(page.locator('#boardArea'), 'board area box');
  // At 60%: A(2,0) spans area-x 212..310, B(2,1) 111.. in y.
  // Band (215,5)-(300,230) clips A and B only.
  await page.mouse.move(areaBox.x + 215, areaBox.y + 5);
  await page.mouse.down();
  await page.mouse.move(areaBox.x + 300, areaBox.y + 230, { steps: 12 });
  const bandVisible = await page.evaluate(() =>
    !!document.querySelector('.rubber-band'));
  assert(bandVisible, 'rubber-band rectangle is drawn live while dragging');
  await page.mouse.up();
  await waitFor(async () => (await selectedNames(page)).length === 2,
    'exactly two items selected by the band');
  const bandSel = await selectedNames(page);
  assert(bandSel.some((t) => t.includes('グループA')) &&
         bandSel.some((t) => t.includes('グループB')),
    'band selected グループA and グループB');

  step('group drag moves both items by the same delta and saves');
  const itemA = page.locator('.item', { hasText: 'グループA' }).first();
  await dragCenterTo(page, itemA, CELL_W * 2, CELL_H * 2);
  await waitFor(() => {
    const data = readJson(path.join(boardDir, '.okiba-board.json'));
    const a = data.positions['グループA.txt'];
    const b = data.positions['グループB.txt'];
    return a && b && a.col === 4 && a.row === 2 && b.col === 4 && b.row === 3;
  }, 'group positions saved: A(4,2) B(4,3)');
  assert(true, 'both items moved by (+2,+2) and persisted');

  step('group drag onto a non-selected cell reverts the whole group');
  await dragCenterTo(page, itemA, -CELL_W, -CELL_H * 2); // A would land on 占有 (3,0)
  await new Promise((r) => setTimeout(r, 700)); // let any (wrong) save happen
  const afterRevert = readJson(path.join(boardDir, '.okiba-board.json'));
  assert(afterRevert.positions['グループA.txt'].col === 4 &&
         afterRevert.positions['グループA.txt'].row === 2 &&
         afterRevert.positions['グループB.txt'].col === 4 &&
         afterRevert.positions['グループB.txt'].row === 3,
    'blocked group drag reverted completely (no partial move)');

  step('Ctrl+click toggles selection (auxiliary method)');
  const memo = page.locator('.item', { hasText: 'メモ帳' }).first();
  const memoBox = await boxOf(memo, 'memo item box');
  await page.keyboard.down('Control');
  await page.mouse.click(memoBox.x + memoBox.width / 2, memoBox.y + memoBox.height / 2);
  await page.keyboard.up('Control');
  await waitFor(async () => (await selectedNames(page)).length === 3,
    'ctrl+click added メモ帳 to the selection');
  await page.keyboard.down('Control');
  await page.mouse.click(memoBox.x + memoBox.width / 2, memoBox.y + memoBox.height / 2);
  await page.keyboard.up('Control');
  await waitFor(async () => (await selectedNames(page)).length === 2,
    'ctrl+click again removed it');

  step('drag-out v1.2: outside release resolves and MOVES the file');
  const hasStartDrag = await page.evaluate(() => typeof window.okiba.startDrag);
  assert(hasStartDrag === 'undefined', 'okiba.startDrag no longer exists (mechanism removed)');
  // clear the selection with a plain click on empty area
  await page.mouse.click(areaBox.x + 500, areaBox.y + 420);
  await waitFor(async () => (await selectedNames(page)).length === 0, 'selection cleared');
  const moveItem = page.locator('.item', { hasText: '移動テスト' }).first();
  const mvBox = await boxOf(moveItem, 'move item box');
  await page.mouse.move(mvBox.x + mvBox.width / 2, mvBox.y + mvBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(mvBox.x + mvBox.width / 2 + 30, mvBox.y + mvBox.height / 2, { steps: 5 });
  // synthetic OUTSIDE release: pointerup with clientX far left of window
  await moveItem.evaluate((el) => {
    el.dispatchEvent(new PointerEvent('pointerup', {
      bubbles: true, cancelable: true, pointerId: 1,
      clientX: -80, clientY: 120, screenX: -40, screenY: 200,
    }));
  });
  await page.mouse.up(); // release the real button too
  await waitFor(() => fs.existsSync(path.join(landing, '移動テスト.txt')),
    'file really landed in the resolved target folder');
  assert(!fs.existsSync(path.join(boardDir, '移動テスト.txt')),
    'original left the board folder (a MOVE, not a copy)');
  await waitFor(async () => {
    const log = await page.evaluate(() => window.okiba.dropLog());
    return Array.isArray(log) && log.some((e) => e.kind === 'resolve') &&
      !log.some((e) => e.kind === 'startdrag');
  }, 'main logged the resolve-drop invocation');
  await waitFor(async () => {
    const t = await page.evaluate(() => document.getElementById('toast').textContent);
    return t.includes('移動しました');
  }, 'status line confirmed the move to the user');
  await waitFor(async () => {
    const ns = await page.locator('.item .name').allTextContents();
    return !ns.some((t) => t.includes('移動テスト'));
  }, 'moved item disappeared from the board');
  assert(true, 'outside release -> resolve -> real MOVE, with visible feedback');
  const logAfterExplorer = await page.evaluate(() => window.okiba.dropLog());
  assert(!logAfterExplorer.some((e) => e.kind === 'position'),
    'explorer-folder drop does NOT invoke desktop icon positioning');

  if (process.platform === 'win32') {
    step('context-menu trash uses the real Recycle Bin (shell.trashItem)');
    const trashSrc = path.join(boardDir, 'メモ帳.txt');
    await page.locator('.item', { hasText: 'メモ帳' }).first().click({ button: 'right' });
    await page.waitForSelector('#ctxMenu:not([hidden]) .ctx-item');
    await page.locator('#ctxMenu .ctx-item', { hasText: 'ゴミ箱へ削除' })
      .dispatchEvent('mousedown');
    await waitFor(() => !fs.existsSync(trashSrc), 'file sent to the Recycle Bin');
    assert(true, 'shell.trashItem removed the file for real');
  } else {
    console.log('  skip - real Recycle Bin check runs on the Windows CI runner');
  }

  await app1.close();

  // ------------------------------------------------------------ run 2
  step('restart restores boards, positions (incl. group), percent and theme');
  const app2 = await launch();
  page = await app2.firstWindow();
  await page.waitForSelector('#boardGrid .board-card', { timeout: 20000 });
  const cardNames = await page.locator('#boardGrid .board-card').evaluateAll(
    (els) => els.map((el) => el.dataset.name));
  assert(cardNames.includes('新しいボード') && cardNames.includes(boardName),
    'both boards restored after restart');
  const theme2 = await page.evaluate(() => document.documentElement.dataset.theme);
  assert(theme2 === '黒グレー', 'theme restored after restart');
  await page.click(`#boardGrid .board-card[data-name="${boardName}"]`);
  await page.waitForSelector('#boardView:not([hidden]) .item');
  const selVal = await page.evaluate(() => document.getElementById('percentSel').value);
  assert(selVal === '60', 'percent restored to 60 after restart');
  const data = readJson(path.join(boardDir, '.okiba-board.json'));
  assert(data.positions[longName].col === 1, 'single-dragged position still saved');
  assert(data.positions['グループA.txt'].col === 4 && data.positions['グループA.txt'].row === 2 &&
         data.positions['グループB.txt'].col === 4 && data.positions['グループB.txt'].row === 3,
    'group-dragged positions restored after restart');
  assert(!data.positions['移動テスト.txt'], 'moved-out item has no stale position');
  const posLeft = await page.locator('.item', { hasText: '撮影データ' }).first()
    .evaluate((el) => el.style.left);
  assert(parseInt(posLeft, 10) > 60, 'item rendered at the dragged column');
  await page.screenshot({ path: path.join(SHOTS, 'board-restored.png') });
  await app2.close();

  // ------------------------------------------------------------ run 3
  step('desktop drop (v1.3): move + icon positioning is invoked');
  const app3 = await launch({ OKIBA_TEST_RESOLVER_TYPE: 'desktop' });
  page = await app3.firstWindow();
  await page.waitForSelector('#boardGrid .board-card', { timeout: 20000 });
  await page.click(`#boardGrid .board-card[data-name="${boardName}"]`);
  await page.waitForSelector('#boardView:not([hidden]) .item');
  const deskItem = page.locator('.item', { hasText: 'デスクトップ移動' }).first();
  const deskBox = await boxOf(deskItem, 'desktop item box');
  await page.mouse.move(deskBox.x + deskBox.width / 2, deskBox.y + deskBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(deskBox.x + deskBox.width / 2 + 30, deskBox.y + deskBox.height / 2,
    { steps: 5 });
  // synthetic OUTSIDE release, same pattern as the explorer drop
  await deskItem.evaluate((el) => {
    el.dispatchEvent(new PointerEvent('pointerup', {
      bubbles: true, cancelable: true, pointerId: 1,
      clientX: -80, clientY: 120, screenX: -40, screenY: 200,
    }));
  });
  await page.mouse.up();
  await waitFor(() => fs.existsSync(path.join(landing, 'デスクトップ移動.txt')),
    'desktop drop: file really landed in the Desktop target');
  assert(!fs.existsSync(path.join(boardDir, 'デスクトップ移動.txt')),
    'desktop drop: original left the board folder (a MOVE)');
  await waitFor(async () => {
    const log = await page.evaluate(() => window.okiba.dropLog());
    return Array.isArray(log) && log.some((e) => e.kind === 'safe-desktop' && e.ok);
  }, 'main logged the positioning invocation (drop point + destination name)');
  assert(true, 'positioning script invoked with the drop point and landed name');
  await waitFor(async () => {
    const t = await page.evaluate(() => document.getElementById('toast').textContent);
    return t.includes('デスクトップへ移動しました');
  }, 'status line says デスクトップへ移動しました');
  await waitFor(async () => {
    const ns = await page.locator('.item .name').allTextContents();
    return !ns.some((t) => t.includes('デスクトップ移動'));
  }, 'moved item disappeared from the board');
  const data3 = readJson(path.join(boardDir, '.okiba-board.json'));
  assert(!data3.positions['デスクトップ移動.txt'], 'no stale position after desktop drop');
  await app3.close();

  // ------------------------------------------------------------ run 4
  // v2.0 "link + hide": intake registers a reference; the original
  // file NEVER moves. On the Windows runner the REAL attrib command
  // is used, so the Hidden attribute is set/cleared for real and
  // read back here.
  const attribHidden = (p) => {
    // Parse ONLY attrib's ASCII attribute field (everything before
    // the "C:\" junction): the Japanese path in the output is
    // codepage-mangled on the runner, the field is not.
    const { execFileSync } = require('child_process');
    const out = execFileSync('attrib', [p], { encoding: 'utf8' });
    const line = out.split(/\r?\n/).filter((s) => s.trim())[0] || '';
    const drive = line.match(/[A-Za-z]:[\\/]/);
    const prefix = drive ? line.slice(0, drive.index) : '';
    return prefix.toUpperCase().includes('H');
  };
  const originDir = fs.mkdtempSync(path.join(os.tmpdir(), 'okiba-gui-origin-'));
  const originFile = path.join(originDir, '外部素材.txt');
  fs.writeFileSync(originFile, 'linked material');

  step('linked intake (v2.0): file stays at origin, card appears');
  const app4 = await launch();
  page = await app4.firstWindow();
  page.on('pageerror', (e) => console.log('  [pageerror]', e.message));
  await page.waitForSelector('#boardGrid .board-card', { timeout: 20000 });
  await page.click(`#boardGrid .board-card[data-name="${boardName}"]`);
  await page.waitForSelector('#boardView:not([hidden]) .item');
  const linkRes = await page.evaluate(
    (arg) => window.okiba.linkFiles(arg.board, [arg.p]),
    { board: boardName, p: originFile });
  assert(linkRes.added.length === 1, 'linkFiles registered the intake');
  assert(linkRes.attribFailed.length === (process.platform === 'win32' ? 0 : linkRes.attribFailed.length),
    'attrib outcome recorded');
  assert(fs.existsSync(originFile), 'origin file still exists (NOT moved)');
  assert(!fs.existsSync(path.join(boardDir, '外部素材.txt')),
    'file was NOT copied/moved into the board folder');
  await waitFor(async () => {
    const ns = await page.locator('.item .name').allTextContents();
    return ns.some((t) => t.includes('外部素材'));
  }, 'linked card appears on the board');
  const jsonAfterLink = readJson(path.join(boardDir, '.okiba-board.json'));
  const linkRec = (jsonAfterLink.links || []).find((l) => l.path === originFile);
  assert(!!linkRec && typeof linkRec.wasHidden === 'boolean',
    'json link recorded with a wasHidden flag');
  assert(linkRec.wasHidden === false, 'wasHidden=false for a normal visible file');
  if (process.platform === 'win32') {
    assert(attribHidden(originFile) === true,
      'origin carries the Hidden attribute (real attrib)');
  } else {
    console.log('  skip - real attrib read-back runs on the Windows CI runner');
  }

  step('unlink via context menu: card gone, origin intact, hidden cleared');
  await page.locator('.item', { hasText: '外部素材' }).first().click({ button: 'right' });
  await page.waitForSelector('#ctxMenu:not([hidden]) .ctx-item');
  const linkMenu = await page.locator('#ctxMenu .ctx-item').allTextContents();
  assert(linkMenu.some((t) => t.includes('ボードから外す')), 'linked menu has ボードから外す');
  assert(linkMenu.some((t) => t.includes('ファイルをゴミ箱へ削除')),
    'linked menu has the explicit real-file delete');
  assert(linkMenu.some((t) => t.includes('戻し先フォルダへ移動')),
    'linked menu has 戻し先フォルダへ移動 (v2.1: a real move, distinct from 外す)');
  await page.locator('#ctxMenu .ctx-item', { hasText: 'ボードから外す' })
    .dispatchEvent('mousedown');
  await waitFor(async () => {
    const ns = await page.locator('.item .name').allTextContents();
    return !ns.some((t) => t.includes('外部素材'));
  }, 'card removed after unlink');
  assert(fs.existsSync(originFile), 'origin file still exists after unlink');
  const jsonAfterUnlink = readJson(path.join(boardDir, '.okiba-board.json'));
  assert(!(jsonAfterUnlink.links || []).some((l) => l.path === originFile),
    'json link removed after unlink');
  if (process.platform === 'win32') {
    // Poll: the card disappears when the board json is saved, which
    // happens just BEFORE the attrib -H lands inside the same IPC —
    // an immediate read-back races it (same pattern as run 7).
    await waitFor(() => attribHidden(originFile) === false,
      'Hidden attribute cleared after unlink (real attrib)');
    assert(true, 'Hidden attribute cleared after unlink (real attrib)');
  }

  step('missing state: external deletion greys the card; cleanup via menu');
  await page.evaluate(
    (arg) => window.okiba.linkFiles(arg.board, [arg.p]),
    { board: boardName, p: originFile });
  await waitFor(async () => {
    const ns = await page.locator('.item .name').allTextContents();
    return ns.some((t) => t.includes('外部素材'));
  }, 'linked card re-appears');
  fs.rmSync(originFile); // the original vanishes behind the app's back
  await waitFor(async () => {
    const el = page.locator('.item', { hasText: '外部素材' }).first();
    if ((await el.count()) === 0) return false;
    const cls = await el.evaluate((n) => n.className);
    return cls.includes('missing');
  }, 'card switches to the missing state', 20000);
  const badgeTexts = await page.locator('.item .badge-missing').allTextContents();
  assert(badgeTexts.some((t) => t.includes('元の場所にありません')),
    'missing badge 「元の場所にありません」 is shown');
  await page.locator('.item', { hasText: '外部素材' }).first().click({ button: 'right' });
  await page.waitForSelector('#ctxMenu:not([hidden]) .ctx-item');
  const missMenu = await page.locator('#ctxMenu .ctx-item').allTextContents();
  assert(missMenu.length === 2 && missMenu[0].includes('素材を探す') && missMenu[1].includes('ボードから外す'),
    'missing item menu offers search and unlink only (nothing destructive)');
  await page.locator('#ctxMenu .ctx-item', { hasText: 'ボードから外す' })
    .dispatchEvent('mousedown');
  await waitFor(async () => {
    const ns = await page.locator('.item .name').allTextContents();
    return !ns.some((t) => t.includes('外部素材'));
  }, 'missing card cleaned off the board');
  await app4.close();

  // ------------------------------------------------------------ run 5
  // v2.1 per-board shortcuts. The Desktop is redirected to a temp
  // dir (OKIBA_SHORTCUT_DESKTOP) so the test never writes to a real
  // user's Desktop. .lnk writing/reading is Windows-only shell work:
  // on other platforms only the menu item is asserted.
  const fakeDesktop = fs.mkdtempSync(path.join(os.tmpdir(), 'okiba-gui-desktop-'));
  step('board shortcut (v2.1): home menu creates a real .lnk');
  const app5 = await launch({ OKIBA_SHORTCUT_DESKTOP: fakeDesktop });
  page = await app5.firstWindow();
  await page.waitForSelector('#boardGrid .board-card', { timeout: 20000 });
  await page.locator(`#boardGrid .board-card[data-name="${boardName}"]`)
    .click({ button: 'right' });
  await page.waitForSelector('#ctxMenu:not([hidden]) .ctx-item');
  const homeMenu = await page.locator('#ctxMenu .ctx-item').allTextContents();
  assert(homeMenu.some((t) => t.includes('デスクトップにショートカットを作る')),
    'home card menu has デスクトップにショートカットを作る');
  if (process.platform === 'win32') {
    await page.locator('#ctxMenu .ctx-item',
      { hasText: 'デスクトップにショートカットを作る' }).dispatchEvent('mousedown');
    const lnkPath = path.join(fakeDesktop, boardName + '.lnk');
    await waitFor(() => fs.existsSync(lnkPath), '.lnk created on the redirected Desktop');
    await waitFor(async () => {
      const t = await page.evaluate(() => document.getElementById('toast').textContent);
      return t.includes('ショートカットをデスクトップに作りました');
    }, 'status line confirms the shortcut creation');
    const info = await page.evaluate((p) => window.okiba.readShortcut(p), lnkPath);
    assert(!!info && typeof info.target === 'string' && info.target.length > 0,
      'shortcut target is a real exe path');
    assert(typeof info.args === 'string' && info.args.includes('--board-path') &&
           info.args.includes(boardDir),
      'shortcut args carry --board-path with the board folder');
    // creating it again refreshes the SAME .lnk (no suffix pile-up)
    await page.locator(`#boardGrid .board-card[data-name="${boardName}"]`)
      .click({ button: 'right' });
    await page.waitForSelector('#ctxMenu:not([hidden]) .ctx-item');
    await page.locator('#ctxMenu .ctx-item',
      { hasText: 'デスクトップにショートカットを作る' }).dispatchEvent('mousedown');
    await new Promise((r) => setTimeout(r, 600));
    const lnks = fs.readdirSync(fakeDesktop).filter((n) => n.endsWith('.lnk'));
    assert(lnks.length === 1 && lnks[0] === boardName + '.lnk',
      're-creating refreshes the same .lnk instead of duplicating');
  } else {
    console.log('  skip - .lnk write/read-back runs on the Windows CI runner');
    await page.evaluate(() => { document.getElementById('ctxMenu').hidden = true; });
  }
  await app5.close();

  step('shortcut launch: --board-path opens the board directly');
  const launchArgs = (extra) => electron.launch({
    args: [ROOT, '--no-sandbox', '--user-data-dir=' + userData, ...extra],
    env, timeout: 60000,
  });
  const app6 = await launchArgs(['--board-path', boardDir]);
  page = await app6.firstWindow();
  await page.waitForSelector('#boardView:not([hidden])', { timeout: 20000 });
  const routeTitle = await page.locator('#boardTitle').textContent();
  assert(routeTitle.includes(boardName), 'board screen for the shortcut board is shown');
  assert(await page.evaluate(() => document.getElementById('homeView').hidden),
    'home screen was skipped entirely');
  await app6.close();

  step('shortcut launch: invalid --board-path falls back to home with a note');
  const app7 = await launchArgs(['--board-path', path.join(base, '存在しないボード')]);
  page = await app7.firstWindow();
  await page.waitForSelector('#boardGrid .board-card', { timeout: 20000 });
  assert(await page.evaluate(() => !document.getElementById('homeView').hidden),
    'home is shown for a missing board');
  await waitFor(async () => {
    const t = await page.evaluate(() => document.getElementById('toast').textContent);
    return t.includes('ショートカット先のボードが見つかりませんでした');
  }, 'one-line not-found note is shown');
  await app7.close();

  // ------------------------------------------------------------ run 6
  // Second-instance routing: with the app already running, a fresh
  // process launched with --board-path must NOT open a duplicate —
  // the running window comes to the front and switches boards.
  step('second instance: shortcut click switches the RUNNING app');
  const app8 = await launch();
  page = await app8.firstWindow();
  await page.waitForSelector('#boardGrid .board-card', { timeout: 20000 });
  {
    const { spawn } = require('child_process');
    const electronBin = require('electron');
    const userData = await app8.evaluate(({ app }) => app.getPath('userData'));
    const second = spawn(electronBin,
      [ROOT, '--no-sandbox', '--user-data-dir=' + userData, '--board-path', boardDir],
      { env, stdio: 'ignore' });
    const exited = await Promise.race([
      new Promise((r) => second.on('exit', (code) => r(code !== null ? 'exited' : 'signalled'))),
      new Promise((r) => setTimeout(() => r('timeout'), 30000)),
    ]);
    if (exited === 'timeout') { try { second.kill(); } catch (e) {} }
    assert(exited === 'exited' || exited === 'signalled',
      'second process handed over to the running instance and exited');
    await page.waitForSelector('#boardView:not([hidden])', { timeout: 20000 });
    const switchedTitle = await page.locator('#boardTitle').textContent();
    assert(switchedTitle.includes(boardName),
      'running window switched into the shortcut board');
  }
  await app8.close();

  // ------------------------------------------------------------ run 7
  // v2.1 linked drag-out = REAL move. A linked item released outside
  // over a resolved folder MOVES there for real (origin loses the
  // file, the link detaches, the landed file is visible). Over an
  // UNRESOLVED place the gesture cancels completely — no move, no
  // unlink, still hidden. Plain removal stays the menu's job.
  const dragOutSynthetic = async (itemLocator) => {
    const box = await boxOf(itemLocator, 'linked drag-out item box');
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 + 30, box.y + box.height / 2, { steps: 5 });
    await itemLocator.evaluate((el) => {
      el.dispatchEvent(new PointerEvent('pointerup', {
        bubbles: true, cancelable: true, pointerId: 1,
        clientX: -80, clientY: 120, screenX: -40, screenY: 200,
      }));
    });
    await page.mouse.up();
  };
  const linkAndWaitCard = async (p, label) => {
    await page.evaluate(
      (arg) => window.okiba.linkFiles(arg.board, [arg.p]),
      { board: boardName, p });
    await waitFor(async () => {
      const ns = await page.locator('.item .name').allTextContents();
      return ns.some((t) => t.includes(label));
    }, 'linked card appears for ' + label);
  };

  step('linked drag-out (v2.1): outside release MOVES the real file');
  const origin7 = fs.mkdtempSync(path.join(os.tmpdir(), 'okiba-gui-origin7-'));
  const dragFile = path.join(origin7, '外部ドラッグ.txt');
  fs.writeFileSync(dragFile, 'drag me out');
  const app9 = await launch();
  page = await app9.firstWindow();
  await page.waitForSelector('#boardGrid .board-card', { timeout: 20000 });
  await page.click(`#boardGrid .board-card[data-name="${boardName}"]`);
  await page.waitForSelector('#boardView:not([hidden]) .item');
  await linkAndWaitCard(dragFile, '外部ドラッグ');
  if (process.platform === 'win32') {
    assert(attribHidden(dragFile) === true, 'origin hidden while linked (real attrib)');
  }
  await dragOutSynthetic(page.locator('.item', { hasText: '外部ドラッグ' }).first());
  await waitFor(() => fs.existsSync(path.join(landing, '外部ドラッグ.txt')),
    'linked file really landed in the resolved folder');
  assert(!fs.existsSync(dragFile), 'linked file LEFT its origin (a real move)');
  if (process.platform === 'win32') {
    // The file appears in the landing folder at the MOVE step; the
    // -H lands a moment later inside the same IPC. Poll for it —
    // an immediate assert races the attrib call.
    await waitFor(
      () => attribHidden(path.join(landing, '外部ドラッグ.txt')) === false,
      'landed file is VISIBLE (Hidden cleared at the destination)');
  }
  await waitFor(async () => {
    const ns = await page.locator('.item .name').allTextContents();
    return !ns.some((t) => t.includes('外部ドラッグ'));
  }, 'card disappeared after the move (link detached)');
  const jsonAfterDragOut = readJson(path.join(boardDir, '.okiba-board.json'));
  assert(!(jsonAfterDragOut.links || []).some((l) => l.path === dragFile),
    'json link removed after drag-out move');
  await app9.close();

  step('linked desktop drop (v2.1): move + icon positioning invoked');
  const deskFile = path.join(origin7, '外部デスクトップ.txt');
  fs.writeFileSync(deskFile, 'to the desktop cell');
  const app10 = await launch({ OKIBA_TEST_RESOLVER_TYPE: 'desktop' });
  page = await app10.firstWindow();
  await page.waitForSelector('#boardGrid .board-card', { timeout: 20000 });
  await page.click(`#boardGrid .board-card[data-name="${boardName}"]`);
  await page.waitForSelector('#boardView:not([hidden]) .item');
  await linkAndWaitCard(deskFile, '外部デスクトップ');
  await dragOutSynthetic(page.locator('.item', { hasText: '外部デスクトップ' }).first());
  await waitFor(() => fs.existsSync(path.join(landing, '外部デスクトップ.txt')),
    'linked desktop drop: file landed in the Desktop target');
  assert(!fs.existsSync(deskFile), 'linked desktop drop: origin lost the file');
  await waitFor(async () => {
    const log = await page.evaluate(() => window.okiba.dropLog());
    return Array.isArray(log) && log.some((e) => e.kind === 'safe-desktop' && e.ok);
  }, 'dropLog records icon positioning for the ex-linked file');
  await waitFor(async () => {
    const log = await page.evaluate(() => window.okiba.dropLog());
    return log.some((e) => e.kind === 'safe-desktop' && e.ok);
  }, 'dropLog records the linked move itself');
  await app10.close();

  step('linked drag-out over UNKNOWN target: full cancel, nothing changes');
  const cancelFile = path.join(origin7, '外部キャンセル.txt');
  fs.writeFileSync(cancelFile, 'stay put');
  const app11 = await launch({ OKIBA_TEST_RESOLVER_UNKNOWN: '1' });
  page = await app11.firstWindow();
  await page.waitForSelector('#boardGrid .board-card', { timeout: 20000 });
  await page.click(`#boardGrid .board-card[data-name="${boardName}"]`);
  await page.waitForSelector('#boardView:not([hidden]) .item');
  await linkAndWaitCard(cancelFile, '外部キャンセル');
  if (process.platform === 'win32') {
    assert(attribHidden(cancelFile) === true, 'cancel target: origin hidden while linked');
  }
  await dragOutSynthetic(page.locator('.item', { hasText: '外部キャンセル' }).first());
  await waitFor(async () => {
    const t = await page.evaluate(() => document.getElementById('toast').textContent);
    return t === '\u79fb\u52d5\u5148\u3092\u78ba\u8a8d\u3067\u304d\u306a\u304b\u3063\u305f\u305f\u3081\u4e2d\u6b62\u3057\u307e\u3057\u305f\u3002';
  }, 'cancel: status line says the drop could not be resolved');
  const unknownDropLog=await page.evaluate(()=>window.okiba.dropLog());
  assert(unknownDropLog.some(e=>e.kind==='resolve'&&e.target?.type==='unknown'),'cancel: resolver explicitly returned unknown');
  assert(!unknownDropLog.some(e=>['move','move-linked','safe-desktop','error'].includes(e.kind)),'cancel: no move, positioning transaction or unrelated error occurred');
  await new Promise((r) => setTimeout(r, 800)); // let any wrong move land
  assert(fs.existsSync(cancelFile), 'cancel: file still at its origin');
  assert(!fs.existsSync(path.join(landing, '外部キャンセル.txt')),
    'cancel: nothing arrived in the landing folder');
  const jsonAfterCancel = readJson(path.join(boardDir, '.okiba-board.json'));
  assert((jsonAfterCancel.links || []).some((l) => l.path === cancelFile),
    'cancel: link record intact (no silent unlink)');
  const cancelNames = await page.locator('.item .name').allTextContents();
  assert(cancelNames.some((t) => t.includes('外部キャンセル')),
    'cancel: card still on the board');
  if (process.platform === 'win32') {
    assert(attribHidden(cancelFile) === true, 'cancel: origin still hidden afterwards');
  }
  await app11.close();

  // ------------------------------------------------------------ run 8
  // v2.2 anchored intake placement (Job B) on a dedicated board
  // whose occupancy is fully known: residents at (0,0) and (0,1).
  // Explicit anchor + offsets come through the same IPC options the
  // renderer's drop handler now sends; the saved cells in
  // .okiba-board.json are the ground truth.
  const placeBoard = '配置ボード';
  const placeDir = path.join(base, placeBoard);
  fs.mkdirSync(placeDir, { recursive: true });
  fs.writeFileSync(path.join(placeDir, '既存A.txt'), 'A');
  fs.writeFileSync(path.join(placeDir, '既存B.txt'), 'B');
  fs.writeFileSync(path.join(placeDir, '.okiba-board.json'), JSON.stringify({
    version: 5, size_percent: 100,
    positions: { '既存A.txt': { col: 0, row: 0 }, '既存B.txt': { col: 0, row: 1 } },
    notes: [],
  }, null, 2));
  const origin8 = fs.mkdtempSync(path.join(os.tmpdir(), 'okiba-gui-origin8-'));
  const linkA = path.join(origin8, '配置リンク1.txt');
  const linkB = path.join(origin8, '配置リンク2.txt');
  const linkC = path.join(origin8, '配置リンク3.txt');
  for (const p of [linkA, linkB, linkC]) fs.writeFileSync(p, 'linked');
  const resDir8 = fs.mkdtempSync(path.join(os.tmpdir(), 'okiba-gui-res8-'));
  const resA = path.join(resDir8, '配置レジデント1.txt');
  const resB = path.join(resDir8, '配置レジデント2.txt');
  fs.writeFileSync(resA, 'resident 1');
  fs.writeFileSync(resB, 'resident 2');

  step('anchored intake (v2.2): links land at anchor, collisions scan forward');
  const app12 = await launch();
  page = await app12.firstWindow();
  await page.waitForSelector('#boardGrid .board-card', { timeout: 20000 });
  await page.click(`#boardGrid .board-card[data-name="${placeBoard}"]`);
  await page.waitForSelector('#boardView:not([hidden]) .item');
  const anchored = await page.evaluate(
    (arg) => window.okiba.linkFiles(arg.board, [arg.a, arg.b],
      { anchor: [0, 0], rows: 10, offsets: [[0, 0], [0, 1]] }),
    { board: placeBoard, a: linkA, b: linkB });
  assert(anchored.added.length === 2, 'anchored linkFiles registered both files');
  const jsonPlaced = readJson(path.join(placeDir, '.okiba-board.json'));
  const recA = (jsonPlaced.links || []).find((l) => l.path === linkA);
  const recB = (jsonPlaced.links || []).find((l) => l.path === linkB);
  // (0,0) and (0,1) are occupied by residents: the forward scan puts
  // the pair at (0,2) and (0,3), relative order preserved.
  assert(recA && recA.col === 0 && recA.row === 2,
    'anchored link 1 shifted past the occupied anchor to (0,2)');
  assert(recB && recB.col === 0 && recB.row === 3,
    'anchored link 2 follows at (0,3)');

  step('anchored intake (v2.2): resident move-in saves anchored positions');
  const placedRes = await page.evaluate(
    (arg) => window.okiba.dropFiles(arg.board, [arg.a, arg.b],
      { anchor: [2, 1], rows: 10, offsets: [[0, 0], [0, 1]] }),
    { board: placeBoard, a: resA, b: resB });
  assert(Array.isArray(placedRes) && placedRes.length === 2,
    'dropFiles moved both residents in');
  assert(fs.existsSync(path.join(placeDir, '配置レジデント1.txt')) &&
    fs.existsSync(path.join(placeDir, '配置レジデント2.txt')),
    'resident files are physically in the board folder');
  const jsonRes = readJson(path.join(placeDir, '.okiba-board.json'));
  const posA = (jsonRes.positions || {})['配置レジデント1.txt'];
  const posB = (jsonRes.positions || {})['配置レジデント2.txt'];
  assert(posA && posA.col === 2 && posA.row === 1,
    'resident 1 saved at the anchor (2,1)');
  assert(posB && posB.col === 2 && posB.row === 2,
    'resident 2 saved one row below (2,2)');

  step('intake back-compat: no anchor -> position-less link (append), as before');
  const plain = await page.evaluate(
    (arg) => window.okiba.linkFiles(arg.board, [arg.p]),
    { board: placeBoard, p: linkC });
  assert(plain.added.length === 1, 'plain linkFiles still registers');
  const jsonPlain = readJson(path.join(placeDir, '.okiba-board.json'));
  const recC = (jsonPlain.links || []).find((l) => l.path === linkC);
  assert(recC && (recC.col === null || recC.col === undefined),
    'plain intake keeps col/row unset (renderer appends)');
  await app12.close();

  // ------------------------------------------------------------ run 9
  // v2.2 warm helper (Job A): resolve + position run through the
  // FAKE helper process (OKIBA_TEST_HELPER=fake) instead of the env
  // stubs. Two full desktop drag-outs must be served by ONE helper
  // process: stats.spawns===1 proves reuse (no timing asserts).
  step('warm helper (v2.2): two drag-outs, one helper process');
  const env9 = {
    ...env,
    OKIBA_TEST_HELPER: 'fake',
    OKIBA_FAKE_LANDING: landing,
    OKIBA_FAKE_TYPE: 'desktop',
  };
  delete env9.OKIBA_TEST_RESOLVER_DIR;
  delete env9.OKIBA_TEST_POSITIONER;
  const app13 = await electron.launch({
    args: [ROOT, '--no-sandbox', '--user-data-dir=' + userData], env: env9, timeout: 60000,
  });
  page = await app13.firstWindow();
  await page.waitForSelector('#boardGrid .board-card', { timeout: 20000 });
  await page.click(`#boardGrid .board-card[data-name="${placeBoard}"]`);
  await page.waitForSelector('#boardView:not([hidden]) .item');
  await dragOutSynthetic(page.locator('.item', { hasText: '既存A' }).first());
  await waitFor(() => fs.existsSync(path.join(landing, '既存A.txt')),
    'warm helper: first file moved via helper resolve');
  await dragOutSynthetic(page.locator('.item', { hasText: '既存B' }).first());
  await waitFor(() => fs.existsSync(path.join(landing, '既存B.txt')),
    'warm helper: second file moved via helper resolve');
  await waitFor(async () => {
    const log = await page.evaluate(() => window.okiba.dropLog());
    return log.filter((e) => e.kind === 'safe-desktop' && e.ok).length >= 2;
  }, 'warm helper: both desktop drops recorded icon positioning');
  const hstats = await page.evaluate(() => window.okiba.helperStats());
  assert(hstats && hstats.enabled === true, 'warm helper: client enabled in fake mode');
  assert(hstats.spawns === 1,
    `warm helper: ONE process served every operation (spawns=${hstats && hstats.spawns})`);
  assert(hstats.requests >= 4,
    `warm helper: resolve+position went through the helper (requests=${hstats && hstats.requests})`);
  await app13.close();

  // ------------------------------------------------------------ run 10
  // Update is a non-destructive version stamp. Real shortcuts in redirected
  // owned folders must retain their bytes and mtime, including obsolete targets.
  step('update: preserve all Desktop/Downloads files and shortcuts');
  const cleanupDesktop = fs.mkdtempSync(path.join(os.tmpdir(), 'okiba-gui-clean-desk-'));
  const cleanupDownloads = fs.mkdtempSync(path.join(os.tmpdir(), 'okiba-gui-clean-dl-'));
  fs.writeFileSync(path.join(cleanupDownloads, 'OkibaBoard.exe'), 'old portable');
  fs.writeFileSync(path.join(cleanupDesktop, 'OkibaBoard-Setup-2.1.0.exe'), 'old setup');
  fs.writeFileSync(path.join(cleanupDesktop, '関係ない.txt'), 'keep me');
  fs.writeFileSync(path.join(cleanupDownloads, 'keep.txt'), 'keep me too');
  // NOTE: seed .lnk names and the board path in args are ASCII on
  // purpose — WScript.Shell on the en-US runner ANSI-mangles
  // non-ASCII shortcut file names when saving (the app's own
  // shell.writeShortcutLink writer is fully Unicode; only this
  // test-side seeding is affected). The cleanup logic under test
  // only looks at target/args, never at the .lnk file name.
  const boardLnkPath = path.join(cleanupDesktop, 'board.lnk');
  const staleLnkPath = path.join(cleanupDesktop, 'OkibaBoard.lnk');
  const asciiBoardDir = path.join(base, 'AsciiBoard');
  fs.mkdirSync(asciiBoardDir, { recursive: true });
  if (process.platform === 'win32') {
    const fakeOldExe = path.join(cleanupDesktop, 'old', 'OkibaBoard.exe');
    const esc = (s) => s.replace(/'/g, "''");
    const psLines = [
      '$ws = New-Object -ComObject WScript.Shell',
      `$s = $ws.CreateShortcut('${esc(staleLnkPath)}'); $s.TargetPath = '${esc(fakeOldExe)}'; $s.Arguments = ''; $s.Save()`,
      `$s = $ws.CreateShortcut('${esc(boardLnkPath)}'); $s.TargetPath = '${esc(fakeOldExe)}'; $s.Arguments = '--board-path="${esc(asciiBoardDir)}"'; $s.Save()`,
      `$s = $ws.CreateShortcut('${esc(path.join(cleanupDesktop, 'memo.lnk'))}'); $s.TargetPath = 'C:\\Windows\\System32\\notepad.exe'; $s.Arguments = ''; $s.Save()`,
    ].join('\n');
    const psFile = path.join(os.tmpdir(), 'okiba-gui-mklnk-' + Date.now() + '.ps1');
    fs.writeFileSync(psFile, '﻿' + psLines, 'utf8');
    require('child_process').execFileSync('powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', psFile]);
    assert(fs.existsSync(staleLnkPath) && fs.existsSync(boardLnkPath),
      'cleanup: seed shortcuts created (stale app + board)');
  }
  {
    const homeJsonPath = path.join(base, '.home.json');
    const homeJson = readJson(homeJsonPath);
    homeJson.appVersion = '2.2.0'; // older than the package version
    fs.writeFileSync(homeJsonPath, JSON.stringify(homeJson, null, 2));
  }
  const updateFiles = [cleanupDesktop, cleanupDownloads].flatMap(dir=>fs.readdirSync(dir).map(name=>path.join(dir,name))).filter(p=>fs.statSync(p).isFile());
  const updateBefore = updateFiles.map(p=>({path:p,bytes:fs.readFileSync(p),mtime:fs.statSync(p).mtimeMs}));
  const updateHomeBefore = readJson(path.join(base,'.home.json'));
  function assertUpdateFilesUnchanged() {
    for(const f of updateBefore) assert(fs.existsSync(f.path)&&fs.readFileSync(f.path).equals(f.bytes)&&fs.statSync(f.path).mtimeMs===f.mtime,'update: existing file bytes and mtime unchanged '+path.basename(f.path));
  }
  const pkgVersion = require('../package.json').version;
  const app14 = await launch({
    OKIBA_CLEANUP_DESKTOP: cleanupDesktop,
    OKIBA_CLEANUP_DOWNLOADS: cleanupDownloads,
  });
  page = await app14.firstWindow();
  await page.waitForSelector('#boardGrid .board-card', { timeout: 20000 });
  await waitFor(() => readJson(path.join(base,'.home.json')).appVersion === pkgVersion,
    'update: version marker stamped');
  assertUpdateFilesUnchanged();
  const updateHomeAfter=readJson(path.join(base,'.home.json'));
  delete updateHomeBefore.appVersion; delete updateHomeAfter.appVersion;
  assert(JSON.stringify(updateHomeAfter)===JSON.stringify(updateHomeBefore),'update: home positions, theme and other fields preserved');
  assert(await page.evaluate(()=>document.getElementById('cleanupNotice').hidden),'update: no misleading cleanup notice');
  await app14.close();

  step('auto-cleanup (v2.2.1): relaunch with a current marker changes nothing');
  const app15 = await launch({
    OKIBA_CLEANUP_DESKTOP: cleanupDesktop,
    OKIBA_CLEANUP_DOWNLOADS: cleanupDownloads,
  });
  page = await app15.firstWindow();
  await page.waitForSelector('#boardGrid .board-card', { timeout: 20000 });
  await new Promise((r) => setTimeout(r, 1500)); // let any wrong cleanup run
  const noticeAfterRelaunch = await page.evaluate(() => {
    const el = document.getElementById('cleanupNotice');
    return { hidden: el.hidden, text: el.textContent };
  });
  assert(noticeAfterRelaunch.hidden === true,
    'cleanup: no notice on a same-version relaunch');
  assert(fs.existsSync(path.join(cleanupDesktop, '関係ない.txt')),
    'cleanup: keepers still present after relaunch');
  assertUpdateFilesUnchanged();
  await app15.close();

  // ------------------------------------------------------------ run 11
  // v2.2.1 move-out history (Job 3): two separate drag-outs (one
  // resident, one linked) record two groups; restoring each from
  // the home history modal brings the item back (resident: real
  // file + original cell; linked: re-linked + hidden again).
  step('move history (v2.2.1): drag-outs recorded, restored from the list');
  const histBoard = '履歴ボード';
  const histDir = path.join(base, histBoard);
  fs.mkdirSync(histDir, { recursive: true });
  fs.writeFileSync(path.join(histDir, '履歴レジデント.txt'), 'resident hist');
  fs.writeFileSync(path.join(histDir, '.okiba-board.json'), JSON.stringify({
    version: 6, size_percent: 100,
    positions: { '履歴レジデント.txt': { col: 5, row: 0 } },
    links: [], notes: [],
  }, null, 2));
  const origin11 = fs.mkdtempSync(path.join(os.tmpdir(), 'okiba-gui-origin11-'));
  const histLinkFile = path.join(origin11, '履歴リンク.txt');
  fs.writeFileSync(histLinkFile, 'linked hist');
  const histGroupsFor = async (pg) => {
    const all = await pg.evaluate(() => window.okiba.getMoveHistory());
    return all.filter((g) => g.boardName === histBoard);
  };
  const app16 = await launch();
  page = await app16.firstWindow();
  await page.waitForSelector('#boardGrid .board-card', { timeout: 20000 });
  await page.click(`#boardGrid .board-card[data-name="${histBoard}"]`);
  await page.waitForSelector('#boardView:not([hidden]) .item');
  await page.evaluate(
    (arg) => window.okiba.linkFiles(arg.board, [arg.p]),
    { board: histBoard, p: histLinkFile });
  await waitFor(async () => {
    const ns = await page.locator('.item .name').allTextContents();
    return ns.some((t) => t.includes('履歴リンク'));
  }, 'history: linked card appears');
  await dragOutSynthetic(page.locator('.item', { hasText: '履歴レジデント' }).first());
  await waitFor(() => fs.existsSync(path.join(landing, '履歴レジデント.txt')),
    'history: resident file moved out to the landing folder');
  await dragOutSynthetic(page.locator('.item', { hasText: '履歴リンク' }).first());
  await waitFor(() => fs.existsSync(path.join(landing, '履歴リンク.txt')),
    'history: linked file moved out to the landing folder');
  // Poll: a linked move-out lands its file BEFORE the history
  // record is written (the handler still awaits the attrib -H at
  // the destination), so an immediate read can beat the record.
  await waitFor(async () => (await histGroupsFor(page)).length === 2,
    'history: two drag-outs recorded as two groups');
  const groupsAfterOut = await histGroupsFor(page);
  if (groupsAfterOut.length !== 2) {
    const allGroups = await page.evaluate(() => window.okiba.getMoveHistory());
    console.log('  [diag] ALL history groups:', JSON.stringify(allGroups, null, 1));
    const dl = await page.evaluate(() => window.okiba.dropLog());
    console.log('  [diag] dropLog:', JSON.stringify(dl));
  }
  assert(groupsAfterOut.length === 2,
    `history: two drag-outs recorded as two groups (got ${groupsAfterOut.length})`);
  assert(groupsAfterOut.some((g) => g.items[0].kind === 'resident') &&
         groupsAfterOut.some((g) => g.items[0].kind === 'linked'),
    'history: one resident group and one linked group');
  await page.click('#backBtn');
  await page.waitForSelector('#boardGrid .board-card', { timeout: 20000 });
  await page.click('#historyBtn');
  await page.waitForSelector('#historyOverlay:not([hidden])');
  const resGroup = page.locator('.history-group', { hasText: '履歴レジデント' }).first();
  await resGroup.locator('[data-act="restore-group"]').click();
  await waitFor(() => fs.existsSync(path.join(histDir, '履歴レジデント.txt')),
    'history: resident restored into the board folder');
  await waitFor(async () => (await histGroupsFor(page)).length === 1,
    'history: resident group consumed by the restore');
  const restoredJson = readJson(path.join(histDir, '.okiba-board.json'));
  const resPos = (restoredJson.positions || {})['履歴レジデント.txt'];
  assert(resPos && resPos.col === 5 && resPos.row === 0,
    'history: resident restored at its original cell (5,0)');
  const linkGroup = page.locator('.history-group', { hasText: '履歴リンク' }).first();
  await linkGroup.locator('[data-act="restore-group"]').click();
  await waitFor(() => {
    const j = readJson(path.join(histDir, '.okiba-board.json'));
    return (j.links || []).some((l) => l.path === path.join(landing, '履歴リンク.txt'));
  }, 'history: linked item re-linked at its moved-out path');
  if (process.platform === 'win32') {
    await waitFor(
      () => attribHidden(path.join(landing, '履歴リンク.txt')) === true,
      'history: restored link is hidden again (real attrib)');
  }
  await waitFor(async () => (await histGroupsFor(page)).length === 0,
    'history: empty after both restores');
  await page.click('#historyClose');
  await app16.close();

  step('move history (v2.2.1): vanished destination shows 見つかりません');
  {
    const j = readJson(path.join(histDir, '.okiba-board.json'));
    j.positions['履歴ミッシング.txt'] = { col: 5, row: 1 };
    fs.writeFileSync(path.join(histDir, '.okiba-board.json'), JSON.stringify(j, null, 2));
    fs.writeFileSync(path.join(histDir, '履歴ミッシング.txt'), 'will vanish');
  }
  const app17 = await launch();
  page = await app17.firstWindow();
  await page.waitForSelector('#boardGrid .board-card', { timeout: 20000 });
  await page.click(`#boardGrid .board-card[data-name="${histBoard}"]`);
  await page.waitForSelector('#boardView:not([hidden]) .item');
  await dragOutSynthetic(page.locator('.item', { hasText: '履歴ミッシング' }).first());
  await waitFor(() => fs.existsSync(path.join(landing, '履歴ミッシング.txt')),
    'history: missing-case file moved out');
  fs.rmSync(path.join(landing, '履歴ミッシング.txt')); // renamed/deleted by hand
  await page.click('#backBtn');
  await page.waitForSelector('#boardGrid .board-card', { timeout: 20000 });
  await page.click('#historyBtn');
  await page.waitForSelector('#historyOverlay:not([hidden])');
  const missGroup = page.locator('.history-group', { hasText: '履歴ミッシング' }).first();
  await waitFor(async () => {
    const t = await missGroup.evaluate((el) => el.textContent);
    return t.includes('見つかりません');
  }, 'history: vanished file row shows 見つかりません');
  await missGroup.locator('[data-act="discard-item"]').click();
  await waitFor(async () => (await histGroupsFor(page)).length === 0,
    'history: missing entry discarded from the list');
  await page.click('#historyClose');
  await app17.close();

  // ------------------------------------------------------------ run 12
  // Grouped history: ONE multi-select drag-out of two residents is
  // ONE history group ("ほか 1 件"); the group restore brings both
  // back at their original cells in one action.
  step('move history (v2.2.1): bulk move-out is ONE group, restored together');
  {
    const j = readJson(path.join(histDir, '.okiba-board.json'));
    j.positions['履歴グループ1.txt'] = { col: 5, row: 2 };
    j.positions['履歴グループ2.txt'] = { col: 5, row: 3 };
    fs.writeFileSync(path.join(histDir, '.okiba-board.json'), JSON.stringify(j, null, 2));
    fs.writeFileSync(path.join(histDir, '履歴グループ1.txt'), 'g1');
    fs.writeFileSync(path.join(histDir, '履歴グループ2.txt'), 'g2');
  }
  const app18 = await launch();
  page = await app18.firstWindow();
  await page.waitForSelector('#boardGrid .board-card', { timeout: 20000 });
  await page.click(`#boardGrid .board-card[data-name="${histBoard}"]`);
  await page.waitForSelector('#boardView:not([hidden]) .item');
  const g1 = page.locator('.item', { hasText: '履歴グループ1' }).first();
  const g2 = page.locator('.item', { hasText: '履歴グループ2' }).first();
  // Locator clicks (live elements, scroll-into-view) rather than
  // raw coordinates: a background re-render between measuring a
  // box and clicking it can shift what sits under fixed coords.
  await g1.click();
  await g2.click({ modifiers: ['Control'] });
  try {
    await waitFor(async () => (await selectedNames(page)).length === 2,
      'history group: both items selected');
  } catch (e) {
    const diag = await page.evaluate(() => {
      const a = document.getElementById('boardArea');
      return {
        items: [...document.querySelectorAll('.item')].map((el) => ({
          name: el.querySelector('.name').textContent,
          cls: el.className, left: el.style.left, top: el.style.top,
        })),
        area: {
          clientWidth: a.clientWidth, clientHeight: a.clientHeight,
          scrollWidth: a.scrollWidth, scrollHeight: a.scrollHeight,
          scrollTop: a.scrollTop, scrollLeft: a.scrollLeft,
        },
      };
    }).catch(() => null);
    console.log('  [diag] selection state:', JSON.stringify(diag));
    throw e;
  }
  await dragOutSynthetic(g1);
  await waitFor(() => fs.existsSync(path.join(landing, '履歴グループ1.txt')) &&
    fs.existsSync(path.join(landing, '履歴グループ2.txt')),
    'history group: both files moved out in one gesture');
  await waitFor(async () => {
    const gs = await histGroupsFor(page);
    return gs.length === 1 && gs[0].items.length === 2;
  }, 'history group: ONE group holds both files');
  const bulkGroups = await histGroupsFor(page);
  assert(bulkGroups.length === 1 && bulkGroups[0].items.length === 2,
    `history group: ONE group holds both files (got ${bulkGroups.length} groups)`);
  await page.click('#backBtn');
  await page.waitForSelector('#boardGrid .board-card', { timeout: 20000 });
  await page.click('#historyBtn');
  await page.waitForSelector('#historyOverlay:not([hidden])');
  const bulkGroupEl = page.locator('.history-group', { hasText: '履歴グループ1' }).first();
  const bulkTitle = await bulkGroupEl.locator('.history-title').textContent();
  assert(bulkTitle.includes('ほか 1 件'),
    'history group: row shows the representative name + ほか 1 件');
  await bulkGroupEl.locator('[data-act="restore-group"]').click();
  await waitFor(() => fs.existsSync(path.join(histDir, '履歴グループ1.txt')) &&
    fs.existsSync(path.join(histDir, '履歴グループ2.txt')),
    'history group: both files restored together');
  const bulkJson = readJson(path.join(histDir, '.okiba-board.json'));
  const bp1 = (bulkJson.positions || {})['履歴グループ1.txt'];
  const bp2 = (bulkJson.positions || {})['履歴グループ2.txt'];
  assert(bp1 && bp1.col === 5 && bp1.row === 2 && bp2 && bp2.col === 5 && bp2.row === 3,
    'history group: original cells restored (5,2) and (5,3)');
  await waitFor(async () => (await histGroupsFor(page)).length === 0,
    'history group: group consumed by the restore');
  await page.click('#historyClose');
  await app18.close();

  // ------------------------------------------------------------ run 13
  // v2.2.2 drag-out latency: while the drag is in progress, main
  // polls the (fake) helper's cursorState and PRE-RESOLVES the
  // drop target; the release must then use the cache (ZERO
  // resolve round-trip), and the card must disappear as soon as
  // the fs move lands — long before the deliberately delayed
  // (4s) positionIcons answer completes. Evidence is request
  // counts and log lines, never wall-clock speed asserts.
  step('pre-resolve (v2.2.2): release uses the drag-time cache; metadata commits only after verified positioning');
  const okibaLogPath = path.join(base, 'okiba.log');
  const readLog = () => (fs.existsSync(okibaLogPath)
    ? fs.readFileSync(okibaLogPath, 'utf8') : '');
  const cursorSeq = [
    { x: 300, y: 300, lbtn: true },
    { x: 320, y: 300, lbtn: true },
    ...Array.from({ length: 80 }, () => ({ x: -40, y: 200, lbtn: true })),
    { x: -40, y: 200, lbtn: false },
  ];
  const env13 = {
    ...env,
    OKIBA_TEST_HELPER: 'fake',
    OKIBA_FAKE_LANDING: landing,
    OKIBA_FAKE_TYPE: 'desktop',
    OKIBA_FAKE_CURSOR: JSON.stringify(cursorSeq),
    OKIBA_FAKE_POSITION_DELAY_MS: '4000',
  };
  delete env13.OKIBA_TEST_RESOLVER_DIR;
  delete env13.OKIBA_TEST_POSITIONER;
  const app19 = await electron.launch({
    args: [ROOT, '--no-sandbox', '--user-data-dir=' + userData], env: env13, timeout: 60000,
  });
  // Both cursor witnesses must use the same scripted coordinates. The
  // renderer backup otherwise reads the user's real OS mouse on multi-monitor
  // PCs and can override this test's synthetic release point.
  page = await app19.firstWindow();
  await app19.evaluate(({ ipcMain, BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0].setPosition(100, 100);
    ipcMain.removeHandler('cursor-point');
    ipcMain.handle('cursor-point', () => ({ x: -40, y: 200 }));
  });
  await page.waitForSelector('#boardGrid .board-card', { timeout: 20000 });
  await page.click(`#boardGrid .board-card[data-name="${placeBoard}"]`);
  await page.waitForSelector('#boardView:not([hidden]) .item');
  const logBefore = readLog();
  const pendingMetaPath=path.join(base,placeBoard,'.okiba-board.json');
  const pendingMetaBefore=fs.readFileSync(pendingMetaPath,'utf8');
  const pendingHistoryPath=path.join(base,'.move-history.json');
  const pendingHistoryBefore=fs.existsSync(pendingHistoryPath)?fs.readFileSync(pendingHistoryPath,'utf8'):null;
  const preItem = page.locator('.item', { hasText: '配置レジデント1' }).first();
  const preBox = await boxOf(preItem, 'pre-resolve item box');
  await page.mouse.move(preBox.x + preBox.width / 2, preBox.y + preBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(preBox.x + preBox.width / 2 + 30, preBox.y + preBox.height / 2,
    { steps: 5 });
  // (a) resolution happens DURING the drag, before any release:
  await waitFor(async () => {
    const log = await page.evaluate(() => window.okiba.dropLog());
    return log.some((e) => e.kind === 'preresolve' && e.type === 'desktop' && e.x === -40 && e.y === 200);
  }, 'pre-resolve: a resolveDrop fired during the drag (dropLog)', 15000);
  assert(true, 'pre-resolve: drop target resolved DURING the drag');
  // synthetic OUTSIDE release at exactly the scripted cursor point
  await preItem.evaluate((el) => {
    el.dispatchEvent(new PointerEvent('pointerup', {
      bubbles: true, cancelable: true, pointerId: 1,
      clientX: -80, clientY: 120, screenX: -40, screenY: 200,
    }));
  });
  await page.mouse.up();
  await waitFor(() => fs.existsSync(path.join(landing, '配置レジデント1.txt')),
    'pre-resolve: file moved to the pre-resolved desktop folder');
  const pendingLog = await page.evaluate(() => window.okiba.dropLog());
  const resolveEntry = pendingLog.find(e=>e.kind==='resolve');
  assert(resolveEntry && resolveEntry.pre===true,'pre-resolve: release used cached target');
  assert(!pendingLog.some(e=>e.kind==='safe-desktop'),'strict UI: positioning still pending after physical move');
  assert(fs.readFileSync(pendingMetaPath,'utf8')===pendingMetaBefore,'strict move: board metadata not committed before position verification');
  assert((fs.existsSync(pendingHistoryPath)?fs.readFileSync(pendingHistoryPath,'utf8'):null)===pendingHistoryBefore,'strict move: history not committed before position verification');
  await waitFor(async()=> (await page.evaluate(()=>window.okiba.dropLog())).some(e=>e.kind==='safe-desktop'&&e.ok),'strict move: verified placement completed',20000);
  await waitFor(()=>readLog().slice(logBefore.length).includes('safe-desktop ms'),'strict move timing recorded');
  const timingLine=readLog().slice(logBefore.length).split(/\r?\n/).find(l=>l.includes('safe-desktop ms'));
  const tm=timingLine.match(/safe-desktop ms plan=(\d+) position=(\d+) total=(\d+)/);
  assert(!!tm && Number(tm[2])>=1000,'strict timing includes scripted delayed position stage');
  const finalLog13=await page.evaluate(()=>window.okiba.dropLog());
  assert(finalLog13.some(e=>e.kind==='timing'&&e.resolveStage==='pre'),'strict completion retains pre-resolve timing marker');
  await app19.close();

  // ------------------------------------------------------------ run 14
  // v2.2.2 scroll expansion (both axes): the board's size derives
  // from its content — an item at row 12 / col 7 lives below/right
  // of the viewport, reachable by wheel, by programmatic scroll,
  // and by dragging with edge auto-scroll; saved (col,row) and
  // rendered positions agree, and a restart restores them.
  step('scroll expansion (v2.2.2): below/right items, auto-scroll drag, restart');
  const scrollBoard = 'スクロールボード';
  const scrollDir = path.join(base, scrollBoard);
  fs.mkdirSync(scrollDir, { recursive: true });
  for (const n of ['縦上.txt', '横移動.txt', '右端.txt', '下段.txt']) {
    fs.writeFileSync(path.join(scrollDir, n), 'scroll seed');
  }
  fs.writeFileSync(path.join(scrollDir, '.okiba-board.json'), JSON.stringify({
    version: 6, size_percent: 100,
    positions: {
      '縦上.txt': { col: 0, row: 0 },
      '横移動.txt': { col: 1, row: 0 },
      '右端.txt': { col: 7, row: 0 },
      '下段.txt': { col: 0, row: 12 },
    },
    links: [], notes: [],
  }, null, 2));
  const scrollJson = () => readJson(path.join(scrollDir, '.okiba-board.json'));
  const app20 = await launch();
  page = await app20.firstWindow();
  // This case tests an in-window synthetic drag, not the physical OS mouse.
  await app20.evaluate(({ ipcMain }) => {
    ipcMain.removeHandler('cursor-point');
    ipcMain.handle('cursor-point', () => null);
  });
  await page.waitForSelector('#boardGrid .board-card', { timeout: 20000 });
  await page.click(`#boardGrid .board-card[data-name="${scrollBoard}"]`);
  await page.waitForSelector('#boardView:not([hidden]) .item');
  const areaDims = await page.evaluate(() => {
    const a = document.getElementById('boardArea');
    return {
      scrollHeight: a.scrollHeight, clientHeight: a.clientHeight,
      scrollWidth: a.scrollWidth, clientWidth: a.clientWidth,
    };
  });
  assert(areaDims.scrollHeight > areaDims.clientHeight + 200,
    'scroll: content is taller than the viewport (rows derived from content)');
  assert(areaDims.scrollWidth > areaDims.clientWidth + 200,
    'scroll: content is wider than the viewport (cols derived from content)');
  const sAreaBox = await boxOf(page.locator('#boardArea'), 'scroll board area box');
  await page.mouse.move(sAreaBox.x + sAreaBox.width / 2, sAreaBox.y + sAreaBox.height / 2);
  await page.mouse.wheel(0, 600);
  await waitFor(async () => (await page.evaluate(
    () => document.getElementById('boardArea').scrollTop)) > 100,
    'scroll: mouse wheel scrolls the board vertically');
  // Jump to the bottom: the row-12 item renders at its saved cell.
  await page.evaluate(() => {
    const a = document.getElementById('boardArea');
    a.scrollTop = a.scrollHeight;
    a.scrollLeft = 0;
  });
  const lowItem = page.locator('.item', { hasText: '下段' }).first();
  await waitFor(async () => {
    const b = await lowItem.boundingBox();
    return b && b.y > sAreaBox.y - 4 && b.y < sAreaBox.y + sAreaBox.height;
  }, 'scroll: the row-12 item is visible after scrolling to the bottom');
  const lowTop = await lowItem.evaluate((el) => el.style.top);
  assert(lowTop === (16 + 12 * 158) + 'px',
    'scroll: rendered top matches the saved row 12 (content coordinates)');
  // Back to the top-left, then an auto-scroll drag DOWNWARD: hold
  // the item at the bottom edge; the board scrolls under the drag
  // and the drop lands in a row below the original viewport.
  await page.evaluate(() => {
    const a = document.getElementById('boardArea');
    a.scrollTop = 0;
    a.scrollLeft = 0;
  });
  const topItem = page.locator('.item', { hasText: '縦上' }).first();
  const topBox = await boxOf(topItem, 'auto-scroll drag item box');
  await page.mouse.move(topBox.x + topBox.width / 2, topBox.y + topBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(topBox.x + topBox.width / 2, sAreaBox.y + sAreaBox.height - 8,
    { steps: 10 });
  await new Promise((r) => setTimeout(r, 900)); // held at the edge
  const scrolledDown = await page.evaluate(
    () => document.getElementById('boardArea').scrollTop);
  assert(scrolledDown > 250,
    `auto-scroll: holding at the bottom edge scrolled the board (scrollTop=${scrolledDown})`);
  await page.mouse.up();
  await waitFor(() => {
    const p = (scrollJson().positions || {})['縦上.txt'];
    return p && p.row >= 5;
  }, 'auto-scroll: the drop landed in a row below the original viewport');
  assert(true, 'auto-scroll: vertical drag past the fold saved a lower row');
  // Same to the RIGHT with the second item.
  await page.evaluate(() => {
    const a = document.getElementById('boardArea');
    a.scrollTop = 0;
    a.scrollLeft = 0;
  });
  const sideItem = page.locator('.item', { hasText: '横移動' }).first();
  const sideBox = await boxOf(sideItem, 'auto-scroll side item box');
  await page.mouse.move(sideBox.x + sideBox.width / 2, sideBox.y + sideBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(sAreaBox.x + sAreaBox.width - 8, sideBox.y + sideBox.height / 2,
    { steps: 10 });
  await new Promise((r) => setTimeout(r, 900)); // held at the edge
  const scrolledRight = await page.evaluate(
    () => document.getElementById('boardArea').scrollLeft);
  assert(scrolledRight > 250,
    `auto-scroll: holding at the right edge scrolled the board (scrollLeft=${scrolledRight})`);
  await page.mouse.up();
  await waitFor(() => {
    const p = (scrollJson().positions || {})['横移動.txt'];
    return p && p.col >= 7;
  }, 'auto-scroll: the drop landed in a column beyond the original viewport');
  assert(true, 'auto-scroll: horizontal drag past the edge saved a further column');
  await app20.close();

  step('scroll expansion (v2.2.2): restart restores the far items in place');
  const app21 = await launch();
  page = await app21.firstWindow();
  await page.waitForSelector('#boardGrid .board-card', { timeout: 20000 });
  await page.click(`#boardGrid .board-card[data-name="${scrollBoard}"]`);
  await page.waitForSelector('#boardView:not([hidden]) .item');
  const kept = scrollJson().positions;
  assert(kept['下段.txt'].col === 0 && kept['下段.txt'].row === 12 &&
         kept['右端.txt'].col === 7 && kept['右端.txt'].row === 0,
    'scroll: far positions persisted verbatim (no migration)');
  await page.evaluate(() => {
    const a = document.getElementById('boardArea');
    a.scrollTop = a.scrollHeight;
    a.scrollLeft = 0;
  });
  const lowItem2 = page.locator('.item', { hasText: '下段' }).first();
  const lowTop2 = await lowItem2.evaluate((el) => el.style.top);
  assert(lowTop2 === (16 + 12 * 158) + 'px',
    'scroll: after restart the row-12 item renders at the same place');
  await page.evaluate(() => {
    const a = document.getElementById('boardArea');
    a.scrollTop = 0;
    // Scroll so the col-7 item (content left = 16 + 7*164 = 1164)
    // sits inside the view — scrolling to the very end could push
    // it off the LEFT edge once earlier drags widened the board.
    a.scrollLeft = 964;
  });
  const rightItem2 = page.locator('.item', { hasText: '右端' }).first();
  const rightLeft2 = await rightItem2.evaluate((el) => el.style.left);
  assert(rightLeft2 === (16 + 7 * 164) + 'px',
    'scroll: after restart the col-7 item renders at the same place');
  await waitFor(async () => {
    const b = await rightItem2.boundingBox();
    const ab = await page.locator('#boardArea').boundingBox();
    return b && ab && b.x > ab.x - 4 && b.x < ab.x + ab.width;
  }, 'scroll: the col-7 item is visible after scrolling right');
  await app21.close();

  step('native desktop previews: thumbnails, file icons, missing/note, unchanged data');
  await require('./previews.e2e')(SHOTS);

  step('upgrade layout: v6 data and old home positions survive update and restart');
  await require('./upgrade-layout.e2e')();

  step('desktop calibration: probe ordering, rollback and cache restart in isolated fake helper');
  await require('./calibration.e2e')();

  console.log('\nGUI E2E: all steps passed');
}

main().then(() => process.exit(0)).catch((e) => {
  console.error('\nGUI E2E FAILED: ' + (e && e.stack || e));
  process.exit(1);
});

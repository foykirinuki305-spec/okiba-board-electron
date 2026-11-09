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
 *   -> context-menu trash uses the real shell.trashItem (Windows)
 *   -> restart restores boards, positions (incl. group), percent,
 *      theme
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
    },
    notes: [],
  }, null, 2));

  // Stub drop-target folder for the v1.2 drag-out resolver: main's
  // resolve step is replaced by this folder; the MOVE itself is real.
  const landing = fs.mkdtempSync(path.join(os.tmpdir(), 'okiba-gui-landing-'));

  const env = {
    ...process.env,
    OKIBA_BASE: base,
    OKIBA_OLD_BASE: oldBase,
    OKIBA_TEST_RESOLVER_DIR: landing,
    OKIBA_TEST_HOOKS: '1',
    ELECTRON_DISABLE_SECURITY_WARNINGS: '1',
  };
  const launch = () => electron.launch({
    args: [ROOT, '--no-sandbox'],
    env,
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
  assert(menuLabels.some((t) => t.includes('デスクトップへ移動')), 'menu has デスクトップへ移動');
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

  console.log('\nGUI E2E: all steps passed');
}

main().then(() => process.exit(0)).catch((e) => {
  console.error('\nGUI E2E FAILED: ' + (e && e.message || e));
  process.exit(1);
});

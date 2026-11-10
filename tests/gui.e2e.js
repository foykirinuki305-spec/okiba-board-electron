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
    OKIBA_BASE: base,
    OKIBA_OLD_BASE: oldBase,
    OKIBA_TEST_RESOLVER_DIR: landing,
    OKIBA_TEST_POSITIONER: 'stub',
    OKIBA_TEST_HOOKS: '1',
    ELECTRON_DISABLE_SECURITY_WARNINGS: '1',
  };
  const launch = (extraEnv) => electron.launch({
    args: [ROOT, '--no-sandbox'],
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
    return Array.isArray(log) && log.some((e) => e.kind === 'position' &&
      e.status === 'ok' && e.x === -40 && e.y === 200 &&
      Array.isArray(e.names) && e.names.includes('デスクトップ移動.txt'));
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
  assert(linkMenu.some((t) => t.includes('デスクトップへ移動')),
    'linked menu has デスクトップへ移動 (v2.1: a real move, distinct from 外す)');
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
    assert(attribHidden(originFile) === false,
      'Hidden attribute cleared after unlink (real attrib)');
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
  assert(missMenu.length === 1 && missMenu[0].includes('ボードから外す'),
    'missing item menu offers ONLY ボードから外す (nothing destructive)');
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
    args: [ROOT, '--no-sandbox', ...extra],
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
    assert(attribHidden(path.join(landing, '外部ドラッグ.txt')) === false,
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
    return Array.isArray(log) && log.some((e) => e.kind === 'position' &&
      Array.isArray(e.names) && e.names.includes('外部デスクトップ.txt'));
  }, 'dropLog records icon positioning for the ex-linked file');
  await waitFor(async () => {
    const log = await page.evaluate(() => window.okiba.dropLog());
    return log.some((e) => e.kind === 'move-linked');
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
    return t.includes('判定できませんでした');
  }, 'cancel: status line says the drop could not be resolved');
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

  console.log('\nGUI E2E: all steps passed');
}

main().then(() => process.exit(0)).catch((e) => {
  console.error('\nGUI E2E FAILED: ' + (e && e.message || e));
  process.exit(1);
});

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
 *   -> drag-out IPC path fires (okiba.startDrag -> main startDrag log)
 *   -> restart restores boards, positions, percent and theme
 *
 * Screenshots of home and board are written to $OKIBA_SHOTS (default
 * ./screenshots). Any failure exits non-zero, failing the CI build.
 * Native OS drag-in/drag-out gestures themselves cannot be automated;
 * only the IPC path is verified (see dragLog check).
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

async function main() {
  fs.mkdirSync(SHOTS, { recursive: true });
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'okiba-gui-base-'));
  const oldBase = fs.mkdtempSync(path.join(os.tmpdir(), 'okiba-gui-old-'));
  const boardName = 'テスト素材';
  const boardDir = path.join(base, boardName);
  fs.mkdirSync(boardDir, { recursive: true });
  const longName = '撮影データ_2024年_最終バージョン_その2.mp4';
  fs.writeFileSync(path.join(boardDir, longName), 'fake video');
  fs.writeFileSync(path.join(boardDir, '写真サンプル.png'), PNG_1PX);
  fs.writeFileSync(path.join(boardDir, 'メモ帳.txt'), 'hello');
  fs.writeFileSync(path.join(boardDir, '.okiba-board.json'), JSON.stringify({
    version: 5, size_percent: 100,
    positions: {
      [longName]: { col: 0, row: 0 },
      '写真サンプル.png': { col: 0, row: 1 },
      'メモ帳.txt': { col: 0, row: 2 },
    },
    notes: [],
  }, null, 2));

  const env = {
    ...process.env,
    OKIBA_BASE: base,
    OKIBA_OLD_BASE: oldBase,
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
  await page.waitForSelector('#boardGrid .board-card', { timeout: 20000 });
  assert(true, 'home shows board cards');
  await page.screenshot({ path: path.join(SHOTS, 'home.png') });

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

  step('pointer-drag an item one cell to the right');
  const first = page.locator('.item', { hasText: '撮影データ' }).first();
  const box = await first.boundingBox();
  assert(box, 'item has a bounding box');
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 164, box.y + box.height / 2, { steps: 12 });
  await page.mouse.up();
  await waitFor(() => {
    const data = readJson(path.join(boardDir, '.okiba-board.json'));
    const pos = data.positions[longName];
    return pos && pos.col === 1 && pos.row === 0;
  }, 'dragged position saved to json');
  assert(true, 'item moved to cell (1,0) and position persisted');

  step('percent dropdown changes size and persists');
  const thumbBefore = await page.locator('.item .thumb').first().boundingBox();
  await page.selectOption('#percentSel', '60');
  await waitFor(() => {
    const data = readJson(path.join(boardDir, '.okiba-board.json'));
    return data.size_percent === 60;
  }, 'size_percent=60 saved');
  const thumbAfter = await page.locator('.item .thumb').first().boundingBox();
  assert(thumbAfter.width < thumbBefore.width, 'icons got smaller at 60%');

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

  step('drag-out IPC path fires (startDrag recorded in main)');
  const targetPath = path.join(boardDir, 'メモ帳.txt');
  await page.evaluate((p) => window.okiba.startDrag(p), targetPath);
  await waitFor(async () => {
    const log = await page.evaluate(() => window.okiba.dragLog());
    return Array.isArray(log) && log.some((e) => e.path === targetPath);
  }, 'main recorded a startDrag invocation for the file');
  assert(true, 'dragstart -> preload IPC -> main startDrag confirmed');

  await app1.close();

  // ------------------------------------------------------------ run 2
  step('restart restores boards, positions, percent and theme');
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
  const posLeft = await page.locator('.item', { hasText: '撮影データ' }).first()
    .evaluate((el) => el.style.left);
  const data = readJson(path.join(boardDir, '.okiba-board.json'));
  assert(data.positions[longName].col === 1, 'dragged position still saved after restart');
  assert(parseInt(posLeft, 10) > 100, 'item rendered at the dragged column');
  await page.screenshot({ path: path.join(SHOTS, 'board-restored.png') });
  await app2.close();

  console.log('\nGUI E2E: all steps passed');
}

main().then(() => process.exit(0)).catch((e) => {
  console.error('\nGUI E2E FAILED: ' + (e && e.message || e));
  process.exit(1);
});

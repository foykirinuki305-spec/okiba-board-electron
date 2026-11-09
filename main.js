'use strict';
const { app, BrowserWindow, ipcMain, shell, nativeImage, dialog } = require('electron');
const fs = require('fs');
const path = require('path');
const bf = require('./lib/boardfs');

// ------------------------------------------------------------------ paths
let BASE = null;
let MIGRATED_COUNT = 0;

const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.bmp', '.webp', '.ico', '.avif']);
const VIDEO_EXTS = new Set(['.mp4', '.mov', '.mkv', '.avi', '.webm', '.m4v', '.wmv']);
const AUDIO_EXTS = new Set(['.mp3', '.wav', '.m4a', '.flac', '.ogg', '.aac', '.wma']);

function kindOf(name, isDir) {
  if (isDir) return 'folder';
  const ext = path.extname(name).toLowerCase();
  if (IMAGE_EXTS.has(ext)) return 'image';
  if (VIDEO_EXTS.has(ext)) return 'video';
  if (AUDIO_EXTS.has(ext)) return 'audio';
  return 'file';
}

// ------------------------------------------------------------- self-test
// OKIBA_SELFTEST=1: run in-app fs checks against a temp OKIBA_BASE and
// exit 0 (ok) / 1 (fail) without opening a window. Used by CI launch
// smoke on windows-latest.
async function runInAppSelfTest() {
  const log = [];
  try {
    const base = process.env.OKIBA_BASE;
    if (!base) throw new Error('OKIBA_BASE not set for self-test');
    bf.ensureBase(base);
    const boards = bf.listBoards(base);
    if (!boards.length) throw new Error('no default board created');
    log.push('boards: ' + boards.join(','));
    const folder = path.join(base, boards[0]);
    fs.writeFileSync(path.join(folder, 'smoke.txt'), 'ok');
    bf.saveBoard(folder, { 'smoke.txt': [1, 2] },
      [{ id: 's1', text: 'smoke', col: 0, row: 0 }], 80);
    const loaded = bf.loadBoard(folder);
    if (loaded.sizePercent !== 80) throw new Error('sizePercent roundtrip');
    if (!loaded.positions['smoke.txt']) throw new Error('position roundtrip');
    const scan = bf.scanFolder(folder);
    if (!scan.some((e) => e.name === 'smoke.txt')) throw new Error('scan');
    const srcDir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'okiba-smoke-src-'));
    const src = path.join(srcDir, 'in.txt');
    fs.writeFileSync(src, 'in');
    const placed = bf.placeDroppedItems([src], folder);
    if (placed.length !== 1) throw new Error('intake');
    log.push('in-app self-test OK');
    console.log(log.join('\n'));
    return 0;
  } catch (e) {
    console.error('in-app self-test FAILED: ' + (e && e.message || e));
    return 1;
  }
}

// -------------------------------------------------------------- thumbnails
const thumbCache = new Map(); // path|mtime|size -> dataURL|null
async function thumbnailFor(fullPath, px) {
  let stat;
  try { stat = fs.statSync(fullPath); } catch (e) { return null; }
  if (!stat.isFile()) return null;
  const key = fullPath + '|' + stat.mtimeMs + '|' + px;
  if (thumbCache.has(key)) return thumbCache.get(key);
  let url = null;
  try {
    const img = await nativeImage.createThumbnailFromPath(fullPath, { width: px, height: px });
    if (img && !img.isEmpty()) url = img.toDataURL();
  } catch (e) { url = null; }
  if (thumbCache.size > 400) thumbCache.clear();
  thumbCache.set(key, url);
  return url;
}

async function boardPreview(boardName) {
  const folder = path.join(BASE, boardName);
  let entries = [];
  try { entries = bf.scanFolder(folder); } catch (e) {}
  const thumbs = [];
  const kinds = [];
  for (const e of entries) {
    if (kinds.length < 6) kinds.push(kindOf(e.name, e.isDir));
    if (thumbs.length >= 6) continue;
    const kind = kindOf(e.name, e.isDir);
    if (kind === 'image' || kind === 'video') {
      const url = await thumbnailFor(path.join(folder, e.name), 220);
      if (url) thumbs.push(url);
    }
  }
  return { name: boardName, count: entries.length, thumbs, kinds };
}

// ----------------------------------------------------------------- state
function homeState() {
  const home = bf.loadHome(BASE);
  return {
    base: BASE,
    theme: home.theme || bf.DEFAULT_THEME,
    positions: home.positions,
    migrated: MIGRATED_COUNT,
  };
}

async function boardsState() {
  const names = bf.listBoards(BASE);
  const boards = [];
  for (const n of names) boards.push(await boardPreview(n));
  return Object.assign(homeState(), { boards });
}

function boardState(boardName) {
  const folder = path.join(BASE, boardName);
  const data = bf.loadBoard(folder);
  let entries = [];
  try { entries = bf.scanFolder(folder); } catch (e) {}
  return {
    name: boardName,
    folder,
    entries: entries.map((e) => Object.assign(e, {
      kind: kindOf(e.name, e.isDir),
      path: path.join(folder, e.name),
    })),
    positions: data.positions,
    notes: data.notes,
    sizePercent: data.sizePercent,
  };
}

// ---------------------------------------------------------------- window
let win = null;
let watchers = [];

function closeWatchers() {
  for (const w of watchers) { try { w.close(); } catch (e) {} }
  watchers = [];
}

function setupWatchers(boardName) {
  closeWatchers();
  const notify = () => {
    if (win && !win.isDestroyed()) win.webContents.send('fs-changed');
  };
  const add = (dir) => {
    try {
      watchers.push(fs.watch(dir, { persistent: false }, () => {
        clearTimeout(add._t);
        add._t = setTimeout(notify, 250);
      }));
    } catch (e) {}
  };
  add(BASE);
  if (boardName) add(path.join(BASE, boardName));
}

function createWindow() {
  win = new BrowserWindow({
    width: 1180,
    height: 780,
    minWidth: 760,
    minHeight: 520,
    backgroundColor: '#05081a',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.on('focus', () => {
    if (win && !win.isDestroyed()) win.webContents.send('fs-changed');
  });
  win.on('closed', () => { win = null; closeWatchers(); });
}

// ------------------------------------------------------------------- IPC
function guardBoard(name) {
  if (!name || name.includes('/') || name.includes('\\') || name === '.' || name === '..') {
    throw new Error('invalid board name');
  }
  return path.join(BASE, name);
}

function registerIpc() {
  ipcMain.handle('get-home', async () => boardsState());
  ipcMain.handle('get-board', (_e, name) => {
    guardBoard(name);
    setupWatchers(name);
    return boardState(name);
  });
  ipcMain.handle('watch-home', () => { setupWatchers(null); return true; });

  ipcMain.handle('thumb', async (_e, fullPath) => thumbnailFor(fullPath, 300));

  ipcMain.handle('create-board', async (_e, name) => {
    const created = bf.createBoard(BASE, name);
    return boardsState().then((s) => Object.assign(s, { created }));
  });
  ipcMain.handle('rename-board', async (_e, oldName, newName) => {
    const renamed = bf.renameBoard(BASE, oldName, newName);
    // keep saved home position under the new name
    const home = bf.loadHome(BASE);
    if (home.positions[oldName]) {
      home.positions[renamed] = home.positions[oldName];
      delete home.positions[oldName];
      bf.saveHome(BASE, home.positions);
    }
    return boardsState();
  });
  ipcMain.handle('trash-board', async (_e, name) => {
    await shell.trashItem(guardBoard(name));
    return boardsState();
  });
  ipcMain.handle('open-board-folder', async (_e, name) => {
    await shell.openPath(guardBoard(name));
    return true;
  });

  ipcMain.handle('save-home-positions', (_e, positions) => {
    bf.saveHome(BASE, positions);
    return true;
  });
  ipcMain.handle('set-theme', (_e, theme) => {
    const home = bf.loadHome(BASE);
    bf.saveHome(BASE, home.positions, theme);
    return true;
  });

  ipcMain.handle('save-board', (_e, name, positions, notes, sizePercent) => {
    bf.saveBoard(guardBoard(name), positions, notes, sizePercent);
    return true;
  });

  ipcMain.handle('open-item', async (_e, fullPath) => {
    await shell.openPath(fullPath);
    return true;
  });
  ipcMain.handle('show-item', (_e, fullPath) => {
    shell.showItemInFolder(fullPath);
    return true;
  });
  ipcMain.handle('trash-item', async (_e, fullPath) => {
    await shell.trashItem(fullPath);
    return true;
  });
  ipcMain.handle('rename-item', (_e, fullPath, newName) => {
    const cleaned = bf.validateBoardName(newName); // same invalid-char rules
    const dest = path.join(path.dirname(fullPath), cleaned);
    if (fs.existsSync(dest)) throw new Error('同じ名前のものがあります');
    fs.renameSync(fullPath, dest);
    return dest;
  });
  ipcMain.handle('move-to-desktop', (_e, fullPath) => {
    const dest = bf.uniqueDestination(bf.desktopDir(), path.basename(fullPath));
    // placeDroppedItems applies the same never-overwrite rule; call the
    // move directly so a same-drive Desktop move always MOVES.
    try { fs.renameSync(fullPath, dest); }
    catch (e) {
      if (fs.statSync(fullPath).isDirectory()) {
        // cross-device fallback
        const { execFileSync } = require('child_process');
        execFileSync('robocopy', [fullPath, dest, '/E', '/MOVE'], { windowsHide: true });
      } else {
        fs.copyFileSync(fullPath, dest);
        fs.rmSync(fullPath, { force: true });
      }
    }
    return dest;
  });
  ipcMain.handle('drop-files', (_e, boardName, paths) => {
    const folder = guardBoard(boardName);
    return bf.placeDroppedItems(paths, folder);
  });

  // Native drag OUT (official Electron API). Must be called from the
  // renderer's dragstart handler via preload IPC.
  const DRAG_ICON = nativeImage.createFromDataURL(
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAYAAACqaXHeAAAAmElEQVR4nO3QMREAIBDAsDeDDwTiGWRkoEP2Xmftc382OkBrgA7QGqADtAboAK0BOkBrgA7QGqADtAboAK0BOkBrgA7QGqADtAboAK0BOkBrgA7QGqADtAboAK0BOkBrgA7QGqADtAboAK0BOkBrgA7QGqADtAboAO0BzG0B0vTUaKYAAAAASUVORK5CYII=');
  // Every startDrag invocation is recorded so the GUI test-suite can
  // verify the drag-out IPC path (renderer -> preload -> this handler)
  // even though a real OS drag gesture cannot be automated.
  const dragLog = [];
  ipcMain.on('ondragstart', (event, fullPath) => {
    // startDrag must be called synchronously inside this handler,
    // so the icon is a pre-built generic image (not an async thumb).
    let okFlag = true;
    let errMsg = null;
    try {
      event.sender.startDrag({ file: fullPath, icon: DRAG_ICON });
    } catch (e) {
      okFlag = false;
      errMsg = String((e && e.message) || e);
    }
    dragLog.push({ path: fullPath, ok: okFlag, err: errMsg });
  });
  ipcMain.handle('test-draglog', () => dragLog);
}

app.whenReady().then(async () => {
  if (process.env.OKIBA_SELFTEST === '1') {
    const resolved = bf.resolveBase();
    BASE = resolved.base;
    const code = await runInAppSelfTest();
    app.exit(code);
    return;
  }
  const resolved = bf.resolveBase();
  BASE = resolved.base;
  MIGRATED_COUNT = resolved.moved;
  bf.ensureBase(BASE);
  registerIpc();
  createWindow();
  setupWatchers(null);
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

'use strict';
const { app, BrowserWindow, ipcMain, shell, nativeImage, dialog, screen } = require('electron');
const fs = require('fs');
const path = require('path');
const bf = require('./lib/boardfs');
const dm = require('./lib/dropmove');

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

  // ------------------------- drag-out: self-implemented MOVE
  // webContents.startDrag is GONE (v1.2). On the user's real PC the
  // handoff silently did nothing: startDrag is only honoured inside a
  // native dragstart event, which a pointer-driven drag never
  // produces, and the renderer could not even reliably notice the
  // pointer leaving the window (pointer capture clamps coordinates
  // at the edge). Instead the renderer detects an OUTSIDE RELEASE
  // itself (pointerup coordinates outside the window, cross-checked
  // with the OS cursor position) and asks main to do the move:
  //   resolveDropTarget(screen point) -> folder under the pointer
  //   (PowerShell: WindowFromPoint -> Progman/WorkerW = Desktop, or
  //    the ShellWindows Explorer window's folder path; else unknown)
  //   -> move the real files there with the intake rules.
  // Unknown target => nothing is moved. Ever.
  function resolverScriptPath() {
    // Packaged: the script ships via extraResources (PowerShell
    // cannot -File a script from inside the asar archive).
    try {
      const packed = path.join(process.resourcesPath, 'scripts', 'resolve-drop.ps1');
      if (fs.existsSync(packed)) return packed;
    } catch (e) {}
    return path.join(__dirname, 'scripts', 'resolve-drop.ps1');
  }
  const resolveDropTarget = dm.createResolver({ scriptPath: resolverScriptPath() });

  // Every resolution is logged so the GUI test-suite can verify the
  // new IPC path (renderer outside-release -> main resolve -> move)
  // even though a real OS drop gesture cannot be automated.
  const dropLog = [];
  ipcMain.handle('resolve-drop-move', async (_e, payload) => {
    const paths = (payload && Array.isArray(payload.paths)) ? payload.paths : [];
    const x = payload ? Number(payload.screenX) : NaN;
    const y = payload ? Number(payload.screenY) : NaN;
    const result = { resolved: null, moved: [], skipped: [], failed: [], error: null };
    try {
      const target = (Number.isFinite(x) && Number.isFinite(y))
        ? await resolveDropTarget(x, y)
        : { type: 'unknown' };
      result.resolved = target;
      dropLog.push({ kind: 'resolve', x, y, target });
      if (target && target.path) {
        let isDir = false;
        try { isDir = fs.statSync(target.path).isDirectory(); } catch (e) { isDir = false; }
        if (isDir) {
          const r = dm.moveItemsOut(paths, target.path);
          result.moved = r.moved;
          result.skipped = r.skipped;
          result.failed = r.failed;
          dropLog.push({ kind: 'move', target: target.path, moved: r.moved.length });
          if (r.moved.length && win && !win.isDestroyed()) {
            win.webContents.send('fs-changed');
          }
        } else {
          result.resolved = { type: 'unknown' };
        }
      }
    } catch (e) {
      result.error = String((e && e.message) || e);
      result.resolved = { type: 'unknown' };
      dropLog.push({ kind: 'error', error: result.error });
    }
    return result;
  });
  // Backup for outside-release detection: the true OS cursor position.
  ipcMain.handle('cursor-point', () => {
    try { return screen.getCursorScreenPoint(); } catch (e) { return null; }
  });
  ipcMain.handle('test-droplog', () => dropLog);
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

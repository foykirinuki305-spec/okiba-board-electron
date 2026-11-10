'use strict';
const { app, BrowserWindow, ipcMain, shell, nativeImage, dialog, screen } = require('electron');
const fs = require('fs');
const path = require('path');
const bf = require('./lib/boardfs');
const dm = require('./lib/dropmove');
const ip = require('./lib/iconpos');
const ln = require('./lib/links');
const sc = require('./lib/shortcut');
const pl = require('./lib/placement');
const sh = require('./lib/shellhelper');

// Hidden-attribute runner for linked items (v2.0). Real attrib.exe
// in production; OKIBA_TEST_ATTRIB=stub swaps in the counting stub.
const attrib = ln.attribRunnerFromEnv();

// ------------------------------------------------------------------ paths
let BASE = null;
let MIGRATED_COUNT = 0;
// Warm shell helper client (v2.2, Job A): one long-lived PowerShell
// process serving resolveDrop / positionIcons / getDesktopPositions.
// Created in registerIpc(); null when disabled or off-Windows, in
// which case every caller uses the v2.1 cold-spawn scripts.
let shellHelper = null;

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

// Startup speed: the home screen must paint BEFORE thumbnails are
// generated (a cold thumbnail cache used to block the first render
// of the board list). peekThumb returns only what is already cached
// and schedules real generation in the background; when a fresh
// thumbnail lands, a debounced fs-changed lets the renderer swap the
// fallback tiles for the collage.
let thumbNotifyTimer = null;
function notifyThumbsReady() {
  clearTimeout(thumbNotifyTimer);
  thumbNotifyTimer = setTimeout(() => {
    if (win && !win.isDestroyed()) win.webContents.send('fs-changed');
  }, 300);
}
function peekThumb(fullPath, px) {
  let stat;
  try { stat = fs.statSync(fullPath); } catch (e) { return null; }
  if (!stat.isFile()) return null;
  const key = fullPath + '|' + stat.mtimeMs + '|' + px;
  if (thumbCache.has(key)) return thumbCache.get(key);
  thumbnailFor(fullPath, px)
    .then((url) => { if (url) notifyThumbsReady(); })
    .catch(() => {});
  return null;
}

async function boardPreview(boardName) {
  const folder = path.join(BASE, boardName);
  let entries = [];
  try { entries = bf.scanFolder(folder); } catch (e) {}
  let data = { links: [] };
  try { data = bf.loadBoard(folder); } catch (e) {}
  // Unified item list: residents (physical, from the folder scan)
  // first, then linked items (references to original paths; skip
  // missing ones for the collage).
  const items = entries.map((e) => ({
    name: e.name, isDir: e.isDir, fullPath: path.join(folder, e.name),
  }));
  for (const l of data.links || []) {
    const st = ln.statLink(l.path);
    if (!st.exists) continue;
    items.push({ name: path.basename(l.path), isDir: st.isDir, fullPath: l.path });
  }
  const thumbs = [];
  const kinds = [];
  for (const e of items) {
    if (kinds.length < 6) kinds.push(kindOf(e.name, e.isDir));
    if (thumbs.length >= 6) continue;
    const kind = kindOf(e.name, e.isDir);
    if (kind === 'image' || kind === 'video') {
      // Cache-first (see peekThumb): never block first paint on
      // thumbnail generation; missing ones arrive via fs-changed.
      const url = peekThumb(e.fullPath, 220);
      if (url) thumbs.push(url);
    }
  }
  const count = entries.length + (data.links || []).length;
  return { name: boardName, count, thumbs, kinds };
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
      itemKind: 'resident',
    })),
    links: (data.links || []).map((l) => {
      const st = ln.statLink(l.path);
      const name = path.basename(l.path);
      return {
        path: l.path,
        name,
        isDir: st.isDir,
        kind: kindOf(name, st.isDir),
        exists: st.exists,
        wasHidden: !!l.wasHidden,
        col: l.col, row: l.row,
        itemKind: 'linked',
      };
    }),
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

// ------------------------------------------- per-board shortcuts
// Startup route from --board-path (lib/shortcut.js). Computed once
// BASE is known; consumed by the renderer on load via
// 'get-startup-route' and re-sent on every second-instance launch.
let startupRoute = { boardName: null, invalidBoard: false };

function shortcutDesktopDir() {
  // OKIBA_SHORTCUT_DESKTOP redirects the shortcut target folder for
  // tests, so the E2E can assert the .lnk without touching a real
  // user's Desktop.
  return process.env.OKIBA_SHORTCUT_DESKTOP || bf.desktopDir();
}

function focusMainWindow() {
  if (!win || win.isDestroyed()) return false;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
  return true;
}

// Single instance: board shortcuts are meant to be double-clicked
// while the app is already running, so a second launch must route
// INTO the running window (focus + switch board) instead of opening
// a duplicate app. The in-app self-test skips the lock: CI runs it
// unattended and it must never be blocked by a stray instance.
const SELFTEST_MODE = process.env.OKIBA_SELFTEST === '1';
const gotSingleInstanceLock = SELFTEST_MODE ? true : app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  app.quit();
} else if (!SELFTEST_MODE) {
  app.on('second-instance', (_e, argv) => {
    if (!BASE) return;
    const route = sc.routeFromArgv(argv, BASE);
    if (focusMainWindow()) {
      win.webContents.send('open-board-request', route);
    } else {
      // No window right now (e.g. macOS-style keep-alive): remember
      // the route — a fresh window's renderer picks it up on load.
      startupRoute = route;
      if (app.isReady()) createWindow();
    }
  });
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
    const folder = guardBoard(name);
    // Linked originals are NOT in the folder and must survive board
    // deletion untouched — but their Hidden attribute (if we set it)
    // is released once no remaining board links them.
    let heldLinks = [];
    try { heldLinks = bf.loadBoard(folder).links; } catch (e) {}
    await shell.trashItem(folder);
    try { await ln.releaseBoardLinks({ base: BASE, links: heldLinks, attrib }); }
    catch (e) { /* releasing visibility must never block deletion */ }
    return boardsState();
  });
  ipcMain.handle('open-board-folder', async (_e, name) => {
    await shell.openPath(guardBoard(name));
    return true;
  });

  // --------------------- per-board desktop shortcuts (v2.1)
  // A board shortcut is a real Windows .lnk on the Desktop whose
  // target is this exe with --board-path "<board folder>"; launching
  // it routes straight into that board (see the startup/second-
  // instance routing below). shell.writeShortcutLink writes it
  // directly — no PowerShell involved.
  ipcMain.handle('get-startup-route', () => startupRoute);
  ipcMain.handle('create-board-shortcut', (_e, name) => {
    const folder = guardBoard(name);
    if (!fs.existsSync(folder) || !fs.statSync(folder).isDirectory()) {
      throw new Error('ボードが見つかりません');
    }
    const desk = shortcutDesktopDir();
    try { fs.mkdirSync(desk, { recursive: true }); } catch (e) {}
    const probe = (rel) => {
      try {
        const st = fs.statSync(path.join(desk, rel));
        return st.isDirectory() ? 'dir' : 'file';
      } catch (e) { return null; }
    };
    const fileName = sc.planShortcutFileName(name, probe);
    const lnkPath = path.join(desk, fileName);
    const written = shell.writeShortcutLink(lnkPath, 'create', {
      target: process.execPath,
      // "=" form on purpose: Chromium's command-line model detaches
      // a two-token "--flag value" pair when it forwards a second
      // instance's argv to the running app (the value comes back as
      // a stray trailing argument and the flag reads as valueless).
      // An attached value survives that round trip intact.
      args: '--board-path="' + folder + '"',
      cwd: folder,
      description: name,
      icon: process.execPath,
      iconIndex: 0,
    });
    if (!written) throw new Error('ショートカットを作成できませんでした');
    return { lnkPath, fileName };
  });
  // Read-back helper (used by the GUI tests to verify a written
  // .lnk really points at this exe with the board's --board-path).
  ipcMain.handle('read-shortcut', (_e, lnkPath) => {
    try { return shell.readShortcutLink(lnkPath); } catch (e) { return null; }
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

  ipcMain.handle('save-board', (_e, name, positions, notes, sizePercent, links) => {
    bf.saveBoard(guardBoard(name), positions, notes, sizePercent, links || []);
    return true;
  });

  // moveFile adapter for ln.moveLinkedOut: a single-item move
  // through the same engine resident items use (never overwrite).
  // "Skipped" there means the file already lives directly inside
  // the target folder (e.g. a Desktop file dropped onto the
  // Desktop) — that folder IS its destination.
  const moveFileViaDropmove = (src, dir) => {
    const r = dm.moveItemsOut([src], dir);
    if (r.destinations && r.destinations.length) return r.destinations[0];
    if (r.skipped && r.skipped.includes(src)) return src;
    return null;
  };

  // ------------------------- linked items (v2.0 "link + hide")
  // Intake NO LONGER moves files into the board folder. The file
  // stays at its original path; the board stores a reference and the
  // original gets the Hidden attribute so it disappears visually.
  //
  // v2.2 anchored placement (Job B): when the caller passes
  // placeOpts { anchor:[col,row], rows, offsets? }, new links are
  // saved WITH the cells lib/placement.js picks around the anchor
  // instead of col/row null (append). Without an anchor the v2.0
  // behaviour is byte-identical. When every dropped path lives on
  // the Desktop and no explicit offsets are given, the warm helper
  // reports the files' current desktop icon cells and that layout
  // becomes the offsets — read BEFORE any hiding happens, because
  // hiding is exactly what makes those icons vanish.
  ipcMain.handle('link-files', async (_e, boardName, paths, placeOpts) => {
    const folder = guardBoard(boardName);
    const result = { added: [], duplicates: [], skipped: [], attribFailed: [] };
    const candidates = [];
    for (const p of paths || []) {
      if (!p || !fs.existsSync(p)) { result.skipped.push(p); continue; }
      // A file already physically inside this board folder is a
      // resident — it is already on the board, nothing to link.
      if (path.resolve(path.dirname(p)) === path.resolve(folder)) {
        result.skipped.push(p);
        continue;
      }
      candidates.push(p);
    }
    const anchor = (placeOpts && Array.isArray(placeOpts.anchor)) ? placeOpts.anchor : null;
    const rows = (placeOpts && placeOpts.rows > 0) ? placeOpts.rows | 0 : 8;
    let ordered = candidates;
    let offsets = (placeOpts && Array.isArray(placeOpts.offsets)) ? placeOpts.offsets : null;
    if (anchor && !offsets && candidates.length) {
      const deskDirs = new Set(
        [bf.desktopDir(), shellDesktopDir()].filter(Boolean)
          .map((d) => path.resolve(d).toLowerCase()));
      const allOnDesktop = candidates.every(
        (p) => deskDirs.has(path.resolve(path.dirname(p)).toLowerCase()));
      if (allOnDesktop) {
        try {
          const plan = await desktopLayoutPlan(candidates);
          if (plan) { ordered = plan.paths; offsets = plan.offsets; }
        } catch (e) { /* layout lookup is best-effort: strip order */ }
      }
    }
    let cells = null;
    if (anchor && ordered.length) {
      try {
        const data = bf.loadBoard(folder);
        const { occupied } = pl.computeCells({
          entries: bf.scanFolder(folder),
          positions: data.positions, notes: data.notes, links: data.links,
          rowsPerCol: rows,
        });
        cells = pl.placeItems({
          occupied, anchor, offsets, count: ordered.length, rowsPerCol: rows,
        });
      } catch (e) { cells = null; /* placement is best-effort */ }
    }
    for (let i = 0; i < ordered.length; i++) {
      const p = ordered[i];
      const r = await ln.addLink({
        base: BASE, boardFolder: folder, targetPath: p, attrib,
        cell: cells ? cells[i] : undefined,
      });
      if (r.duplicate) result.duplicates.push(p);
      else {
        result.added.push(p);
        if (!r.attribOk) result.attribFailed.push(p);
      }
    }
    if (result.added.length && win && !win.isDestroyed()) {
      win.webContents.send('fs-changed');
    }
    return result;
  });
  ipcMain.handle('unlink-items', async (_e, boardName, paths) => {
    const folder = guardBoard(boardName);
    const results = await ln.removeLinks({
      base: BASE, boardFolder: folder, targetPaths: paths || [], attrib,
    });
    if (win && !win.isDestroyed()) win.webContents.send('fs-changed');
    return results;
  });
  ipcMain.handle('rename-linked', async (_e, boardName, oldPath, newName) => {
    const folder = guardBoard(boardName);
    const cleaned = bf.validateBoardName(newName); // same invalid-char rules
    const dest = path.join(path.dirname(oldPath), cleaned);
    if (fs.existsSync(dest)) throw new Error('同じ名前のものがあります');
    const data = bf.loadBoard(folder);
    const link = data.links.find((l) => ln.samePath(l.path, oldPath));
    if (!link) throw new Error('リンクが見つかりません');
    fs.renameSync(oldPath, dest); // real rename of the original file
    link.path = dest;
    bf.saveBoard(folder, data.positions, data.notes, data.sizePercent, data.links);
    return dest;
  });
  // Menu counterpart of the linked drag-out (v2.1): move the real
  // file to the Desktop and detach the link. No drop point exists
  // here, so the icon takes the Desktop's default placement.
  ipcMain.handle('move-linked-to-desktop', async (_e, boardName, paths) => {
    const folder = guardBoard(boardName);
    const moved = [];
    const destinations = [];
    for (const lp of paths || []) {
      const one = await ln.moveLinkedOut({
        base: BASE, boardFolder: folder, targetPath: lp,
        destDir: bf.desktopDir(), attrib, moveFile: moveFileViaDropmove,
      });
      if (one.moved) {
        moved.push(lp);
        if (one.dest) destinations.push(one.dest);
      }
    }
    if (moved.length && win && !win.isDestroyed()) {
      win.webContents.send('fs-changed');
    }
    return { moved, destinations };
  });
  ipcMain.handle('trash-linked', async (_e, boardName, targetPath) => {
    const folder = guardBoard(boardName);
    // Explicit REAL-file delete (distinct from ボードから外す）:
    // trash the original, then drop the reference. No unhide needed
    // or wanted — the file itself is gone.
    await shell.trashItem(targetPath);
    const data = bf.loadBoard(folder);
    const before = data.links.length;
    data.links = data.links.filter((l) => !ln.samePath(l.path, targetPath));
    if (data.links.length !== before) {
      bf.saveBoard(folder, data.positions, data.notes, data.sizePercent, data.links);
    }
    if (win && !win.isDestroyed()) win.webContents.send('fs-changed');
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
  ipcMain.handle('drop-files', (_e, boardName, paths, placeOpts) => {
    const folder = guardBoard(boardName);
    const placed = bf.placeDroppedItems(paths, folder);
    // Anchored placement for moved-in residents (v2.2): with an
    // anchor, the new arrivals get saved cells from the same
    // placement module linked intake uses (their own stale/absent
    // positions excluded from occupancy). Without one, positions
    // stay unset and the renderer appends, exactly as before.
    const anchor = (placeOpts && Array.isArray(placeOpts.anchor)) ? placeOpts.anchor : null;
    if (anchor && placed.length) {
      try {
        const rows = (placeOpts && placeOpts.rows > 0) ? placeOpts.rows | 0 : 8;
        const data = bf.loadBoard(folder);
        const fresh = new Set(placed.map((d) => path.basename(d)));
        const { occupied } = pl.computeCells({
          entries: bf.scanFolder(folder).filter((e) => !fresh.has(e.name)),
          positions: data.positions, notes: data.notes, links: data.links,
          rowsPerCol: rows,
        });
        const cells = pl.placeItems({
          occupied, anchor,
          offsets: (placeOpts && Array.isArray(placeOpts.offsets)) ? placeOpts.offsets : null,
          count: placed.length, rowsPerCol: rows,
        });
        placed.forEach((dest, i) => { data.positions[path.basename(dest)] = cells[i]; });
        bf.saveBoard(folder, data.positions, data.notes, data.sizePercent, data.links);
      } catch (e) { /* placement is best-effort; the files are in */ }
    }
    return placed;
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
  function bundledScriptPath(fileName) {
    // Packaged: scripts ship via extraResources (PowerShell cannot
    // -File a script from inside the asar archive).
    try {
      const packed = path.join(process.resourcesPath, 'scripts', fileName);
      if (fs.existsSync(packed)) return packed;
    } catch (e) {}
    return path.join(__dirname, 'scripts', fileName);
  }
  // ------------------------- warm shell helper (v2.2, Job A)
  // One long-lived PowerShell process (scripts/shell-helper.ps1)
  // serves drop-target resolution, desktop icon positioning and
  // desktop icon position reads over JSON lines. The v2.1 cold-spawn
  // scripts remain as the fallback for every operation: a helper
  // transport failure (not running, died, timed out) transparently
  // re-runs the operation the old way, so nothing can regress below
  // v2.1 behaviour. The env test stubs keep top precedence so the
  // suites stay deterministic; OKIBA_HELPER_MODE=off disables the
  // helper entirely; OKIBA_TEST_HELPER=fake swaps in the Node test
  // double (tools/fake-helper.js).
  function createShellHelper() {
    if (process.env.OKIBA_HELPER_MODE === 'off') return null;
    if (process.env.OKIBA_TEST_HELPER === 'fake') {
      const fake = path.join(__dirname, 'tools', 'fake-helper.js');
      if (!fs.existsSync(fake)) return null;
      // process.execPath is the ELECTRON binary here, not Node:
      // ELECTRON_RUN_AS_NODE makes it behave as plain Node so the
      // fake helper script runs as-is.
      return sh.createShellHelperClient({
        command: process.execPath, args: [fake],
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      });
    }
    if (process.platform !== 'win32') return null;
    return sh.createShellHelperClient({
      command: 'powershell.exe',
      args: ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
        '-File', bundledScriptPath('shell-helper.ps1')],
    });
  }
  shellHelper = createShellHelper();
  if (shellHelper) shellHelper.start();

  // The SHELL Desktop folder (what the helper reads icons from);
  // bf.desktopDir() is the plain ~/Desktop path. Both are accepted
  // when deciding whether a drop came "from the desktop".
  function shellDesktopDir() {
    try { return app.getPath('desktop'); } catch (e) { return null; }
  }

  // Desktop-layout plan for an all-Desktop intake: ask the helper
  // where those icons sit right now (budget ~400ms — it is a pure
  // read) and turn the arrangement into relative offsets. ANY
  // failure → null → drop-order vertical strip.
  async function desktopLayoutPlan(candidatePaths) {
    if (!shellHelper) return null;
    const names = candidatePaths.map((p) => path.basename(p));
    const r = await shellHelper.request(
      'getDesktopPositions', { names }, { timeoutMs: 400 });
    if (!r.ok || !r.result) return null;
    const cellMap = pl.cellsFromDesktopPositions(r.result, names);
    const items = candidatePaths.map((p) => ({ key: p, cell: cellMap.get(path.basename(p)) }));
    if (items.some((it) => !it.cell)) return null; // partial plan would scramble order
    const plan = pl.planDesktopOffsets(items);
    if (!plan) return null;
    return { paths: plan.order, offsets: plan.offsets };
  }

  const testResolveDrop = dm.testResolverFromEnv();
  const coldResolveDrop = dm.createPowerShellResolver(bundledScriptPath('resolve-drop.ps1'));
  async function resolveDropTarget(x, y) {
    if (testResolveDrop) return testResolveDrop(x, y);
    if (shellHelper) {
      const r = await shellHelper.request(
        'resolveDrop', { x: Math.round(x), y: Math.round(y) });
      if (r.ok && r.result) return dm.parseResolveOutput(JSON.stringify(r.result));
      // transport failure only: an authoritative 'unknown' from the
      // helper is returned as-is (the cold script would agree).
    }
    return coldResolveDrop(x, y);
  }
  // Desktop icon positioning (v1.3): after a Desktop move, place the
  // new icons at the drop point. Strictly best-effort — see
  // lib/iconpos.js. v2.2 routes it through the warm helper first
  // (its internal poll is tightened to ~50ms); the cold script is
  // the fallback, unchanged.
  const testPositionIcons = ip.testPositionerFromEnv();
  const coldPositionIcons = ip.createPowerShellPositioner(
    bundledScriptPath('position-desktop-icons.ps1'));
  async function positionDesktopIcons(x, y, names) {
    if (testPositionIcons) return testPositionIcons(x, y, names);
    if (shellHelper) {
      const r = await shellHelper.request(
        'positionIcons',
        { x: Math.round(x), y: Math.round(y), names },
        { timeoutMs: 10000 });
      if (r.ok && r.result) return ip.parsePositionOutput(JSON.stringify(r.result));
    }
    return coldPositionIcons(x, y, names);
  }

  // Every resolution is logged so the GUI test-suite can verify the
  // new IPC path (renderer outside-release -> main resolve -> move)
  // even though a real OS drop gesture cannot be automated.
  const dropLog = [];
  ipcMain.handle('resolve-drop-move', async (_e, payload) => {
    const paths = (payload && Array.isArray(payload.paths)) ? payload.paths : [];
    const x = payload ? Number(payload.screenX) : NaN;
    const y = payload ? Number(payload.screenY) : NaN;
    const result = {
      resolved: null, moved: [], skipped: [], failed: [], error: null,
      position: null, positionNote: '',
    };
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
          const allDestinations = [...r.destinations];
          // LINKED items dragged out are a REAL move too (v2.1 —
          // the user: 「ボードから外すをしなくても、ドラッグで
          // デスクトップとかに移動できるように」). Each one goes
          // through ln.moveLinkedOut: real move -> detach this
          // board's link -> -H at the destination so it lands
          // visible. An UNRESOLVED target never reaches this block,
          // so a cancelled drop changes nothing for linked items
          // either (plain removal stays the ボードから外す menu's
          // job). Other boards linking the old path keep their
          // record and will show it missing — intended.
          const linkedPaths = (payload && Array.isArray(payload.linkedPaths))
            ? payload.linkedPaths : [];
          if (linkedPaths.length && payload.boardName) {
            let folder = null;
            try { folder = guardBoard(payload.boardName); } catch (e) { folder = null; }
            if (folder) {
              for (const lp of linkedPaths) {
                const one = await ln.moveLinkedOut({
                  base: BASE, boardFolder: folder, targetPath: lp,
                  destDir: target.path, attrib, moveFile: moveFileViaDropmove,
                });
                if (one.moved) {
                  result.moved.push(lp);
                  if (one.dest) allDestinations.push(one.dest);
                  dropLog.push({ kind: 'move-linked', target: target.path, path: lp, dest: one.dest });
                } else {
                  result.failed.push(lp);
                }
              }
            }
          }
          dropLog.push({ kind: 'move', target: target.path, moved: result.moved.length });
          if (result.moved.length && win && !win.isDestroyed()) {
            win.webContents.send('fs-changed');
          }
          // Desktop drops only: put the new icon(s) where the user
          // actually dropped them. The move is already done — any
          // positioning failure is reported in the log/result but
          // never changes the move outcome.
          if (target.type === 'desktop' && result.moved.length && allDestinations.length) {
            const names = allDestinations.map((d) => path.basename(d));
            result.position = { status: 'script-error', positioned: 0, detail: 'not-run' };
            try {
              result.position = await positionDesktopIcons(x, y, names);
            } catch (e) {
              result.position = {
                status: 'script-error', positioned: 0,
                detail: String((e && e.message) || e).slice(0, 200),
              };
            }
            result.positionNote = ip.statusNoteFor(result.position);
            dropLog.push({
              kind: 'position', x, y, names,
              status: result.position.status,
              positioned: result.position.positioned,
              detail: result.position.detail || '',
            });
            // Diagnostics: positioning must never fail silently
            // again (v1.3.0's invisible bug). One line per drop in
            // <base>\okiba.log with the full result + the args.
            try {
              const line = new Date().toISOString() +
                ' drop-position status=' + result.position.status +
                ' positioned=' + result.position.positioned +
                ' detail=' + (result.position.detail || '') +
                ' names=' + names.join(', ') +
                ' drop=' + x + ',' + y + '\n';
              fs.appendFileSync(path.join(BASE, 'okiba.log'), line);
            } catch (e) { /* diagnostics must never break a move */ }
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
  // Test hook: when the attrib runner is the stub, expose its call
  // log so tests can verify +H / -H without a Windows shell.
  ipcMain.handle('test-attrib', () => {
    if (!attrib || !Array.isArray(attrib.calls)) return null;
    return {
      calls: attrib.calls,
      hidden: Object.fromEntries(attrib.state || []),
    };
  });
  // Test hook (v2.2): warm-helper counters. E2E asserts spawns===1
  // across several drag-out operations (process reuse) instead of
  // flaky wall-clock timing checks.
  ipcMain.handle('test-helper-stats', () => (shellHelper
    ? shellHelper.stats()
    : { enabled: false, spawns: 0, requests: 0, ok: 0, failed: 0 }));
}

app.whenReady().then(async () => {
  if (!gotSingleInstanceLock) return; // another instance owns the app
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
  // --board-path "<board folder>" (from a board shortcut) opens the
  // app directly into that board; the renderer asks for this route
  // once its home data has loaded.
  startupRoute = sc.routeFromArgv(process.argv, BASE);
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

app.on('will-quit', () => {
  if (shellHelper) shellHelper.dispose();
});

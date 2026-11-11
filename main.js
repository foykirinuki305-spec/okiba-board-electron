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
const mh = require('./lib/movehistory');
const cu = require('./lib/cleanup');
const pr = require('./lib/preresolve');
const dragCoords = require('./lib/dragcoords');

// Hidden-attribute runner for linked items (v2.0). Real attrib.exe
// in production; OKIBA_TEST_ATTRIB=stub swaps in the counting stub.
const attrib = ln.attribRunnerFromEnv();

// ------------------------------------------------------------------ paths
let BASE = null;
let MIGRATED_COUNT = 0;
// Files removed/healed by the once-per-version update cleanup
// (v2.2.1, Job 2); surfaced on the home screen as one status line.
let CLEANED_COUNT = 0;
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
// Read-only packaged watchdog smoke: no lease scope, Desktop enumeration or flags.
async function runReadonlyLeaseSmoke(base) {
  if(process.env.GITHUB_ACTIONS!=='true'||process.env.RUNNER_OS!=='Windows'||process.env.RUNNER_ENVIRONMENT!=='github-hosted')throw Error('readonly-lease-smoke-hosted-only');
  const temp=path.resolve(process.env.RUNNER_TEMP||require('os').tmpdir());
  if(!path.resolve(base).toLowerCase().startsWith((temp+path.sep).toLowerCase()))throw Error('smoke-base-not-isolated');
  const packed=path.join(process.resourcesPath,'scripts','shell-helper.ps1');
  const helperScript=fs.existsSync(packed)?packed:path.join(__dirname,'scripts','shell-helper.ps1');
  const client=require('./lib/desktop-lease-client').createDesktopLeaseClient({journalDir:path.join(base,'readonly-lease-smoke-journal'),helper:{command:'powershell.exe',args:['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',helperScript]},owner:{pid:process.pid},timeoutMs:60000});
  const evidence={packaged:app.isPackaged,watchdogModule:path.join(__dirname,'lib','desktop-lease-watchdog.js'),helperScript};
  try {
    evidence.ready=await client.ready();if(!evidence.ready.ok)throw Error('readonly-ready-failed');
    evidence.status=await client.status();if(!evidence.status.ok||evidence.status.phase!=='idle'||evidence.status.helper.spawns!==1)throw Error('readonly-status-failed');
    evidence.closed=await client.close();if(!evidence.closed.ok)throw Error('readonly-close-failed');
    const end=Date.now()+10000;while(client.diagnostics().connected&&Date.now()<end)await new Promise(r=>setTimeout(r,50));
    if(client.diagnostics().connected)throw Error('readonly-child-exit-unconfirmed');
    evidence.ok=true;
  }finally{client.disconnect();fs.writeFileSync(path.join(base,'readonly-lease-smoke.json'),JSON.stringify(evidence,null,2));}
}

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
    if(process.env.OKIBA_LEASE_READONLY_SMOKE==='1'){await runReadonlyLeaseSmoke(base);log.push('read-only packaged lease smoke OK');}
    log.push('in-app self-test OK');
    console.log(log.join('\n'));
    return 0;
  } catch (e) {
    console.error('in-app self-test FAILED: ' + (e && e.message || e));
    return 1;
  }
}

// -------------------------------------------------------------- thumbnails
const { createPreviewService } = require('./lib/previews');
const { createFileIconResolver } = require('./lib/shortcut-preview');
const fileIconFor = createFileIconResolver({
  readShortcutLink: (fullPath) => shell.readShortcutLink(fullPath),
  getFileIcon: (fullPath, options) => app.getFileIcon(fullPath, options),
  stat: (fullPath) => fs.promises.stat(fullPath),
  loadIcon: (fullPath) => nativeImage.createFromPath(fullPath),
});
const previewService = createPreviewService({
  stat: (fullPath) => fs.promises.stat(fullPath),
  thumbnail: (fullPath, options) => nativeImage.createThumbnailFromPath(fullPath, options),
  fileIcon: fileIconFor,
  isMedia: (fullPath) => ['image', 'video'].includes(kindOf(path.basename(fullPath), false)),
});
function thumbnailFor(fullPath, px) { return previewService.get(fullPath, px); }

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
  return previewService.peek(fullPath, px, notifyThumbsReady);
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
  let previewCandidates = 0;
  for (const e of items) {
    if (kinds.length < 6) kinds.push(kindOf(e.name, e.isDir));
    if (previewCandidates >= 6) continue;
    const kind = kindOf(e.name, e.isDir);
    if (kind === 'image' || kind === 'video') {
      previewCandidates++;
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
    cleaned: CLEANED_COUNT,
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

// ------------------------------------------- auto-cleanup (v2.2.1)
// Runs ONCE per version change, after the window is up: loose
// OkibaBoard exes left in Desktop/Downloads by chat deliveries
// are deleted, stale app shortcuts are deleted, and board
// shortcuts from older builds are healed onto the current exe
// (lib/cleanup.js holds the pure decisions). Failures never block
// startup; every action lands in <base>\okiba.log, one line each.
function cleanupScanDirs() {
  // OKIBA_CLEANUP_DESKTOP / OKIBA_CLEANUP_DOWNLOADS redirect the
  // scanned folders for the GUI E2E (same pattern as
  // OKIBA_SHORTCUT_DESKTOP) so tests never touch a real Desktop.
  let desktop = null;
  let downloads = null;
  try { desktop = process.env.OKIBA_CLEANUP_DESKTOP || app.getPath('desktop'); } catch (e) {}
  try { downloads = process.env.OKIBA_CLEANUP_DOWNLOADS || app.getPath('downloads'); } catch (e) {}
  return { desktop, downloads };
}

function listCleanupFiles(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true })
      .filter((e) => { try { return e.isFile(); } catch (err) { return false; } })
      .map((e) => path.join(dir, e.name));
  } catch (e) { return []; }
}

function runVersionCleanup() {
  // Development/test runs must never clean the real Desktop or Downloads.
  // Explicit redirected folders keep the cleanup integration test available.
  if (!app.isPackaged && (!process.env.OKIBA_CLEANUP_DESKTOP ||
      !process.env.OKIBA_CLEANUP_DOWNLOADS)) return;
  try {
    const current = app.getVersion();
    const home = bf.loadHome(BASE);
    if (!cu.shouldRunCleanup(current, home.appVersion)) return;
    const dirs = cleanupScanDirs();
    const desktopFiles = dirs.desktop ? listCleanupFiles(dirs.desktop) : [];
    const downloadsFiles = dirs.downloads ? listCleanupFiles(dirs.downloads) : [];
    const shortcuts = [];
    for (const lnkPath of desktopFiles.filter((p) => p.toLowerCase().endsWith('.lnk'))) {
      let info = null;
      try { info = shell.readShortcutLink(lnkPath); } catch (e) { info = null; }
      if (info && info.target) {
        shortcuts.push({
          lnkPath, target: info.target, args: info.args || '',
          icon: info.icon || '', iconIndex: info.iconIndex || 0,
          cwd: info.cwd || '', description: info.description || '',
        });
      }
    }
    const plan = cu.planCleanup({
      desktopFiles, downloadsFiles, shortcuts, execPath: process.execPath,
    });
    const logLine = (s) => {
      try {
        fs.appendFileSync(path.join(BASE, 'okiba.log'),
          new Date().toISOString() + ' cleanup ' + s + '\n');
      } catch (e) { /* diagnostics must never break the app */ }
    };
    let acted = 0;
    for (const p of plan.deleteFiles) {
      try {
        fs.rmSync(p, { force: true });
        if (!fs.existsSync(p)) { acted++; logLine('delete ' + p); }
      } catch (e) { /* locked/in-use files are skipped silently */ }
    }
    for (const p of plan.deleteShortcuts) {
      try {
        fs.rmSync(p, { force: true });
        if (!fs.existsSync(p)) { acted++; logLine('delete-shortcut ' + p); }
      } catch (e) { /* skipped silently */ }
    }
    for (const h of plan.healShortcuts) {
      try {
        const written = shell.writeShortcutLink(h.lnkPath, 'replace', {
          target: process.execPath,
          args: h.args,
          cwd: h.cwd || undefined,
          description: h.description || undefined,
          icon: h.icon || process.execPath,
          iconIndex: h.iconIndex || 0,
        });
        if (written) { acted++; logLine('heal-shortcut ' + h.lnkPath + ' -> ' + process.execPath); }
      } catch (e) { /* skipped silently */ }
    }
    CLEANED_COUNT = acted;
    // Stamp the marker LAST (positions/theme preserved), so the
    // cleanup runs exactly once per version change.
    try {
      const fresh = bf.loadHome(BASE);
      bf.saveHome(BASE, fresh.positions, fresh.theme, current);
    } catch (e) { /* a failed stamp only means a retry next launch */ }
    if (acted > 0 && win && !win.isDestroyed()) win.webContents.send('fs-changed');
  } catch (e) { /* cleanup must never block startup */ }
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

  // ------------------------- move-out history (v2.2.1, Job 3)
  // Every REAL move-out is recorded as ONE group per operation so
  // the file can be found again (「場所を開く」) or restored
  // (「ボードに戻す」). Recording must never break the move itself:
  // every call is wrapped and failures are swallowed.
  function snapshotBoard(boardName) {
    // Cells as they were BEFORE a move: resident positions by file
    // name, link records by path. Null when the board is unknown.
    try {
      const folder = guardBoard(boardName);
      const data = bf.loadBoard(folder);
      return { folder, positions: data.positions || {}, links: data.links || [] };
    } catch (e) { return null; }
  }
  function cellOfPos(pos) {
    return Array.isArray(pos) ? [pos[0], pos[1]] : [null, null];
  }
  function cellOfLink(links, targetPath) {
    const l = (links || []).find((x) => ln.samePath(x.path, targetPath));
    if (!l) return [null, null];
    return [
      Number.isFinite(l.col) ? l.col : null,
      Number.isFinite(l.row) ? l.row : null,
    ];
  }
  function recordHistory(boardName, snap, items, groupId) {
    try {
      if (!boardName || !items || !items.length) return;
      const folder = snap ? snap.folder : guardBoard(boardName);
      mh.recordItems(BASE, {
        id: groupId || undefined,
        boardName, boardFolder: folder, items,
      });
    } catch (e) { /* history is a rescue net, never a blocker */ }
  }

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
    const intakeStart = Date.now();
    const timings = { layoutMs: 0, placementMs: 0, loadMs: 0, registryMs: 0, attribMs: 0, saveMs: 0 };
    let intakeStatus = 'error';
    try {
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
          const layoutStart = Date.now();
          try {
            const plan = await desktopLayoutPlan(candidates);
            if (plan) { ordered = plan.paths; offsets = plan.offsets; }
          } catch (e) { /* layout lookup is best-effort: strip order */ }
          finally { timings.layoutMs += Date.now() - layoutStart; }
        }
      }
      let cells = null;
      if (anchor && ordered.length) {
        const placementStart = Date.now();
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
        finally { timings.placementMs += Date.now() - placementStart; }
      }
      for (let i = 0; i < ordered.length; i++) {
        const p = ordered[i];
        const r = await ln.addLink({
          base: BASE, boardFolder: folder, targetPath: p, attrib,
          cell: cells ? cells[i] : undefined, timings,
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
      intakeStatus = 'ok';
      return result;
    } finally {
      try {
        fs.appendFileSync(path.join(BASE, 'okiba.log'),
          new Date().toISOString() + ' intake ms' +
          ' release=' + intakeStart + ' count=' + (Array.isArray(paths) ? paths.length : 0) +
          ' layout=' + timings.layoutMs + ' placement=' + timings.placementMs +
          ' load=' + timings.loadMs + ' registry=' + timings.registryMs +
          ' attrib=' + timings.attribMs + ' save=' + timings.saveMs +
          ' total=' + (Date.now() - intakeStart) + ' status=' + intakeStatus + '\n');
      } catch (e) { /* diagnostics must never break intake */ }
    }
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

  // Desktop returns are planned as a complete group before any mutation.
  // No legacy cold positioner is used by this strict path.
  const safeDesk = require('./lib/safe-desktop');
  const leaseController=require('./lib/desktop-snap-lease-controller');
  const leaseReceipt=require('./lib/desktop-commit-receipt');
  let desktopLeaseClient=null,desktopLeasePending=false;
  function leaseOptIn(){return process.env.OKIBA_TEST_HOOKS==='1'&&process.env.OKIBA_TEST_SNAP_LEASE==='1';}
  function pendingLeaseResult(reason){return {moved:[],destinations:[],skipped:[],failed:[],error:'配置処理の結果を確認中です。再実行せず確認を待ってください。',reason,pendingVerification:true,retrySafe:false,position:{status:'pending'}};}
  function leaseClient(){
    if(desktopLeaseClient)return desktopLeaseClient;
    const fake=process.env.OKIBA_TEST_HELPER==='fake';
    const hosted=process.env.GITHUB_ACTIONS==='true'&&process.env.RUNNER_OS==='Windows'&&process.env.RUNNER_ENVIRONMENT==='github-hosted';
    if(!leaseOptIn()||(!fake&&!hosted))throw Error('lease-test-environment-required');
    const helper=fake?{command:process.execPath,args:[path.join(__dirname,'tools','fake-helper.js')],env:{...process.env,ELECTRON_RUN_AS_NODE:'1'}}:{command:'powershell.exe',args:['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',bundledScriptPath('shell-helper.ps1')]};
    desktopLeaseClient=require('./lib/desktop-lease-client').createDesktopLeaseClient({journalDir:path.join(app.getPath('userData'),'desktop-lease-journals'),helper,owner:{pid:process.pid}});
    app.once('will-quit',()=>desktopLeaseClient?.disconnect());
    return desktopLeaseClient;
  }
  const desktopCalibration = require('./lib/desktop-calibration');
  const calibrationCacheStore=require('./lib/desktop-calibration-cache');
  const calibrationCacheFile=path.join(app.getPath('userData'),'desktop-calibration-cache.json');
  let calibrationImportGeneration=-1,calibrationImportPromise=null;
  async function ensureCalibrationImported(){
    if(!shellHelper)return;
    shellHelper.start();
    const generation=shellHelper.stats().spawns;
    if(calibrationImportGeneration===generation)return calibrationImportPromise;
    calibrationImportGeneration=generation;
    calibrationImportPromise=(async()=>{
      const saved=calibrationCacheStore.load(calibrationCacheFile);
      if(!saved)return;
      const response=await shellHelper.request('importDesktopCalibration',saved,{timeoutMs:10000});
      try{fs.appendFileSync(path.join(BASE,'okiba.log'),new Date().toISOString()+' calibration-cache import '+JSON.stringify({generation,transportOk:response.ok,result:response.result})+'\n');}catch(_){}
    })();
    return calibrationImportPromise;
  }
  async function persistCalibrationEvidence(){
    if(!shellHelper)return;
    const response=await shellHelper.request('exportDesktopCalibration',{}, {timeoutMs:10000});
    if(response.ok&&response.result?.ok&&calibrationCacheStore.save(calibrationCacheFile,response.result))return;
    try{fs.appendFileSync(path.join(BASE,'okiba.log'),new Date().toISOString()+' calibration-cache save unavailable\n');}catch(_){}
  }

  const {createCrossVolumeMove}=require('./lib/cross-volume-move');
  function desktopReturnDir(){
    if(process.env.OKIBA_TEST_HOOKS==='1')return process.env.OKIBA_TEST_DESKTOP_DIR||process.env.OKIBA_SHORTCUT_DESKTOP||null;
    return shellDesktopDir()||bf.desktopDir();
  }
  let desktopBusy = false;
  let desktopUnsafe = false;
  function desktopBlocked(reason, recovery=[]) {
    let message='安全を確認できなかったため中止しました。';
    if(['occupied-or-outside','no-space'].includes(reason))message='並びを保って置けません。別の空いている場所へ戻してください。';
    else if(reason==='busy')message='前の取り出し処理が終わるまでお待ちください。';
    else if(reason==='helper-not-stopped')message='配置処理の停止を確認できません。アプリを再起動してください。';
    else if(reason==='cross-volume')message='別ドライブへの安全な取り出しは未対応のため中止しました。';
    else if(reason==='desktop-changed'||reason==='board-changed')message='配置が変わったため中止しました。もう一度操作してください。';
    if(recovery.length)message='一部の素材を元に戻せませんでした。保存先: '+recovery.map(r=>r.path).join(' / ');
    try{fs.appendFileSync(path.join(BASE,'okiba.log'),new Date().toISOString()+' safe-desktop blocked '+JSON.stringify({reason,recovery})+'\n');}catch(_){}
    return {moved:[],skipped:[],failed:[],blocked:true,reason,recovery,error:message};
  }
  async function desktopSnapshot() {
    if(process.env.OKIBA_TEST_HOOKS==='1' && process.env.OKIBA_TEST_POSITIONER==='stub') {
      if(process.env.OKIBA_TEST_DESKTOP_SNAPSHOT) return JSON.parse(process.env.OKIBA_TEST_DESKTOP_SNAPSHOT);
      return {ok:true,autoArrange:false,snap:true,sx:100,sy:100,gx:0,gy:0,origin:{x:0,y:0},
        areas:[{left:-1000,top:-1000,right:10000,bottom:10000}],icons:[]};
    }
    if(!shellHelper) return {ok:false};
    await ensureCalibrationImported();
    const r=await shellHelper.request('desktopSnapshot',{}, {timeoutMs:3000});
    return r.ok && r.result ? r.result : {ok:false};
  }
  async function atomicDesktopMove(source,destination) {
    if(process.env.OKIBA_TEST_HOOKS==='1'&&process.env.OKIBA_TEST_POSITIONER==='stub') {
      if(fs.existsSync(destination)){const e=Error('destination-occupied');e.win32Code=183;throw e;}
      fs.renameSync(source,destination);return;
    }
    if(!shellHelper)throw Error('helper-unavailable');
    const r=await shellHelper.request('moveNoReplace',{source,destination},{timeoutMs:15000});
    if(!r.ok){const stopped=await shellHelper.stopAndWait();if(!stopped)desktopUnsafe=true;const e=Error('move-outcome-unknown');e.unsafe=!stopped;throw e;}
    if(!r.result?.ok){const e=Error(r.result?.reason||'move-failed');e.win32Code=r.result?.errorCode;throw e;}
  }

  function crossVolumeOptions(source,destination,desktop) {
    const within=(candidate,root)=>{const r=path.relative(path.resolve(root),path.resolve(candidate));return r===''||(!r.startsWith('..'+path.sep)&&r!=='..'&&!path.isAbsolute(r));};
    const stagingParents=[];
    for(let candidate=path.dirname(source);;candidate=path.dirname(candidate)) {
      if(![BASE,desktop,source,destination].filter(Boolean).some(root=>within(candidate,root)))stagingParents.push(candidate);
      if(path.dirname(candidate)===candidate)break;
    }
    return {moveNoReplace:atomicDesktopMove,stagingParents,stagingExcludedRoots:[BASE,desktop].filter(Boolean)};
  }

  // BEGIN tested-desktop-rollback
  async function rollbackDesktopFile(item, io) {
    const isOriginal=p=>{const st=io.stat(p);return st.dev===item.identity.dev&&st.ino===item.identity.ino;};
    if(item.renamed) {
      if(!isOriginal(item.dest))throw Error('destination-changed');
      if(io.exists(item.path))throw Error('original-path-occupied');
      try {await io.move(item.dest,item.path);}
      catch(e) {
        if(e.unsafe)throw e;
        // A stopped helper may have completed the move but lost its response.
        if(!io.exists(item.path)||io.exists(item.dest)||!isOriginal(item.path))throw e;
      }
      item.renamed=false;item.recoveryPath=item.path;
    }
    if(item.visibilityChanged) {
      if(!isOriginal(item.path))throw Error('source-changed-before-attribute-restore');
      const a=await io.setHidden(item.path,item.hidden);if(!a?.ok)throw Error('attributes-restore-failed');
    }
  }
  // END tested-desktop-rollback

  // BEGIN tested-lease-metadata
  // Lease-only preparation: retain every unrelated field and saved position.
  function prepareLeaseMetadata(before,selected,samePath) {
    if(typeof before!=='string'||!Array.isArray(selected)||!selected.length)throw Error('lease-metadata-missing');
    const json=JSON.parse(before);
    if(!json||typeof json!=='object'||Array.isArray(json)||!Array.isArray(json.links))throw Error('lease-links-invalid');
    if(selected.some((p,n)=>typeof p!=='string'||selected.some((q,j)=>j<n&&samePath(p,q))))throw Error('lease-selection-invalid');
    for(const p of selected)if(json.links.filter(l=>l&&typeof l.path==='string'&&samePath(l.path,p)).length!==1)throw Error('lease-link-changed');
    json.links=json.links.filter(l=>!selected.some(p=>l&&typeof l.path==='string'&&samePath(l.path,p)));
    return JSON.stringify(json,null,2);
  }
  async function commitLeaseMetadata({before,after,expectedIdentity,io}) {
    // The caller MUST hold a watchdog commit permit. This is not an OS-level CAS:
    // an external write between the final check and replace remains a limitation.
    const unchanged=()=>io.read()===before&&io.identity()===expectedIdentity;
    if(!unchanged())throw Error('board-changed');
    let temporary;
    try {
      temporary=await io.writeTemporary(after);
      if(!unchanged())throw Error('board-changed');
      await io.replace(temporary);
      temporary=null;
    }finally{if(temporary)await io.removeTemporary(temporary);}
  }
  // END tested-lease-metadata

  async function safeDesktopMove(payload,target) {
    if(desktopLeasePending)return pendingLeaseResult('lease-verification-pending');
    if(desktopUnsafe)return desktopBlocked('helper-not-stopped');
    if(desktopBusy) return desktopBlocked('busy');
    desktopBusy=true;
    const started=Date.now();let planMs=0,positionMs=0;
    const diagnosticId=process.pid+'-'+started;
    const diagnostic=(phase,detail)=>{try{fs.appendFileSync(path.join(BASE,'okiba.log'),new Date().toISOString()+' safe-desktop diagnostic '+JSON.stringify({id:diagnosticId,phase,...detail})+'\n');}catch(_){}};
    try {
      if(!payload?.boardName || !target?.path) return desktopBlocked('unknown-board');
      const folder=guardBoard(payload.boardName), data=bf.loadBoard(folder);
      const targetStat=fs.statSync(target.path);if(!targetStat.isDirectory())return desktopBlocked('invalid-destination');
      const meta=path.join(folder,'.okiba-board.json');
      const readMeta=()=>{try{return fs.readFileSync(meta,'utf8');}catch(e){if(e.code==='ENOENT')return null;throw e;}};
      const before=readMeta();
      const residents=Array.isArray(payload.paths)?payload.paths:[];
      const linked=Array.isArray(payload.linkedPaths)?payload.linkedPaths:[];
      const requested=[...residents,...linked];
      if(!requested.length || new Set(requested.map(p=>path.resolve(p).toLowerCase())).size!==requested.length) return desktopBlocked('invalid-selection');
      const layout=new Map((payload.layout||[]).filter(i=>i&&typeof i.path==='string').map(i=>[path.resolve(i.path).toLowerCase(),i.cell]));
      const planned=[]; const reserved=new Set();
      for(const src of requested) {
        const isLink=linked.includes(src);
        const link=data.links.find(l=>ln.samePath(l.path,src));
        if(isLink ? !link : !ln.samePath(path.dirname(src),folder))return desktopBlocked('invalid-source');
        const st=fs.statSync(src);
        if(!st.isFile()&&!st.isDirectory())return desktopBlocked('invalid-source');
        const crossVolume=st.dev!==targetStat.dev;
        let cell=layout.get(path.resolve(src).toLowerCase()) || (isLink ? [link.col,link.row] : data.positions[path.basename(src)]);
        if(!Array.isArray(cell)||cell.length!==2||!cell.every(Number.isInteger))return desktopBlocked('unknown-layout');
        let dest=ln.samePath(path.dirname(src),target.path)?src:bf.uniqueDestination(target.path,path.basename(src));
        if(reserved.has(dest.toLowerCase()))return desktopBlocked('duplicate-destination');reserved.add(dest.toLowerCase());
        const attr=await attrib.readHidden(src);if(!attr?.ok)return desktopBlocked('unknown-attributes');
        planned.push({path:src,dest,name:path.basename(dest),cell,isLink,hidden:attr.hidden,identity:{dev:st.dev,ino:st.ino},crossVolume,crossTx:null,recoveryPath:src,renamed:false,visibilityChanged:false});
      }
      const anchor=Array.isArray(payload.anchorCell)?payload.anchorCell:[Math.min(...planned.map(i=>i.cell[0])),Math.min(...planned.map(i=>i.cell[1]))];
      if(anchor.length!==2||!anchor.every(Number.isInteger))return desktopBlocked('unknown-anchor');
      for(const item of planned)item.offset=[item.cell[0]-anchor[0],item.cell[1]-anchor[1]];
      const snap=await desktopSnapshot();
      const point=payload.automatic?null:{x:Number(payload.screenX)+Number(snap.origin?.x),y:Number(payload.screenY)+Number(snap.origin?.y)};
      let plan=safeDesk.planDesktop({snapshot:snap,items:planned,point,automatic:!!payload.automatic});
      let calibrationPlan=null,calibrationEvidence=null;
      if(!plan.ok&&(plan.reason==='unknown-desktop'||(payload.automatic&&plan.reason==='no-space'))) {
        const candidateAreas=(snap.areas||[]).map((area,index)=>({area,index})).filter(({area})=>Object.hasOwn(area,'grid')&&area.grid===null&&(payload.automatic||(point&&point.x>=area.left&&point.x<area.right&&point.y>=area.top&&point.y<area.bottom)));
        if(payload.automatic||candidateAreas.length===1)for(const {area,index} of candidateAreas) {
          const ratio=Number(area.scale)*96/(Number(snap.viewDpi)*100);
          if(!Number.isFinite(ratio)||ratio<=0||!Number.isInteger(snap.sx)||!Number.isInteger(snap.sy))continue;
          const maxSpacing={x:Math.ceil(snap.sx*Math.max(1,ratio)*1.25),y:Math.ceil(snap.sy*Math.max(1,ratio)*1.25)};
          const step=Math.ceil(Math.max(maxSpacing.x,maxSpacing.y)/16);
          const candidate=desktopCalibration.planCalibration({snapshot:snap,areaIndex:index,probeId:planned[0].dest,maxSpacing,step});
          if(candidate.ok&&candidate.requests.length<=192){calibrationPlan=candidate;plan={ok:true,calibrationPending:true};break;}
        }
      }
      planMs=Date.now()-started;
      diagnostic('plan',{automatic:!!payload.automatic,screenPoint:{x:payload.screenX,y:payload.screenY},clientPoint:point,anchor,geometry:{origin:snap.origin,sx:snap.sx,sy:snap.sy,gx:snap.gx,gy:snap.gy,areas:snap.areas,autoArrange:snap.autoArrange,snap:snap.snap,iconCount:snap.icons?.length},displays:screen.getAllDisplays().map(d=>({id:d.id,bounds:d.bounds,workArea:d.workArea,scaleFactor:d.scaleFactor})),items:planned.map(i=>({name:i.name,source:i.path,destination:i.dest,isLink:i.isLink,hidden:i.hidden,samePath:ln.samePath(i.path,i.dest),crossVolume:i.crossVolume,cell:i.cell,offset:i.offset})),plan});
      if(!plan.ok)return desktopBlocked(plan.reason);
      let leaseTransaction=null;
      if(leaseOptIn()) {
        const first=plan.targets?.[0];
        const targetAreaIndex=(snap.areas||[]).findIndex(a=>first&&first.x>=a.left&&first.x<a.right&&first.y>=a.top&&first.y<a.bottom);
        const candidate={kind:'samepath-hidden',desktop:target.path,items:planned.map(i=>({path:i.path,destination:i.dest,hidden:i.hidden,fileIdentity:String(i.identity.dev)+':'+String(i.identity.ino)})),snapshot:snap,targetAreaIndex,metadataPaths:[meta],targets:(plan.targets||[]).map(t=>({...t,path:planned.find(i=>i.path===t.path)?.dest})),buffer:plan.buffer};
        const eligible=!calibrationPlan&&planned.every(i=>i.isLink&&i.hidden&&ln.samePath(i.path,i.dest))&&leaseController.validateScope(candidate);
        if(eligible){
          const after=prepareLeaseMetadata(before,planned.map(i=>i.path),ln.samePath);
          const receipts=[{path:meta,beforeHash:leaseReceipt.hash(before),afterHash:leaseReceipt.hash(after)}];
          const identity=()=>{const st=fs.statSync(meta);return String(st.dev)+':'+String(st.ino);};
          const metadataIdentity=identity();
          const checkSources=()=>{for(const i of planned){const st=fs.statSync(i.path);if(st.dev!==i.identity.dev||st.ino!==i.identity.ino)throw Error('source-changed');}};
          checkSources();const client=leaseClient();const ready=await client.ready();if(!ready.ok)throw Error(ready.reason||'lease-not-ready');
          const scope=await client.prepareScope(candidate);checkSources();
          // Ordinary executeDesktop rollback is deliberately NOT used after a lease commit gate.
          const commitFn=async()=>commitLeaseMetadata({before,after,expectedIdentity:metadataIdentity,io:{
            read:readMeta,identity,
            writeTemporary:text=>{const tmp=meta+'.lease-'+process.pid+'-'+Date.now()+'.tmp';fs.writeFileSync(tmp,text,{encoding:'utf8',flag:'wx'});return tmp;},
            replace:tmp=>fs.renameSync(tmp,meta),
            removeTemporary:tmp=>{if(fs.existsSync(tmp))fs.unlinkSync(tmp);}
          }});
          leaseTransaction=await leaseController.runLease({scope,receipts,adapter:client.adapter(commitFn)});
          diagnostic('lease-transaction',{result:leaseTransaction});
          if(leaseTransaction.pendingVerification||(!leaseTransaction.ok&&leaseTransaction.resolution?.state!=='aborted')){desktopLeasePending=true;return pendingLeaseResult(leaseTransaction.reason);}
        }else diagnostic('lease-not-covered',{reason:calibrationPlan?'unknown-grid-calibration':'scope-not-supported',legacyArrivalRiskUnresolved:true});
      }
      const tx=leaseTransaction||await safeDesk.executeDesktop({items:planned,plan,snapshot:snap,adapter:{
        snapshot:desktopSnapshot,
        completePlanAfterFirstMove:calibrationPlan?async probe=>{
          if(!shellHelper)return {ok:false,reason:'helper-unavailable'};
          const calibrationStarted=Date.now();
          const response=await shellHelper.request('calibrateDesktopGrid',{snapshot:snap,probe:{path:probe.dest,name:probe.name},plan:calibrationPlan},{timeoutMs:100000});
          diagnostic('calibration-result',{elapsedMs:Date.now()-calibrationStarted,transportOk:response.ok,transportError:response.error,result:response.result});
          if(!response.ok){const stopped=await shellHelper.stopAndWait();if(!stopped)desktopUnsafe=true;diagnostic('calibration-helper-stop',{stopped});return {ok:false,reason:'calibration-unavailable',unsafe:!stopped};}
          if(!response.result?.ok)return response.result||{ok:false,reason:'calibration-unavailable'};
          const inferred=desktopCalibration.inferCalibration({plan:calibrationPlan,samples:response.result.samples});
          if(!inferred.ok)return inferred;
          if(typeof response.result.token!=='string'||!response.result.token)return {ok:false,reason:'missing-calibration-token'};
          calibrationEvidence={token:response.result.token,grid:inferred.grid};
          const calibrated={...snap,areas:snap.areas.map((area,index)=>index===calibrationPlan.areaIndex?{...area,grid:inferred.grid}:area)};
          // Reuse the user's original point and offsets, never the probe location.
          const completed=safeDesk.planDesktop({snapshot:calibrated,items:planned,point,automatic:!!payload.automatic});
          diagnostic('calibrated-plan',{areaIndex:calibrationPlan.areaIndex,grid:inferred.grid,plan:completed});
          return completed;
        }:null,
        async move(item) {
          const st=fs.statSync(item.path);if(st.dev!==item.identity.dev||st.ino!==item.identity.ino)throw Error('source-changed');
          if(!ln.samePath(item.path,item.dest)) {
            if(fs.existsSync(item.dest))throw Error('destination-changed');
            if(item.crossVolume){item.crossTx=createCrossVolumeMove(item.path,item.dest,crossVolumeOptions(item.path,item.dest,target.path));item.recoveryPath=item.dest;await item.crossTx.prepare();}
            else {
              try {await atomicDesktopMove(item.path,item.dest);item.renamed=true;item.recoveryPath=item.dest;}
              catch(e) {
                if(e.unsafe){item.recoveryPath=item.path+' / '+item.dest;throw e;}
                if(e.win32Code===17||e.code==='EXDEV') {
                  item.crossTx=createCrossVolumeMove(item.path,item.dest,crossVolumeOptions(item.path,item.dest,target.path));
                  item.recoveryPath=item.dest;await item.crossTx.prepare();
                } else {
                  if(!fs.existsSync(item.path)&&fs.existsSync(item.dest)){
                    const d=fs.statSync(item.dest);if(d.dev===item.identity.dev&&d.ino===item.identity.ino){item.renamed=true;item.recoveryPath=item.dest;}
                  }
                  throw e;
                }
              }
            }
          }
          if(item.hidden){item.visibilityChanged=true;const a=await attrib.setHidden(item.dest,false);if(!a?.ok)throw Error('unhide-failed');}
        },
        async position(snapshot,p) {
          if(process.env.OKIBA_TEST_HOOKS==='1'&&process.env.OKIBA_TEST_POSITIONER==='stub')return {ok:true};
          if(!shellHelper)return {ok:false,reason:'helper-unavailable'};
          const posStart=Date.now();
          const r=await shellHelper.request('positionDesktopPlan',{snapshot,targets:p.targets.map(t=>({...t,path:planned.find(i=>i.path===t.path).dest})),buffer:p.buffer,...(calibrationEvidence?{calibration:calibrationEvidence}:{})},{timeoutMs:60000});
          positionMs=Date.now()-posStart;
          diagnostic('position-result',{elapsedMs:positionMs,transportOk:r.ok,transportError:r.error,result:r.result});
          if(!r.ok){const stopped=await shellHelper.stopAndWait();if(!stopped)desktopUnsafe=true;diagnostic('helper-stop',{stopped});return {ok:false,reason:'position-unavailable',unsafe:!stopped,detail:r.error};}
          return r.result||{ok:false,reason:'position-unavailable'};
        },
        async commit() {
          for(const item of planned)if(item.crossTx){try{await item.crossTx.stageSource();}finally{item.recoveryPath=item.crossTx.recoveryPaths.join(" / ");}}
          if(readMeta()!==before)throw Error('board-changed');
          if(planned.some(i=>i.isLink)) {
            const json=before===null?{version:6,positions:{},links:[],notes:[],size_percent:100}:JSON.parse(before);
            json.links=(json.links||[]).filter(l=>!planned.some(i=>i.isLink&&ln.samePath(i.path,l.path)));
            const tmp=meta+'.safe-'+process.pid+'-'+Date.now()+'.tmp';
            try {fs.writeFileSync(tmp,JSON.stringify(json,null,2),'utf8');fs.renameSync(tmp,meta);}
            finally {try{if(fs.existsSync(tmp))fs.unlinkSync(tmp);}catch(_){}}
          }
        },
        async rollback(item) {
          if(item.crossTx){try{await item.crossTx.rollback();}catch(e){item.recoveryPath=item.crossTx.recoveryPaths.join(" / ");throw e;}item.recoveryPath=item.path;}
          await rollbackDesktopFile(item,{stat:fs.statSync,exists:fs.existsSync,move:atomicDesktopMove,setHidden:attrib.setHidden});
        }
      }});
      diagnostic('transaction-result',{result:tx});
      if(!tx.ok){try{fs.appendFileSync(path.join(BASE,'okiba.log'),new Date().toISOString()+' safe-desktop '+JSON.stringify(tx)+'\n');}catch(_){}return desktopBlocked(tx.reason,tx.recovery);}
      if(calibrationEvidence){try{await persistCalibrationEvidence();}catch(_){}}
      const warnings=[];
      for(const item of planned)if(item.crossTx){try{const cleaned=await item.crossTx.cleanup();if(!cleaned.ok)warnings.push(cleaned);}catch(e){warnings.push({warning:String(e.message||e),recovery:item.crossTx.recoveryPaths});}}
      for(const item of planned)if(item.crossTx){try{fs.appendFileSync(path.join(BASE,'okiba.log'),new Date().toISOString()+' safe-desktop cross-volume '+JSON.stringify(item.crossTx.timings)+'\n');}catch(_){}}
      if(warnings.length){try{fs.appendFileSync(path.join(BASE,'okiba.log'),new Date().toISOString()+' safe-desktop cleanup '+JSON.stringify(warnings)+'\n');}catch(_){}}
      try{recordHistory(payload.boardName,{folder,positions:data.positions,links:data.links},planned.map(i=>({kind:i.isLink?'linked':'resident',destPath:i.dest,fileName:i.name,col:i.cell[0],row:i.cell[1]})),payload.groupId);}catch(e){warnings.push({warning:"history-save-failed",recovery:planned.map(i=>i.dest)});}
      if(win&&!win.isDestroyed())win.webContents.send('fs-changed');
      return {metadataCommitted:leaseTransaction?.ok===true,moved:planned.map(i=>i.path),destinations:planned.map(i=>i.dest),skipped:[],failed:[],error:null,warnings,warningText:warnings.length?'元データの予備コピーが残っています: '+warnings.map(w=>w.backupPath||(w.recovery||[]).join(' / ')).join(' / '):'',position:{status:'ok',positioned:planned.length}};
    } catch(e){return desktopBlocked(String(e.message||e));}
    finally {desktopBusy=false;try{fs.appendFileSync(path.join(BASE,'okiba.log'),new Date().toISOString()+' safe-desktop ms plan='+planMs+' position='+positionMs+' total='+(Date.now()-started)+'\n');}catch(_){}}
  }
  ipcMain.handle('safe-takeout',(_e,payload)=>safeDesktopMove({...payload,automatic:true},{type:'desktop',path:desktopReturnDir()}));

  ipcMain.handle('move-linked-to-desktop', (_e, boardName, paths, groupId) => safeDesktopMove({boardName,linkedPaths:paths,paths:[],groupId,automatic:true},{type:'desktop',path:desktopReturnDir()}));
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
  ipcMain.handle('move-to-desktop', (_e, fullPath, boardName, groupId) => safeDesktopMove({boardName,paths:[fullPath],linkedPaths:[],groupId,automatic:true},{type:'desktop',path:desktopReturnDir()}));
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
  //   resolve the folder under the release point (PowerShell:
  //   WindowFromPoint -> Progman/WorkerW = Desktop, or the
  //   ShellWindows Explorer window's folder path; else unknown) —
  //   since v2.2.2 usually PRE-resolved during the drag itself
  //   (see startDragWatch) -> move the real files there with the
  //   intake rules.
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
  if (shellHelper) {shellHelper.start();ensureCalibrationImported().catch(()=>{});}
  // Test-only background prewarm; native owner pin is read-only and never blocks UI.
  if(leaseOptIn()) {
    Promise.resolve().then(()=>leaseClient().ready()).then(result=>{
      try{fs.appendFileSync(path.join(BASE,'okiba.log'),new Date().toISOString()+' lease-prewarm '+JSON.stringify(result)+'\n');}catch(_){}
    }).catch(error=>{try{fs.appendFileSync(path.join(BASE,'okiba.log'),new Date().toISOString()+' lease-prewarm '+JSON.stringify({ok:false,reason:String(error.message||error)})+'\n');}catch(_){}});
  }

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
  // One resolution through the channels, in precedence order: the
  // env test stub, the warm helper, the v2.1 cold-spawn script.
  // Used both by the drag-time pre-resolver below and by the
  // release-time fallback when no (usable) cache entry exists.
  async function resolveViaChannels(x, y) {
    if (testResolveDrop) return testResolveDrop(x, y);
    if (shellHelper) {
      const r = await shellHelper.request(
        'resolveDrop', { x: Math.round(x), y: Math.round(y) });
      if (r.ok && r.result) return dm.parseResolveOutput(JSON.stringify(r.result));
      // transport failure only: an authoritative 'unknown' from the
      // helper is returned as-is (the cold script would agree).
    }
    // Legacy cold process has no verified mixed-DPI awareness. Never move using uncertain coordinates.
    if (!dragCoords.coldResolveSafe(screen)) return {type:'unknown',reason:'native-coordinate-unavailable',error:'画面の座標を確認できなかったため移動を中止しました。OkibaBoardを再起動してもう一度お試しください。'};
    return coldResolveDrop(x, y);
  }

  // ------------------------- drag-out pre-resolve (v2.2.2)
  // Even with the warm helper, v2.2's release pipeline ran strictly
  // AFTER the release (detect -> resolve -> move -> position) and
  // the card waited for all of it. Now, while an item drag is in
  // progress, main polls the OS cursor through the helper
  // (cursorState, ~40ms — the renderer cannot see the pointer
  // reliably once it leaves the window) and PRE-RESOLVES the drop
  // target for outside points into lib/preresolve.js's cache. On
  // release the resolve-drop-move handler consults the cache
  // first: a fresh hit within ~12px of the release point starts
  // the move with NO resolve round-trip at all.
  //
  // The poll loop exists only for the life of one drag: the
  // renderer starts it when a drag first moves and stops it when
  // the gesture ends inside the window; an outside release is
  // consumed (and the loop stopped) by resolve-drop-move itself.
  // A button-up witnessed by the poll arms a safety stop so a
  // renderer that never reports cannot leave the loop running.
  // Zero cost while no drag is active.
  let dragWatch = null;
  const DRAG_POLL_MS = 40;
  function stopDragWatch() {
    if (!dragWatch) return;
    clearInterval(dragWatch.timer);
    dragWatch = null;
  }
  async function dragCursorState() {
    if (!shellHelper) return null;
    const r = await shellHelper.request('cursorState', {}, { timeoutMs: 1200 });
    if (!r.ok || !r.result) return null;
    const { x, y, lbtn } = r.result;
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    return { x, y, lbtn: !!lbtn };
  }
  function startDragWatch() {
    stopDragWatch();
    if (!shellHelper) return false; // no cursor witness -> no pre-resolve
    const cache = pr.createPreResolver({
      resolve: (x, y) => resolveViaChannels(x, y).then((t) => {
        dropLog.push({ kind: 'preresolve', x, y, type: t && t.type });
        return t;
      }),
    });
    const session = { cache, lastButton: null, upSeenAt: 0, timer: null };
    const tick = async () => {
      if (dragWatch !== session) return;
      const cs = await dragCursorState();
      if (dragWatch !== session || !cs) return;
      const now = Date.now();
      const b = (win && !win.isDestroyed()) ? win.getBounds() : null;
      const outside = dragCoords.outsideDipBounds(screen, cs, b);
      if (outside) session.cache.observe(cs.x, cs.y, now);
      // Button-up seen by the OS witness: the release happened
      // (usually a beat before the renderer's own pointerup lands),
      // so the cache is already warm for the handler — and if the
      // renderer never reports, the loop still retires itself.
      if (session.lastButton === true && cs.lbtn === false && !session.upSeenAt) {
        session.upSeenAt = now;
      }
      session.lastButton = cs.lbtn;
      if (session.upSeenAt && now - session.upSeenAt > 1500) stopDragWatch();
    };
    session.timer = setInterval(() => { tick().catch(() => {}); }, DRAG_POLL_MS);
    if (session.timer.unref) session.timer.unref();
    dragWatch = session;
    return true;
  }
  ipcMain.handle('drag-watch-start', () => ({ active: startDragWatch() }));
  ipcMain.handle('drag-watch-stop', () => { stopDragWatch(); return true; });
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

  // ------------------------- move-out history IPC (v2.2.1, Job 3)
  function historyForRenderer() {
    const deskDirs = [bf.desktopDir()];
    try {
      const d = app.getPath('desktop');
      if (d) deskDirs.push(d);
    } catch (e) {}
    const isDesktopDir = (dir) => deskDirs.some((d) => {
      try {
        return path.resolve(d).toLowerCase() === path.resolve(dir).toLowerCase();
      } catch (e) { return false; }
    });
    return mh.loadHistory(BASE).map((g) => ({
      ...g,
      items: g.items.map((it) => {
        const dir = path.dirname(it.destPath);
        return {
          ...it,
          exists: fs.existsSync(it.destPath),
          destDir: dir,
          destDirName: path.basename(dir),
          onDesktop: isDesktopDir(dir),
        };
      }),
    }));
  }

  // Restore a set of items from one history group (the whole group
  // for 「まとめてボードに戻す」, or a single item). Residents are
  // real-moved back into the board folder; linked items are
  // re-linked at their current path and hidden again. Placement
  // replays the original cells through lib/placement.js (occupied
  // cells scan forward to the nearest free one, layout preserved).
  // Items whose destination vanished stay in the history.
  async function restoreHistoryItems(group, scope) {
    const folder = group.boardFolder || (() => {
      try { return guardBoard(group.boardName); } catch (e) { return null; }
    })();
    if (!folder || !fs.existsSync(folder)) {
      return { restored: [], missing: scope.map((i) => i.fileName), error: 'board-missing' };
    }
    const { restorable, missing } = mh.planRestore(
      { items: scope }, (p) => fs.existsSync(p));
    if (!restorable.length) {
      return { restored: [], missing: missing.map((i) => i.fileName) };
    }
    const residentItems = restorable.filter((i) => i.kind === 'resident');
    const linkedItems = restorable.filter((i) => i.kind === 'linked');
    // 1) residents: real move back into the board folder.
    const actualDest = new Map();
    if (residentItems.length) {
      const placed = bf.placeDroppedItems(
        residentItems.map((i) => i.destPath), folder);
      let pi = 0;
      for (const item of residentItems) {
        if (path.resolve(path.dirname(item.destPath)) === path.resolve(folder)) {
          actualDest.set(item, item.destPath); // already inside (edge)
        } else {
          actualDest.set(item, placed[pi++] || null);
        }
      }
    }
    // 2) one placement pass for everything, original layout order.
    let rowsPerCol = 8;
    for (const i of restorable) {
      if (i.row != null) rowsPerCol = Math.max(rowsPerCol, i.row + 1);
    }
    const data = bf.loadBoard(folder);
    const restoredNames = new Set(
      [...actualDest.values()].filter(Boolean).map((p) => path.basename(p)));
    const { occupied } = pl.computeCells({
      entries: bf.scanFolder(folder).filter((e) => !restoredNames.has(e.name)),
      positions: Object.fromEntries(Object.entries(data.positions)
        .filter(([n]) => !restoredNames.has(n))),
      notes: data.notes, links: data.links, rowsPerCol,
    });
    const ordered = restorable.map((item, idx) => ({ item, idx }))
      .sort((a, b) => {
        const ka = (a.item.col == null || a.item.row == null)
          ? null : a.item.col * 10000 + a.item.row;
        const kb = (b.item.col == null || b.item.row == null)
          ? null : b.item.col * 10000 + b.item.row;
        if (ka === null && kb === null) return a.idx - b.idx;
        if (ka === null) return 1;
        if (kb === null) return -1;
        return ka - kb || a.idx - b.idx;
      })
      .map((x) => x.item);
    const firstCell = ordered.find((i) => i.col != null && i.row != null);
    const anchor = firstCell ? [firstCell.col, firstCell.row] : [0, 0];
    const offsets = ordered.map((item, i) => (
      (item.col != null && item.row != null)
        ? [item.col - anchor[0], item.row - anchor[1]]
        : [0, i]));
    const cells = pl.placeItems({
      occupied, anchor, offsets, count: ordered.length, rowsPerCol,
    });
    const cellFor = new Map(ordered.map((item, i) => [item, cells[i]]));
    // 3) linked: re-link at the current path, hidden again.
    for (const item of linkedItems) {
      await ln.addLink({
        base: BASE, boardFolder: folder, targetPath: item.destPath,
        attrib, cell: cellFor.get(item),
      });
    }
    // 4) residents: save their cells (reload first so step 3's
    // board saves are not clobbered).
    if (residentItems.length) {
      const data2 = bf.loadBoard(folder);
      for (const item of residentItems) {
        const dest = actualDest.get(item);
        if (dest) data2.positions[path.basename(dest)] = cellFor.get(item);
      }
      bf.saveBoard(folder, data2.positions, data2.notes,
        data2.sizePercent, data2.links);
    }
    // 5) restored items leave the history; missing ones stay.
    mh.removeItems(BASE, group.id, restorable.map((i) => i.destPath));
    if (win && !win.isDestroyed()) win.webContents.send('fs-changed');
    return {
      restored: restorable.map((i) => i.fileName),
      missing: missing.map((i) => i.fileName),
    };
  }

  ipcMain.handle('get-move-history', () => historyForRenderer());
  ipcMain.handle('restore-history-group', async (_e, groupId) => {
    const group = mh.findGroup(BASE, groupId);
    if (!group) return { restored: [], missing: [], error: 'not-found' };
    return restoreHistoryItems(group, group.items);
  });
  ipcMain.handle('restore-history-item', async (_e, groupId, destPath) => {
    const group = mh.findGroup(BASE, groupId);
    if (!group) return { restored: [], missing: [], error: 'not-found' };
    const item = group.items.find((i) => i.destPath === destPath);
    if (!item) return { restored: [], missing: [], error: 'not-found' };
    return restoreHistoryItems(group, [item]);
  });
  ipcMain.handle('discard-history-item', (_e, groupId, destPath) => {
    mh.removeItems(BASE, groupId, [destPath]);
    return historyForRenderer();
  });
  ipcMain.handle('discard-history-group', (_e, groupId) => {
    mh.removeGroup(BASE, groupId);
    return historyForRenderer();
  });

  // Every resolution is logged so the GUI test-suite can verify the
  // new IPC path (renderer outside-release -> main resolve -> move)
  // even though a real OS drop gesture cannot be automated.
  const dropLog = [];
  ipcMain.handle('resolve-drop-move', async (_e, payload) => {
    // Renderer screenX/Y and cursor-point are DIP; native cache/resolve/plan are physical.
    // Do not resample the live cursor: the user may already have moved it.
    try { payload = dragCoords.physicalDropPayload(screen, payload); }
    catch (e) { stopDragWatch(); return {moved:[],skipped:[],failed:[],error:'invalid-screen-point'}; }
    // Stage timings for the v2.2.2 latency work: one summary line
    // per real drag-out lands in <base>\okiba.log —
    //   dragout ms release=<epoch> resolve=<ms|pre> move=<ms>
    //              position=<ms|skip> total=<ms>
    // so the next "still slow" report points at a stage, not a
    // feeling. `release` is when this handler was entered.
    const t0 = Date.now();
    let resolveStage = 'resolve'; // 'pre' when the drag-time cache hit
    let resolveMs = 0;
    let moveMs = 0;
    let positionMs = null; // null -> 'skip' in the timing line
    let appearMs = null;
    let workMs = null;
    const writeTiming = () => {
      const totalMs = Date.now() - t0;
      try {
        fs.appendFileSync(path.join(BASE, 'okiba.log'),
          new Date().toISOString() + ' dragout ms' +
          ' release=' + t0 +
          ' resolve=' + (resolveStage === 'pre' ? 'pre' : resolveMs) +
          ' move=' + moveMs +
          ' position=' + (positionMs === null ? 'skip' : positionMs) +
          ' appear=' + (appearMs === null ? 'unknown' : appearMs) +
          ' work=' + (workMs === null ? 'unknown' : workMs) +
          ' total=' + totalMs + '\n');
      } catch (e) { /* diagnostics must never break a move */ }
      dropLog.push({
        kind: 'timing', resolveStage, resolveMs, moveMs, positionMs, appearMs, workMs, totalMs,
      });
    };
    const paths = (payload && Array.isArray(payload.paths)) ? payload.paths : [];
    const x = payload ? Number(payload.screenX) : NaN;
    const y = payload ? Number(payload.screenY) : NaN;
    const result = {
      resolved: null, moved: [], skipped: [], failed: [], error: null,
      position: null, positionNote: '',
    };
    // History snapshot: cells BEFORE anything moves (v2.2.1 Job 3).
    const histSnap = (payload && payload.boardName)
      ? snapshotBoard(payload.boardName) : null;
    const histItems = [];
    try {
      // v2.2.2: a drag-time PRE-RESOLVED answer (see startDragWatch)
      // whose point is within ~12px of the release point and still
      // fresh is used IMMEDIATELY — the move starts with no resolve
      // round-trip on the critical path. Anything else falls back
      // to resolving here, exactly as before.
      let target = null;
      if (dragWatch && Number.isFinite(x) && Number.isFinite(y)) {
        const hit = dragWatch.cache.lookup(Math.round(x), Math.round(y), t0);
        if (hit) { target = hit.target; resolveStage = 'pre'; }
      }
      stopDragWatch(); // this drag is over either way
      if (!target) {
        const rs = Date.now();
        target = (Number.isFinite(x) && Number.isFinite(y))
          ? await resolveViaChannels(x, y)
          : { type: 'unknown' };
        resolveMs = Date.now() - rs;
      }
      result.resolved = target;
      if (target?.error) result.error = target.error;
      dropLog.push({ kind: 'resolve', x, y, target, pre: resolveStage === 'pre' });
      if(target?.type==='desktop' && target.path) {
        const tm=Date.now();const strict=await safeDesktopMove(payload,target);moveMs=Date.now()-tm;
        dropLog.push({kind:'safe-desktop',ok:!strict.error,reason:strict.reason||null});
        writeTiming();return {...result,...strict,resolved:target};
      }
      if (target && target.path) {
        let isDir = false;
        try { isDir = fs.statSync(target.path).isDirectory(); } catch (e) { isDir = false; }
        if (isDir) {
          const tm = Date.now();
          const r = dm.moveItemsOut(paths, target.path);
          result.moved = r.moved;
          result.skipped = r.skipped;
          result.failed = r.failed;
          const allDestinations = [...r.destinations];
          for (const pair of r.pairs || []) {
            const [c, rr] = cellOfPos(histSnap
              ? histSnap.positions[path.basename(pair.src)] : null);
            histItems.push({
              kind: 'resident', destPath: pair.dest,
              fileName: path.basename(pair.dest), col: c, row: rr,
            });
          }
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
                  if (one.dest) {
                    allDestinations.push(one.dest);
                    const [c, rr] = cellOfLink(histSnap ? histSnap.links : [], lp);
                    histItems.push({
                      kind: 'linked', destPath: one.dest,
                      fileName: path.basename(one.dest), col: c, row: rr,
                    });
                  }
                  dropLog.push({ kind: 'move-linked', target: target.path, path: lp, dest: one.dest });
                } else {
                  result.failed.push(lp);
                }
              }
            }
          }
          moveMs = Date.now() - tm;
          if (histItems.length && payload.boardName) {
            recordHistory(payload.boardName, histSnap, histItems);
          }
          dropLog.push({ kind: 'move', target: target.path, moved: result.moved.length });
          if (result.moved.length && win && !win.isDestroyed()) {
            win.webContents.send('fs-changed');
          }
          // Desktop drops only: put the new icon(s) where the user
          // actually dropped them. v2.2.2 OPTIMISTIC REPLY: the
          // handler returns as soon as the fs move is done — the
          // renderer removes the cards and shows the result right
          // away instead of waiting out positioning (icon-appear
          // polling + set/read-back retries can take seconds).
          // Positioning continues fire-and-forget as a cosmetic
          // follow-up: it still logs its dropLog entry and its
          // okiba.log lines when it lands, completes the dragout
          // timing line, and only touches the status line if it
          // FAILS in a way v1.3.1+ reported (via the 'status'
          // push the renderer's onStatus shows as a toast).
          if (target.type === 'desktop' && result.moved.length && allDestinations.length) {
            const names = allDestinations.map((d) => path.basename(d));
            (async () => {
              const tp = Date.now();
              let pos = { status: 'script-error', positioned: 0, detail: 'not-run' };
              try {
                pos = await positionDesktopIcons(x, y, names);
              } catch (e) {
                pos = {
                  status: 'script-error', positioned: 0,
                  detail: String((e && e.message) || e).slice(0, 200),
                };
              }
              positionMs = Date.now() - tp;
              appearMs = Number.isFinite(pos.appearMs) && pos.appearMs >= 0 ? pos.appearMs : null;
              workMs = Number.isFinite(pos.workMs) && pos.workMs >= 0 ? pos.workMs : null;
              dropLog.push({
                kind: 'position', x, y, names,
                status: pos.status,
                positioned: pos.positioned,
                detail: pos.detail || '',
              });
              // Diagnostics: positioning must never fail silently
              // again (v1.3.0's invisible bug). One line per drop
              // in <base>\okiba.log with the full result + the args.
              try {
                const line = new Date().toISOString() +
                  ' drop-position status=' + pos.status +
                  ' positioned=' + pos.positioned +
                  ' detail=' + (pos.detail || '') +
                  ' names=' + names.join(', ') +
                  ' drop=' + x + ',' + y + '\n';
                fs.appendFileSync(path.join(BASE, 'okiba.log'), line);
              } catch (e) { /* diagnostics must never break a move */ }
              writeTiming();
              const note = ip.statusNoteFor(pos);
              if (note && win && !win.isDestroyed()) {
                win.webContents.send('status', 'デスクトップへ移動しました。' + note);
              }
            })().catch(() => { /* positioning is best-effort, always */ });
            return result;
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
    writeTiming();
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
  // Once-per-version update cleanup (v2.2.1): fire and forget —
  // it runs after the window is up and never blocks startup.
  runVersionCleanup();
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

'use strict';
const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('okiba', {
  // real path for a File object from a drop / drag event (Electron 32+)
  getPathForFile: (file) => webUtils.getPathForFile(file),

  copySelectedOut: (payload) => ipcRenderer.invoke('copy-selected-out', payload),

  findMissingMaterial: (name,oldPath) => ipcRenderer.invoke('find-missing-material',name,oldPath),
  repairMissingMaterial: token => ipcRenderer.invoke('repair-missing-material',token),
  getHome: () => ipcRenderer.invoke('get-home'),
  getBoard: (name) => ipcRenderer.invoke('get-board', name),
  watchHome: () => ipcRenderer.invoke('watch-home'),
  thumb: (fullPath) => ipcRenderer.invoke('thumb', fullPath),

  createBoard: (name) => ipcRenderer.invoke('create-board', name),
  renameBoard: (oldName, newName) => ipcRenderer.invoke('rename-board', oldName, newName),
  trashBoard: (name) => ipcRenderer.invoke('trash-board', name),
  openBoardFolder: (name) => ipcRenderer.invoke('open-board-folder', name),

  saveHomePositions: (positions) => ipcRenderer.invoke('save-home-positions', positions),
  setTheme: (theme) => ipcRenderer.invoke('set-theme', theme),
  saveBoard: (name, positions, notes, sizePercent, links, expectedRevision) =>
    ipcRenderer.invoke('save-board', name, positions, notes, sizePercent, links, expectedRevision),

  // linked items (v2.0): intake registers a reference and hides the
  // original in place; unlink restores visibility; trashLinked is
  // the explicit REAL-file delete.
  linkFiles: (boardName, paths, placeOpts) =>
    ipcRenderer.invoke('link-files', boardName, paths, placeOpts),
  unlinkItems: (boardName, paths) => ipcRenderer.invoke('unlink-items', boardName, paths),
  renameLinked: (boardName, oldPath, newName) =>
    ipcRenderer.invoke('rename-linked', boardName, oldPath, newName),
  trashLinked: (boardName, targetPath) =>
    ipcRenderer.invoke('trash-linked', boardName, targetPath),
  testAttrib: () => ipcRenderer.invoke('test-attrib'),

  // per-board shortcuts (v2.1): write a Desktop .lnk that relaunches
  // the app into one board; getStartupRoute/onOpenBoardRequest carry
  // the --board-path routing at first launch and on second-instance.
  createBoardShortcut: (name) => ipcRenderer.invoke('create-board-shortcut', name),
  readShortcut: (lnkPath) => ipcRenderer.invoke('read-shortcut', lnkPath),
  getStartupRoute: () => ipcRenderer.invoke('get-startup-route'),
  onOpenBoardRequest: (cb) =>
    ipcRenderer.on('open-board-request', (_e, route) => cb(route)),

  openItem: (p) => ipcRenderer.invoke('open-item', p),
  showItem: (p) => ipcRenderer.invoke('show-item', p),
  trashItem: (p) => ipcRenderer.invoke('trash-item', p),
  renameItem: (p, newName) => ipcRenderer.invoke('rename-item', p, newName),
  safeTakeout: (payload) => ipcRenderer.invoke('safe-takeout', payload),
  moveToDesktop: (p, boardName, groupId) =>
    ipcRenderer.invoke('move-to-desktop', p, boardName, groupId),
  dropFiles: (boardName, paths, placeOpts) =>
    ipcRenderer.invoke('drop-files', boardName, paths, placeOpts),

  // drag-out (v1.2): self-implemented move on outside release.
  // resolveDropMove asks main to resolve the folder under the given
  // screen point (Desktop / Explorer window) and move the files
  // there — resident files in `paths`, linked originals in
  // `linkedPaths` (v2.1: a real move + detach for them too).
  // cursorPoint is the OS cursor position (backup signal).
  resolveDropMove: (payload) => ipcRenderer.invoke('resolve-drop-move', payload),
  // drag-out pre-resolve (v2.2.2): the renderer starts main's
  // cursor poll when an item drag first moves (main pre-resolves
  // outside drop targets during the drag so the release starts
  // the move instantly) and stops it when the gesture ends
  // inside the window. An outside release is consumed — and the
  // poll stopped — by resolveDropMove itself.
  dragWatchStart: () => ipcRenderer.invoke('drag-watch-start'),
  dragWatchStop: () => ipcRenderer.invoke('drag-watch-stop'),
  moveLinkedToDesktop: (boardName, paths, groupId) =>
    ipcRenderer.invoke('move-linked-to-desktop', boardName, paths, groupId),

  // move-out history (v2.2.1): grouped by move operation (newest 5).
  // 「場所を開く」 reuses showItem above (shell.showItemInFolder).
  getMoveHistory: () => ipcRenderer.invoke('get-move-history'),
  restoreHistoryGroup: (groupId) =>
    ipcRenderer.invoke('restore-history-group', groupId),
  restoreHistoryItem: (groupId, destPath) =>
    ipcRenderer.invoke('restore-history-item', groupId, destPath),
  discardHistoryItem: (groupId, destPath) =>
    ipcRenderer.invoke('discard-history-item', groupId, destPath),
  discardHistoryGroup: (groupId) =>
    ipcRenderer.invoke('discard-history-group', groupId),
  cursorPoint: () => ipcRenderer.invoke('cursor-point'),
  // test hook: read back main's resolve/move invocation log
  dropLog: () => ipcRenderer.invoke('test-droplog'),
  // test hook (v2.2): warm-helper counters (spawns / requests)
  helperStats: () => ipcRenderer.invoke('test-helper-stats'),

  onFsChanged: (cb) => ipcRenderer.on('fs-changed', cb),
  onStatus: (cb) => ipcRenderer.on('status', (_e, msg) => cb(msg)),
});

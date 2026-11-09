'use strict';
const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('okiba', {
  // real path for a File object from a drop / drag event (Electron 32+)
  getPathForFile: (file) => webUtils.getPathForFile(file),

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
  saveBoard: (name, positions, notes, sizePercent) =>
    ipcRenderer.invoke('save-board', name, positions, notes, sizePercent),

  openItem: (p) => ipcRenderer.invoke('open-item', p),
  showItem: (p) => ipcRenderer.invoke('show-item', p),
  trashItem: (p) => ipcRenderer.invoke('trash-item', p),
  renameItem: (p, newName) => ipcRenderer.invoke('rename-item', p, newName),
  moveToDesktop: (p) => ipcRenderer.invoke('move-to-desktop', p),
  dropFiles: (boardName, paths) => ipcRenderer.invoke('drop-files', boardName, paths),

  // drag-out (v1.2): self-implemented move on outside release.
  // resolveDropMove asks main to resolve the folder under the given
  // screen point (Desktop / Explorer window) and move the files
  // there; cursorPoint is the OS cursor position (backup signal).
  resolveDropMove: (paths, screenX, screenY) =>
    ipcRenderer.invoke('resolve-drop-move', { paths, screenX, screenY }),
  cursorPoint: () => ipcRenderer.invoke('cursor-point'),
  // test hook: read back main's resolve/move invocation log
  dropLog: () => ipcRenderer.invoke('test-droplog'),

  onFsChanged: (cb) => ipcRenderer.on('fs-changed', cb),
  onStatus: (cb) => ipcRenderer.on('status', (_e, msg) => cb(msg)),
});

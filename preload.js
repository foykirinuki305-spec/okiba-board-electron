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

  startDrag: (fullPath) => ipcRenderer.send('ondragstart', fullPath),
  // test hook: read back the main process's startDrag invocation log
  dragLog: () => ipcRenderer.invoke('test-draglog'),

  onFsChanged: (cb) => ipcRenderer.on('fs-changed', cb),
});

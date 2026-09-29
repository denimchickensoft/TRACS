'use strict'

const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('electronAPI', {
  getVersion:       () => ipcRenderer.invoke('app:getVersion'),
  pickLnmDatabase:  () => ipcRenderer.invoke('lnm:pickDatabase'),

  // The docs pages' Ctrl+F box (server/src/docsFind.js, electron/findBar.html).
  openFind:         () => ipcRenderer.invoke('find:open'),
  closeFind:        () => ipcRenderer.invoke('find:close'),

  downloadUpdate:   () => ipcRenderer.invoke('update:download'),
  installUpdate:    () => ipcRenderer.invoke('update:install'),
  openReleasePage:  () => ipcRenderer.invoke('update:openReleasePage'),
  getUpdateState:   () => ipcRenderer.invoke('update:getState'),
  // Returns an unsubscribe function.
  onUpdateState:    (cb) => {
    const listener = (_e, state) => cb(state)
    ipcRenderer.on('update:state', listener)
    return () => ipcRenderer.removeListener('update:state', listener)
  },
})

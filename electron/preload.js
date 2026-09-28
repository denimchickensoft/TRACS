'use strict'

const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('electronAPI', {
  getVersion:       () => ipcRenderer.invoke('app:getVersion'),
  pickLnmDatabase:  () => ipcRenderer.invoke('lnm:pickDatabase'),

  // Page search for the docs pages' Ctrl+F bar (server/src/docsFind.js).
  findInPage:       (text, options) => ipcRenderer.invoke('find:start', text, options),
  stopFindInPage:   () => ipcRenderer.invoke('find:stop'),
  onFindResult:     (cb) => ipcRenderer.on('find:result', (_e, result) => cb(result)),

  downloadUpdate:   () => ipcRenderer.invoke('update:download'),
  installUpdate:    () => ipcRenderer.invoke('update:install'),
  openReleasePage:  () => ipcRenderer.invoke('update:openReleasePage'),
  onUpdateAvailable:   (cb) => ipcRenderer.on('update:available',    (_e, version) => cb(version)),
  onUpdateNotifyOnly:  (cb) => ipcRenderer.on('update:notify-only',  (_e, version) => cb(version)),
  onUpdateProgress:    (cb) => ipcRenderer.on('update:progress',     (_e, percent) => cb(percent)),
  onUpdateDownloaded:  (cb) => ipcRenderer.on('update:downloaded',   () => cb()),
})

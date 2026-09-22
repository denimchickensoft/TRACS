'use strict'

const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('electronAPI', {
  getVersion:       () => ipcRenderer.invoke('app:getVersion'),
  pickLnmDatabase:  () => ipcRenderer.invoke('lnm:pickDatabase'),

  downloadUpdate:   () => ipcRenderer.invoke('update:download'),
  installUpdate:    () => ipcRenderer.invoke('update:install'),
  openReleasePage:  () => ipcRenderer.invoke('update:openReleasePage'),
  onUpdateAvailable:   (cb) => ipcRenderer.on('update:available',    (_e, version) => cb(version)),
  onUpdateNotifyOnly:  (cb) => ipcRenderer.on('update:notify-only',  (_e, version) => cb(version)),
  onUpdateProgress:    (cb) => ipcRenderer.on('update:progress',     (_e, percent) => cb(percent)),
  onUpdateDownloaded:  (cb) => ipcRenderer.on('update:downloaded',   () => cb()),
})

'use strict'

// Preload for findBar.html: the few calls the find box needs, nothing else.

const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('findBar', {
  info:     () => ipcRenderer.invoke('findbar:info'),
  search:   (text, forward, newSearch) => ipcRenderer.invoke('findbar:search', text, forward, newSearch),
  close:    () => ipcRenderer.invoke('findbar:close'),
  onResult: (cb) => ipcRenderer.on('findbar:result', (_e, result) => cb(result)),
  onOpened: (cb) => ipcRenderer.on('findbar:opened', () => cb()),
})

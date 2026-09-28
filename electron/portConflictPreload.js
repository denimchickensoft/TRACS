'use strict'

const { contextBridge, ipcRenderer } = require('electron')

// Only for electron/portConflict.html, the startup dialog shown when TRACS's
// saved port is taken. Main checks every call comes from that window.
contextBridge.exposeInMainWorld('portConflict', {
  info:     ()       => ipcRenderer.invoke('port-conflict:info'),
  resize:   (height) => ipcRenderer.invoke('port-conflict:resize', height),
  retry:    ()       => ipcRenderer.invoke('port-conflict:retry'),
  fallback: ()       => ipcRenderer.invoke('port-conflict:fallback'),
  quit:     ()       => ipcRenderer.invoke('port-conflict:quit'),
})

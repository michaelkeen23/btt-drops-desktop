// Bridge for the LOCAL settings page (settings.html) only. Never attached to a remote origin.
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('bd', {
  get: () => ipcRenderer.invoke('bd:get'),
  set: (patch) => ipcRenderer.invoke('bd:set', patch),
  preview: (id, volume) => ipcRenderer.invoke('bd:preview', { id, volume }),
  test: () => ipcRenderer.invoke('bd:test'),
  openDrops: () => ipcRenderer.invoke('bd:open'),
  checkUpdates: () => ipcRenderer.invoke('bd:update'),
})

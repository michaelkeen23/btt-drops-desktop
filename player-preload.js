// Bridge for the hidden audio window. The only thing it can do is receive a "play this file at this
// volume" message from the main process.
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('bdPlayer', {
  onPlay: (cb) => ipcRenderer.on('play', (_e, payload) => { try { cb(payload) } catch (_) {} }),
})

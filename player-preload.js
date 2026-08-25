// Bridge for the hidden audio window. The only thing it can do is receive a "play this file at this
// volume" message from the main process.
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('bdPlayer', {
  onPlay: (cb) => ipcRenderer.on('play', (_e, payload) => { try { cb(payload) } catch (_) {} }),
  // Playback either happened or it didn't. Reporting back is what makes a silent machine diagnosable
  // instead of a mystery — the settings window shows the last failure.
  report: (ok, error) => ipcRenderer.send('bd:sound-report', { ok: !!ok, error: error ? String(error) : null }),
})

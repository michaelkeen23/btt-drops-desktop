// Bridge exposed to the HOSTED page (firetickets.ai/btt/drops).
//
// Deliberately narrow. The settings window gets its own, much wider preload — a remote origin, even our
// own, has no business writing the alert configuration.
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('bttDropsDesktop', {
  isDesktop: true,
  // Let the page raise a native toast (it plays the chosen alert sound too).
  notify: (title, body) => ipcRenderer.send('bd:notify', { title, body }),
  // The page calls this when someone acknowledges a priority event, so the desktop nag loop stops too.
  acknowledged: (hex) => ipcRenderer.send('bd:acknowledged', String(hex || '')),
  // "Alert settings" in the page can open the desktop sound picker.
  openSettings: () => ipcRenderer.send('bd:open-settings'),
})

// Bridge exposed to the HOSTED drop-checker page.
//
// Deliberately narrow. The settings window gets its own, much wider preload — a remote origin, even our
// own, has no business writing the alert configuration.
//
// NOTE: a preload runs SANDBOXED (Electron's default alongside contextIsolation), where `require` is
// limited to electron plus a few polyfilled builtins. `require('./product')` throws
// "module not found: ./product", which aborts the WHOLE preload and silently leaves the page with no
// bridge at all — the button just does nothing, with no error anywhere the user can see. So the product's
// bridge name is handed in from the main process as a launch argument instead; process.argv IS available
// in a sandboxed preload.
const { contextBridge, ipcRenderer } = require('electron')

const api = {
  isDesktop: true,
  // Let the page raise a native toast (it plays the chosen alert sound too).
  notify: (title, body) => ipcRenderer.send('bd:notify', { title, body }),
  // The page calls this when someone acknowledges a priority event, so the desktop nag loop stops too.
  acknowledged: (hex) => ipcRenderer.send('bd:acknowledged', String(hex || '')),
  // "Sound & alerts" in the page opens the desktop sound picker.
  openSettings: () => ipcRenderer.send('bd:open-settings'),
}

// A STABLE name every drop-checker page can rely on whichever app it is running in, plus the per-product
// name. Exposing both means an older app paired with a newer page (or the reverse) still finds a bridge.
const names = ['fireticketsDrops']
try {
  const arg = (process.argv || []).find((a) => String(a).startsWith('--bridge='))
  if (arg) names.push(arg.slice('--bridge='.length))
} catch (_) { /* argv unavailable — the stable name is enough */ }

for (const n of names) {
  try { contextBridge.exposeInMainWorld(n, api) } catch (_) { /* duplicate or blocked name */ }
}

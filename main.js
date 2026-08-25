// BTT Drops Desktop — Electron shell around https://www.firetickets.ai/btt/drops.
//
// The web page already has an on-site pop-up, but a browser tab can only shout at you while it is open,
// focused-ish, and allowed to autoplay audio. This app exists to fix exactly that: it polls the same
// alert feed from the MAIN process, raises a real Windows notification, and plays a sound you chose — with
// the window minimised, in the tray, or on another desktop.
//
//   • own window + taskbar/tray icon, close-to-tray, launch-at-startup, single instance
//   • native drop notifications with a selectable alert sound (bundled + Windows system sounds)
//   • priority drops can re-alert until acknowledged
//   • Mute 2h / Delete straight from the notification actions
//   • silent auto-update from the same Storage bucket the installer comes from

const { app, BrowserWindow, Tray, Menu, nativeImage, shell, Notification, ipcMain, session, dialog } = require('electron')
const path = require('path')
const fs = require('fs')

let autoUpdater = null
try { autoUpdater = require('electron-updater').autoUpdater } catch (_) { /* not packaged in dev */ }

// ── Config ───────────────────────────────────────────────────────────────────
const BASE_URL = 'https://www.firetickets.ai'
const APP_URL = BASE_URL + '/btt/drops'
const APP_ID = 'com.firetickets.bttdrops'
const UA_TAG = () => 'BTTDropsDesktop/' + app.getVersion()
const POLL_MIN_MS = 5000
const POLL_MAX_MS = 120000

app.setAppUserModelId(APP_ID)

// ── State / persistence ──────────────────────────────────────────────────────
let win = null
let settingsWin = null
let player = null           // hidden window that owns the audio element
let tray = null
let isQuiting = false
let pollTimer = null
let cursor = 0              // btt_drop_alert_log id watermark
let baselined = false
let lastError = null
let lastPollAt = 0
let nagTimer = null
let nagging = null          // { alert, until } — priority alert still un-acknowledged

const DEFAULTS = {
  notifications: true,
  sound: 'drop-alert',      // a bundled id, or "win:<file>.wav" for a standard Windows sound
  volume: 0.8,
  pollSeconds: 15,
  soundWhenFocused: true,   // play the sound even if the app window is in front
  repeatPriority: true,     // keep re-alerting a priority drop until it's acknowledged
  repeatSeconds: 60,
  repeatMax: 10,
  launchAtStartup: true,
  startHidden: false,
}
let settings = { ...DEFAULTS }

const dataDir = () => app.getPath('userData')
const settingsFile = () => path.join(dataDir(), 'settings.json')
const stateFile = () => path.join(dataDir(), 'state.json')

function readJson(file, fallback) { try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch (_) { return fallback } }
function writeJson(file, obj) { try { fs.writeFileSync(file, JSON.stringify(obj, null, 2)) } catch (_) {} }

function loadSettings() {
  settings = { ...DEFAULTS, ...readJson(settingsFile(), {}) }
  const st = readJson(stateFile(), {})
  cursor = Number(st.cursor) || 0
  baselined = !!st.baselined
}
function saveSettings() { writeJson(settingsFile(), settings) }
function saveState() { writeJson(stateFile(), { cursor, baselined }) }

const pollMs = () => Math.min(POLL_MAX_MS, Math.max(POLL_MIN_MS, (Number(settings.pollSeconds) || 15) * 1000))

// ── Sounds ───────────────────────────────────────────────────────────────────
// The WAVs are asarUnpack'd (see package.json) so an <audio> element streams them off real disk rather
// than through the archive. Electron redirects asar paths transparently, but pointing at the unpacked
// copy explicitly means the renderer never has to.
const UNPACKED = __dirname.replace(/([\\/])app\.asar([\\/]|$)/, '$1app.asar.unpacked$2')
const soundsDir = () => {
  const unpacked = path.join(UNPACKED, 'assets', 'sounds')
  return fs.existsSync(unpacked) ? unpacked : path.join(__dirname, 'assets', 'sounds')
}

// Purpose-built alert tones that ship with the app. Deliberately unlike anything Windows plays, so a drop
// never gets mistaken for an email.
const BUILT_IN = [
  ['drop-alert', 'Drop Alert', 'Three rising blips into a soft thump — the default'],
  ['cash-register', 'Cash Register', 'Ka-ching'],
  ['air-horn', 'Air Horn', 'Loud. Use it for priority events'],
  ['klaxon', 'Klaxon', 'Two-tone industrial alarm'],
  ['siren', 'Siren', 'Rising/falling sweep'],
  ['radar-ping', 'Radar Ping', 'Sonar, long tail'],
  ['bell-tower', 'Bell Tower', 'Struck bell with harmonics'],
  ['chime-cascade', 'Chime Cascade', 'Four descending chimes'],
  ['fanfare', 'Fanfare', 'Short celebratory triad'],
  ['arcade-coin', 'Arcade Coin', '8-bit coin pickup'],
  ['laser', 'Laser', 'Very short descending zap'],
  ['heartbeat', 'Heartbeat', 'Two low thumps — subtle on headphones'],
  ['pulse', 'Pulse', 'Two soft pulses — the quiet option'],
  ['subtle-tick', 'Subtle Tick', 'Barely there'],
]

// Standard Windows notification sounds, whichever of them this machine actually has.
const WINDOWS_MEDIA = process.env.SystemRoot ? path.join(process.env.SystemRoot, 'Media') : 'C:\\Windows\\Media'
const WINDOWS_SOUNDS = [
  ['Windows Notify System Generic.wav', 'Windows Notify'],
  ['Windows Notify Calendar.wav', 'Windows Calendar'],
  ['Windows Notify Messaging.wav', 'Windows Messaging'],
  ['Windows Notify Email.wav', 'Windows Email'],
  ['Windows Background.wav', 'Windows Background'],
  ['Windows Foreground.wav', 'Windows Foreground'],
  ['Windows Message Nudge.wav', 'Windows Nudge'],
  ['Windows Proximity Notification.wav', 'Windows Proximity'],
  ['Alarm01.wav', 'Windows Alarm 1'],
  ['Alarm03.wav', 'Windows Alarm 3'],
  ['Alarm05.wav', 'Windows Alarm 5'],
  ['Ring01.wav', 'Windows Ring 1'],
  ['Ring05.wav', 'Windows Ring 5'],
  ['chimes.wav', 'Windows Chimes'],
  ['chord.wav', 'Windows Chord'],
  ['ding.wav', 'Windows Ding'],
  ['notify.wav', 'Windows Classic Notify'],
  ['tada.wav', 'Windows Tada'],
]

function listSounds() {
  const out = BUILT_IN
    .filter(([id]) => fs.existsSync(path.join(soundsDir(), id + '.wav')))
    .map(([id, name, note]) => ({ id, name, note, kind: 'built-in', file: path.join(soundsDir(), id + '.wav') }))
  for (const [file, name] of WINDOWS_SOUNDS) {
    const p = path.join(WINDOWS_MEDIA, file)
    if (fs.existsSync(p)) out.push({ id: 'win:' + file, name, note: 'Standard Windows sound', kind: 'windows', file: p })
  }
  out.push({ id: 'none', name: 'Silent', note: 'Pop-up only, no sound', kind: 'none', file: null })
  return out
}

function soundPath(id) {
  if (!id || id === 'none') return null
  if (id.startsWith('win:')) { const p = path.join(WINDOWS_MEDIA, id.slice(4)); return fs.existsSync(p) ? p : null }
  const p = path.join(soundsDir(), id + '.wav')
  return fs.existsSync(p) ? p : null
}

// The audio lives in a hidden renderer: Electron's main process can't play sound itself, and routing it
// through the visible window would go silent whenever that window is closed to the tray.
function ensurePlayer() {
  if (player && !player.isDestroyed()) return player
  player = new BrowserWindow({
    show: false, width: 200, height: 100, skipTaskbar: true,
    webPreferences: {
      preload: path.join(__dirname, 'player-preload.js'),
      nodeIntegration: false, contextIsolation: true, backgroundThrottling: false,
    },
  })
  player.loadFile(path.join(__dirname, 'player.html'))
  return player
}

function playSound(id, volume) {
  const file = soundPath(id === undefined ? settings.sound : id)
  if (!file) return
  const vol = typeof volume === 'number' ? volume : (Number(settings.volume) || 0.8)
  const p = ensurePlayer()
  const send = () => { try { p.webContents.send('play', { url: 'file://' + file.replace(/\\/g, '/'), volume: Math.max(0, Math.min(1, vol)) }) } catch (_) {} }
  if (p.webContents.isLoading()) p.webContents.once('did-finish-load', send)
  else send()
}

// ── Icons ────────────────────────────────────────────────────────────────────
function iconPath(name) { const p = path.join(__dirname, 'assets', name); return fs.existsSync(p) ? p : null }
function appIcon() { const ico = iconPath('icon.ico') || iconPath('icon.png'); return ico ? nativeImage.createFromPath(ico) : undefined }
function trayIcon() {
  const p = iconPath('tray.png') || iconPath('icon.png') || iconPath('icon.ico')
  if (!p) return nativeImage.createEmpty()
  let img = nativeImage.createFromPath(p)
  if (!img.isEmpty()) img = img.resize({ width: 16, height: 16 })
  return img
}

// ── Window ───────────────────────────────────────────────────────────────────
function createWindow() {
  win = new BrowserWindow({
    width: 1280, height: 860, minWidth: 900, minHeight: 600,
    backgroundColor: '#05070d',
    title: 'BTT Drops',
    icon: appIcon(),
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: true,
    },
  })
  win.setMenuBarVisibility(false)

  const ua = win.webContents.getUserAgent() + ' ' + UA_TAG()
  win.webContents.setUserAgent(ua)
  win.loadURL(APP_URL, { userAgent: ua })
  win.once('ready-to-show', () => { if (!process.argv.includes('--hidden')) win.show() })

  // Anything that isn't firetickets.ai (Ticketmaster links, mostly) opens in the real browser, where the
  // user is already signed in to TM.
  win.webContents.setWindowOpenHandler(({ url }) => {
    try {
      if (new URL(url).host !== new URL(APP_URL).host) { shell.openExternal(url); return { action: 'deny' } }
    } catch (_) {}
    return { action: 'allow' }
  })

  win.webContents.on('did-fail-load', (_e, code, _d, _u, isMainFrame) => {
    if (isMainFrame && code !== -3) {
      const offline = path.join(__dirname, 'offline.html')
      if (fs.existsSync(offline)) win.loadFile(offline)
    }
  })

  win.on('close', (e) => { if (!isQuiting) { e.preventDefault(); win.hide() } })
}

function showWindow(url) {
  if (!win || win.isDestroyed()) createWindow()
  if (win.isMinimized()) win.restore()
  if (!win.isVisible()) win.show()
  win.focus()
  if (url) { try { win.webContents.loadURL(url, { userAgent: win.webContents.getUserAgent() }) } catch (_) {} }
}

function openSettings() {
  if (settingsWin && !settingsWin.isDestroyed()) { settingsWin.show(); settingsWin.focus(); return }
  settingsWin = new BrowserWindow({
    width: 620, height: 760, minWidth: 480, minHeight: 520,
    backgroundColor: '#05070d', title: 'BTT Drops — Alerts & Sound',
    icon: appIcon(), autoHideMenuBar: true, parent: undefined, show: false,
    webPreferences: { preload: path.join(__dirname, 'settings-preload.js'), contextIsolation: true, nodeIntegration: false },
  })
  settingsWin.setMenuBarVisibility(false)
  settingsWin.loadFile(path.join(__dirname, 'settings.html'))
  settingsWin.once('ready-to-show', () => settingsWin.show())
  settingsWin.on('closed', () => { settingsWin = null })
}

// ── Alert feed ───────────────────────────────────────────────────────────────
const money = (c) => (c == null ? '' : '$' + Math.round(c / 100).toLocaleString('en-US'))

function describe(a) {
  const d = a.detail || {}
  const groups = Array.isArray(d.groups) ? d.groups : []
  const where = [a.venue, a.city].filter(Boolean).join(' · ')
  const lines = []
  if (where || a.event_date) lines.push([a.event_date, where].filter(Boolean).join(' · '))
  if (d.totalSeats != null) {
    const price = d.faceLo ? ` · ${money(d.faceLo)}${d.faceHi && d.faceHi !== d.faceLo ? '–' + money(d.faceHi) : ''} face` : ''
    lines.push(`${d.totalSeats} seat${d.totalSeats === 1 ? '' : 's'} in ${d.totalGroups || groups.length} group${(d.totalGroups || groups.length) === 1 ? '' : 's'}${price}`)
  }
  for (const g of groups.slice(0, 3)) {
    lines.push(g.ga
      ? `${g.s} (GA) — ${g.n} new`
      : `Sec ${g.s} Row ${g.r} — ${g.n === 1 ? `seat ${g.lo}` : `seats ${g.lo}–${g.hi} (${g.n})`}${g.face ? ' · ' + money(g.face) : ''}`)
  }
  if (groups.length > 3) lines.push(`…and ${(d.totalGroups || groups.length) - 3} more`)
  if (d.notes) lines.push('📝 ' + d.notes)
  return lines.join('\n')
}

function notifyDrop(a, { isNag = false } = {}) {
  if (!settings.notifications) return
  if (!Notification.isSupported()) return
  const isTest = a.kind === 'test'
  const prio = !!(a.detail && a.detail.priority)
  const title = isTest
    ? '🧪 Test — not a real drop'
    : `${prio ? '⭐ PRIORITY · ' : ''}🎯 ${isNag ? 'Still unacknowledged: ' : 'Seat Drop — '}${a.event_name || a.hex}`

  const n = new Notification({
    title,
    body: describe(a) || 'Seats just dropped.',
    icon: appIcon(),
    silent: true,                       // we play the chosen sound ourselves
    timeoutType: prio ? 'never' : 'default',
    actions: [{ type: 'button', text: 'Open on Ticketmaster' }, { type: 'button', text: 'Mute 2h' }],
    closeButtonText: 'Dismiss',
  })
  n.on('click', () => showWindow(APP_URL))
  n.on('action', (_e, index) => {
    if (index === 0 && a.tm_url) shell.openExternal(a.tm_url)
    else if (index === 1) postAction('mute', a.hex).then(() => stopNag(a.hex))
  })
  n.show()

  const focused = !!(win && !win.isDestroyed() && win.isFocused())
  if (!focused || settings.soundWhenFocused) playSound()
}

// Priority events keep alerting until someone acknowledges them — the desktop mirror of the drop-checker's
// own nag loop, so a big drop can't be missed just because the first toast was dismissed by accident.
function startNag(a) {
  if (!settings.repeatPriority) return
  stopNag()
  let count = 0
  nagging = { alert: a }
  nagTimer = setInterval(() => {
    if (!nagging) return stopNag()
    if (++count >= (Number(settings.repeatMax) || 10)) return stopNag()
    notifyDrop(nagging.alert, { isNag: true })
  }, Math.max(20, Number(settings.repeatSeconds) || 60) * 1000)
}
function stopNag(hex) {
  if (hex && nagging && nagging.alert.hex !== hex) return
  if (nagTimer) clearInterval(nagTimer)
  nagTimer = null; nagging = null
  refreshTray()
}

// Both of these run against the SAME session the window is signed in with, so the API sees the normal
// FireTickets cookie and no separate auth is needed.
async function apiFetch(url, init) {
  const ses = session.defaultSession
  const headers = { accept: 'application/json', 'user-agent': UA_TAG(), ...(init && init.headers) }
  return ses.fetch(url, { ...init, headers, cache: 'no-store' })
}

async function postAction(a, hex) {
  try {
    await apiFetch(BASE_URL + '/api/btt/drops/action', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(a === 'mute' ? { a: 'mute', hex, mins: 120 } : { a, hex }),
    })
    return true
  } catch (_) { return false }
}

async function poll() {
  try {
    const url = baselined
      ? `${BASE_URL}/api/btt/drops/popup?since=${cursor}`
      : `${BASE_URL}/api/btt/drops/popup`
    const res = await apiFetch(url)
    if (res.status === 403) { lastError = 'Not signed in as a BTT user — open the window and log in.'; refreshTray(); return }
    if (!res.ok) { lastError = 'Feed HTTP ' + res.status; return }
    const j = await res.json()
    lastError = null
    lastPollAt = Date.now()

    // First poll only records where the log is, so installing the app doesn't fire a burst of history.
    if (!baselined) { cursor = Number(j.latestId) || 0; baselined = true; saveState(); refreshTray(); return }

    const next = Math.max(cursor, Number(j.nextCursor) || 0)
    const alerts = Array.isArray(j.alerts) ? j.alerts : []
    if (next > cursor) { cursor = next; saveState() }
    for (const a of alerts) {
      notifyDrop(a)
      if (a.detail && a.detail.priority && a.kind !== 'test') startNag(a)
    }
    if (alerts.length) refreshTray()
  } catch (e) {
    lastError = e && e.message ? e.message : 'poll failed'
  }
}

function startPolling() {
  if (pollTimer) clearInterval(pollTimer)
  poll()
  pollTimer = setInterval(poll, pollMs())
}

// ── Tray ─────────────────────────────────────────────────────────────────────
function soundMenu() {
  const items = listSounds().map((s) => ({
    label: s.name,
    type: 'radio',
    checked: settings.sound === s.id,
    click: () => { settings.sound = s.id; saveSettings(); playSound(); refreshTray() },
  }))
  return [
    ...items.slice(0, 15),
    { type: 'separator' },
    { label: 'More sounds & settings…', click: openSettings },
    { label: 'Test this sound', click: () => playSound() },
  ]
}

function volumeMenu() {
  return [25, 50, 75, 100].map((p) => ({
    label: p + '%', type: 'radio', checked: Math.round((Number(settings.volume) || 0.8) * 100) === p,
    click: () => { settings.volume = p / 100; saveSettings(); playSound(); refreshTray() },
  }))
}

function statusLabel() {
  if (lastError) return '⚠ ' + lastError
  if (!lastPollAt) return 'Connecting…'
  const s = Math.round((Date.now() - lastPollAt) / 1000)
  return `Watching · checked ${s < 60 ? s + 's' : Math.round(s / 60) + 'm'} ago`
}

function buildTrayMenu() {
  return Menu.buildFromTemplate([
    { label: statusLabel(), enabled: false },
    ...(nagging ? [{ label: `⭐ ${nagging.alert.event_name || nagging.alert.hex} — unacknowledged`, click: () => showWindow(APP_URL) },
                   { label: 'Stop repeating', click: () => stopNag() }] : []),
    { type: 'separator' },
    { label: 'Open BTT Drops', click: () => showWindow(APP_URL) },
    { label: 'Alert settings & sounds…', click: openSettings },
    { type: 'separator' },
    { label: 'Desktop notifications', type: 'checkbox', checked: !!settings.notifications, click: (mi) => { settings.notifications = mi.checked; saveSettings() } },
    { label: 'Alert sound', submenu: soundMenu() },
    { label: 'Volume', submenu: volumeMenu() },
    { label: 'Repeat priority alerts', type: 'checkbox', checked: !!settings.repeatPriority, click: (mi) => { settings.repeatPriority = mi.checked; saveSettings(); if (!mi.checked) stopNag() } },
    { label: 'Launch on startup', type: 'checkbox', checked: getOpenAtLogin(), click: (mi) => setOpenAtLogin(mi.checked) },
    { type: 'separator' },
    { label: 'Send a test alert', click: () => sendTestAlert() },
    { label: 'Check for updates…', click: () => checkForUpdates(true) },
    { label: 'Quit BTT Drops', click: () => { isQuiting = true; app.quit() } },
  ])
}
function refreshTray() {
  if (!tray) return
  tray.setToolTip(nagging ? 'BTT Drops — ⭐ unacknowledged drop' : 'BTT Drops — ' + statusLabel())
  tray.setContextMenu(buildTrayMenu())
}
function createTray() {
  tray = new Tray(trayIcon())
  tray.setToolTip('BTT Drops')
  tray.setContextMenu(buildTrayMenu())
  tray.on('click', () => showWindow())
  tray.on('double-click', () => showWindow())
  setInterval(refreshTray, 30000)
}

// ── Launch at startup ────────────────────────────────────────────────────────
function getOpenAtLogin() { try { return app.getLoginItemSettings().openAtLogin } catch (_) { return false } }
function setOpenAtLogin(v) {
  try { app.setLoginItemSettings({ openAtLogin: v, args: settings.startHidden ? ['--hidden'] : [] }) } catch (_) {}
  settings.launchAtStartup = v; saveSettings(); refreshTray()
}

// ── Test alert ───────────────────────────────────────────────────────────────
// Posts a real test row to the feed so the whole chain is exercised (API auth included), and falls back to
// a local-only toast if the post can't be made.
async function sendTestAlert() {
  try {
    const r = await apiFetch(BASE_URL + '/api/btt/drops/popup', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ test: true }),
    })
    if (r.ok) { setTimeout(poll, 1200); return { ok: true, via: 'feed' } }
    if (r.status === 403) throw new Error('not signed in as a BTT user')
    throw new Error('HTTP ' + r.status)
  } catch (e) {
    notifyDrop({
      hex: '0000000000000000', kind: 'test', event_name: 'Test Drop — BTT', venue: 'Test Arena', city: 'Testville',
      event_date: null, tm_url: BASE_URL + '/btt/drops',
      detail: { groups: [{ s: 'TEST', r: 'A', lo: 1, hi: 4, n: 4, face: 8500 }], totalGroups: 1, totalSeats: 4, faceLo: 8500, faceHi: 8500 },
    })
    return { ok: true, via: 'local', error: e && e.message }
  }
}

// ── Updates ──────────────────────────────────────────────────────────────────
function checkForUpdates(interactive) {
  if (!autoUpdater) { if (interactive) dialog.showMessageBox({ message: 'Updates are only available in the installed build.' }); return }
  try {
    autoUpdater.autoDownload = true
    if (interactive) {
      autoUpdater.once('update-not-available', () => dialog.showMessageBox({ message: `BTT Drops ${app.getVersion()} is the latest version.` }))
      autoUpdater.once('error', (e) => dialog.showMessageBox({ type: 'warning', message: 'Update check failed', detail: String((e && e.message) || e) }))
    }
    autoUpdater.checkForUpdatesAndNotify()
  } catch (_) {}
}

// ── IPC (settings window) ────────────────────────────────────────────────────
ipcMain.handle('bd:get', () => ({
  settings,
  sounds: listSounds().map(({ id, name, note, kind }) => ({ id, name, note, kind })),
  version: app.getVersion(),
  status: { error: lastError, lastPollAt, cursor, baselined, openAtLogin: getOpenAtLogin() },
}))
ipcMain.handle('bd:set', (_e, patch) => {
  if (patch && typeof patch === 'object') {
    const before = settings.pollSeconds
    settings = { ...settings, ...patch }
    if ('launchAtStartup' in patch) setOpenAtLogin(!!patch.launchAtStartup)
    saveSettings(); refreshTray()
    if (settings.pollSeconds !== before) startPolling()
  }
  return settings
})
ipcMain.handle('bd:preview', (_e, { id, volume } = {}) => { playSound(id, volume); return true })
ipcMain.handle('bd:test', async () => sendTestAlert())
ipcMain.handle('bd:open', () => { showWindow(APP_URL); return true })
ipcMain.handle('bd:update', () => { checkForUpdates(true); return true })

// From the hosted page (via preload) — lets the web app raise a native toast if it wants to.
ipcMain.on('bd:notify', (_e, p) => {
  if (p && p.title && settings.notifications && Notification.isSupported()) {
    const n = new Notification({ title: String(p.title), body: String(p.body || ''), icon: appIcon(), silent: true })
    n.on('click', () => showWindow(APP_URL))
    n.show()
    playSound()
  }
})
ipcMain.on('bd:acknowledged', (_e, hex) => stopNag(hex))
ipcMain.on('bd:open-settings', () => openSettings())

// ── App lifecycle ────────────────────────────────────────────────────────────
const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', () => showWindow())

  app.whenReady().then(() => {
    loadSettings()
    if (settings.launchAtStartup && !getOpenAtLogin()) setOpenAtLogin(true)

    createWindow()
    createTray()
    ensurePlayer()
    startPolling()

    if (process.argv.includes('--hidden') && win) win.hide()

    if (autoUpdater) {
      checkForUpdates(false)
      setInterval(() => checkForUpdates(false), 6 * 60 * 60 * 1000)
    }

    app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); else showWindow() })
  })

  app.on('window-all-closed', () => { /* keep running in the tray */ })
  app.on('before-quit', () => { isQuiting = true })
}

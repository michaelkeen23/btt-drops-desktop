// Drop-checker desktop shell — an Electron window around a FireTickets drop-checker page.
//
// SHARED FILE. This is byte-identical between btt-drops-desktop and fireseats-drops-desktop; everything
// product-specific lives in product.js. Copy it across verbatim when fixing something, don't hand-port.
//
// The web page already has an on-site pop-up, but a browser tab can only shout at you while it is open,
// focused-ish, and allowed to autoplay audio. This app exists to fix exactly that: it polls the same
// alert feed from the MAIN process, raises a real Windows notification, and plays a sound you chose — with
// the window minimised, in the tray, or on another desktop.
//
//   • own window + taskbar/tray icon, close-to-tray, launch-at-startup, single instance
//   • native drop notifications with a selectable alert sound (bundled + Windows system sounds)
//   • priority drops can re-alert until acknowledged
//   • Mute 2h straight from the notification actions
//   • silent auto-update from the GitHub release the installer came from

const { app, BrowserWindow, Tray, Menu, nativeImage, shell, Notification, ipcMain, session, dialog } = require('electron')
const path = require('path')
const fs = require('fs')
const PRODUCT = require('./product')

let autoUpdater = null
try { autoUpdater = require('electron-updater').autoUpdater } catch (_) { /* not packaged in dev */ }

// ── Config ───────────────────────────────────────────────────────────────────
const BASE_URL = PRODUCT.baseUrl
const APP_URL = BASE_URL + PRODUCT.appPath
const APP_ID = PRODUCT.appId
const UA_TAG = () => PRODUCT.uaTag + '/' + app.getVersion()
const POLL_MIN_MS = 5000
const POLL_MAX_MS = 120000

// The alert sound has to fire with the window minimised or hidden in the tray, which is exactly when
// Chromium wants to throttle and suspend a renderer. The audio host is a hidden window, so say no to all
// three of the mechanisms that would silence it. (The POLLER itself lives in the main process, whose
// timers are never throttled — this is only about the audio renderer.)
app.commandLine.appendSwitch('disable-background-timer-throttling')
app.commandLine.appendSwitch('disable-renderer-backgrounding')
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows')
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required')

// Windows keys toasts off the AppUserModelID. It must match the installer's shortcut or notifications are
// silently dropped, which is the classic "the app works but nothing ever pops up" failure.
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
let signInPrompted = false  // "sign in" toast is shown once per signed-out streak, not every poll

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

// Your own sounds. Anything dropped in this app's own %APPDATA% "sounds" folder shows up in the picker on
// the next open — no rebuild, no reinstall. This is the answer to "where do I change the sounds": for a
// one-off, put a file here; to change what everyone gets, edit scripts/make-sounds.mjs and ship a build.
const CUSTOM_EXT = new Set(['.wav', '.mp3', '.ogg', '.m4a', '.flac', '.aac'])
const customDir = () => path.join(app.getPath('userData'), 'sounds')
function ensureCustomDir() {
  const dir = customDir()
  try {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(path.join(dir, 'README.txt'),
        'Drop .wav / .mp3 / .ogg / .m4a files in this folder and they appear in\r\n'
        + PRODUCT.productName + ' under "Your sounds" (tray icon -> Alert sound, or the settings window).\r\n\r\n'
        + 'Keep them short - under about 3 seconds - so an alert does not talk over the next one.\r\n')
    }
  } catch (_) {}
  return dir
}
function listCustomSounds() {
  const dir = customDir()
  let names = []
  try { names = fs.readdirSync(dir) } catch (_) { return [] }
  return names
    .filter((n) => CUSTOM_EXT.has(path.extname(n).toLowerCase()))
    .sort((a, b) => a.localeCompare(b))
    .map((n) => ({
      id: 'custom:' + n,
      name: path.basename(n, path.extname(n)),
      note: 'Your sound · ' + path.extname(n).slice(1).toUpperCase(),
      kind: 'custom',
      file: path.join(dir, n),
    }))
}

function listSounds() {
  const out = BUILT_IN
    .filter(([id]) => fs.existsSync(path.join(soundsDir(), id + '.wav')))
    .map(([id, name, note]) => ({ id, name, note, kind: 'built-in', file: path.join(soundsDir(), id + '.wav') }))
  out.push(...listCustomSounds())
  for (const [file, name] of WINDOWS_SOUNDS) {
    const p = path.join(WINDOWS_MEDIA, file)
    if (fs.existsSync(p)) out.push({ id: 'win:' + file, name, note: 'Standard Windows sound', kind: 'windows', file: p })
  }
  out.push({ id: 'none', name: 'Silent', note: 'Pop-up only, no sound', kind: 'none', file: null })
  return out
}

function soundPath(id) {
  if (!id || id === 'none') return null
  let p
  if (id.startsWith('win:')) p = path.join(WINDOWS_MEDIA, id.slice(4))
  else if (id.startsWith('custom:')) p = path.join(customDir(), id.slice(7))
  else p = path.join(soundsDir(), id + '.wav')
  if (fs.existsSync(p)) return p
  // A custom sound that was renamed or deleted must not leave the app silent on the next drop.
  if (id !== DEFAULTS.sound) { const fb = path.join(soundsDir(), DEFAULTS.sound + '.wav'); if (fs.existsSync(fb)) return fb }
  return null
}

// The audio lives in a hidden renderer: Electron's main process can't play sound itself, and routing it
// through the visible window would go silent whenever that window is closed to the tray.
function ensurePlayer() {
  if (player && !player.isDestroyed()) return player
  player = new BrowserWindow({
    show: false, width: 200, height: 100, skipTaskbar: true,
    webPreferences: {
      preload: path.join(__dirname, 'player-preload.js'),
      nodeIntegration: false, contextIsolation: true,
      backgroundThrottling: false,
      autoplayPolicy: 'no-user-gesture-required',   // no click has ever happened in this window
    },
  })
  player.loadFile(path.join(__dirname, 'player.html'))
  // If the audio host ever dies (renderer crash, OOM), rebuild it so the next drop still makes a noise.
  player.webContents.on('render-process-gone', () => { try { player.destroy() } catch (_) {} ; player = null })
  return player
}

let lastSoundError = null
let soundProbe = null       // one-shot callback used by --selftest-sound
function playSound(id, volume) {
  const wanted = id === undefined ? settings.sound : id
  if (wanted === 'none') return
  const file = soundPath(wanted)
  if (!file) { lastSoundError = 'sound file missing: ' + wanted; return }
  const vol = typeof volume === 'number' ? volume : (Number(settings.volume) || 0.8)
  const p = ensurePlayer()
  const send = () => { try { p.webContents.send('play', { url: 'file://' + file.replace(/\\/g, '/'), volume: Math.max(0, Math.min(1, vol)) }) } catch (e) { lastSoundError = e.message } }
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
// The only pages this window is allowed to be on: the drop checker itself, and whatever is needed to
// sign in to it. Everything else is somebody else's page and belongs in a browser.
const IN_APP_PATHS = PRODUCT.inAppPaths
function isOurHost(url) {
  try { return new URL(url).host === new URL(APP_URL).host } catch (_) { return false }
}
function isAppUrl(url) {
  try {
    const u = new URL(url)
    return isOurHost(url) && IN_APP_PATHS.some((re) => re.test(u.pathname + u.search))
  } catch (_) { return false }
}

function createWindow() {
  win = new BrowserWindow({
    width: 1280, height: 860, minWidth: 900, minHeight: 600,
    backgroundColor: PRODUCT.background,
    title: PRODUCT.productName,
    icon: appIcon(),
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: true,
      // The preload is sandboxed and cannot require product.js, so hand it the bridge name here. Keeping
      // the sandbox is the point: this window loads a remote origin.
      additionalArguments: ['--bridge=' + PRODUCT.bridgeName],
    },
  })
  win.setMenuBarVisibility(false)

  const ua = win.webContents.getUserAgent() + ' ' + UA_TAG()
  win.webContents.setUserAgent(ua)
  win.loadURL(APP_URL, { userAgent: ua })
  win.once('ready-to-show', () => { if (!process.argv.includes('--hidden')) win.show() })

  // This app is ONE drop checker and nothing else. Ticketmaster links, and any other part of the
  // FireTickets site the page might link to, open in the real browser — the window itself never leaves
  // the drop checker, so there is no way to end up somewhere that wants site navigation.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (isAppUrl(url)) return { action: 'allow' }
    if (!isOurHost(url)) shell.openExternal(url)
    else showWindow(APP_URL)
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (e, url) => {
    if (isAppUrl(url)) return
    e.preventDefault()
    // Our own site, just not the drop checker (the logo, a stray link, a post-login bounce to "/"):
    // come straight back rather than opening a browser tab for it.
    if (isOurHost(url)) win.loadURL(APP_URL, { userAgent: win.webContents.getUserAgent() })
    else shell.openExternal(url)
  })
  // Server-side redirects don't go through will-navigate. If one lands us off the drop checker (e.g. a
  // login flow that forgets `next`), bounce back.
  win.webContents.on('did-navigate', (_e, url) => {
    if (!isAppUrl(url) && isOurHost(url)) win.loadURL(APP_URL, { userAgent: win.webContents.getUserAgent() })
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
    backgroundColor: PRODUCT.background, title: `${PRODUCT.productName} — Alerts & Sound`,
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
    await apiFetch(BASE_URL + PRODUCT.actionPath, {
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
      ? `${BASE_URL}${PRODUCT.feedPath}?since=${cursor}`
      : `${BASE_URL}${PRODUCT.feedPath}`
    const res = await apiFetch(url)
    if (res.status === 403 || res.status === 401) {
      lastError = `Not signed in as ${PRODUCT.audience} — open the window and log in.`
      // Say so once, out loud. Otherwise the app looks like it's working and silently never alerts —
      // the single most likely reason someone reports "I never get notifications".
      if (!signInPrompted && Notification.isSupported()) {
        signInPrompted = true
        const n = new Notification({ title: `${PRODUCT.productName} — sign in to start alerts`, body: `Open ${PRODUCT.productName} and log in with your FireTickets account. Nothing will alert until you do.`, icon: appIcon() })
        n.on('click', () => showWindow(APP_URL))
        n.show()
      }
      refreshTray(); return
    }
    signInPrompted = false
    if (!res.ok) { lastError = 'Feed HTTP ' + res.status; return }
    const j = await res.json()
    lastError = null
    lastPollAt = Date.now()

    // First poll only records where the log is, so installing the app doesn't fire a burst of history.
    if (!baselined) { cursor = Number(j.latestId) || 0; baselined = true; saveState(); refreshTray(); return }

    const next = Math.max(cursor, Number(j.nextCursor) || 0)
    // Some feeds carry more than drops on one log (StubTerminal mixes in release alerts and the Austin
    // watch). product.alertKinds narrows this app to what it is FOR; null takes everything. The cursor
    // still advances past the rows we skip, so a filtered-out burst can never stall the feed.
    const kinds = PRODUCT.alertKinds
    const alerts = (Array.isArray(j.alerts) ? j.alerts : []).filter((a) => !kinds || kinds.includes(a.kind))
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
// The tray offers every sound the settings window does. The 14 app tones sit at the top level (that's
// what people pick day to day); your own files and the ~18 Windows sounds go in nested submenus so the
// menu stays a menu rather than a wall.
function soundMenu() {
  const all = listSounds()
  const pick = (s) => ({
    label: s.name, type: 'radio', checked: settings.sound === s.id,
    click: () => { settings.sound = s.id; saveSettings(); playSound(); refreshTray() },
  })
  const of = (kind) => all.filter((s) => s.kind === kind)
  const custom = of('custom')
  const windows = of('windows')
  return [
    ...of('built-in').map(pick),
    { type: 'separator' },
    ...(custom.length
      ? [{ label: `Your sounds (${custom.length})`, submenu: custom.map(pick) }]
      : [{ label: 'Your sounds — none yet', enabled: false }]),
    ...(windows.length ? [{ label: `Standard Windows sounds (${windows.length})`, submenu: windows.map(pick) }] : []),
    ...of('none').map(pick),
    { type: 'separator' },
    { label: 'Test this sound', click: () => playSound() },
    { label: 'Add your own sounds…', click: () => shell.openPath(ensureCustomDir()) },
    { label: 'All alert settings…', click: openSettings },
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
    { label: `Open ${PRODUCT.productName}`, click: () => showWindow(APP_URL) },
    { label: 'Alert settings & sounds…', click: openSettings },
    { type: 'separator' },
    { label: 'Desktop notifications', type: 'checkbox', checked: !!settings.notifications, click: (mi) => { settings.notifications = mi.checked; saveSettings() } },
    { label: 'Alert sound', submenu: soundMenu() },
    { label: 'Volume', submenu: volumeMenu() },
    { label: 'Repeat priority alerts', type: 'checkbox', checked: !!settings.repeatPriority, click: (mi) => { settings.repeatPriority = mi.checked; saveSettings(); if (!mi.checked) stopNag() } },
    { label: 'Launch on startup', type: 'checkbox', checked: getOpenAtLogin(), click: (mi) => setOpenAtLogin(mi.checked) },
    { type: 'separator' },
    ...(updateReady ? [{ label: `⬆ Restart & install ${updateReady}`, click: installUpdateNow }] : []),
    { label: 'Send a test alert', click: () => sendTestAlert() },
    { label: 'Windows notification settings…', click: () => shell.openExternal('ms-settings:notifications') },
    { label: updateReady ? 'Update ready — restart to install' : 'Check for updates…', click: () => checkForUpdates(true) },
    { label: `Quit ${PRODUCT.productName}`, click: () => { isQuiting = true; app.quit() } },
  ])
}
function refreshTray() {
  if (!tray) return
  tray.setToolTip(nagging ? `${PRODUCT.productName} — ⭐ unacknowledged drop` : `${PRODUCT.productName} — ` + statusLabel())
  tray.setContextMenu(buildTrayMenu())
}
function createTray() {
  tray = new Tray(trayIcon())
  tray.setToolTip(PRODUCT.productName)
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
    const r = await apiFetch(BASE_URL + PRODUCT.testPath, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ test: true }),
    })
    if (r.ok) { setTimeout(poll, 1200); return { ok: true, via: 'feed' } }
    if (r.status === 403) throw new Error(`not signed in as ${PRODUCT.audience}`)
    throw new Error('HTTP ' + r.status)
  } catch (e) {
    notifyDrop({
      hex: '0000000000000000', kind: 'test', event_name: `Test Drop — ${PRODUCT.productName}`, venue: 'Test Arena', city: 'Testville',
      event_date: null, tm_url: BASE_URL + PRODUCT.appPath,
      detail: { groups: [{ s: 'TEST', r: 'A', lo: 1, hi: 4, n: 4, face: 8500 }], totalGroups: 1, totalSeats: 4, faceLo: 8500, faceHi: 8500 },
    })
    return { ok: true, via: 'local', error: e && e.message }
  }
}

// ── Updates ──────────────────────────────────────────────────────────────────
//
// Updating from inside the app is the path that WORKS cleanly, and it should be the normal one: the app
// quits itself and hands over to the installer, so nothing is holding files open. Running the downloaded
// installer by hand against a live tray app is the awkward case (see build/installer.nsh).
let updateReady = null   // the downloaded version, waiting for a restart

function installUpdateNow() {
  if (!autoUpdater || !updateReady) return
  isQuiting = true
  stopNag()
  try { autoUpdater.quitAndInstall(false, true) } catch (_) { app.quit() }
}

function wireUpdater() {
  if (!autoUpdater) return
  autoUpdater.autoDownload = true
  autoUpdater.on('update-downloaded', (info) => {
    updateReady = (info && info.version) || 'a new version'
    refreshTray()
    if (!Notification.isSupported()) return
    const n = new Notification({
      title: `${PRODUCT.productName} ${updateReady} is ready`,
      body: 'Click to restart and install. Takes a couple of seconds — no installer to run by hand.',
      icon: appIcon(),
      silent: true,
    })
    n.on('click', installUpdateNow)
    n.show()
  })
}

function checkForUpdates(interactive) {
  if (!autoUpdater) { if (interactive) dialog.showMessageBox({ message: 'Updates are only available in the installed build.' }); return }
  if (updateReady) { if (interactive) installUpdateNow(); return }
  try {
    if (interactive) {
      autoUpdater.once('update-not-available', () => dialog.showMessageBox({ message: `${PRODUCT.productName} ${app.getVersion()} is the latest version.` }))
      autoUpdater.once('error', (e) => dialog.showMessageBox({ type: 'warning', message: 'Update check failed', detail: String((e && e.message) || e) }))
    }
    autoUpdater.checkForUpdates()
  } catch (_) {}
}

// ── IPC (settings window) ────────────────────────────────────────────────────
ipcMain.handle('bd:get', () => ({
  settings,
  sounds: listSounds().map(({ id, name, note, kind }) => ({ id, name, note, kind })),
  version: app.getVersion(),
  soundsFolder: customDir(),
  // Branding for the settings window, so that file stays shared between the two apps too.
  product: { name: PRODUCT.productName, shortName: PRODUCT.shortName, accent: PRODUCT.accent, soundBadge: PRODUCT.soundBadge },
  status: {
    error: lastError,
    soundError: lastSoundError,
    lastPollAt,
    cursor,
    baselined,
    openAtLogin: getOpenAtLogin(),
    // If Windows itself can't show toasts, no amount of app configuration will help — surface it.
    notificationsSupported: Notification.isSupported(),
  },
}))
ipcMain.handle('bd:sounds-folder', () => { shell.openPath(ensureCustomDir()); return customDir() })
// Deep-links straight into the Windows page where this app can be re-enabled / un-muted.
ipcMain.handle('bd:os-notification-settings', () => { shell.openExternal('ms-settings:notifications'); return true })
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
ipcMain.on('bd:sound-report', (_e, r) => {
  lastSoundError = r && r.ok ? null : ((r && r.error) || 'playback failed')
  if (soundProbe) { soundProbe(r); soundProbe = null }
})

// ── App lifecycle ────────────────────────────────────────────────────────────
const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', () => showWindow())

  app.whenReady().then(() => {
    loadSettings()
    ensureCustomDir()

    // `<productName>.exe --selftest-sound` — play the configured alert, print whether the audio host
    // actually managed it, and exit. For diagnosing a machine that pops up but stays silent.
    if (process.argv.includes('--selftest-sound')) {
      ensurePlayer()
      const chosen = listSounds().find((s) => s.id === settings.sound)
      console.log('sound       :', settings.sound, chosen ? `(${chosen.name})` : '(unknown id)')
      console.log('resolves to :', soundPath(settings.sound) || 'NOTHING')
      console.log('volume      :', settings.volume)
      const done = (r) => { console.log('playback    :', r && r.ok ? 'OK' : 'FAILED — ' + ((r && r.error) || 'no response')); app.exit(r && r.ok ? 0 : 1) }
      soundProbe = done
      setTimeout(() => playSound(), 400)
      setTimeout(() => done(null), 8000)
      return
    }

    if (settings.launchAtStartup && !getOpenAtLogin()) setOpenAtLogin(true)

    createWindow()
    createTray()
    ensurePlayer()
    startPolling()

    if (process.argv.includes('--hidden') && win) win.hide()

    if (autoUpdater) {
      wireUpdater()
      checkForUpdates(false)
      setInterval(() => checkForUpdates(false), 6 * 60 * 60 * 1000)
    }

    app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); else showWindow() })
  })

  app.on('window-all-closed', () => { /* keep running in the tray */ })
  app.on('before-quit', () => { isQuiting = true })
  // Windows signing off (shutdown, restart, log off) is NOT a "hide to the tray" close — go away properly
  // instead of blocking the shutdown and being killed.
  app.on('session-end', () => { isQuiting = true; try { app.exit(0) } catch (_) {} })
}

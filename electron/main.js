'use strict'

// TRACS desktop wrapper. Wraps the existing Express server (server/src/index.js)
// and React client (client/dist) in an Electron BrowserWindow.
//
// The server is required in-process (same Node process as Electron's main
// process) rather than spawned as a child — it's already a plain CJS module
// with startup side effects, so requiring it here is identical to `npm start`
// running it directly, just with a few env vars set first (see resolvePort()
// and the userData state-dir line below).

const { app, BrowserWindow, ipcMain, dialog, shell, Menu } = require('electron')
const path = require('path')
const fs   = require('fs')
const net  = require('net')
const { execFile }      = require('child_process')
const { pathToFileURL } = require('url')
const log  = require('electron-log/main')

// log.initialize() alone only wires up renderer-console forwarding - it does
// NOT touch this (main) process's own global console. Object.assign(console,
// log.functions) is electron-log's own documented way to do that: it
// overrides console.log/warn/error/info/debug so every existing call site
// across server/src/, server/navdata/, etc. - hundreds of them, none touched
// - automatically also writes to a log file, with zero per-call-site
// changes. Still prints to an attached terminal too (dev mode unaffected).
// Must run before startServer() requires the server.
log.initialize()
Object.assign(console, log.functions)
// Uncaught exceptions/rejections anywhere in the main process (including the
// in-process server) are written to the log file instead of vanishing;
// exceptions also get an error dialog. The app keeps running.
log.errorHandler.startCatching()
console.log(`[electron] logging to ${log.transports.file.getFile().path}`)

const DEFAULT_PORT   = 8722
const PORT_RANGE      = 10   // how many ports to try past the default/saved one before giving up
const PORT_FILE       = () => path.join(app.getPath('userData'), 'port.json')
let   currentPort     = null

// Nothing stops a user from launching TRACS.exe a second time the normal
// way (double-clicking the icon again) rather than using File > New Window
// - without this, that second process would run its own resolvePort()/
// startServer() and race the first one for the same port, crashing with
// EADDRINUSE. requestSingleInstanceLock() makes that second launch attempt
// hand off to the already-running instance instead (via 'second-instance'
// below) and quit immediately, rather than starting a competing server.
if (!app.requestSingleInstanceLock()) {
  // app.quit() alone schedules a shutdown but doesn't synchronously stop
  // this process's JS from continuing to run — process.exit() guarantees
  // this losing instance can never reach the app.whenReady() below and race
  // the real instance for the same port, regardless of quit()'s exact timing.
  app.quit()
  process.exit(0)
} else {
  app.on('second-instance', () => {
    if (currentPort) openNewWindow(currentPort)
  })
}

let mainWindow = null

// ── Navigation / window-open / IPC guards ─────────────────────────────────
// Every TRACS window carries the preload's electronAPI (update install, file
// picker), so only TRACS's own pages may ever load in one. Pop-out windows
// (window.open to the same origin) are allowed; any other http(s) URL opens
// in the user's normal browser instead; everything else is refused.

function isAppUrl(url) {
  try {
    const u = new URL(url)
    return u.protocol === 'http:'
      && (u.hostname === 'localhost' || u.hostname === '127.0.0.1')
      && currentPort !== null && u.port === String(currentPort)
  } catch {
    return false
  }
}

function openExternally(url) {
  try {
    const { protocol } = new URL(url)
    if (protocol === 'http:' || protocol === 'https:') shell.openExternal(url)
  } catch { /* not a URL - ignore */ }
}

app.on('web-contents-created', (_event, contents) => {
  contents.setWindowOpenHandler(({ url }) => {
    if (isAppUrl(url)) return { action: 'allow' }
    openExternally(url)
    return { action: 'deny' }
  })
  contents.on('will-navigate', (event, url) => {
    if (isAppUrl(url)) return
    event.preventDefault()
    openExternally(url)
  })
})

// ipcMain.handle, but only for requests from a TRACS page.
function handleFromApp(channel, handler) {
  ipcMain.handle(channel, (event, ...args) => {
    if (!isAppUrl(event.senderFrame?.url ?? '')) {
      console.warn(`[electron] refused IPC '${channel}' from ${event.senderFrame?.url ?? 'unknown frame'}`)
      throw new Error('IPC not allowed from this page')
    }
    return handler(event, ...args)
  })
}

// ── Port resolution ───────────────────────────────────────────────────────
// Origin stability matters here: client-side localStorage (serverProfiles,
// *Prefs/*Bookmarks stores) is tied to http://localhost:<port> as an origin.
// A port that drifted between launches would silently orphan that data. So
// the first-ever launch picks (and persists) whichever port binds, and every
// later launch reuses that exact port. When it's taken, the user decides:
// retry once they've closed whatever holds it, use a nearby port for this
// session only (never persisted), or quit.

function probePort(port) {
  return new Promise((resolve) => {
    const tester = net.createServer()
    tester.once('error', () => resolve(false))
    tester.once('listening', () => tester.close(() => resolve(true)))
    tester.listen(port, '127.0.0.1')
  })
}

async function findFreePort(startPort) {
  for (let port = startPort; port < startPort + PORT_RANGE; port++) {
    if (await probePort(port)) return port
  }
  throw new Error(`no free port found in range ${startPort}-${startPort + PORT_RANGE - 1}`)
}

// A free port just past `port` for a one-session fallback, or null.
function findFallbackPort(port) {
  return findFreePort(port + 1).catch(() => null)
}

function runQuiet(cmd, args) {
  return new Promise((resolve) => {
    execFile(cmd, args, { windowsHide: true, timeout: 5000 }, (err, stdout) => resolve(err ? '' : stdout))
  })
}

// Names the program listening on `port`, e.g. "node.exe (PID 12345)". Windows
// only, and needs no admin rights (netstat -ano, not -b). Null when nothing
// is listening, e.g. a port range Windows reserves for Hyper-V/WSL, or when
// the lookup fails.
async function findPortOwner(port) {
  if (process.platform !== 'win32') return null
  let pid = null
  for (const line of (await runQuiet('netstat', ['-ano'])).split('\n')) {
    // TCP <local> <foreign> <state> <pid>. The state text is localized, so a
    // listening socket is told apart by its unset foreign address instead.
    const cols = line.trim().split(/\s+/)
    if (cols[0] === 'TCP' && cols[1]?.endsWith(`:${port}`) && /:0$/.test(cols[2] ?? '') && /^\d+$/.test(cols[4] ?? '')) {
      pid = cols[4]
      break
    }
  }
  if (!pid || pid === '0') return null
  if (pid === '4') return 'System (a Windows service)'
  const csv  = await runQuiet('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'])
  const name = csv.match(/^"([^"]+)"/)?.[1]
  return name ? `${name} (PID ${pid})` : `process ${pid}`
}

// TRACS's own bundled Roboto Mono, so the dialog matches the app. Vite
// hashes the file name, so look it up.
function findBundledFontUrl() {
  try {
    const dir  = path.join(__dirname, '..', 'client', 'dist', 'assets')
    const file = fs.readdirSync(dir).find((f) => /^roboto-mono-latin-400-normal-.*\.woff2$/.test(f))
    return file ? pathToFileURL(path.join(dir, file)).href : null
  } catch {
    return null
  }
}

// Shows electron/portConflict.html, styled like the in-app Navigation Data
// dialog, and resolves to the port to use, or null to quit.
async function askPortConflict(port) {
  const state = { port, fallback: await findFallbackPort(port), owner: await findPortOwner(port) }
  const win = new BrowserWindow({
    width: 540, height: 240, useContentSize: true, show: false,
    resizable: false, minimizable: false, maximizable: false, fullscreenable: false,
    title: 'TRACS', backgroundColor: '#1a1a1a', autoHideMenuBar: true,
    webPreferences: {
      preload:          path.join(__dirname, 'portConflictPreload.js'),
      contextIsolation: true,
      nodeIntegration:  false,
      sandbox:          true,
    },
  })
  win.removeMenu()

  const channels = ['info', 'resize', 'retry', 'fallback', 'quit'].map((c) => `port-conflict:${c}`)
  return new Promise((resolve) => {
    let settled = false
    const finish = (result) => {
      if (settled) return
      settled = true
      for (const c of channels) ipcMain.removeHandler(c)
      if (!win.isDestroyed()) win.destroy()
      resolve(result)
    }
    const handle = (name, fn) => ipcMain.handle(`port-conflict:${name}`, (event, ...args) => {
      if (event.sender !== win.webContents) throw new Error('IPC not allowed from this page')
      return fn(...args)
    })

    handle('info', () => ({ ...state, fontUrl: findBundledFontUrl() }))
    handle('resize', (height) => {
      const h = Math.min(Math.max(Number(height) || 0, 120), 600)
      win.setContentSize(540, h)
      if (!win.isVisible()) win.show()
    })
    handle('retry', async () => {
      if (await probePort(port)) {
        finish(port)
        return { free: true }
      }
      state.fallback = await findFallbackPort(port)
      state.owner    = await findPortOwner(port)
      return { free: false, ...state }
    })
    handle('fallback', () => finish(state.fallback))
    handle('quit', () => finish(null))
    win.on('closed', () => finish(null))

    win.loadFile(path.join(__dirname, 'portConflict.html'))
  })
}

// Resolves to the port to run on, or null when the user chose to quit.
async function resolvePort() {
  let saved = null
  try {
    saved = JSON.parse(fs.readFileSync(PORT_FILE(), 'utf8')).port
  } catch {
    // no saved port yet — first launch
  }

  if (!saved) {
    const port = await findFreePort(DEFAULT_PORT)
    fs.mkdirSync(app.getPath('userData'), { recursive: true })
    fs.writeFileSync(PORT_FILE(), JSON.stringify({ port }))
    return port
  }

  if (await probePort(saved)) return saved
  return askPortConflict(saved)
}

// ── Server bootstrap ──────────────────────────────────────────────────────

function startServer(port) {
  process.env.PORT                  = String(port)
  process.env.TRACS_STATE_DIR       = app.getPath('userData')
  // Keeps LNM-derived extraction output out of the app's own install
  // directory - not reliably writable, and replaced on every app update. The
  // bundled theatre data is read in place from the install directory. See
  // server/navdata/parser.js's CACHE_DIR/BUNDLED_CACHE_DIR.
  process.env.TRACS_NAVDATA_CACHE_DIR = path.join(app.getPath('userData'), 'navdata-cache')
  // Same reasoning as TRACS_NAVDATA_CACHE_DIR above: operator-edited config
  // (rateConfig.json, tacviewDetectionConfig.json, airspace_colors.json,
  // asdex_colors.json) must live outside the install directory to survive an
  // app update. See server/src/seedConfigFiles.js.
  process.env.TRACS_CONFIG_DIR        = path.join(app.getPath('userData'), 'config')
  return require('../server/src/index.js').ready
}

// ── Window ────────────────────────────────────────────────────────────────

const WINDOW_OPTS = {
  width:          1600,
  height:         900,
  webPreferences: {
    preload:         path.join(__dirname, 'preload.js'),
    contextIsolation: true,
    nodeIntegration:  false,
  },
}

function createWindow(port) {
  mainWindow = new BrowserWindow(WINDOW_OPTS)
  mainWindow.loadURL(`http://localhost:${port}`)
}

// Opens an additional, fully independent top-level window at the same root
// URL (no query params -> lands on Login, since a fresh window has no
// session yet) - lets one running TRACS instance sign into multiple
// positions at once, same as opening a second browser tab already did.
// Deliberately does NOT reassign `mainWindow` - dialog.showOpenDialog(
// mainWindow, ...) and the update-banner IPC below both depend on that
// staying pointed at the original/primary window.
function openNewWindow(port) {
  const win = new BrowserWindow(WINDOW_OPTS)
  win.loadURL(`http://localhost:${port}`)
  return win
}

function buildMenu(port) {
  const isMac = process.platform === 'darwin'

  const template = [
    ...(isMac ? [{
      label: app.name,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    }] : []),
    {
      label: 'File',
      submenu: [
        {
          label:       'New Window',
          accelerator: 'CmdOrCtrl+N',
          click:       () => openNewWindow(port),
        },
        {
          label: 'Open Logs Folder',
          click: () => shell.showItemInFolder(log.transports.file.getFile().path),
        },
        {
          label: 'Open Config Folder',
          click: () => shell.showItemInFolder(path.join(app.getPath('userData'), 'config', 'rateConfig.json')),
        },
        { type: 'separator' },
        isMac ? { role: 'close' } : { role: 'quit' },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
      ],
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
  ]

  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

// ── IPC ───────────────────────────────────────────────────────────────────

handleFromApp('app:getVersion', () => app.getVersion())

handleFromApp('lnm:pickDatabase', async (event) => {
  // Start in LittleNavMap's usual database folder when it exists.
  const lnmDir = path.join(app.getPath('appData'), 'ABarthel', 'little_navmap_db')
  const result = await dialog.showOpenDialog(BrowserWindow.fromWebContents(event.sender) ?? mainWindow, {
    title:      'Select your LittleNavMap Navigraph database (little_navmap_navigraph.sqlite)',
    defaultPath: fs.existsSync(lnmDir) ? lnmDir : undefined,
    filters:    [{ name: 'SQLite database', extensions: ['sqlite'] }],
    properties: ['openFile'],
  })
  if (result.canceled || result.filePaths.length === 0) return null
  return result.filePaths[0]
})

// ── Find in page (docs windows' Ctrl+F) ─────────────────────────────────
// Electron has Chromium's page search but not Chrome's find bar. The docs
// page draws the box (server/src/docsFind.js); the searching, highlighting
// and match count are Electron's own findInPage.
const findResultsForwarded = new WeakSet()

handleFromApp('find:start', (event, text, options) => {
  const contents = event.sender
  if (!findResultsForwarded.has(contents)) {
    findResultsForwarded.add(contents)
    contents.on('found-in-page', (_e, result) => {
      if (!contents.isDestroyed()) contents.send('find:result', { activeMatchOrdinal: result.activeMatchOrdinal, matches: result.matches })
    })
  }
  if (typeof text !== 'string' || text === '') return
  // findNext: true starts a new search, false moves to the next match.
  contents.findInPage(text, { forward: options?.forward !== false, findNext: options?.newSearch === true })
})

handleFromApp('find:stop', (event) => event.sender.stopFindInPage('clearSelection'))

// ── Auto-update ("check on launch, ask before downloading") ─────────────
// autoDownload:false — respects variable end-user bandwidth rather than
// silently consuming data. Mac builds aren't code-signed, so electron-updater's Squirrel.Mac backend can't verify unsigned
// updates — Mac falls back to notify-only (link to the release page).

function setupAutoUpdate() {
  if (process.platform === 'darwin') {
    const { autoUpdater } = require('electron-updater')
    // Notify-only: never download an update the unsigned app can't install.
    // The zip target is what makes electron-builder publish latest-mac.yml,
    // which this check reads.
    autoUpdater.autoDownload = false
    autoUpdater.on('update-available', (info) => {
      mainWindow?.webContents.send('update:notify-only', info.version)
    })
    autoUpdater.checkForUpdates().catch((err) => console.error('[update] check failed:', err.message))
    return
  }

  const { autoUpdater } = require('electron-updater')
  autoUpdater.autoDownload = false

  autoUpdater.on('update-available', (info) => {
    mainWindow?.webContents.send('update:available', info.version)
  })
  autoUpdater.on('download-progress', (progress) => {
    mainWindow?.webContents.send('update:progress', progress.percent)
  })
  autoUpdater.on('update-downloaded', () => {
    mainWindow?.webContents.send('update:downloaded')
  })
  autoUpdater.on('error', (err) => console.error('[update] error:', err.message))

  handleFromApp('update:download', () => autoUpdater.downloadUpdate())
  handleFromApp('update:install', () => autoUpdater.quitAndInstall())

  autoUpdater.checkForUpdates().catch((err) => console.error('[update] check failed:', err.message))
}

handleFromApp('update:openReleasePage', () => shell.openExternal('https://github.com/denimchickensoft/TRACS/releases/latest'))

// ── Lifecycle ─────────────────────────────────────────────────────────────

// True until the main window exists, so closing the port-conflict dialog
// doesn't count as the last window closing.
let startingUp = true

app.whenReady().then(async () => {
  const port = await resolvePort()
  if (port === null) {
    app.quit()
    return
  }
  currentPort = port
  await startServer(port)
  createWindow(port)
  startingUp = false
  buildMenu(port)
  setupAutoUpdate()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow(port)
  })
}).catch((err) => {
  // e.g. no free port in the range. Without this the app would keep running
  // with no window. If the window did open, a later step failed; keep it.
  console.error('[electron] startup failed:', err)
  dialog.showErrorBox('TRACS could not start', err?.message ?? String(err))
  if (BrowserWindow.getAllWindows().length === 0) app.quit()
})

// Let the in-process server stop its sources and close sockets cleanly
// before the app exits. The quit is paused once, then resumed.
let serverShutDown = false
app.on('before-quit', (event) => {
  if (serverShutDown || currentPort === null) return
  event.preventDefault()
  serverShutDown = true
  require('../server/src/index.js').shutdown()
    .catch((err) => console.error('[electron] server shutdown failed:', err))
    .finally(() => app.quit())
})

app.on('window-all-closed', () => {
  if (startingUp) return
  if (process.platform !== 'darwin') app.quit()
})

'use strict';
/*
 * Smoke & Mirrors — main process.
 *
 * SAFETY CONTRACT (the most important part of this app):
 *   - We NEVER change system display settings (no xrandr / kscreen / mirroring changes),
 *     never install autostart entries, never touch anything outside our own userData dir.
 *   - Everything the audience sees comes from ONE window of ours placed on the projector.
 *     If this app quits, crashes or is killed, that window disappears with the process and
 *     the projector simply shows your normal desktop again — exactly as without the app.
 *   - If the projector gets unplugged, the output window is destroyed immediately so it can
 *     never end up covering your laptop screen.
 */
const {
  app, BrowserWindow, screen, ipcMain, dialog, protocol, net,
  desktopCapturer, session, globalShortcut, powerSaveBlocker, shell,
} = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { pathToFileURL } = require('node:url');
const { setOverrideRedirect, xidOf } = require('./x11');

const APP_NAME = 'Smoke & Mirrors';
const UI_DIR = path.join(__dirname, 'ui');
const OUTPUT_URL = 'sm://app/output.html';
const CONTROL_URL = 'sm://app/control.html';

const MEDIA_EXT = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.avif', '.bmp', '.svg', '.apng',
  '.mp4', '.webm', '.mkv', '.mov', '.m4v', '.ogv',
]);

// ---------------------------------------------------------------------------
// Wayland: clients cannot choose which monitor a window goes to. Run ourselves through
// XWayland (only this process, nothing system-wide) so we can put the output exactly on
// the projector. Set SM_NATIVE_WAYLAND=1 to opt out.
// ---------------------------------------------------------------------------
if (process.platform === 'linux'
    && process.env.XDG_SESSION_TYPE === 'wayland'
    && !process.env.SM_NATIVE_WAYLAND
    && !app.commandLine.hasSwitch('ozone-platform')) {
  app.relaunch({ args: process.argv.slice(1).concat(['--ozone-platform=x11']) });
  app.exit(0);
  return; // eslint-disable-line no-unreachable
}

app.setName(APP_NAME);

if (!app.requestSingleInstanceLock()) {
  app.quit();
  return; // eslint-disable-line no-unreachable
}

protocol.registerSchemesAsPrivileged([{
  scheme: 'sm',
  privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true },
}]);

// ---------------------------------------------------------------------------
// Persistent state (scenes + settings) — lives only in our userData folder.
// ---------------------------------------------------------------------------
const STATE_FILE = () => path.join(app.getPath('userData'), 'state.json');

function readState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE(), 'utf8')); } catch { return null; }
}
function writeState(data) {
  try {
    const file = STATE_FILE();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
    fs.renameSync(tmp, file);
    return true;
  } catch (err) {
    console.error('[state] save failed', err);
    return false;
  }
}

let settings = { projectorDisplayId: null, testMode: false, keepAwake: true };
{
  // settings needed by main are mirrored from the saved state at startup
  app.whenReady().then(() => {
    const s = readState();
    if (s && s.settings) Object.assign(settings, pick(s.settings, ['projectorDisplayId', 'testMode', 'keepAwake']));
    applyKeepAwake();
  });
}
function pick(obj, keys) {
  const out = {};
  for (const k of keys) if (k in obj) out[k] = obj[k];
  return out;
}

// ---------------------------------------------------------------------------
// Displays
// ---------------------------------------------------------------------------
function displayLabel(d, i) {
  const { width, height } = d.size;
  const name = d.label && d.label.trim() ? d.label.trim() : `Display ${i + 1}`;
  return `${name} — ${Math.round(width * d.scaleFactor)}×${Math.round(height * d.scaleFactor)}`;
}

/** Where the controller lives: the built-in laptop panel if there is one, else the primary display. */
function homeDisplay() {
  const all = screen.getAllDisplays();
  return all.find((d) => d.internal) || screen.getPrimaryDisplay();
}

/** The display the controller window is actually on right now. */
function controlDisplay() {
  if (controlWin && !controlWin.isDestroyed()) return screen.getDisplayMatching(controlWin.getBounds());
  return homeDisplay();
}

function listDisplays() {
  const mine = controlDisplay();
  return screen.getAllDisplays().map((d, i) => ({
    id: d.id,
    label: displayLabel(d, i),
    bounds: d.bounds,
    scaleFactor: d.scaleFactor,
    controller: d.id === mine.id,
  }));
}

/** The display the audience looks at: never the one the controller window is on. */
function projectorDisplay() {
  const mine = controlDisplay();
  const home = homeDisplay();
  // Never the controller's screen — and never the laptop panel either, even if you dragged the
  // controller onto the projector.
  const others = screen.getAllDisplays().filter((d) => d.id !== mine.id && d.id !== home.id);
  if (!others.length) return null;
  return others.find((d) => d.id === settings.projectorDisplayId) || others[0];
}

function outputMode() {
  if (projectorDisplay()) return 'projector';
  if (settings.testMode) return 'test';
  return 'none';
}

function displayInfo() {
  const p = projectorDisplay();
  return {
    displays: listDisplays(),
    projectorId: p ? p.id : null,
    mode: outputMode(),
    testMode: settings.testMode,
  };
}

// ---------------------------------------------------------------------------
// Windows
// ---------------------------------------------------------------------------
let controlWin = null;
let outputWin = null;
let outputRole = null;            // 'projector' | 'test' — what the current output window was made for
let outputUnmanaged = false;      // override-redirect active (stays above focused fullscreen apps)
let outputReady = null;           // promise resolved once the window is prepared
let outputWantedVisible = true;   // false while "Reveal desktop" is live
let outputDisplayId = null;       // display the output was last placed on
let placeGen = 0;                 // bumps on every placement so stale verify chains stop
let destroyingOnPurpose = false;

function createControlWindow() {
  const wa = homeDisplay().workArea;
  controlWin = new BrowserWindow({
    title: APP_NAME,
    x: wa.x + Math.round(wa.width * 0.05),
    y: wa.y + Math.round(wa.height * 0.05),
    width: Math.min(1500, Math.round(wa.width * 0.9)),
    height: Math.min(980, Math.round(wa.height * 0.9)),
    minWidth: 980,
    minHeight: 640,
    backgroundColor: '#101114',
    show: false,
    icon: path.join(UI_DIR, 'icon.png'),
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      sandbox: true,
      backgroundThrottling: false, // keep countdowns/fades smooth when minimized
      autoplayPolicy: 'no-user-gesture-required',
    },
  });
  controlWin.removeMenu();
  controlWin.once('ready-to-show', () => { controlWin.maximize(); controlWin.show(); });
  let lastControlDisplay = null;
  let moveTimer = null;
  controlWin.on('move', () => {
    clearTimeout(moveTimer);
    moveTimer = setTimeout(() => {
      if (!controlWin || controlWin.isDestroyed()) return;
      const id = controlDisplay().id;
      if (lastControlDisplay !== null && id !== lastControlDisplay) onDisplaysChanged();
      lastControlDisplay = id;
    }, 700);
  });

  const wc = controlWin.webContents;

  // The output window is opened by the control page itself (window.open) so both pages share
  // one JS world: live screen captures (MediaStreams) can be shown on the projector directly,
  // with zero copying or extra capture prompts.
  wc.setWindowOpenHandler(({ url }) => {
    if (url !== OUTPUT_URL) {
      if (/^https?:/i.test(url)) shell.openExternal(url);
      return { action: 'deny' };
    }
    const mode = outputMode();
    if (mode === 'none') return { action: 'deny' };
    const test = mode === 'test';
    const p = projectorDisplay();
    return {
      action: 'allow',
      overrideBrowserWindowOptions: test ? {
        title: `${APP_NAME} — projector test window`,
        width: 640, height: 360, show: false, frame: true,
        backgroundColor: '#000000', autoHideMenuBar: true,
        webPreferences: { backgroundThrottling: false, autoplayPolicy: 'no-user-gesture-required' },
      } : {
        title: `${APP_NAME} — output`,
        // created directly on the projector, hidden until it has been placed
        ...p.bounds,
        show: false, frame: false, transparent: true, backgroundColor: '#00000000',
        skipTaskbar: true, resizable: false, movable: false, minimizable: false,
        maximizable: false, hasShadow: false, focusable: false,
        webPreferences: { backgroundThrottling: false, autoplayPolicy: 'no-user-gesture-required' },
      },
    };
  });

  wc.on('did-create-window', (win) => {
    if (outputWin && !outputWin.isDestroyed()) destroyOutput();
    outputWin = win;
    outputRole = outputMode() === 'test' ? 'test' : 'projector';
    outputUnmanaged = false;
    outputDisplayId = null;
    win.removeMenu();
    win.on('closed', () => {
      if (outputWin !== win) return;
      const role = outputRole;
      outputWin = null; outputRole = null; outputDisplayId = null;
      if (!destroyingOnPurpose && role === 'test') sendToControl('output:userClosed', role);
    });

    let guardTimer = null;
    let guardAttempts = 0;
    const guard = () => {
      if (win !== outputWin || outputRole !== 'projector') return;
      if (!outputOnWrongDisplay(win, outputDisplayId)) return;
      win.hide(); // never sit on the controller's screen, not even for a moment
      clearTimeout(guardTimer);
      guardTimer = setTimeout(() => {
        if (win !== outputWin) return;
        if (++guardAttempts > 4) { giveUp(); return; }
        placeOutput(guardAttempts);
      }, 600);
    };
    win.on('move', guard);
    win.on('resize', guard);
    win.on('show', guard);

    outputReady = (outputRole === 'projector' && process.platform === 'linux' && process.env.DISPLAY)
      ? setOverrideRedirect(xidOf(win), true).then((ok) => {
        outputUnmanaged = ok;
        if (!ok) {
          console.warn('[output] could not make the output unmanaged — a focused fullscreen app may cover it');
          sendToControl('output:warning', 'Heads-up: a focused fullscreen app on the projector could cover the curtain on this system.');
        }
      })
      : Promise.resolve();
    win.webContents.once('did-finish-load', () => outputReady.then(() => placeOutput()));
  });

  // If the control page dies or hangs, the output (same renderer) goes with it: fall back to the
  // normal desktop and reload the controller.
  wc.on('render-process-gone', (_e, details) => {
    console.error('[control] renderer gone', details);
    destroyOutput();
    if (details.reason !== 'clean-exit' && controlWin && !controlWin.isDestroyed()) {
      setTimeout(() => controlWin && !controlWin.isDestroyed() && controlWin.reload(), 500);
    }
  });
  controlWin.on('unresponsive', () => {
    console.error('[control] unresponsive — removing output so the projector shows the normal desktop');
    destroyOutput();
  });

  wc.on('will-navigate', (e, url) => { if (url !== CONTROL_URL) e.preventDefault(); });

  controlWin.on('closed', () => {
    controlWin = null;
    destroyOutput();
    app.quit();
  });

  controlWin.loadURL(CONTROL_URL);
}

function destroyOutput() {
  placeGen++;
  if (outputWin && !outputWin.isDestroyed()) {
    destroyingOnPurpose = true;
    try { outputWin.destroy(); } finally { destroyingOnPurpose = false; }
  }
  outputWin = null;
  outputRole = null;
  outputDisplayId = null;
}

function giveUp() {
  console.error('[output] could not place output on the projector — giving up, desktop stays normal');
  destroyOutput();
  sendToControl('output:failed', 'The output could not be placed on the projector. Pick the display again or re-open the output.');
}

function refocusControl() {
  if (controlWin && !controlWin.isDestroyed()) setTimeout(() => controlWin && !controlWin.isDestroyed() && controlWin.focus(), 150);
}

const sameBounds = (a, b) => a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;

function placeOutput(attempt = 0) {
  if (!outputWin || outputWin.isDestroyed()) return;
  const mode = outputMode();
  if (mode === 'none' || (outputRole === 'projector') !== (mode === 'projector')) { destroyOutput(); return; }

  if (outputRole === 'test') {
    if (!outputWin.isVisible()) {
      const wa = controlDisplay().workArea;
      outputWin.setBounds({ x: wa.x + wa.width - 680, y: wa.y + wa.height - 420, width: 640, height: 360 });
      outputWin.setAlwaysOnTop(true, 'floating'); // a rehearsal window you can move around, above the controller
      outputWin.showInactive();
    }
    return;
  }

  const d = projectorDisplay();
  if (!d) { destroyOutput(); return; }
  if (outputDisplayId != null && outputDisplayId !== d.id) { destroyOutput(); return; } // never "slide" between screens

  const win = outputWin;
  const gen = ++placeGen;
  const already = outputDisplayId === d.id && sameBounds(win.getBounds(), d.bounds)
    && (outputUnmanaged || win.isFullScreen());
  outputDisplayId = d.id;

  if (!already) {
    if (win.isVisible()) win.hide(); // re-place while hidden: no flicker over the wrong screen
    if (outputUnmanaged) {
      win.setBounds(d.bounds);       // unmanaged: we place it, nobody else does
    } else {
      if (win.isFullScreen()) win.setFullScreen(false);
      win.setBounds(d.bounds);
      win.setAlwaysOnTop(true, 'screen-saver');
      win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
      win.setFullScreen(true);
    }
  }
  if (outputWantedVisible && !win.isVisible()) { win.showInactive(); refocusControl(); }
  if (!outputWantedVisible && win.isVisible()) win.hide();

  // The window manager has the last word on placement. Check where we really ended up.
  setTimeout(() => verifyPlacement(win, gen, attempt), 400);
}

/** Is the output window covering the controller's display (or not on its target)? Must never happen. */
function outputOnWrongDisplay(win, targetId) {
  if (!win || win.isDestroyed() || !win.isVisible()) return false;
  if (targetId == null) return true; // visible but never placed
  const actual = screen.getDisplayMatching(win.getBounds());
  return actual.id !== targetId || actual.id === controlDisplay().id;
}

function verifyPlacement(win, gen, attempt) {
  if (win !== outputWin || gen !== placeGen) return; // superseded
  if (!outputOnWrongDisplay(win, outputDisplayId)) return;
  win.hide(); // safety first: get off the wrong screen immediately
  if (attempt < 4) {
    setTimeout(() => { if (win === outputWin && gen === placeGen) placeOutput(attempt + 1); }, 500 * (attempt + 1));
  } else {
    giveUp();
  }
}

let displaySettleTimer = null;
function onDisplaysChanged() {
  // Safety first: if the display we were covering is gone (or is no longer the projector), kill the
  // output NOW — before the window manager can move it onto the laptop screen. Decided by what the
  // window was made for, not by the current mode.
  if (outputWin && outputRole === 'projector') {
    const p = projectorDisplay();
    const still = outputDisplayId != null && screen.getAllDisplays().some((d) => d.id === outputDisplayId);
    if (!p || (outputDisplayId != null && (!still || p.id !== outputDisplayId))) destroyOutput();
    else if (outputOnWrongDisplay(outputWin, outputDisplayId)) outputWin.hide();
  }
  if (outputWin && outputRole === 'test' && outputMode() !== 'test') destroyOutput();
  // Monitors come and go in bursts while the compositor reconfigures; wait until it settles
  // before (re)creating anything.
  clearTimeout(displaySettleTimer);
  displaySettleTimer = setTimeout(() => {
    if (outputWin) placeOutput();
    sendToControl('displays:changed', displayInfo());
  }, 1200);
}

function sendToControl(channel, payload) {
  if (controlWin && !controlWin.isDestroyed()) controlWin.webContents.send(channel, payload);
}

// "Identify displays": flash a big number on each screen for a moment.
function identifyDisplays() {
  const mine = controlDisplay();
  const p = projectorDisplay();
  screen.getAllDisplays().forEach((d, i) => {
    const role = d.id === mine.id ? 'YOU (controller)' : (p && d.id === p.id ? 'AUDIENCE (projector)' : 'unused');
    const w = new BrowserWindow({
      x: d.bounds.x + Math.round(d.bounds.width / 2 - 260),
      y: d.bounds.y + Math.round(d.bounds.height / 2 - 160),
      width: 520, height: 320, frame: false, transparent: true, alwaysOnTop: true,
      skipTaskbar: true, focusable: false, resizable: false, show: false,
      backgroundColor: '#00000000',
      webPreferences: { sandbox: true, contextIsolation: true },
    });
    w.setAlwaysOnTop(true, 'screen-saver');
    const html = `<!doctype html><meta charset="utf-8"><body style="margin:0;display:grid;place-items:center;height:100vh;font-family:system-ui,sans-serif;background:transparent">
      <div style="background:rgba(12,12,16,.92);color:#fff;border-radius:28px;padding:26px 44px;text-align:center;border:3px solid #ffb627">
      <div style="font-size:150px;font-weight:800;line-height:1">${i + 1}</div>
      <div style="font-size:22px;opacity:.85;letter-spacing:.08em">${role}</div></div></body>`;
    w.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
    w.once('ready-to-show', () => w.showInactive());
    setTimeout(() => { if (!w.isDestroyed()) w.destroy(); }, 2600);
  });
}

// ---------------------------------------------------------------------------
// Keep-awake (released automatically when the app exits — nothing persists)
// ---------------------------------------------------------------------------
let keepAwakeId = null;
function applyKeepAwake() {
  if (settings.keepAwake && keepAwakeId == null) keepAwakeId = powerSaveBlocker.start('prevent-display-sleep');
  if (!settings.keepAwake && keepAwakeId != null) { powerSaveBlocker.stop(keepAwakeId); keepAwakeId = null; }
}

// ---------------------------------------------------------------------------
// Screen / window capture sources
// ---------------------------------------------------------------------------
const sourceCache = new Map(); // id -> DesktopCapturerSource
let pendingSourceId = null;

async function listSources() {
  const sources = await desktopCapturer.getSources({
    types: ['window', 'screen'],
    thumbnailSize: { width: 400, height: 225 },
    fetchWindowIcons: false,
  });
  sourceCache.clear();
  const ownIds = new Set(BrowserWindow.getAllWindows().map((w) => w.getMediaSourceId()));
  const out = [];
  for (const s of sources) {
    if (ownIds.has(s.id)) continue;
    sourceCache.set(s.id, s);
    out.push({
      id: s.id,
      name: s.name,
      kind: s.id.startsWith('screen') ? 'screen' : 'window',
      thumbnail: s.thumbnail && !s.thumbnail.isEmpty() ? s.thumbnail.toDataURL() : null,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// IPC
// ---------------------------------------------------------------------------
function registerIpc() {
  ipcMain.handle('state:load', () => ({
    saved: readState(),
    displays: displayInfo(),
    platform: process.platform,
    wayland: process.env.XDG_SESSION_TYPE === 'wayland',
    version: app.getVersion(),
  }));

  ipcMain.handle('state:save', (_e, data) => {
    if (data && data.settings) {
      const before = { ...settings };
      Object.assign(settings, pick(data.settings, ['projectorDisplayId', 'testMode', 'keepAwake']));
      if (before.keepAwake !== settings.keepAwake) applyKeepAwake();
      if (before.projectorDisplayId !== settings.projectorDisplayId || before.testMode !== settings.testMode) {
        // output target changed → let the controller re-open the output where it belongs
        destroyOutput();
        setTimeout(() => sendToControl('displays:changed', displayInfo()), 50);
      }
    }
    return writeState(data);
  });

  ipcMain.handle('displays:get', () => displayInfo());
  ipcMain.handle('displays:identify', () => identifyDisplays());

  ipcMain.handle('output:setVisible', (_e, visible) => {
    outputWantedVisible = !!visible;
    if (!outputWin || outputWin.isDestroyed() || outputRole !== 'projector') return;
    if (!visible) { outputWin.hide(); return; }
    // only show a window that has been placed on the projector; otherwise (re)place it first
    if (outputDisplayId == null) return; // placeOutput will show it once it's ready
    if (!outputWin.isVisible()) placeOutput();
  });

  ipcMain.handle('dialog:media', async () => {
    const r = await dialog.showOpenDialog(controlWin, {
      title: 'Add images, GIFs or videos',
      properties: ['openFile', 'multiSelections'],
      filters: [
        { name: 'Images, GIFs & videos', extensions: [...MEDIA_EXT].map((e) => e.slice(1)) },
        { name: 'All files', extensions: ['*'] },
      ],
    });
    return r.canceled ? [] : r.filePaths;
  });

  ipcMain.handle('media:exists', (_e, p) => {
    try { return fs.statSync(p).isFile(); } catch { return false; }
  });

  ipcMain.handle('capture:list', async () => {
    try { return { ok: true, sources: await listSources() }; } catch (err) { return { ok: false, error: String(err && err.message || err) }; }
  });
  ipcMain.handle('capture:select', (_e, id) => { pendingSourceId = id; return sourceCache.has(id); });
}

// ---------------------------------------------------------------------------
// Protocol: sm://app/<file> (our UI) and sm://app/__media/<encoded absolute path> (your media)
// ---------------------------------------------------------------------------
function registerProtocol() {
  protocol.handle('sm', async (req) => {
    try {
      const u = new URL(req.url);
      if (u.host !== 'app') return new Response('not found', { status: 404 });
      const pathname = decodeURIComponent(u.pathname);
      if (pathname.startsWith('/__media/')) {
        const file = pathname.slice('/__media/'.length);
        if (!path.isAbsolute(file) || !MEDIA_EXT.has(path.extname(file).toLowerCase())) {
          return new Response('forbidden', { status: 403 });
        }
        const res = await net.fetch(pathToFileURL(file).toString(), { headers: req.headers });
        if (path.extname(file).toLowerCase() !== '.svg') return res;
        const headers = new Headers(res.headers);
        headers.set('Content-Security-Policy', 'sandbox; script-src \'none\''); // SVGs can carry scripts
        headers.set('Content-Type', 'image/svg+xml');
        return new Response(res.body, { status: res.status, headers });
      }
      const rel = pathname.replace(/^\/+/, '') || 'control.html';
      const file = path.normalize(path.join(UI_DIR, rel));
      if (!file.startsWith(UI_DIR + path.sep)) return new Response('forbidden', { status: 403 });
      return await net.fetch(pathToFileURL(file).toString());
    } catch {
      return new Response('not found', { status: 404 });
    }
  });
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
app.on('second-instance', () => {
  if (controlWin) { if (controlWin.isMinimized()) controlWin.restore(); controlWin.focus(); }
});

app.whenReady().then(() => {
  registerProtocol();
  registerIpc();

  // Screen capture: the control page calls getDisplayMedia() after choosing a source.
  session.defaultSession.setDisplayMediaRequestHandler((_req, callback) => {
    const src = pendingSourceId && sourceCache.get(pendingSourceId);
    pendingSourceId = null;
    if (src) callback({ video: src });
    else callback({});
  });

  // Deny every permission we don't need.
  session.defaultSession.setPermissionRequestHandler((_wc, permission, cb) => {
    cb(['media', 'display-capture', 'fullscreen'].includes(permission));
  });

  createControlWindow();

  screen.on('display-added', onDisplaysChanged);
  screen.on('display-removed', onDisplaysChanged);
  screen.on('display-metrics-changed', onDisplaysChanged);

  // Best-effort panic keys that work even when the controller isn't focused
  // (on Wayland the compositor may only deliver them while one of our windows has focus).
  const keys = { 'CommandOrControl+Alt+B': 'blackout', 'CommandOrControl+Alt+C': 'cover', 'CommandOrControl+Alt+Space': 'take' };
  for (const [accel, action] of Object.entries(keys)) {
    try { globalShortcut.register(accel, () => sendToControl('hotkey', action)); } catch { /* ignore */ }
  }
});

process.on('uncaughtException', (err) => {
  console.error('[main] uncaught exception — removing output so the projector shows the normal desktop', err);
  try { destroyOutput(); } catch { /* nothing left to do */ }
});

app.on('will-quit', () => globalShortcut.unregisterAll());
app.on('window-all-closed', () => app.quit());

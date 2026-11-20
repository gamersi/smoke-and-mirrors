import { createStage, formatDuration } from './stage.js';

const api = window.sm;
const $ = (sel) => document.querySelector(sel);
const uid = () => Math.random().toString(36).slice(2, 10);

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|avif|bmp|svg|apng)$/i;
const VIDEO_EXT = /\.(mp4|webm|mkv|mov|m4v|ogv)$/i;
const BUILTIN = new Set(['black', 'desktop']);
const TYPE_LABEL = {
  black: 'Black', desktop: 'Reveal desktop', curtain: 'Curtain', text: 'Text card', countdown: 'Countdown',
  pattern: 'Test pattern', image: 'Image / GIF', video: 'Video', capture: 'Window / screen', color: 'Solid color',
};

const DEFAULT_SCENES = () => [
  { id: 'curtain', type: 'curtain', name: 'Curtain', title: 'The show starts soon', subtitle: '', color: '#8f1020' },
  { id: 'desktop', type: 'desktop', name: 'Reveal desktop', peekId: null },
  { id: 'black', type: 'black', name: 'Black' },
  { id: uid(), type: 'text', name: 'Starting soon', title: 'We start in a moment', subtitle: 'Grab a coffee ☕', fg: '#ffffff', bg: '#101820' },
  { id: uid(), type: 'countdown', name: 'Countdown 5 min', minutes: 5, title: 'Starting in', doneText: "Let's go!", fg: '#ffffff', bg: '#0b0f1a' },
  { id: uid(), type: 'pattern', name: 'Test pattern' },
];

const DEFAULT_SETTINGS = {
  transition: 'fade', duration: 600, coverId: 'curtain',
  projectorDisplayId: null, testMode: false, keepAwake: true, autoTimer: true,
};

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
let scenes = [];
let settings = { ...DEFAULT_SETTINGS };
let displays = { displays: [], projectorId: null, mode: 'none', testMode: false };
let previewId = null;
let program = null;      // snapshot currently on air
let programId = null;
let takeToken = 0;
let blackoutRestore = null; // { snap, id } while blackout is active
let freezeRestore = null;   // { snap, id } while freeze is active
let revealedOnce = false;

let previewStage, programStage;
let outputStage = null;
let outWin = null;
let outOpenedFor = '';
let outCounter = 0;

const byId = (id) => scenes.find((s) => s.id === id);
const cover = () => byId(settings.coverId) || byId('curtain') || byId('black');

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------
let saveTimer = null;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const clean = scenes.map(({ stream, ended, endsAt, peekStream, missing, ...rest }) => rest);
    api.saveState({ version: 1, scenes: clean, settings });
  }, 300);
}
function saveNow() {
  clearTimeout(saveTimer);
  const clean = scenes.map(({ stream, ended, endsAt, peekStream, missing, ...rest }) => rest);
  return api.saveState({ version: 1, scenes: clean, settings });
}

// ---------------------------------------------------------------------------
// Output window (the projector). Opened from this page so it shares our JS world.
// ---------------------------------------------------------------------------
window.__smOutputReady = (w) => {
  if (w !== outWin) { try { w.close(); } catch { /* */ } return; }
  const doc = w.document;
  doc.body.style.background = 'transparent';
  if (displays.mode === 'test') doc.title = 'Smoke & Mirrors — projector test window';
  const mode = displays.mode === 'test' ? 'monitor' : 'output';
  outputStage = createStage(doc.getElementById('stage'), { mode });
  if (program) outputStage.show(program, { transition: 'cut' });
  api.setOutputVisible(!(program && program.type === 'desktop'));
  renderStatus();
};

function closeOutput() {
  if (outputStage) { outputStage.destroy(); outputStage = null; }
  if (outWin && !outWin.closed) { try { outWin.close(); } catch { /* */ } }
  outWin = null;
  outOpenedFor = '';
}

function reconcileOutput() {
  const want = displays.mode === 'none' ? '' : `${displays.mode}:${displays.projectorId}`;
  if (!want) { closeOutput(); return; }
  if (outWin && !outWin.closed && outOpenedFor === want) return;
  closeOutput();
  outOpenedFor = want;
  outWin = window.open('sm://app/output.html', `sm-output-${++outCounter}`);
}

// Notice when the output window disappears (closed by the user, display unplugged, …)
setInterval(() => {
  if (outWin && outWin.closed) {
    outputStage = null; outWin = null; outOpenedFor = '';
    renderStatus();
  }
}, 700);

// ---------------------------------------------------------------------------
// Taking scenes to air
// ---------------------------------------------------------------------------
function snapshotOf(scene) {
  const snap = { ...scene };
  if (scene.type === 'countdown') snap.endsAt = Date.now() + (Number(scene.minutes) || 0) * 60000;
  if (scene.type === 'desktop') {
    const peek = byId(scene.peekId);
    snap.peekStream = peek && peek.stream && !peek.ended ? peek.stream : null;
  }
  return snap;
}

function airSnapshot(snap, id, { transition = settings.transition, duration = settings.duration } = {}) {
  const tr = { transition, duration: transition === 'cut' ? 0 : duration };
  const wasDesktop = program && program.type === 'desktop';
  const token = ++takeToken;
  program = snap;
  programId = id;

  if (snap.type !== 'desktop' && wasDesktop) api.setOutputVisible(true);
  programStage.show(snap, tr);
  if (outputStage) outputStage.show(snap, tr);
  if (snap.type === 'desktop') {
    setTimeout(() => { if (token === takeToken) api.setOutputVisible(false); }, tr.duration + 80);
    if (!revealedOnce && settings.autoTimer && !sw.running) swStart();
    revealedOnce = true;
  }
  if (id !== '__freeze' && id !== 'black') freezeRestore = null;
  if (id !== 'black') blackoutRestore = null;
  renderTally();
}

function take(id, opts) {
  const scene = byId(id);
  if (!scene) return;
  if (scene.type === 'capture' && (!scene.stream || scene.ended)) {
    toast('That source has no signal — select it and click “Re-pick source”.', true);
    return;
  }
  airSnapshot(snapshotOf(scene), id, opts);
  const b = $('#takeBtn'); b.classList.add('flash'); setTimeout(() => b.classList.remove('flash'), 150);
}

function takePreview() { if (previewId) take(previewId); }

function toggleBlackout() {
  if (programId === 'black') {
    const r = blackoutRestore;
    blackoutRestore = null;
    if (r) restore(r.snap, r.id); else take(cover().id, { transition: 'cut' });
  } else {
    const prev = program ? { snap: program, id: programId } : null;
    airSnapshot(snapshotOf(byId('black')), 'black', { transition: 'cut' });
    blackoutRestore = prev;
  }
  renderTally();
}

function restore(snap, id) {
  if (snap.type === 'capture') {
    // use the scene's current stream (it may have been re-picked); dead source → cover
    const scene = byId(id);
    const stream = scene && scene.stream;
    if (!stream || scene.ended || stream.getVideoTracks().every((t) => t.readyState === 'ended')) {
      take(cover().id, { transition: 'cut' });
      return;
    }
    airSnapshot({ ...snap, stream }, id, { transition: 'cut' });
    return;
  }
  airSnapshot(snap, id, { transition: 'cut' });
}

function toggleFreeze() {
  if (programId === '__freeze' && freezeRestore) {
    const { snap, id } = freezeRestore;
    freezeRestore = null;
    restore(snap, id);
    renderTally();
    return;
  }
  // Prefer the frame the audience sees; for the desktop use the peek capture in the monitor.
  let data = null;
  if (program && program.type !== 'desktop' && outputStage) data = outputStage.snapshot();
  if (!data) data = programStage.snapshot();
  if (!data) {
    toast(program && program.type === 'desktop'
      ? 'To freeze the real desktop, add a Window/Screen source of the projector and pick it as “peek” on the Reveal scene.'
      : 'Nothing to freeze — freeze works on videos, captures and images.', true);
    return;
  }
  const prev = { snap: program, id: programId };
  airSnapshot({ id: '__freeze', type: 'image', name: '❄ Frozen frame', src: data, fit: 'contain', bg: '#000' }, '__freeze', { transition: 'cut' });
  freezeRestore = prev;
  renderTally();
}

function setPreview(id) {
  const s = byId(id);
  if (!s) return;
  previewId = id;
  // desktop needs its peek stream resolved; a countdown in preview shows its full (not running) time
  previewStage.show(s.type === 'desktop' ? snapshotOf(s) : { ...s }, { transition: 'cut' });
  renderTally();
  renderInspector();
}

// ---------------------------------------------------------------------------
// Scenes
// ---------------------------------------------------------------------------
function addScene(scene, { select = true } = {}) {
  scenes.push(scene);
  renderGrid();
  if (select) setPreview(scene.id);
  save();
  return scene;
}

function deleteScene(id) {
  const s = byId(id);
  if (!s || BUILTIN.has(id)) return;
  if (programId === id) take(settings.coverId === id ? 'black' : cover().id, { transition: 'cut' });
  if (s.stream) s.stream.getTracks().forEach((t) => t.stop());
  scenes = scenes.filter((x) => x.id !== id);
  if (settings.coverId === id) settings.coverId = byId('curtain') ? 'curtain' : 'black';
  scenes.forEach((x) => { if (x.peekId === id) x.peekId = null; });
  if (previewId === id) setPreview(scenes[0].id);
  renderGrid();
  save();
}

function duplicateScene(id) {
  const s = byId(id);
  if (!s || BUILTIN.has(id) || s.type === 'capture') return;
  const { stream, ended, ...rest } = s;
  const copy = { ...rest, id: uid(), name: `${s.name} copy` };
  scenes.splice(scenes.indexOf(s) + 1, 0, copy);
  renderGrid();
  setPreview(copy.id);
  save();
}

function updateScene(id, patch) {
  const s = byId(id);
  if (!s) return;
  Object.assign(s, patch);
  renderTile(s);
  if (previewId === id) {
    previewStage.show(s.type === 'desktop' ? snapshotOf(s) : { ...s }, { transition: 'cut' });
  }
  renderLiveNote();
  save();
}

async function addMediaPaths(paths) {
  let added = 0;
  for (const p of paths) {
    const name = p.split(/[\\/]/).pop();
    if (IMAGE_EXT.test(p)) { addScene({ id: uid(), type: 'image', name, path: p, fit: 'contain', bg: '#000000' }); added++; }
    else if (VIDEO_EXT.test(p)) { addScene({ id: uid(), type: 'video', name, path: p, fit: 'contain', loop: true, audio: false, bg: '#000000' }); added++; }
  }
  if (!added && paths.length) toast('Only images, GIFs and videos can be added.', true);
}

const NEW_SCENE = {
  text: () => ({ id: uid(), type: 'text', name: 'Text card', title: 'Your title', subtitle: '', fg: '#ffffff', bg: '#101820' }),
  countdown: () => ({ id: uid(), type: 'countdown', name: 'Countdown', minutes: 10, title: 'Starting in', doneText: "Let's go!", fg: '#ffffff', bg: '#0b0f1a' }),
  curtain: () => ({ id: uid(), type: 'curtain', name: 'Curtain', title: 'Intermission', subtitle: '', color: '#1d3f8f' }),
  color: () => ({ id: uid(), type: 'color', name: 'Solid color', color: '#1b2a4a' }),
  pattern: () => ({ id: uid(), type: 'pattern', name: 'Test pattern' }),
};

// ---------------------------------------------------------------------------
// Screen / window capture
// ---------------------------------------------------------------------------
async function pickSource() {
  const res = await api.listSources();
  if (!res.ok) { toast(`Could not list windows/screens: ${res.error}`, true); return null; }
  const sources = res.sources;
  if (!sources.length) { toast('No source selected.', true); return null; }
  if (sources.length === 1) return sources[0]; // Wayland: the system dialog already asked
  return new Promise((resolve) => {
    const dlg = $('#pickerDlg');
    const grid = $('#pickerGrid');
    grid.replaceChildren();
    const sorted = [...sources].sort((a, b) => (a.kind === b.kind ? 0 : a.kind === 'window' ? -1 : 1));
    for (const s of sorted) {
      const b = document.createElement('button');
      b.className = 'pick';
      const img = s.thumbnail ? Object.assign(document.createElement('img'), { src: s.thumbnail }) : Object.assign(document.createElement('div'), { className: 'noimg', textContent: 'no preview' });
      const kind = Object.assign(document.createElement('div'), { className: 'pkind', textContent: s.kind });
      const name = Object.assign(document.createElement('div'), { className: 'pname', textContent: s.name, title: s.name });
      b.append(img, kind, name);
      b.onclick = () => { done = true; dlg.close(); resolve(s); };
      grid.appendChild(b);
    }
    let done = false;
    dlg.addEventListener('close', () => { if (!done) resolve(null); }, { once: true });
    dlg.showModal();
  });
}

async function openStream(source) {
  await api.selectSource(source.id);
  try {
    return await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: { ideal: 60, max: 60 } }, audio: false });
  } catch (err) {
    console.warn('getDisplayMedia failed, trying legacy capture', err);
    return navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { mandatory: { chromeMediaSource: 'desktop', chromeMediaSourceId: source.id, maxWidth: 3840, maxHeight: 2160, maxFrameRate: 60 } },
    });
  }
}

function attachStream(scene, stream) {
  if (scene.stream && scene.stream !== stream) scene.stream.getTracks().forEach((t) => t.stop());
  scene.stream = stream;
  scene.ended = false;
  const track = stream.getVideoTracks()[0];
  if (track) {
    track.addEventListener('ended', () => {
      if (scene.stream !== stream) return;
      scene.ended = true;
      renderTile(scene);
      if (previewId === scene.id) previewStage.show({ ...scene }, { transition: 'cut' });
      // Safety net: never leave the audience with a dead picture.
      if (programId === scene.id) {
        take(cover().id, { transition: 'cut' });
        toast(`“${scene.name}” went away — projector switched back to the cover.`, true);
      } else {
        toast(`Source “${scene.name}” ended.`, true);
      }
      refreshPeekUsers(scene.id);
    });
  }
}

function refreshPeekUsers(captureId) {
  for (const s of scenes) {
    if (s.type !== 'desktop' || s.peekId !== captureId) continue;
    if (previewId === s.id) previewStage.show(snapshotOf(s), { transition: 'cut' });
    if (programId === s.id) { program = snapshotOf(s); programStage.show(program, { transition: 'cut' }); }
    renderTile(s);
  }
}

async function addCapture(existing) {
  try {
    const src = await pickSource();
    if (!src) return;
    const stream = await openStream(src);
    let scene = existing;
    if (!scene) scene = addScene({ id: uid(), type: 'capture', name: src.name || 'Screen share', fit: 'contain', bg: '#000000' }, { select: false });
    else if (!scene.name || scene.name === 'Capture') scene.name = src.name || scene.name;
    attachStream(scene, stream);
    renderTile(scene);
    setPreview(scene.id);
    refreshPeekUsers(scene.id);
    save();
  } catch (err) {
    console.error(err);
    toast(`Capture failed: ${err.message || err}`, true);
  }
}

// ---------------------------------------------------------------------------
// Rendering: grid, tiles, tally
// ---------------------------------------------------------------------------
const tileStages = new Map();

function renderGrid() {
  const grid = $('#sceneGrid');
  for (const st of tileStages.values()) st.destroy();
  tileStages.clear();
  grid.replaceChildren();
  scenes.forEach((s) => grid.appendChild(buildTile(s)));
  renderTally();
}

function tileThumbScene(s) {
  if (s.type === 'desktop') return snapshotOf(s);
  return { ...s, endsAt: undefined };
}

function buildTile(s) {
  const tile = document.createElement('div');
  tile.className = 'tile';
  tile.dataset.id = s.id;
  tile.draggable = true;
  const thumb = document.createElement('div');
  thumb.className = 'thumb';
  const meta = document.createElement('div');
  meta.className = 'meta';
  tile.append(thumb, meta);
  const st = createStage(thumb, { mode: 'thumb' });
  tileStages.set(s.id, st);
  fillTile(tile, s);

  tile.addEventListener('click', () => setPreview(s.id));
  tile.addEventListener('dblclick', () => { setPreview(s.id); take(s.id); });
  tile.addEventListener('dragstart', (e) => { tile.classList.add('dragging'); e.dataTransfer.setData('text/x-sm-scene', s.id); e.dataTransfer.effectAllowed = 'move'; });
  tile.addEventListener('dragend', () => tile.classList.remove('dragging'));
  tile.addEventListener('dragover', (e) => { if (e.dataTransfer.types.includes('text/x-sm-scene')) { e.preventDefault(); tile.classList.add('drop-before'); } });
  tile.addEventListener('dragleave', () => tile.classList.remove('drop-before'));
  tile.addEventListener('drop', (e) => {
    tile.classList.remove('drop-before');
    const from = e.dataTransfer.getData('text/x-sm-scene');
    if (!from || from === s.id) return;
    e.preventDefault(); e.stopPropagation();
    const moving = byId(from);
    if (!moving) return;
    scenes = scenes.filter((x) => x.id !== from);
    scenes.splice(scenes.indexOf(byId(s.id)), 0, moving);
    renderGrid();
    save();
  });
  return tile;
}

function fillTile(tile, s) {
  const st = tileStages.get(s.id);
  st.show(tileThumbScene(s), { transition: 'cut' });
  const meta = tile.querySelector('.meta');
  meta.replaceChildren();
  const idx = scenes.indexOf(s);
  if (idx < 9) meta.appendChild(Object.assign(document.createElement('span'), { className: 'key', textContent: String(idx + 1) }));
  meta.appendChild(Object.assign(document.createElement('span'), { className: 'name', textContent: s.name, title: `${s.name} — ${TYPE_LABEL[s.type] || s.type}` }));
  if (settings.coverId === s.id) meta.appendChild(Object.assign(document.createElement('span'), { className: 'star', textContent: '★', title: 'Cover scene' }));
}

function renderTile(s) {
  const tile = document.querySelector(`.tile[data-id="${CSS.escape(s.id)}"]`);
  if (tile) fillTile(tile, s);
}

function renderTally() {
  document.querySelectorAll('.tile').forEach((t) => {
    const id = t.dataset.id;
    t.classList.toggle('is-preview', id === previewId);
    t.classList.toggle('is-program', id === programId);
    t.querySelectorAll('.badge').forEach((b) => b.remove());
    if (id === programId) t.appendChild(Object.assign(document.createElement('span'), { className: 'badge live', textContent: 'LIVE' }));
    if (id === previewId) t.appendChild(Object.assign(document.createElement('span'), { className: 'badge next', textContent: 'NEXT' }));
  });
  const p = byId(previewId);
  $('#previewName').textContent = p ? p.name : '';
  $('#programName').textContent = program ? program.name : '';
  $('#blackBtn').classList.toggle('active', programId === 'black');
  $('#freezeBtn').classList.toggle('active', programId === '__freeze');
  $('#coverBtn').classList.toggle('active', programId === settings.coverId);
  $('#revealBtn').classList.toggle('active', program && program.type === 'desktop');
  const onAir = $('#onAir');
  const live = outputStage && displays.mode !== 'none';
  onAir.textContent = live ? 'ON AIR' : 'NO OUTPUT';
  onAir.classList.toggle('off', !live);
  renderLiveNote();
}

// ---------------------------------------------------------------------------
// Inspector
// ---------------------------------------------------------------------------
function field(label, input) {
  const f = document.createElement('label');
  f.className = 'field';
  f.append(Object.assign(document.createElement('span'), { textContent: label }), input);
  return f;
}
function textInput(s, key, { multiline = false, placeholder = '' } = {}) {
  const i = document.createElement(multiline ? 'textarea' : 'input');
  if (!multiline) i.type = 'text';
  i.value = s[key] ?? '';
  i.placeholder = placeholder;
  i.addEventListener('input', () => updateScene(s.id, { [key]: i.value }));
  return i;
}
function numberInput(s, key, { min = 0, max = 999, step = 1 } = {}) {
  const i = Object.assign(document.createElement('input'), { type: 'number', min, max, step, value: s[key] ?? 0 });
  i.addEventListener('input', () => { const v = parseFloat(i.value); if (!Number.isNaN(v)) updateScene(s.id, { [key]: Math.min(max, Math.max(min, v)) }); });
  return i;
}
function colorInput(s, key, fallback) {
  const i = Object.assign(document.createElement('input'), { type: 'color', value: s[key] || fallback });
  i.addEventListener('input', () => updateScene(s.id, { [key]: i.value }));
  const f = field(key === 'fg' ? 'Text color' : key === 'bg' ? 'Background' : 'Color', i);
  f.classList.add('color-field');
  return f;
}
function selectInput(s, key, options) {
  const sel = document.createElement('select');
  for (const [value, label] of options) sel.appendChild(Object.assign(document.createElement('option'), { value, textContent: label }));
  sel.value = s[key] ?? options[0][0];
  sel.addEventListener('change', () => updateScene(s.id, { [key]: sel.value === '' ? null : sel.value }));
  return sel;
}
function checkInput(s, key, label) {
  const l = document.createElement('label');
  l.className = 'toggle';
  const i = Object.assign(document.createElement('input'), { type: 'checkbox', checked: !!s[key] });
  i.addEventListener('change', () => updateScene(s.id, { [key]: i.checked }));
  l.append(i, Object.assign(document.createElement('span'), { textContent: label }));
  return l;
}
function button(label, onClick, cls = '') {
  return Object.assign(document.createElement('button'), { className: `btn ${cls}`, textContent: label, onclick: onClick });
}
function note(text, cls = '') {
  return Object.assign(document.createElement('div'), { className: `note ${cls}`, textContent: text });
}
const row = (...kids) => { const r = document.createElement('div'); r.className = 'row'; r.append(...kids); return r; };
const FIT = [['contain', 'Fit (letterbox)'], ['cover', 'Fill (crop)'], ['fill', 'Stretch']];

function renderInspector() {
  const box = $('#inspector');
  box.replaceChildren();
  const s = byId(previewId);
  if (!s) { box.appendChild(note('Select a scene.')); return; }

  box.appendChild(Object.assign(document.createElement('h3'), { textContent: 'Inspector' }));
  box.appendChild(Object.assign(document.createElement('div'), { className: 'type', textContent: TYPE_LABEL[s.type] || s.type }));
  box.appendChild(Object.assign(document.createElement('div'), { id: 'liveNote' }));
  if (!BUILTIN.has(s.id)) box.appendChild(field('Name', textInput(s, 'name')));

  switch (s.type) {
    case 'desktop': {
      box.appendChild(note('Takes the cover away so the projector shows your real desktop — full resolution, presenter view, videos, everything. Put your slideshow on the projector first; it stays hidden until you TAKE this.'));
      const caps = scenes.filter((x) => x.type === 'capture');
      box.appendChild(field('Peek source (shown in the monitors)', selectInput(s, 'peekId', [['', '— none —'], ...caps.map((c) => [c.id, c.name])])));
      box.appendChild(note(caps.length
        ? 'Pick a capture of your slideshow window (or of the projector screen) to see what\'s behind the curtain before you reveal it.'
        : 'Tip: add a “Window / Screen” source of your slideshow window, then pick it here to peek behind the curtain.'));
      if (!caps.length) box.appendChild(button('+ Add window / screen source', () => addCapture()));
      break;
    }
    case 'black':
      box.appendChild(note('Pure black. Press B at any time for an instant blackout and B again to come back.'));
      break;
    case 'curtain':
      box.appendChild(field('Title', textInput(s, 'title', { multiline: true })));
      box.appendChild(field('Subtitle', textInput(s, 'subtitle')));
      box.appendChild(colorInput(s, 'color', '#8f1020'));
      break;
    case 'text':
      box.appendChild(field('Title', textInput(s, 'title', { multiline: true })));
      box.appendChild(field('Subtitle', textInput(s, 'subtitle', { multiline: true })));
      box.appendChild(row(colorInput(s, 'fg', '#ffffff'), colorInput(s, 'bg', '#000000')));
      break;
    case 'countdown':
      box.appendChild(field('Minutes', numberInput(s, 'minutes', { min: 0, max: 600, step: 0.5 })));
      box.appendChild(field('Title', textInput(s, 'title')));
      box.appendChild(field('Text when it reaches 0', textInput(s, 'doneText')));
      box.appendChild(row(colorInput(s, 'fg', '#ffffff'), colorInput(s, 'bg', '#000000')));
      box.appendChild(note('The countdown starts the moment it goes live. Taking it again restarts it.'));
      break;
    case 'color':
      box.appendChild(colorInput(s, 'color', '#000000'));
      break;
    case 'pattern':
      box.appendChild(note('Grid, color bars and corner markers to focus and align the beamer. The number shows the real output resolution.'));
      break;
    case 'image':
    case 'video': {
      const p = Object.assign(document.createElement('div'), { className: 'path', textContent: s.path || '(embedded)' });
      box.appendChild(field('File', p));
      if (s.missing) box.appendChild(note('⚠ File not found — replace it or it will show nothing.', 'live'));
      box.appendChild(field('Scaling', selectInput(s, 'fit', FIT)));
      box.appendChild(colorInput(s, 'bg', '#000000'));
      if (s.type === 'video') {
        box.appendChild(checkInput(s, 'loop', 'Loop'));
        box.appendChild(checkInput(s, 'audio', 'Play sound on the projector output'));
      }
      box.appendChild(button('Replace file…', async () => {
        const paths = await api.pickMedia();
        if (!paths.length) return;
        const np = paths[0];
        const type = VIDEO_EXT.test(np) ? 'video' : IMAGE_EXT.test(np) ? 'image' : null;
        if (!type) { toast('Not an image or video.', true); return; }
        updateScene(s.id, { path: np, type, missing: false, loop: s.loop ?? true });
        renderInspector();
      }));
      break;
    }
    case 'capture': {
      box.appendChild(field('Scaling', selectInput(s, 'fit', FIT)));
      if (!s.stream || s.ended) box.appendChild(note(s.ended ? 'Signal lost — the window was closed or sharing was stopped.' : 'No signal yet (sources must be re-picked after a restart).', 'live'));
      box.appendChild(button(s.stream && !s.ended ? 'Change source…' : 'Re-pick source…', () => addCapture(s), 'primary'));
      box.appendChild(note('Shows only this window/screen on the projector — notifications and other windows stay private.'));
      break;
    }
    default: break;
  }

  const actions = document.createElement('div');
  actions.className = 'btn-row';
  if (settings.coverId !== s.id && s.type !== 'desktop' && s.type !== 'capture') {
    actions.appendChild(button('★ Use as cover', () => { settings.coverId = s.id; renderGrid(); renderInspector(); save(); }));
  }
  if (!BUILTIN.has(s.id) && s.type !== 'capture') actions.appendChild(button('Duplicate', () => duplicateScene(s.id)));
  if (!BUILTIN.has(s.id)) actions.appendChild(button('Delete', () => deleteScene(s.id), 'danger'));
  if (actions.children.length) box.appendChild(actions);
  renderLiveNote();
}

function renderLiveNote() {
  const holder = document.getElementById('liveNote');
  if (!holder) return;
  holder.replaceChildren();
  if (previewId && previewId === programId) {
    holder.appendChild(note('This scene is live. Edits show in the preview only — press TAKE to push them to the projector.', 'live'));
  }
}

// ---------------------------------------------------------------------------
// Displays / status
// ---------------------------------------------------------------------------
function renderStatus() {
  const chip = $('#projStatus');
  const proj = displays.displays.find((d) => d.id === displays.projectorId);
  chip.className = 'chip';
  if (displays.mode === 'projector') { chip.classList.add('ok'); chip.textContent = '● Projector covered'; chip.title = proj ? proj.label : ''; }
  else if (displays.mode === 'test') { chip.classList.add('test'); chip.textContent = '● Test window'; chip.title = 'No projector — output runs in a window'; }
  else { chip.classList.add('none'); chip.textContent = '○ No projector'; chip.title = ''; }

  const sel = $('#displaySelect');
  sel.replaceChildren();
  const others = displays.displays.filter((d) => !d.controller);
  if (!others.length) {
    sel.appendChild(Object.assign(document.createElement('option'), { textContent: 'No second display' }));
    sel.disabled = true;
  } else {
    sel.disabled = false;
    others.forEach((d) => sel.appendChild(Object.assign(document.createElement('option'), { value: String(d.id), textContent: `Projector: ${d.label}` })));
    sel.value = String(displays.projectorId);
  }

  const banner = $('#banner');
  banner.replaceChildren();
  if (displays.mode === 'none') {
    banner.hidden = false;
    banner.append(
      Object.assign(document.createElement('span'), { textContent: '🔌 No projector detected. Plug it in (in “extend” mode, not mirror) — it will be covered automatically. Want to rehearse first?' }),
      button('Open test window', () => setTestMode(true)),
    );
  } else if (!outWin && displays.mode !== 'none') {
    banner.hidden = false;
    banner.append(
      Object.assign(document.createElement('span'), { textContent: 'The output window was closed.' }),
      button('Re-open output', () => reconcileOutput()),
    );
  } else {
    banner.hidden = true;
  }
  renderTally();
}

function setTestMode(on) {
  settings.testMode = on;
  $('#testMode').checked = on;
  saveNow();
}

function onDisplays(info) {
  displays = info;
  reconcileOutput();
  renderStatus();
}

// ---------------------------------------------------------------------------
// Clock + presentation timer
// ---------------------------------------------------------------------------
const sw = { running: false, startedAt: 0, acc: 0 };
const swElapsed = () => sw.acc + (sw.running ? Date.now() - sw.startedAt : 0);
function swStart() { if (!sw.running) { sw.running = true; sw.startedAt = Date.now(); } renderClock(); }
function swPause() { if (sw.running) { sw.acc = swElapsed(); sw.running = false; } renderClock(); }
function renderClock() {
  const now = new Date();
  $('#clock').textContent = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const s = $('#stopwatch');
  s.textContent = formatDuration(swElapsed());
  s.classList.toggle('running', sw.running);
  $('#swToggle').textContent = sw.running ? '❚❚' : '▶';
}

// ---------------------------------------------------------------------------
// Toast
// ---------------------------------------------------------------------------
let toastTimer = null;
function toast(msg, warn = false) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = `toast${warn ? ' warn' : ''}`;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 4200);
}

// ---------------------------------------------------------------------------
// Transition controls
// ---------------------------------------------------------------------------
function renderTransition() {
  document.querySelectorAll('.seg button').forEach((b) => b.classList.toggle('active', b.dataset.tr === settings.transition));
  $('#duration').value = settings.duration;
  $('#durationLabel').textContent = `${(settings.duration / 1000).toFixed(1)}s`;
  $('.dur').classList.toggle('disabled', settings.transition === 'cut');
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------
function wire() {
  $('#takeBtn').onclick = takePreview;
  $('#blackBtn').onclick = toggleBlackout;
  $('#freezeBtn').onclick = toggleFreeze;
  $('#coverBtn').onclick = () => take(cover().id);
  $('#revealBtn').onclick = () => take('desktop');
  document.querySelectorAll('.seg button').forEach((b) => { b.onclick = () => { settings.transition = b.dataset.tr; renderTransition(); save(); }; });
  $('#duration').oninput = (e) => { settings.duration = Number(e.target.value); renderTransition(); save(); };

  $('#identifyBtn').onclick = () => api.identifyDisplays();
  $('#displaySelect').onchange = (e) => { settings.projectorDisplayId = Number(e.target.value); saveNow(); };
  $('#testMode').onchange = (e) => setTestMode(e.target.checked);
  $('#keepAwake').onchange = (e) => { settings.keepAwake = e.target.checked; saveNow(); };
  $('#autoTimer').onchange = (e) => { settings.autoTimer = e.target.checked; save(); };

  $('#swToggle').onclick = () => (sw.running ? swPause() : swStart());
  $('#swReset').onclick = () => { sw.acc = 0; sw.startedAt = Date.now(); renderClock(); };
  $('#helpBtn').onclick = () => $('#helpDlg').showModal();
  document.querySelectorAll('[data-close]').forEach((b) => { b.onclick = () => b.closest('dialog').close(); });

  document.querySelectorAll('[data-add]').forEach((b) => {
    b.onclick = async () => {
      const kind = b.dataset.add;
      if (kind === 'media') addMediaPaths(await api.pickMedia());
      else if (kind === 'capture') addCapture();
      else addScene(NEW_SCENE[kind]());
    };
  });

  // file drag & drop
  let dragDepth = 0;
  const isFiles = (e) => e.dataTransfer && [...e.dataTransfer.types].includes('Files');
  document.addEventListener('dragenter', (e) => { if (isFiles(e)) { dragDepth++; $('#dropHint').hidden = false; } });
  document.addEventListener('dragleave', (e) => { if (isFiles(e) && --dragDepth <= 0) { dragDepth = 0; $('#dropHint').hidden = true; } });
  document.addEventListener('dragover', (e) => { if (isFiles(e)) e.preventDefault(); });
  document.addEventListener('drop', (e) => {
    if (!isFiles(e)) return;
    e.preventDefault();
    dragDepth = 0; $('#dropHint').hidden = true;
    addMediaPaths([...e.dataTransfer.files].map((f) => api.pathForFile(f)).filter(Boolean));
  });

  // keyboard
  document.addEventListener('keydown', (e) => {
    const t = e.target;
    if (t instanceof Element && (t.matches('input:not([type=checkbox]):not([type=range]), textarea, select') || t.isContentEditable)) return;
    if (document.querySelector('dialog[open]')) return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const k = e.key.toLowerCase();
    const digit = /^Digit([1-9])$/.exec(e.code);
    if (k === ' ' || k === 'enter') { e.preventDefault(); takePreview(); }
    else if (digit) {
      const s = scenes[Number(digit[1]) - 1];
      if (!s) return;
      e.preventDefault();
      if (e.shiftKey) { setPreview(s.id); take(s.id); } else setPreview(s.id);
    }
    else if (k === 'b') toggleBlackout();
    else if (k === 'f') toggleFreeze();
    else if (k === 'c') take(cover().id);
    else if (k === 'd') take('desktop');
    else if (k === 't') { settings.transition = settings.transition === 'cut' ? 'fade' : 'cut'; renderTransition(); save(); }
    else if (k === '?') $('#helpDlg').showModal();
  });

  api.on('displays:changed', onDisplays);
  api.on('output:failed', (msg) => { toast(msg, true); renderStatus(); });
  api.on('output:warning', (msg) => toast(msg, true));
  api.on('output:userClosed', () => setTestMode(false)); // you closed the rehearsal window
  api.on('hotkey', (action) => {
    if (action === 'blackout') toggleBlackout();
    else if (action === 'cover') take(cover().id, { transition: 'cut' });
    else if (action === 'take') takePreview();
  });

  // If this page goes away, the output goes with it (desktop shows normally).
  window.addEventListener('beforeunload', () => closeOutput());
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
async function boot() {
  const init = await api.loadState();
  const saved = init.saved;
  if (saved && Array.isArray(saved.scenes) && saved.scenes.length) {
    scenes = saved.scenes.filter((s) => s && s.id && s.type);
    // built-ins can't be lost
    if (!byId('desktop')) scenes.splice(1, 0, DEFAULT_SCENES()[1]);
    if (!byId('black')) scenes.splice(2, 0, DEFAULT_SCENES()[2]);
  } else {
    scenes = DEFAULT_SCENES();
  }
  settings = { ...DEFAULT_SETTINGS, ...(saved && saved.settings) };
  displays = init.displays;

  await Promise.all(scenes.filter((s) => s.path).map(async (s) => { s.missing = !(await api.mediaExists(s.path)); }));

  previewStage = createStage($('#previewStage'), { mode: 'monitor' });
  programStage = createStage($('#programStage'), { mode: 'monitor' });

  $('#testMode').checked = !!settings.testMode;
  $('#keepAwake').checked = !!settings.keepAwake;
  $('#autoTimer').checked = !!settings.autoTimer;

  wire();
  renderGrid();
  renderTransition();

  // On start the projector shows the cover. Always.
  airSnapshot(snapshotOf(cover()), cover().id, { transition: 'cut' });
  setPreview(byId('desktop') ? 'desktop' : scenes[0].id);

  reconcileOutput();
  renderStatus();
  renderClock();
  setInterval(renderClock, 500);
}

boot().catch((err) => {
  console.error(err);
  document.body.insertAdjacentHTML('afterbegin', `<pre style="color:#f88;padding:12px">Startup error: ${String(err && err.stack || err).replace(/</g, '&lt;')}</pre>`);
});

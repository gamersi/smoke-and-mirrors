// Scene renderer shared by the projector output, the preview/program monitors and the tiles.
// All DOM is created through root.ownerDocument, so the control page can drive the output
// window's document directly (same origin, same JS world).

// served from the same origin as the UI so frames can be grabbed for Freeze
export const mediaUrl = (p) => 'sm://app/__media/' + encodeURIComponent(p);

const fmt = (ms) => {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return h ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
};
export const formatDuration = fmt;

function el(doc, tag, cls, text) {
  const e = doc.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

/**
 * mode: 'output'  – real projector (desktop scene = transparent, audio allowed)
 *       'monitor' – preview/program monitors (desktop scene = placeholder / peek capture)
 *       'thumb'   – scene tiles (static where possible)
 */
function buildScene(doc, scene, mode) {
  const disposers = [];
  const root = el(doc, 'div', `scene scene-${scene.type}`);
  const bg = scene.bg || '#000000';
  root.style.background = bg;

  // Problems are only ever shown in the monitors — the audience just sees the background.
  const markBroken = (msg) => {
    if (mode === 'output') return;
    root.classList.add('broken');
    root.dataset.msg = msg;
  };

  const addVideo = (setup) => {
    const v = el(doc, 'video', 'fill');
    v.muted = true; v.autoplay = true; v.playsInline = true;
    setup(v);
    root.appendChild(v);
    const p = v.play(); if (p && p.catch) p.catch(() => {});
    disposers.push(() => { try { v.pause(); v.srcObject = null; v.removeAttribute('src'); v.load(); } catch { /* gone */ } });
    return v;
  };

  switch (scene.type) {
    case 'black':
      root.style.background = '#000';
      break;

    case 'color':
      root.style.background = scene.color || bg;
      break;

    case 'image': {
      const img = el(doc, 'img', 'fill');
      img.draggable = false;
      img.style.objectFit = scene.fit || 'contain';
      img.src = scene.src || mediaUrl(scene.path);
      img.onerror = () => { img.remove(); markBroken('File not found'); };
      root.appendChild(img);
      break;
    }

    case 'video': {
      addVideo((v) => {
        v.loop = scene.loop !== false;
        v.style.objectFit = scene.fit || 'contain';
        if (mode === 'output' && scene.audio) v.muted = false;
        v.src = mediaUrl(scene.path);
        v.onerror = () => { v.remove(); markBroken('File not found'); };
      });
      break;
    }

    case 'text': {
      root.style.color = scene.fg || '#ffffff';
      const box = el(doc, 'div', 'text-box');
      box.appendChild(el(doc, 'div', 'text-title', scene.title || ''));
      if (scene.subtitle) box.appendChild(el(doc, 'div', 'text-sub', scene.subtitle));
      root.appendChild(box);
      break;
    }

    case 'countdown': {
      root.style.color = scene.fg || '#ffffff';
      const box = el(doc, 'div', 'text-box');
      if (scene.title) box.appendChild(el(doc, 'div', 'text-sub', scene.title));
      const digits = el(doc, 'div', 'count-digits');
      box.appendChild(digits);
      const after = el(doc, 'div', 'text-sub count-after');
      box.appendChild(after);
      root.appendChild(box);
      const duration = Math.max(0, Number(scene.minutes) || 0) * 60000;
      const tick = () => {
        const left = scene.endsAt ? scene.endsAt - Date.now() : duration;
        digits.textContent = fmt(left);
        const done = scene.endsAt && left <= 0;
        root.classList.toggle('done', !!done);
        after.textContent = done ? (scene.doneText || '') : '';
      };
      tick();
      if (scene.endsAt && mode !== 'thumb') {
        const t = setInterval(tick, 200);
        disposers.push(() => clearInterval(t));
      }
      break;
    }

    case 'pattern': {
      root.classList.add('pattern');
      const bars = el(doc, 'div', 'pattern-bars');
      ['#fff', '#ff0', '#0ff', '#0f0', '#f0f', '#f00', '#00f', '#000'].forEach((c) => {
        const b = el(doc, 'div'); b.style.background = c; bars.appendChild(b);
      });
      root.appendChild(el(doc, 'div', 'pattern-grid'));
      root.appendChild(bars);
      root.appendChild(el(doc, 'div', 'pattern-circle'));
      ['tl', 'tr', 'bl', 'br'].forEach((c) => root.appendChild(el(doc, 'div', `pattern-corner ${c}`)));
      const info = el(doc, 'div', 'pattern-info');
      root.appendChild(info);
      const win = doc.defaultView;
      const upd = () => {
        const r = root.getBoundingClientRect();
        const dpr = (win && win.devicePixelRatio) || 1;
        info.textContent = `${Math.round(r.width * dpr)} × ${Math.round(r.height * dpr)}`;
      };
      requestAnimationFrame(upd);
      break;
    }

    case 'curtain': {
      root.classList.add('curtain');
      if (scene.color) root.style.setProperty('--velvet', scene.color);
      root.appendChild(el(doc, 'div', 'curtain-half left'));
      root.appendChild(el(doc, 'div', 'curtain-half right'));
      root.appendChild(el(doc, 'div', 'curtain-valance'));
      root.appendChild(el(doc, 'div', 'curtain-spot'));
      const box = el(doc, 'div', 'curtain-text');
      box.appendChild(el(doc, 'div', 'text-title', scene.title || ''));
      if (scene.subtitle) box.appendChild(el(doc, 'div', 'text-sub', scene.subtitle));
      root.appendChild(box);
      break;
    }

    case 'capture': {
      if (scene.stream && !scene.ended) {
        addVideo((v) => { v.srcObject = scene.stream; v.style.objectFit = scene.fit || 'contain'; });
      } else {
        markBroken(scene.ended ? 'Signal lost' : 'No signal — re-pick source');
      }
      break;
    }

    case 'desktop': {
      if (mode === 'output') {
        root.style.background = 'transparent';
      } else {
        root.classList.add('desktop-ph');
        if (scene.peekStream) {
          addVideo((v) => { v.srcObject = scene.peekStream; v.style.objectFit = 'contain'; });
        }
        root.appendChild(el(doc, 'div', 'desktop-label', scene.peekStream ? 'DESKTOP (peek)' : 'YOUR DESKTOP'));
      }
      break;
    }

    default:
      markBroken(`Unknown scene: ${scene.type}`);
  }

  return { el: root, dispose: () => disposers.forEach((d) => d()) };
}

export function createStage(root, { mode = 'monitor' } = {}) {
  const doc = root.ownerDocument;
  root.classList.add('stage', `stage-${mode}`);
  let layers = [];
  let current = null;

  const drop = (list) => {
    for (const l of list) {
      l.built.dispose();
      l.layer.remove();
    }
    layers = layers.filter((l) => !list.includes(l));
  };

  function show(scene, { transition = 'cut', duration = 0 } = {}) {
    const built = buildScene(doc, scene, mode);
    const layer = el(doc, 'div', 'layer');
    layer.appendChild(built.el);
    const prev = layers.slice();
    const entry = { layer, built };
    layers.push(entry);
    root.appendChild(layer);
    current = scene;

    if (transition === 'fade' && duration > 0 && prev.length) {
      const passthrough = mode === 'output' && scene.type === 'desktop';
      const ease = `opacity ${duration}ms ease-in-out`;
      if (passthrough) {
        // fade the old picture out to reveal the (real) desktop behind the window
        prev.forEach((p) => { p.layer.style.transition = ease; p.layer.style.opacity = '0'; });
      } else {
        // crossfade: new picture fades in on top of the old one
        layer.style.opacity = '0';
        layer.getBoundingClientRect();
        layer.style.transition = ease;
        layer.style.opacity = '1';
      }
      setTimeout(() => drop(prev), duration + 60);
    } else {
      drop(prev);
    }
  }

  /** Grab the currently visible frame (image/video/capture) as a data URL, or null. */
  function snapshot() {
    const top = layers[layers.length - 1];
    if (!top) return null;
    const media = top.layer.querySelector('video, img');
    if (!media) return null;
    const w = media.videoWidth || media.naturalWidth;
    const h = media.videoHeight || media.naturalHeight;
    if (!w || !h) return null;
    const c = doc.createElement('canvas');
    c.width = w; c.height = h;
    try {
      c.getContext('2d').drawImage(media, 0, 0, w, h);
      return c.toDataURL('image/jpeg', 0.92);
    } catch {
      return null;
    }
  }

  function destroy() { drop(layers.slice()); }

  return { show, snapshot, destroy, get current() { return current; } };
}

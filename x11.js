'use strict';
/*
 * A tiny, dependency-free X11 client with exactly one job: mark OUR OWN output window as
 * "override-redirect" before it is shown.
 *
 * Why: window managers (KWin included) stack a *focused* fullscreen window — e.g. your slideshow
 * once you click into it — above every "always on top" window, so it would pop through the
 * curtain. Override-redirect windows are not managed by the window manager at all and are
 * stacked above managed windows (like menus or lock screens). We then place it ourselves.
 *
 * It only ever touches the window id we pass in (our own window) and keeps no connection open.
 */
const net = require('node:net');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const pad4 = (n) => (4 - (n % 4)) % 4;

function displayNumber() {
  const m = /^(?:unix)?:(\d+)(?:\.\d+)?$/.exec(process.env.DISPLAY || '');
  return m ? Number(m[1]) : null; // only local displays
}

function readCookie(num) {
  const file = process.env.XAUTHORITY || path.join(os.homedir(), '.Xauthority');
  let buf;
  try { buf = fs.readFileSync(file); } catch { return null; }
  const host = os.hostname();
  let o = 0;
  let fallback = null;
  const u16 = () => { const v = buf.readUInt16BE(o); o += 2; return v; };
  const str = () => { const l = u16(); const s = buf.subarray(o, o + l); o += l; return s; };
  try {
    while (o + 2 <= buf.length) {
      const family = u16();
      const addr = str().toString();
      const number = str().toString();
      const name = str().toString();
      const data = str();
      if (name !== 'MIT-MAGIC-COOKIE-1') continue;
      if (number !== '' && number !== String(num)) continue;
      // FamilyLocal = 256 (matching hostname), FamilyWild = 65535
      if ((family === 256 && addr === host) || family === 65535) return { name, data };
      if (!fallback) fallback = { name, data };
    }
  } catch { /* truncated file */ }
  return fallback;
}

/** Set override-redirect on an (unmapped) window. Resolves true on success, false otherwise. */
function setOverrideRedirect(xid, on = true, timeoutMs = 2000) {
  return new Promise((resolve) => {
    const num = displayNumber();
    if (process.platform !== 'linux' || num == null || !xid) { resolve(false); return; }

    let done = false;
    const finish = (ok) => { if (done) return; done = true; clearTimeout(timer); sock.destroy(); resolve(ok); };
    const timer = setTimeout(() => finish(false), timeoutMs);
    const sock = net.createConnection(`/tmp/.X11-unix/X${num}`);
    sock.on('error', () => finish(false));

    const cookie = readCookie(num);
    const name = Buffer.from(cookie ? cookie.name : '');
    const data = cookie ? cookie.data : Buffer.alloc(0);

    sock.on('connect', () => {
      const hdr = Buffer.alloc(12);
      hdr.write('l', 0);              // little-endian
      hdr.writeUInt16LE(11, 2);       // protocol 11.0
      hdr.writeUInt16LE(0, 4);
      hdr.writeUInt16LE(name.length, 6);
      hdr.writeUInt16LE(data.length, 8);
      sock.write(Buffer.concat([hdr, name, Buffer.alloc(pad4(name.length)), data, Buffer.alloc(pad4(data.length))]));
    });

    let buf = Buffer.alloc(0);
    let setupDone = false;
    let failed = false;
    sock.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      if (!setupDone) {
        if (buf.length < 8) return;
        if (buf[0] !== 1) { finish(false); return; } // connection refused / auth failed
        const total = 8 + buf.readUInt16LE(6) * 4;
        if (buf.length < total) return;
        buf = buf.subarray(total);
        setupDone = true;

        // ChangeWindowAttributes(window, CWOverrideRedirect = 1<<9, value)
        const cwa = Buffer.alloc(16);
        cwa.writeUInt8(2, 0);
        cwa.writeUInt16LE(4, 2);
        cwa.writeUInt32LE(xid >>> 0, 4);
        cwa.writeUInt32LE(1 << 9, 8);
        cwa.writeUInt32LE(on ? 1 : 0, 12);
        // GetInputFocus: a round trip, so we know the request above was processed
        const sync = Buffer.from([43, 0, 1, 0]);
        sock.write(Buffer.concat([cwa, sync]));
      }
      while (buf.length >= 32) {
        const kind = buf[0];
        const len = kind === 1 ? 32 + buf.readUInt32LE(4) * 4 : 32;
        if (buf.length < len) return;
        buf = buf.subarray(len);
        if (kind === 0) failed = true;        // X error (e.g. bad window)
        else if (kind === 1) { finish(!failed); return; } // our sync reply
      }
    });
  });
}

function xidOf(win) {
  try {
    const h = win.getNativeWindowHandle();
    return h.length >= 8 ? Number(h.readBigUInt64LE(0)) : h.readUInt32LE(0);
  } catch {
    return 0;
  }
}

module.exports = { setOverrideRedirect, xidOf };

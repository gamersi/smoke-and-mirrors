# 🎩 Smoke & Mirrors

*Pay no attention to the laptop behind the curtain.*

Your audience doesn't need to watch you hunt for the right window, type a password, close
Slack or fight with presenter mode. While Smoke & Mirrors runs, the projector shows a **cover**:
a theatre curtain, your logo, a GIF, a countdown, or plain black. You set everything up
behind it, check it in the preview, and press **TAKE**.

```
 ┌──────────── your laptop ─────────────┐        ┌────────── projector ──────────┐
 │  PREVIEW (next)  [TAKE]  PROGRAM (live)│  ───▶ │   🎭  The show starts soon    │
 │  scenes · inspector · timers         │        │   (your messy desktop hides   │
 └──────────────────────────────────────┘        │    behind this)               │
                                                 └───────────────────────────────┘
```

## Run it

```sh
./bin/smoke-and-mirrors          # or: npm start
```

It uses the system `electron` (Arch: `pacman -S electron`). To bundle your own copy instead,
run `npm install`. To get a menu entry, copy `smoke-and-mirrors.desktop` to
`~/.local/share/applications/`. That's optional and something you do yourself; the app never
installs anything.

Keep the projector in **extend** mode (not mirror). Smoke & Mirrors covers it automatically as
soon as it starts or the projector is plugged in.

## 🛟 Safety: when the app isn't running, nothing changes

- It **never changes display settings**: no xrandr, no kscreen, no mirroring changes. It installs
  no autostart entries or services, and the only file it writes is its own `state.json` in
  `~/.config/Smoke & Mirrors/`.
- Everything the audience sees is **one window** owned by the app. If the app quits, crashes or is
  `kill -9`'d, that window disappears with it and the projector shows your normal desktop.
  (Tested with `kill -9`.)
- **Unplug the projector** and the output window is destroyed at once, so it can't slide onto
  your laptop screen. Plug it back in and the app covers it again.
- The output is **never allowed onto the controller's screen**. After every placement the app
  checks where the window manager actually put it, retries, and gives up (back to normal desktop)
  rather than cover your screen.
- **The curtain stays on top of your slideshow**, even after you click into it. Window managers
  normally let a *focused* fullscreen app jump above "always on top" windows. On X11/XWayland the
  output window is made *override-redirect*, the mechanism menus and lock screens use, so the
  window manager stacks it above everything (`x11.js`, which only touches the app's own window).
- If the controller hangs, the output is removed and the projector shows the normal desktop.
- If a live window capture disappears (window closed, sharing stopped), the projector **falls back
  to the cover**. The audience never sees "no signal" or error placeholders.
- "Keep awake" blocks screen sleep only while the app runs. The block is released on exit.

## Features

| | |
|---|---|
| **Preview / Program / TAKE** | Control-room workflow. Load the next scene into preview (green), push it to the projector (red) with a cut or crossfade. |
| **Reveal desktop** | Fades the cover away and shows your real projector screen at full quality. Presenter view, video and everything else work as usual. |
| **Peek behind the curtain** | Add a *Window / Screen* source of your slideshow window and select it on the Reveal scene. Window captures keep working while the window is hidden behind the cover, so you can check it in the monitors before revealing. |
| **Mirror a single window** | TAKE a window source to show only that window on the projector. Notifications and other windows stay private. |
| **Blackout** `B` | Instant black. Press again to return to exactly what was live. |
| **Freeze** `F` | Freezes the current frame while you fiddle underneath. Press again to unfreeze. Works on videos, captures, and the desktop when it has a peek source. |
| **Covers** | Animated theatre curtain, images, **GIFs**, looping videos (optional sound), text cards, solid colors. ★ marks the default cover, used on start and as the safety fallback. |
| **Countdown** | Starts when it goes live ("Starting in 04:59" → "Let's go!"). |
| **Test pattern** | Grid, color bars and corner markers to focus and align the beamer. It also shows the real output resolution. |
| **Identify** | Flashes a big number and role on every display. |
| **Test window** | No projector at hand? Rehearse with the output in a small floating window. |
| **Presentation timer + clock** | Starts automatically on the first reveal (optional). |
| **Hot keys** | `Space` take · `1–9` preview · `Shift+1–9` take directly · `B` `F` `C` `D` · `T` cut/fade. Global: `Ctrl+Alt+B` blackout, `Ctrl+Alt+C` cover, `Ctrl+Alt+Space` take.* |
| **Drag & drop** | Drop images, GIFs and videos anywhere to add them. Drag tiles to reorder. |

\* On Wayland, global shortcuts depend on the compositor and may only work while an app window is focused.

## Typical show

1. Plug in the projector and start the app. The audience sees the curtain.
2. Drag your slides onto the projector and start the slideshow. It stays behind the curtain.
3. *(optional)* **+ Window / Screen** → pick the slideshow window, then select it as *Peek source*
   on the **Reveal desktop** scene. You now see your slides in the monitors.
4. Preview **Reveal desktop** and press `Space`. The curtain fades out and you're live.
5. Q&A, a demo, or a broken video? Press `B` (blackout) or `C` (back to the cover), fix it, then press `Space`.

## How it works (for the curious)

- `main.js` handles displays, window placement and the safety guards. It also serves the UI and
  your media over a private `sm://` scheme.
- `ui/control.*` is the controller. It opens the projector window itself (`window.open`), so both
  pages share one JS world. Live captures are handed straight to the projector with no copying and
  no second permission prompt.
- `ui/stage.js` renders scenes. One renderer is used for the projector, both monitors and the scene
  tiles, so the preview shows what the audience will see.
- On Wayland the app runs through XWayland (`--ozone-platform=x11`, this process only), because
  Wayland doesn't let apps choose which monitor a window goes on. Screen capture still goes
  through the normal desktop portal dialog. Set `SM_NATIVE_WAYLAND=1` to opt out.

# Media Tab Controller — Chromium Extension (Brave / Chrome / Edge)

Control media playback in any background tab without switching focus.
Built for use with ZMK keyboards (Cyboard Imprint).

## Features

| Command         | Default Shortcut  | Behavior                               |
|-----------------|-------------------|----------------------------------------|
| Seek Backward   | Alt+Shift+9       | Rewind 5 seconds silently              |
| Play / Pause    | Alt+Shift+0       | Toggle playback silently               |
| Seek Forward    | Alt+Shift+8       | Fast-forward 5 seconds silently        |
| Focus Media Tab | Alt+Shift+7       | Switch to the tab playing media         |
| Speed Down      | *(set manually)*  | Decrease playback speed by 0.25x       |
| Speed Up        | *(set manually)*  | Increase playback speed by 0.25x       |
| Quality Max     | *(set manually)*  | Force highest available resolution      |
| Quality Cycle   | *(set manually)*  | Cycle: Auto → 1080p → 720p → ... → Auto|

Brave limits extensions to 4 pre-configured shortcuts. Speed and quality controls
must be assigned manually at `brave://extensions/shortcuts` after installation.

- **Silent control**: play/pause and seeking work without stealing focus from your current window.
- **Smart tab tracking**: remembers the last media tab even after you pause it, so you can resume without hunting for it.
- **Idle content script**: `content.js` is loaded in every page (all frames) but does nothing until a shortcut is pressed — it only acts as a fallback when direct injection can't reach the media element.

## Installation

1. Open your browser's extensions page:
   - **Brave**: `brave://extensions/`
   - **Chrome**: `chrome://extensions/`
   - **Edge**: `edge://extensions/`
2. Enable **Developer mode** (toggle in the top-right corner)
3. Click **Load unpacked**
4. Select the `media-control-extension` folder
5. Configure shortcuts (see below)

## Customizing Shortcuts

Go to your browser's extension shortcuts page:
   - **Brave**: `brave://extensions/shortcuts`
   - **Chrome**: `chrome://extensions/shortcuts`
   - **Edge**: `edge://extensions/shortcuts`

Each command has a dropdown to set its scope:

- **In Browser**: shortcut works only when the browser is focused
- **Global**: shortcut works from any application

Set all four commands to **Global** if you want them to work while you're in
VS Code, a terminal, or any other app.

## ZMK Keymap Bindings

In your ZMK keymap, bind the matching key combos on a layer. For example,
if you keep the default shortcuts, on Layer 1:

```dts
// Example: media keys on a layer
&kp LA(LS(N7))      // Alt+Shift+7  → Focus media tab
&kp LA(LS(N8))      // Alt+Shift+8  → Seek forward 5s
&kp LA(LS(N9))      // Alt+Shift+9  → Seek back 5s
&kp LA(LS(N0))      // Alt+Shift+0  → Play/Pause
// Speed controls: assign shortcuts at brave://extensions/shortcuts, then match here
// &kp LA(LS(COMMA))   // Speed down (example)
// &kp LA(LS(DOT))     // Speed up (example)
// Quality controls: same — assign in Brave, then match in ZMK
// &kp LA(LS(N5))      // Quality max (example)
// &kp LA(LS(N4))      // Quality cycle (example)
```

Or you can change the Chrome shortcuts to match whatever keys are convenient
on your Imprint layout — the extension doesn't care what the combo is, as
long as Chrome's shortcut settings match what ZMK sends.

## How It Works

1. **Background service worker** listens for Chrome command events.
2. On play/pause/seek: it queries `chrome.tabs` for audible tabs (or falls
   back to the last known media tab), then uses `chrome.scripting.executeScript`
   to directly call `.play()`, `.pause()`, or adjust `.currentTime` on the
   `<video>` / `<audio>` element — all without changing focus.
3. If direct injection fails, it falls back to messaging `content.js`, which is
   already loaded in the page and performs the same action.
4. On focus: it activates the media tab and brings Chrome to the foreground.

## Notes

- Works with any site that uses standard HTML5 `<video>` or `<audio>` elements
  (YouTube, Netflix, Twitch, Spotify web player, etc.).
- Sites using DRM (e.g. Netflix) may restrict `executeScript` access on some
  pages. Play/pause usually still works; seeking may not on DRM-protected
  content.
- The seek duration (5 seconds) is hardcoded in `background.js` — change the
  `{ seconds: 5 }` value if you prefer a different interval.

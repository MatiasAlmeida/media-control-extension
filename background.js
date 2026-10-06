// Firefox and Zen expose the WebExtension APIs as `browser`, with promises;
// Chrome added `browser` in version 148 and keeps `chrome` (promises in
// Manifest V3), so this works in both.
const api = globalThis.browser ?? globalThis.chrome;

// Chromium accepts at most 4 suggested shortcuts per manifest, so the other
// four commands get theirs here, in browsers that let an extension set its
// own shortcuts (Firefox and Zen have commands.update; Chromium doesn't, and
// there they are assigned by hand at brave://extensions/shortcuts). Only on
// install, so shortcuts changed later in about:addons are kept.
const EXTRA_SHORTCUTS = {
  'media-speed-down': 'Alt+Shift+Comma',
  'media-speed-up': 'Alt+Shift+Period',
  'media-quality-max': 'Alt+Shift+4',
  'media-quality-cycle': 'Alt+Shift+5',
};

api.runtime.onInstalled.addListener(async ({ reason }) => {
  if (reason !== 'install' || typeof api.commands.update !== 'function') return;
  for (const [name, shortcut] of Object.entries(EXTRA_SHORTCUTS)) {
    try {
      await api.commands.update({ name, shortcut });
    } catch (err) {
      console.warn('[Media Controller] Could not set shortcut', name, err);
    }
  }
});

// Track audible tabs — persisted to storage so it survives service worker restarts
api.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (changeInfo.audible === true) {
    await api.storage.local.set({
      lastMediaTabId: tabId,
      lastMediaWindowId: tab.windowId,
    });
  }
});

api.tabs.onRemoved.addListener(async (tabId) => {
  const { lastMediaTabId } = await api.storage.local.get('lastMediaTabId');
  if (tabId === lastMediaTabId) {
    await api.storage.local.remove(['lastMediaTabId', 'lastMediaWindowId']);
  }
});

/**
 * Finds the best media tab candidate.
 * Priority: currently audible tab > last known media tab (from storage).
 */
async function findMediaTab() {
  // First, try currently audible tabs
  const audibleTabs = await api.tabs.query({ audible: true });
  if (audibleTabs.length > 0) {
    const { lastMediaTabId } = await api.storage.local.get('lastMediaTabId');
    const tracked = audibleTabs.find((t) => t.id === lastMediaTabId);
    const tab = tracked || audibleTabs[0];
    await api.storage.local.set({
      lastMediaTabId: tab.id,
      lastMediaWindowId: tab.windowId,
    });
    return tab;
  }

  // Fall back to last known media tab from storage
  const { lastMediaTabId } = await api.storage.local.get('lastMediaTabId');
  if (lastMediaTabId != null) {
    try {
      const tab = await api.tabs.get(lastMediaTabId);
      return tab;
    } catch {
      await api.storage.local.remove([
        'lastMediaTabId',
        'lastMediaWindowId',
      ]);
    }
  }

  return null;
}

/**
 * Runs in the PAGE's MAIN world (not isolated content script world).
 * This is needed because videoRenditions is a custom JS property on
 * web components — invisible to the isolated world.
 *
 * Two layers are set to enforce quality selection:
 *   Layer 1 — renditions.selectedIndex: updates the Media Chrome UI
 *   Layer 2 — hls.currentLevel: locks hls.js ABR controller
 * Without Layer 2, ABR keeps overriding the rendition selection
 * whenever bandwidth fluctuates.
 */
function controlQualityMainWorld(action) {
  const muxPlayer = document.querySelector('mux-player');
  if (!muxPlayer) return false;

  // Path: mux-player → shadowRoot → mux-video → videoRenditions
  let renditions = null;
  let muxVideo = null;
  if (muxPlayer.shadowRoot) {
    muxVideo = muxPlayer.shadowRoot.querySelector('mux-video');
    if (muxVideo?.videoRenditions?.length > 0)
      renditions = muxVideo.videoRenditions;
  }
  if (!renditions && muxPlayer.media?.videoRenditions?.length > 0) {
    renditions = muxPlayer.media.videoRenditions;
  }
  if (!renditions || renditions.length === 0) return false;

  // Sort by height descending
  const sorted = [];
  for (let i = 0; i < renditions.length; i++) {
    sorted.push({ index: i, height: renditions[i].height || 0 });
  }
  sorted.sort((a, b) => b.height - a.height);

  // Determine target rendition index
  let targetRenditionIndex;
  if (action === 'quality-max') {
    targetRenditionIndex = sorted[0].index;
  } else if (action === 'quality-cycle') {
    const current = renditions.selectedIndex;
    let curPos = -1;
    if (current >= 0) {
      curPos = sorted.findIndex((s) => s.index === current);
    }
    const nextPos = curPos + 1;
    targetRenditionIndex =
      nextPos >= sorted.length ? -1 : sorted[nextPos].index;
  } else {
    return false;
  }

  // Layer 1: Set the UI (Media Chrome renditions)
  renditions.selectedIndex = targetRenditionIndex;

  // Layer 2: Lock hls.js ABR controller via _hls on mux-video
  const hls = muxVideo?._hls;
  if (hls && hls.levels) {
    if (targetRenditionIndex === -1) {
      // Auto mode — re-enable ABR
      hls.currentLevel = -1;
    } else {
      // Match rendition height to hls.js level index (they may differ)
      const targetHeight = renditions[targetRenditionIndex]?.height;
      if (targetHeight) {
        const hlsLevelIndex = hls.levels.findIndex(
          (l) => l.height === targetHeight,
        );
        if (hlsLevelIndex >= 0) {
          hls.currentLevel = hlsLevelIndex;
        }
      }
    }
  }

  return true;
}

async function executeMediaAction(tab, action, args = {}) {
  // For quality actions: must run in page's MAIN world to access
  // custom JS properties like videoRenditions on web components
  if (action === 'quality-max' || action === 'quality-cycle') {
    try {
      const results = await api.scripting.executeScript({
        target: { tabId: tab.id },
        world: 'MAIN',
        func: controlQualityMainWorld,
        args: [action],
      });

      const handled = results?.some((r) => r.result === true);
      if (handled) return;
    } catch (err) {
      console.warn('[Media Controller] MAIN world quality failed:', err);
    }

    console.log('[Media Controller] Quality control failed for tab', tab.id);
    return;
  }

  // For all other actions: isolated world is fine
  // Strategy 1: direct executeScript in all frames
  try {
    const results = await api.scripting.executeScript({
      target: { tabId: tab.id, allFrames: true },
      func: controlMediaDirect,
      args: [action, args],
    });

    const handled = results?.some((r) => r.result === true);
    if (handled) return;
  } catch (err) {
    console.warn('[Media Controller] executeScript failed:', err);
  }

  // Strategy 2: message content script
  try {
    const response = await api.tabs.sendMessage(tab.id, {
      target: 'media-content-script',
      action: action,
      args: args,
    });

    if (response?.handled) return;
  } catch (err) {
    console.warn('[Media Controller] Content script message failed:', err);
  }

  console.log('[Media Controller] No strategy succeeded for tab', tab.id);
}

function controlMediaDirect(action, args) {
  function findAllMedia(root) {
    const media = [];
    media.push(...root.querySelectorAll('video, audio'));
    const allElements = root.querySelectorAll('*');
    for (const el of allElements) {
      if (el.shadowRoot) {
        media.push(...findAllMedia(el.shadowRoot));
      }
    }
    return media;
  }

  // Quality actions — Mux Player videoRenditions.selectedIndex API
  if (action === 'quality-max' || action === 'quality-cycle') {
    function findByTag(tagName, root) {
      const el = root.querySelector(tagName);
      if (el) return el;
      for (const elem of root.querySelectorAll('*')) {
        if (elem.shadowRoot) {
          const found = findByTag(tagName, elem.shadowRoot);
          if (found) return found;
        }
      }
      return null;
    }

    // Find renditions: mux-player → shadowRoot → mux-video → videoRenditions
    let renditions = null;
    const muxPlayer = document.querySelector('mux-player');
    if (muxPlayer) {
      if (muxPlayer.shadowRoot) {
        const mv = muxPlayer.shadowRoot.querySelector('mux-video');
        if (mv?.videoRenditions?.length > 0) renditions = mv.videoRenditions;
      }
      if (!renditions && muxPlayer.media?.videoRenditions?.length > 0) {
        renditions = muxPlayer.media.videoRenditions;
      }
    }
    if (!renditions) {
      const mv = findByTag('mux-video', document);
      if (mv?.videoRenditions?.length > 0) renditions = mv.videoRenditions;
    }

    if (renditions && renditions.length > 0) {
      const sorted = [];
      for (let i = 0; i < renditions.length; i++) {
        sorted.push({ index: i, height: renditions[i].height || 0 });
      }
      sorted.sort((a, b) => b.height - a.height);

      if (action === 'quality-max') {
        renditions.selectedIndex = sorted[0].index;
        return true;
      }
      if (action === 'quality-cycle') {
        const current = renditions.selectedIndex;
        let curPos = -1;
        if (current >= 0) curPos = sorted.findIndex((s) => s.index === current);
        const nextPos = curPos + 1;
        renditions.selectedIndex =
          nextPos >= sorted.length ? -1 : sorted[nextPos].index;
        return true;
      }
    }

    return false;
  }

  // All other actions need a media element
  const allMedia = findAllMedia(document);
  if (allMedia.length === 0) return false;

  allMedia.sort((a, b) => {
    if (!a.paused && b.paused) return -1;
    if (a.paused && !b.paused) return 1;
    if (a.tagName === 'VIDEO' && b.tagName === 'AUDIO') return -1;
    if (a.tagName === 'AUDIO' && b.tagName === 'VIDEO') return 1;
    return 0;
  });

  const media = allMedia[0];

  switch (action) {
    case 'play-pause':
      if (media.paused) {
        media.play();
      } else {
        media.pause();
      }
      return true;
    case 'seek-backward':
      media.currentTime = Math.max(0, media.currentTime - (args.seconds || 5));
      return true;
    case 'seek-forward':
      media.currentTime = Math.min(
        media.duration || Infinity,
        media.currentTime + (args.seconds || 5),
      );
      return true;
    case 'speed-up':
      media.playbackRate = Math.min(
        4,
        media.playbackRate + (args.step || 0.25),
      );
      return true;
    case 'speed-down':
      media.playbackRate = Math.max(
        0.25,
        media.playbackRate - (args.step || 0.25),
      );
      return true;
  }
  return false;
}

api.commands.onCommand.addListener(async (command) => {
  const tab = await findMediaTab();

  if (!tab) {
    console.log('[Media Controller] No media tab found.');
    return;
  }

  switch (command) {
    case 'media-play-pause':
      await executeMediaAction(tab, 'play-pause');
      break;
    case 'media-seek-backward':
      await executeMediaAction(tab, 'seek-backward', { seconds: 5 });
      break;
    case 'media-seek-forward':
      await executeMediaAction(tab, 'seek-forward', { seconds: 5 });
      break;
    case 'media-focus-tab':
      await api.tabs.update(tab.id, { active: true });
      await api.windows.update(tab.windowId, { focused: true });
      break;
    case 'media-quality-max':
      await executeMediaAction(tab, 'quality-max');
      break;
    case 'media-quality-cycle':
      await executeMediaAction(tab, 'quality-cycle');
      break;
    case 'media-speed-up':
      await executeMediaAction(tab, 'speed-up', { step: 0.25 });
      break;
    case 'media-speed-down':
      await executeMediaAction(tab, 'speed-down', { step: 0.25 });
      break;
  }
});

console.log('[Media Controller] Service worker loaded.');

/**
 * Content script — injected into ALL frames via manifest.
 * Searches for <video>/<audio> elements including inside Shadow DOM.
 * Quality control via Mux Player videoRenditions.selectedIndex API.
 */

// `browser` in Firefox, Zen and Chrome >= 148; `chrome` in older Chrome.
const api = globalThis.browser ?? globalThis.chrome;

function findAllMedia(root = document) {
  const media = [];
  media.push(...root.querySelectorAll("video, audio"));
  for (const el of root.querySelectorAll("*")) {
    if (el.shadowRoot) media.push(...findAllMedia(el.shadowRoot));
  }
  return media;
}

/**
 * Find an element by tag across shadow DOM boundaries.
 */
function findByTag(tagName, root = document) {
  const el = root.querySelector(tagName);
  if (el) return el;
  for (const elem of root.querySelectorAll("*")) {
    if (elem.shadowRoot) {
      const found = findByTag(tagName, elem.shadowRoot);
      if (found) return found;
    }
  }
  return null;
}

/**
 * Gets the videoRenditions object from wherever it lives.
 * Path: mux-player → shadowRoot → mux-video → .videoRenditions
 */
function getRenditions() {
  // Try mux-player first (top level), then look inside its shadow root
  const muxPlayer = document.querySelector("mux-player");
  if (muxPlayer) {
    // Check inner mux-video inside shadow root
    if (muxPlayer.shadowRoot) {
      const muxVideo = muxPlayer.shadowRoot.querySelector("mux-video");
      if (muxVideo?.videoRenditions?.length > 0) {
        return muxVideo.videoRenditions;
      }
    }
    // Check mux-player.media (another way to access the inner element)
    if (muxPlayer.media?.videoRenditions?.length > 0) {
      return muxPlayer.media.videoRenditions;
    }
    // Check mux-player itself
    if (muxPlayer.videoRenditions?.length > 0) {
      return muxPlayer.videoRenditions;
    }
  }

  // Fallback: search entire shadow DOM for mux-video
  const muxVideo = findByTag("mux-video");
  if (muxVideo?.videoRenditions?.length > 0) {
    return muxVideo.videoRenditions;
  }

  return null;
}

/**
 * Handle quality actions.
 */
function handleQuality(action) {
  const renditions = getRenditions();

  if (renditions && renditions.length > 0) {
    // Build sorted list by height descending
    const sorted = [];
    for (let i = 0; i < renditions.length; i++) {
      sorted.push({ index: i, height: renditions[i].height || 0 });
    }
    sorted.sort((a, b) => b.height - a.height);

    if (action === "quality-max") {
      renditions.selectedIndex = sorted[0].index;
      return { handled: true, quality: sorted[0].height + "p" };
    }

    if (action === "quality-cycle") {
      const current = renditions.selectedIndex;

      // Find where current sits in sorted order
      // -1 means auto
      let curSortedPos = -1;
      if (current >= 0) {
        curSortedPos = sorted.findIndex((s) => s.index === current);
      }

      // Cycle: auto(-1) → highest(0) → next(1) → ... → lowest(n-1) → auto(-1)
      const nextPos = curSortedPos + 1;

      if (nextPos >= sorted.length) {
        // Back to auto
        renditions.selectedIndex = -1;
        return { handled: true, quality: "Auto" };
      } else {
        renditions.selectedIndex = sorted[nextPos].index;
        return { handled: true, quality: sorted[nextPos].height + "p" };
      }
    }
  }

  // Fallback: hls.js direct
  function findHls(root) {
    const props = ["__hls", "_hls", "hls", "__hlsjs"];
    for (const el of root.querySelectorAll("*")) {
      for (const p of props) {
        const c = el[p];
        if (c && c.levels && typeof c.currentLevel !== "undefined") return c;
      }
      if (el.shadowRoot) {
        const found = findHls(el.shadowRoot);
        if (found) return found;
      }
    }
    return null;
  }

  const hls = findHls(document);
  if (hls && hls.levels?.length > 0) {
    const sortedIdx = hls.levels
      .map((l, i) => ({ i, h: l.height }))
      .sort((a, b) => b.h - a.h)
      .map((l) => l.i);

    if (action === "quality-max") {
      hls.currentLevel = sortedIdx[0];
      return { handled: true, quality: hls.levels[sortedIdx[0]].height + "p" };
    }
    if (action === "quality-cycle") {
      const cycle = [-1, ...sortedIdx];
      const pos = cycle.indexOf(hls.currentLevel);
      const next = cycle[(pos + 1) % cycle.length];
      hls.currentLevel = next;
      return { handled: true, quality: next === -1 ? "Auto" : hls.levels[next].height + "p" };
    }
  }

  return { handled: false };
}

api.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.target !== "media-content-script") return false;

  const action = message.action;
  const args = message.args || {};

  if (action === "quality-max" || action === "quality-cycle") {
    const result = handleQuality(action);
    if (result.handled) {
      sendResponse(result);
      return true;
    }
    return false;
  }

  const allMedia = findAllMedia(document);
  if (allMedia.length === 0) return false;

  allMedia.sort((a, b) => {
    if (!a.paused && b.paused) return -1;
    if (a.paused && !b.paused) return 1;
    if (a.tagName === "VIDEO" && b.tagName === "AUDIO") return -1;
    if (a.tagName === "AUDIO" && b.tagName === "VIDEO") return 1;
    return 0;
  });

  const media = allMedia[0];

  switch (action) {
    case "play-pause":
      if (media.paused) { media.play(); } else { media.pause(); }
      sendResponse({ handled: true });
      return true;
    case "seek-backward":
      media.currentTime = Math.max(0, media.currentTime - (args.seconds || 5));
      sendResponse({ handled: true });
      return true;
    case "seek-forward":
      media.currentTime = Math.min(media.duration || Infinity, media.currentTime + (args.seconds || 5));
      sendResponse({ handled: true });
      return true;
    case "speed-up":
      media.playbackRate = Math.min(4, media.playbackRate + (args.step || 0.25));
      sendResponse({ handled: true });
      return true;
    case "speed-down":
      media.playbackRate = Math.max(0.25, media.playbackRate - (args.step || 0.25));
      sendResponse({ handled: true });
      return true;
  }

  return false;
});

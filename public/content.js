// =============================================================================
// Data layer: map each rendered Bytescale `enc` token -> the real app_screens
// file UUID that Mobbin ships (in plaintext) alongside it in the RSC payload.
//
// Every screen object in Mobbin's flow/screen RSC responses looks like:
//   { "id": "<screenId>",
//     "screenUrl": ".../content/app_screens/<fileUuid>.png",   <- plaintext
//     "restricted": true|false,
//     "screenCdnImgSources": { "src": ".../file.webp?enc=<token>" } }  <- rendered
// The `enc` token is identical between the DOM <img> and the payload, so it is a
// reliable join key. The plaintext app_screens path is present even for locked
// (`restricted: true`) screens, and the unsigned Bytescale URL
//   .../content/app_screens/<fileUuid>.png?f=png&w=1920
// serves the full-resolution image without the encrypted token.
// =============================================================================

const encToUuid = Object.create(null);
const seenScripts = new WeakSet();
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/;

// Scan a blob of text (RSC response or inline script) for enc<->UUID pairs.
// For each `enc=` token, the nearest preceding `app_screens/<uuid>` within the
// same object is its plaintext source. Returns how many new pairs were learned.
function harvestPairs(text) {
  if (!text || text.indexOf("app_screens") === -1) return 0;
  const clean = text.indexOf("\\") === -1 ? text : text.replace(/\\/g, "");
  let added = 0;
  const encRe = /enc=([A-Za-z0-9._-]{20,})/g;
  let m;
  while ((m = encRe.exec(clean))) {
    const enc = m[1];
    if (encToUuid[enc]) continue;
    const before = clean.lastIndexOf("app_screens/", m.index);
    if (before === -1 || m.index - before > 4000) continue; // same-object guard
    const uuid = clean.slice(before + 12, before + 48).match(UUID_RE);
    if (!uuid) continue;
    encToUuid[enc] = uuid[0];
    added++;
  }
  return added;
}

// Locked flow-VIDEO cells expose no `app_screens` sibling, only encrypted URLs,
// and (unlike image screen cells) their <a> has no href, so we can't read the
// flow id from the DOM. But the grid payload's flow object holds both
// `"id":"<flowId>"` and the video's `file.mp4?enc=` poster token, so we join
// poster-enc -> flowId here and later fetch `/flows/<flowId>` for the plaintext
// first-screen image. The same map/fallback also covers locked flow SCREEN
// cells rendered by `/api/search/fetch-search-page-flows`: that endpoint never
// ships a plaintext sibling at all (unlike flow-detail/screen-detail RSC), so
// harvestSearchFlowPairs below joins its cover-screen enc -> flow id instead.
const encToFlow = Object.create(null);
function harvestVideoPairs(text) {
  if (!text || text.indexOf("file.mp4") === -1) return 0;
  const clean = text.indexOf("\\") === -1 ? text : text.replace(/\\/g, "");
  let added = 0;
  const re = /file\.mp4\?enc=([A-Za-z0-9._-]{20,})/g;
  let m;
  while ((m = re.exec(clean))) {
    const enc = m[1];
    if (encToFlow[enc]) continue;
    // The flow's own `"id"` is the nearest one preceding the poster token (the
    // screens array in between uses the `"screenId"` key, so it can't collide).
    const before = clean.slice(Math.max(0, m.index - 30000), m.index);
    const ids = before.match(/"id":"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}"/g);
    if (!ids) continue;
    encToFlow[enc] = ids[ids.length - 1].slice(6, 42);
    added++;
  }
  return added;
}

// Search-results flow grids (`/api/search/fetch-search-page-flows`) return a
// JSON `{ value: { data: [ { id, restricted, screens: [...] } ] } }` shape
// with no plaintext path anywhere, even for locked flows. Join the locked
// cover screen's enc to its flow id so upgradeImageSrc can fall back to
// fetchFlowFirstScreen (same trick as the video cells above).
function harvestSearchFlowPairs(text) {
  if (!text || text.indexOf('"screenCdnImgSources"') === -1 || text.indexOf('"data"') === -1) return 0;
  let json;
  try { json = JSON.parse(text); } catch (e) { return 0; }
  const flows = json && json.value && json.value.data;
  if (!Array.isArray(flows)) return 0;
  let added = 0;
  flows.forEach(flow => {
    if (!flow || !flow.restricted || !flow.id || !Array.isArray(flow.screens) || !flow.screens[0]) return;
    const src = flow.screens[0].screenCdnImgSources && flow.screens[0].screenCdnImgSources.src;
    const m = src && src.match(/enc=([A-Za-z0-9._-]{20,})/);
    if (m && !encToFlow[m[1]]) { encToFlow[m[1]] = flow.id; added++; }
  });
  return added;
}

// Parse inline <script> payloads (Next.js streams screen data via __next_f here
// on the initial full-page load). Each script is scanned once.
function harvestFromScripts() {
  let added = 0;
  document.querySelectorAll("script").forEach(s => {
    if (seenScripts.has(s)) return;
    seenScripts.add(s);
    if (s.textContent) { added += harvestPairs(s.textContent); harvestVideoPairs(s.textContent); }
  });
  return added;
}

// Intercept fetch + XHR so client-side navigations (the `?_rsc=` requests that
// load additional flows/screens) also feed the map. New pairs trigger a re-run.
function installNetworkHooks() {
  if (window.__mvHooked) return;
  window.__mvHooked = true;

  const origFetch = window.fetch;
  if (origFetch) {
    window.fetch = function () {
      return origFetch.apply(this, arguments).then(res => {
        try {
          res.clone().text().then(t => {
            const n = harvestPairs(t) + harvestVideoPairs(t) + harvestSearchFlowPairs(t);
            if (n > 0) scheduleHandle();
          }).catch(() => {});
        } catch (e) { /* opaque response */ }
        return res;
      });
    };
  }

  const XHR = window.XMLHttpRequest;
  if (XHR && XHR.prototype) {
    const origSend = XHR.prototype.send;
    XHR.prototype.send = function () {
      this.addEventListener("load", () => {
        try {
          if (this.responseText && (harvestPairs(this.responseText) + harvestVideoPairs(this.responseText) + harvestSearchFlowPairs(this.responseText)) > 0) scheduleHandle();
        } catch (e) { /* non-text response */ }
      });
      return origSend.apply(this, arguments);
    };
  }
}

// =============================================================================
// DOM layer: remove blur markers and swap blurred images to full resolution.
// =============================================================================

function handleModifications() {
  harvestFromScripts();
  removePromoBanners();
  unblurScreenCells();
  unblurFlowCells();
  unblurVideoCells();
}

function removePromoBanners() {
  document.querySelectorAll("aside.sticky.z-10.my-32").forEach(el => { el.style.display = "none"; });
}

function unblurScreenCells() {
  // Type 1: CSS-blurred via pointer-events-none + backdrop-blur overlay
  document.querySelectorAll(".mobile-screen-border-radius.pointer-events-none, .web-screen-border-radius.pointer-events-none").forEach(container => {
    container.classList.remove("pointer-events-none");
    const blurOverlay = container.querySelector('div[class*="backdrop-blur"]');
    if (blurOverlay) blurOverlay.style.display = "none";
    const img = container.querySelector("img");
    if (img) upgradeImageSrc(img);
  });

  // Type 2: Resolution-blurred via 15w-only srcset (no CSS overlay)
  document.querySelectorAll(".mobile-screen-border-radius, .web-screen-border-radius").forEach(container => {
    if (container.classList.contains("pointer-events-none")) return;
    const img = container.querySelector("img");
    if (isTinySrcset(img)) upgradeImageSrc(img);
  });
}

function unblurFlowCells() {
  // Type 1: CSS-blurred via pointer-events-none + backdrop-blur overlay
  document.querySelectorAll('a[data-sentry-component="FlowCellScreen"].pointer-events-none').forEach(link => {
    link.classList.remove("pointer-events-none");
    link.setAttribute("tabindex", "0");
    const blurOverlay = link.querySelector('div[class*="backdrop-blur"]');
    if (blurOverlay) blurOverlay.style.display = "none";
    const img = link.querySelector("img");
    if (img) upgradeImageSrc(img);
  });

  // Type 2: Resolution-blurred via 15w-only srcset (no pointer-events-none marker)
  document.querySelectorAll('a[data-sentry-component="FlowCellScreen"]').forEach(link => {
    if (link.classList.contains("pointer-events-none")) return;
    const img = link.querySelector("img");
    if (isTinySrcset(img)) upgradeImageSrc(img);
  });

  // Type 3: Wrapper container selector (Tailwind v4 CSS variable class). The
  // blurred flow cell has no href and only a 15w image inside this wrapper.
  document.querySelectorAll('.w-\\(--screen-width\\)').forEach(container => {
    const blurOverlay = container.querySelector('div.absolute[class*="backdrop-blur"]');
    if (blurOverlay) blurOverlay.style.display = "none";
    const link = container.querySelector("a");
    if (link && link.classList.contains("pointer-events-none")) {
      link.classList.remove("pointer-events-none");
      link.setAttribute("tabindex", "0");
    }
    const img = container.querySelector("img");
    if (isTinySrcset(img)) upgradeImageSrc(img);
  });
}

// =============================================================================
// Video layer: locked flow-video cells (`FlowCellVideo` -> VideoWrapper) can NOT
// be unblurred like images. The grid payload ships only encrypted URLs for them
// (poster + source are both `?enc=...`, sealed to a 15px thumbnail) and, unlike
// image screens, carries NO plaintext `app_screens/<uuid>` sibling. So there is
// nothing to reconstruct a clean URL from at the grid level.
//
// BUT the flow-detail endpoint does: `GET /flows/<flowId>` (RSC) returns the
// walkthrough's screens in the open, each as plaintext `app_screens/<uuid>.png`.
// The first one is the video's first frame, so we paint its full-resolution
// unsigned URL onto the <video>'s poster. No playback (Mobbin never ships the
// plaintext .mp4), but the blur is gone and the sharp first frame is shown.
// =============================================================================

// Cache one in-flight/settled fetch per flowId -> first screen's file UUID (or null).
const flowFirstScreen = Object.create(null);
function fetchFlowFirstScreen(flowId) {
  if (flowFirstScreen[flowId]) return flowFirstScreen[flowId];
  const p = fetch("/flows/" + flowId, { headers: { RSC: "1" } })
    .then(r => r.text())
    .then(t => {
      const c = t.indexOf("\\") === -1 ? t : t.replace(/\\/g, "");
      const m = c.match(/app_screens\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/);
      return m ? m[1] : null;
    })
    .catch(() => null);
  flowFirstScreen[flowId] = p;
  return p;
}

function unblurVideoCells() {
  document.querySelectorAll('a[data-sentry-component="VideoWrapper"]').forEach(link => {
    const video = link.querySelector("video");
    if (!video || video.dataset.mvDone === "1" || video.dataset.mvProbing === "1") return;
    const poster = video.poster || "";
    const encM = poster.match(/enc=([A-Za-z0-9._-]{20,})/);
    if (!encM) return;                                  // no sealed poster -> nothing to do
    // Locked cells have no href; recover the flow id from the harvested poster
    // enc -> flowId map. If it isn't harvested yet, a later pass will retry.
    const flowId = encToFlow[encM[1]] ||
      ((link.getAttribute("href") || "").match(/\/flows\/([0-9a-f-]{36})/) || [])[1];
    if (!flowId) return;

    // Unlocked cells also use an enc poster but at full resolution and they play
    // fine, so probe the poster's natural size and only touch the 15px locked ones.
    video.dataset.mvProbing = "1";
    const probe = new Image();
    probe.onload = () => {
      if (probe.naturalWidth > 60) { video.dataset.mvDone = "1"; return; } // unlocked, leave it
      fetchFlowFirstScreen(flowId).then(uuid => {
        if (uuid) {
          video.poster = "https://bytescale.mobbin.com/FW25bBB/image/mobbin.com/prod/content/app_screens/" + uuid + ".png?f=png&w=1920";
          link.classList.remove("pointer-events-none");
        }
        video.dataset.mvDone = "1"; // best-effort; don't re-fetch
      });
    };
    probe.onerror = () => { video.dataset.mvDone = "1"; };
    probe.src = poster;
  });
}

// True when every srcset candidate is the 15px watermark thumbnail.
function isTinySrcset(img) {
  if (!img || !img.srcset) return false;
  return img.srcset.split(",").every(entry => {
    const width = parseInt(entry.trim().split(/\s+/)[1], 10) || 0;
    return width <= 15;
  });
}

// Pull the Bytescale enc token out of an image's src/srcset.
function extractEnc(img) {
  const src = img.currentSrc || img.src || "";
  let m = src.match(/enc=([A-Za-z0-9._-]{20,})/);
  if (m) return m[1];
  if (img.srcset) {
    m = img.srcset.match(/enc=([A-Za-z0-9._-]{20,})/);
    if (m) return m[1];
  }
  return null;
}

// Swap a blurred image for its full-resolution unsigned Bytescale URL. No-op
// (and retried on the next tick) until the matching screen data has loaded.
function upgradeImageSrc(img) {
  if (!img || img.dataset.mvDone === "1") return;

  const enc = extractEnc(img);
  const uuid = enc ? encToUuid[enc] : null;
  if (uuid) {
    img.src = "https://bytescale.mobbin.com/FW25bBB/image/mobbin.com/prod/content/app_screens/" + uuid + ".png?f=png&w=1920";
    img.removeAttribute("srcset");
    img.dataset.mvDone = "1";
    return;
  }

  // Legacy fallback: a real high-res entry already in the srcset (pre-enc format).
  if (img.srcset) {
    const best = img.srcset.split(",").map(s => {
      const parts = s.trim().split(/\s+/);
      return { url: parts[0], width: parseInt(parts[1], 10) || 0 };
    }).sort((a, b) => b.width - a.width)[0];
    if (best && best.width > 100) {
      img.src = best.url;
      img.dataset.mvDone = "1";
      return;
    }
  }

  // Last resort: this page's own payload never carried a plaintext sibling for
  // this enc (e.g. /api/search/fetch-search-page-flows) but harvestSearchFlowPairs
  // mapped it to its flow id, so pull the plaintext first screen from the flow's
  // own detail page instead.
  if (enc && encToFlow[enc] && img.dataset.mvProbing !== "1") {
    img.dataset.mvProbing = "1";
    fetchFlowFirstScreen(encToFlow[enc]).then(uuid2 => {
      img.dataset.mvProbing = "";
      if (uuid2) {
        img.src = "https://bytescale.mobbin.com/FW25bBB/image/mobbin.com/prod/content/app_screens/" + uuid2 + ".png?f=png&w=1920";
        img.removeAttribute("srcset");
        img.dataset.mvDone = "1";
      }
    });
  }
}

// =============================================================================
// Scheduling
// =============================================================================

// Debounced, but with a hard cap so a busy page (constant DOM mutations) can't
// starve the trailing timer: if it's been > MAX_WAIT since the last real run,
// run now instead of deferring again.
let handleTimer;
let lastRun = 0;
const DEBOUNCE = 120;
const MAX_WAIT = 350;
function scheduleHandle() {
  const now = Date.now();
  clearTimeout(handleTimer);
  if (now - lastRun >= MAX_WAIT) {
    lastRun = now;
    handleModifications();
  } else {
    handleTimer = setTimeout(() => { lastRun = Date.now(); handleModifications(); }, DEBOUNCE);
  }
}

installNetworkHooks();
handleModifications();

window.addEventListener("scroll", scheduleHandle);
document.addEventListener("DOMContentLoaded", scheduleHandle);

// Mobbin streams its screen data (the enc -> UUID map source) into the page in
// chunks after first paint, so poll briefly to apply the unblur as soon as each
// chunk lands, then back off. Cheap: harvestFromScripts only reads new scripts.
let ticks = 0;
const poll = setInterval(() => {
  handleModifications();
  if (++ticks >= 40) clearInterval(poll); // ~10s at 250ms
}, 250);

// Catch later dynamic content (infinite scroll, client navigations).
const observer = new MutationObserver(scheduleHandle);
observer.observe(document.body, { childList: true, subtree: true });

window.addEventListener("unload", () => {
  window.removeEventListener("scroll", scheduleHandle);
  clearTimeout(handleTimer);
  clearInterval(poll);
  observer.disconnect();
});

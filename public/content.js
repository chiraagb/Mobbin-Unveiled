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

// Parse inline <script> payloads (Next.js streams screen data via __next_f here
// on the initial full-page load). Each script is scanned once.
function harvestFromScripts() {
  let added = 0;
  document.querySelectorAll("script").forEach(s => {
    if (seenScripts.has(s)) return;
    seenScripts.add(s);
    if (s.textContent) added += harvestPairs(s.textContent);
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
            if (harvestPairs(t) > 0) scheduleHandle();
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
          if (this.responseText && harvestPairs(this.responseText) > 0) scheduleHandle();
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
    }
  }
}

// =============================================================================
// Scheduling
// =============================================================================

let handleTimer;
function scheduleHandle() {
  clearTimeout(handleTimer);
  handleTimer = setTimeout(handleModifications, 150);
}

installNetworkHooks();
harvestFromScripts();
handleModifications();

window.addEventListener("scroll", scheduleHandle);
document.addEventListener("DOMContentLoaded", handleModifications);

// Retry after load to catch screen data that streams in after first paint.
setTimeout(handleModifications, 500);
setTimeout(handleModifications, 1500);
setTimeout(handleModifications, 3000);

// Debounced so React/RSC has time to populate the DOM and the map before we act.
const observer = new MutationObserver(scheduleHandle);
observer.observe(document.body, { childList: true, subtree: true });

window.addEventListener("unload", () => {
  window.removeEventListener("scroll", scheduleHandle);
  clearTimeout(handleTimer);
  observer.disconnect();
});

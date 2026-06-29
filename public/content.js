function handleModifications() {
  removePromoBanners();
  unblurScreenCells();
  unblurFlowCells();
}

function removePromoBanners() {
  document.querySelectorAll("aside.sticky.z-10.my-32").forEach(el => el.remove());
}

function unblurScreenCells() {
  // Type 1: CSS-blurred via pointer-events-none + backdrop-blur overlay
  document.querySelectorAll(".mobile-screen-border-radius.pointer-events-none").forEach(container => {
    container.classList.remove("pointer-events-none");
    const blurOverlay = container.querySelector('div[class*="backdrop-blur"]');
    if (blurOverlay) blurOverlay.remove();
    const img = container.querySelector("img");
    if (img) upgradeImageSrc(img);
  });

  // Type 2: Resolution-blurred via 15w-only srcset (no CSS overlay)
  document.querySelectorAll(".mobile-screen-border-radius").forEach(container => {
    if (container.classList.contains("pointer-events-none")) return;
    const img = container.querySelector("img");
    if (!img || !img.srcset) return;
    const allTiny = img.srcset.split(",").every(entry => {
      const width = parseInt(entry.trim().split(/\s+/)[1], 10) || 0;
      return width <= 15;
    });
    if (allTiny) upgradeImageSrc(img);
  });
}

function unblurFlowCells() {
  document.querySelectorAll('a[data-sentry-component="FlowCellScreen"].pointer-events-none').forEach(link => {
    link.classList.remove("pointer-events-none");
    link.setAttribute("tabindex", "0");
    const blurOverlay = link.querySelector('div[class*="backdrop-blur"]');
    if (blurOverlay) blurOverlay.remove();
    const img = link.querySelector("img");
    if (img) upgradeImageSrc(img);
  });

  document.querySelectorAll('.w-\\[--screen-width\\]').forEach(container => {
    const blurOverlay = container.querySelector('div.absolute[class*="backdrop-blur"]');
    if (blurOverlay) blurOverlay.remove();
    const link = container.querySelector("a");
    if (link && link.classList.contains("pointer-events-none")) {
      link.classList.remove("pointer-events-none");
      link.setAttribute("tabindex", "0");
    }
    const img = container.querySelector("img");
    if (img) upgradeImageSrc(img);
  });
}

function getScreenUrlFromFiber(element) {
  const fiberKey = Object.keys(element).find(k => k.startsWith("__reactFiber"));
  if (!fiberKey) return null;
  let fiber = element[fiberKey];
  let depth = 0;
  while (fiber && depth < 35) {
    const props = fiber.memoizedProps || fiber.pendingProps;
    if (props && props.screen && props.screen.screenUrl) {
      return props.screen.screenUrl;
    }
    fiber = fiber.return;
    depth++;
  }
  return null;
}

function upgradeImageSrc(img) {
  // Primary: extract UUID from fiber's screenUrl, construct Bytescale CDN URL without enc
  const screenUrl = getScreenUrlFromFiber(img);
  if (screenUrl) {
    const uuid = screenUrl.match(/app_screens\/([^/.]+)\.png/)?.[1];
    if (uuid) {
      img.src = `https://bytescale.mobbin.com/FW25bBB/image/mobbin.com/prod/content/app_screens/${uuid}.png?f=png&w=1920`;
      img.srcset = "";
      return;
    }
  }

  // Fallback: pick largest entry from srcset (for Type 1 when fiber fails)
  if (!img.srcset) return;
  const entries = img.srcset.split(",").map(s => {
    const parts = s.trim().split(/\s+/);
    return { url: parts[0], width: parseInt(parts[1], 10) || 0 };
  });
  entries.sort((a, b) => b.width - a.width);
  if (entries.length > 0 && entries[0].width > 100) {
    img.src = entries[0].url;
  }
}

window.addEventListener("scroll", handleModifications);
document.addEventListener("DOMContentLoaded", handleModifications);

const observer = new MutationObserver(() => handleModifications());
observer.observe(document.body, { childList: true, subtree: true });

window.addEventListener("unload", () => {
  window.removeEventListener("scroll", handleModifications);
  observer.disconnect();
});

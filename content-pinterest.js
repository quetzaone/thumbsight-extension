// Pinterest images and video posters: show the Thumb Sight trigger on hover.

const PIN_MIN_WIDTH = 160;
const PIN_MIN_HEIGHT = 90;
let hoverMedia = null;
let hideTimer = null;
let lastPointer = null;
let refreshScheduled = false;

const btn = document.createElement("button");
btn.id = "tv-pin-btn";
btn.type = "button";
TV.setTriggerState(btn, "idle");
btn.title = TVI18N.t("saveImage");
btn.setAttribute("aria-label", btn.title);
btn.style.display = "none";
document.body.appendChild(btn);

document.addEventListener("tv:langchange", () => {
  btn.title = TVI18N.t("saveImage");
  btn.setAttribute("aria-label", btn.title);
});

btn.addEventListener("click", (event) => {
  event.preventDefault();
  event.stopPropagation();
  if (!tvIsTrustedGesture(event, navigator.userActivation)) return;
  // Отсоединённый узел — карточка прежней страницы: сохранять её нельзя.
  if (hoverMedia?.isConnected) savePin(event, hoverMedia);
});
btn.addEventListener("mouseenter", () => {
  clearTimeout(hideTimer);
  hideTimer = null; // scheduleHide смотрит на hideTimer, чтобы не перевзводить таймер
});
btn.addEventListener("mouseleave", scheduleHide);

function mediaSrc(media) {
  if (media?.tagName === "VIDEO") return media.poster || "";
  return media?.currentSrc || media?.src || "";
}

// Возвращает rect подходящего медиа или null: mediaAtPoint проверяет попадание
// по этому же rect и не меряет узел второй раз (скан всей ленты в зазоре сетки).
function pinMediaRect(media) {
  if (!media || !["IMG", "VIDEO"].includes(media.tagName)) return null;
  if (!/i\.pinimg\.com/.test(mediaSrc(media))) return null;
  const rect = media.getBoundingClientRect();
  return rect.width >= PIN_MIN_WIDTH && rect.height >= PIN_MIN_HEIGHT ? rect : null;
}

function mediaAtPoint(container, clientX, clientY) {
  const candidates = [
    ...(["IMG", "VIDEO"].includes(container?.tagName) ? [container] : []),
    ...(container?.querySelectorAll ? container.querySelectorAll("video, img") : []),
  ];
  candidates.sort((a, b) => Number(b.tagName === "VIDEO") - Number(a.tagName === "VIDEO"));
  return candidates.find((media) => {
    const rect = pinMediaRect(media);
    if (!rect) return false;
    return clientX >= rect.left && clientX <= rect.right && clientY >= rect.top && clientY <= rect.bottom;
  }) || null;
}

// Pinterest's own Save/board controls can be 10+ DOM levels above the image.
// Resolve the stable pin-card boundary instead of depending on parent depth.
function findPinMedia(element, clientX, clientY) {
  if (!element) return null;
  if (element === btn || btn.contains(element)) return hoverMedia;

  const direct = mediaAtPoint(element, clientX, clientY);
  if (direct) return direct;

  const containers = [
    element.closest?.('[data-test-id="pinWrapper"]'),
    element.closest?.('[data-test-id="closeup-body-image-container"]'),
    element.closest?.('a[href*="/pin/"]'),
  ].filter(Boolean);
  for (const container of [...new Set(containers)]) {
    const media = mediaAtPoint(container, clientX, clientY);
    if (media) return media;
  }
  return null;
}

function isPinDetailPage() {
  return /^\/pin\/\d+\/?$/.test(location.pathname);
}

function isMainDetailMedia(media) {
  return isPinDetailPage() && Boolean(
    media.closest('[data-test-id="closeup-body-image-container"]') ||
    media.closest('[data-test-id="closeup-image-main"]')
  );
}

function positionBtn(media) {
  const rect = media.getBoundingClientRect();
  const detail = isMainDetailMedia(media);
  btn.style.display = "flex";
  btn.dataset.tvPlacement = detail ? "top-right" : "bottom-left";
  btn.dataset.tvMediaKind = media.tagName.toLowerCase();
  btn.style.top = window.scrollY + (detail ? rect.top + 10 : rect.bottom - 48) + "px";
  btn.style.left = window.scrollX + (detail ? rect.right - 48 : rect.left + 10) + "px";
}

function scheduleHide() {
  // Уже скрыта (display и hoverMedia меняются только вместе) — иначе каждый
  // кадр с мутациями взводил бы новый таймер впустую.
  if (btn.style.display === "none" && !hoverMedia) return;
  // Не перевзводить: при частых мутациях сброс таймера держал бы кнопку на
  // старом пине до 280 мс тишины.
  if (hideTimer) return;
  hideTimer = setTimeout(() => {
    hideTimer = null;
    btn.style.display = "none";
    hoverMedia = null;
  }, 280);
}

function refreshHoveredMedia() {
  refreshScheduled = false;
  // Карточка ушла из DOM (SPA-переход, переиспользование): не позиционировать
  // по нулевому rect и не оставлять старый пин под кликом.
  if (hoverMedia && !hoverMedia.isConnected) {
    btn.style.display = "none";
    hoverMedia = null;
  }
  if (!lastPointer) return;
  const target = document.elementFromPoint(lastPointer.x, lastPointer.y);
  const media = findPinMedia(target, lastPointer.x, lastPointer.y);
  if (media) {
    hoverMedia = media;
    clearTimeout(hideTimer);
    hideTimer = null;
    positionBtn(media);
  } else if (target !== btn && !btn.contains(target)) {
    scheduleHide();
  }
}

function scheduleRefresh() {
  // Нет живой точки (до первого движения или курсор ушёл из окна) — мутации
  // не должны гонять rAF и пересчёт по устаревшим координатам.
  if (!lastPointer) return;
  if (refreshScheduled) return;
  refreshScheduled = true;
  requestAnimationFrame(refreshHoveredMedia);
}

document.addEventListener("pointermove", (event) => {
  if (event.isTrusted !== true) return;
  lastPointer = { x: event.clientX, y: event.clientY };
  scheduleRefresh();
}, { capture: true, passive: true });

// relatedTarget === null — курсор ушёл за окно (в iframe он не null): точку
// забыть и кнопку спрятать, иначе она висит, а мутации пересчитывают пустое место.
document.addEventListener("pointerout", (event) => {
  if (event.isTrusted && !event.relatedTarget) {
    lastPointer = null;
    scheduleHide();
  }
}, { capture: true, passive: true });

// Re-evaluate a stationary pointer when Pinterest swaps an image for a video
// or recycles a card while scrolling.
new MutationObserver(scheduleRefresh).observe(document, { subtree: true, childList: true });

window.addEventListener("scroll", () => {
  if (hoverMedia?.isConnected) positionBtn(hoverMedia);
  else scheduleRefresh();
}, { passive: true });

function bestSrc(media) {
  if (media.tagName === "VIDEO") return media.poster;
  if (media.srcset) {
    let best = null;
    let bestW = 0;
    for (const part of media.srcset.split(",")) {
      const [url, width] = part.trim().split(/\s+/);
      const parsedWidth = parseInt(width) || 0;
      if (url && parsedWidth >= bestW) {
        bestW = parsedWidth;
        best = url;
      }
    }
    if (best) return best;
  }
  return media.currentSrc || media.src;
}

function pinSourceUrl(media) {
  const anchor = media.closest("a[href*='/pin/']");
  if (anchor) return new URL(anchor.getAttribute("href"), location.origin).href;
  return location.href;
}

function savePin(event, media) {
  TV.openPanel(event, {
    mode: "pinterest",
    imageUrl: bestSrc(media),
    sourceUrl: pinSourceUrl(media),
  });
}

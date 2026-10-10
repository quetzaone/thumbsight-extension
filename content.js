// YouTube video pages: adds the Thumb Sight save button to the action bar.

function getVideoId() {
  const u = new URL(location.href);
  if (u.pathname.startsWith("/shorts/")) return u.pathname.split("/")[2];
  return u.searchParams.get("v");
}

function makeButton(id = "tv-save-btn") {
  const btn = document.createElement("button");
  btn.id = id;
  btn.type = "button";
  btn.className = "tv-yt-btn";
  TV.setTriggerState(btn, "idle");
  btn.setAttribute("aria-label", TVI18N.t("saveThumbnail"));
  btn.title = TVI18N.t("saveThumbnail");
  btn.addEventListener("click", onSave);
  return btn;
}

document.addEventListener("tv:langchange", () => {
  for (const button of document.querySelectorAll("#tv-save-btn, #tv-shorts-save-btn")) {
    button.title = TVI18N.t("saveThumbnail");
    button.setAttribute("aria-label", button.title);
  }
});

async function onSave(e) {
  e.preventDefault();
  e.stopPropagation();
  // Синтетический click со страницы не проходит дальше этой строки.
  if (!tvIsTrustedGesture(e, navigator.userActivation)) return;
  const videoId = getVideoId();
  if (!videoId) {
    TV.toast(TVI18N.t("notVideo"), "info");
    return;
  }
  TV.openPanel(e, {
    mode: "youtube",
    videoId,
    imageUrl: `https://i.ytimg.com/vi/${videoId}/maxresdefault.jpg`,
    sourceUrl: `https://www.youtube.com/watch?v=${videoId}`,
  });
}

function findActionsAnchor() {
  return (
    document.querySelector("ytd-watch-metadata #top-level-buttons-computed") ||
    document.querySelector("#actions-inner #top-level-buttons-computed") ||
    document.querySelector("#menu #top-level-buttons-computed") ||
    document.querySelector("#actions #top-level-buttons-computed") ||
    document.querySelector("ytd-watch-metadata #actions ytd-menu-renderer") ||
    document.querySelector("#actions-inner ytd-menu-renderer") ||
    document.querySelector("#actions ytd-menu-renderer")
  );
}

function findShortsActionsAnchor() {
  return (
    document.querySelector("ytd-reel-video-renderer[is-active] ytd-reel-player-overlay-renderer #actions") ||
    document.querySelector("ytd-reel-player-overlay-renderer #actions") ||
    document.querySelector("ytd-reel-video-renderer[is-active] .YtReelPlayerOverlayActionsViewModelHost") ||
    document.querySelector("ytd-reel-player-overlay-renderer .YtReelPlayerOverlayActionsViewModelHost")
  );
}

function removeBtn() {
  document.getElementById("tv-save-btn")?.remove();
  document.getElementById("tv-shorts-save-btn")?.remove();
}

function ensureButton() {
  const isShorts = location.pathname.startsWith("/shorts/");
  if (!/\/watch/.test(location.pathname) && !isShorts) {
    removeBtn();
    return;
  }
  const anchor = isShorts ? findShortsActionsAnchor() : findActionsAnchor();
  if (!anchor) return;

  const buttonId = isShorts ? "tv-shorts-save-btn" : "tv-save-btn";
  const otherButtonId = isShorts ? "tv-save-btn" : "tv-shorts-save-btn";
  document.getElementById(otherButtonId)?.remove();
  const existing = document.getElementById(buttonId);
  if (existing && anchor.contains(existing)) return;

  if (existing) existing.remove();
  const btn = makeButton(buttonId);
  btn.classList.add(isShorts ? "tv-yt-shorts" : "tv-yt-inline");
  anchor.insertBefore(btn, anchor.firstChild);
}

let lastUrl = location.href;
let scheduled = false;
function schedule() {
  if (scheduled) return;
  scheduled = true;
  requestAnimationFrame(() => {
    scheduled = false;
    ensureButton();
  });
}

const observer = new MutationObserver(() => {
  if (location.href !== lastUrl) {
    lastUrl = location.href;
    removeBtn();
  }
  schedule();
});
observer.observe(document, { subtree: true, childList: true });

schedule();

document.addEventListener("yt-navigate-finish", schedule);
document.addEventListener("yt-page-data-updated", schedule);
window.addEventListener("pageshow", schedule);
setTimeout(schedule, 800);
setTimeout(schedule, 1800);
setTimeout(schedule, 3500);

// Host-page side of Thumb Sight. Private data stays inside the extension-origin
// iframe; the content script owns only the closed-shadow presentation shell.

let tvPanelHost = null;
let tvPanelFrame = null;
let tvPanelDialog = null;
let tvPanelOpening = false;
const tvPanelOrigin = new URL(chrome.runtime.getURL("/")).origin;

function tvCloseEmbeddedPanel() {
  if (tvPanelDialog?.open) tvPanelDialog.close();
  tvPanelHost?.remove();
  tvPanelHost = null;
  tvPanelFrame = null;
  tvPanelDialog = null;
}

function tvMountEmbeddedPanel(nonce) {
  tvCloseEmbeddedPanel();

  const host = document.createElement("div");
  host.id = "tv-panel-host";
  const shadow = host.attachShadow({ mode: "closed" });
  const style = document.createElement("style");
  style.textContent = `
    :host { all: initial; }
    dialog.tv-shell {
      all: initial;
      box-sizing: border-box;
      position: fixed; inset: 0;
      width: 100vw; height: 100vh; max-width: none; max-height: none;
      margin: 0; padding: 0; border: 0;
      background: rgba(5, 7, 11, .62);
      -webkit-backdrop-filter: blur(12px);
      backdrop-filter: blur(12px);
    }
    dialog.tv-shell::backdrop { background: transparent; }
    iframe { width: 100%; height: 100%; border: 0; display: block; background: transparent; }
  `;
  // A modal <dialog> is promoted to the browser top layer. Host-page CSS can
  // still remove the outer marker (availability only), but opacity, transform,
  // clipping and stacking on that marker cannot redraw the privileged panel.
  const dialog = document.createElement("dialog");
  dialog.className = "tv-shell";
  dialog.setAttribute("aria-label", "Thumb Sight");
  const frame = document.createElement("iframe");
  frame.title = "Thumb Sight";
  frame.src = chrome.runtime.getURL(`${TV_PANEL_PAGE}?intent=${encodeURIComponent(nonce)}&embedded=1`);
  dialog.appendChild(frame);
  dialog.addEventListener("cancel", (event) => {
    event.preventDefault();
    tvCloseEmbeddedPanel();
  });
  shadow.append(style, dialog);
  document.documentElement.appendChild(host);
  tvPanelHost = host;
  tvPanelFrame = frame;
  tvPanelDialog = dialog;
  try {
    dialog.showModal();
  } catch (error) {
    tvCloseEmbeddedPanel();
    throw error;
  }
}

window.addEventListener("message", (event) => {
  if (
    tvPanelFrame &&
    event.source === tvPanelFrame.contentWindow &&
    event.origin === tvPanelOrigin &&
    event.data?.type === "tv:panel-close"
  ) {
    tvCloseEmbeddedPanel();
  }
});

const TV = {
  markSvg() {
    return `<svg class="tv-mark" viewBox="0 0 17.32 17.32" aria-hidden="true"><path d="M11.78,7.62c-.19.74-.86,1.29-1.66,1.29-.95,0-1.72-.77-1.72-1.72,0-.79.54-1.46,1.27-1.66-.32-.1-.65-.17-1.01-.17-1.82,0-3.3,1.48-3.3,3.3s1.48,3.3,3.3,3.3,3.3-1.48,3.3-3.3c0-.37-.07-.71-.18-1.04Z"/><path d="M4.14,6.79C4.64,3.73,6.36,1.21,8.65,0c1.01.53,1.91,1.32,2.64,2.29-2.08.3-4.2,1.33-5.94,3.07-.45.45-.86.93-1.21,1.43Zm2.65,6.38C3.73,12.67,1.21,10.95,0,8.66c.53-1.01,1.32-1.91,2.29-2.64.3,2.08,1.33,4.2,3.07,5.94.45.45.93.86,1.43,1.21Zm3.74-9.03c3.06.5,5.58,2.22,6.79,4.51-.53,1.01-1.32,1.91-2.29,2.64-.3-2.08-1.33-4.2-3.07-5.94-.45-.45-.93-.86-1.43-1.21Zm2.64,6.39c-.5,3.06-2.22,5.58-4.51,6.79-1.01-.53-1.91-1.32-2.64-2.29,2.08-.3,4.2-1.33,5.94-3.07.45-.45.86-.93,1.21-1.43Z"/></svg>`;
  },

  setTriggerState(button, state = "idle") {
    if (!button) return;
    const visibleState = state === "disabled" ? "disabled" : "idle";
    button.dataset.tvState = visibleState;
    button.disabled = visibleState === "disabled";
    button.innerHTML = TV.markSvg();
  },

  // Публичные (со страницы) сообщения; приватных данных тут не бывает.
  toast(msg, kind = "info") {
    let t = document.getElementById("tv-toast");
    if (!t) {
      t = document.createElement("div");
      t.id = "tv-toast";
      document.body.appendChild(t);
    }
    const safeKind = ["ok", "error", "info", "warn"].includes(kind) ? kind : "info";
    t.dataset.kind = safeKind;
    t.textContent = "";

    const icon = document.createElement("span");
    icon.className = "tv-toast-icon";
    icon.textContent = safeKind === "ok" ? "✓" : safeKind === "error" ? "×" : "i";
    const copy = document.createElement("span");
    copy.className = "tv-toast-copy";
    copy.textContent = msg;
    t.append(icon, copy);

    t.classList.add("show");
    clearTimeout(t._h);
    t._h = setTimeout(() => t.classList.remove("show"), 2800);
  },

  // event — исходное событие пользователя. Без доверенного жеста ни одного
  // сообщения в background не уходит (EXT-001).
  // intent: { mode: 'youtube'|'pinterest'|'channel', ... } — только данные,
  // которые host page и так знает.
  //
  // Обработчики проверяют пару isTrusted + navigator.userActivation
  // синхронно, пока transient activation ещё жива; здесь остаётся второй,
  // не истекающий слой — isTrusted самого события.
  async openPanel(event, intent) {
    if (!tvIsTrustedGesture(event, null)) return false;
    // Пока ответа на tv:open-intent нет, страница ещё не inert, и второй клик
    // двойного клика на холодном worker чеканил второй intent и монтировал
    // панель дважды (EXT-OPT-01 #1/#43). Callback sendMessage вызывается
    // всегда, поэтому finally флаг не подвесит.
    if (tvPanelOpening) return false;
    tvPanelOpening = true;
    try {
      let result;
      try {
        result = await new Promise((resolve) => {
          chrome.runtime.sendMessage({ type: "tv:open-intent", intent }, (response) => {
            const runtimeError = chrome.runtime.lastError?.message || "";
            resolve({ response, runtimeError });
          });
        });
      } catch (error) {
        result = { response: null, runtimeError: error?.message || "" };
      }
      if (!result?.response?.ok || typeof result.response.nonce !== "string") {
        const stale = /context invalidated|receiving end does not exist/i.test(result?.runtimeError || "");
        TV.toast(
          stale
            ? TVI18N.t("stalePage")
            : TVI18N.t("openFailed"),
          "error"
        );
        return false;
      }
      try {
        tvMountEmbeddedPanel(result.response.nonce);
      } catch {
        TV.toast(TVI18N.t("openFailed"), "error");
        return false;
      }
      return true;
    } finally {
      tvPanelOpening = false;
    }
  },
};

window.TV = TV;

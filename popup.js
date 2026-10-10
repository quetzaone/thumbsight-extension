function $(id) {
  return document.getElementById(id);
}

function text(id, value) {
  const el = $(id);
  if (el) el.textContent = value;
}

function setDisplay(id, display) {
  const el = $(id);
  if (el) el.style.display = display;
}

function setDisabled(id, disabled) {
  const el = $(id);
  if (el) el.disabled = disabled;
}

function on(id, event, handler) {
  const el = $(id);
  if (el) el.addEventListener(event, handler);
}

const TVL = globalThis.TVI18N || {
  LANGS: ["en"],
  NAMES: { en: "English" },
  lang: "en",
  ready: Promise.resolve(),
  apply() {},
  async setLang() {},
  t: (key) => key,
};
const tvT = (key) => TVL.t(key);

function renderLanguageMenu() {
  const menu = $("langMenu");
  if (!menu || typeof document.createElement !== "function") return;
  text("langCode", TVL.lang.toUpperCase());
  menu.textContent = "";
  for (const code of TVL.LANGS) {
    const option = document.createElement("button");
    option.type = "button";
    option.className = "lang-option";
    option.setAttribute("role", "menuitemradio");
    option.setAttribute("aria-checked", code === TVL.lang ? "true" : "false");
    const label = document.createElement("span");
    label.textContent = TVL.NAMES[code];
    option.append(label);
    if (code === TVL.lang) option.append("✓");
    option.addEventListener("click", async () => {
      await TVL.setLang(code);
      menu.hidden = true;
      $("langButton").setAttribute("aria-expanded", "false");
      renderLanguageMenu();
      await render();
    });
    menu.appendChild(option);
  }
}

function sendRuntimeMessage(message) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(message, (response) => {
      if (chrome.runtime.lastError) resolve({ ok: false, error: chrome.runtime.lastError.message });
      else resolve(response || { ok: false, error: "Empty background response" });
    });
  });
}

async function render() {
  await TVL.ready;
  TVL.apply();
  if (globalThis.TVI18N && typeof document.querySelector === "function") {
    const warning = document.querySelector(".warn[role='alert']");
    if (warning) warning.textContent = tvT("signOutWarn");
  }
  renderLanguageMenu();
  const s = await SB.getSession();
  if (s) {
    setDisplay("login", "none");
    setDisplay("account", "block");
    const email = s.user?.email || "";
    text("who", email);
    text("avatarInitial", (email.trim()[0] || "T").toUpperCase());
    if ($("siteLink")) {
      $("siteLink").href = window.THUMBVAULT_CONFIG.AUTH_SITE_URL || "https://thumbsight.com";
    }
    const res = await sendRuntimeMessage({ type: "tv:ping" });
    text("bgStatus", res.ok ? tvT("ready") : `${tvT("backgroundUnavailable")}: ${res.error || "unknown error"}`);
  } else {
    setDisplay("login", "block");
    setDisplay("account", "none");
    // Слот ошибки входа живёт там же, где сессия, а область выбирает
    // background (в Firefox это storage.session). Popup спрашивает текст
    // сообщением и сам storage не читает.
    const stored = await sendRuntimeMessage({ type: "tv:oauth-error" });
    text("status", (stored.ok && stored.text) || tvT("signInStatus"));
  }
}

on("langButton", "click", (event) => {
  event.stopPropagation();
  const menu = $("langMenu");
  menu.hidden = !menu.hidden;
  $("langButton").setAttribute("aria-expanded", menu.hidden ? "false" : "true");
});
document.addEventListener?.("click", () => {
  if (!$("langMenu")) return;
  $("langMenu").hidden = true;
  $("langButton").setAttribute("aria-expanded", "false");
});

on("loginBtn", "click", async () => {
  setDisabled("loginBtn", true);
  showLogoutWarning(false);
  text("status", tvT("opening"));
  await sendRuntimeMessage({ type: "tv:oauth-error-clear" });
  try {
    const res = await sendRuntimeMessage({ type: "tv:oauth-sign-in" });
    if (!res.ok) throw new Error(res.error || tvT("signInFailed"));
    text("status", tvT("signInStatus"));
    render();
  } catch (e) {
    text("status", e.message);
  } finally {
    setDisabled("loginBtn", false);
  }
});

// EXT-003: локальный выход выполнен всегда, но обещать отзыв серверной сессии
// можно только при подтверждённом revoke. Текст предупреждения статичен в
// popup.html, поэтому сырая диагностика в UI попасть не может.
function showLogoutWarning(show) {
  const el = $("logoutWarn");
  if (el) el.hidden = !show;
}

on("logoutBtn", "click", async () => {
  showLogoutWarning(false);
  let result = null;
  try {
    result = await SB.signOut();
  } catch (_) {
    result = null;
  }
  await sendRuntimeMessage({ type: "tv:oauth-error-clear" });
  showLogoutWarning(!result || (result.hadSession && !result.remoteRevoked));
  render();
});

render().catch((err) => {
  text("status", err.message || String(err));
  text("bgStatus", err.message || String(err));
});

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
      // Отказ storage при сохранении языка не должен всплыть необработанным rejection.
      await TVL.setLang(code).catch(() => {});
      menu.hidden = true;
      $("langButton").setAttribute("aria-expanded", "false");
      renderLanguageMenu();
      // Полный render() здесь лишний: он заново спрашивал у фона сессию (с
      // возможным refresh) и ошибку входа. Хватает перерисовать тексты —
      // но сначала apply(): при отказе storage в setLang он не вызывался.
      TVL.apply();
      renderTexts();
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

// Что показал последний render(): смена языка перерисовывает по нему тексты без
// новых сообщений фону. apply() затирает #status и #bgStatus через data-i18n,
// поэтому динамический текст надо помнить, а не читать из DOM.
let shown = null;

function renderTexts() {
  if (globalThis.TVI18N && typeof document.querySelector === "function") {
    const warning = document.querySelector(".warn[role='alert']");
    if (warning) warning.textContent = tvT("signOutWarn");
  }
  if (!shown) return;
  if (shown.error) {
    text("status", shown.error);
    text("bgStatus", shown.error);
  } else if (shown.signedIn) {
    text("who", shown.email);
    text("bgStatus", tvT("ready"));
  } else {
    text("status", shown.oauthError || tvT("signInStatus"));
  }
}

// #login скрыт разметкой до первого ответа фона (иначе вошедший видит кадр
// «Sign in»); открывать его — только когда сессии нет или фон отказал.
function showLogin() {
  const el = $("login");
  if (el) el.hidden = false;
}

async function render() {
  await TVL.ready;
  TVL.apply();
  renderLanguageMenu();
  const s = await SB.getSession();
  if (s) {
    setDisplay("login", "none");
    setDisplay("account", "block");
    const email = s.user?.email || "";
    text("avatarInitial", (email.trim()[0] || "T").toUpperCase());
    if ($("siteLink")) {
      $("siteLink").href = window.THUMBVAULT_CONFIG.AUTH_SITE_URL || "https://thumbsight.com";
    }
    // Отдельный tv:ping не нужен: SB._send отклоняет промис при lastError и
    // !ok, так что полученная сессия уже доказывает, что фон жив.
    shown = { signedIn: true, email };
  } else {
    showLogin();
    setDisplay("login", "block");
    setDisplay("account", "none");
    // Слот ошибки входа живёт там же, где сессия, а область выбирает
    // background (в Firefox это storage.session). Popup спрашивает текст
    // сообщением и сам storage не читает.
    const stored = await sendRuntimeMessage({ type: "tv:oauth-error" });
    shown = { signedIn: false, oauthError: (stored.ok && stored.text) || "" };
  }
  renderTexts();
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
    render().catch(tvRenderFailed);
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

// Без формы входа отказ фона оставил бы пустой popup: вход — единственное,
// что пользователь может сделать отсюда. Один обработчик на все вызовы render().
function tvRenderFailed(err) {
  shown = { error: err.message || String(err) };
  showLogin();
  renderTexts();
}

render().catch(tvRenderFailed);

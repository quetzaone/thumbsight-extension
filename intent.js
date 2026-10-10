// Общий intent/capability слой публичного расширения.
//
// Границы доверия:
//   host page DOM      — только статические триггеры, никаких приватных данных;
//   content script     — доказывает реальный жест и просит одноразовый nonce;
//   background         — единственный владелец сессии, выдаёт одноразовое намерение;
//   panel iframe       — extension-origin UI в overlay текущей вкладки;
//   panel.html (ext)   — browser-controlled поверхность приватного и mutating UI.
//
// Файл грузится тремя контекстами: importScripts в service worker, content
// script и extension page. Экспорт для node --test — в самом низу.

const TV_INTENT_TTL_MS = 30000;
const TV_INTENT_MAX = 32;
const TV_INTENT_NONCE_RE = /^[A-Za-z0-9_-]{22,64}$/;
const TV_INTENT_STORAGE_PREFIX = "tv_intent_";
const TV_PANEL_PAGE = "panel.html";

// ---------- 1. Доказательство пользовательского намерения (EXT-001) ----------

// Синтетические page-события дают isTrusted === false и не создают user
// activation, поэтому оба сигнала обязательны, когда браузер их предоставляет.
function tvIsTrustedGesture(event, activation) {
  if (!event || event.isTrusted !== true) return false;
  if (activation && typeof activation.isActive === "boolean") return activation.isActive === true;
  return true;
}

// ---------- 2. Строгая валидация параметров intent ----------

function tvIntentText(value, max) {
  return String(value == null ? "" : value).replace(/\s+/g, " ").trim().slice(0, max);
}

function tvIntentUrl(value, allowedHosts) {
  const raw = tvIntentText(value, 2048);
  if (!raw) return "";
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:") return "";
    const host = url.hostname.toLowerCase();
    const ok = allowedHosts.some((allowed) => host === allowed || host.endsWith(`.${allowed}`));
    return ok ? url.href.slice(0, 2048) : "";
  } catch {
    return "";
  }
}

function tvIntentHostFamily(originUrl) {
  try {
    const url = new URL(String(originUrl || ""));
    if (url.protocol !== "https:") return "";
    const host = url.hostname.toLowerCase();
    if (host === "youtube.com" || host.endsWith(".youtube.com")) return "youtube";
    if (
      host === "pinterest.com" || host.endsWith(".pinterest.com") ||
      host === "pinterest.ru" || host.endsWith(".pinterest.ru")
    ) return "pinterest";
    return "";
  } catch {
    return "";
  }
}

// Возвращает нормализованный intent либо бросает. Ничего приватного тут нет:
// все поля происходят из самой host-страницы.
function tvValidateIntent(raw, originUrl) {
  const family = tvIntentHostFamily(originUrl);
  if (!family) throw new Error("Invalid intent origin");

  const origin = new URL(String(originUrl)).origin;
  const mode = raw && typeof raw.mode === "string" ? raw.mode : "";

  if (mode === "youtube" || mode === "channel") {
    if (family !== "youtube") throw new Error("Invalid intent origin");
  } else if (mode === "pinterest") {
    if (family !== "pinterest") throw new Error("Invalid intent origin");
  } else {
    throw new Error("Invalid intent mode");
  }

  if (mode === "youtube") {
    const videoId = tvIntentText(raw.videoId, 32);
    if (!/^[A-Za-z0-9_-]{11}$/.test(videoId)) throw new Error("Invalid video id");
    const imageUrl = tvIntentUrl(raw.imageUrl, ["i.ytimg.com"]);
    if (!imageUrl) throw new Error("Invalid image URL");
    const sourceUrl = tvIntentUrl(raw.sourceUrl, ["youtube.com"]);
    if (!sourceUrl) throw new Error("Invalid source URL");
    return { mode, origin, videoId, imageUrl, sourceUrl };
  }

  if (mode === "pinterest") {
    const imageUrl = tvIntentUrl(raw.imageUrl, ["i.pinimg.com"]);
    if (!imageUrl) throw new Error("Invalid image URL");
    const sourceUrl = tvIntentUrl(raw.sourceUrl, ["pinterest.com", "pinterest.ru"]);
    if (!sourceUrl) throw new Error("Invalid source URL");
    return { mode, origin, videoId: null, imageUrl, sourceUrl };
  }

  const channelId = tvIntentText(raw.channelId, 32);
  if (!/^UC[A-Za-z0-9_-]{22}$/.test(channelId)) throw new Error("Invalid channel id");
  return {
    mode,
    origin,
    channelId,
    channelName: tvIntentText(raw.channelName, 160),
    channelAvatar: tvIntentUrl(raw.channelAvatar, ["yt3.ggpht.com", "googleusercontent.com"]),
  };
}

// ---------- 3. Одноразовые lifecycle-устойчивые capability ----------

function tvRandomNonce() {
  const bytes = new Uint8Array(24);
  (globalThis.crypto || crypto).getRandomValues(bytes);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function tvIntentStorageKey(nonce) {
  return `${TV_INTENT_STORAGE_PREFIX}${nonce}`;
}

// storage.session переживает остановку MV3 worker, но очищается при рестарте
// браузера. В записи лежат только публичные данные текущей host page — ни
// Supabase session, ни токены, ни приватные данные пользователя туда не попадают.
//
// Операции сериализованы: remove выполняется до успешного возврата claim, поэтому
// concurrent/replay claim не могут получить один intent дважды.
function tvCreateSessionIntentStore(area, deps = {}) {
  if (!area?.get || !area?.set || !area?.remove) throw new Error("Invalid intent storage");
  const now = deps.now || (() => Date.now());
  const newNonce = deps.newNonce || tvRandomNonce;
  const ttlMs = deps.ttlMs || TV_INTENT_TTL_MS;
  const maxPending = deps.maxPending || TV_INTENT_MAX;
  let queue = Promise.resolve();

  const exclusive = (operation) => {
    const result = queue.then(operation, operation);
    queue = result.catch(() => {});
    return result;
  };

  const readEntry = async (nonce) => {
    const key = tvIntentStorageKey(nonce);
    const values = await area.get(key);
    return { key, entry: values?.[key] || null };
  };

  const sweep = async () => {
    const values = await area.get(null);
    const expired = [];
    let live = 0;
    for (const [key, value] of Object.entries(values || {})) {
      if (!key.startsWith(TV_INTENT_STORAGE_PREFIX)) continue;
      if (!value || value.expiresAt <= now()) expired.push(key);
      else live++;
    }
    if (expired.length) await area.remove(expired);
    return live;
  };

  return {
    mint(intent, sourceTabId) {
      return exclusive(async () => {
        if (!Number.isInteger(sourceTabId) || sourceTabId < 0) throw new Error("Invalid intent source");
        if (await sweep() >= maxPending) throw new Error("Too many pending intents");
        const nonce = newNonce();
        if (!TV_INTENT_NONCE_RE.test(nonce)) throw new Error("Invalid capability");
        await area.set({
          [tvIntentStorageKey(nonce)]: {
            intent,
            sourceTabId,
            targetTabId: null,
            expiresAt: now() + ttlMs,
          },
        });
        return nonce;
      });
    },

    bind(nonce, targetTabId) {
      return exclusive(async () => {
        if (typeof nonce !== "string" || !TV_INTENT_NONCE_RE.test(nonce)) throw new Error("Invalid capability");
        if (!Number.isInteger(targetTabId) || targetTabId < 0) throw new Error("Invalid intent target");
        const { key, entry } = await readEntry(nonce);
        if (!entry || entry.expiresAt <= now() || entry.targetTabId !== null) {
          if (entry) await area.remove(key);
          throw new Error("Invalid capability");
        }
        await area.set({ [key]: { ...entry, targetTabId } });
      });
    },

    claim(nonce, targetTabId) {
      return exclusive(async () => {
        if (typeof nonce !== "string" || !TV_INTENT_NONCE_RE.test(nonce)) throw new Error("Invalid capability");
        const { key, entry } = await readEntry(nonce);
        if (!entry) throw new Error("Invalid capability");
        // Состояние pending сохраняет корректность при возможной смене порядка
        // bind/загрузки в будущих transport-реализациях.
        if (entry.targetTabId === null) throw new Error("Capability pending");
        await area.remove(key); // single use: удаляем до проверок и возврата
        if (entry.expiresAt <= now() || entry.targetTabId !== targetTabId) {
          throw new Error("Invalid capability");
        }
        return entry.intent;
      });
    },

    discard(nonce) {
      return exclusive(async () => {
        if (typeof nonce === "string" && TV_INTENT_NONCE_RE.test(nonce)) {
          await area.remove(tvIntentStorageKey(nonce));
        }
      });
    },
  };
}

// Enter и click вызывают одну и ту же action-функцию. Lock предотвращает
// двойной запуск, если два настоящих события пришли до завершения первого.
function tvCreateActionLock(action) {
  let running = false;
  return async (...args) => {
    if (running) return false;
    running = true;
    try {
      await action(...args);
      return true;
    } finally {
      running = false;
    }
  };
}

// ---------- 4. Валидация отправителя и политика сообщений ----------

// Собственный адрес страниц расширения зависит от браузера: в Chrome это
// `chrome-extension://<runtime.id>`, в Firefox — `moz-extension://<UUID
// установки>`, и этот UUID НЕ равен `runtime.id` (замерено: F13 в
// security/receipts/CLAUDE-EXT-FIREFOX-PLATFORM-PROBE-01.md). Поэтому базу
// берём из `runtime.getURL("/")` и сравниваем protocol и host ПО ОТДЕЛЬНОСТИ.
//
// Сравнивать `URL.origin` нельзя. Для схем, которых парсер не знает, он отдаёт
// непрозрачный `"null"`: в Firefox так выходит для `chrome-extension:` и любой
// неизвестной схемы, а в Node — для ВСЕХ extension-схем сразу (F8/F14 там же).
// Реализация на origin прошла бы юнит-тесты, сравнивая `"null" === "null"`, и
// пропускала бы чужого отправителя.
//
// `baseUrl` не передан — поведение прежнее, Chrome-форма из `extensionId`:
// это сохраняет контракт для всех существующих вызовов и тестов.
function tvParseSelfBase(baseUrl, extensionId) {
  const raw = typeof baseUrl === "string" && baseUrl
    ? baseUrl
    : (extensionId ? `chrome-extension://${extensionId}/` : "");
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if (!url.protocol || !url.host) return null;
    return { protocol: url.protocol, host: url.host };
  } catch {
    return null;
  }
}

function tvSenderIsExtensionPage(sender, extensionId, baseUrl) {
  if (sender && sender.id && sender.id !== extensionId) return false;
  if (!sender || typeof sender.url !== "string") return false;
  const base = tvParseSelfBase(baseUrl, extensionId);
  if (!base) return false;
  try {
    const url = new URL(sender.url);
    return url.protocol === base.protocol && url.host === base.host;
  } catch {
    return false;
  }
}

function tvSenderPagePath(sender) {
  try {
    return new URL(sender.url).pathname;
  } catch {
    return "";
  }
}

function tvSenderIsPopup(sender, extensionId, baseUrl) {
  return tvSenderIsExtensionPage(sender, extensionId, baseUrl) && tvSenderPagePath(sender) === "/popup.html";
}

function tvSenderIsPanel(sender, extensionId, baseUrl) {
  return (
    tvSenderIsExtensionPage(sender, extensionId, baseUrl) &&
    tvSenderPagePath(sender) === `/${TV_PANEL_PAGE}` &&
    Number.isInteger(sender?.tab?.id)
  );
}

function tvSenderIsHostPage(sender, extensionId) {
  if (sender && sender.id && sender.id !== extensionId) return false;
  if (!sender || typeof sender.url !== "string") return false;
  if (!Number.isInteger(sender?.tab?.id)) return false;
  return tvIntentHostFamily(sender.url) !== "";
}

// Сохраняет прежнее поведение background sender validation. Вторая проверка
// extension-origin: та же дисциплина, что в `tvSenderIsExtensionPage` —
// protocol и host из собственной базы, никаких сравнений origin.
function tvSenderIsAllowed(sender, extensionId, baseUrl) {
  if (sender && sender.id && sender.id !== extensionId) return false;
  if (!sender || !sender.url) return true;
  const base = tvParseSelfBase(baseUrl, extensionId);
  try {
    const url = new URL(sender.url);
    if (base && url.protocol === base.protocol && url.host === base.host) return true;
    if (url.protocol !== "https:") return false;
    return tvIntentHostFamily(sender.url) !== "";
  } catch {
    return false;
  }
}

// Кто какой тип сообщения вправе прислать. Host page больше не имеет доступа
// ни к одному authenticated Supabase route и ни к одному session-ответу.
const TV_MESSAGE_POLICY = {
  "tv:ping": "any",
  // Публичная настройка интерфейса, а не данные аккаунта: content script читать
  // закрытый storage не может, а ответ — один код языка из фиксированного
  // списка.
  "tv:lang": "any",
  "tv:oauth-sign-in": "popup",
  "tv:sb-sign-out": "popup",
  // Слот ошибки входа переехал вместе с сессией, а носитель выбирает
  // background (Chrome — storage.local, Firefox — storage.session). Popup
  // больше не знает, где слот лежит, и не читает storage сам. Контракт узкий:
  // получить текст и очистить, без параметра «какой ключ» — как у `tv:lang`.
  "tv:oauth-error": "popup",
  "tv:oauth-error-clear": "popup",
  "tv:sb-session": "extension",
  "tv:sb-rest": "extension",
  "tv:sb-function": "extension",
  "tv:open-intent": "host",
  "tv:claim-intent": "panel",
};

function tvMessageAllowed(type, sender, extensionId, baseUrl) {
  const rule = Object.prototype.hasOwnProperty.call(TV_MESSAGE_POLICY, type)
    ? TV_MESSAGE_POLICY[type]
    : null;
  if (!rule) return false;
  if (!tvSenderIsAllowed(sender, extensionId, baseUrl)) return false;
  if (rule === "any") return true;
  if (rule === "popup") return tvSenderIsPopup(sender, extensionId, baseUrl);
  if (rule === "panel") return tvSenderIsPanel(sender, extensionId, baseUrl);
  if (rule === "host") return tvSenderIsHostPage(sender, extensionId);
  return tvSenderIsExtensionPage(sender, extensionId, baseUrl);
}

if (typeof self !== "undefined") {
  self.tvParseSelfBase = tvParseSelfBase;
  self.TV_PANEL_PAGE = TV_PANEL_PAGE;
  self.tvIsTrustedGesture = tvIsTrustedGesture;
  self.tvValidateIntent = tvValidateIntent;
  self.tvCreateSessionIntentStore = tvCreateSessionIntentStore;
  self.tvCreateActionLock = tvCreateActionLock;
  self.tvMessageAllowed = tvMessageAllowed;
  self.tvSenderIsAllowed = tvSenderIsAllowed;
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    TV_PANEL_PAGE,
    TV_MESSAGE_POLICY,
    tvIsTrustedGesture,
    tvValidateIntent,
    tvCreateSessionIntentStore,
    tvCreateActionLock,
    tvRandomNonce,
    tvMessageAllowed,
    tvParseSelfBase,
    tvSenderIsAllowed,
    tvSenderIsExtensionPage,
    tvSenderIsPopup,
    tvSenderIsPanel,
    tvSenderIsHostPage,
  };
}

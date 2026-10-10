// Chrome грузит фон как service worker: `window` там нет, зависимости
// подключает `importScripts`. Firefox MV3 service worker не поддерживает —
// фон там event page, где `importScripts` отсутствует, а зависимости
// перечислены в `background.scripts` манифеста (`manifest.firefox.json`) и
// уже загружены к этому моменту. Оба условия проверяются, а не угадываются.
if (typeof window === "undefined") self.window = self;
if (typeof importScripts === "function") importScripts("config.js", "intent.js", "oauth.js");

// Собственный адрес расширения: `chrome-extension://<id>` в Chrome и
// `moz-extension://<UUID установки>` в Firefox. Снимается один раз в
// доверенном фоне и передаётся в проверки отправителя.
function tvSelfBaseUrl() {
  try {
    return typeof chrome.runtime.getURL === "function" ? chrome.runtime.getURL("/") : "";
  } catch (_) {
    return "";
  }
}

const TV_SELF_BASE = tvSelfBaseUrl();

// Firefox-сборка ходит к сайту под ОТДЕЛЬНЫМ OAuth-клиентом: её redirect URI
// (`https://<hash>.extensions.allizom.org/auth`) не имеет chromiumapp-формы,
// под которую написан серверный allowlist. Значение выбирается ЗДЕСЬ, в
// доверенном фоне, по собственному адресу расширения — не приходит в
// сообщении и не берётся из параметра, поэтому отправитель не может выбрать
// себе клиента. Серверная сторона — отдельный этап; до неё Firefox-вход
// будет отклонён функцией `authorize`, и это ожидаемо.
const TV_OAUTH_CLIENT_ID = TV_SELF_BASE.startsWith("moz-extension:") ? "public-firefox" : "public";

chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === "install") void tvBeginInstallStateReset();
});

// Одноразовые capability живут в storage.session: остановка MV3 worker между
// открытием вкладки и claim не ломает легитимный сценарий (см. intent.js).
//
// Отсутствие области больше не валит модуль. Прежний безусловный вызов фабрики
// бросал здесь `Invalid intent storage` (intent.js), исполнение файла
// прерывалось, и `onMessage` ниже не регистрировался ВОВСЕ: расширение выглядело
// молча мёртвым, без причины в UI
// (`security/receipts/CLAUDE-PUBLIC-PUB07-DESIGN-01.md`, probe P4).
// `onInstalled` при этом уже зарегистрирован выше и не теряется.
//
// Отказ теперь названный и локальный: без области недоступны ровно intent-
// маршруты, а ping и язык продолжают работать.
const tvIntentArea = chrome.storage.session || null;
const tvIntents = tvIntentArea ? tvCreateSessionIntentStore(tvIntentArea) : null;
const TV_NO_INTENT_STORE = "Intent storage unavailable";

if (tvIntentArea?.setAccessLevel) {
  try {
    Promise.resolve(
      tvIntentArea.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" })
    ).catch(() => {});
  } catch (_) {}
}

function tvPublicSession(session) {
  if (!session?.user?.id) return null;
  return {
    expires_at: session.expires_at || null,
    user: {
      id: session.user.id,
      email: session.user.email || "",
    },
  };
}

// Зеркало `LANGS` из i18n.js: worker его не импортирует — i18n.js трогает
// `document` при загрузке и в service worker не исполним.
const TV_LANGS = ["en", "es", "ru"];

function tvNormalizeVideoId(videoId) {
  const id = String(videoId || "").trim();
  return /^[A-Za-z0-9_-]{11}$/.test(id) ? id : "";
}

// Единственный разрешённый RPC-маршрут: атомарная замена наборов папок и тегов
// одной обложки (`supabase/migration-junction-ownership-atomic.sql`). Открыт
// именно он, а не `rpc/*`: имя пришпилено, метод один, тело собирается заново по
// фиксированной форме — как у `channels` GET и `thumbnails` DELETE.
const TV_RPC_LINKS = "rpc/replace_thumbnail_links";
const TV_UUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

// Единственный разрешённый PATCH во всей поверхности (PUB-02): заметка ОДНОЙ
// своей строки thumbnails. Путь пришпилен целиком — один `id=eq.<uuid>` и
// `select=id`, ни фильтров, ни `in.(…)`, ни `neq`, ни `limit`. Это не PATCH-прокси:
// произвольное обновление таблиц по-прежнему недостижимо, а владение строкой
// проверяет сервер (RLS `own thumbnails update`), не клиент.
const TV_NOTE_PATCH = /^thumbnails\?id=eq\.[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}&select=id$/;
// Зеркало canonical-лимита (`supabase/migration-thumbnail-note-limit.sql`):
// здесь он только ограничивает тело до сети, авторитет — серверный CHECK.
const TV_NOTE_MAX = 1000;

// Тело собирается заново, как у RPC-маршрута: ровно одно поле `note` и строка.
// `user_id`, `added_at`, `views_at`, `img_url` через эту дверь не проходят —
// иначе узкая правка заметки стала бы произвольным UPDATE своей строки.
function tvNormalizeNoteBody(raw) {
  if (typeof raw !== "string" || raw.length > 20000) throw new Error("Invalid Supabase body");
  let body;
  try {
    body = JSON.parse(raw);
  } catch (_) {
    throw new Error("Invalid Supabase body");
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("Invalid Supabase body");
  const keys = Object.keys(body);
  if (keys.length !== 1 || keys[0] !== "note") throw new Error("Invalid Supabase body");
  if (typeof body.note !== "string" || body.note.length > TV_NOTE_MAX) throw new Error("Invalid Supabase body");
  return JSON.stringify({ note: body.note });
}

// Различие сохраняется дословно, потому что оно и есть контракт функции:
// `null` — «не трогай этот набор», `[]` — «очисти его». Потолки 50/100 —
// зеркало ранней проверки RPC (FIX-07 остаётся авторитетом), здесь они только
// ограничивают размер тела до разбора.
function tvNormalizeLinkSet(value, max) {
  if (value === null || value === undefined) return null;
  if (!Array.isArray(value) || value.length > max) throw new Error("Invalid Supabase body");
  for (const id of value) {
    if (typeof id !== "string" || !TV_UUID.test(id)) throw new Error("Invalid Supabase body");
  }
  return value;
}

function tvNormalizeLinkBody(raw) {
  if (typeof raw !== "string" || raw.length > 20000) throw new Error("Invalid Supabase body");
  let body;
  try {
    body = JSON.parse(raw);
  } catch (_) {
    throw new Error("Invalid Supabase body");
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("Invalid Supabase body");
  for (const key of Object.keys(body)) {
    if (key !== "p_thumbnail_id" && key !== "p_collection_ids" && key !== "p_tag_ids") {
      throw new Error("Invalid Supabase body");
    }
  }
  if (typeof body.p_thumbnail_id !== "string" || !TV_UUID.test(body.p_thumbnail_id)) {
    throw new Error("Invalid Supabase body");
  }
  const collections = tvNormalizeLinkSet(body.p_collection_ids, 50);
  const tags = tvNormalizeLinkSet(body.p_tag_ids, 100);
  // Оба `null` функция отвергает как ошибку вызывающего; не отправляем такой
  // запрос вовсе, чтобы отказ не выглядел серверным.
  if (collections === null && tags === null) throw new Error("Invalid Supabase body");
  return JSON.stringify({
    p_thumbnail_id: body.p_thumbnail_id,
    p_collection_ids: collections,
    p_tag_ids: tags,
  });
}

function tvNormalizeRestRequest(path, opts = {}) {
  if (typeof path !== "string" || !path || path.length > 2200) {
    throw new Error("Invalid Supabase path");
  }
  if (/^[a-z][a-z0-9+.-]*:/i.test(path) || path.startsWith("/") || path.includes("..")) {
    throw new Error("Invalid Supabase path");
  }

  const table = path.split("?")[0];
  const method = String(opts.method || "GET").toUpperCase();
  const allowed = {
    collections: new Set(["GET", "POST"]),
    tags: new Set(["GET", "POST"]),
    thumbnails: new Set(["DELETE", "GET", "PATCH", "POST"]),
    thumbnail_collections: new Set(["DELETE", "POST"]),
    thumbnail_tags: new Set(["DELETE", "POST"]),
    channels: new Set(["GET", "POST"]),
    [TV_RPC_LINKS]: new Set(["POST"]),
  };
  if (!allowed[table]?.has(method)) throw new Error("Supabase route not allowed");
  if (table === "channels" && method === "GET" && !/^channels\?select=id&channel_id=eq\.UC[A-Za-z0-9_-]{22}&limit=1$/.test(path)) {
    throw new Error("Supabase route not allowed");
  }
  if (table === "thumbnails" && method === "DELETE" && !/^thumbnails\?id=eq\.[0-9a-fA-F-]{36}$/.test(path)) {
    throw new Error("Supabase route not allowed");
  }
  if (table === "thumbnails" && method === "PATCH" && !TV_NOTE_PATCH.test(path)) {
    throw new Error("Supabase route not allowed");
  }
  // Ни одного query-параметра на RPC-маршруте: аргументы приходят телом.
  if (table === TV_RPC_LINKS && path !== TV_RPC_LINKS) throw new Error("Supabase route not allowed");

  const headers = {};
  const inputHeaders = opts.headers || {};
  // `Prefer` на RPC-маршрут не пробрасывается: `return=minimal` превратил бы
  // ответ функции в пустое тело, а вызывающий читает именно его, чтобы отличить
  // настоящую замену от молчаливого no-op.
  if (table !== TV_RPC_LINKS && typeof inputHeaders.Prefer === "string") {
    headers.Prefer = inputHeaders.Prefer.slice(0, 160);
  }
  // На PATCH заметки `Prefer` выбирает фон, а не вызывающий: ответ с обновлённой
  // строкой — единственный способ отличить настоящее обновление от нуля строк,
  // и `return=minimal` (как и любой другой Prefer) погасил бы это подтверждение.
  if (table === "thumbnails" && method === "PATCH") headers.Prefer = "return=representation";

  const clean = { method, headers };
  if (method !== "GET" && method !== "HEAD" && typeof opts.body === "string") {
    if (opts.body.length > 20000) throw new Error("Supabase body too large");
    clean.body = opts.body;
  }
  if (table === TV_RPC_LINKS) clean.body = tvNormalizeLinkBody(opts.body);
  if (table === "thumbnails" && method === "PATCH") clean.body = tvNormalizeNoteBody(opts.body);
  return { path, opts: clean };
}

async function tvSupabaseRaw(path, opts = {}, forcedSession = null) {
  const session = forcedSession || await tvValidSession();
  if (!session?.access_token) throw new Error("Not signed in");

  const conf = self.THUMBVAULT_CONFIG;
  const headers = {
    apikey: conf.SUPABASE_ANON_KEY,
    Authorization: `Bearer ${session.access_token}`,
    "Content-Type": "application/json",
    ...(opts.headers || {}),
  };
  return await fetch(`${conf.SUPABASE_URL}/rest/v1/${path}`, { ...opts, headers });
}

// PostgREST этого проекта отвечает `401` с кодом `PGRST303` («JWT issued at
// future») на СВЕЖИЙ, ещё не протухший токен. Причина внешняя и НЕ установлена
// (security/receipts/CLAUDE-SEC-JWT-IAT-SKEW-DATALOAD-01.md §3.4), поэтому
// правило опирается только на наблюдаемое — статус плюс код в теле — и ничего
// не знает ни о версии PostgREST, ни о часах, ни о потоках.
//
// Правило ниже — НОВЫЙ same-token retry, и только для `GET`/`HEAD`. Внутри него
// сессия не обновляется: refresh не обоснован для этого отказа. Новый токен
// получает ещё более свежий `iat` и может воспроизвести или усилить то же
// временное рассогласование; доказательства, что refresh гарантированно
// ухудшает исход, у нас нет — поэтому цикл его просто не делает, а не «лечит»
// им. Все попытки цикла уходят с одним и тем же access token, снятым до первой
// из них.
//
// Прежний refresh-путь для остальных `401` и для writes НЕ изменён — это
// сознательно оставленный residual risk, см.
// security/receipts/CLAUDE-EXT-PGRST303-RECOVERY-01.md §7 п.2.
const TV_PGRST303 = { retries: 3, baseMs: 150, capMs: 1200 };

function tvIsFutureIatDenial(status, text) {
  if (status !== 401) return false;
  try {
    return JSON.parse(text)?.code === "PGRST303";
  } catch (_) {
    return false;
  }
}

// Половинный джиттер: равномерно на [full/2, full]. Панель тянет collections и
// tags одной пачкой — без джиттера их повторы уходили бы синхронно.
function tvPgrstBackoffMs(attempt) {
  const full = Math.min(TV_PGRST303.capMs, TV_PGRST303.baseMs * 2 ** attempt);
  return full / 2 + Math.random() * (full / 2);
}

// ponytail: сигнал поддержан, но продюсера у него сегодня нет —
// `tvNormalizeRestRequest` собирает opts с нуля, а через runtime-сообщение
// AbortSignal не передаётся. Это контракт обёртки, а не рабочий путь.
function tvSleep(ms, signal) {
  if (signal?.aborted) return Promise.reject(tvAbortError(signal));
  return new Promise((resolve, reject) => {
    let onAbort = null;
    const timer = setTimeout(() => {
      if (onAbort) signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    if (signal) {
      onAbort = () => {
        clearTimeout(timer);
        reject(tvAbortError(signal));
      };
      signal.addEventListener("abort", onAbort, { once: true });
    }
  });
}

function tvAbortError(signal) {
  return signal.reason || new Error("Aborted");
}

async function tvSupabaseRest(path, opts = {}) {
  // Сессия снимается ОДИН раз. Внутри PGRST303-цикла (только GET/HEAD) не
  // допускается ни обновление сессии, ни повторное её чтение, которую мог
  // обновить кто-то другой: иначе повтор ушёл бы с другим Authorization.
  // На прежний refresh-путь ниже это ограничение не распространяется.
  const session = await tvValidSession();
  if (!session?.access_token) throw new Error("Not signed in");

  const method = String(opts.method || "GET").toUpperCase();
  const idempotent = method === "GET" || method === "HEAD";

  let res = await tvSupabaseRaw(path, opts, session);
  let text = await res.text();
  let futureIat = idempotent && tvIsFutureIatDenial(res.status, text);

  for (let attempt = 0; futureIat && attempt < TV_PGRST303.retries; attempt++) {
    await tvSleep(tvPgrstBackoffMs(attempt), opts.signal);
    res = await tvSupabaseRaw(path, opts, session);
    text = await res.text();
    futureIat = tvIsFutureIatDenial(res.status, text);
  }

  // Прежний путь для любого ДРУГОГО 401 сохранён дословно: обновить сессию и
  // повторить один раз с новой. Сюда же по-прежнему попадают writes с PGRST303 —
  // их поведение намеренно не менялось этой задачей.
  if (res.status === 401 && !futureIat) {
    const next = await tvRefreshSession();
    if (next) {
      const retry = await tvSupabaseRaw(path, opts, next);
      const retryText = await retry.text();
      if (!retry.ok) throw new Error(`${retry.status}: ${retryText}`);
      return retryText ? JSON.parse(retryText) : null;
    }
  }
  if (!res.ok) throw new Error(`${res.status}: ${text}`);
  return text ? JSON.parse(text) : null;
}

// PUB-06: у необязательного snapshot ОДИН срок на весь шаг — не по сроку на
// этап, не по сроку на попытку и не по свежему сроку на каждый контекст.
// Бюджет накрывает получение сессии, сам запрос, чтение тела, ожидание общего
// refresh после 401 и единственный повтор. Значение — выбранный default пакета,
// а не измеренная production-latency, и здесь оно служит ПОТОЛКОМ остатка.
const TV_SNAPSHOT_BUDGET_MS = 5000;

// Конечный срок приходит метаданными сообщения от `snapshotStats`. Это поле
// отправителя, поэтому оно проверяется, а не принимается на веру — но и не
// подменяется свежими пятью секундами: «не доверять» здесь значит
// валидировать, иначе задержка доставки молча продлевала бы общий срок
// (CODEX-PUBLIC-PUB06-REVIEW-01.md, F1).
//
// Правила явные: не число или не конечное значение — отказ; срок уже истёк —
// отказ ДО session lookup, refresh и сети; остаток больше нашего предела —
// срезается до него. Ни один из случаев не даёт неограниченного ожидания.
function tvSnapshotRemaining(deadline) {
  if (typeof deadline !== "number" || !Number.isFinite(deadline)) {
    throw new Error("Invalid snapshot deadline");
  }
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new Error("Snapshot deadline expired");
  return Math.min(remaining, TV_SNAPSHOT_BUDGET_MS);
}

// Ожидание чужого промиса в пределах бюджета. Сам промис НЕ отменяется: общий
// refresh обслуживает и другие операции, у snapshot нет права его обрывать —
// он лишь перестаёт его ждать. Слушатель снимается при любом исходе, а поздний
// отказ уже привязан к этому промису и не станет unhandled rejection.
function tvWithinBudget(promise, signal) {
  if (signal.aborted) return Promise.reject(tvAbortError(signal));
  let onAbort = null;
  const raced = new Promise((resolve, reject) => {
    onAbort = () => reject(tvAbortError(signal));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(resolve, reject);
  });
  return raced.finally(() => signal.removeEventListener("abort", onAbort));
}

async function tvInvokeFunction(name, body = {}, deadline = null) {
  if (name !== "refresh-views") throw new Error("Function not allowed");
  const videoId = tvNormalizeVideoId(body?.video_id);
  if (!videoId) throw new Error("Invalid videoId");
  // Срок проверяется ПЕРВЫМ: просроченный вызов не должен трогать ни сессию,
  // ни общий refresh, ни сеть.
  const remaining = tvSnapshotRemaining(deadline);
  const endsAt = Date.now() + remaining;

  // Один контроллер на весь шаг: его abort обрывает и запрос, и чтение тела —
  // клиентская отмена, которая не откатывает уже начатую серверную работу и не
  // возвращает израсходованную квоту.
  const controller = new AbortController();
  const budget = setTimeout(() => controller.abort(new Error("Snapshot budget expired")), remaining);
  // Срок сверяется по часам, а не только по своевременному callback таймера:
  // продолжение после await и каждый исходящий запрос обязаны проверять остаток
  // сами. Заодно обрывается собственный запрос/чтение тела.
  const ensureTime = () => {
    if (Date.now() < endsAt) return;
    controller.abort(new Error("Snapshot budget expired"));
    throw new Error("Snapshot budget expired");
  };
  try {
    const session = await tvWithinBudget(tvValidSession(), controller.signal);
    ensureTime();
    if (!session?.access_token) throw new Error("Not signed in");

    const conf = self.THUMBVAULT_CONFIG;
    const send = (current) => fetch(`${conf.SUPABASE_URL}/functions/v1/${name}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${current.access_token}`,
        apikey: conf.SUPABASE_ANON_KEY,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ ...body, video_id: videoId }),
      signal: controller.signal,
    });
    ensureTime();
    let res = await send(session);
    if (res.status === 401) {
      ensureTime();   // лишний refresh после истечения срока не начинаем
      // Ждём общий refresh только в пределах того же бюджета. Истёкший срок
      // выбрасывает нас отсюда ДО повтора: просроченный retry не отправляется,
      // а сам refresh продолжает жить для остальных вызывающих.
      const next = await tvWithinBudget(tvRefreshSession(), controller.signal);
      ensureTime();
      if (next) res = await send(next);
    }
    if (!res.ok) throw new Error(`${res.status}: ${await res.text()}`);
    const text = await res.text();
    return text ? JSON.parse(text) : null;
  } finally {
    clearTimeout(budget);
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // Единая политика «кто какое сообщение вправе прислать» (intent.js).
  // Host page больше не допускается ни к одному authenticated route.
  if (!tvMessageAllowed(msg?.type, sender, chrome.runtime.id, TV_SELF_BASE)) {
    sendResponse({ ok: false, error: "Blocked sender" });
    return false;
  }

  if (msg.type === "tv:ping") {
    sendResponse({ ok: true });
    return false;
  }

  // Единственное, что host-страница получает из `chrome.storage.local`: код
  // языка, и только после сверки со списком. Ни ключа, ни произвольного
  // значения наружу не уходит — это не storage-прокси, а один enum.
  if (msg.type === "tv:lang") {
    chrome.storage.local.get("tv_lang")
      .then(({ tv_lang }) => sendResponse({ ok: true, lang: TV_LANGS.includes(tv_lang) ? tv_lang : "en" }))
      .catch(() => sendResponse({ ok: true, lang: "en" }));
    return true;
  }

  // The trusted host click creates only a short-lived public intent. The
  // extension-origin panel iframe in the same source tab claims it; no new tab
  // is opened and the first click performs no account mutation.
  if (msg.type === "tv:open-intent") {
    if (!tvIntents) {
      sendResponse({ ok: false, error: TV_NO_INTENT_STORE });
      return false;
    }
    let intent;
    try {
      intent = tvValidateIntent(msg.intent || {}, sender.url);
    } catch (err) {
      sendResponse({ ok: false, error: err.message });
      return false;
    }

    (async () => {
      let nonce = null;
      try {
        nonce = await tvIntents.mint(intent, sender.tab.id);
        await tvIntents.bind(nonce, sender.tab.id);
        sendResponse({ ok: true, nonce });
      } catch (err) {
        if (nonce) await tvIntents.discard(nonce);
        sendResponse({ ok: false, error: err.message });
      }
    })();
    return true;
  }

  // Capability claim is allowed only to panel.html at extension origin and is
  // bound to the source tab that contains the embedded panel.
  if (msg.type === "tv:claim-intent") {
    if (!tvIntents) {
      sendResponse({ ok: false, error: TV_NO_INTENT_STORE });
      return false;
    }
    tvIntents.claim(msg.nonce, sender.tab.id)
      .then((intent) => sendResponse({ ok: true, intent }))
      .catch((err) => sendResponse({ ok: false, error: err.message }));
    return true;
  }

  if (msg.type === "tv:oauth-sign-in") {
    tvOAuthSignIn(TV_OAUTH_CLIENT_ID)
      .then((session) => sendResponse({ ok: true, session: tvPublicSession(session) }))
      .catch((err) => sendResponse({ ok: false, error: err.message }));
    return true;
  }

  // Диагностика прошлого входа для popup. Ключ не параметризуется: это не
  // storage-прокси, а один слот, живущий вместе с сессией.
  if (msg.type === "tv:oauth-error") {
    tvGetOAuthError()
      .then((text) => sendResponse({ ok: true, text }))
      .catch((err) => sendResponse({ ok: false, error: err.message }));
    return true;
  }

  if (msg.type === "tv:oauth-error-clear") {
    tvClearOAuthError()
      .then(() => sendResponse({ ok: true }))
      .catch((err) => sendResponse({ ok: false, error: err.message }));
    return true;
  }

  // Передаём структурный logout result: popup обязан отличать подтверждённый
  // server revoke от только локальной очистки (EXT-003).
  if (msg.type === "tv:sb-sign-out") {
    tvSignOutSession()
      .then((result) => sendResponse({ ok: true, result }))
      .catch((err) => sendResponse({ ok: false, error: err.message }));
    return true;
  }

  if (msg.type === "tv:sb-session") {
    tvValidSession()
      .then((session) => sendResponse({ ok: true, session: tvPublicSession(session) }))
      .catch((err) => sendResponse({ ok: false, error: err.message }));
    return true;
  }

  if (msg.type === "tv:sb-rest") {
    try {
      const req = tvNormalizeRestRequest(msg.path, msg.opts || {});
      tvSupabaseRest(req.path, req.opts)
        .then((data) => sendResponse({ ok: true, data }))
        .catch((err) => sendResponse({ ok: false, error: err.message }));
    } catch (err) {
      sendResponse({ ok: false, error: err.message });
    }
    return true;
  }

  if (msg.type === "tv:sb-function") {
    tvInvokeFunction(msg.name, msg.body || {}, msg.deadline)
      .then((data) => sendResponse({ ok: true, data }))
      .catch((err) => sendResponse({ ok: false, error: err.message }));
    return true;
  }

  return false;
});

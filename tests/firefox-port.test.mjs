// node --test: Firefox-порт публичного расширения.
//
// Проверяем инварианты, а не формулировки:
//   собственная база адреса берётся из runtime и сверяется по protocol+host;
//   сравнения непрозрачного origin ("null") в проверке отправителя нет;
//   в Firefox сессия и ошибка входа живут ТОЛЬКО в storage.session — без
//     fallback и без дубля в storage.local, в том числе когда область падает;
//   очередь, эпоха, ревизия, single-flight и запрет воскрешения после logout
//     работают на новом носителе так же, как на старом;
//   client_id выбирает доверенный фон, а не отправитель сообщения;
//   popup получает ошибку входа узкими сообщениями и сам storage не читает;
//   два манифеста не разъезжаются.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

import intent from "../intent.js";

const {
  tvParseSelfBase,
  tvMessageAllowed,
  tvSenderIsAllowed,
  tvSenderIsExtensionPage,
  tvSenderIsPopup,
  tvSenderIsPanel,
} = intent;

const EXT_ID = "eaglnoljaplmhgmlgahndpgeakebgmfb";
const FF_UUID = "11111111-2222-3333-4444-555555555555";
const FF_BASE = `moz-extension://${FF_UUID}/`;
const CHROME_BASE = `chrome-extension://${EXT_ID}/`;
const FF_PAGE = (path, tabId) => ({ id: EXT_ID, url: `moz-extension://${FF_UUID}${path}`, ...(tabId === undefined ? {} : { tab: { id: tabId } }) });
const CH_PAGE = (path, tabId) => ({ id: EXT_ID, url: `chrome-extension://${EXT_ID}${path}`, ...(tabId === undefined ? {} : { tab: { id: tabId } }) });

const CONFIG = {
  SUPABASE_URL: "https://project.supabase.co",
  SUPABASE_ANON_KEY: "anon-key",
  AUTH_SITE_URL: "https://thumbsight.com",
};
const CONFIG_SRC = `self.THUMBVAULT_CONFIG = ${JSON.stringify(CONFIG)};`;

const file = (name) => readFile(new URL(`../${name}`, import.meta.url), "utf8");
const src = {
  intent: await file("intent.js"),
  oauth: await file("oauth.js"),
  background: await file("background.js"),
  popup: await file("popup.js"),
  i18n: await file("i18n.js"),
  manifestChrome: JSON.parse(await file("manifest.json")),
  manifestFirefox: JSON.parse(await file("manifest.firefox.json")),
};

const SESSION = {
  access_token: `access-${"x".repeat(40)}`,
  refresh_token: "refresh-secret-1",
  token_type: "bearer",
  expires_in: 3600,
  expires_at: Math.floor(Date.now() / 1000) + 3600,
  user: { id: "user-1", email: "user@example.com" },
};
const ROTATED = { ...SESSION, access_token: `access-${"y".repeat(40)}`, refresh_token: "refresh-secret-2" };

function memoryArea(initial = {}) {
  const data = { ...initial };
  const area = {
    data,
    calls: [],
    async get(keys) {
      area.calls.push("get");
      if (keys === null || keys === undefined) return { ...data };
      const list = Array.isArray(keys) ? keys : [keys];
      return Object.fromEntries(list.filter((k) => k in data).map((k) => [k, data[k]]));
    },
    async set(values) {
      area.calls.push("set");
      Object.assign(data, values);
    },
    async remove(keys) {
      area.calls.push("remove");
      for (const k of Array.isArray(keys) ? keys : [keys]) delete data[k];
    },
    async setAccessLevel() {
      area.calls.push("setAccessLevel");
    },
  };
  return area;
}

// Фоновый контекст: config + intent + oauth (+ background по требованию),
// как их грузит расширение. `platform` меняет ТОЛЬКО собственный адрес
// расширения — ровно тот сигнал, по которому код выбирает область и client_id.
const REDIRECT = `https://${"a".repeat(40)}.extensions.allizom.org/auth`;
const AUTH_CODE = "c".repeat(64);

// `getURL` — необязательная подмена ровно того сигнала, по которому код
// опознаёт платформу: `"missing"` убирает метод, функция подставляется как
// есть (может бросать или вернуть чужую схему).
// `dropArea` убирает область storage ДО загрузки oauth.js — так выглядит
// платформа, на которой нужного носителя просто нет.
// Всё остальное не меняется.
function worker({ platform = "firefox", withBackground = false, session = null, local, fetchImpl, getURL, dropArea } = {}) {
  const base = platform === "firefox" ? FF_BASE : CHROME_BASE;
  const localArea = local === undefined ? memoryArea() : local;
  const sessionArea = memoryArea();
  if (session) (platform === "firefox" ? sessionArea : localArea).data.tv_session = session;

  let listener = null;
  const calls = [];
  // Все обращения к окну авторизации считаются: отказ входа обязан быть ДО
  // первого из них, а не после.
  const launches = [];
  const runtime = {
    id: EXT_ID,
    lastError: null,
    getURL: (path) => `${base.replace(/\/$/, "")}${path}`,
    onInstalled: { addListener() {} },
    onMessage: { addListener: (fn) => { listener = fn; } },
  };
  if (getURL === "missing") delete runtime.getURL;
  else if (typeof getURL === "function") runtime.getURL = getURL;
  const storage = { local: localArea, session: sessionArea };
  if (dropArea) delete storage[dropArea];
  const sw = {
    chrome: {
      storage,
      identity: {
        getRedirectURL: () => REDIRECT,
        // Настоящий путь входа: state берём из построенного oauth.js URL и
        // возвращаем как реальный редирект.
        launchWebAuthFlow: ({ url }, callback) => {
          launches.push(String(url));
          const state = new URL(String(url)).searchParams.get("state");
          callback(`${REDIRECT}?state=${state}&code=${AUTH_CODE}`);
        },
      },
      runtime,
    },
    crypto: globalThis.crypto,
    TextEncoder,
    URL,
    URLSearchParams,
    btoa,
    setTimeout,
    clearTimeout,
    console,
    fetch: (url, options) => {
      calls.push({ url: String(url), options });
      return fetchImpl ? fetchImpl(url, options, calls.length) : Promise.reject(new Error("network not stubbed"));
    },
  };
  sw.self = sw;
  vm.createContext(sw);
  sw.importScripts = () => {};
  vm.runInContext(CONFIG_SRC, sw, { filename: "config.js" });
  vm.runInContext(src.intent, sw, { filename: "intent.js" });
  vm.runInContext(src.oauth, sw, { filename: "oauth.js" });
  if (withBackground) vm.runInContext(src.background, sw, { filename: "background.js" });

  const send = (msg, sender) => new Promise((resolve) => {
    const async_ = listener(msg, sender, resolve);
    if (async_ !== true) resolve(undefined);
  });

  return { sw, local: localArea, session: sessionArea, calls, launches, send };
}

const plain = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));

// --------------------------------------------------- 1. проверка отправителя

test("собственная база выводится из runtime, а не из константы", () => {
  assert.deepEqual(tvParseSelfBase(FF_BASE, EXT_ID), { protocol: "moz-extension:", host: FF_UUID });
  // Без базы — прежняя Chrome-форма из extensionId: контракт старых вызовов.
  assert.deepEqual(tvParseSelfBase(undefined, EXT_ID), { protocol: "chrome-extension:", host: EXT_ID });
  // Ни базы, ни id — fail-closed.
  assert.equal(tvParseSelfBase(undefined, undefined), null);
  assert.equal(tvParseSelfBase("not a url", undefined), null);
});

test("Firefox: popup и panel проходят, чужой UUID и чужой id — нет", () => {
  assert.equal(tvSenderIsPopup(FF_PAGE("/popup.html"), EXT_ID, FF_BASE), true);
  assert.equal(tvSenderIsPanel(FF_PAGE("/panel.html", 7), EXT_ID, FF_BASE), true);
  // panel обязан быть привязан к вкладке, popup — наоборот, без tab.id
  assert.equal(tvSenderIsPanel(FF_PAGE("/panel.html"), EXT_ID, FF_BASE), false);
  assert.equal(tvSenderIsPopup(FF_PAGE("/popup.html", 7), EXT_ID, FF_BASE), true);
  // чужая установка того же браузера
  const foreignUuid = { id: EXT_ID, url: `moz-extension://99999999-8888-7777-6666-555555555555/popup.html` };
  assert.equal(tvSenderIsPopup(foreignUuid, EXT_ID, FF_BASE), false);
  // sender.id проверяется отдельно и остаётся значимым: host != runtime.id
  const foreignId = { id: "b".repeat(32), url: `moz-extension://${FF_UUID}/popup.html` };
  assert.equal(tvSenderIsExtensionPage(foreignId, EXT_ID, FF_BASE), false);
  // Chrome-страница при Firefox-базе не проходит и наоборот
  assert.equal(tvSenderIsPopup(CH_PAGE("/popup.html"), EXT_ID, FF_BASE), false);
  assert.equal(tvSenderIsPopup(FF_PAGE("/popup.html"), EXT_ID, CHROME_BASE), false);
});

test("пути popup/panel по-прежнему обязательны", () => {
  assert.equal(tvSenderIsPopup(FF_PAGE("/panel.html"), EXT_ID, FF_BASE), false);
  assert.equal(tvSenderIsPanel(FF_PAGE("/popup.html", 7), EXT_ID, FF_BASE), false);
  assert.equal(tvSenderIsPopup(FF_PAGE("/popup.html/../panel.html"), EXT_ID, FF_BASE), false);
  assert.equal(tvMessageAllowed("tv:claim-intent", FF_PAGE("/panel.html", 7), EXT_ID, FF_BASE), true);
  assert.equal(tvMessageAllowed("tv:claim-intent", FF_PAGE("/popup.html", 7), EXT_ID, FF_BASE), false);
});

test("непрозрачный origin не пропускает отправителя", () => {
  // Ловушка: в Node ВСЕ extension-схемы и неизвестные схемы дают origin "null",
  // поэтому реализация на сравнении origin прошла бы этот файл незамеченной.
  assert.equal(new URL(`${FF_BASE}popup.html`).origin, "null");
  assert.equal(new URL("tv-unknown-scheme://evil/popup.html").origin, "null");

  const opaque = { id: EXT_ID, url: "tv-unknown-scheme://evil/popup.html" };
  assert.equal(tvSenderIsExtensionPage(opaque, EXT_ID, FF_BASE), false);
  assert.equal(tvSenderIsAllowed(opaque, EXT_ID, FF_BASE), false);
  assert.equal(tvMessageAllowed("tv:sb-rest", opaque, EXT_ID, FF_BASE), false);
  assert.equal(tvMessageAllowed("tv:ping", opaque, EXT_ID, FF_BASE), false);
});

test("host-страницы и Chrome-поведение по умолчанию не изменились", () => {
  const yt = { id: EXT_ID, url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ", tab: { id: 3 } };
  assert.equal(tvMessageAllowed("tv:open-intent", yt, EXT_ID, FF_BASE), true);
  assert.equal(tvMessageAllowed("tv:sb-session", yt, EXT_ID, FF_BASE), false);
  // Вызов без базы (как во всех прежних тестах) остаётся Chrome-совместимым.
  assert.equal(tvMessageAllowed("tv:sb-session", CH_PAGE("/popup.html"), EXT_ID), true);
  assert.equal(tvMessageAllowed("tv:sb-session", FF_PAGE("/popup.html"), EXT_ID), false);
});

// --------------------------------------------------- 2. носитель сессии

test("Firefox: сессия живёт в storage.session и не появляется в local", async () => {
  const h = worker({ platform: "firefox" });
  await h.sw.tvSetSession(SESSION);
  assert.equal(h.session.data.tv_session.refresh_token, SESSION.refresh_token);
  assert.deepEqual(Object.keys(h.local.data), []);
  const read = await h.sw.tvGetSession();
  assert.equal(read.refresh_token, SESSION.refresh_token);
  assert.equal(h.sw.TV_SESSION_AREA, "session");
});

test("Chrome: носитель и setAccessLevel не изменились", async () => {
  const h = worker({ platform: "chrome" });
  await h.sw.tvSetSession(SESSION);
  assert.equal(h.local.data.tv_session.refresh_token, SESSION.refresh_token);
  assert.deepEqual(Object.keys(h.session.data), []);
  assert.equal(h.sw.TV_SESSION_AREA, "local");
  assert.ok(h.local.calls.includes("setAccessLevel"), "Chrome обязан закрыть storage.local");
});

test("Firefox: setAccessLevel не вызывается — его там нет", async () => {
  const h = worker({ platform: "firefox" });
  await h.sw.tvSetSession(SESSION);
  assert.equal(h.local.calls.includes("setAccessLevel"), false);
  assert.equal(h.session.calls.includes("setAccessLevel"), false);
});

test("Firefox: отказ области не откатывается на storage.local", async () => {
  const h = worker({ platform: "firefox" });
  // Область исчезла (гипотетический отказ платформы): операция обязана
  // отказать, а не тихо записать токен туда, где его читает content script.
  delete h.sw.chrome.storage.session;
  await assert.rejects(() => h.sw.tvSetSession(SESSION), /Session storage area unavailable/);
  assert.deepEqual(Object.keys(h.local.data), []);
  await assert.rejects(() => h.sw.tvGetSession(), /Session storage area unavailable/);
});

// R1: неопределённая платформа — это ОТКАЗ, а не «значит Chrome». Умолчание
// `local` при сбое отдавало бы refresh_token content script'ам ровно в момент
// сбоя — в Firefox `storage.local` им читается, и закрыть его нечем.
const UNDETERMINED = [
  ["getURL бросает", { getURL: () => { throw new Error("no such method"); } }],
  ["getURL отсутствует", { getURL: "missing" }],
  ["неизвестная схема", { getURL: () => "tv-unknown-scheme://evil/" }],
  ["некорректный адрес", { getURL: () => "not a url" }],
  ["пустой адрес", { getURL: () => "" }],
];

for (const [name, opts] of UNDETERMINED) {
  test(`платформа не определена (${name}): операции закрыты, storage не тронут`, async () => {
    const h = worker({ platform: "firefox", ...opts });
    assert.equal(h.sw.TV_SESSION_AREA, "", "неопознанная платформа обязана остаться без области");

    // Каждая операция слота отказывает ДО storage и ДО сети.
    await assert.rejects(() => h.sw.tvSetSession(SESSION), /Session storage area unavailable/);
    await assert.rejects(() => h.sw.tvGetSession(), /Session storage area unavailable/);
    await assert.rejects(() => h.sw.tvValidSession(), /Session storage area unavailable/);
    await assert.rejects(() => h.sw.tvRefreshSession(), /Session storage area unavailable/);
    await assert.rejects(() => h.sw.tvSignOutSession(), /Session storage area unavailable/);
    await assert.rejects(() => h.sw.tvGetOAuthError(), /Session storage area unavailable/);
    await assert.rejects(() => h.sw.tvClearOAuthError(), /Session storage area unavailable/);
    await assert.rejects(() => h.sw.tvBeginInstallStateReset(), /Session storage area unavailable/);

    // Ни одна область не получила ни ключа, ни вызова.
    assert.deepEqual(Object.keys(h.local.data), []);
    assert.deepEqual(Object.keys(h.session.data), []);
    assert.deepEqual(h.local.calls, []);
    assert.deepEqual(h.session.calls, [], "неопределённая платформа не должна открывать даже session");
    assert.deepEqual(h.calls, [], "сеть не должна вызываться при закрытой области");
  });
}

test("платформа определяется положительно: chrome-extension → local, moz-extension → session", () => {
  const cases = [
    ["chrome-extension://abc/", "local"],
    ["moz-extension://11111111-2222-3333-4444-555555555555/", "session"],
    ["safari-web-extension://abc/", ""],
    ["ms-browser-extension://abc/", ""],
    ["https://www.youtube.com/", ""],
  ];
  for (const [base, expected] of cases) {
    const h = worker({ getURL: () => base });
    assert.equal(h.sw.TV_SESSION_AREA, expected, `${base} → ${expected}`);
  }
});

// R1, остаток: вход обязан отказать ДО окна авторизации и ДО exchange, если
// сохранить результат заведомо некуда. Иначе браузер открывает окно, сервер
// выпускает одноразовый код и создаёт сессию — при уже известной невозможности
// её записать.
const SIGN_IN_CLOSED = [
  ["неизвестная схема собственного адреса", { getURL: () => "tv-unknown-scheme://evil/" }],
  ["getURL бросает", { getURL: () => { throw new Error("no such method"); } }],
  ["getURL отсутствует", { getURL: "missing" }],
  ["Firefox без storage.session", { platform: "firefox", dropArea: "session" }],
];

for (const [name, opts] of SIGN_IN_CLOSED) {
  test(`вход закрыт до launchWebAuthFlow и exchange (${name})`, async () => {
    const h = worker({ platform: "firefox", ...opts });

    // ПЕРВОЕ действие свежего контекста. Никакого предварительного
    // install-сброса: запечатанный барьер дал бы тот же отказ и замаскировал
    // бы, проверяется ли носитель вообще.
    await assert.rejects(() => h.sw.tvOAuthSignIn("public-firefox"), /Session storage area unavailable/);

    assert.deepEqual(h.launches, [], "окно авторизации открывалось");
    assert.deepEqual(h.calls, [], "exchange вызывался");
    assert.deepEqual(h.local.calls, []);
    assert.deepEqual(h.session.calls, []);
    assert.deepEqual(Object.keys(h.local.data), []);
    assert.deepEqual(Object.keys(h.session.data), []);
  });
}

function exchangeStub(payload) {
  return async (url) => {
    if (!String(url).endsWith("/functions/v1/exchange")) throw new Error(`unexpected fetch: ${url}`);
    return new Response(JSON.stringify(payload), { status: 200, headers: { "Content-Type": "application/json" } });
  };
}

test("обычный вход проходит на обеих платформах и ложится в свою область", async () => {
  for (const [platform, clientId, area, other] of [
    ["firefox", "public-firefox", "session", "local"],
    ["chrome", "public", "local", "session"],
  ]) {
    const h = worker({ platform, fetchImpl: exchangeStub(SESSION) });
    const signed = await h.sw.tvOAuthSignIn(clientId);

    assert.equal(signed.refresh_token, SESSION.refresh_token, `${platform}: сессия не возвращена`);
    assert.equal(h.launches.length, 1, `${platform}: окно авторизации должно открыться ровно раз`);
    assert.equal(h.calls.length, 1, `${platform}: exchange должен быть ровно один`);

    // client_id уходит и в URL авторизации, и в тело exchange — тем, что передал фон.
    assert.equal(new URL(h.launches[0]).searchParams.get("client_id"), clientId);
    assert.equal(JSON.parse(h.calls[0].options.body).client_id, clientId);

    // Носитель — тот, что выбран по платформе; вторая область пуста.
    assert.equal(h[area].data.tv_session.refresh_token, SESSION.refresh_token);
    assert.deepEqual(Object.keys(h[other].data), [], `${platform}: сессия продублирована в ${other}`);
    assert.equal((await h.sw.tvGetSession()).refresh_token, SESSION.refresh_token);
  }
});

test("Firefox: ошибка входа тоже в session, popup получает её сообщением", async () => {
  const h = worker({ platform: "firefox", withBackground: true });
  h.session.data.tv_oauth_error = "Authorization failed: invalid_client";
  const res = plain(await h.send({ type: "tv:oauth-error" }, FF_PAGE("/popup.html")));
  assert.deepEqual(res, { ok: true, text: "Authorization failed: invalid_client" });
  assert.deepEqual(Object.keys(h.local.data), []);

  const cleared = plain(await h.send({ type: "tv:oauth-error-clear" }, FF_PAGE("/popup.html")));
  assert.deepEqual(cleared, { ok: true });
  assert.equal("tv_oauth_error" in h.session.data, false);
});

test("слот ошибки входа доступен только popup и не параметризуется", async () => {
  const h = worker({ platform: "firefox", withBackground: true });
  h.session.data.tv_oauth_error = "diagnostic";
  const yt = { id: EXT_ID, url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ", tab: { id: 3 } };
  for (const sender of [yt, FF_PAGE("/panel.html", 3)]) {
    assert.deepEqual(plain(await h.send({ type: "tv:oauth-error" }, sender)), { ok: false, error: "Blocked sender" });
    assert.deepEqual(plain(await h.send({ type: "tv:oauth-error-clear" }, sender)), { ok: false, error: "Blocked sender" });
  }
  // Посторонние поля игнорируются: ключ не выбирается вызывающим.
  const res = plain(await h.send({ type: "tv:oauth-error", key: "tv_session" }, FF_PAGE("/popup.html")));
  assert.deepEqual(res, { ok: true, text: "diagnostic" });
  assert.equal(JSON.stringify(res).includes(SESSION.refresh_token), false);
});

test("popup.js не читает storage сам", () => {
  assert.equal(/chrome\.storage\.local\.(get|remove|set)\(\s*["']tv_oauth_error/.test(src.popup), false);
  assert.match(src.popup, /sendRuntimeMessage\(\{ type: "tv:oauth-error" \}\)/);
  assert.match(src.popup, /sendRuntimeMessage\(\{ type: "tv:oauth-error-clear" \}\)/);
});

// --------------------------------------------------- 3. инварианты сессии

test("Firefox: install-сброс чистит оба ключа в своей области", async () => {
  const h = worker({ platform: "firefox" });
  await h.sw.tvSetSession(SESSION);
  h.session.data.tv_oauth_error = "stale";
  await h.sw.tvBeginInstallStateReset();
  assert.deepEqual(Object.keys(h.session.data), []);
  assert.equal(await h.sw.tvGetSession(), null);
});

test("Firefox: logout удаляет сессию до сети и не воскрешается поздним refresh", async () => {
  let refreshResolve;
  const gate = new Promise((r) => { refreshResolve = r; });
  const h = worker({
    platform: "firefox",
    session: SESSION,
    fetchImpl: async (url) => {
      if (String(url).includes("/auth/v1/token")) {
        await gate;
        return new Response(JSON.stringify(ROTATED), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      return new Response(null, { status: 204 });
    },
  });

  // refresh стартовал и держит сеть
  const pending = h.sw.tvRefreshSession();
  await new Promise((r) => setImmediate(r));
  const logout = await h.sw.tvSignOutSession();
  assert.equal(logout.localCleared, true);
  assert.equal("tv_session" in h.session.data, false);

  refreshResolve();
  await pending.catch(() => {});
  assert.equal("tv_session" in h.session.data, false, "поздний refresh воскресил сессию");
  assert.deepEqual(Object.keys(h.local.data), []);
  assert.equal(await h.sw.tvGetSession(), null);
});

test("Firefox: single-flight — параллельные refresh дают один запрос", async () => {
  let calls = 0;
  const h = worker({
    platform: "firefox",
    session: { ...SESSION, expires_at: Math.floor(Date.now() / 1000) - 10 },
    fetchImpl: async () => {
      calls++;
      return new Response(JSON.stringify(ROTATED), { status: 200, headers: { "Content-Type": "application/json" } });
    },
  });
  const [a, b, c] = await Promise.all([h.sw.tvValidSession(), h.sw.tvValidSession(), h.sw.tvValidSession()]);
  assert.equal(calls, 1, "refresh обязан быть один на всех");
  for (const s of [a, b, c]) assert.equal(s.refresh_token, ROTATED.refresh_token);
  assert.equal(h.session.data.tv_session.refresh_token, ROTATED.refresh_token);
  assert.deepEqual(Object.keys(h.local.data), []);
});

test("Firefox: невалидный refresh-token чистит именно свою сессию", async () => {
  const h = worker({
    platform: "firefox",
    session: { ...SESSION, expires_at: Math.floor(Date.now() / 1000) - 10 },
    fetchImpl: async () => new Response("{}", { status: 400 }),
  });
  assert.equal(await h.sw.tvValidSession(), null);
  assert.equal("tv_session" in h.session.data, false);
});

// --------------------------------------------------- 4. client_id и фон

test("client_id выбирает фон по собственному адресу, а не сообщение", async () => {
  for (const [platform, expected] of [["firefox", "public-firefox"], ["chrome", "public"]]) {
    const h = worker({ platform, withBackground: true });
    const seen = [];
    h.sw.tvOAuthSignIn = async (clientId) => { seen.push(clientId); return SESSION; };
    const sender = platform === "firefox" ? FF_PAGE("/popup.html") : CH_PAGE("/popup.html");
    const res = plain(await h.send({ type: "tv:oauth-sign-in", client_id: "admin", clientId: "admin" }, sender));
    assert.equal(res.ok, true);
    assert.deepEqual(seen, [expected]);
    // Наружу уходит только публичная часть сессии.
    assert.equal(JSON.stringify(res).includes(SESSION.access_token), false);
    assert.equal(JSON.stringify(res).includes(SESSION.refresh_token), false);
  }
});

test("background грузит зависимости совместимо с обоими браузерами", () => {
  assert.match(src.background, /if \(typeof window === "undefined"\) self\.window = self;/);
  assert.match(src.background, /if \(typeof importScripts === "function"\) importScripts\("config\.js", "intent\.js", "oauth\.js"\);/);
  // client_id выводится из собственного адреса и является константой модуля.
  assert.match(src.background, /const TV_OAUTH_CLIENT_ID = TV_SELF_BASE\.startsWith\("moz-extension:"\)/);
  assert.equal(/tvOAuthSignIn\(\s*"public"\s*\)/.test(src.background), false);
});

test("i18n определяет доверенный контекст по собственному адресу", () => {
  assert.equal(/=== "chrome-extension:"/.test(src.i18n), false, "константа схемы вернулась в i18n");
  assert.match(src.i18n, /chrome\.runtime\.getURL\("\/"\)/);
  // Content script по-прежнему не читает storage напрямую — только сообщение.
  assert.match(src.i18n, /chrome\.runtime\.sendMessage\(\{ type: "tv:lang" \}/);
});

// --------------------------------------------------- 5. манифесты

test("манифесты Chrome и Firefox не разъезжаются", () => {
  const c = src.manifestChrome;
  const f = src.manifestFirefox;
  for (const key of ["manifest_version", "name", "version", "default_locale", "description", "icons", "permissions", "host_permissions", "content_security_policy", "action", "content_scripts", "web_accessible_resources"]) {
    assert.deepEqual(f[key], c[key], `${key} разошёлся между манифестами`);
  }
  // Chrome-only ключи в Firefox-манифест не попадают и наоборот.
  assert.equal("key" in f, false);
  assert.equal("version_name" in f, false);
  assert.equal("service_worker" in (f.background || {}), false);
  assert.equal("browser_specific_settings" in c, false);
  assert.equal("scripts" in (c.background || {}), false);

  assert.deepEqual(f.background.scripts, ["config.js", "intent.js", "oauth.js", "background.js"]);
  const imported = src.background.match(/importScripts\(([^)]*)\)/)[1].match(/"([^"]+)"/g).map((s) => s.slice(1, -1));
  assert.deepEqual(f.background.scripts.slice(0, 3), imported, "порядок загрузки зависимостей разошёлся");

  assert.match(f.browser_specific_settings.gecko.id, /^[^\s@]+@[^\s@]+$/);
  assert.ok(f.browser_specific_settings.gecko.strict_min_version, "нужен пол по версии Firefox");
  // Права остаются узкими: порт их не расширяет.
  assert.deepEqual(f.permissions, ["storage", "identity"]);
});

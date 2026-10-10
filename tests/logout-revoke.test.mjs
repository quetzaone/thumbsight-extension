// node --test: контракт logout активных расширений (EXT-003).
//
// Проверяем инварианты, а не формулировки:
//   локальный доступ закрывается всегда и ДО сети;
//   подтверждение server revoke не подделывается ни при exception, ни при non-OK;
//   retry ограничен и не повторяет обычные 4xx;
//   поздний refresh и новый login не страдают от завершения старого logout;
//   в result, UI и логах нет токенов и тела ответа Supabase.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

// В public-only экспорте соседнего admin/ нет: там проверяется один вариант.
// В monorepo (умолчание) проверяются оба — см. tests/scope.mjs.
import { VARIANTS, variantRoot } from "./scope.mjs";

const EXT_ID = "a".repeat(32);
const ACCESS_TOKEN = `access-${"x".repeat(40)}`;
const REFRESH_TOKEN = "refresh-secret-1";
const SERVER_BODY = "internal supabase diagnostic body";
// Внутренняя диагностика storage: наружу, в сообщение об отказе, попасть не должна.
const STORAGE_FAILURE = "storage unavailable";
const SEALED = /Session unavailable: install state reset failed/;
const CONFIG = {
  SUPABASE_URL: "https://project.supabase.co",
  SUPABASE_ANON_KEY: "anon-key",
  AUTH_SITE_URL: "https://thumbsight.com",
};
const CONFIG_SRC = `self.THUMBVAULT_CONFIG = ${JSON.stringify(CONFIG)};`;

const src = {};
for (const variant of VARIANTS) {
  const file = (name) => readFile(new URL(name, variantRoot(variant)), "utf8");
  src[variant] = {
    oauth: await file("oauth.js"),
    background: await file("background.js"),
    supabase: await file("supabase.js"),
    popup: await file("popup.js"),
    popupHtml: await file("popup.html"),
  };
}
src.public.intent = await readFile(new URL("../intent.js", import.meta.url), "utf8");

function memoryArea(initial = {}) {
  const data = { ...initial };
  return {
    data,
    async get(keys) {
      if (keys === null || keys === undefined) return { ...data };
      const list = Array.isArray(keys) ? keys : [keys];
      return Object.fromEntries(list.filter((key) => key in data).map((key) => [key, data[key]]));
    },
    async set(values) {
      Object.assign(data, values);
    },
    async remove(keys) {
      for (const key of Array.isArray(keys) ? keys : [keys]) delete data[key];
    },
    async setAccessLevel() {},
  };
}

// Модель chrome.storage для гонок. Мгновенный memoryArea физически не может
// показать чужую операцию, обслуженную МЕЖДУ чтением и записью, — окно, в
// котором жил TASK-03 F-01. Здесь операции применяются с задержкой, а `ops`
// хранит порядок постановки.
//
//   reorder=false — FIFO-бэкенд: порядок завершения = порядок старта;
//   reorder=true  — враждебный бэкенд: операции, стартовавшие до того, как
//                   предыдущая партия завершилась, завершаются в ОБРАТНОМ
//                   порядке. chrome.storage нигде не обещает FIFO, поэтому
//                   механизм обязан быть к порядку завершения безразличен.
//
// Счётчики пересечений считаются в момент ПОСТАНОВКИ операции и снимаются в
// момент её применения, поэтому они меряют конкурентность вызывающего кода, а
// не бэкенда, и одинаковы для обеих конфигураций:
//   `maxMutations` — одновременно начатые записи `tv_session` (set/remove);
//   `maxProtected` — одновременно начатые ЛЮБЫЕ операции с `tv_session`,
//     включая чтения. Только он видит пересечение чтения с выполняющейся
//     мутацией — дефект, стоивший ревизии 02 подтверждённого HIGH.
//
// `holdNext(kind)` — управляемые ворота: держат конкретную операцию «начатой,
// но не завершённой», пока тест её не отпустит. Без них mutation-first сценарий
// («мутация уже выполняется, в этот момент стартует refresh») недетерминирован.
// Удержание ведёт себя по-разному и это намеренно:
//   fifo     — держит и очередь: бэкенд, сохраняющий порядок, физически не
//              может обслужить более позднюю операцию раньше висящей;
//   reorder  — держит только саму операцию, остальные продолжают
//              обслуживаться. Так ведёт себя реальный асинхронный storage:
//              параллельный get может вернуть данные раньше, чем завершится
//              уже начатый remove.
//
// `failNext(kind)` — одноразовая инъекция отказа storage. Нужна для барьера
// install-сброса: без падающего `remove` контракт fail-closed нечем проверить.
function storageArea({ initial = {}, ticks = 3, reorder = false } = {}) {
  const data = { ...initial };
  const ops = [];
  const holds = [];
  const fails = [];
  const area = { data, ops, maxMutations: 0, maxProtected: 0, reorder };
  let live = 0;
  let open = 0;
  let tail = Promise.resolve();
  let pending = [];
  let scheduled = false;

  area.holdNext = (kind, key = "tv_session") => {
    const started = deferred();
    const release = deferred();
    holds.push({ kind, key, started, release, taken: false });
    return { started: started.promise, release: () => release.resolve() };
  };

  area.failNext = (kind, key = "tv_session") => {
    fails.push({ kind, key, taken: false });
  };

  const takeHold = (item) => {
    const hold = holds.find((h) => !h.taken && h.kind === item.kind && item.list.includes(h.key));
    if (hold) hold.taken = true;
    return hold;
  };

  // Счётчики снимаются в finally: отказавшая операция не должна навсегда
  // остаться «начатой» и отравить maxProtected всем следующим тестам сценария.
  const applyItem = (item) => {
    try {
      const fail = fails.find((f) => !f.taken && f.kind === item.kind && item.list.includes(f.key));
      if (fail) {
        fail.taken = true;
        throw new Error(STORAGE_FAILURE);
      }
      return item.apply();
    } finally {
      if (item.touches) open--;
      if (item.mutation) live--;
    }
  };

  const settleItem = (item) => {
    try {
      item.resolve(applyItem(item));
    } catch (err) {
      item.reject(err);
    }
  };

  const flush = async () => {
    for (let i = 0; i < ticks; i++) await new Promise((resolve) => setTimeout(resolve, 0));
    scheduled = false;
    const batch = pending.reverse();
    pending = [];
    for (const item of batch) {
      const hold = takeHold(item);
      if (hold) {
        // Висящая операция не блокирует бэкенд: остальные обслуживаются, пока
        // она «в процессе». Это и есть окно, в котором чтение возвращает
        // сессию, которую выполняющийся remove уже решил удалить.
        hold.started.resolve();
        void hold.release.promise.then(() => settleItem(item));
        continue;
      }
      settleItem(item);
    }
  };

  const enqueue = (kind, keys, apply) => {
    ops.push(kind);
    const list = Array.isArray(keys) ? keys : [keys];
    const touches = list.includes("tv_session");
    const mutation = kind !== "get" && touches;
    if (touches) {
      open++;
      area.maxProtected = Math.max(area.maxProtected, open);
    }
    if (mutation) {
      live++;
      area.maxMutations = Math.max(area.maxMutations, live);
    }
    const item = { kind, list, apply, touches, mutation };
    if (!reorder) {
      const run = tail.then(async () => {
        for (let i = 0; i < ticks; i++) await new Promise((resolve) => setTimeout(resolve, 0));
        const hold = takeHold(item);
        if (hold) {
          hold.started.resolve();
          await hold.release.promise;
        }
        return applyItem(item);
      });
      tail = run.then(() => {}, () => {});
      return run;
    }
    return new Promise((resolve, reject) => {
      pending.push({ ...item, resolve, reject });
      if (scheduled) return;
      scheduled = true;
      void flush();
    });
  };

  area.get = (keys) =>
    enqueue("get", keys, () => {
      if (keys === null || keys === undefined) return { ...data };
      const list = Array.isArray(keys) ? keys : [keys];
      return Object.fromEntries(list.filter((key) => key in data).map((key) => [key, data[key]]));
    });
  area.set = (values) =>
    enqueue("set", Object.keys(values), () => { Object.assign(data, values); });
  area.remove = (keys) =>
    enqueue("remove", keys, () => {
      for (const key of Array.isArray(keys) ? keys : [keys]) delete data[key];
    });
  area.setAccessLevel = async () => {};
  return area;
}

const fifoArea = (initial) => storageArea({ initial });
const reorderArea = (initial) => storageArea({ initial, reorder: true });
const BACKENDS = [["fifo", fifoArea], ["reorder", reorderArea]];

function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

function session(refreshToken = REFRESH_TOKEN, expiresAt = Math.floor(Date.now() / 1000) + 3600) {
  return {
    access_token: ACCESS_TOKEN,
    refresh_token: refreshToken,
    token_type: "bearer",
    expires_in: 3600,
    expires_at: expiresAt,
    user: { id: "user-1", email: "user@example.com" },
  };
}

function collector() {
  const logs = [];
  const push = (...args) => {
    logs.push(args.map((a) => (typeof a === "string" ? a : safeJson(a))).join(" "));
  };
  return { logs, console: { log: push, info: push, warn: push, error: push, debug: push } };
}

function safeJson(value) {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

// Результаты приходят из другого realm (vm): сравниваем по значению.
const plain = (value) => ({ ...value });

async function settle(ticks = 30) {
  for (let i = 0; i < ticks; i++) await new Promise((resolve) => setTimeout(resolve, 0));
}

async function waitFor(predicate) {
  for (let i = 0; i < 50; i++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error("condition not reached");
}

// Только oauth.js: тонкий контекст для матрицы статусов/ошибок сети.
function oauthHarness(variant, fetchImpl, initialSession = session(), makeArea = memoryArea) {
  const local = makeArea(initialSession ? { tv_session: initialSession } : {});
  const calls = [];
  const { logs, console: consoleStub } = collector();
  const context = {
    chrome: {
      storage: { local },
      identity: {
        getRedirectURL: () => `https://${EXT_ID}.chromiumapp.org/auth`,
        // Настоящий путь входа: state берём из построенного oauth.js URL и
        // возвращаем как реальный редирект, чтобы вход шёл через tvOAuthSignIn.
        launchWebAuthFlow: ({ url }, callback) => {
          const state = new URL(url).searchParams.get("state");
          callback(`https://${EXT_ID}.chromiumapp.org/auth?state=${state}&code=${"c".repeat(64)}`);
        },
      },
      // `getURL` обязателен: носитель сессии выбирается по СХЕМЕ собственного
      // адреса и при неопознанной платформе закрывает все операции. Стенд
      // обязан давать настоящую форму runtime API, а не полагаться на
      // умолчание (CODEX-EXT-FIREFOX-IMPLEMENTATION-REVIEW-01, R1).
      runtime: {
        id: EXT_ID,
        lastError: null,
        getURL: (path) => `chrome-extension://${EXT_ID}${path.startsWith("/") ? "" : "/"}${path}`,
      },
    },
    crypto: globalThis.crypto,
    TextEncoder,
    URL,
    URLSearchParams,
    btoa,
    console: consoleStub,
    fetch: (url, options) => {
      calls.push({ url, options });
      return fetchImpl(url, options, calls.length);
    },
  };
  context.self = context;
  context.THUMBVAULT_CONFIG = CONFIG;
  vm.runInNewContext(src[variant].oauth, context, { filename: `${variant}/oauth.js` });
  return { context, storage: local.data, ops: local.ops, area: local, calls, logs };
}

// Полная цепочка: service worker (background.js + oauth.js) → runtime message →
// supabase.js → popup.js с минимальным DOM-стабом.
// `options.i18n` подставляет TVI18N с двумя языками: его apply(), как настоящий,
// затирает #status и #bgStatus переводом из data-i18n.
function chainHarness(variant, fetchImpl, initialSession = session(), options = {}) {
  const local = memoryArea(initialSession ? { tv_session: initialSession } : {});
  const calls = [];
  const { logs, console: consoleStub } = collector();
  const fetchStub = (url, options) => {
    calls.push({ url, options });
    return fetchImpl(url, options, calls.length);
  };

  let listener = null;
  let installListener = null;
  const sw = {
    chrome: {
      storage: { local, session: memoryArea() },
      identity: { getRedirectURL: () => `https://${EXT_ID}.chromiumapp.org/auth` },
      runtime: {
        id: EXT_ID,
        lastError: null,
        getURL: (path) => `chrome-extension://${EXT_ID}/${path}`,
        onInstalled: { addListener: (fn) => { installListener = fn; } },
        onMessage: { addListener: (fn) => { listener = fn; } },
      },
      tabs: { create() {}, remove() {} },
    },
    crypto: globalThis.crypto,
    TextEncoder,
    URL,
    URLSearchParams,
    btoa,
    setTimeout,
    clearTimeout,
    console: consoleStub,
    fetch: fetchStub,
  };
  sw.self = sw;
  vm.createContext(sw);
  sw.importScripts = (...names) => {
    for (const name of names) {
      const key = name.replace(/\.js$/, "");
      const code = key === "config" ? CONFIG_SRC : src[variant][key];
      if (!code) throw new Error(`missing importScripts source: ${name}`);
      vm.runInContext(code, sw, { filename: `${variant}/${name}` });
    }
  };
  vm.runInContext(src[variant].background, sw, { filename: `${variant}/background.js` });
  assert.ok(listener, "background не зарегистрировал onMessage listener");

  const elements = new Map();
  const handlers = new Map();
  const element = (id) => {
    if (!elements.has(id)) {
      elements.set(id, {
        id,
        textContent: "",
        // Зеркалит разметку: предупреждение и форма входа по умолчанию скрыты.
        hidden: id === "logoutWarn" || id === "login",
        disabled: false,
        value: "50",
        href: "",
        style: {},
        children: [],
        classList: { toggle() {}, add() {}, remove() {} },
        setAttribute() {},
        appendChild(child) { this.children.push(child); },
        addEventListener(type, fn) { handlers.set(`${id}:${type}`, fn); },
      });
    }
    return elements.get(id);
  };
  // Ровно то, что строит renderLanguageMenu: кнопка с подписью и обработчиком.
  // Только с `options.i18n`: без него меню не строится, как и раньше.
  const createElement = (tag) => ({
    tag,
    textContent: "",
    children: [],
    listeners: {},
    setAttribute() {},
    append(...nodes) { this.children.push(...nodes); },
    addEventListener(type, fn) { this.listeners[type] = fn; },
  });

  const messages = [];
  const page = {
    document: options.i18n ? { getElementById: element, createElement } : { getElementById: element },
    chrome: {
      storage: { local },
      runtime: {
        id: EXT_ID,
        lastError: null,
        getURL: (path) => `chrome-extension://${EXT_ID}/${path}`,
        sendMessage: (message, callback) => {
          messages.push(message.type);
          listener(message, { id: EXT_ID, url: `chrome-extension://${EXT_ID}/popup.html` }, callback);
        },
      },
    },
    console: consoleStub,
    setTimeout,
    clearTimeout,
    URL,
  };
  page.window = page;
  page.THUMBVAULT_CONFIG = CONFIG;
  if (options.i18n) {
    const i18n = {
      LANGS: ["en", "ru"],
      NAMES: { en: "English", ru: "Русский" },
      lang: "en",
      ready: Promise.resolve("en"),
      t: (key) => `${i18n.lang}:${key}`,
      apply() {
        element("status").textContent = i18n.t("signInStatus");
        element("bgStatus").textContent = i18n.t("ready");
      },
      async setLang(code) {
        i18n.lang = code;
        i18n.apply();
      },
    };
    page.TVI18N = i18n;
  }
  vm.createContext(page);
  vm.runInContext(src[variant].supabase, page, { filename: `${variant}/supabase.js` });
  vm.runInContext(src[variant].popup, page, { filename: `${variant}/popup.js` });

  return {
    page,
    storage: local.data,
    calls,
    logs,
    elements,
    messages,
    click: (id) => handlers.get(`${id}:click`)(),
    // Клик по последней построенной опции языка с этой подписью.
    clickLang: (name) => element("langMenu").children
      .filter((option) => option.children[0]?.textContent === name)
      .at(-1)
      .listeners.click(),
    install: async (reason) => {
      assert.ok(installListener, "background не зарегистрировал onInstalled listener");
      installListener({ reason });
      await settle();
    },
  };
}

const respond = (status, body = SERVER_BODY) => async () =>
  new Response(status === 204 ? null : body, { status });

const chainFetch = (logoutResponder) => async (url, options, n) => {
  if (String(url).includes("/auth/v1/logout")) return await logoutResponder(url, options, n);
  return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
};

for (const variant of VARIANTS) {
  test(`${variant}: новый install очищает сохранённую сессию, update сохраняет`, async () => {
    const fresh = chainHarness(variant, chainFetch(respond(204)));
    fresh.storage.tv_oauth_error = "old error";
    await fresh.install("install");
    assert.equal(fresh.storage.tv_session, undefined);
    assert.equal(fresh.storage.tv_oauth_error, undefined);

    const update = chainHarness(variant, chainFetch(respond(204)));
    await update.install("update");
    assert.equal(update.storage.tv_session?.refresh_token, REFRESH_TOKEN);
  });
}

for (const variant of VARIANTS) {
  test(`${variant}: 204 — локальная сессия удалена до запроса, revoke подтверждён`, async () => {
    let storageAtRequest = null;
    const h = oauthHarness(variant, async () => {
      storageAtRequest = { ...h.storage };
      return new Response(null, { status: 204 });
    });

    const result = await h.context.tvSignOutSession();
    assert.deepEqual(plain(result), {
      localCleared: true,
      remoteRevoked: true,
      hadSession: true,
      attempts: 1,
      reason: "revoked",
    });
    assert.equal(storageAtRequest.tv_session, undefined, "storage обязан быть пуст ДО сетевого запроса");
    assert.equal(h.storage.tv_session, undefined);
    assert.equal(h.calls.length, 1);
    assert.match(h.calls[0].url, /\/auth\/v1\/logout\?scope=local$/);
    assert.equal(h.calls[0].options.method, "POST");
    assert.equal(h.calls[0].options.headers.Authorization, `Bearer ${ACCESS_TOKEN}`);
  });

  test(`${variant}: network exception — ограниченный retry и честный отказ`, async () => {
    const h = oauthHarness(variant, async () => {
      throw new TypeError("Failed to fetch");
    });

    const result = await h.context.tvSignOutSession();
    assert.deepEqual(plain(result), {
      localCleared: true,
      remoteRevoked: false,
      hadSession: true,
      attempts: 3,
      reason: "network",
    });
    assert.equal(h.calls.length, 3);
    assert.equal(h.storage.tv_session, undefined, "сессия не восстанавливается после неудачного revoke");
  });

  test(`${variant}: 503 — ограниченный retry, remoteRevoked:false, без тела ответа`, async () => {
    const h = oauthHarness(variant, respond(503));
    const result = await h.context.tvSignOutSession();
    assert.deepEqual(plain(result), {
      localCleared: true,
      remoteRevoked: false,
      hadSession: true,
      attempts: 3,
      reason: "server_error",
    });
    assert.equal(h.calls.length, 3);
    assert.ok(!JSON.stringify(result).includes(SERVER_BODY));
    assert.equal(h.storage.tv_session, undefined);
  });

  test(`${variant}: 429 — ограниченный retry без бесконечного цикла`, async () => {
    const h = oauthHarness(variant, respond(429));
    const result = await h.context.tvSignOutSession();
    assert.equal(result.remoteRevoked, false);
    assert.equal(result.attempts, 3);
    assert.equal(result.reason, "rate_limited");
    assert.equal(h.calls.length, 3);
  });

  test(`${variant}: 401 и 403 — без retry и без ложного успеха`, async () => {
    for (const status of [401, 403]) {
      const h = oauthHarness(variant, respond(status));
      const result = await h.context.tvSignOutSession();
      assert.deepEqual(plain(result), {
        localCleared: true,
        remoteRevoked: false,
        hadSession: true,
        attempts: 1,
        reason: "unauthorized",
      });
      assert.equal(h.calls.length, 1, `${status} не должен повторяться`);
      assert.equal(h.storage.tv_session, undefined);
    }
  });

  test(`${variant}: неожиданный non-OK — отказ без сырой диагностики`, async () => {
    const h = oauthHarness(variant, respond(418));
    const result = await h.context.tvSignOutSession();
    assert.deepEqual(plain(result), {
      localCleared: true,
      remoteRevoked: false,
      hadSession: true,
      attempts: 1,
      reason: "unexpected_status",
    });
    assert.equal(h.calls.length, 1);
    const blob = JSON.stringify(result);
    assert.ok(!blob.includes(SERVER_BODY));
    assert.ok(!blob.includes("418"));
  });

  test(`${variant}: отсутствующая сессия — идемпотентный logout без запроса`, async () => {
    const h = oauthHarness(variant, respond(204), null);
    const result = await h.context.tvSignOutSession();
    assert.deepEqual(plain(result), {
      localCleared: true,
      remoteRevoked: false,
      hadSession: false,
      attempts: 0,
      reason: "no_session",
    });
    assert.equal(h.calls.length, 0);
    assert.equal(h.storage.tv_session, undefined);
  });

  test(`${variant}: запоздалый refresh не воскрешает вышедшую сессию`, async () => {
    let releaseRefresh = null;
    const h = oauthHarness(
      variant,
      (url) => {
        if (String(url).includes("/auth/v1/token")) {
          return new Promise((resolve) => { releaseRefresh = resolve; });
        }
        return Promise.resolve(new Response(null, { status: 204 }));
      },
      session(REFRESH_TOKEN, Math.floor(Date.now() / 1000) - 1),
    );

    const refreshing = h.context.tvRefreshSession();
    await waitFor(() => h.calls.length === 1);

    const logout = await h.context.tvSignOutSession();
    assert.equal(logout.remoteRevoked, true);
    assert.equal(h.storage.tv_session, undefined);

    releaseRefresh(new Response(JSON.stringify(session("rotated")), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }));
    assert.equal(await refreshing, null);
    assert.equal(h.storage.tv_session, undefined, "поздний refresh не должен переписать logout");
  });

  test(`${variant}: новый login во время ожидающего revoke не удаляется`, async () => {
    // Подтверждённый revoke старого токена.
    let release = null;
    const ok = oauthHarness(variant, () => new Promise((resolve) => { release = resolve; }));
    const pending = ok.context.tvSignOutSession();
    await waitFor(() => ok.calls.length === 1);
    ok.storage.tv_session = session("new-login");
    release(new Response(null, { status: 204 }));
    assert.equal((await pending).remoteRevoked, true);
    assert.equal(ok.storage.tv_session.refresh_token, "new-login");

    // То же самое при неудачном revoke.
    const failed = oauthHarness(variant, async () => {
      if (failed.calls.length === 1) failed.storage.tv_session = session("new-login");
      return new Response(SERVER_BODY, { status: 503 });
    });
    const result = await failed.context.tvSignOutSession();
    assert.equal(result.remoteRevoked, false);
    assert.equal(failed.storage.tv_session.refresh_token, "new-login");
  });

  test(`${variant}: повторный и одновременный logout ограничены и безопасны`, async () => {
    const repeat = oauthHarness(variant, respond(204));
    const first = await repeat.context.tvSignOutSession();
    const second = await repeat.context.tvSignOutSession();
    assert.equal(first.reason, "revoked");
    assert.deepEqual(plain(second), {
      localCleared: true,
      remoteRevoked: false,
      hadSession: false,
      attempts: 0,
      reason: "no_session",
    });
    assert.equal(repeat.calls.length, 1, "повторный logout не шлёт лишних запросов");

    const concurrent = oauthHarness(variant, respond(503));
    const results = await Promise.all([
      concurrent.context.tvSignOutSession(),
      concurrent.context.tvSignOutSession(),
    ]);
    assert.ok(concurrent.calls.length <= 6, `fan-out не ограничен: ${concurrent.calls.length}`);
    for (const result of results) {
      assert.equal(result.localCleared, true);
      assert.equal(result.remoteRevoked, false);
    }
    assert.equal(concurrent.storage.tv_session, undefined);
  });

  test(`${variant}: background → SB.signOut() → popup различает confirmed и local-only`, async () => {
    const confirmed = chainHarness(variant, chainFetch(async () => new Response(null, { status: 204 })));
    await settle();
    const result = await confirmed.page.SB.signOut();
    assert.deepEqual(plain(result), {
      localCleared: true,
      remoteRevoked: true,
      hadSession: true,
      attempts: 1,
      reason: "revoked",
    });

    const okUi = chainHarness(variant, chainFetch(async () => new Response(null, { status: 204 })));
    await settle();
    await okUi.click("logoutBtn");
    await settle();
    assert.equal(okUi.elements.get("logoutWarn").hidden, true, "при подтверждённом revoke предупреждения нет");
    assert.equal(okUi.storage.tv_session, undefined);

    const localOnly = chainHarness(variant, chainFetch(respond(503)));
    await settle();
    await localOnly.click("logoutBtn");
    await settle();
    assert.equal(localOnly.elements.get("logoutWarn").hidden, false, "неподтверждённый revoke обязан предупредить");
    assert.equal(localOnly.storage.tv_session, undefined);

    // Отсутствующая сессия — обычный выход, пугать пользователя нечем.
    const empty = chainHarness(variant, chainFetch(respond(503)), null);
    await settle();
    await empty.click("logoutBtn");
    await settle();
    assert.equal(empty.elements.get("logoutWarn").hidden, true);
  });

  test(`${variant}: токены и тело ответа не попадают в result, UI и логи`, async () => {
    const h = chainHarness(variant, chainFetch(respond(503)));
    await settle();
    const result = await h.page.SB.signOut();
    await settle();

    const rendered = [...h.elements.values()].map((el) => String(el.textContent)).join("\n");
    const blob = [JSON.stringify(result), rendered, h.logs.join("\n")].join("\n");
    for (const secret of [ACCESS_TOKEN, REFRESH_TOKEN, SERVER_BODY, "Bearer ", "503"]) {
      assert.ok(!blob.includes(secret), `утечка в result/UI/логи: ${secret}`);
    }
    assert.equal(result.remoteRevoked, false);
  });
}

// ── EXT-OPT-01: первый кадр popup и число сообщений фону ──────────────────
//
// Только public: правки popup.js (ids 4, 8/27/34) сделаны в нём, admin —
// отдельный пакет и в этот срез не входит.

const jsonResponse = (body) =>
  new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
const expiredSession = () => session(REFRESH_TOKEN, Math.floor(Date.now() / 1000) - 10);
const isRefresh = (url) => String(url).includes("/auth/v1/token");

test("public: форма входа скрыта, пока фон не ответил, и у вошедшего не открывается (id 4)", async () => {
  // Стаб берёт `hidden` у #login из разметки — значит, разметка обязана его нести.
  assert.match(src.public.popupHtml, /<section id="login"[^>]*\shidden[\s>]/, "popup.html: #login без hidden");
  const gate = deferred();
  const h = chainHarness("public", (url) => (isRefresh(url) ? gate.promise : Promise.resolve(jsonResponse({}))), expiredSession());
  const login = h.page.document.getElementById("login");
  const account = h.page.document.getElementById("account");

  // tv:sb-session висит на refresh: это и есть окно, в котором раньше был
  // виден экран входа.
  await waitFor(() => h.calls.some((call) => isRefresh(call.url)));
  await settle();
  assert.equal(login.hidden, true, "до ответа фона форма входа не открыта");
  assert.notEqual(login.style.display, "block");
  assert.notEqual(account.style.display, "block");

  gate.resolve(jsonResponse(session("rotated")));
  await settle();
  assert.equal(account.style.display, "block");
  assert.equal(login.hidden, true, "у вошедшего форма входа так и не открывалась");
  assert.equal(login.style.display, "none");
});

test("public: отказ фона открывает форму входа, а не пустой popup (id 4)", async () => {
  const h = chainHarness("public", async (url) => (isRefresh(url) ? new Response(null, { status: 503 }) : jsonResponse({})), expiredSession());
  await settle();
  const login = h.page.document.getElementById("login");
  assert.equal(login.hidden, false, "войти должно быть можно и при отказе фона");
  assert.notEqual(h.page.document.getElementById("account").style.display, "block");
  assert.notEqual(h.elements.get("status").textContent, "", "отказ виден пользователю");
});

test("public: popup шлёт фону только нужные сообщения, без tv:ping (ids 8/27/34)", async () => {
  const signedIn = chainHarness("public", chainFetch(respond(204)));
  await settle();
  assert.deepEqual(signedIn.messages, ["tv:sb-session"], "ответ tv:sb-session уже доказал, что фон жив");
  assert.equal(signedIn.elements.get("bgStatus").textContent, "ready");
  assert.equal(signedIn.elements.get("who").textContent, "user@example.com");

  const signedOut = chainHarness("public", chainFetch(respond(204)), null);
  await settle();
  assert.deepEqual(signedOut.messages, ["tv:sb-session", "tv:oauth-error"]);
  assert.equal(signedOut.elements.get("login").hidden, false);
});

test("public: смена языка перерисовывает тексты без новых сообщений фону (ids 8/27/34)", async () => {
  const OAUTH_ERROR = "Sign-in window was closed";
  const signedOut = chainHarness("public", chainFetch(respond(204)), null, { i18n: true });
  signedOut.storage.tv_oauth_error = OAUTH_ERROR;
  await settle();
  assert.equal(signedOut.elements.get("status").textContent, OAUTH_ERROR);
  const before = [...signedOut.messages];

  await signedOut.clickLang("Русский");
  await settle();
  assert.equal(signedOut.page.TVI18N.lang, "ru");
  assert.deepEqual(signedOut.messages, before, "смена языка не спрашивает фон заново");
  // apply() затёр #status переводом из data-i18n — текст ошибки обязан вернуться.
  assert.equal(signedOut.elements.get("status").textContent, OAUTH_ERROR);

  const signedIn = chainHarness("public", chainFetch(respond(204)), session(), { i18n: true });
  await settle();
  assert.equal(signedIn.elements.get("bgStatus").textContent, "en:ready");
  await signedIn.clickLang("Русский");
  await settle();
  assert.deepEqual(signedIn.messages, ["tv:sb-session"]);
  assert.equal(signedIn.elements.get("bgStatus").textContent, "ru:ready");
  assert.equal(signedIn.elements.get("who").textContent, "user@example.com");
});

// ── TASK-03 F-01: гонка авторитетных мутаций tv_session ────────────────────
//
// Каждый сценарий прогоняется против ОБОИХ бэкендов storage — FIFO и
// враждебного, переставляющего порядок завершения одновременно начатых
// операций. Совпадение результатов и есть доказательство того, что механизм не
// опирается на недокументированную FIFO-гарантию chrome.storage.
// `area.maxMutations === 1` доказывает вторую половину: защищённые операции
// вообще не пересекаются во времени, поэтому переставлять нечего.

const rotatedResponse = (token = "rotated") =>
  new Response(JSON.stringify(session(token)), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });

// Новый вход с ТЕМ ЖЕ refresh_token: сравнение токена его не отличает, поэтому
// сохранность нового входа держится только поколением. access_token отличается
// — по нему видно, чей credential отзывает logout.
const NEW_ACCESS_TOKEN = `access-${"y".repeat(40)}`;
const NEW_LOGIN = {
  ...session(REFRESH_TOKEN),
  access_token: NEW_ACCESS_TOKEN,
  user: { id: "user-2", email: "second@example.com" },
};

const raceFetch = (gate, logoutImpl) => (url) => {
  const target = String(url);
  if (target.includes("/auth/v1/token")) return gate.promise;
  if (target.includes("/functions/v1/exchange")) {
    return Promise.resolve(
      new Response(JSON.stringify(NEW_LOGIN), { status: 200, headers: { "Content-Type": "application/json" } }),
    );
  }
  return logoutImpl();
};

const revokeCalls = (h) => h.calls.filter((call) => String(call.url).includes("/auth/v1/logout"));

// Refresh ушёл в сеть и запаркован: дальше любая мутация — «поздняя».
// Обёртка обязательна: `return refreshing` из async-функции подождал бы сам
// promise, а он намеренно не завершён.
async function parkedRefresh(h) {
  const refreshing = h.context.tvRefreshSession();
  await waitFor(() => h.calls.some((call) => String(call.url).includes("/auth/v1/token")));
  return { refreshing };
}

// Сериализация: ни две записи, ни запись с чтением не пересекаются во времени.
// maxProtected строго сильнее maxMutations — он видит и чтения.
function assertSerialized(h) {
  assert.equal(h.area.maxMutations, 1, `записи tv_session пересеклись: ${h.ops.join(",")}`);
  assert.equal(h.area.maxProtected, 1, `защищённые операции tv_session пересеклись: ${h.ops.join(",")}`);
}

function assertRevokedOldCredentialOnly(h) {
  const revokes = revokeCalls(h);
  assert.equal(revokes.length, 1, "logout обязан сделать ровно один запрос отзыва");
  assert.match(revokes[0].url, /\/auth\/v1\/logout\?scope=local$/, "scope=local обязан сохраниться");
  assert.equal(
    revokes[0].options.headers.Authorization,
    `Bearer ${ACCESS_TOKEN}`,
    "отзывать надо тот credential, который logout прочитал внутри своей секции",
  );
  assert.ok(
    !h.calls.some((call) => call.options?.headers?.Authorization === `Bearer ${NEW_ACCESS_TOKEN}`),
    "credential нового входа не должен отзываться никогда",
  );
}

for (const [backend, makeArea] of BACKENDS) {
  for (const variant of VARIANTS) {
    test(`${variant}/${backend}: logout с подтверждённым revoke не воскрешается поздним refresh`, async () => {
      const gate = deferred();
      const h = oauthHarness(
        variant,
        raceFetch(gate, () => Promise.resolve(new Response(null, { status: 204 }))),
        session(),
        makeArea,
      );

      const { refreshing } = await parkedRefresh(h);
      const logout = h.context.tvSignOutSession();
      gate.resolve(rotatedResponse());
      const result = await logout;

      assert.deepEqual(plain(result), {
        localCleared: true,
        remoteRevoked: true,
        hadSession: true,
        attempts: 1,
        reason: "revoked",
      });
      assert.equal(await refreshing, null, "поздний refresh обязан вернуть фактическое состояние storage");
      assert.equal(h.storage.tv_session, undefined, "logout не должен быть воскрешён");
      assert.ok(!h.ops.includes("set"), `поздний refresh не имел права писать: ${h.ops.join(",")}`);
      assertSerialized(h);
      assertRevokedOldCredentialOnly(h);
      // localCleared честен: сессия, которую увидел logout, в storage отсутствует.
      assert.equal(result.localCleared, h.storage.tv_session === undefined);
    });

    test(`${variant}/${backend}: logout без подтверждения revoke тоже не воскрешается`, async () => {
      const gate = deferred();
      const h = oauthHarness(
        variant,
        raceFetch(gate, () => Promise.reject(new TypeError("Failed to fetch"))),
        session(),
        makeArea,
      );

      const { refreshing } = await parkedRefresh(h);
      const logout = h.context.tvSignOutSession();
      gate.resolve(rotatedResponse());
      const result = await logout;

      assert.deepEqual(plain(result), {
        localCleared: true,
        remoteRevoked: false,
        hadSession: true,
        attempts: 3,
        reason: "network",
      });
      // Ветка сетевого отказа — та, где воскресший refresh_token остался бы рабочим.
      assert.equal(await refreshing, null);
      assert.equal(h.storage.tv_session, undefined);
      assert.ok(!h.ops.includes("set"), `поздний refresh не имел права писать: ${h.ops.join(",")}`);
      assertSerialized(h);
      assert.equal(result.localCleared, h.storage.tv_session === undefined);
    });

    test(`${variant}/${backend}: новый login переживает поздний refresh (успешная ветка)`, async () => {
      const gate = deferred();
      const h = oauthHarness(
        variant,
        raceFetch(gate, () => Promise.resolve(new Response(null, { status: 204 }))),
        session(),
        makeArea,
      );

      const { refreshing } = await parkedRefresh(h);
      const logged = await h.context.tvOAuthSignIn(variant);
      assert.equal(logged.user.id, "user-2", "настоящий вход через tvOAuthSignIn обязан пройти");
      gate.resolve(rotatedResponse());

      assert.equal((await refreshing)?.user.id, "user-2", "поздний refresh не имеет права подменить новый вход");
      assert.equal(h.storage.tv_session?.user.id, "user-2");
      assert.equal(h.storage.tv_session.refresh_token, REFRESH_TOKEN, "ротированный токен старой сессии не записан");
      assertSerialized(h);
    });

    test(`${variant}/${backend}: 401-ветка refresh не удаляет новый login и возвращает его`, async () => {
      const gate = deferred();
      const h = oauthHarness(
        variant,
        raceFetch(gate, () => Promise.resolve(new Response(null, { status: 204 }))),
        session(),
        makeArea,
      );

      const { refreshing } = await parkedRefresh(h);
      await h.context.tvOAuthSignIn(variant);
      gate.resolve(new Response(SERVER_BODY, { status: 401 }));

      // Устаревший refresh обязан вернуть ФАКТИЧЕСКОЕ состояние, а не null:
      // сессия существует, и вызывающий не должен считать пользователя вышедшим.
      assert.equal((await refreshing)?.user.id, "user-2", "устаревший refresh обязан вернуть новую сессию");
      assert.equal(h.storage.tv_session?.user.id, "user-2", "очистка невалидного токена не должна задеть новый вход");
      assertSerialized(h);
    });

    test(`${variant}/${backend}: login, начатый до завершения remove logout, побеждает и не отзывается`, async () => {
      const gate = deferred();
      const h = oauthHarness(
        variant,
        raceFetch(gate, () => Promise.resolve(new Response(null, { status: 204 }))),
        session(),
        makeArea,
      );

      const logout = h.context.tvSignOutSession();
      await settle(1);
      assert.equal(
        h.storage.tv_session?.refresh_token,
        REFRESH_TOKEN,
        "предусловие теста: локальный remove logout ещё не завершён",
      );

      const logged = await h.context.tvOAuthSignIn(variant);
      const result = await logout;

      assert.equal(logged.user.id, "user-2");
      assert.equal(h.storage.tv_session?.user.id, "user-2", "новый вход обязан пережить завершение logout");
      assert.equal(h.storage.tv_session.access_token, NEW_ACCESS_TOKEN);
      assert.equal(result.hadSession, true);
      assert.equal(result.localCleared, true);
      assertSerialized(h);
      assertRevokedOldCredentialOnly(h);
    });

    test(`${variant}/${backend}: install-сброс и конкурентный login не смешиваются`, async () => {
      const gate = deferred();
      const h = oauthHarness(
        variant,
        raceFetch(gate, () => Promise.resolve(new Response(null, { status: 204 }))),
        session(),
        makeArea,
      );
      h.storage.tv_oauth_error = "old error";

      const reset = h.context.tvBeginInstallStateReset();
      await settle(1);
      const logged = await h.context.tvOAuthSignIn(variant);
      await reset;

      assert.equal(logged.user.id, "user-2");
      assert.equal(h.storage.tv_session?.user.id, "user-2", "вход после install-сброса не должен быть стёрт");
      assert.equal(h.storage.tv_oauth_error, undefined, "install-сброс обязан снять старую ошибку");
      assertSerialized(h);
    });
  }
}

// ── mutation-first: мутация УЖЕ выполняется, в этот момент стартует читатель ─
//
// Ревизия 02 брала снимок поколения и сессию ВНЕ секции, поэтому могла получить
// уже увеличенное поколение вместе со старой сессией, которую выполняющаяся
// мутация ещё не успела удалить, и потом пройти сверку в commit. Воспроизведён
// порядок: `get logout → remove:start → get refresh(старая) → remove:end →
// set refresh(rotated)`. Ворота `holdNext` делают этот момент детерминированным
// на обоих бэкендах.

const MF_LOGIN_TOKEN = "login-token";
const MF_LOGIN = {
  ...session(MF_LOGIN_TOKEN),
  access_token: NEW_ACCESS_TOKEN,
  user: { id: "user-2", email: "second@example.com" },
};

// Сервер ротирует ИМЕННО тот токен, который у него попросили, иначе тест
// доказывал бы артефакт заглушки, а не поведение кода.
const mutationFirstFetch = (url, options) => {
  const target = String(url);
  if (target.includes("/auth/v1/token")) {
    const asked = JSON.parse(String(options.body)).refresh_token;
    const rotated = asked === MF_LOGIN_TOKEN
      ? { ...MF_LOGIN, refresh_token: "rotated-login" }
      : session("rotated-old");
    return Promise.resolve(
      new Response(JSON.stringify(rotated), { status: 200, headers: { "Content-Type": "application/json" } }),
    );
  }
  if (target.includes("/functions/v1/exchange")) {
    return Promise.resolve(
      new Response(JSON.stringify(MF_LOGIN), { status: 200, headers: { "Content-Type": "application/json" } }),
    );
  }
  return Promise.resolve(new Response(null, { status: 204 }));
};

for (const [backend, makeArea] of BACKENDS) {
  for (const variant of VARIANTS) {
    test(`${variant}/${backend}: refresh при выполняемом remove logout не воскрешает сессию`, async () => {
      const h = oauthHarness(variant, mutationFirstFetch, session(), makeArea);
      const gate = h.area.holdNext("remove");

      const logout = h.context.tvSignOutSession();
      await gate.started; // remove logout начат и удерживается
      const refreshing = h.context.tvRefreshSession();
      await settle(6); // окно, в котором ревизия 02 брала снимок вне секции
      gate.release();

      const result = await logout;
      assert.equal(await refreshing, null, "refresh обязан увидеть уже принятое решение logout");
      assertSerialized(h);
      assert.equal(h.storage.tv_session, undefined, "logout не должен быть воскрешён");
      assert.ok(!h.ops.includes("set"), `refresh не имел права писать: ${h.ops.join(",")}`);
      assert.equal(result.hadSession, true);
      assert.equal(result.localCleared, true);
    });

    test(`${variant}/${backend}: refresh при выполняемом set нового login не перезаписывает его`, async () => {
      const h = oauthHarness(variant, mutationFirstFetch, session(), makeArea);
      const gate = h.area.holdNext("set");

      const signingIn = h.context.tvOAuthSignIn(variant);
      await gate.started; // set нового входа начат и удерживается
      const refreshing = h.context.tvRefreshSession();
      await settle(6);
      gate.release();

      const logged = await signingIn;
      await refreshing;
      assertSerialized(h);
      assert.equal(logged.user.id, "user-2");
      assert.equal(
        h.storage.tv_session?.user.id,
        "user-2",
        "сессия старого пользователя не имеет права перезаписать новый вход",
      );
      assert.notEqual(h.storage.tv_session.refresh_token, "rotated-old");
    });

    test(`${variant}/${backend}: refresh при выполняемом install-сбросе не воскрешает сессию`, async () => {
      const h = oauthHarness(variant, mutationFirstFetch, session(), makeArea);
      h.storage.tv_oauth_error = "old error";
      const gate = h.area.holdNext("remove");

      const reset = h.context.tvBeginInstallStateReset();
      await gate.started;
      const refreshing = h.context.tvRefreshSession();
      await settle(6);
      gate.release();

      await reset;
      assert.equal(await refreshing, null);
      assertSerialized(h);
      assert.equal(h.storage.tv_session, undefined, "install-сброс не должен быть отменён поздним refresh");
      assert.equal(h.storage.tv_oauth_error, undefined);
    });

    test(`${variant}/${backend}: чтение при выполняемом remove logout не отдаёт удаляемую сессию`, async () => {
      const h = oauthHarness(variant, mutationFirstFetch, session(), makeArea);
      const gate = h.area.holdNext("remove");

      const logout = h.context.tvSignOutSession();
      await gate.started;
      const reading = h.context.tvGetSession();
      const validating = h.context.tvValidSession();
      await settle(6);
      gate.release();

      const seen = await reading;
      const valid = await validating;
      await logout;
      assertSerialized(h);
      assert.equal(seen, null, "потребитель не должен увидеть сессию, которую logout уже решил удалить");
      assert.equal(valid, null);
    });
  }
}

// ── ревизия 04: порядок вызовов против install-барьера и fail-closed ────────
//
// Ревизия 03 ждала `tvInstallStatePromise` ДО постановки операции в очередь,
// поэтому удерживаемый install-сброс отправлял вызванный раньше setter в хвост,
// а вызванный позже logout проходил вперёд него:
//   `remove(reset) → get/logout → remove/logout → set:new`.
// Logout возвращал `localCleared:true, hadSession:false`, но сессия в storage
// существовала. Ревизия 04 снимает барьер синхронно и ждёт его ВНУТРИ секции,
// поэтому порядок секций равен порядку вызовов.
//
// Вторая половина блока — единый security-контракт на отказ install-сброса:
// отказавший сброс запечатывает слот целиком (чтения, refresh, login/set,
// logout), старый credential не используется и не отзывается, следующий
// УСПЕШНЫЙ сброс печать снимает, очередь при этом продолжает работать.

for (const [backend, makeArea] of BACKENDS) {
  for (const variant of VARIANTS) {
    test(`${variant}/${backend}: setter при удерживаемом install-сбросе не пропускает вперёд поздний logout`, async () => {
      const h = oauthHarness(variant, mutationFirstFetch, session(), makeArea);
      const gate = h.area.holdNext("remove");

      const reset = h.context.tvBeginInstallStateReset();
      await gate.started; // remove install-сброса начат и удерживается

      const setting = h.context.tvSetSession(NEW_LOGIN); // вызван ВТОРЫМ
      await settle(6);
      const logout = h.context.tvSignOutSession(); // вызван ТРЕТЬИМ
      await settle(6);
      gate.release();

      await reset;
      await setting;
      const result = await logout;

      assert.deepEqual(
        h.ops,
        ["remove", "set", "get", "remove"],
        "порядок storage обязан совпасть с порядком вызовов: reset → set → logout",
      );
      assert.equal(h.storage.tv_session, undefined, "logout вызван последним — storage обязан остаться пуст");
      assert.equal(result.hadSession, true, "logout обязан увидеть сессию, записанную до него");
      assert.equal(result.localCleared, true);
      assert.equal(result.remoteRevoked, true);
      const revokes = revokeCalls(h);
      assert.equal(revokes.length, 1);
      assert.equal(
        revokes[0].options.headers.Authorization,
        `Bearer ${NEW_ACCESS_TOKEN}`,
        "отзывается credential той сессии, которую logout прочитал внутри секции",
      );
      assert.match(revokes[0].url, /\/auth\/v1\/logout\?scope=local$/);
      assertSerialized(h);
    });

    test(`${variant}/${backend}: setter, вызванный до install-сброса, стирается им`, async () => {
      const h = oauthHarness(variant, mutationFirstFetch, null, makeArea);

      const setting = h.context.tvSetSession(NEW_LOGIN); // вызван ПЕРВЫМ
      const reset = h.context.tvBeginInstallStateReset(); // вызван ВТОРЫМ
      await setting;
      await reset;

      assert.deepEqual(h.ops, ["set", "remove"], "сброс обязан встать в очередь ПОСЛЕ setter");
      assert.equal(h.storage.tv_session, undefined, "более поздний install-сброс обязан стереть запись setter");
      assertSerialized(h);
    });

    test(`${variant}/${backend}: отказавший install-сброс закрывает весь слот без сети`, async () => {
      const h = oauthHarness(variant, mutationFirstFetch, session(), makeArea);
      h.area.failNext("remove");

      await assert.rejects(h.context.tvBeginInstallStateReset(), /storage unavailable/);

      // Писатели и потребители старого credential — первыми: именно они на
      // ревизии 03 продолжали работать со старым состоянием.
      await assert.rejects(h.context.tvRefreshSession(), SEALED);
      await assert.rejects(h.context.tvSignOutSession(), SEALED);
      await assert.rejects(h.context.tvOAuthSignIn(variant), SEALED);
      await assert.rejects(h.context.tvSetSession(NEW_LOGIN), SEALED);
      await assert.rejects(h.context.tvValidSession(), SEALED);
      await assert.rejects(h.context.tvGetSession(), (err) => {
        assert.match(err.message, SEALED);
        assert.ok(!err.message.includes(STORAGE_FAILURE), "причина storage-сбоя наружу не уходит");
        return true;
      });

      assert.equal(h.calls.length, 0, "в запечатанном состоянии сеть не трогается вообще");
      assert.deepEqual(h.ops, ["remove"], "запечатанные операции не выполняют storage-операций");
      assert.equal(
        h.storage.tv_session?.access_token,
        ACCESS_TOKEN,
        "старый credential остался нетронутым: он не прочитан, не отозван и не переписан",
      );
      assertSerialized(h);
    });

    test(`${variant}/${backend}: следующий успешный install-сброс снимает fail-closed`, async () => {
      const h = oauthHarness(variant, mutationFirstFetch, session(), makeArea);
      h.area.failNext("remove");

      await assert.rejects(h.context.tvBeginInstallStateReset(), /storage unavailable/);
      await assert.rejects(h.context.tvSignOutSession(), SEALED);
      assert.equal(revokeCalls(h).length, 0, "запечатанный logout не отзывает старый credential");

      await h.context.tvBeginInstallStateReset();
      assert.equal(h.storage.tv_session, undefined, "успешный сброс обязан очистить слот");

      // Печать снята: работают и чтение, и запись, и logout с реальным отзывом.
      await h.context.tvSetSession(NEW_LOGIN);
      assert.equal((await h.context.tvGetSession())?.user.id, "user-2");
      const result = await h.context.tvSignOutSession();
      assert.equal(result.hadSession, true);
      assert.equal(result.remoteRevoked, true);
      assert.equal(h.storage.tv_session, undefined);
      assert.equal(revokeCalls(h).length, 1);
      assert.equal(revokeCalls(h)[0].options.headers.Authorization, `Bearer ${NEW_ACCESS_TOKEN}`);
      assertSerialized(h);
    });

    test(`${variant}/${backend}: очередь исполняет смешанную партию в порядке вызовов и не залипает`, async () => {
      const h = oauthHarness(variant, mutationFirstFetch, session(), makeArea);
      const gate = h.area.holdNext("remove");

      const reset = h.context.tvBeginInstallStateReset();
      await gate.started;

      const first = h.context.tvGetSession();
      const setting = h.context.tvSetSession(NEW_LOGIN);
      const logout = h.context.tvSignOutSession();
      const second = h.context.tvGetSession();
      await settle(6);
      gate.release();

      // Ни одна из пяти операций не имеет права зависнуть.
      const [, before, , result, after] = await Promise.all([reset, first, setting, logout, second]);

      assert.deepEqual(
        h.ops,
        ["remove", "get", "set", "get", "remove", "get"],
        "порядок storage обязан совпасть с порядком вызовов",
      );
      assert.equal(before, null, "чтение сразу после сброса обязано видеть очищенный слот");
      assert.equal(result.hadSession, true, "logout обязан увидеть запись setter, вызванного до него");
      assert.equal(after, null, "чтение после logout обязано видеть пустой слот");
      assert.equal(h.storage.tv_session, undefined);
      assert.equal(revokeCalls(h).length, 1);
      assert.equal(revokeCalls(h)[0].options.headers.Authorization, `Bearer ${NEW_ACCESS_TOKEN}`);
      assertSerialized(h);
    });
  }
}

for (const variant of VARIANTS) {
  test(`${variant}: refresh single-flight — два параллельных вызова дают один сетевой запрос`, async () => {
    const gate = deferred();
    const h = oauthHarness(
      variant,
      raceFetch(gate, () => Promise.resolve(new Response(null, { status: 204 }))),
      session(),
      fifoArea,
    );

    const first = h.context.tvRefreshSession();
    const second = h.context.tvRefreshSession();
    await waitFor(() => h.calls.some((call) => String(call.url).includes("/auth/v1/token")));
    gate.resolve(rotatedResponse());
    const [a, b] = await Promise.all([first, second]);

    assert.equal(
      h.calls.filter((call) => String(call.url).includes("/auth/v1/token")).length,
      1,
      "single-flight обязан схлопнуть два вызова в один запрос",
    );
    assert.equal(a?.refresh_token, "rotated");
    assert.equal(b?.refresh_token, "rotated");
    assert.equal(h.storage.tv_session.refresh_token, "rotated");
    assertSerialized(h);
  });
}

// ── ревизия 05, HIGH-1: intent входа против позднего результата ─────────────
//
// Ревизия 04 фиксировала вход только в момент commit. Между стартом
// `tvOAuthSignIn()` и записью сессии стоят PKCE, `launchWebAuthFlow` и
// exchange, поэтому решение, принятое ПОСЛЕ старта входа, отменялось поздним
// результатом: вход, начатый до logout, записывал сессию обратно, а начатый до
// install-сброса — отменял сброс. Ревизия 05 ставит guarded-секцию intent
// первым действием, двигает ею поколение и разрешает commit только пока intent
// остаётся текущим.

const SECOND_ACCESS_TOKEN = `access-${"z".repeat(40)}`;
const SECOND_LOGIN = {
  ...session("second-refresh"),
  access_token: SECOND_ACCESS_TOKEN,
  user: { id: "user-3", email: "third@example.com" },
};
const SUPERSEDED = /Sign-in superseded by a newer session change/;

const isExchange = (call) => String(call.url).includes("/functions/v1/exchange");
const isToken = (call) => String(call.url).includes("/auth/v1/token");

// Каждый вызов `/functions/v1/exchange` обслуживается своим шагом очереди —
// `{ gate?, payload }`. Без этого сценарий «вход A удерживается, вход B
// проходит целиком» не выразить: оба входа идут через один и тот же fetch.
const exchangeQueue = (steps) => {
  let served = 0;
  return (url) => {
    const call = { url };
    if (isExchange(call)) {
      const step = steps[served++];
      assert.ok(step, "exchange вызван больше раз, чем описано в сценарии");
      return Promise.resolve(step.gate?.promise).then(
        () =>
          new Response(JSON.stringify(step.payload), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
      );
    }
    if (isToken(call)) return Promise.resolve(rotatedResponse());
    return Promise.resolve(new Response(null, { status: 204 }));
  };
};

for (const [backend, makeArea] of BACKENDS) {
  for (const variant of VARIANTS) {
    test(`${variant}/${backend}: вход, начатый до logout, не воскрешает сессию поздним exchange`, async () => {
      const gate = deferred();
      const h = oauthHarness(variant, exchangeQueue([{ gate, payload: NEW_LOGIN }]), session(), makeArea);

      const signingIn = h.context.tvOAuthSignIn(variant);
      await waitFor(() => h.calls.some(isExchange)); // intent поставлен, exchange в сети

      const logout = await h.context.tvSignOutSession();
      assert.equal(logout.remoteRevoked, true);
      assert.equal(h.storage.tv_session, undefined, "предусловие: logout завершён, слот пуст");

      gate.resolve();
      await assert.rejects(signingIn, SUPERSEDED, "устаревший вход обязан быть отклонён");
      assert.equal(h.storage.tv_session, undefined, "поздний вход не имеет права воскресить сессию после logout");
      assert.equal(h.storage.tv_oauth_error, undefined, "устаревший вход не имеет права писать ошибку");
      assert.ok(!h.ops.includes("set"), `устаревший вход не имел права писать: ${h.ops.join(",")}`);
      assertSerialized(h);
      assertRevokedOldCredentialOnly(h);
    });

    test(`${variant}/${backend}: вход, начатый до install-сброса, не отменяет сброс`, async () => {
      const gate = deferred();
      const h = oauthHarness(variant, exchangeQueue([{ gate, payload: NEW_LOGIN }]), session(), makeArea);
      h.storage.tv_oauth_error = "old error";

      const signingIn = h.context.tvOAuthSignIn(variant);
      await waitFor(() => h.calls.some(isExchange));

      await h.context.tvBeginInstallStateReset();
      assert.equal(h.storage.tv_session, undefined, "предусловие: сброс завершён, слот пуст");

      gate.resolve();
      await assert.rejects(signingIn, SUPERSEDED);
      assert.equal(h.storage.tv_session, undefined, "install-сброс не имеет права быть отменён поздним входом");
      assert.equal(h.storage.tv_oauth_error, undefined);
      assert.ok(!h.ops.includes("set"), `устаревший вход не имел права писать: ${h.ops.join(",")}`);
      assertSerialized(h);
    });

    test(`${variant}/${backend}: поздний вход A не подменяет более новый вход B`, async () => {
      const gateA = deferred();
      const h = oauthHarness(
        variant,
        exchangeQueue([{ gate: gateA, payload: NEW_LOGIN }, { payload: SECOND_LOGIN }]),
        session(),
        makeArea,
      );
      h.storage.tv_oauth_error = "old error";

      const a = h.context.tvOAuthSignIn(variant);
      await waitFor(() => h.calls.filter(isExchange).length === 1);

      const b = await h.context.tvOAuthSignIn(variant);
      assert.equal(b.user.id, "user-3", "вход B обязан пройти целиком");
      assert.equal(h.storage.tv_oauth_error, undefined, "успешный вход обязан снять старую ошибку");

      gateA.resolve();
      await assert.rejects(a, SUPERSEDED);
      assert.equal(h.storage.tv_session?.user.id, "user-3", "A не имеет права подменить сессию B");
      assert.equal(h.storage.tv_session.access_token, SECOND_ACCESS_TOKEN);
      assert.equal(h.storage.tv_oauth_error, undefined, "A не имеет права положить ошибку поверх успешного B");
      assertSerialized(h);
    });

    test(`${variant}/${backend}: вход после завершённого logout и после завершённого сброса проходит`, async () => {
      const afterLogout = oauthHarness(variant, exchangeQueue([{ payload: NEW_LOGIN }]), session(), makeArea);
      await afterLogout.context.tvSignOutSession();
      const logged = await afterLogout.context.tvOAuthSignIn(variant);
      assert.equal(logged.user.id, "user-2");
      assert.equal(afterLogout.storage.tv_session?.user.id, "user-2", "вход после logout обязан сохраниться");
      assertSerialized(afterLogout);

      const afterReset = oauthHarness(variant, exchangeQueue([{ payload: SECOND_LOGIN }]), session(), makeArea);
      afterReset.storage.tv_oauth_error = "old error";
      await afterReset.context.tvBeginInstallStateReset();
      const relogged = await afterReset.context.tvOAuthSignIn(variant);
      assert.equal(relogged.user.id, "user-3");
      assert.equal(afterReset.storage.tv_session?.user.id, "user-3", "вход после install-сброса обязан сохраниться");
      assert.equal(afterReset.storage.tv_oauth_error, undefined);
      assertSerialized(afterReset);
    });
  }
}

// ── ревизия 05, HIGH-2: общий refresh-flight не отдаёт свой результат ───────
//
// Ревизия 04 возвращала `tvOAuthRefreshPromise` напрямую. Caller, пришедший уже
// ПОСЛЕ постановки install-сброса, получал доресетную ротированную сессию: и
// барьер, и секция были сняты тем, кто flight начал, то есть до сброса.
// Ревизия 05 сохраняет ровно один сетевой запрос, но каждый caller после flight
// делает СВОЙ guarded readback через актуальный барьер.

for (const [backend, makeArea] of BACKENDS) {
  for (const variant of VARIANTS) {
    test(`${variant}/${backend}: caller, пришедший после install-сброса, не получает доресетный credential`, async () => {
      const h = oauthHarness(variant, mutationFirstFetch, session(), makeArea);
      const commit = h.area.holdNext("set");

      const first = h.context.tvRefreshSession();
      await commit.started; // commit refresh начат и удерживается

      const removal = h.area.holdNext("remove");
      const reset = h.context.tvBeginInstallStateReset();
      const second = h.context.tvRefreshSession(); // вызван уже ПОСЛЕ постановки сброса

      let settled = 0;
      const mark = () => { settled++; };
      void first.then(mark, mark);
      void second.then(mark, mark);

      commit.release();
      await removal.started; // remove сброса начат и удерживается
      assert.equal(
        h.storage.tv_session?.refresh_token,
        "rotated-old",
        "предусловие: ротированная сессия записана, сброс её ещё не убрал",
      );
      await settle(10);
      assert.equal(settled, 0, "ни один caller не имеет права завершиться до install-сброса");

      removal.release();
      await reset;

      assert.equal(await first, null, "после успешного сброса refresh обязан вернуть null");
      assert.equal(await second, null, "второй caller обязан пройти новый барьер, а не результат flight");
      assert.equal(h.storage.tv_session, undefined);
      assert.equal(h.calls.filter(isToken).length, 1, "сетевой refresh обязан остаться единственным");
      assertSerialized(h);
    });

    test(`${variant}/${backend}: после отказавшего сброса оба caller-а refresh получают sealed`, async () => {
      const h = oauthHarness(variant, mutationFirstFetch, session(), makeArea);
      const commit = h.area.holdNext("set");

      const first = h.context.tvRefreshSession();
      await commit.started;

      h.area.failNext("remove");
      const reset = h.context.tvBeginInstallStateReset();
      const second = h.context.tvRefreshSession();
      const captured = Promise.all([first.catch((err) => err), second.catch((err) => err)]);

      commit.release();
      await assert.rejects(reset, /storage unavailable/);

      const [a, b] = await captured;
      assert.match(a.message, SEALED, "первый caller обязан получить sealed, а не доресетную сессию");
      assert.match(b.message, SEALED, "второй caller обязан получить sealed");
      assert.equal(h.calls.filter(isToken).length, 1, "сетевой refresh обязан остаться единственным");
      assertSerialized(h);
    });
  }
}

// ── ревизия 06, дефект 1: частичный отказ storage внутри commit входа ───────
//
// Секция commit сериализована, но НЕ атомарна: `remove(tv_oauth_error)` и
// `set(tv_session)` могут отказать по отдельности. Ревизия 05 двигала поколение
// первой строкой и писала сессию раньше, чем снимала старую ошибку, поэтому
// отказ последнего `remove` возвращал вызывающему ошибку входа при уже
// сохранённом credential, а сдвинутое поколение делало intent устаревшим и
// лишало `catch` права записать хоть какую-то диагностику. Ревизия 06 меняет
// порядок: ошибка снимается первой, поколение двигается последним.

for (const [backend, makeArea] of BACKENDS) {
  for (const variant of VARIANTS) {
    test(`${variant}/${backend}: отказ remove(tv_oauth_error) в commit не оставляет сохранённый credential`, async () => {
      const h = oauthHarness(
        variant,
        exchangeQueue([{ payload: NEW_LOGIN }, { payload: SECOND_LOGIN }]),
        null,
        makeArea,
      );
      h.storage.tv_oauth_error = "old error";
      h.area.failNext("remove", "tv_oauth_error");

      await assert.rejects(h.context.tvOAuthSignIn(variant), /storage unavailable/);
      assert.equal(
        h.storage.tv_session,
        undefined,
        "отказавший commit не имеет права оставить credential в storage",
      );
      assert.ok(h.storage.tv_oauth_error, "intent остался текущим — catch обязан записать диагностику входа");
      assert.notEqual(h.storage.tv_oauth_error, "old error", "записана ошибка этой попытки, а не прежняя");

      // Очередь не залипла, и следующая попытка входа проходит целиком.
      assert.equal(await h.context.tvGetSession(), null);
      const logged = await h.context.tvOAuthSignIn(variant);
      assert.equal(logged.user.id, "user-3", "следующая попытка входа обязана пройти");
      assert.equal(h.storage.tv_session?.user.id, "user-3");
      assert.equal(h.storage.tv_oauth_error, undefined, "успешный вход обязан снять ошибку прошлой попытки");
      assertSerialized(h);
    });

    test(`${variant}/${backend}: отказ set(tv_session) после снятой ошибки не создаёт сессию и не залипает`, async () => {
      const h = oauthHarness(
        variant,
        exchangeQueue([{ payload: NEW_LOGIN }, { payload: SECOND_LOGIN }]),
        null,
        makeArea,
      );
      h.storage.tv_oauth_error = "old error";
      h.area.failNext("set", "tv_session");

      await assert.rejects(h.context.tvOAuthSignIn(variant), /storage unavailable/);
      assert.equal(h.storage.tv_session, undefined, "сессия не имеет права появиться при отказавшей записи");
      assert.ok(h.storage.tv_oauth_error, "catch обязан записать диагностику: intent остался текущим");
      assert.notEqual(h.storage.tv_oauth_error, "old error", "старая ошибка снята первой операцией секции");

      assert.equal(await h.context.tvGetSession(), null, "очередь обязана продолжать работать");
      const logged = await h.context.tvOAuthSignIn(variant);
      assert.equal(logged.user.id, "user-3");
      assert.equal(h.storage.tv_session?.user.id, "user-3");
      assert.equal(h.storage.tv_oauth_error, undefined);
      assertSerialized(h);
    });
  }
}

// ── ревизия 06, дефект 2: отказавший flight тоже проходит authoritative readback
//
// Ревизия 05 делала per-caller readback только после УСПЕШНОГО flight. Сетевой
// отказ refresh и install-сброс — независимые события: отказ сети не отменяет
// того, что состояние уже авторитетно изменилось. Отдать в этом случае старую
// сетевую ошибку значит сказать «обновление не удалось, credential прежний»
// там, где credential уже удалён или слот запечатан.

const REFRESH_FAILURES = [
  {
    kind: "503",
    message: /Session refresh temporarily unavailable \(503\)/,
    respond: () => new Response(SERVER_BODY, { status: 503 }),
  },
  {
    kind: "invalid-response",
    message: /Invalid session refresh response/,
    respond: () =>
      new Response(JSON.stringify({ nonsense: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
  },
];

// Сетевой refresh запаркован на воротах: только так момент «сброс произошёл,
// пока refresh был в сети» детерминирован на обоих бэкендах.
const gatedRefreshFetch = (gate, respond) => (url) => {
  if (isToken({ url })) return gate.promise.then(respond);
  return Promise.resolve(new Response(null, { status: 204 }));
};

for (const [backend, makeArea] of BACKENDS) {
  for (const variant of VARIANTS) {
    for (const failure of REFRESH_FAILURES) {
      test(`${variant}/${backend}: отказ refresh (${failure.kind}) при успешном сбросе даёт authoritative null`, async () => {
        const gate = deferred();
        const h = oauthHarness(variant, gatedRefreshFetch(gate, failure.respond), session(), makeArea);

        const first = h.context.tvRefreshSession().then((v) => v, (e) => e);
        await waitFor(() => h.calls.some(isToken)); // сетевой refresh в полёте

        const reset = h.context.tvBeginInstallStateReset();
        const second = h.context.tvRefreshSession().then((v) => v, (e) => e); // вызван ПОСЛЕ постановки сброса
        await reset;
        assert.equal(h.storage.tv_session, undefined, "предусловие: сброс завершён, слот пуст");

        gate.resolve();
        assert.equal(await first, null, "после успешного сброса отказавший refresh обязан вернуть authoritative null");
        assert.equal(await second, null, "второй caller обязан получить тот же authoritative null");
        assert.equal(h.storage.tv_session, undefined);
        assert.equal(h.calls.filter(isToken).length, 1, "сетевой refresh обязан остаться единственным");
        assertSerialized(h);
      });

      test(`${variant}/${backend}: отказ refresh (${failure.kind}) при отказавшем сбросе даёт sealed`, async () => {
        const gate = deferred();
        const h = oauthHarness(variant, gatedRefreshFetch(gate, failure.respond), session(), makeArea);

        const first = h.context.tvRefreshSession().then((v) => v, (e) => e);
        await waitFor(() => h.calls.some(isToken));

        h.area.failNext("remove");
        const reset = h.context.tvBeginInstallStateReset();
        const second = h.context.tvRefreshSession().then((v) => v, (e) => e);
        await assert.rejects(reset, /storage unavailable/);

        gate.resolve();
        const [a, b] = await Promise.all([first, second]);
        assert.match(a.message, SEALED, "запечатанный барьер обязан быть сильнее сетевой ошибки refresh");
        assert.match(b.message, SEALED, "второй caller обязан получить sealed");
        assert.ok(!a.message.includes(STORAGE_FAILURE), "причина storage-сбоя наружу не уходит");
        assert.equal(h.calls.filter(isToken).length, 1, "сетевой refresh обязан остаться единственным");
        assert.equal(
          h.storage.tv_session?.access_token,
          ACCESS_TOKEN,
          "в запечатанном состоянии старый credential не трогается",
        );
        assertSerialized(h);
      });
    }

    test(`${variant}/${backend}: без install-сброса исходная ошибка refresh не подавляется`, async () => {
      for (const failure of REFRESH_FAILURES) {
        const gate = deferred();
        const h = oauthHarness(variant, gatedRefreshFetch(gate, failure.respond), session(), makeArea);

        const first = h.context.tvRefreshSession().then((v) => v, (e) => e);
        await waitFor(() => h.calls.some(isToken));
        const second = h.context.tvRefreshSession().then((v) => v, (e) => e);

        gate.resolve();
        const [a, b] = await Promise.all([first, second]);
        assert.match(a.message, failure.message, `${failure.kind}: исходная ошибка обязана дойти до caller`);
        assert.match(b.message, failure.message, `${failure.kind}: второй caller обязан получить ту же ошибку`);
        assert.equal(
          h.storage.tv_session?.refresh_token,
          REFRESH_TOKEN,
          `${failure.kind}: сессия обязана остаться нетронутой`,
        );
        assert.equal(h.calls.filter(isToken).length, 1, `${failure.kind}: сетевой refresh обязан остаться единственным`);
        // Здесь мутаций нет вообще, поэтому assertSerialized() неприменим: он
        // требует ровно одной записи. Проверяем обе половины напрямую —
        // защищённые операции не пересеклись и ни одной записи не было.
        assert.equal(
          h.area.maxProtected,
          1,
          `${failure.kind}: защищённые операции tv_session пересеклись: ${h.ops.join(",")}`,
        );
        assert.deepEqual(
          [...new Set(h.ops)],
          ["get"],
          `${failure.kind}: отказавший refresh не имел права писать: ${h.ops.join(",")}`,
        );
      }
    });
  }
}

// ── ревизия 07: признак «состояние изменилось» — поколение, а не наличие ────
//
// Ревизия 06 после отказавшего flight сверяла НАЛИЧИЕ сессии: любая непустая
// сессия считалась доказательством того, что состояние не менялось. Успешный
// вход, завершившийся пока refresh был в сети, оставляет слот непустым — и
// caller получал устаревшую `503` / `Invalid session refresh response` вместо
// только что записанной сессии. Поколение различает «слот не трогали» и «слот
// перезаписали»; наличие сессии — нет.

const SESSION_KEYS = ["access_token", "expires_at", "expires_in", "refresh_token", "token_type", "user"];

const gatedRefreshWithLogin = (gate, respond, payload) => (url) => {
  const call = { url };
  if (isToken(call)) return gate.promise.then(respond);
  if (isExchange(call)) {
    return Promise.resolve(
      new Response(JSON.stringify(payload), { status: 200, headers: { "Content-Type": "application/json" } }),
    );
  }
  return Promise.resolve(new Response(null, { status: 204 }));
};

for (const [backend, makeArea] of BACKENDS) {
  for (const variant of VARIANTS) {
    for (const failure of REFRESH_FAILURES) {
      test(`${variant}/${backend}: отказ refresh (${failure.kind}) при конкурентном входе отдаёт новую сессию`, async () => {
        const gate = deferred();
        const h = oauthHarness(
          variant,
          gatedRefreshWithLogin(gate, failure.respond, NEW_LOGIN),
          session(),
          makeArea,
        );

        const first = h.context.tvRefreshSession().then((v) => v, (e) => e);
        await waitFor(() => h.calls.some(isToken)); // сетевой refresh в полёте

        const second = h.context.tvRefreshSession().then((v) => v, (e) => e); // присоединился ДО входа
        const logged = await h.context.tvOAuthSignIn(variant);
        assert.equal(logged.user.id, "user-2", "предусловие: конкурентный вход прошёл целиком");
        assert.equal(h.storage.tv_session?.access_token, NEW_ACCESS_TOKEN);

        const third = h.context.tvRefreshSession().then((v) => v, (e) => e); // присоединился ПОСЛЕ входа

        gate.resolve();
        const results = await Promise.all([first, second, third]);
        for (const [i, result] of results.entries()) {
          assert.equal(
            result?.user?.id,
            "user-2",
            `caller ${i + 1}: устаревшая ошибка refresh не имеет права вытеснить новый вход`,
          );
          assert.equal(result.access_token, NEW_ACCESS_TOKEN, `caller ${i + 1}: отдан credential нового входа`);
          assert.deepEqual(
            Object.keys(plain(result)).sort(),
            SESSION_KEYS,
            `caller ${i + 1}: наружу уходит только session — ни поколения, ни служебных полей`,
          );
        }

        assert.equal(h.storage.tv_session?.user.id, "user-2", "отказавший refresh не имеет права трогать новый вход");
        assert.equal(h.storage.tv_session.refresh_token, REFRESH_TOKEN, "ротации не было — записывать было нечего");
        assert.equal(
          h.calls.filter(isToken).length,
          1,
          "single-flight: три caller-а обязаны схлопнуться в один сетевой запрос",
        );
        const blob = [safeJson(plain(results[0])), h.logs.join("\n")].join("\n");
        assert.ok(!/generation|base|flight/i.test(blob), "внутренние метаданные не должны утекать в результат и логи");
        assertSerialized(h);
      });
    }

    test(`${variant}/${backend}: поколение не изменилось — исходная ошибка refresh сохраняется даже при чтениях`, async () => {
      for (const failure of REFRESH_FAILURES) {
        const gate = deferred();
        const h = oauthHarness(variant, gatedRefreshWithLogin(gate, failure.respond, NEW_LOGIN), session(), makeArea);

        const first = h.context.tvRefreshSession().then((v) => v, (e) => e);
        await waitFor(() => h.calls.some(isToken));

        // Чтения поколение не двигают: подавлять исходную ошибку им нечем.
        assert.equal((await h.context.tvGetSession())?.refresh_token, REFRESH_TOKEN);
        const second = h.context.tvRefreshSession().then((v) => v, (e) => e);

        gate.resolve();
        const [a, b] = await Promise.all([first, second]);
        assert.match(a.message, failure.message, `${failure.kind}: исходная ошибка обязана дойти до caller`);
        assert.match(b.message, failure.message, `${failure.kind}: второй caller обязан получить ту же ошибку`);
        assert.equal(h.storage.tv_session?.refresh_token, REFRESH_TOKEN, `${failure.kind}: сессия нетронута`);
        assert.equal(h.calls.filter(isToken).length, 1, `${failure.kind}: сетевой refresh обязан остаться единственным`);
      }
    });
  }
}

// ── ревизия 08: намерение ≠ факт ────────────────────────────────────────────
//
// Ревизия 07 сверяла отказавший refresh с ЕДИНСТВЕННЫМ счётчиком, который
// означал сразу и намерение (фенс устаревших записей), и факт сохранения. Он
// двигался ДО storage-операции и двигался даже у намерения, которое потом
// отменилось, поэтому отказавший refresh принимал за «состояние изменилось»:
//   собственную ОТКАЗАВШУЮ запись (set/remove в tvCommitRefresh);
//   отменённый или отказавший вход, не записавший ничего.
// В обоих случаях caller получал СТАРЫЙ credential как успешный результат.
// Ревизия 08 разводит эпоху намерений и ревизию зафиксированного; отказавший
// refresh сверяется только с ревизией.

const gatedRefreshWithSignIn = (gate, respond, exchangeImpl) => (url) => {
  const call = { url };
  if (isToken(call)) return gate.promise.then(respond);
  if (isExchange(call)) return Promise.resolve(exchangeImpl());
  return Promise.resolve(new Response(null, { status: 204 }));
};

const failedExchange = () =>
  new Response(JSON.stringify({ error: "invalid_grant" }), {
    status: 400,
    headers: { "Content-Type": "application/json" },
  });

// Ни в отказе, ни в логах не должно быть ни токенов, ни внутренних счётчиков.
function assertNoInternals(h, message, label) {
  const blob = [String(message), h.logs.join("\n")].join("\n");
  for (const secret of [ACCESS_TOKEN, REFRESH_TOKEN]) {
    assert.ok(!blob.includes(secret), `${label}: credential утёк в отказ или логи`);
  }
  assert.ok(!/epoch|revision|generation/i.test(blob), `${label}: внутренние счётчики утекли в отказ или логи`);
}

for (const [backend, makeArea] of BACKENDS) {
  for (const variant of VARIANTS) {
    test(`${variant}/${backend}: refresh 200 с отказавшим set(tv_session) отклоняется, а не выдаёт старый credential`, async () => {
      const gate = deferred();
      const h = oauthHarness(variant, gatedRefreshFetch(gate, () => rotatedResponse()), session(), makeArea);
      h.area.failNext("set", "tv_session");

      const first = h.context.tvRefreshSession().then((v) => v, (e) => e);
      await waitFor(() => h.calls.some(isToken));
      const second = h.context.tvRefreshSession().then((v) => v, (e) => e);

      gate.resolve();
      const results = await Promise.all([first, second]);
      for (const [i, result] of results.entries()) {
        const label = `caller ${i + 1}`;
        assert.ok(result?.message, `${label}: отказавшая запись обязана дойти как отказ, а не как сессия`);
        assert.equal(result.access_token, undefined, `${label}: старый credential не выдаётся за результат обновления`);
        assert.match(result.message, /storage unavailable/, `${label}: исходная ошибка storage обязана сохраниться`);
        assertNoInternals(h, result.message, label);
      }
      assert.equal(
        h.storage.tv_session?.refresh_token,
        REFRESH_TOKEN,
        "ротация не состоялась — в слоте обязана остаться прежняя сессия",
      );
      assert.equal(h.calls.filter(isToken).length, 1, "single-flight обязан сохраниться");
      assertSerialized(h);
    });

    test(`${variant}/${backend}: refresh 400/401/403 с отказавшим remove(tv_session) отклоняется`, async () => {
      for (const status of [400, 401, 403]) {
        const gate = deferred();
        const h = oauthHarness(
          variant,
          gatedRefreshFetch(gate, () => new Response(SERVER_BODY, { status })),
          session(),
          makeArea,
        );
        h.area.failNext("remove", "tv_session");

        const first = h.context.tvRefreshSession().then((v) => v, (e) => e);
        await waitFor(() => h.calls.some(isToken));
        const second = h.context.tvRefreshSession().then((v) => v, (e) => e);

        gate.resolve();
        const results = await Promise.all([first, second]);
        for (const [i, result] of results.entries()) {
          const label = `${status}/caller ${i + 1}`;
          assert.ok(result?.message, `${label}: отказавшая очистка обязана дойти как отказ`);
          assert.equal(result.access_token, undefined, `${label}: старый credential не выдаётся за результат`);
          assert.match(result.message, /storage unavailable/, `${label}: исходная ошибка storage обязана сохраниться`);
          assertNoInternals(h, result.message, label);
        }
        assert.equal(h.calls.filter(isToken).length, 1, `${status}: single-flight обязан сохраниться`);
        assertSerialized(h);
      }
    });

    test(`${variant}/${backend}: отказавший вход без записи session не подавляет исходную ошибку refresh`, async () => {
      for (const failure of REFRESH_FAILURES) {
        const gate = deferred();
        const h = oauthHarness(
          variant,
          gatedRefreshWithSignIn(gate, failure.respond, failedExchange),
          session(),
          makeArea,
        );

        const first = h.context.tvRefreshSession().then((v) => v, (e) => e);
        await waitFor(() => h.calls.some(isToken));

        await assert.rejects(h.context.tvOAuthSignIn(variant), /Authorization failed: invalid_grant/);
        assert.equal(
          h.storage.tv_session?.refresh_token,
          REFRESH_TOKEN,
          `${failure.kind}: отказавший вход не имеет права трогать слот`,
        );

        const second = h.context.tvRefreshSession().then((v) => v, (e) => e);
        gate.resolve();
        const [a, b] = await Promise.all([first, second]);
        assert.ok(a?.message, `${failure.kind}: намерение войти — не изменение состояния, caller обязан получить отказ`);
        assert.match(a.message, failure.message, `${failure.kind}: исходная ошибка refresh обязана сохраниться`);
        assert.ok(b?.message, `${failure.kind}: второй caller тоже обязан получить отказ`);
        assert.match(b.message, failure.message);
        assert.equal(h.calls.filter(isToken).length, 1, `${failure.kind}: single-flight обязан сохраниться`);
        assert.equal(
          h.area.maxProtected,
          1,
          `${failure.kind}: защищённые операции tv_session пересеклись: ${h.ops.join(",")}`,
        );
      }
    });

    test(`${variant}/${backend}: отменённый вход без записи session не подавляет исходную ошибку refresh`, async () => {
      for (const failure of REFRESH_FAILURES) {
        const gate = deferred();
        const h = oauthHarness(
          variant,
          gatedRefreshWithSignIn(gate, failure.respond, failedExchange),
          session(),
          makeArea,
        );
        // Настоящая отмена пользователем: launchWebAuthFlow возвращает пустой
        // редирект, поэтому до exchange дело не доходит вовсе.
        h.context.chrome.identity.launchWebAuthFlow = (_options, callback) => callback(undefined);

        const first = h.context.tvRefreshSession().then((v) => v, (e) => e);
        await waitFor(() => h.calls.some(isToken));

        await assert.rejects(h.context.tvOAuthSignIn(variant), /Authorization cancelled/);
        assert.equal(h.calls.filter(isExchange).length, 0, `${failure.kind}: отменённый вход не доходит до exchange`);
        assert.equal(
          h.storage.tv_session?.refresh_token,
          REFRESH_TOKEN,
          `${failure.kind}: отменённый вход не имеет права трогать слот`,
        );

        const second = h.context.tvRefreshSession().then((v) => v, (e) => e);
        gate.resolve();
        const [a, b] = await Promise.all([first, second]);
        assert.ok(a?.message, `${failure.kind}: отменённый вход не изменил состояние — caller обязан получить отказ`);
        assert.match(a.message, failure.message, `${failure.kind}: исходная ошибка refresh обязана сохраниться`);
        assert.ok(b?.message, `${failure.kind}: второй caller тоже обязан получить отказ`);
        assert.match(b.message, failure.message);
        assert.equal(h.calls.filter(isToken).length, 1, `${failure.kind}: single-flight обязан сохраниться`);
        assert.equal(
          h.area.maxProtected,
          1,
          `${failure.kind}: защищённые операции tv_session пересеклись: ${h.ops.join(",")}`,
        );
      }
    });

    test(`${variant}/${backend}: успешный logout при отказавшем refresh даёт authoritative null`, async () => {
      for (const failure of REFRESH_FAILURES) {
        const gate = deferred();
        const h = oauthHarness(variant, gatedRefreshFetch(gate, failure.respond), session(), makeArea);

        const first = h.context.tvRefreshSession().then((v) => v, (e) => e);
        await waitFor(() => h.calls.some(isToken));
        const second = h.context.tvRefreshSession().then((v) => v, (e) => e);

        const logout = await h.context.tvSignOutSession();
        assert.equal(logout.remoteRevoked, true, `${failure.kind}: предусловие — logout подтверждён`);
        assert.equal(h.storage.tv_session, undefined, `${failure.kind}: предусловие — слот пуст`);

        gate.resolve();
        const [a, b] = await Promise.all([first, second]);
        assert.equal(a, null, `${failure.kind}: после logout отказавший refresh обязан вернуть authoritative null`);
        assert.equal(b, null, `${failure.kind}: второй caller обязан получить тот же null`);
        assert.equal(h.storage.tv_session, undefined);
        assert.equal(h.calls.filter(isToken).length, 1, `${failure.kind}: single-flight обязан сохраниться`);
        assertSerialized(h);
      }
    });
  }
}

// ── ревизия 09: фенс commit не отдаёт содержимое слота за результат ─────────
//
// Ревизия 08 при несовпадении эпохи возвращала `tvReadSession()` как УСПЕШНЫЙ
// результат refresh. Эпоху двигает любое чужое НАМЕРЕНИЕ, в том числе то, чья
// запись потом отказала или которое отменилось: failed `tvSetSession`, failed
// logout, отказавший или отменённый вход. Ревизия при этом не менялась, в слоте
// оставалась ровно та сессия, с которой refresh начинался, — истёкшая или уже
// отвергнутая сервером, — и она выдавалась за обновление.
//
// Ревизия 09 передаёт в commit обе величины снимка: эпоха решает, можно ли
// писать, ревизия — что вернуть, когда писать нельзя.

const FENCED = /Session refresh superseded by a newer session change/;

// Два исхода сети, которые ДОХОДЯТ до commit: успешная ротация и отвергнутый
// сервером токен. Сетевые отказы (503, невалидное тело) до commit не доходят и
// закрыты блоком ревизии 08.
const COMMIT_OUTCOMES = [
  { kind: "200", respond: () => rotatedResponse() },
  { kind: "401", respond: () => new Response(SERVER_BODY, { status: 401 }) },
];

for (const [backend, makeArea] of BACKENDS) {
  for (const variant of VARIANTS) {
    test(`${variant}/${backend}: refresh 200 при конкурентном отказавшем tvSetSession отклоняется`, async () => {
      const gate = deferred();
      const h = oauthHarness(variant, gatedRefreshFetch(gate, () => rotatedResponse()), session(), makeArea);

      const first = h.context.tvRefreshSession().then((v) => v, (e) => e);
      await waitFor(() => h.calls.some(isToken)); // сетевой refresh в полёте

      h.area.failNext("set", "tv_session");
      await assert.rejects(h.context.tvSetSession(NEW_LOGIN), /storage unavailable/);
      assert.equal(
        h.storage.tv_session?.refresh_token,
        REFRESH_TOKEN,
        "предусловие: намерение setter состоялось, а запись — нет",
      );

      const second = h.context.tvRefreshSession().then((v) => v, (e) => e);
      gate.resolve();
      const results = await Promise.all([first, second]);
      for (const [i, result] of results.entries()) {
        const label = `caller ${i + 1}`;
        assert.ok(result?.message, `${label}: фенс обязан дойти как отказ, а не как сессия`);
        assert.equal(result.access_token, undefined, `${label}: устаревший credential не выдаётся за обновление`);
        assert.match(result.message, FENCED, `${label}: стабильное сообщение фенса`);
        assertNoInternals(h, result.message, label);
      }
      assert.equal(h.storage.tv_session?.refresh_token, REFRESH_TOKEN, "ротация не записана: фенс запретил запись");
      assert.equal(h.calls.filter(isToken).length, 1, "single-flight обязан сохраниться");
      assertSerialized(h);
    });

    test(`${variant}/${backend}: refresh 401 при конкурентном отказавшем logout отклоняется`, async () => {
      const gate = deferred();
      const h = oauthHarness(
        variant,
        gatedRefreshFetch(gate, () => new Response(SERVER_BODY, { status: 401 })),
        session(),
        makeArea,
      );

      const first = h.context.tvRefreshSession().then((v) => v, (e) => e);
      await waitFor(() => h.calls.some(isToken));

      h.area.failNext("remove", "tv_session");
      await assert.rejects(h.context.tvSignOutSession(), /storage unavailable/);
      assert.equal(revokeCalls(h).length, 0, "предусловие: отказавшая секция logout до сети не дошла");
      assert.equal(
        h.storage.tv_session?.refresh_token,
        REFRESH_TOKEN,
        "предусловие: намерение logout состоялось, а удаление — нет",
      );

      const second = h.context.tvRefreshSession().then((v) => v, (e) => e);
      gate.resolve();
      const results = await Promise.all([first, second]);
      for (const [i, result] of results.entries()) {
        const label = `caller ${i + 1}`;
        assert.ok(result?.message, `${label}: фенс обязан дойти как отказ`);
        assert.equal(result.access_token, undefined, `${label}: отвергнутый сервером credential не выдаётся наружу`);
        assert.match(result.message, FENCED, `${label}: стабильное сообщение фенса`);
        assertNoInternals(h, result.message, label);
      }
      assert.equal(h.calls.filter(isToken).length, 1, "single-flight обязан сохраниться");
      assertSerialized(h);
    });

    test(`${variant}/${backend}: отказавший вход без committed session отклоняет refresh 200 и 401`, async () => {
      for (const outcome of COMMIT_OUTCOMES) {
        const gate = deferred();
        const h = oauthHarness(
          variant,
          gatedRefreshWithSignIn(gate, outcome.respond, failedExchange),
          session(),
          makeArea,
        );

        const first = h.context.tvRefreshSession().then((v) => v, (e) => e);
        await waitFor(() => h.calls.some(isToken));

        await assert.rejects(h.context.tvOAuthSignIn(variant), /Authorization failed: invalid_grant/);
        assert.equal(
          h.storage.tv_session?.refresh_token,
          REFRESH_TOKEN,
          `${outcome.kind}: отказавший вход не записал session`,
        );

        const second = h.context.tvRefreshSession().then((v) => v, (e) => e);
        gate.resolve();
        const [a, b] = await Promise.all([first, second]);
        assert.ok(a?.message, `${outcome.kind}: намерение войти — не изменение, caller обязан получить отказ`);
        assert.match(a.message, FENCED, `${outcome.kind}: стабильное сообщение фенса`);
        assert.ok(b?.message, `${outcome.kind}: второй caller тоже обязан получить отказ`);
        assert.match(b.message, FENCED);
        assertNoInternals(h, a.message, outcome.kind);
        assert.equal(h.calls.filter(isToken).length, 1, `${outcome.kind}: single-flight обязан сохраниться`);
        assert.equal(
          h.area.maxProtected,
          1,
          `${outcome.kind}: защищённые операции tv_session пересеклись: ${h.ops.join(",")}`,
        );
      }
    });

    test(`${variant}/${backend}: отменённый вход без committed session отклоняет refresh 200 и 401`, async () => {
      for (const outcome of COMMIT_OUTCOMES) {
        const gate = deferred();
        const h = oauthHarness(
          variant,
          gatedRefreshWithSignIn(gate, outcome.respond, failedExchange),
          session(),
          makeArea,
        );
        h.context.chrome.identity.launchWebAuthFlow = (_options, callback) => callback(undefined);

        const first = h.context.tvRefreshSession().then((v) => v, (e) => e);
        await waitFor(() => h.calls.some(isToken));

        await assert.rejects(h.context.tvOAuthSignIn(variant), /Authorization cancelled/);
        assert.equal(h.calls.filter(isExchange).length, 0, `${outcome.kind}: отмена происходит раньше exchange`);
        assert.equal(
          h.storage.tv_session?.refresh_token,
          REFRESH_TOKEN,
          `${outcome.kind}: отменённый вход не записал session`,
        );

        const second = h.context.tvRefreshSession().then((v) => v, (e) => e);
        gate.resolve();
        const [a, b] = await Promise.all([first, second]);
        assert.ok(a?.message, `${outcome.kind}: отменённый вход не изменил состояние — caller обязан получить отказ`);
        assert.match(a.message, FENCED, `${outcome.kind}: стабильное сообщение фенса`);
        assert.ok(b?.message, `${outcome.kind}: второй caller тоже обязан получить отказ`);
        assert.match(b.message, FENCED);
        assert.equal(h.calls.filter(isToken).length, 1, `${outcome.kind}: single-flight обязан сохраниться`);
        assert.equal(
          h.area.maxProtected,
          1,
          `${outcome.kind}: защищённые операции tv_session пересеклись: ${h.ops.join(",")}`,
        );
      }
    });

    test(`${variant}/${backend}: успешный конкурентный вход при refresh 200 отдаёт новую сессию`, async () => {
      const gate = deferred();
      const h = oauthHarness(
        variant,
        gatedRefreshWithLogin(gate, () => rotatedResponse(), NEW_LOGIN),
        session(),
        makeArea,
      );

      const first = h.context.tvRefreshSession().then((v) => v, (e) => e);
      await waitFor(() => h.calls.some(isToken));

      const logged = await h.context.tvOAuthSignIn(variant);
      assert.equal(logged.user.id, "user-2", "предусловие: вход записал session");

      const second = h.context.tvRefreshSession().then((v) => v, (e) => e);
      gate.resolve();
      const [a, b] = await Promise.all([first, second]);
      assert.equal(a?.user?.id, "user-2", "состоявшееся изменение обязано дойти до caller");
      assert.equal(a.access_token, NEW_ACCESS_TOKEN);
      assert.equal(b?.user?.id, "user-2", "второй caller обязан получить ту же сессию");
      assert.equal(h.storage.tv_session?.user.id, "user-2");
      assert.equal(h.storage.tv_session.refresh_token, REFRESH_TOKEN, "ротация старой сессии не записана");
      assert.equal(h.calls.filter(isToken).length, 1, "single-flight обязан сохраниться");
      assertSerialized(h);
    });

    test(`${variant}/${backend}: успешный logout при refresh 401 отдаёт null`, async () => {
      const gate = deferred();
      const h = oauthHarness(
        variant,
        gatedRefreshFetch(gate, () => new Response(SERVER_BODY, { status: 401 })),
        session(),
        makeArea,
      );

      const first = h.context.tvRefreshSession().then((v) => v, (e) => e);
      await waitFor(() => h.calls.some(isToken));
      const second = h.context.tvRefreshSession().then((v) => v, (e) => e);

      const logout = await h.context.tvSignOutSession();
      assert.equal(logout.remoteRevoked, true, "предусловие: logout подтверждён");
      assert.equal(h.storage.tv_session, undefined, "предусловие: слот пуст");

      gate.resolve();
      const [a, b] = await Promise.all([first, second]);
      assert.equal(a, null, "состоявшийся logout обязан дойти как authoritative null");
      assert.equal(b, null, "второй caller обязан получить тот же null");
      assert.equal(h.storage.tv_session, undefined);
      assert.equal(h.calls.filter(isToken).length, 1, "single-flight обязан сохраниться");
      assertSerialized(h);
    });
  }
}

// ── ревизия 10: база держателя фиксируется вместе со снимком ────────────────
//
// Ревизия 09 присваивала `flight.base` СНАРУЖИ, после успешного
// `await tvAcquireRefresh()`. Отказ первого же `get(tv_session)` оставлял базу
// `null`, и per-caller readback терял способность распознать состоявшееся
// позже изменение: `base === null` трактуется как «сравнивать не с чем», и
// caller получал устаревшую storage-ошибку вместо новой сессии или null.
// Ревизия 10 ставит базу ВНУТРИ секции снимка, до чтения storage.

const noRefreshFetch = () => Promise.resolve(new Response(null, { status: 204 }));

for (const [backend, makeArea] of BACKENDS) {
  for (const variant of VARIANTS) {
    test(`${variant}/${backend}: отказ первого get(tv_session) не мешает распознать более позднюю запись`, async () => {
      const h = oauthHarness(variant, noRefreshFetch, session(), makeArea);
      const hold = h.area.holdNext("get", "tv_session");
      h.area.failNext("get", "tv_session");

      const first = h.context.tvRefreshSession().then((v) => v, (e) => e);
      await hold.started; // секция снимка начата — база уже зафиксирована

      const writing = h.context.tvSetSession(NEW_LOGIN); // встаёт в очередь ПОСЛЕ снимка
      await settle(6);
      hold.release(); // чтение отказывает → flight отклонён

      await writing;
      const result = await first;
      assert.equal(result?.user?.id, "user-2", "состоявшаяся запись обязана дойти до caller");
      assert.equal(result.access_token, NEW_ACCESS_TOKEN, "отдан credential состоявшейся записи");
      assert.equal(h.storage.tv_session?.user.id, "user-2");
      assert.equal(h.calls.length, 0, "сеть не трогалась: flight отказал до запроса");
      assertNoInternals(h, "", "readback");
      assertSerialized(h);
    });

    test(`${variant}/${backend}: отказ первого get(tv_session) не мешает распознать более поздний logout`, async () => {
      const h = oauthHarness(variant, noRefreshFetch, session(), makeArea);
      const hold = h.area.holdNext("get", "tv_session");
      h.area.failNext("get", "tv_session");

      const first = h.context.tvRefreshSession().then((v) => v, (e) => e);
      await hold.started;

      const logout = h.context.tvSignOutSession();
      await settle(6);
      hold.release();

      const result = await logout;
      assert.equal(result.remoteRevoked, true, "предусловие: logout подтверждён");
      assert.equal(await first, null, "состоявшийся logout обязан дойти как authoritative null");
      assert.equal(h.storage.tv_session, undefined);
      assert.equal(revokeCalls(h).length, 1, "отозван ровно один credential");
      assertSerialized(h);
    });

    test(`${variant}/${backend}: отказ первого get(tv_session) без последующих изменений сохраняет storage-ошибку`, async () => {
      const h = oauthHarness(variant, noRefreshFetch, session(), makeArea);
      h.area.failNext("get", "tv_session");

      const result = await h.context.tvRefreshSession().then((v) => v, (e) => e);
      assert.ok(result?.message, "caller обязан получить отказ");
      assert.match(result.message, /storage unavailable/, "исходная storage-ошибка обязана сохраниться");
      assert.equal(result.access_token, undefined, "прежняя сессия не выдаётся за результат обновления");
      assert.equal(h.storage.tv_session?.refresh_token, REFRESH_TOKEN, "слот не тронут");
      assert.equal(h.calls.length, 0, "сеть не трогалась");
      assertNoInternals(h, result.message, "control");
      assert.equal(h.area.maxProtected, 1, `защищённые операции tv_session пересеклись: ${h.ops.join(",")}`);
    });

    test(`${variant}/${backend}: отказавший install-сброс держит sealed выше базы, успешный возвращает refresh к работе`, async () => {
      const h = oauthHarness(variant, noRefreshFetch, session(), makeArea);
      h.area.failNext("remove");

      await assert.rejects(h.context.tvBeginInstallStateReset(), /storage unavailable/);
      await assert.rejects(h.context.tvRefreshSession(), SEALED);
      assert.equal(h.calls.length, 0, "в запечатанном состоянии сеть не трогается");
      assert.deepEqual(h.ops, ["remove"], "запечатанный refresh не выполняет storage-операций: база не ставится");
      assert.equal(h.storage.tv_session?.access_token, ACCESS_TOKEN, "старый credential не тронут");

      await h.context.tvBeginInstallStateReset();
      assert.equal(
        await h.context.tvRefreshSession(),
        null,
        "после успешного сброса refresh работает и видит очищенный слот",
      );
      assert.equal(h.calls.length, 0, "пустой слот в сеть не ходит");
    });

    test(`${variant}/${backend}: состоявшаяся запись после фенса доходит до caller`, async () => {
      const gate = deferred();
      const h = oauthHarness(
        variant,
        gatedRefreshWithLogin(gate, () => rotatedResponse(), NEW_LOGIN),
        session(),
        makeArea,
      );

      const first = h.context.tvRefreshSession().then((v) => v, (e) => e);
      await waitFor(() => h.calls.some(isToken)); // снимок взят, база зафиксирована, сеть в полёте

      // Чужое намерение с ОТКАЗАВШЕЙ записью: эпоха сдвинута, ревизия — нет,
      // поэтому commit ниже обязан отфенсить.
      h.area.failNext("set", "tv_session");
      await assert.rejects(h.context.tvSetSession(NEW_LOGIN), /storage unavailable/);

      // Блокируем очередь, чтобы поставить УСПЕШНУЮ запись строго ПОСЛЕ секции
      // commit и строго ДО per-caller readback.
      const holdQueue = h.area.holdNext("get", "tv_session");
      const blocking = h.context.tvGetSession();
      await holdQueue.started;

      gate.resolve(); // секция commit встаёт в очередь за блокирующей
      await settle(6);
      const committing = h.context.tvSetSession(SECOND_LOGIN); // встаёт ПОСЛЕ commit
      await settle(6);
      holdQueue.release();

      await blocking;
      await committing;
      const result = await first;
      assert.equal(result?.user?.id, "user-3", "после фенса состоявшаяся запись обязана дойти до caller");
      assert.equal(result.access_token, SECOND_ACCESS_TOKEN);
      assert.equal(h.storage.tv_session?.user.id, "user-3", "ротация старой сессии не записана");
      assert.equal(h.calls.filter(isToken).length, 1, "single-flight обязан сохраниться");
    });

    test(`${variant}/${backend}: после отказавшего flight следующий refresh стартует новый сетевой запрос`, async () => {
      let served = 0;
      const h = oauthHarness(
        variant,
        (url) => {
          if (isToken({ url })) {
            served++;
            return Promise.resolve(served === 1 ? new Response(SERVER_BODY, { status: 503 }) : rotatedResponse());
          }
          return Promise.resolve(new Response(null, { status: 204 }));
        },
        session(),
        makeArea,
      );

      const failed = await h.context.tvRefreshSession().then((v) => v, (e) => e);
      assert.ok(failed?.message, "первый flight обязан отказать");
      assert.match(failed.message, /Session refresh temporarily unavailable \(503\)/);
      assert.equal(h.storage.tv_session?.refresh_token, REFRESH_TOKEN, "отказавший flight ничего не записал");

      const second = await h.context.tvRefreshSession();
      assert.equal(second?.refresh_token, "rotated", "следующий flight обязан пройти целиком");
      assert.equal(h.storage.tv_session?.refresh_token, "rotated");
      assert.equal(
        h.calls.filter(isToken).length,
        2,
        "держатель снят после отказа: второй вызов обязан сделать НОВЫЙ сетевой запрос",
      );
      assertSerialized(h);
    });
  }
}

test("бэкенды storage расходятся в порядке завершения (контроль harness)", async () => {
  // Если бы враждебный бэкенд вёл себя как FIFO, зелёные тесты выше ничего не
  // говорили бы о независимости от порядка завершения.
  const finished = [];
  const fifo = fifoArea({ tv_session: session("first") });
  await Promise.all([
    fifo.set({ tv_session: session("A") }).then(() => finished.push("A")),
    fifo.set({ tv_session: session("B") }).then(() => finished.push("B")),
  ]);
  assert.deepEqual(finished, ["A", "B"], "FIFO-бэкенд завершает в порядке старта");
  assert.equal(fifo.data.tv_session.refresh_token, "B");
  assert.equal(fifo.maxMutations, 2, "две несериализованные мутации обязаны быть видны как пересечение");

  finished.length = 0;
  const hostile = reorderArea({ tv_session: session("first") });
  await Promise.all([
    hostile.set({ tv_session: session("A") }).then(() => finished.push("A")),
    hostile.set({ tv_session: session("B") }).then(() => finished.push("B")),
  ]);
  assert.deepEqual(finished, ["B", "A"], "враждебный бэкенд обязан ломать FIFO");
  assert.equal(hostile.data.tv_session.refresh_token, "A", "и применять операции в обратном порядке");
  assert.equal(hostile.maxMutations, 2);
});

test("harness воспроизводит окно F-01 на несериализованном writer (контроль)", async () => {
  // Дофиксовая последовательность: READ → сравнение → SET, без критической
  // секции. Если этот контроль перестанет воскрешать сессию, значит harness
  // больше не открывает окно и зелёные тесты выше ничего не доказывают.
  const area = fifoArea({ tv_session: session() });
  const gate = deferred();
  let atNetwork = false;

  const naiveRefresh = (async () => {
    const { tv_session: before } = await area.get("tv_session");
    atNetwork = true;
    const next = await (await gate.promise).json();
    const { tv_session: current } = await area.get("tv_session");
    if (current?.refresh_token !== before?.refresh_token) return current || null;
    await area.set({ tv_session: next });
    return next;
  })();
  await waitFor(() => atNetwork);

  const naiveLogout = (async () => {
    await area.get("tv_session");
    await area.remove("tv_session");
  })();
  await settle(1);
  gate.resolve(rotatedResponse());
  await naiveRefresh;
  await naiveLogout;

  assert.deepEqual(area.ops, ["get", "get", "get", "remove", "set"]);
  assert.equal(
    area.data.tv_session?.refresh_token,
    "rotated",
    "контроль обязан воскресить сессию — иначе harness не доказывает фикс",
  );
});

// Сравнение двух вариантов возможно только там, где лежат оба. В public-only
// экспорте admin/ нет, и копировать его туда нельзя; защита носителя PUB-07
// при этом остаётся проверенной ПОВЕДЕНЧЕСКИ в pub07-storage-barrier.test.mjs,
// а не совпадением строки в исходнике.
test("public и admin используют один эквивалентный logout-контракт", { skip: VARIANTS.includes("admin") ? false : "область public: admin/ вне экспорта" }, () => {
  // Сравнение oauth.js целиком больше невозможно и больше НЕ нужно: PUB-07 ввёл
  // защиту носителя только в public, а admin — отдельный пакет и в этот срез не
  // входит. Чтобы расхождение не стало тихим, здесь проверяется ровно то, чем
  // этот тест и назван — контракт logout, — плюс сам факт расхождения.
  const logoutContract = /const TV_LOGOUT_MAX_ATTEMPTS[\s\S]*?\nconst TV_SIGN_IN_SUPERSEDED/;
  const publicLogout = src.public.oauth.match(logoutContract)?.[0];
  const adminLogout = src.admin.oauth.match(logoutContract)?.[0];
  assert.ok(publicLogout && adminLogout, "блок logout не найден в одном из вариантов");
  assert.equal(publicLogout, adminLogout, "контракт logout вариантов разошёлся");

  // Публичная поверхность модуля обязана остаться той же: PUB-07 не добавляет
  // ни одного нового экспорта и ни одной новой точки входа.
  const exports_ = /self\.tvOAuthSignIn[\s\S]*?self\.TV_SESSION_AREA = TV_SESSION_AREA;/;
  assert.equal(
    src.public.oauth.match(exports_)?.[0],
    src.admin.oauth.match(exports_)?.[0],
    "экспортируемая поверхность oauth.js разошлась",
  );

  // Расхождение зафиксировано намеренно и в одну сторону. Если защита исчезнет
  // из public или окажется в admin без отдельного пакета — тест упадёт.
  assert.match(src.public.oauth, /TV_CARRIER_UNPROTECTED/, "public потерял защиту носителя (PUB-07)");
  assert.doesNotMatch(src.admin.oauth, /TV_CARRIER_UNPROTECTED/, "admin получил защиту носителя вне своего пакета");

  assert.equal(src.public.supabase, src.admin.supabase, "supabase.js вариантов разошлись");

  const logoutBlock = /on\("logoutBtn", "click"[\s\S]*?\n\}\);/;
  const publicBlock = src.public.popup.match(logoutBlock)?.[0];
  const adminBlock = src.admin.popup.match(logoutBlock)?.[0];
  assert.ok(publicBlock && adminBlock, "обработчик logout не найден");
  assert.equal(publicBlock, adminBlock, "поведение logout в popup разошлось");

  const warnRe = /<p id="logoutWarn" class="warn" role="alert" hidden>([^<]+)<\/p>/;
  const copies = VARIANTS.map((variant) => {
    assert.match(
      src[variant].background,
      /tvSignOutSession\(\)\s*\.then\(\(result\) => sendResponse\(\{ ok: true, result \}\)\)/,
      `${variant}: background не передаёт структурный result`,
    );
    assert.equal(
      (src[variant].popup.match(/logoutWarn/g) || []).length,
      1,
      `${variant}: popup.js трогает предупреждение больше чем в одном месте`,
    );
    const copy = src[variant].popupHtml.match(warnRe)?.[1];
    assert.ok(copy, `${variant}: скрытое предупреждение отсутствует в popup.html`);
    // Текст статичен: подставить в него exception, статус или токен нечем.
    assert.ok(!/\$\{|%s/.test(copy), `${variant}: предупреждение содержит интерполяцию`);
    return copy;
  });
  assert.equal(copies[0], copies[1], "тексты предупреждения разошлись");
});

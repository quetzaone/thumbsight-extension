// node --test: восстановление публичного расширения после PostgREST `401 PGRST303`.
//
// Проверяем инварианты, а не формулировки:
//   повтор уходит с ТЕМ ЖЕ Authorization на всех попытках;
//   между попытками нет ни refresh, ни повторного чтения сессии;
//   бюджет ограничен, паузы растут и джиттерятся, abort их прекращает;
//   любой ДРУГОЙ 401 (в т.ч. malformed body) сохраняет прежний refresh-путь;
//   writes и Edge Function по PGRST303-правилу не повторяются;
//   токен не попадает ни в логи, ни в storage;
//   боевой extension-код действительно ходит через исправленную обёртку.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

import { WITH_PRIVATE } from "./scope.mjs";

const EXT_ID = "a".repeat(32);
const ACCESS_TOKEN = `access-${"x".repeat(40)}`;
const ROTATED_TOKEN = `access-${"y".repeat(40)}`;
const HOSTILE_TOKEN = `access-${"z".repeat(40)}`;
const REFRESH_TOKEN = "refresh-secret-1";
const CONFIG = {
  SUPABASE_URL: "https://project.supabase.co",
  SUPABASE_ANON_KEY: "anon-key",
  AUTH_SITE_URL: "https://thumbsight.com",
};
const CONFIG_SRC = `self.THUMBVAULT_CONFIG = ${JSON.stringify(CONFIG)};`;

const REST = `${CONFIG.SUPABASE_URL}/rest/v1/`;
const FUNCTIONS = `${CONFIG.SUPABASE_URL}/functions/v1/`;
const TOKEN_URL = `${CONFIG.SUPABASE_URL}/auth/v1/token`;

// Ровно то тело, что владелец наблюдал на проде
// (CLAUDE-SEC-JWT-IAT-SKEW-DATALOAD-01.md §3.1).
const PGRST303 = JSON.stringify({
  code: "PGRST303",
  details: null,
  hint: null,
  message: "JWT issued at future",
});
const PGRST301 = JSON.stringify({ code: "PGRST301", details: null, hint: null, message: "JWT expired" });

const COLLECTIONS = "collections?select=id,name&order=name.asc";
const ROWS = [{ id: "c1", name: "Ideas" }];
const ROWS_BODY = JSON.stringify(ROWS);

const file = (name) => readFile(new URL(`../${name}`, import.meta.url), "utf8");
const src = {
  background: await file("background.js"),
  oauth: await file("oauth.js"),
  intent: await file("intent.js"),
  supabase: await file("supabase.js"),
  api: await file("api.js"),
};
// Сверка «правило не утекло в admin» возможна только там, где admin лежит
// рядом. В public-only экспорте его нет, и копировать его сюда нельзя —
// проверка объявляется внутренней (см. tests/scope.mjs), а весь остальной
// PostgREST-набор этого файла в public-области остаётся обязательным.
const adminBackground = WITH_PRIVATE
  ? await readFile(new URL("../../admin/background.js", import.meta.url), "utf8")
  : null;

// --------------------------------------------------------------- фикстуры

function makeSession(accessToken = ACCESS_TOKEN, refreshToken = REFRESH_TOKEN) {
  return {
    access_token: accessToken,
    refresh_token: refreshToken,
    token_type: "bearer",
    expires_in: 3600,
    expires_at: Math.floor(Date.now() / 1000) + 3600,
    user: { id: "user-1", email: "user@example.com" },
  };
}

function memoryArea(initial = {}) {
  const data = { ...initial };
  const ops = [];
  return {
    data,
    ops,
    async get(keys) {
      ops.push("get");
      if (keys === null || keys === undefined) return { ...data };
      const list = Array.isArray(keys) ? keys : [keys];
      return Object.fromEntries(list.filter((key) => key in data).map((key) => [key, data[key]]));
    },
    async set(values) {
      ops.push("set");
      Object.assign(data, values);
    },
    async remove(keys) {
      ops.push("remove");
      for (const key of Array.isArray(keys) ? keys : [keys]) delete data[key];
    },
    async setAccessLevel() {},
  };
}

// Тело Response читается ровно один раз, поэтому сценарий отдаёт не готовые
// ответы, а фабрики: последний шаг повторяется, и каждый повтор обязан получить
// свежее тело.
const make = (status, text) =>
  new Response(status === 204 ? null : text, {
    status,
    headers: { "Content-Type": "application/json" },
  });

const resp = (status, text) => () => make(status, text);
const denied = () => resp(401, PGRST303);
const ok = (text = ROWS_BODY) => resp(200, text);

// Ответы отдаются по порядку REST-запросов; последний шаг повторяется, что и
// нужно сценарию «отказ не проходит никогда».
function responder({ rest = [ok()], auth, fn } = {}) {
  let i = 0;
  return async (url, options) => {
    if (url.startsWith(TOKEN_URL)) {
      return auth
        ? auth(url, options)
        : make(200, JSON.stringify(makeSession(ROTATED_TOKEN, "refresh-secret-2")));
    }
    if (url.startsWith(FUNCTIONS)) {
      if (!fn) throw new Error(`unexpected function fetch: ${url}`);
      return fn(url, options);
    }
    if (!url.startsWith(REST)) throw new Error(`unexpected fetch host: ${url}`);
    const step = rest[Math.min(i, rest.length - 1)];
    i += 1;
    return step(url, options, i);
  };
}

const panelSender = () => ({
  id: EXT_ID,
  url: `chrome-extension://${EXT_ID}/panel.html`,
  tab: { id: 7 },
});

function harness({ fetchImpl = responder(), session = makeSession() } = {}) {
  const local = memoryArea(session ? { tv_session: session } : {});
  const calls = [];
  const logs = [];
  const push = (...args) => {
    logs.push(args.map((a) => (typeof a === "string" ? a : safeJson(a))).join(" "));
  };
  let listener = null;

  const sw = {
    chrome: {
      storage: { local, session: memoryArea() },
      identity: { getRedirectURL: () => `https://${EXT_ID}.chromiumapp.org/auth` },
      runtime: {
        id: EXT_ID,
        lastError: null,
        getURL: (path) => `chrome-extension://${EXT_ID}/${path}`,
        onInstalled: { addListener() {} },
        onMessage: { addListener: (fn) => { listener = fn; } },
      },
      tabs: { create() {}, remove() {} },
    },
    crypto: globalThis.crypto,
    TextEncoder,
    URL,
    URLSearchParams,
    // PUB-06: у необязательного snapshot собственный AbortController, поэтому
    // worker-контекст обязан его иметь — иначе tvInvokeFunction падает ещё до сети.
    AbortController,
    btoa,
    setTimeout,
    clearTimeout,
    console: { log: push, info: push, warn: push, error: push, debug: push },
    fetch: (url, options) => {
      const call = {
        url: String(url),
        method: String(options?.method || "GET").toUpperCase(),
        auth: options?.headers?.Authorization || null,
        body: options?.body ?? null,
      };
      calls.push(call);
      return fetchImpl(call.url, options, calls.length);
    },
  };
  sw.self = sw;
  vm.createContext(sw);
  sw.importScripts = (...names) => {
    for (const name of names) {
      const key = name.replace(/\.js$/, "");
      const code = key === "config" ? CONFIG_SRC : src[key];
      if (!code) throw new Error(`missing importScripts source: ${name}`);
      vm.runInContext(code, sw, { filename: `public/${name}` });
    }
  };
  vm.runInContext(src.background, sw, { filename: "public/background.js" });
  assert.ok(listener, "background не зарегистрировал onMessage listener");

  // Счётчики ставятся поверх глобалей контекста: `tvSupabaseRest` зовёт эти имена
  // свободно, значит видит именно обёртки.
  const counters = { validSession: 0, refreshSession: 0, waits: [] };
  const origValid = sw.tvValidSession;
  sw.tvValidSession = (...args) => { counters.validSession += 1; return origValid(...args); };
  const origRefresh = sw.tvRefreshSession;
  sw.tvRefreshSession = (...args) => { counters.refreshSession += 1; return origRefresh(...args); };

  const h = {
    sw,
    calls,
    logs,
    counters,
    local,
    listener,
    restCalls: () => calls.filter((c) => c.url.startsWith(REST)),
    authCalls: () => calls.filter((c) => c.url.startsWith(TOKEN_URL)),
    fnCalls: () => calls.filter((c) => c.url.startsWith(FUNCTIONS)),
    // Снимает ожидание со стены, но сохраняет и настоящую величину паузы, и
    // настоящую реакцию на abort.
    fakeSleep() {
      const origSleep = sw.tvSleep;
      sw.tvSleep = (ms, signal) => { counters.waits.push(ms); return origSleep(0, signal); };
      return h;
    },
    rest: (path, opts = {}) => sw.tvSupabaseRest(path, opts),
    send: (message, sender = panelSender()) =>
      new Promise((resolve) => { listener(message, sender, resolve); }),
  };
  return h;
}

function pageHarness(h) {
  const page = {
    chrome: {
      runtime: {
        id: EXT_ID,
        lastError: null,
        sendMessage: (message, callback) => { h.listener(message, panelSender(), callback); },
      },
    },
    console: { log() {}, warn() {}, error() {}, info() {}, debug() {} },
    URL,
    setTimeout,
    clearTimeout,
  };
  page.window = page;
  vm.createContext(page);
  vm.runInContext(src.supabase, page, { filename: "public/supabase.js" });
  vm.runInContext(src.api, page, { filename: "public/api.js" });
  return page;
}

function safeJson(value) {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

async function rejection(promise) {
  try {
    await promise;
  } catch (err) {
    return err;
  }
  throw new Error("ожидался отказ, а промис разрешился");
}

const authHeaders = (h) => h.restCalls().map((c) => c.auth);

// ------------------------------------------------- 1. тот же Authorization

test("PGRST303: все попытки уходят с ОДНИМ И ТЕМ ЖЕ Authorization", async () => {
  const h = harness({ fetchImpl: responder({ rest: [denied(), denied(), ok()] }) }).fakeSleep();

  const data = await h.rest(COLLECTIONS);

  assert.equal(JSON.stringify(data), ROWS_BODY, "успешное тело осталось разбираемым");
  assert.equal(h.restCalls().length, 3);
  assert.deepEqual(new Set(authHeaders(h)).size, 1, "Authorization менялся между попытками");
  assert.equal(authHeaders(h)[0], `Bearer ${ACCESS_TOKEN}`);
});

test("PGRST303: враждебная перезапись tv_session между попытками не меняет Authorization", async () => {
  // Между первым отказом и повтором кто-то другой кладёт в слот новую сессию.
  // Повтор ОБЯЗАН уйти со старым токеном: перечитывать слот запрещено.
  const h = harness({
    fetchImpl: responder({
      rest: [
        () => {
          h.local.data.tv_session = makeSession(HOSTILE_TOKEN, "refresh-secret-9");
          return make(401, PGRST303);
        },
        ok(),
      ],
    }),
  }).fakeSleep();

  await h.rest(COLLECTIONS);

  assert.equal(h.restCalls().length, 2);
  assert.deepEqual(authHeaders(h), [`Bearer ${ACCESS_TOKEN}`, `Bearer ${ACCESS_TOKEN}`]);
  assert.equal(h.local.data.tv_session.access_token, HOSTILE_TOKEN, "слот действительно был перезаписан");
});

// ------------------------------------------- 2. между попытками нет refresh

test("PGRST303: между попытками нет ни refresh, ни повторного чтения сессии", async () => {
  const h = harness({ fetchImpl: responder({ rest: [denied(), denied(), denied(), ok()] }) }).fakeSleep();

  await h.rest(COLLECTIONS);

  assert.equal(h.restCalls().length, 4);
  assert.equal(h.authCalls().length, 0, "уходил запрос к /auth/v1/token");
  assert.equal(h.counters.refreshSession, 0, "звался tvRefreshSession");
  assert.equal(h.counters.validSession, 1, "сессия читалась больше одного раза");
  assert.equal(h.local.ops.filter((op) => op !== "get").length, 0, "storage писался во время повторов");
});

// ------------------------------------------------------ 3. бюджет ограничен

test("PGRST303: бюджет ограничен четырьмя запросами, исчерпание даёт честную ошибку", async () => {
  const h = harness({ fetchImpl: responder({ rest: [denied()] }) }).fakeSleep();

  const err = await rejection(h.rest(COLLECTIONS));

  assert.equal(h.restCalls().length, 4, "повторов больше бюджета");
  assert.equal(h.counters.waits.length, 3);
  assert.equal(err.message, `401: ${PGRST303}`);
  // Вызывающий обязан суметь разобрать причину из текста ошибки.
  assert.equal(JSON.parse(err.message.slice("401: ".length)).code, "PGRST303");
  assert.equal(h.authCalls().length, 0, "исчерпание не должно скатываться в refresh");
});

test("PGRST303: паузы растут экспоненциально и джиттерятся", async () => {
  const bands = [[75, 150], [150, 300], [300, 600]];
  const seen = [new Set(), new Set(), new Set()];

  for (let run = 0; run < 25; run++) {
    const h = harness({ fetchImpl: responder({ rest: [denied()] }) }).fakeSleep();
    await rejection(h.rest(COLLECTIONS));
    assert.equal(h.counters.waits.length, 3);
    h.counters.waits.forEach((ms, i) => {
      assert.ok(ms >= bands[i][0] && ms <= bands[i][1], `пауза ${i} вне [${bands[i]}]: ${ms}`);
      seen[i].add(ms);
    });
  }

  for (const [i, values] of seen.entries()) {
    assert.ok(values.size > 1, `пауза ${i} постоянна — джиттера нет`);
  }
});

test("боевой tvSleep действительно ждёт (подмены нет)", async () => {
  const h = harness({ fetchImpl: responder({ rest: [denied(), ok()] }) });

  const started = Date.now();
  await h.rest(COLLECTIONS);
  const elapsed = Date.now() - started;

  assert.equal(h.restCalls().length, 2);
  assert.ok(elapsed >= 60, `ожидание не состоялось: ${elapsed} мс`);
});

// -------------------------------------------- 4. другие 401 — прежний путь

test("обычный 401 сохраняет прежний refresh-путь", async () => {
  const h = harness({ fetchImpl: responder({ rest: [resp(401, PGRST301), ok()] }) }).fakeSleep();

  const data = await h.rest(COLLECTIONS);

  assert.equal(JSON.stringify(data), ROWS_BODY);
  assert.equal(h.restCalls().length, 2);
  assert.equal(h.authCalls().length, 1, "refresh не состоялся");
  assert.deepEqual(authHeaders(h), [`Bearer ${ACCESS_TOKEN}`, `Bearer ${ROTATED_TOKEN}`]);
  assert.equal(h.counters.waits.length, 0, "PGRST303-пауза на чужом 401");
});

test("401 без кода, с чужим кодом и с непарсящимся телом не повторяется по PGRST303-правилу", async () => {
  const bodies = ['{"message":"nope"}', PGRST301, "<html>gateway</html>", "", "null", '["PGRST303"]'];
  for (const text of bodies) {
    const h = harness({ fetchImpl: responder({ rest: [resp(401, text), ok()] }) }).fakeSleep();
    await h.rest(COLLECTIONS);
    assert.equal(h.restCalls().length, 2, `тело ${JSON.stringify(text)} ушло в PGRST303-цикл`);
    assert.equal(h.counters.waits.length, 0, `тело ${JSON.stringify(text)} дало паузу`);
    assert.equal(h.authCalls().length, 1, `тело ${JSON.stringify(text)} потеряло refresh-путь`);
  }
});

test("чужие статусы не повторяются, даже с телом PGRST303", async () => {
  for (const status of [403, 404, 429, 500, 503]) {
    const h = harness({ fetchImpl: responder({ rest: [resp(status, PGRST303)] }) }).fakeSleep();
    const err = await rejection(h.rest(COLLECTIONS));
    assert.equal(h.restCalls().length, 1, `статус ${status} повторился`);
    assert.equal(h.counters.waits.length, 0);
    assert.equal(h.authCalls().length, 0);
    assert.equal(err.message, `${status}: ${PGRST303}`);
  }
});

// ---------------------------------------------------- 5. только GET / HEAD

test("writes не повторяются по PGRST303-правилу и сохраняют прежний путь", async () => {
  for (const method of ["POST", "PATCH", "PUT", "DELETE"]) {
    const h = harness({ fetchImpl: responder({ rest: [denied(), ok("")] }) }).fakeSleep();
    await h.rest("thumbnails", { method, body: '{"x":1}' });

    assert.equal(h.restCalls().length, 2, `${method} ушёл в PGRST303-цикл`);
    assert.equal(h.counters.waits.length, 0, `${method} ждал backoff`);
    // Прежнее поведение любого 401 для write сохранено дословно: один refresh и
    // ровно один повтор с НОВОЙ сессией.
    assert.equal(h.authCalls().length, 1, `${method} потерял refresh-путь`);
    assert.deepEqual(authHeaders(h), [`Bearer ${ACCESS_TOKEN}`, `Bearer ${ROTATED_TOKEN}`]);
  }
});

test("HEAD входит в правило наравне с GET", async () => {
  const h = harness({ fetchImpl: responder({ rest: [denied(), ok()] }) }).fakeSleep();
  await h.rest(COLLECTIONS, { method: "HEAD" });
  assert.equal(h.restCalls().length, 2);
  assert.equal(h.authCalls().length, 0);

  // Через message-proxy HEAD недостижим: нормализатор его не разрешает.
  const blocked = await h.send({ type: "tv:sb-rest", path: COLLECTIONS, opts: { method: "HEAD" } });
  assert.deepEqual({ ok: blocked.ok, error: blocked.error }, { ok: false, error: "Supabase route not allowed" });
});

// -------------------------------------------------------------- 6. abort

test("abort прекращает ожидание", async () => {
  const controller = new AbortController();
  const h = harness({ fetchImpl: responder({ rest: [denied()] }) });
  // Пауза заведомо длиннее теста: если abort её не прервёт, тест повиснет.
  h.sw.tvPgrstBackoffMs = () => 60000;
  setTimeout(() => controller.abort(), 10);

  const started = Date.now();
  const err = await rejection(h.rest(COLLECTIONS, { signal: controller.signal }));
  const elapsed = Date.now() - started;

  assert.equal(err.name, "AbortError");
  assert.ok(elapsed < 2000, `ожидание не прервалось: ${elapsed} мс`);
  assert.equal(h.restCalls().length, 1);
});

test("уже отменённый сигнал не даёт даже первого ожидания", async () => {
  const controller = new AbortController();
  controller.abort();
  const h = harness({ fetchImpl: responder({ rest: [denied()] }) });
  h.sw.tvPgrstBackoffMs = () => 60000;

  const err = await rejection(h.rest(COLLECTIONS, { signal: controller.signal }));

  assert.equal(err.name, "AbortError");
  assert.equal(h.restCalls().length, 1);
});

test("живой сигнал повторам не мешает", async () => {
  const controller = new AbortController();
  const h = harness({ fetchImpl: responder({ rest: [denied(), denied(), ok()] }) }).fakeSleep();

  const data = await h.rest(COLLECTIONS, { signal: controller.signal });

  assert.equal(JSON.stringify(data), ROWS_BODY);
  assert.equal(h.restCalls().length, 3);
});

// --------------------------------------------- 7. токен не утекает наружу

test("токен не попадает ни в логи, ни в storage", async () => {
  const h = harness({ fetchImpl: responder({ rest: [denied(), denied(), denied(), denied()] }) }).fakeSleep();
  await rejection(h.rest(COLLECTIONS));

  const refresh = harness({ fetchImpl: responder({ rest: [resp(401, PGRST301), ok()] }) }).fakeSleep();
  await refresh.rest(COLLECTIONS);

  for (const h2 of [h, refresh]) {
    const joined = h2.logs.join("\n");
    for (const secret of [ACCESS_TOKEN, ROTATED_TOKEN, REFRESH_TOKEN]) {
      assert.equal(joined.includes(secret), false, "секрет попал в логи");
    }
  }
  // Единственный ключ сессии — прежний слот; PGRST303-цикл не пишет в storage вовсе.
  assert.deepEqual(Object.keys(h.local.data), ["tv_session"]);
  assert.equal(h.local.ops.filter((op) => op !== "get").length, 0);
});

test("исходник обёртки не декодирует, не логирует и не сохраняет JWT", async () => {
  assert.equal(/console\./.test(src.background), false, "в background.js появился console");
  assert.equal(/\batob\b|jwt_decode|split\(["']\.["']\)/.test(src.background), false, "появилось декодирование JWT");
  assert.equal(/chrome\.storage\.\w+\.(set|remove)\(/.test(src.background), false, "background.js стал писать в storage");
});

// ------------------------------------------ 8. только PostgREST проекта

test("правило не может уйти на чужой хост: нормализатор режет путь до fetch", async () => {
  const h = harness();
  const bad = [
    "https://evil.example/rest/v1/collections",
    "//evil.example/collections",
    "/rest/v1/collections",
    "../functions/v1/refresh-views",
    "collections/../../functions/v1/refresh-views",
  ];
  for (const path of bad) {
    const res = await h.send({ type: "tv:sb-rest", path, opts: {} });
    assert.equal(res.ok, false, `путь пропущен: ${path}`);
  }
  assert.equal(h.calls.length, 0, "запрещённый путь дошёл до сети");
});

test("разрешённый путь бьёт строго в PostgREST этого проекта", async () => {
  const h = harness({ fetchImpl: responder({ rest: [denied(), ok()] }) }).fakeSleep();
  await h.send({ type: "tv:sb-rest", path: COLLECTIONS, opts: {} });
  assert.equal(h.restCalls().length, 2);
  for (const call of h.restCalls()) assert.equal(call.url, `${REST}${COLLECTIONS}`);
});

// ------------------------------------------------- 9. Edge Function не тронут

test("Edge Function по PGRST303-правилу не повторяется", async () => {
  let n = 0;
  const h = harness({
    fetchImpl: responder({
      fn: async () => {
        n += 1;
        return n === 1 ? make(401, PGRST303) : make(200, '{"ok":true}');
      },
    }),
  }).fakeSleep();

  const res = await h.send({
    type: "tv:sb-function",
    name: "refresh-views",
    body: { video_id: "dQw4w9WgXcQ" },
    // PUB-06: конверт snapshot несёт конечный срок шага; без него фон отвергает
    // вызов до сети. Здесь он заведомо не истёк — проверяется PGRST303-правило.
    deadline: Date.now() + 5000,
  });

  assert.equal(res.ok, true);
  assert.equal(h.fnCalls().length, 2, "функция ушла в PGRST303-цикл");
  assert.equal(h.counters.waits.length, 0, "функция ждала backoff");
  // Прежний путь функции сохранён: один refresh и повтор с новой сессией.
  assert.equal(h.authCalls().length, 1);
  assert.deepEqual(h.fnCalls().map((c) => c.auth), [`Bearer ${ACCESS_TOKEN}`, `Bearer ${ROTATED_TOKEN}`]);
});

test("правило не расползлось на admin-вариант: у него нет PostgREST-пути вовсе", { skip: WITH_PRIVATE ? false : "область public: admin/ вне экспорта" }, () => {
  assert.equal(/\/rest\/v1\//.test(adminBackground), false, "у admin появился PostgREST-прокси");
  assert.equal(/PGRST303/.test(adminBackground), false, "правило утекло в admin");
  assert.equal((adminBackground.match(/\/functions\/v1\//g) || []).length, 1);
});

test("исходник: PGRST303 живёт только в REST-пути, не в вызове функции", () => {
  const fetches = src.background.match(/\bfetch\(/g) || [];
  assert.equal(fetches.length, 2, "изменилось число сетевых точек в background.js");
  assert.equal((src.background.match(/\/rest\/v1\//g) || []).length, 1);
  assert.equal((src.background.match(/\/functions\/v1\//g) || []).length, 1);

  const start = src.background.indexOf("async function tvInvokeFunction");
  const end = src.background.indexOf("chrome.runtime.onMessage.addListener");
  assert.ok(start > 0 && end > start);
  const invokeBody = src.background.slice(start, end);
  assert.equal(/PGRST303|tvSleep|tvPgrstBackoffMs|tvIsFutureIatDenial/.test(invokeBody), false);
});

// ------------------------------------------------------------ 10. проводка

test("проводка: боевой message-route публичного расширения идёт через обёртку", async () => {
  const h = harness({ fetchImpl: responder({ rest: [denied(), denied(), ok()] }) }).fakeSleep();

  const res = await h.send({ type: "tv:sb-rest", path: COLLECTIONS, opts: {} });

  assert.equal(res.ok, true);
  assert.equal(JSON.stringify(res.data), ROWS_BODY);
  assert.equal(h.restCalls().length, 3);
  assert.equal(h.authCalls().length, 0);
  assert.equal(new Set(authHeaders(h)).size, 1);
});

test("проводка: боевой api.js через supabase.js переживает PGRST303", async () => {
  const h = harness({ fetchImpl: responder({ rest: [denied(), denied(), ok()] }) }).fakeSleep();
  const page = pageHarness(h);

  const rows = await page.API.getCollections();

  assert.equal(JSON.stringify(rows), ROWS_BODY);
  assert.equal(h.restCalls().length, 3);
  assert.equal(h.restCalls()[0].url, `${REST}${COLLECTIONS}`);
  assert.equal(new Set(authHeaders(h)).size, 1);
  assert.equal(h.counters.refreshSession, 0);
});

test("проводка: исчерпанный PGRST303 доезжает до вызывающего честной ошибкой", async () => {
  const h = harness({ fetchImpl: responder({ rest: [denied()] }) }).fakeSleep();
  const page = pageHarness(h);

  const err = await rejection(page.API.getCollections());

  assert.equal(err.message, `401: ${PGRST303}`);
  assert.equal(h.restCalls().length, 4);
});

test("без сессии обёртка отказывает прежним сообщением и в сеть не ходит", async () => {
  const h = harness({ session: null });
  const err = await rejection(h.rest(COLLECTIONS));
  assert.equal(err.message, "Not signed in");
  assert.equal(h.calls.length, 0);
});

// node --test: PUB-07 — защита носителя credential проверяется, а не предполагается.
//
// Проверяем инварианты, а не формулировки:
//   ни одна credential-операция не идёт вперёд без ДОКАЗАННОЙ защиты области;
//   отсутствие метода, синхронный throw, reject и зависание дают ОДИН исход —
//     печать на всю активацию и немедленный отказ, а не молчаливый успех;
//   поздний успех после предела ожидания запечатанную активацию НЕ открывает;
//   отказ UI не ждёт ни уборки, ни сети, ни зависшей очереди storage;
//   уборка старого слота однократна, сериализована и различает три исхода:
//     чтение, локальное удаление, серверный отзыв;
//   ping и язык не зависят от auth; intent-область отсутствует — отказ назван;
//   Firefox остаётся на storage.session и setAccessLevel не зовёт.
//
// Таймеры модельные: ручные часы, никаких настоящих ожиданий.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

const EXT_ID = "a".repeat(32);
const SB_URL = "https://project.supabase.co";
const CONFIG = {
  SUPABASE_URL: SB_URL,
  SUPABASE_ANON_KEY: "anon-key",
  AUTH_SITE_URL: "https://thumbsight.invalid",
};
const CONFIG_SRC = `self.THUMBVAULT_CONFIG = ${JSON.stringify(CONFIG)};`;
const LOGOUT_URL = `${SB_URL}/auth/v1/logout?scope=local`;

// Зеркала констант oauth.js. Если там значение поменяется, эти тесты обязаны
// упасть: предел ожидания и границы аварийного отзыва — часть контракта.
const CARRIER_TIMEOUT = 3000;
const REVOKE_BUDGET = 4000;
const REVOKE_MAX_ATTEMPTS = 2;

const UNPROTECTED = /Session unavailable: storage protection unavailable/;
const SEALED_INSTALL = /Session unavailable: install state reset failed/;
const NO_INTENT_STORE = /Intent storage unavailable/;

const file = (name) => readFile(new URL(`../${name}`, import.meta.url), "utf8");
const src = {
  oauth: await file("oauth.js"),
  intent: await file("intent.js"),
  background: await file("background.js"),
};

// Синтетическая сессия: ни одно значение не похоже на настоящее и нигде не
// используется как реальный credential.
const SESSION = {
  access_token: `access-${"x".repeat(40)}`,
  refresh_token: "refresh-synthetic-1",
  token_type: "bearer",
  expires_in: 3600,
  expires_at: Math.floor(Date.now() / 1000) + 3600,
  user: { id: "11111111-1111-4111-8111-111111111111", email: "probe@example.invalid" },
};

// ---------------------------------------------------------------- часы и ворота

// Ручные часы: тест сам решает, когда срабатывает таймер, и видит его длительность.
function makeClock() {
  let now = 0;
  let seq = 0;
  const live = new Map();
  const created = [];
  const flush = async () => { for (let i = 0; i < 40; i++) await new Promise((r) => setImmediate(r)); };
  return {
    created,
    pending: () => [...live.values()].map((timer) => timer.ms),
    setTimeout(fn, ms = 0) {
      const id = ++seq;
      created.push(ms);
      live.set(id, { fn, at: now + ms, ms });
      return id;
    },
    clearTimeout(id) { live.delete(id); },
    async advance(ms) {
      const target = now + ms;
      for (;;) {
        const due = [...live.entries()]
          .filter(([, timer]) => timer.at <= target)
          .sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
        if (!due) break;
        live.delete(due[0]);
        now = due[1].at;
        due[1].fn();
        await flush();
      }
      now = target;
      await flush();
    },
    flush,
    now: () => now,
  };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

// `access`: "ok" | "missing" | "throw" | "reject" | "hang" | "deferred" | "not-thenable"
//   "reject" — это и Chrome <140: метод на прототипе есть, но эту область не
//   принимает. Отдельного режима «метод есть, но чужая область» не нужно — с
//   точки зрения расширения наблюдение одно и то же.
// `gate`: { get, set, remove } → "fail" | "hang" для ОДНОЙ следующей операции.
function memoryArea({ initial = {}, access = "ok", gate = {} } = {}) {
  const data = { ...initial };
  const accessCalls = [];
  const pendingAccess = deferred();
  const gates = { ...gate };

  const takeGate = (kind) => {
    const mode = gates[kind];
    if (mode) delete gates[kind];
    return mode;
  };
  const apply = (kind, work) => {
    ops.push(kind);
    const mode = takeGate(kind);
    if (mode === "fail") return Promise.reject(new Error("storage unavailable"));
    if (mode === "hang") return new Promise(() => {});
    return Promise.resolve().then(work);
  };

  const ops = [];
  const area = {
    data,
    ops,
    accessCalls,
    releaseAccess: pendingAccess.resolve,
    failAccess: pendingAccess.reject,
    opsOf: (kind) => ops.filter((op) => op === kind).length,
    get: (keys) => apply("get", () => {
      if (keys === null || keys === undefined) return { ...data };
      const list = Array.isArray(keys) ? keys : [keys];
      return Object.fromEntries(list.filter((key) => key in data).map((key) => [key, data[key]]));
    }),
    set: (values) => apply("set", () => { Object.assign(data, values); }),
    remove: (keys) => apply("remove", () => {
      for (const key of Array.isArray(keys) ? keys : [keys]) delete data[key];
    }),
  };

  if (access !== "missing") {
    area.setAccessLevel = (opts) => {
      accessCalls.push(opts);
      if (access === "throw") throw new Error("synchronous failure");
      if (access === "ok") return Promise.resolve();
      if (access === "reject") return Promise.reject(new Error("This StorageArea is not available"));
      if (access === "hang") return new Promise(() => {});
      if (access === "not-thenable") return undefined;
      return pendingAccess.promise;
    };
  }
  return area;
}

// ---------------------------------------------------------------- стенд worker

// Полный фон: background.js + oauth.js + intent.js. Нужен целиком, потому что
// половина контракта — маршруты сообщений (ping/язык/intent) и регистрация
// обработчиков, а не только сам oauth.
function stand({ local = {}, session = {}, hasSession = true, respond = () => ({ status: 200, ok: true, text: async () => "{}", json: async () => ({}) }), platform = "chrome" } = {}) {
  const clock = makeClock();
  const localArea = memoryArea(local);
  const sessionArea = memoryArea(session);
  const calls = [];
  const storage = { local: localArea };
  if (hasSession) storage.session = sessionArea;

  let onMessage = null;
  let onInstalled = null;
  const base = platform === "firefox"
    ? `moz-extension://11111111-2222-3333-4444-555555555555/`
    : platform === "chrome"
      ? `chrome-extension://${EXT_ID}/`
      // Неопознанная платформа: схема, которую tvSessionAreaName не признаёт.
      : `https://unknown.invalid/`;

  const sw = {
    chrome: {
      storage,
      identity: {
        getRedirectURL: () => `https://${EXT_ID}.chromiumapp.org/auth`,
        launchWebAuthFlow: ({ url }, callback) => {
          const state = new URL(url).searchParams.get("state");
          callback(`https://${EXT_ID}.chromiumapp.org/auth?state=${state}&code=${"c".repeat(64)}`);
        },
      },
      runtime: {
        id: EXT_ID,
        lastError: null,
        getURL: (path) => `${base}${String(path).replace(/^\//, "")}`,
        onInstalled: { addListener: (fn) => { onInstalled = fn; } },
        onMessage: { addListener: (fn) => { onMessage = fn; } },
      },
      tabs: { create() {}, remove() {} },
    },
    crypto: globalThis.crypto,
    TextEncoder,
    URL,
    URLSearchParams,
    AbortController,
    btoa,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    console: { log() {}, info() {}, warn() {}, error() {}, debug() {} },
    fetch: (url, options = {}) => {
      const call = {
        url: String(url),
        method: String(options.method || "GET").toUpperCase(),
        headers: options.headers || {},
        signal: options.signal || null,
      };
      calls.push(call);
      return Promise.resolve(respond(call)).then((value) => {
        if (value !== "hang") return value;
        return new Promise((_, reject) => {
          if (!call.signal) return;
          if (call.signal.aborted) { reject(call.signal.reason || new Error("Aborted")); return; }
          call.signal.addEventListener("abort", () => reject(call.signal.reason || new Error("Aborted")), { once: true });
        });
      });
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

  let bootError = null;
  try {
    vm.runInContext(src.background, sw, { filename: "public/background.js" });
  } catch (err) {
    bootError = err;
  }

  const api = (name) => vm.runInContext(name, sw);
  return {
    clock, calls, sw, bootError, localArea, sessionArea,
    get onMessage() { return onMessage; },
    get onInstalled() { return onInstalled; },
    logoutCalls: () => calls.filter((call) => call.url === LOGOUT_URL),
    getSession: () => api("tvGetSession")(),
    setSession: (value) => api("tvSetSession")(value),
    validSession: () => api("tvValidSession")(),
    refreshSession: () => api("tvRefreshSession")(),
    signOut: () => api("tvSignOutSession")(),
    signIn: () => api("tvOAuthSignIn")("public"),
    oauthError: () => api("tvGetOAuthError")(),
    area: () => api("TV_SESSION_AREA"),
    send: (message, sender) => new Promise((resolve) => {
      const async_ = onMessage(message, sender, resolve);
      if (async_ !== true) resolve(undefined);
    }),
  };
}

const HOST_SENDER = { id: EXT_ID, url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ", tab: { id: 3 } };
const POPUP_SENDER = { id: EXT_ID, url: `chrome-extension://${EXT_ID}/popup.html` };
const PANEL_SENDER = { id: EXT_ID, url: `chrome-extension://${EXT_ID}/panel.html`, tab: { id: 3 } };

// Значения, пришедшие из VM-контекста, имеют ДРУГИЕ прототипы: строгое
// глубокое сравнение с host-объектом падает на «same structure but not
// reference-equal». Сравниваем содержимое, а не realm.
const plain = (value) => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)));

// Наблюдать «операция ещё не завершилась» иначе нечем: у промиса нет
// синхронного состояния.
function track(promise) {
  const state = { settled: false, value: undefined, error: undefined };
  promise.then(
    (value) => { state.settled = true; state.value = value; },
    (error) => { state.settled = true; state.error = error; },
  );
  return state;
}

// ============================================================ 1. успех защиты

test("успех: защита подтверждена, срок заведён на старте и снят завершением", async () => {
  const h = stand();
  await h.clock.flush();
  assert.equal(h.bootError, null);
  assert.ok(h.onMessage, "onMessage обязан регистрироваться");
  assert.deepEqual(plain(h.localArea.accessCalls), [{ accessLevel: "TRUSTED_CONTEXTS" }]);

  await h.setSession(SESSION);
  assert.deepEqual(plain(await h.getSession()), SESSION);
  // Срок отсчитывается от САМОЙ проверки, а не от первого вызывающего (F1),
  // поэтому один таймер на активацию — ожидаемая цена. Успех его снимает.
  assert.deepEqual(h.clock.created, [CARRIER_TIMEOUT], `таймеры: ${JSON.stringify(h.clock.created)}`);
  assert.deepEqual(h.clock.pending(), [], "срок не снят завершившейся проверкой");
});

test("успех с ОТЛОЖЕННЫМ разрешением: операция ждёт, предел заводится и снимается", async () => {
  const h = stand({ local: { access: "deferred" } });
  const state = track(h.getSession());
  await h.clock.flush();
  assert.equal(state.settled, false, "операция пошла вперёд без подтверждённой защиты");
  assert.deepEqual(h.clock.created, [CARRIER_TIMEOUT], "предел ожидания не заведён");

  await h.clock.advance(CARRIER_TIMEOUT - 1);
  assert.equal(state.settled, false);

  h.localArea.releaseAccess();
  await h.clock.flush();
  assert.equal(state.settled, true, "подтверждённая защита не пустила операцию");
  assert.equal(state.error, undefined);
  assert.deepEqual(h.clock.pending(), [], "предел ожидания не снят");
});

// ====================================================== 2. отказы защиты

const FAILURES = [
  ["метод отсутствует", { access: "missing" }],
  ["синхронный throw", { access: "throw" }],
  ["reject (в том числе Chrome <140: область не принимается)", { access: "reject" }],
];

for (const [name, localOpts] of FAILURES) {
  test(`отказ защиты — ${name}: слот запечатан, новых записей нет`, async () => {
    const h = stand({ local: { ...localOpts, initial: {} } });
    await h.clock.flush();
    assert.equal(h.bootError, null, "отказ защиты не должен валить загрузку фона");
    assert.ok(h.onMessage, "обработчики обязаны остаться зарегистрированными");

    await assert.rejects(() => h.getSession(), UNPROTECTED);
    await assert.rejects(() => h.setSession(SESSION), UNPROTECTED);
    await assert.rejects(() => h.validSession(), UNPROTECTED);
    await assert.rejects(() => h.refreshSession(), UNPROTECTED);
    await assert.rejects(() => h.signOut(), UNPROTECTED);
    await assert.rejects(() => h.signIn(), UNPROTECTED);
    await assert.rejects(() => h.oauthError(), UNPROTECTED);

    assert.equal("tv_session" in h.localArea.data, false, "в запечатанную область попала запись");
    assert.equal(h.calls.length, 0, "запечатанная активация ходила в сеть");
  });
}

test("зависшая проверка: предел ожидания превращает её в отказ, а не в ожидание", async () => {
  const h = stand({ local: { access: "hang" } });
  const state = track(h.getSession());
  await h.clock.flush();
  assert.equal(state.settled, false);
  assert.deepEqual(h.clock.created, [CARRIER_TIMEOUT]);

  await h.clock.advance(CARRIER_TIMEOUT);
  assert.equal(state.settled, true, "зависшая проверка не была ограничена по времени");
  assert.match(String(state.error?.message), UNPROTECTED);
  // После печати следующие вызовы отвечают сразу и НОВЫХ таймеров не заводят.
  await assert.rejects(() => h.setSession(SESSION), UNPROTECTED);
  assert.deepEqual(h.clock.created, [CARRIER_TIMEOUT], "печать продолжает заводить таймеры");
});

test("метод вернул не-thenable: подтверждения нет, защита не считается включённой", async () => {
  const h = stand({ local: { access: "not-thenable" } });
  await h.clock.flush();
  await assert.rejects(() => h.getSession(), UNPROTECTED);
});

test("поздний УСПЕХ после предела не открывает запечатанную активацию", async () => {
  const h = stand({ local: { access: "deferred" } });
  const first = track(h.getSession());
  await h.clock.flush();
  await h.clock.advance(CARRIER_TIMEOUT);
  assert.equal(first.settled, true);
  assert.match(String(first.error?.message), UNPROTECTED);

  // Браузер ответил успехом уже после того, как ждать перестали.
  h.localArea.releaseAccess();
  await h.clock.flush();
  await assert.rejects(() => h.getSession(), UNPROTECTED);
  await assert.rejects(() => h.setSession(SESSION), UNPROTECTED);
  assert.equal("tv_session" in h.localArea.data, false);
});

test("поздний ОТКАЗ после предела ничего не меняет и не всплывает", async () => {
  const h = stand({ local: { access: "deferred" } });
  const first = track(h.getSession());
  await h.clock.flush();
  await h.clock.advance(CARRIER_TIMEOUT);
  h.localArea.failAccess(new Error("late denial"));
  await h.clock.flush();
  assert.match(String(first.error?.message), UNPROTECTED);
  await assert.rejects(() => h.getSession(), UNPROTECTED);
});

// ================================================ 3. аварийная уборка слота

test("старый слот: уборка читает, удаляет и отзывает ровно один раз", async () => {
  const h = stand({
    local: { access: "missing", initial: { tv_session: SESSION, tv_oauth_error: "old" } },
    respond: () => ({ status: 204, ok: true, text: async () => "", json: async () => null }),
  });
  await h.clock.flush();

  assert.equal("tv_session" in h.localArea.data, false, "старый credential остался в открытой области");
  const logout = h.logoutCalls();
  assert.equal(logout.length, 1, `аварийных отзывов: ${logout.length}`);
  assert.equal(logout[0].method, "POST");
  assert.equal(logout[0].url, LOGOUT_URL, "отзыв обязан быть scope=local");
  assert.ok(logout[0].signal, "у аварийного отзыва нет AbortController");
  assert.equal(logout[0].headers.Authorization, `Bearer ${SESSION.access_token}`);
  // Диагностический слот уборка не трогает: она отвечает за credential.
  assert.equal(h.localArea.data.tv_oauth_error, "old");
});

test("пустой слот: уборка не ходит в сеть", async () => {
  const h = stand({ local: { access: "missing", initial: {} } });
  await h.clock.flush();
  assert.equal(h.logoutCalls().length, 0, "уборка отозвала несуществующий токен");
});

test("отказ удаления: локальная очистка НЕ заявляется, но отзыв всё равно пробуется", async () => {
  const h = stand({
    local: { access: "missing", initial: { tv_session: SESSION }, gate: { remove: "fail" } },
    respond: () => ({ status: 204, ok: true, text: async () => "", json: async () => null }),
  });
  await h.clock.flush();

  // Это и есть предел, который нельзя обещать: запись осталась.
  assert.deepEqual(plain(h.localArea.data.tv_session), SESSION, "отказавшее удаление выглядело как очистка");
  // Но прочитанный токен уже можно попытаться убить на сервере.
  assert.equal(h.logoutCalls().length, 1, "прочитанный credential не был отозван");
  // И пользоваться им расширение всё равно отказывается.
  await assert.rejects(() => h.getSession(), UNPROTECTED);
});

test("отказ ЧТЕНИЯ: ни очистка, ни серверный отзыв не заявляются", async () => {
  const h = stand({
    local: { access: "missing", initial: { tv_session: SESSION }, gate: { get: "fail" } },
  });
  await h.clock.flush();
  assert.equal(h.logoutCalls().length, 0, "отзыв заявлен при неудавшемся чтении");
});

test("зависшее ЧТЕНИЕ в уборке не задерживает отказ UI", async () => {
  const h = stand({
    local: { access: "missing", initial: { tv_session: SESSION }, gate: { get: "hang" } },
  });
  await h.clock.flush();
  // Уборка стоит в очереди на зависшем get — очередь заблокирована навсегда.
  // Отказ обязан уходить мимо очереди.
  await assert.rejects(() => h.getSession(), UNPROTECTED);
  await assert.rejects(() => h.setSession(SESSION), UNPROTECTED);
  await assert.rejects(() => h.signIn(), UNPROTECTED);
  assert.equal(h.calls.length, 0);
});

test("зависший аварийный отзыв ограничен собственным бюджетом", async () => {
  const h = stand({
    local: { access: "missing", initial: { tv_session: SESSION } },
    respond: () => "hang",
  });
  await h.clock.flush();
  assert.equal("tv_session" in h.localArea.data, false, "удаление ждало сеть");
  const logout = h.logoutCalls();
  assert.equal(logout.length, 1);
  assert.deepEqual(h.clock.created, [REVOKE_BUDGET], `таймеры: ${JSON.stringify(h.clock.created)}`);
  assert.equal(logout[0].signal.aborted, false);

  await h.clock.advance(REVOKE_BUDGET);
  assert.equal(logout[0].signal.aborted, true, "зависший отзыв не был оборван");
  // Повторов после обрыва нет: истёкший бюджет — конец, а не повод попробовать снова.
  assert.equal(h.logoutCalls().length, 1);
});

test("аварийный отзыв повторяется ограниченно и только на повторяемых статусах", async () => {
  const h = stand({
    local: { access: "missing", initial: { tv_session: SESSION } },
    respond: () => ({ status: 503, ok: false, text: async () => "", json: async () => null }),
  });
  await h.clock.flush();
  assert.equal(h.logoutCalls().length, REVOKE_MAX_ATTEMPTS, "предел попыток не соблюдён");
});

test("окончательный 401 аварийный отзыв не повторяет", async () => {
  const h = stand({
    local: { access: "missing", initial: { tv_session: SESSION } },
    respond: () => ({ status: 401, ok: false, text: async () => "", json: async () => null }),
  });
  await h.clock.flush();
  assert.equal(h.logoutCalls().length, 1);
});

test("повторные вызывающие не запускают вторую уборку", async () => {
  const h = stand({
    local: { access: "missing", initial: { tv_session: SESSION } },
    respond: () => ({ status: 204, ok: true, text: async () => "", json: async () => null }),
  });
  await h.clock.flush();
  await Promise.allSettled([h.getSession(), h.setSession(SESSION), h.signIn(), h.validSession()]);
  await h.clock.flush();
  assert.equal(h.logoutCalls().length, 1, `уборок: ${h.logoutCalls().length}`);
});

test("отказ UI не ждёт уборку: удаление держится, отказ уже пришёл", async () => {
  const h = stand({
    local: { access: "missing", initial: { tv_session: SESSION }, gate: { remove: "hang" } },
    respond: () => ({ status: 204, ok: true, text: async () => "", json: async () => null }),
  });
  await h.clock.flush();
  // Удаление зависло → уборка не дошла до сети и очередь занята.
  assert.equal(h.logoutCalls().length, 0);
  // И тем не менее каждая операция отвечает.
  await assert.rejects(() => h.getSession(), UNPROTECTED);
  await assert.rejects(() => h.validSession(), UNPROTECTED);
});

// ===================================== 4. отсутствие цикла и сохранённые гонки

test("цикла очереди нет: уборка проходит через очередь, а отказ — мимо", async () => {
  const h = stand({
    local: { access: "missing", initial: { tv_session: SESSION } },
    respond: () => ({ status: 204, ok: true, text: async () => "", json: async () => null }),
  });
  // Отказ приходит, даже если ждать его начали ДО того, как уборка завершилась.
  const early = track(h.getSession());
  await h.clock.flush();
  assert.equal(early.settled, true, "ожидание готовности зависло на собственной уборке");
  assert.match(String(early.error?.message), UNPROTECTED);
  assert.equal("tv_session" in h.localArea.data, false, "уборка не прошла через очередь");
});

test("отказавший install-сброс сохраняет свою печать и своё сообщение", async () => {
  const h = stand({
    local: { initial: { tv_session: SESSION }, gate: { remove: "fail" } },
  });
  await h.clock.flush();
  h.onInstalled({ reason: "install" });
  await h.clock.flush();
  // Защита носителя в порядке, поэтому виден именно install-отказ.
  await assert.rejects(() => h.getSession(), SEALED_INSTALL);
  assert.deepEqual(plain(h.localArea.data.tv_session), SESSION, "печать не означает удаления данных");
});

test("успешный install-сброс при рабочей защите чистит слот и не печатает его", async () => {
  const h = stand({ local: { initial: { tv_session: SESSION } } });
  await h.clock.flush();
  h.onInstalled({ reason: "install" });
  await h.clock.flush();
  assert.equal(await h.getSession(), null);
  assert.equal("tv_session" in h.localArea.data, false);
  assert.equal(h.logoutCalls().length, 0, "штатная защита не должна вызывать аварийный отзыв");
});

test("update/reload при рабочей защите сессию сохраняет", async () => {
  const h = stand({ local: { initial: { tv_session: SESSION } } });
  await h.clock.flush();
  h.onInstalled({ reason: "update" });
  await h.clock.flush();
  assert.deepEqual(plain(await h.getSession()), SESSION);
  assert.equal(h.logoutCalls().length, 0);
});

// Глубокие гонки install/refresh/logout/login покрыты logout-revoke.test.mjs с
// враждебным storage-бэкендом; повторять их здесь нечем и незачем. Здесь
// проверяется ровно то, что добавил PUB-07: ожидание защиты внутри секции не
// переставляет секции и не останавливает очередь.
test("ожидание защиты не переставляет порядок секций", async () => {
  const h = stand({ local: { access: "deferred", initial: {} } });
  const order = [];
  // Все три вызова сделаны ДО того, как защита подтверждена, поэтому каждая
  // секция ждёт её у себя внутри. Порядок завершения обязан совпасть с порядком
  // вызовов.
  const a = h.setSession(SESSION).then(() => order.push("set"));
  const b = h.getSession().then(() => order.push("get"));
  const c = h.setSession(null).then(() => order.push("remove"));
  await h.clock.flush();
  assert.deepEqual(order, [], "секция прошла вперёд без подтверждённой защиты");

  h.localArea.releaseAccess();
  await Promise.all([a, b, c]);
  assert.deepEqual(order, ["set", "get", "remove"], "порядок секций переставлен");
  assert.equal("tv_session" in h.localArea.data, false, "последняя операция не применилась");
});

test("вход при рабочей защите доходит до commit и пишет сессию", async () => {
  const rotated = { ...SESSION, refresh_token: "refresh-synthetic-2" };
  const h = stand({
    local: { initial: {} },
    respond: (call) => {
      if (call.url.includes("/functions/v1/exchange")) {
        return { status: 200, ok: true, json: async () => rotated, text: async () => "" };
      }
      return { status: 200, ok: true, json: async () => ({}), text: async () => "{}" };
    },
  });
  await h.clock.flush();
  const session = await h.signIn();
  assert.equal(session.refresh_token, "refresh-synthetic-2");
  assert.deepEqual(plain(h.localArea.data.tv_session), rotated);
  assert.equal(h.logoutCalls().length, 0);
});

test("вход при запечатанном носителе не доходит ни до окна авторизации, ни до сети", async () => {
  let launched = 0;
  const h = stand({ local: { access: "reject" } });
  h.sw.chrome.identity.launchWebAuthFlow = () => { launched++; };
  await h.clock.flush();
  await assert.rejects(() => h.signIn(), UNPROTECTED);
  assert.equal(launched, 0, "браузер открыл окно авторизации при заведомо незащищённом носителе");
  assert.equal(h.calls.length, 0);
});

test("общий refresh остаётся единственным на всех при рабочей защите", async () => {
  let tokenCalls = 0;
  const expired = { ...SESSION, expires_at: Math.floor(Date.now() / 1000) - 10 };
  const h = stand({
    local: { initial: { tv_session: expired } },
    respond: (call) => {
      if (call.url.includes("/auth/v1/token")) {
        tokenCalls++;
        return { status: 200, ok: true, json: async () => ({ ...SESSION, refresh_token: "refresh-synthetic-3" }), text: async () => "" };
      }
      return { status: 200, ok: true, json: async () => ({}), text: async () => "{}" };
    },
  });
  await h.clock.flush();
  const [a, b] = await Promise.all([h.validSession(), h.validSession()]);
  assert.equal(tokenCalls, 1, `сетевых refresh: ${tokenCalls}`);
  assert.equal(a.refresh_token, "refresh-synthetic-3");
  assert.equal(b.refresh_token, "refresh-synthetic-3");
});

// ================================================ 5. storage-отказы под защитой

for (const kind of ["get", "set", "remove"]) {
  test(`отказ storage.${kind} при рабочей защите остаётся отказом операции`, async () => {
    const h = stand({ local: { initial: { tv_session: SESSION }, gate: { [kind]: "fail" } } });
    await h.clock.flush();
    const op = kind === "get" ? () => h.getSession() : () => h.setSession(kind === "remove" ? null : SESSION);
    await assert.rejects(op, /storage unavailable/);
    // Печати носителя отказ storage не ставит: это разные условия.
    assert.match(String(await h.getSession().then(() => "ok", (err) => err.message)), /^(ok|storage unavailable)$/);
  });
}

test("зависший storage.set не объявляется завершённым и не открывает очередь", async () => {
  const h = stand({ local: { initial: {}, gate: { set: "hang" } } });
  await h.clock.flush();
  const first = track(h.setSession(SESSION));
  const second = track(h.getSession());
  await h.clock.flush();
  assert.equal(first.settled, false, "зависшая запись объявлена завершённой");
  // Очередь честно занята: следующая секция за ней и не проскакивает вперёд.
  assert.equal(second.settled, false, "секция обошла выполняющуюся запись");
  assert.equal("tv_session" in h.localArea.data, false);
  // Единственный таймер — startup-срок проверки, и он уже снят.
  assert.deepEqual(h.clock.created, [CARRIER_TIMEOUT], "у зависшей записи появился чужой таймер");
  assert.deepEqual(h.clock.pending(), []);
});

test(`зависший storage.get при рабочей защите не подменяется отказом защиты`, async () => {
  const h = stand({ local: { initial: { tv_session: SESSION }, gate: { get: "hang" } } });
  await h.clock.flush();
  const state = track(h.getSession());
  await h.clock.flush();
  assert.equal(state.settled, false, "зависшее чтение объявлено завершённым");
  assert.deepEqual(h.clock.created, [CARRIER_TIMEOUT], "у зависшего storage появился чужой таймер");
  assert.deepEqual(h.clock.pending(), []);
});

// ============================================ 6. ping, язык и intent-область

test("ping и язык не зависят ни от защиты, ни от сессии", async () => {
  const h = stand({ local: { access: "missing", initial: { tv_lang: "ru" } } });
  await h.clock.flush();
  assert.deepEqual(plain(await h.send({ type: "tv:ping" }, HOST_SENDER)), { ok: true });
  assert.deepEqual(plain(await h.send({ type: "tv:lang" }, HOST_SENDER)), { ok: true, lang: "ru" });
});

test("intent-маршруты работают и при запечатанном носителе", async () => {
  const h = stand({ local: { access: "missing" } });
  await h.clock.flush();
  const res = await h.send({
    type: "tv:open-intent",
    intent: {
      mode: "youtube",
      videoId: "dQw4w9WgXcQ",
      imageUrl: "https://i.ytimg.com/vi/dQw4w9WgXcQ/hq.jpg",
      sourceUrl: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    },
  }, HOST_SENDER);
  assert.equal(res.ok, true, `intent отказал: ${res.error}`);
});

test("без storage.session фон жив, обработчики есть, отказ назван", async () => {
  const h = stand({ hasSession: false, local: { access: "missing" } });
  await h.clock.flush();
  assert.equal(h.bootError, null, "отсутствие storage.session снова валит модуль");
  assert.ok(h.onInstalled, "onInstalled потерян");
  assert.ok(h.onMessage, "onMessage потерян");

  assert.deepEqual(plain(await h.send({ type: "tv:ping" }, HOST_SENDER)), { ok: true });
  const open = await h.send({ type: "tv:open-intent", intent: { mode: "youtube" } }, HOST_SENDER);
  assert.equal(open.ok, false);
  assert.match(open.error, NO_INTENT_STORE);
  const claim = await h.send({ type: "tv:claim-intent", nonce: "x".repeat(24) }, PANEL_SENDER);
  assert.equal(claim.ok, false);
  assert.match(claim.error, NO_INTENT_STORE);
});

test("границы отправителя не изменились", async () => {
  const h = stand();
  await h.clock.flush();
  // Host page по-прежнему не достаёт до аутентифицированных маршрутов.
  for (const type of ["tv:sb-session", "tv:sb-rest", "tv:oauth-sign-in", "tv:sb-sign-out"]) {
    const res = await h.send({ type }, HOST_SENDER);
    assert.equal(res.ok, false, `${type} пустил host page`);
    assert.match(res.error, /Blocked sender/);
  }
  // Popup — по-прежнему достаёт.
  const session = await h.send({ type: "tv:sb-session" }, POPUP_SENDER);
  assert.equal(session.ok, true);
});

test("запечатанный носитель отвечает popup отказом, а не молчанием", async () => {
  const h = stand({ local: { access: "reject" } });
  await h.clock.flush();
  const res = await h.send({ type: "tv:sb-session" }, POPUP_SENDER);
  assert.equal(res.ok, false);
  assert.match(res.error, UNPROTECTED);
  // В сообщении наружу нет ни токена, ни внутренней диагностики storage.
  const text = JSON.stringify(res);
  for (const secret of [SESSION.access_token, SESSION.refresh_token, "This StorageArea"]) {
    assert.equal(text.includes(secret), false, `утечка в сообщении: ${secret}`);
  }
});

// ============================================================ 7. Firefox

test("Firefox: носитель session, setAccessLevel не вызывается, local не трогается", async () => {
  const h = stand({ platform: "firefox", local: { access: "missing" }, session: { access: "missing" } });
  await h.clock.flush();
  assert.equal(h.area(), "session");
  assert.deepEqual(plain(h.localArea.accessCalls), []);
  assert.deepEqual(plain(h.sessionArea.accessCalls), []);

  await h.setSession(SESSION);
  assert.deepEqual(plain(await h.getSession()), SESSION);
  assert.deepEqual(plain(h.sessionArea.data.tv_session), SESSION, "сессия не легла в storage.session");
  assert.equal("tv_session" in h.localArea.data, false, "в Firefox появился local fallback");
  assert.deepEqual(h.clock.created, [], "в Firefox заведён предел ожидания защиты");
});

test("Firefox: отсутствие setAccessLevel не печатает носитель", async () => {
  const h = stand({ platform: "firefox", session: { access: "missing", initial: { tv_session: SESSION } } });
  await h.clock.flush();
  assert.deepEqual(plain(await h.getSession()), SESSION);
  assert.equal(h.logoutCalls().length, 0, "в Firefox запустилась аварийная уборка");
});

test("неопознанная платформа закрывается прежним сообщением", async () => {
  const h = stand({ platform: "unknown" });
  await h.clock.flush();
  assert.equal(h.area(), "");
  await assert.rejects(() => h.getSession(), /Session storage area unavailable/);
});

// ============================================ 8. F1: срок от старта активации
//
// Repro CODEX-PUBLIC-PUB07-REVIEW-01, F1. До исправления таймер заводился
// только из tvAwaitCarrier, то есть при ПЕРВОМ credential-вызывающем: зависшая
// проверка без единого вызова не приводила ни к печати, ни к уборке, и старый
// tv_session сколько угодно долго лежал в потенциально открытой области.

const OK_204 = () => ({ status: 204, ok: true, text: async () => "", json: async () => null });

test("F1: зависшая проверка печатает активацию и убирает слот БЕЗ единого вызывающего", async () => {
  const h = stand({
    local: { access: "hang", initial: { tv_session: SESSION } },
    respond: OK_204,
  });
  await h.clock.flush();

  // Ключевое условие сценария: credential API не вызывался вообще.
  assert.deepEqual(h.clock.created, [CARRIER_TIMEOUT], "срок не заведён на старте активации");
  assert.deepEqual(plain(h.localArea.data.tv_session), SESSION, "слот убран раньше срока");
  assert.equal(h.logoutCalls().length, 0);

  // Срок проходит сам по себе — UI не участвует.
  await h.clock.advance(CARRIER_TIMEOUT);
  assert.equal("tv_session" in h.localArea.data, false, "зависшая проверка не привела к уборке");
  assert.equal(h.logoutCalls().length, 1, "прочитанный credential не отозван");

  // Первый вызывающий приходит уже после срока: немедленный отказ и НИКАКОГО
  // собственного бюджета.
  const timersBefore = h.clock.created.length;
  await assert.rejects(() => h.getSession(), UNPROTECTED);
  assert.equal(h.clock.created.length, timersBefore, "поздний вызывающий получил новый срок");
});

test("F1: очередь ранних вызывающих делит ОДИН срок и даёт одну уборку", async () => {
  const h = stand({
    local: { access: "hang", initial: { tv_session: SESSION } },
    respond: OK_204,
  });
  await h.clock.flush();

  const waiters = [
    track(h.getSession().then(() => "ok", (err) => err.message)),
    track(h.setSession(SESSION).then(() => "ok", (err) => err.message)),
    track(h.validSession().then(() => "ok", (err) => err.message)),
    track(h.signIn().then(() => "ok", (err) => err.message)),
  ];
  await h.clock.flush();
  assert.deepEqual(h.clock.created, [CARRIER_TIMEOUT], `у вызывающих появились свои сроки: ${JSON.stringify(h.clock.created)}`);
  assert.equal(waiters.some((state) => state.settled), false, "кто-то прошёл без подтверждённой защиты");

  await h.clock.advance(CARRIER_TIMEOUT);
  for (const state of waiters) {
    assert.equal(state.settled, true, "вызывающий не дождался решения по сроку");
    assert.match(String(state.value), UNPROTECTED);
  }
  assert.equal(h.logoutCalls().length, 1, `уборок больше одной: ${h.logoutCalls().length}`);
  assert.equal("tv_session" in h.localArea.data, false);
});

test("F1: поздний успех после истёкшего срока не открывает активацию", async () => {
  const h = stand({ local: { access: "deferred", initial: { tv_session: SESSION } }, respond: OK_204 });
  await h.clock.flush();
  await h.clock.advance(CARRIER_TIMEOUT);

  h.localArea.releaseAccess();
  await h.clock.flush();
  await assert.rejects(() => h.getSession(), UNPROTECTED);
  await assert.rejects(() => h.setSession(SESSION), UNPROTECTED);
  assert.equal("tv_session" in h.localArea.data, false);
});

// ====================================== 9. F2: уборка соблюдает install-барьер
//
// Repro CODEX-PUBLIC-PUB07-REVIEW-01, F2. До исправления уборка шла через
// tvSessionSection напрямую и после ОТКАЗАВШЕГО install-сброса читала старый
// credential, удаляла его и посылала в logout. Прежний контракт запрещает не
// только выдавать такой credential, но и читать и отзывать его.

test("F2: после отказавшего install-сброса уборка не читает и не отзывает credential", async () => {
  const h = stand({
    local: { access: "deferred", initial: { tv_session: SESSION }, gate: { remove: "fail" } },
    respond: OK_204,
  });
  await h.clock.flush();

  h.onInstalled({ reason: "install" });
  await h.clock.flush();
  // Сброс отказал, печать install стоит, слот остался.
  assert.deepEqual(plain(h.localArea.data.tv_session), SESSION);
  const readsBefore = h.localArea.opsOf("get");

  // Теперь отказывает и защита носителя — запускается аварийная уборка.
  h.localArea.failAccess(new Error("no protection"));
  await h.clock.flush();

  assert.equal(h.localArea.opsOf("get") - readsBefore, 0, "уборка прочитала credential под install-печатью");
  assert.deepEqual(plain(h.localArea.data.tv_session), SESSION, "уборка удалила слот под install-печатью");
  assert.equal(h.logoutCalls().length, 0, "уборка отозвала credential под install-печатью");

  // UI при этом отвечает сразу: печать носителя сильнее и проверяется до очереди.
  await assert.rejects(() => h.getSession(), UNPROTECTED);
});

test("F2: успешный install-сброс перед печатью — уборке нечего отзывать", async () => {
  const h = stand({
    local: { access: "deferred", initial: { tv_session: SESSION } },
    respond: OK_204,
  });
  await h.clock.flush();
  h.onInstalled({ reason: "install" });
  await h.clock.flush();
  assert.equal("tv_session" in h.localArea.data, false, "успешный сброс не очистил слот");

  h.localArea.failAccess(new Error("no protection"));
  await h.clock.flush();
  // Слот уже пуст: отзывать нечего, сети нет.
  assert.equal(h.logoutCalls().length, 0);
  await assert.rejects(() => h.getSession(), UNPROTECTED);
});

test("F2: сброс, поставленный ПОЗЖЕ уборки, её не блокирует", async () => {
  const h = stand({
    local: { access: "reject", initial: { tv_session: SESSION } },
    respond: OK_204,
  });
  // Печать наступает синхронно при загрузке (reject), уборка уже в очереди.
  await h.clock.flush();
  assert.equal("tv_session" in h.localArea.data, false, "уборка не отработала");
  assert.equal(h.logoutCalls().length, 1);

  // Сброс приходит уже после уборки: её снимок его не видит и не ждёт.
  h.onInstalled({ reason: "install" });
  await h.clock.flush();
  await assert.rejects(() => h.getSession(), UNPROTECTED);
});

test("F2: зависший install-сброс держит очередь, но UI всё равно fail-fast", async () => {
  const h = stand({
    local: { access: "deferred", initial: { tv_session: SESSION }, gate: { remove: "hang" } },
    respond: OK_204,
  });
  await h.clock.flush();
  h.onInstalled({ reason: "install" });
  await h.clock.flush();

  h.localArea.failAccess(new Error("no protection"));
  await h.clock.flush();
  // Уборка стоит за зависшим сбросом и не выполнится; это честный предел.
  assert.deepEqual(plain(h.localArea.data.tv_session), SESSION);
  assert.equal(h.logoutCalls().length, 0);
  // Но отказ уходит немедленно, мимо заблокированной очереди.
  await assert.rejects(() => h.getSession(), UNPROTECTED);
  await assert.rejects(() => h.signIn(), UNPROTECTED);
  await assert.rejects(() => h.signOut(), UNPROTECTED);
});

test("F2: уборка не ждёт будущую секцию своей очереди", async () => {
  const h = stand({
    local: { access: "reject", initial: { tv_session: SESSION } },
    respond: OK_204,
  });
  // Уборка поставлена синхронно при загрузке. Если бы она читала
  // tvInstallStatePromise ДИНАМИЧЕСКИ внутри секции, поставленный сразу после
  // неё сброс оказался бы её же будущей секцией — взаимоблокировка.
  h.onInstalled({ reason: "install" });
  const state = track(h.getSession().then(() => "ok", (err) => err.message));
  await h.clock.flush();
  assert.equal(state.settled, true, "очередь встала в цикл");
  assert.match(String(state.value), UNPROTECTED);
  assert.equal("tv_session" in h.localArea.data, false);
});

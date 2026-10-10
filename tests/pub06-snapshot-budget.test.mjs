// node --test: PUB-06 — у необязательного snapshot ОДИН срок на весь шаг.
//
// Стенд поведенческий: в vm исполняются настоящие background.js + oauth.js +
// intent.js (service worker) и настоящие supabase.js + api.js (страница).
// Подставлены только browser API, сеть и ЧАСЫ: таймеры управляются вручную,
// поэтому 5-секундный бюджет проверяется без пятисекундных пауз, а каждый
// заведённый таймер виден тесту по своей длительности.
//
// Инварианты:
//   зависший запрос, зависшее чтение тела и зависший общий refresh укладываются
//     в ОДИН бюджет, а не получают по сроку каждый;
//   у зависшего запроса наблюдаем abort — и у самого fetch, и у чтения тела;
//   молчание messaging тоже завершает шаг: панель не ждёт вечно;
//   401 → refresh → ровно один повтор; просроченный повтор не отправляется;
//   общий refresh не отменяется и остаётся рабочим для других вызывающих;
//   поздний ответ/отказ не даёт unhandled rejection и нового запроса.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

const EXT_ID = "a".repeat(32);
const CONFIG = {
  SUPABASE_URL: "https://project.supabase.co",
  SUPABASE_ANON_KEY: "anon-key",
  AUTH_SITE_URL: "https://thumbsight.com",
};
const CONFIG_SRC = `self.THUMBVAULT_CONFIG = ${JSON.stringify(CONFIG)};`;
const FN_URL = `${CONFIG.SUPABASE_URL}/functions/v1/refresh-views`;
const TOKEN_URL = `${CONFIG.SUPABASE_URL}/auth/v1/token?grant_type=refresh_token`;
const VIDEO = "dQw4w9WgXcQ";
const BUDGET = 5000;

const file = (name) => readFile(new URL(`../${name}`, import.meta.url), "utf8");
const src = {
  background: await file("background.js"),
  oauth: await file("oauth.js"),
  intent: await file("intent.js"),
  supabase: await file("supabase.js"),
  api: await file("api.js"),
};

// ------------------------------------------------------------------ часы

// Ручные часы — ОБЩИЙ источник времени обоих контекстов: они двигают и таймеры,
// и `Date.now()`, из которого считается конечный срок. Тест видит длительность
// каждого заведённого таймера и сам решает, когда он сработает, а доставка
// сообщения между контекстами занимает настоящее модельное время, а не ноль.
// Подсчёт таймеров поэтому не единственное доказательство: наблюдаются момент
// завершения шага, факт «ещё не завершился» и число реальных запросов.
function makeClock() {
  let now = 0;
  let seq = 0;
  const live = new Map();
  const created = [];
  const flush = async () => { for (let i = 0; i < 40; i++) await new Promise((resolve) => setImmediate(resolve)); };
  const api = {
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
  return api;
}

// `Date` обоих контекстов ходит по тем же часам: конечный срок вычисляется из
// `Date.now()`, и без общего источника времени задержку доставки не смоделировать.
function makeDate(clock) {
  const Fake = function Date_(...args) {
    return args.length ? new Date(...args) : new Date(clock.now());
  };
  Fake.now = () => clock.now();
  Fake.parse = Date.parse;
  Fake.UTC = Date.UTC;
  return Fake;
}

// Следим за фактом «шаг ещё не завершился»: это и есть доказательство ожидания,
// в отличие от подсчёта таймеров.
function track(promise) {
  const state = { settled: false, value: undefined };
  promise.then((value) => { state.settled = true; state.value = value; });
  return state;
}

// ---------------------------------------------------------------- фикстуры

// Область, чьё чтение висит до явного разрешения: моделирует зависший
// initial-этап фона (tvValidSession → storage) и его ПОЗДНЕЕ завершение.
function stalledArea(initial = {}) {
  const area = memoryArea(initial);
  let release = null;
  const gate = new Promise((resolve) => { release = resolve; });
  return { ...area, release: () => release(), get: (keys) => gate.then(() => area.get(keys)) };
}

function memoryArea(initial = {}) {
  const data = { ...initial };
  return {
    data,
    async get(keys) {
      if (keys === null || keys === undefined) return { ...data };
      const list = Array.isArray(keys) ? keys : [keys];
      return Object.fromEntries(list.filter((key) => key in data).map((key) => [key, data[key]]));
    },
    async set(values) { Object.assign(data, values); },
    async remove(keys) { for (const key of Array.isArray(keys) ? keys : [keys]) delete data[key]; },
    async setAccessLevel() {},
  };
}

const session = (over = {}) => ({
  access_token: `access-${"x".repeat(40)}`,
  refresh_token: "refresh-secret-1",
  token_type: "bearer",
  expires_in: 3600,
  expires_at: Math.floor(Date.now() / 1000) + 3600,
  user: { id: "user-1", email: "user@example.com" },
  ...over,
});

// Ответ в той форме, которую читают обе стороны: snapshot берёт text(),
// общий refresh — json().
function response(status, body) {
  return {
    status,
    ok: status >= 200 && status < 300,
    text: async () => body,
    json: async () => JSON.parse(body),
  };
}

// Зависший ответ, который умеет то же, что настоящий: abort сигнала обрывает и
// сам запрос, и уже начатое чтение тела.
//
// Запрос БЕЗ signal (таков общий refresh — его не отменяют) обязан честно
// висеть, а не падать: чтение `signal.aborted` у `null` давало TypeError, и
// сценарий зависшего refresh на самом деле проверял мгновенную ошибку (F2).
function hangForever(signal) {
  return new Promise((_, reject) => {
    if (!signal) return;
    if (signal.aborted) { reject(signal.reason || new Error("Aborted")); return; }
    signal.addEventListener("abort", () => reject(signal.reason || new Error("Aborted")), { once: true });
  });
}

function hangingBody(signal, status = 200) {
  return {
    status,
    ok: status >= 200 && status < 300,
    text: () => hangForever(signal),
    json: () => hangForever(signal),
  };
}

function hangingRequest(signal) {
  return hangForever(signal);
}

/**
 * Service worker + страница панели поверх него, общие управляемые часы.
 * `respond(call)` возвращает готовый ответ либо Promise; ему доступен signal.
 */
function stand({ respond, storage = { tv_session: session() }, silentMessaging = false,
  deliveryMs = 0, stallSessionRead = false } = {}) {
  const clock = makeClock();
  const FakeDate = makeDate(clock);
  const localArea = stallSessionRead ? stalledArea(storage) : memoryArea(storage);
  const calls = [];
  const messages = [];
  let listener = null;

  const sw = {
    chrome: {
      // Зависшее чтение storage: первый же initial-этап фона не отвечает, пока
      // тест не разрешит его сам.
      storage: { local: localArea, session: memoryArea() },
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
    AbortController,
    Date: FakeDate,
    btoa,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    console: { log() {}, info() {}, warn() {}, error() {}, debug() {} },
    fetch: (url, options = {}) => {
      const call = {
        url: String(url),
        method: String(options.method || "GET").toUpperCase(),
        headers: options.headers || {},
        body: options.body ?? null,
        signal: options.signal || null,
      };
      calls.push(call);
      return Promise.resolve(respond(call)).then((value) => {
        if (value === "hang") return hangingRequest(call.signal);
        if (value === "hang-body") return hangingBody(call.signal);
        return value;
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
  vm.runInContext(src.background, sw, { filename: "public/background.js" });
  assert.ok(listener, "background не зарегистрировал onMessage listener");

  const panelSender = { id: EXT_ID, url: `chrome-extension://${EXT_ID}/panel.html`, tab: { id: 7 } };
  const page = {
    chrome: {
      runtime: {
        id: EXT_ID,
        lastError: null,
        sendMessage: (message, callback) => {
          messages.push(message);
          // Молчание messaging: остановленный MV3 worker или осиротевший канал.
          if (silentMessaging) return;
          // Доставка между контекстами занимает модельное время: в этом зазоре и
          // расходился «общий срок» от «свежих пяти секунд у фона».
          if (deliveryMs > 0) clock.setTimeout(() => listener(message, panelSender, callback), deliveryMs);
          else listener(message, panelSender, callback);
        },
      },
    },
    console: { log() {}, info() {}, warn() {}, error() {}, debug() {} },
    URL,
    Date: FakeDate,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
  };
  page.window = page;
  vm.createContext(page);
  vm.runInContext(src.supabase, page, { filename: "public/supabase.js" });
  vm.runInContext(src.api, page, { filename: "public/api.js" });

  // PUB-07 завёл ОДИН таймер на активацию worker: срок проверки защиты носителя
  // отсчитывается от самой проверки, а не от первого credential-вызывающего
  // (CODEX-PUBLIC-PUB07-REVIEW-01, F1). Он создаётся синхронно при загрузке
  // oauth.js, то есть уже к этой строке, и снимается успешной проверкой.
  //
  // Утверждения ниже говорят о таймерах ШАГА snapshot, поэтому они считаются от
  // этой отметки. Точность не теряется: список таймеров шага по-прежнему
  // сверяется целиком, а startup-таймер проверяется отдельным тестом.
  const startupTimers = clock.created.length;

  return {
    clock,
    startupTimers,
    stepTimers: () => clock.created.slice(startupTimers),
    calls,
    messages,
    sw,
    API: page.API,
    fnCalls: () => calls.filter((call) => call.url === FN_URL),
    tokenCalls: () => calls.filter((call) => call.url === TOKEN_URL),
    releaseSessionRead: () => localArea.release?.(),
    invoke: (name, body, deadline) => vm.runInContext("tvInvokeFunction", sw)(name, body, deadline),
    send: (message, sender) => new Promise((resolve) => {
      const async_ = listener(message, sender, resolve);
      if (async_ !== true) resolve(undefined);
    }),
  };
}

// Необработанный rejection ловится процессом: поздние ответы обязаны быть
// обработаны, а не «просто не мешать».
async function withoutUnhandled(body) {
  const seen = [];
  const onReject = (reason) => seen.push(reason);
  process.on("unhandledRejection", onReject);
  try {
    const result = await body();
    for (let i = 0; i < 10; i++) await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(seen.map(String), [], "необработанный Promise rejection");
    return result;
  } finally {
    process.off("unhandledRejection", onReject);
  }
}

// ==================================== 1. зависшие этапы в одном бюджете

test("зависший запрос завершает шаг одним бюджетом и отменяется", async () => {
  await withoutUnhandled(async () => {
    const h = stand({ respond: () => "hang" });
    const step = h.API.snapshotStats(VIDEO);
    await h.clock.flush();

    assert.deepEqual(h.stepTimers(), [BUDGET, BUDGET],
      "ровно два таймера — по одному на слой (UI и фон), оба на весь шаг");
    assert.equal(h.fnCalls().length, 1);
    assert.ok(h.fnCalls()[0].signal, "запрос обязан уходить с AbortSignal");
    assert.equal(h.fnCalls()[0].signal.aborted, false);

    await h.clock.advance(BUDGET - 1);
    assert.equal(h.fnCalls()[0].signal.aborted, false, "срок истёк раньше бюджета");

    await h.clock.advance(1);
    assert.equal(await step, false, "best-effort шаг обязан завершиться");
    assert.equal(h.fnCalls()[0].signal.aborted, true, "принадлежащий snapshot запрос не отменён");
    assert.equal(h.fnCalls().length, 1, "после истечения срока ушёл лишний запрос");
    assert.deepEqual(h.clock.pending(), [], "таймеры не убраны");
  });
});

test("зависшее чтение тела обрывается тем же сроком", async () => {
  await withoutUnhandled(async () => {
    const h = stand({ respond: () => "hang-body" });
    const step = h.API.snapshotStats(VIDEO);
    await h.clock.flush();
    assert.deepEqual(h.stepTimers(), [BUDGET, BUDGET]);

    await h.clock.advance(BUDGET);
    assert.equal(await step, false);
    assert.equal(h.fnCalls()[0].signal.aborted, true, "abort обязан доходить до чтения тела");
    assert.equal(h.fnCalls().length, 1);
    assert.deepEqual(h.clock.pending(), []);
  });
});

test("молчание messaging тоже завершает шаг: панель не ждёт вечно", async () => {
  await withoutUnhandled(async () => {
    // Ответа не будет вовсе — фоновый бюджет тут не поможет, и UI обязан иметь
    // собственный предел.
    const h = stand({ respond: () => response(200, "{}"), silentMessaging: true });
    const step = h.API.snapshotStats(VIDEO);
    await h.clock.flush();
    assert.deepEqual(h.stepTimers(), [BUDGET], "UI завёл ровно один таймер на шаг");
    assert.equal(h.calls.length, 0, "фон сообщение не получил");

    await h.clock.advance(BUDGET);
    assert.equal(await step, false);
    assert.deepEqual(h.clock.pending(), []);
  });
});

// ============================================ 2. штатные исходы не сломаны

test("быстрый snapshot сохраняет прежнее поведение", async () => {
  await withoutUnhandled(async () => {
    const h = stand({ respond: () => response(200, JSON.stringify({ ok: true })) });
    assert.equal(await h.API.snapshotStats(VIDEO), true);
    assert.equal(h.fnCalls().length, 1);
    assert.equal(JSON.parse(h.fnCalls()[0].body).video_id, VIDEO);
    assert.deepEqual(h.clock.pending(), [], "таймеры бюджета обязаны сниматься при успехе");
    // Предварительного tv:sb-session больше нет: лишний неограниченный этап убран.
    assert.deepEqual(h.messages.map((message) => message.type), ["tv:sb-function"]);
  });
});

test("обычная ошибка остаётся обычной ошибкой best-effort шага", async () => {
  await withoutUnhandled(async () => {
    const h = stand({ respond: () => response(500, JSON.stringify({ message: "boom" })) });
    assert.equal(await h.API.snapshotStats(VIDEO), false);
    assert.equal(h.fnCalls().length, 1, "ошибка не повод для повторов");
    assert.deepEqual(h.clock.pending(), []);
  });
});

test("пустой videoId не заводит ни таймера, ни запроса", async () => {
  await withoutUnhandled(async () => {
    const h = stand({ respond: () => response(200, "{}") });
    assert.equal(await h.API.snapshotStats(""), false);
    assert.deepEqual(h.stepTimers(), []);
    assert.equal(h.calls.length, 0);
  });
});

test("401 → общий refresh → ровно один успешный повтор", async () => {
  await withoutUnhandled(async () => {
    let attempt = 0;
    const h = stand({
      respond: (call) => {
        if (call.url === TOKEN_URL) {
          return response(200, JSON.stringify({ ...session({ access_token: `access-${"z".repeat(40)}` }), expires_in: 3600 }));
        }
        attempt += 1;
        return attempt === 1 ? response(401, JSON.stringify({ message: "expired" })) : response(200, "{}");
      },
    });
    assert.equal(await h.API.snapshotStats(VIDEO), true);
    assert.equal(h.fnCalls().length, 2, "ровно один повтор после 401");
    assert.equal(h.tokenCalls().length, 1);
    assert.deepEqual(h.stepTimers(), [BUDGET, BUDGET], "повтор не получает собственный срок");
    assert.deepEqual(h.clock.pending(), []);
  });
});

// ======================= 3. общий refresh: ждём, но не отменяем и не повторяем

test("401 с зависшим общим refresh укладывается в исходный срок, таймер не перезапускается", async () => {
  await withoutUnhandled(async () => {
    const h = stand({
      respond: (call) => (call.url === TOKEN_URL ? "hang" : response(401, JSON.stringify({ message: "expired" }))),
    });
    const step = h.API.snapshotStats(VIDEO);
    await h.clock.flush();
    assert.equal(h.fnCalls().length, 1);
    assert.equal(h.tokenCalls().length, 1, "общий refresh должен быть начат");

    await h.clock.advance(BUDGET);
    assert.equal(await step, false);
    assert.deepEqual(h.stepTimers(), [BUDGET, BUDGET], "срок начался заново");
    assert.equal(h.fnCalls().length, 1, "просроченный повтор не имеет права уходить");
    assert.deepEqual(h.clock.pending(), []);
    // Общий refresh НЕ отменялся: его собственный запрос живёт дальше.
    assert.equal(h.tokenCalls()[0].signal, null, "у общего refresh не должно появиться чужого signal");
  });
});

test("после истечения snapshot общий refresh остаётся рабочим для другого caller", async () => {
  await withoutUnhandled(async () => {
    let releaseToken = null;
    const pending = new Promise((resolve) => { releaseToken = resolve; });
    const h = stand({
      respond: (call) => (call.url === TOKEN_URL
        ? pending.then(() => response(200, JSON.stringify({ ...session({ access_token: `access-${"q".repeat(40)}` }), expires_in: 3600 })))
        : response(401, JSON.stringify({ message: "expired" }))),
    });
    const step = h.API.snapshotStats(VIDEO);
    await h.clock.flush();
    await h.clock.advance(BUDGET);
    assert.equal(await step, false);
    const fnAfterTimeout = h.fnCalls().length;

    // Поздний успех общего refresh: снапшот его больше не касается, но другой
    // вызывающий обязан получить рабочую сессию.
    releaseToken();
    await h.clock.flush();
    const revived = await vm.runInContext("tvRefreshSession()", h.sw);
    assert.ok(revived?.access_token, "общий refresh сломан для остальных вызывающих");
    assert.equal(h.fnCalls().length, fnAfterTimeout, "поздний refresh не имеет права поднимать новый snapshot");
    assert.deepEqual(h.clock.pending(), []);
  });
});

test("поздний успех запроса после истечения срока ничего не запускает", async () => {
  await withoutUnhandled(async () => {
    let release = null;
    const late = new Promise((resolve) => { release = resolve; });
    const h = stand({ respond: () => late.then(() => response(200, "{}")) });
    const step = h.API.snapshotStats(VIDEO);
    await h.clock.flush();
    await h.clock.advance(BUDGET);
    assert.equal(await step, false, "шаг завершился по бюджету");

    release();
    await h.clock.flush();
    assert.equal(h.fnCalls().length, 1, "поздний ответ породил новый запрос");
    assert.deepEqual(h.clock.pending(), [], "поздний ответ оставил таймер");
  });
});

// ================================== 4. границы соседних операций не сдвинуты

test("бюджет не распространился на REST и на прочие функции", async () => {
  await withoutUnhandled(async () => {
    const h = stand({ respond: () => response(200, "[]") });
    // REST-путь таймеров бюджета не заводит.
    await vm.runInContext(`tvSupabaseRest("collections?select=id,name&order=name.asc", { method: "GET", headers: {} })`, h.sw);
    assert.deepEqual(h.stepTimers(), [], "у REST появился чужой бюджет");
    // Чужая функция по-прежнему недостижима.
    await assert.rejects(
      () => vm.runInContext(`tvInvokeFunction("other-function", { video_id: "${VIDEO}" })`, h.sw),
      /Function not allowed/,
    );
    await assert.rejects(
      () => vm.runInContext(`tvInvokeFunction("refresh-views", { video_id: "nope" })`, h.sw),
      /Invalid videoId/,
    );
    assert.deepEqual(h.stepTimers(), [], "отказ до сети не должен заводить таймер");
  });
});

// ============ 5. ОДИН конечный срок между контекстами (F1 из REVIEW-01)

test("доставка на t=6000: просроченный вызов не идёт ни в Auth, ни в сеть", async () => {
  await withoutUnhandled(async () => {
    const h = stand({ respond: () => response(200, "{}"), deliveryMs: 6000 });
    const step = track(h.API.snapshotStats(VIDEO));
    await h.clock.flush();

    await h.clock.advance(BUDGET - 1);
    assert.equal(step.settled, false, "шаг завершился раньше срока");
    await h.clock.advance(1);
    assert.equal(step.settled, true, "UI обязан закончить ровно на своём сроке");
    assert.equal(step.value, false);
    assert.equal(h.calls.length, 0, "до доставки сети быть не может");

    // Сообщение доезжает уже после конца срока.
    await h.clock.advance(1000);
    assert.equal(h.fnCalls().length, 0, "просроченный вызов отправил snapshot POST");
    assert.equal(h.tokenCalls().length, 0, "просроченный вызов полез в Auth");
    assert.equal(h.calls.length, 0, "просроченный вызов вообще не должен ходить в сеть");
  });
});

test("доставка на t=1000: у фона остаётся 4000, а не свежие 5000", async () => {
  await withoutUnhandled(async () => {
    const h = stand({ respond: () => "hang", deliveryMs: 1000 });
    const step = track(h.API.snapshotStats(VIDEO));
    await h.clock.flush();
    await h.clock.advance(1000);
    assert.equal(h.fnCalls().length, 1, "после доставки запрос обязан уйти");

    const budgets = h.stepTimers().filter((ms) => ms === BUDGET);
    assert.equal(budgets.length, 1, "фон завёл вторые свежие 5000 вместо остатка");
    assert.ok(h.stepTimers().includes(BUDGET - 1000), `фон не учёл доставку: ${JSON.stringify(h.stepTimers())}`);

    await h.clock.advance(BUDGET - 1000 - 1);
    assert.equal(step.settled, false, "шаг закончился раньше общего срока");
    assert.equal(h.fnCalls()[0].signal.aborted, false);

    await h.clock.advance(1);
    assert.equal(step.settled, true, "общий срок наступает на t=5000, а не на t=6000");
    assert.equal(step.value, false);
    assert.equal(h.fnCalls()[0].signal.aborted, true, "активный запрос не отменён по исходному сроку");
    assert.deepEqual(h.clock.pending(), []);
  });
});

test("401 и общий refresh, завершающийся после исходного срока: повтора нет", async () => {
  await withoutUnhandled(async () => {
    let releaseToken = null;
    const token = new Promise((resolve) => { releaseToken = resolve; });
    const h = stand({
      respond: (call) => (call.url === TOKEN_URL
        ? token.then(() => response(200, JSON.stringify({ ...session({ access_token: `access-${"q".repeat(40)}` }), expires_in: 3600 })))
        : response(401, JSON.stringify({ message: "expired" }))),
    });
    const step = track(h.API.snapshotStats(VIDEO));
    await h.clock.flush();
    assert.equal(h.fnCalls().length, 1);
    assert.equal(h.tokenCalls().length, 1, "общий refresh обязан быть начат");
    assert.equal(h.tokenCalls()[0].signal, null, "общий refresh не должен получать чужой signal");

    await h.clock.advance(BUDGET - 1);
    assert.equal(step.settled, false, "шаг не дождался срока");
    await h.clock.advance(1);
    assert.equal(step.settled, true);
    assert.equal(step.value, false);
    assert.equal(h.fnCalls().length, 1, "повтор ушёл несмотря на истёкший срок");

    // Общий refresh завершается ПОЗЖЕ срока: snapshot его больше не касается,
    // но сам flight живёт и отдаёт результат другому caller.
    await h.clock.advance(500);
    releaseToken();
    await h.clock.flush();
    assert.equal(h.fnCalls().length, 1, "поздний refresh запустил просроченный retry");
    const revived = await vm.runInContext("tvRefreshSession()", h.sw);
    assert.ok(revived?.access_token, "общий refresh сломан для остальных вызывающих");
    assert.deepEqual(h.clock.pending(), []);
  });
});

test("поздний ОТКАЗ общего refresh не даёт ни повтора, ни unhandled rejection", async () => {
  await withoutUnhandled(async () => {
    let failToken = null;
    const token = new Promise((_, reject) => { failToken = reject; });
    token.catch(() => {});
    const h = stand({
      respond: (call) => (call.url === TOKEN_URL ? token : response(401, JSON.stringify({ message: "expired" }))),
    });
    const step = track(h.API.snapshotStats(VIDEO));
    await h.clock.flush();
    await h.clock.advance(BUDGET);
    assert.equal(step.settled, true);
    assert.equal(step.value, false);

    failToken(new Error("network down"));
    await h.clock.flush();
    assert.equal(h.fnCalls().length, 1);
    assert.deepEqual(h.clock.pending(), []);
  });
});

test("зависший initial-этап (storage) ограничен тем же сроком, позднее чтение ничего не шлёт", async () => {
  await withoutUnhandled(async () => {
    const h = stand({ respond: () => response(200, "{}"), stallSessionRead: true });
    const step = track(h.API.snapshotStats(VIDEO));
    await h.clock.flush();
    assert.equal(h.calls.length, 0, "сети до сессии быть не должно");

    await h.clock.advance(BUDGET - 1);
    assert.equal(step.settled, false, "шаг не дождался срока на зависшем storage");
    await h.clock.advance(1);
    assert.equal(step.settled, true);
    assert.equal(step.value, false);

    // Позднее завершение чтения не должно оживлять просроченный шаг.
    h.releaseSessionRead();
    await h.clock.flush();
    assert.equal(h.fnCalls().length, 0, "поздняя сессия отправила snapshot POST");
    assert.deepEqual(h.clock.pending(), []);
  });
});

// ======================= 6. метаданные срока: валидируются, а не расширяют

test("отсутствующий и невалидный срок — явный отказ до Auth и до сети", async () => {
  await withoutUnhandled(async () => {
    const h = stand({ respond: () => response(200, "{}") });
    for (const bad of [undefined, null, "5000", NaN, Infinity, -Infinity, {}, [], true]) {
      await assert.rejects(
        () => h.invoke("refresh-views", { video_id: VIDEO }, bad),
        /Invalid snapshot deadline/,
        `срок принят: ${String(bad)}`,
      );
    }
    assert.equal(h.calls.length, 0, "невалидные метаданные дошли до сети");
    assert.deepEqual(h.stepTimers(), [], "невалидные метаданные завели таймер");
  });
});

test("уже просроченный срок отвергается до session lookup и сети", async () => {
  await withoutUnhandled(async () => {
    const h = stand({ respond: () => response(200, "{}") });
    for (const past of [h.clock.now(), h.clock.now() - 1, h.clock.now() - 10000]) {
      await assert.rejects(
        () => h.invoke("refresh-views", { video_id: VIDEO }, past),
        /Snapshot deadline expired/,
        `просроченный срок принят: ${past}`,
      );
    }
    assert.equal(h.calls.length, 0);
    assert.deepEqual(h.stepTimers(), []);
  });
});

// Startup-таймер PUB-07 учитывается ЯВНО, а не прячется за смещением отсчёта:
// иначе «таймеров шага столько же» перестало бы отличать отсутствие лишних
// таймеров от их молчаливого списания.
test("PUB-07 startup timer: ровно один на активацию, снят успешной проверкой", async () => {
  await withoutUnhandled(async () => {
    const h = stand({ respond: () => response(200, "{}") });
    assert.equal(h.startupTimers, 1, `startup-таймеров: ${h.startupTimers}`);
    assert.deepEqual(h.clock.created.slice(0, 1), [3000], JSON.stringify(h.clock.created));
    await h.clock.flush();
    // Успешная проверка защиты снимает его: до шага snapshot живых таймеров нет.
    assert.deepEqual(h.clock.pending(), [], "startup-таймер не снят");
    assert.deepEqual(h.stepTimers(), [], "шаг ещё не начинался, а таймеры уже есть");
  });
});

test("чрезмерный срок срезается нашим пределом, а не продлевает бюджет", async () => {
  await withoutUnhandled(async () => {
    const h = stand({ respond: () => "hang" });
    const state = track(h.invoke("refresh-views", { video_id: VIDEO }, h.clock.now() + 60000).then(() => "ok", () => "failed"));
    await h.clock.flush();
    assert.deepEqual(h.stepTimers(), [BUDGET], `остаток не срезан: ${JSON.stringify(h.stepTimers())}`);

    await h.clock.advance(BUDGET - 1);
    assert.equal(state.settled, false);
    await h.clock.advance(1);
    assert.equal(state.settled, true, "чрезмерный срок пережил собственный предел");
    assert.equal(state.value, "failed");
    assert.equal(h.fnCalls()[0].signal.aborted, true);
  });
});

test("срок — метаданные конверта: в тело Edge-запроса он не попадает", async () => {
  await withoutUnhandled(async () => {
    const h = stand({ respond: () => response(200, "{}") });
    assert.equal(await h.API.snapshotStats(VIDEO), true);
    const sent = JSON.parse(h.fnCalls()[0].body);
    assert.deepEqual(Object.keys(sent).sort(), ["video_id"], JSON.stringify(sent));
    // В сообщении срок есть, в теле — нет.
    const message = h.messages.find((item) => item.type === "tv:sb-function");
    assert.equal(typeof message.deadline, "number");
    assert.ok(message.deadline > h.clock.now() - 1 && message.deadline <= h.clock.now() + BUDGET);
  });
});

test("host page по-прежнему не достаёт до snapshot-маршрута", async () => {
  await withoutUnhandled(async () => {
    const h = stand({ respond: () => response(200, "{}") });
    const blocked = await h.send({
      type: "tv:sb-function",
      name: "refresh-views",
      body: { video_id: VIDEO },
      deadline: h.clock.now() + BUDGET,
    }, { id: EXT_ID, url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ", tab: { id: 7 } });
    assert.deepEqual({ ok: blocked.ok, error: blocked.error }, { ok: false, error: "Blocked sender" });
    assert.equal(h.calls.length, 0);
  });
});

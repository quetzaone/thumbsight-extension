// node --test: срок сессии считается по локальным часам (EXT-OPT-01, id 30).
//
// Серверный `expires_at` — время по часам сервера. Если часы ПК впереди, он
// уже «в прошлом» в момент получения, и `tvValidSession` уходил в refresh перед
// КАЖДЫМ сообщением: лишние ротации refresh_token. Проверяем инварианты:
//   после refresh со сдвинутым `expires_at` следующий запрос токен не трогает;
//   refresh без `expires_at`, но с `expires_in` — тоже;
//   вход (exchange) со сдвигом даёт сессию, валидную сразу;
//   без `expires_in` остаётся серверный `expires_at`, набор ключей прежний.
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
const TOKEN_URL = `${CONFIG.SUPABASE_URL}/auth/v1/token`;
const EXCHANGE_URL = `${CONFIG.SUPABASE_URL}/functions/v1/exchange`;
const REST = `${CONFIG.SUPABASE_URL}/rest/v1/`;
const COLLECTIONS = "collections?select=id,name&order=name.asc";
const SESSION_KEYS = ["access_token", "expires_at", "expires_in", "refresh_token", "token_type", "user"];

const file = (name) => readFile(new URL(`../${name}`, import.meta.url), "utf8");
const src = {
  background: await file("background.js"),
  oauth: await file("oauth.js"),
  intent: await file("intent.js"),
};

const nowSec = () => Math.floor(Date.now() / 1000);

// Тело ответа GoTrue/exchange. `fields` перекрывает срок: так задаются и сдвиг
// часов, и отсутствие полей (undefined выпадает из JSON).
function sessionBody(fields = {}, n = 1) {
  return {
    access_token: `access-${String(n).padStart(40, "x")}`,
    refresh_token: `refresh-${n}`,
    token_type: "bearer",
    expires_in: 3600,
    expires_at: nowSec() + 3600,
    user: { id: "user-1", email: "user@example.com" },
    ...fields,
  };
}

function memoryArea(initial = {}) {
  const data = { ...initial };
  return {
    data,
    async get(keys) {
      const list = Array.isArray(keys) ? keys : [keys];
      return Object.fromEntries(list.filter((key) => key in data).map((key) => [key, data[key]]));
    },
    async set(values) { Object.assign(data, values); },
    async remove(keys) {
      for (const key of Array.isArray(keys) ? keys : [keys]) delete data[key];
    },
    async setAccessLevel() {},
  };
}

const json = (body) =>
  new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });

// Service worker целиком (background.js → importScripts intent.js, oauth.js):
// срок проверяет настоящий tvValidSession на пути tv:sb-rest. Ответ refresh и
// exchange отдаёт `auth()` — новая сессия на каждый вызов.
function harness({ session = null, auth }) {
  const local = memoryArea(session ? { tv_session: session } : {});
  const calls = [];
  let listener = null;
  let served = 0;
  const sw = {
    chrome: {
      storage: { local, session: memoryArea() },
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
    btoa,
    setTimeout,
    clearTimeout,
    console: { log() {}, info() {}, warn() {}, error() {}, debug() {} },
    fetch: async (url) => {
      const target = String(url);
      calls.push(target);
      if (target.startsWith(TOKEN_URL) || target.startsWith(EXCHANGE_URL)) return json(auth(++served));
      if (target.startsWith(REST)) return json([]);
      throw new Error(`unexpected fetch: ${target}`);
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

  const send = (message, page) =>
    new Promise((resolve) => {
      listener(message, { id: EXT_ID, url: `chrome-extension://${EXT_ID}/${page}`, tab: { id: 7 } }, resolve);
    });
  return {
    stored: () => local.data.tv_session,
    tokenCalls: () => calls.filter((url) => url.startsWith(TOKEN_URL)).length,
    rest: async () => {
      const res = await send({ type: "tv:sb-rest", path: COLLECTIONS, opts: {} }, "panel.html");
      assert.equal(res.ok, true, `tv:sb-rest отказал: ${res.error}`);
    },
    signIn: () => send({ type: "tv:oauth-sign-in" }, "popup.html"),
  };
}

// Сохранённая сессия уже истекла — первый запрос обязан обновить её.
const expired = () => sessionBody({ expires_at: nowSec() - 10 }, 0);

test("refresh со сдвигом часов (expires_at сервера = локальное «сейчас»): token один раз на три запроса", async () => {
  const h = harness({ session: expired(), auth: (n) => sessionBody({ expires_at: nowSec() }, n) });
  for (let i = 0; i < 3; i++) await h.rest();
  assert.equal(h.tokenCalls(), 1, "каждый запрос заново ротировал refresh_token");
  const stored = h.stored();
  assert.ok(stored.expires_at >= nowSec() + 3600 - 5, "срок не пересчитан от локального времени запроса");
  assert.deepEqual(Object.keys(stored).sort(), SESSION_KEYS, "набор ключей сессии изменился");
});

test("refresh без expires_at, но с expires_in: следующий запрос не идёт в token", async () => {
  const h = harness({ session: expired(), auth: (n) => sessionBody({ expires_at: undefined }, n) });
  await h.rest();
  assert.equal(h.tokenCalls(), 1);
  await h.rest();
  assert.equal(h.tokenCalls(), 1, "сессия без expires_at обновлялась перед каждым запросом");
});

test("вход (exchange) со сдвигом часов: сессия валидна сразу", async () => {
  const h = harness({ auth: (n) => sessionBody({ expires_at: nowSec() }, n) });
  const res = await h.signIn();
  assert.equal(res.ok, true, `вход отказал: ${res.error}`);
  await h.rest();
  assert.equal(h.tokenCalls(), 0, "только что полученная сессия сразу ушла в refresh");
  assert.ok(h.stored().expires_at >= nowSec() + 3600 - 5);
});

test("без expires_in в ответе остаётся серверный expires_at (контроль)", async () => {
  const serverExpiry = nowSec() + 7200;
  const h = harness({ session: expired(), auth: (n) => sessionBody({ expires_in: undefined, expires_at: serverExpiry }, n) });
  await h.rest();
  assert.equal(h.tokenCalls(), 1);
  assert.equal(h.stored().expires_at, serverExpiry);
});

// node --test: единственный RPC-маршрут публичного расширения —
// `rpc/replace_thumbnail_links` (supabase/migration-junction-ownership-atomic.sql).
//
// Проверяем инварианты, а не формулировки:
//   одно сохранение — ОДИН POST, оба набора в нём, ни одной прямой junction-записи;
//   `null` («не менять») и `[]` («очистить») остаются разными вещами;
//   отказ доходит до панели и не порождает фолбэка на прямую запись;
//   ответ, не подтвердивший замену, успехом не считается;
//   маршрут пришпилен: ни другого rpc, ни query, ни другого метода, ни другого тела;
//   прежние границы (sender, PATCH/PUT, шесть таблиц, Prefer) не сдвинулись.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

const EXT_ID = "a".repeat(32);
const ACCESS_TOKEN = `access-${"x".repeat(40)}`;
const CONFIG = {
  SUPABASE_URL: "https://project.supabase.co",
  SUPABASE_ANON_KEY: "anon-key",
  AUTH_SITE_URL: "https://thumbsight.com",
};
const CONFIG_SRC = `self.THUMBVAULT_CONFIG = ${JSON.stringify(CONFIG)};`;
const REST = `${CONFIG.SUPABASE_URL}/rest/v1/`;
const RPC_PATH = "rpc/replace_thumbnail_links";
const RPC_URL = `${REST}${RPC_PATH}`;

const COVER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const C1 = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const C2 = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const T1 = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

const file = (name) => readFile(new URL(`../${name}`, import.meta.url), "utf8");
const src = {
  background: await file("background.js"),
  oauth: await file("oauth.js"),
  intent: await file("intent.js"),
  supabase: await file("supabase.js"),
  api: await file("api.js"),
};

// --------------------------------------------------------------- фикстуры

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

const session = () => ({
  access_token: ACCESS_TOKEN,
  refresh_token: "refresh-secret-1",
  token_type: "bearer",
  expires_in: 3600,
  expires_at: Math.floor(Date.now() / 1000) + 3600,
  user: { id: "user-1", email: "user@example.com" },
});

const panelSender = () => ({
  id: EXT_ID,
  url: `chrome-extension://${EXT_ID}/panel.html`,
  tab: { id: 7 },
});

const hostSender = () => ({
  id: EXT_ID,
  url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
  tab: { id: 7 },
});

/** Ответ функции дословно по SQL: она сообщает, какие наборы заменила. */
const echo = (body) => JSON.stringify({
  thumbnail_id: body.p_thumbnail_id,
  collections: body.p_collection_ids === null ? null : body.p_collection_ids.length,
  tags: body.p_tag_ids === null ? null : body.p_tag_ids.length,
});

/**
 * Service worker в vm + страница панели поверх него. Ответы REST задаются
 * функцией от разобранного тела; по умолчанию — честный ответ RPC.
 */
function harness(respond = (body) => ({ status: 200, text: echo(body) })) {
  const calls = [];
  const logs = [];
  const push = (...args) => logs.push(args.map(String).join(" "));
  let listener = null;

  const sw = {
    chrome: {
      storage: { local: memoryArea({ tv_session: session() }), session: memoryArea() },
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
    btoa,
    setTimeout,
    clearTimeout,
    console: { log: push, info: push, warn: push, error: push, debug: push },
    fetch: async (url, options) => {
      const call = {
        url: String(url),
        method: String(options?.method || "GET").toUpperCase(),
        headers: options?.headers || {},
        body: options?.body ?? null,
      };
      calls.push(call);
      if (!call.url.startsWith(REST)) throw new Error(`unexpected fetch host: ${call.url}`);
      const parsed = call.body ? JSON.parse(call.body) : null;
      const { status, text } = respond(parsed, call);
      return new Response(status === 204 ? null : text, {
        status,
        headers: { "Content-Type": "application/json" },
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

  const page = {
    chrome: {
      runtime: {
        id: EXT_ID,
        lastError: null,
        sendMessage: (message, callback) => { listener(message, panelSender(), callback); },
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

  return {
    sw,
    calls,
    logs,
    API: page.API,
    normalize: (path, opts) => sw.tvNormalizeRestRequest(path, opts),
    send: (message, sender = panelSender()) =>
      new Promise((resolve) => { listener(message, sender, resolve); }),
  };
}

async function rejection(promise) {
  try {
    await promise;
  } catch (err) {
    return err;
  }
  throw new Error("ожидался отказ, а промис разрешился");
}

// ------------------------------------------- 1. один совместный вызов

test("папки и теги одного сохранения уходят ОДНИМ POST", async () => {
  const h = harness();
  const result = await h.API.replaceThumbnailLinks(COVER, { collectionIds: [C1, C2], tagIds: [T1] });

  assert.equal(h.calls.length, 1, "две цепочки вместо одной — это и есть неатомарность");
  assert.equal(h.calls[0].url, RPC_URL);
  assert.equal(h.calls[0].method, "POST");
  assert.deepEqual(JSON.parse(h.calls[0].body), {
    p_thumbnail_id: COVER,
    p_collection_ids: [C1, C2],
    p_tag_ids: [T1],
  }, "PostgREST связывает аргументы ПО ИМЕНИ — имена и есть контракт");
  // Значения приходят из vm-контекста: сверяем содержимое, а не realm прототипа.
  assert.deepEqual(JSON.parse(JSON.stringify(result)), { thumbnail_id: COVER, collections: 2, tags: 1 });

  // Прямых junction-запросов не осталось ни одного.
  assert.ok(!h.calls.some((c) => /thumbnail_(collections|tags)\?/.test(c.url)));
});

test("API расширения больше не умеет заменять набор по одной таблице", () => {
  const h = harness();
  assert.equal(h.API.setThumbnailCollections, undefined);
  assert.equal(h.API.setThumbnailTags, undefined);
  assert.ok(!src.api.includes("thumbnail_collections?thumbnail_id=eq."));
  assert.ok(!src.api.includes("thumbnail_tags?thumbnail_id=eq."));
});

// -------------------------------------------------- 2. null против []

test("`[]` очищает набор, `null` оставляет его в покое", async () => {
  const h = harness();
  await h.API.replaceThumbnailLinks(COVER, { collectionIds: [], tagIds: null });
  assert.deepEqual(JSON.parse(h.calls[0].body), {
    p_thumbnail_id: COVER,
    p_collection_ids: [],
    p_tag_ids: null,
  });

  await h.API.replaceThumbnailLinks(COVER, { tagIds: [] });
  assert.deepEqual(JSON.parse(h.calls[1].body), {
    p_thumbnail_id: COVER,
    p_collection_ids: null,
    p_tag_ids: [],
  });
});

test("оба набора `null` — запроса нет вовсе", async () => {
  const h = harness();
  assert.equal(await h.API.replaceThumbnailLinks(COVER, {}), null);
  assert.equal(await h.API.replaceThumbnailLinks(COVER, { collectionIds: null, tagIds: null }), null);
  assert.equal(h.calls.length, 0);
});

test("панель сохраняет только изменившиеся наборы одним вызовом", async () => {
  // Ровно та форма, которую собирает panel.js: неизменившийся набор — `null`.
  const panel = await file("panel.js");
  const save = panel.slice(panel.indexOf("tvOnTrusted(save,"), panel.indexOf("function tvSendMessage"));
  assert.equal((save.match(/API\.replaceThumbnailLinks\(/g) || []).length, 1, "сохранение обязано быть одним вызовом");
  assert.ok(!save.includes("Promise.all(writes)"), "две независимые цепочки вернулись");
  assert.ok(save.includes("tvSame(selectedFolders, originalFolders) ? null"), "потеряно различие «не менялось» → null");
  assert.ok(save.includes("tvSame(selectedTags, originalTags) ? null"));
});

// ------------------------------------------------ 3. отказ без фолбэка

test("отказ RPC доходит до вызывающего и не идёт в обход", async () => {
  const h = harness(() => ({ status: 400, text: JSON.stringify({ code: "JO011", message: "set too large" }) }));
  const err = await rejection(h.API.replaceThumbnailLinks(COVER, { collectionIds: [C1] }));

  assert.match(err.message, /^400: /);
  assert.equal(h.calls.length, 1, "ни повтора, ни фолбэка на прямую запись");
});

test("403 не превращается в прямую запись в junction-таблицы", async () => {
  const h = harness(() => ({ status: 403, text: JSON.stringify({ code: "42501" }) }));
  await rejection(h.API.replaceThumbnailLinks(COVER, { collectionIds: [C1], tagIds: [T1] }));
  assert.deepEqual(h.calls.map((c) => c.url), [RPC_URL]);
});

// -------------------------------------------------- 4. ложный успех

test("200 с пустым телом успехом не считается (STRICT-дрейф функции)", async () => {
  // `ALTER FUNCTION … STRICT` не меняет ни тела, ни грантов, ни posture, но
  // штатный вызов с одним null возвращает 200 и null, не выполнив ничего.
  for (const text of ["null", ""]) {
    const h = harness(() => ({ status: 200, text }));
    const err = await rejection(h.API.replaceThumbnailLinks(COVER, { collectionIds: [C1] }));
    assert.equal(err.message, "Link replacement not confirmed");
  }
});

test("ответ, не отчитавшийся о запрошенном наборе, — отказ", async () => {
  const h = harness((body) => ({
    status: 200,
    text: JSON.stringify({ thumbnail_id: body.p_thumbnail_id, collections: null, tags: null }),
  }));
  const err = await rejection(h.API.replaceThumbnailLinks(COVER, { collectionIds: [C1] }));
  assert.equal(err.message, "Link replacement not confirmed");

  // И симметрично: отчёт о наборе, который не просили трогать.
  const noisy = harness((body) => ({
    status: 200,
    text: JSON.stringify({ thumbnail_id: body.p_thumbnail_id, collections: 1, tags: 0 }),
  }));
  await rejection(noisy.API.replaceThumbnailLinks(COVER, { collectionIds: [C1] }));
});

// ----------------------------------------------- 5. маршрут пришпилен

test("разрешён ровно один rpc-маршрут и ровно один метод", () => {
  const h = harness();
  assert.doesNotThrow(() => h.normalize(RPC_PATH, {
    method: "POST",
    body: JSON.stringify({ p_thumbnail_id: COVER, p_collection_ids: [C1] }),
  }));

  for (const path of [
    "rpc/replace_thumbnail_links?select=*",
    "rpc/replace_thumbnail_links?p_thumbnail_id=eq.1",
    "rpc/reserve_upload",
    "rpc/finalize_upload",
    "rpc/replace_thumbnail_links/",
    "rpc/",
    "rpc/Replace_Thumbnail_Links",
  ]) {
    assert.throws(
      () => h.normalize(path, { method: "POST", body: JSON.stringify({ p_thumbnail_id: COVER, p_tag_ids: [] }) }),
      /Supabase route not allowed/,
      `маршрут открылся: ${path}`,
    );
  }

  for (const method of ["GET", "HEAD", "PATCH", "PUT", "DELETE"]) {
    assert.throws(
      () => h.normalize(RPC_PATH, { method, body: JSON.stringify({ p_thumbnail_id: COVER, p_tag_ids: [] }) }),
      /Supabase route not allowed/,
      `метод открылся: ${method}`,
    );
  }
});

test("тело RPC собирается заново по фиксированной форме", () => {
  const h = harness();
  const ok = JSON.stringify({ p_tag_ids: [T1], p_thumbnail_id: COVER, p_collection_ids: null });
  const clean = h.normalize(RPC_PATH, { method: "POST", body: ok });
  assert.equal(
    clean.opts.body,
    JSON.stringify({ p_thumbnail_id: COVER, p_collection_ids: null, p_tag_ids: [T1] }),
    "порядок ключей и содержимое обязаны быть нашими, а не вызывающего",
  );
});

test("недопустимое тело отвергается до сети", () => {
  const h = harness();
  const bad = [
    "{",
    "null",
    '"string"',
    "[]",
    JSON.stringify({}),
    JSON.stringify({ p_thumbnail_id: COVER }),                                  // оба набора null
    JSON.stringify({ p_thumbnail_id: COVER, p_collection_ids: null, p_tag_ids: null }),
    JSON.stringify({ p_thumbnail_id: COVER, p_tag_ids: [], extra: 1 }),         // лишний ключ
    JSON.stringify({ p_thumbnail_id: "not-a-uuid", p_tag_ids: [] }),
    JSON.stringify({ p_thumbnail_id: COVER, p_collection_ids: "all" }),
    JSON.stringify({ p_thumbnail_id: COVER, p_collection_ids: [C1, "nope"] }),
    JSON.stringify({ p_thumbnail_id: COVER, p_collection_ids: [null] }),
    JSON.stringify({ p_thumbnail_id: COVER, p_collection_ids: [{ id: C1 }] }),
    JSON.stringify({ p_thumbnail_id: COVER, p_collection_ids: Array(51).fill(C1) }),
    JSON.stringify({ p_thumbnail_id: COVER, p_tag_ids: Array(101).fill(T1) }),
  ];
  for (const body of bad) {
    assert.throws(
      () => h.normalize(RPC_PATH, { method: "POST", body }),
      /Invalid Supabase body/,
      `тело прошло: ${body.slice(0, 60)}`,
    );
  }
  // Нестроковое тело тоже не проходит.
  assert.throws(() => h.normalize(RPC_PATH, { method: "POST", body: { p_thumbnail_id: COVER } }), /Invalid Supabase body/);
  assert.throws(() => h.normalize(RPC_PATH, { method: "POST" }), /Invalid Supabase body/);

  // Потолки — ровно на границе, а не «примерно».
  assert.doesNotThrow(() => h.normalize(RPC_PATH, {
    method: "POST",
    body: JSON.stringify({ p_thumbnail_id: COVER, p_collection_ids: Array(50).fill(C1), p_tag_ids: Array(100).fill(T1) }),
  }));
});

test("недопустимое тело не доходит до сети через message-proxy", async () => {
  const h = harness();
  const blocked = await h.send({
    type: "tv:sb-rest",
    path: RPC_PATH,
    opts: { method: "POST", body: JSON.stringify({ p_thumbnail_id: COVER, drop: "table" }) },
  });
  assert.deepEqual({ ok: blocked.ok, error: blocked.error }, { ok: false, error: "Invalid Supabase body" });
  assert.equal(h.calls.length, 0, "запрос ушёл в сеть до проверки тела");
});

// ------------------------------------------ 6. прежние границы на месте

test("host page по-прежнему не достаёт до tv:sb-rest", async () => {
  const h = harness();
  const blocked = await h.send({
    type: "tv:sb-rest",
    path: RPC_PATH,
    opts: { method: "POST", body: JSON.stringify({ p_thumbnail_id: COVER, p_tag_ids: [] }) },
  }, hostSender());
  assert.deepEqual({ ok: blocked.ok, error: blocked.error }, { ok: false, error: "Blocked sender" });
  assert.equal(h.calls.length, 0);
});

test("Prefer на rpc-маршрут не пробрасывается, на прежних — пробрасывается", () => {
  const h = harness();
  const rpc = h.normalize(RPC_PATH, {
    method: "POST",
    headers: { Prefer: "return=minimal" },
    body: JSON.stringify({ p_thumbnail_id: COVER, p_tag_ids: [] }),
  });
  assert.deepEqual(Object.keys(rpc.opts.headers), [], "return=minimal погасил бы подтверждение замены");

  const legacy = h.normalize("thumbnails?on_conflict=user_id,video_id", {
    method: "POST",
    headers: { Prefer: "resolution=merge-duplicates,return=representation" },
    body: "{}",
  });
  assert.equal(legacy.opts.headers.Prefer, "resolution=merge-duplicates,return=representation");
});

test("прежний allowlist не сдвинулся", () => {
  const h = harness();
  const allowed = [
    ["collections?select=id,name&order=name.asc", "GET"],
    ["collections", "POST"],
    ["tags", "POST"],
    ["thumbnails", "POST"],
    [`thumbnails?id=eq.${COVER}`, "DELETE"],
    ["channels?select=id&channel_id=eq.UCabcdefghijklmnopqrstuv&limit=1", "GET"],
    ["channels?on_conflict=user_id,channel_id", "POST"],
  ];
  for (const [path, method] of allowed) {
    assert.doesNotThrow(() => h.normalize(path, { method, body: "{}" }), `сломан прежний маршрут: ${method} ${path}`);
  }

  // Прямые junction-записи РАЗРЕШЕНЫ по-прежнему (R1 оставляет прямой путь, а
  // отзыв грантов — отдельное решение владельца); клиент их больше не делает.
  for (const path of ["thumbnail_collections", "thumbnail_tags"]) {
    assert.doesNotThrow(() => h.normalize(path, { method: "POST", body: "[]" }));
  }

  // PUT недостижим для всей поверхности. PATCH с PUB-02 разрешён РОВНО в одном
  // виде — заметка одной своей строки thumbnails по пришпиленному пути
  // (подробные границы: pub02-note-update.test.mjs); всё остальное по-прежнему
  // отказ, включая PATCH без пинов и PATCH на RPC-маршрут.
  for (const path of ["collections", "tags", "thumbnails", "channels", "thumbnail_tags", RPC_PATH]) {
    for (const method of ["PATCH", "PUT"]) {
      assert.throws(() => h.normalize(path, { method, body: "{}" }), /Supabase route not allowed/);
    }
  }
  assert.throws(() => h.normalize(`thumbnails?id=eq.${COVER}&select=id`, { method: "PUT", body: JSON.stringify({ note: "x" }) }), /Supabase route not allowed/);
  assert.doesNotThrow(() => h.normalize(`thumbnails?id=eq.${COVER}&select=id`, { method: "PATCH", body: JSON.stringify({ note: "x" }) }));
});

test("токен и тело не попадают в логи фонового скрипта", async () => {
  const h = harness();
  await h.API.replaceThumbnailLinks(COVER, { collectionIds: [C1] });
  assert.equal(h.logs.length, 0, "background обязан оставаться без console.*");
  assert.ok(!src.background.includes("console."));
});

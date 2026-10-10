// node --test: PUB-02 — изменение заметки существующей обложки правит ТУ ЖЕ
// строку, а не создаёт вторую.
//
// Стенд поведенческий: в vm исполняются настоящие background.js + intent.js +
// oauth.js (service worker) и настоящие intent.js + supabase.js + api.js +
// panel.js (страница панели). Подставлены только DOM, browser API и сеть.
// Проверяются наблюдаемые запросы и решения UI, а не текст реализации.
//
// Инварианты:
//   existing + изменённая заметка → один PATCH того же id, ни одного POST;
//   неизменённая заметка не порождает записи в thumbnails вообще;
//   отказ загрузки списка не превращается в очистку набора;
//   отказ/нулевой результат PATCH — не успех, панель не закрывается, INSERT нет;
//   частичный успех «строка создана, связи не легли» не плодит вторую строку;
//   PATCH на границе background пришпилен: один UUID, одно поле note, лимит.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

import { WITH_PRIVATE } from "./scope.mjs";
import { readFileSync } from "node:fs";
import { resolve as tvResolvePath } from "node:path";

const EXT_ID = "a".repeat(32);
const ACCESS_TOKEN = `access-${"x".repeat(40)}`;
const CONFIG = {
  SUPABASE_URL: "https://project.supabase.co",
  SUPABASE_ANON_KEY: "anon-key",
  AUTH_SITE_URL: "https://thumbsight.com",
};
const CONFIG_SRC = `self.THUMBVAULT_CONFIG = ${JSON.stringify(CONFIG)};`;
const REST = `${CONFIG.SUPABASE_URL}/rest/v1/`;

const PIN_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const YT_ID = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const OTHER_ID = "ffffffff-ffff-4fff-8fff-ffffffffffff";
const C1 = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const C2 = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const T1 = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

const PIN_IMG = "https://i.pinimg.com/originals/ab/cd/ef/abcdef.jpg";
const PIN_SRC = "https://www.pinterest.com/pin/1234567890/";
const YT_VIDEO = "dQw4w9WgXcQ";
const YT_IMG = `https://i.ytimg.com/vi/${YT_VIDEO}/maxresdefault.jpg`;
const YT_SRC = `https://www.youtube.com/watch?v=${YT_VIDEO}`;

const file = (name) => readFile(new URL(`../${name}`, import.meta.url), "utf8");
const src = {
  background: await file("background.js"),
  oauth: await file("oauth.js"),
  intent: await file("intent.js"),
  supabase: await file("supabase.js"),
  api: await file("api.js"),
  panel: await file("panel.js"),
};
// Сверка с миграциями — контракт БЭКЕНДА, а не расширения: она читает
// supabase/, которого в public-only экспорте нет. Копировать туда SQL ради
// прохождения импорта нельзя, поэтому проверка объявлена внутренней
// (см. tests/scope.mjs). Поведенческие проверки панели ниже от неё не зависят
// и в public-области выполняются полностью.
const SQL_RLS = WITH_PRIVATE
  ? await readFile(new URL("../../../supabase/migration-rls-column-pinning.sql", import.meta.url), "utf8")
  : null;
const SQL_NOTE = WITH_PRIVATE
  ? await readFile(new URL("../../../supabase/migration-thumbnail-note-limit.sql", import.meta.url), "utf8")
  : null;

// ------------------------------------------------------------ browser stubs

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

// Минимальный DOM: элементы создаются по требованию, поэтому список id не
// приходится поддерживать вручную. Кнопка с `disabled` не вызывает обработчик —
// именно так ведёт себя браузер, и на этом держится проверка двойного нажатия.
function makeElement(tag = "div") {
  const el = {
    tag,
    children: [],
    dataset: {},
    attrs: {},
    classes: new Set(),
    handlers: {},
    className: "",
    value: "",
    disabled: false,
    classList: {
      add: (...names) => { for (const name of names) el.classes.add(name); },
      remove: (...names) => { for (const name of names) el.classes.delete(name); },
      contains: (name) => el.classes.has(name),
      toggle: (name, force) => {
        const on = force === undefined ? !el.classes.has(name) : !!force;
        if (on) el.classes.add(name); else el.classes.delete(name);
        return on;
      },
    },
    setAttribute: (name, value) => { el.attrs[name] = String(value); },
    getAttribute: (name) => (name in el.attrs ? el.attrs[name] : null),
    hasAttribute: (name) => name in el.attrs,
    addEventListener: (type, fn) => { (el.handlers[type] ||= []).push(fn); },
    removeEventListener: () => {},
    append: (...nodes) => { el.children.push(...nodes); },
    remove: () => {},
    hidden: () => el.classes.has("tv-hidden"),
    fire: (type, event = {}) => {
      // Пользовательский click не доходит ни до `disabled`, ни до скрытого
      // элемента: `.tv-hidden { display: none !important }` (panel.css:251)
      // убирает его из потока и из hit-testing. Без этого запрета стенд
      // «нажимал» невидимую кнопку и выдавал недоступный повтор за рабочий (F1).
      if (type === "click" && (el.disabled || el.classes.has("tv-hidden"))) return;
      for (const fn of [...(el.handlers[type] || [])]) {
        fn({ type, isTrusted: true, target: el, preventDefault() {}, stopPropagation() {}, ...event });
      }
    },
  };
  // В настоящем DOM присваивание textContent заменяет ВСЕХ детей текстовым
  // узлом; `wrap.textContent = ""` в tvRenderChoices именно так и очищает
  // список. Без этого дети копились и состояние выбора было не сосчитать.
  let text = "";
  Object.defineProperty(el, "textContent", {
    get: () => text,
    set: (value) => { text = String(value); el.children.length = 0; },
  });
  return el;
}

function makeDocument() {
  const byId = new Map();
  const handlers = {};
  return {
    byId,
    getElementById(id) {
      if (!byId.has(id)) byId.set(id, makeElement("div"));
      return byId.get(id);
    },
    createElement: (tag) => makeElement(tag),
    addEventListener(type, fn) { (handlers[type] ||= []).push(fn); },
    dispatchEvent(event) {
      for (const fn of [...(handlers[event.type] || [])]) fn(event);
      return true;
    },
    documentElement: { setAttribute() {} },
    querySelector: () => null,
    querySelectorAll: () => [],
  };
}

// --------------------------------------------------------------- синтетический сервер

// `rows` — состояние синтетической базы. Ответы даёт функция от разобранного
// запроса, поэтому каждый тест переопределяет только нужную ветку.
function makeServer(state) {
  const calls = [];
  const rows = state.rows;
  const handle = (call) => {
    const path = call.url.slice(REST.length);
    const table = path.split("?")[0];
    const body = call.body ? JSON.parse(call.body) : null;

    if (state.override) {
      const forced = state.override({ path, table, method: call.method, body });
      if (forced) return forced;
    }
    if (table === "collections" && call.method === "GET") {
      return { status: 200, text: JSON.stringify([{ id: C1, name: "Refs" }, { id: C2, name: "Ideas" }]) };
    }
    if (table === "tags" && call.method === "GET") {
      return { status: 200, text: JSON.stringify([{ id: T1, name: "bold" }]) };
    }
    if (table === "thumbnails" && call.method === "GET") {
      const found = rows.find((row) => (
        path.includes(`img_url=eq.${encodeURIComponent(row.img_url || "")}`)
        || (row.video_id && path.includes(`video_id=eq.${encodeURIComponent(row.video_id)}`))
      ));
      if (!found) return { status: 200, text: "[]" };
      return {
        status: 200,
        text: JSON.stringify([{
          id: found.id,
          note: found.note,
          thumbnail_collections: (found.collectionIds || []).map((collection_id) => ({ collection_id })),
          thumbnail_tags: (found.tagIds || []).map((tag_id) => ({ tag_id })),
        }]),
      };
    }
    if (table === "thumbnails" && call.method === "POST") {
      const created = {
        id: state.newId || PIN_ID,
        note: body.note,
        img_url: body.img_url,
        video_id: body.video_id || null,
        collectionIds: [],
        tagIds: [],
      };
      rows.push(created);
      return { status: 201, text: JSON.stringify([{ id: created.id }]) };
    }
    if (table === "thumbnails" && call.method === "PATCH") {
      // RLS `own thumbnails update` фильтрует чужие строки через USING: чужой id
      // даёт НОЛЬ строк, а не ошибку. Здесь это моделируется составом `rows`.
      const id = /id=eq\.([0-9a-fA-F-]{36})/.exec(path)?.[1];
      const row = rows.find((item) => item.id === id);
      if (!row) return { status: 200, text: "[]" };
      row.note = body.note;
      return { status: 200, text: JSON.stringify([{ id: row.id }]) };
    }
    if (table === "rpc/replace_thumbnail_links" && call.method === "POST") {
      const row = rows.find((item) => item.id === body.p_thumbnail_id);
      if (!row) return { status: 404, text: JSON.stringify({ code: "JO001" }) };
      if (body.p_collection_ids !== null) row.collectionIds = body.p_collection_ids;
      if (body.p_tag_ids !== null) row.tagIds = body.p_tag_ids;
      return {
        status: 200,
        text: JSON.stringify({
          thumbnail_id: body.p_thumbnail_id,
          collections: body.p_collection_ids === null ? null : body.p_collection_ids.length,
          tags: body.p_tag_ids === null ? null : body.p_tag_ids.length,
        }),
      };
    }
    return { status: 400, text: JSON.stringify({ code: "PGRSTx", message: `unexpected ${call.method} ${path}` }) };
  };
  return { calls, handle };
}

// ------------------------------------------------------------------- стенд

async function panelStand({ mode, rows = [], override = null, newId = null } = {}) {
  const state = { rows, override, newId };
  const server = makeServer(state);
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
    console: { log() {}, info() {}, warn() {}, error() {}, debug() {} },
    fetch: async (url, options) => {
      const call = {
        url: String(url),
        method: String(options?.method || "GET").toUpperCase(),
        headers: options?.headers || {},
        body: options?.body ?? null,
      };
      server.calls.push(call);
      if (!call.url.startsWith(REST)) throw new Error(`unexpected fetch host: ${call.url}`);
      const { status, text } = server.handle(call);
      return new Response(status === 204 ? null : text, { status, headers: { "Content-Type": "application/json" } });
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

  const send = (message, sender) => new Promise((resolve) => {
    const async_ = listener(message, sender, resolve);
    if (async_ !== true) resolve(undefined);
  });

  // Настоящая последовательность: trusted click на host-странице чеканит
  // capability, панель extension-origin его забирает.
  const hostUrl = mode === "pinterest" ? PIN_SRC : YT_SRC;
  const intent = mode === "pinterest"
    ? { mode: "pinterest", imageUrl: PIN_IMG, sourceUrl: PIN_SRC }
    : { mode: "youtube", videoId: YT_VIDEO, imageUrl: YT_IMG, sourceUrl: YT_SRC };
  const minted = await send({ type: "tv:open-intent", intent }, { id: EXT_ID, url: hostUrl, tab: { id: 7 } });
  assert.equal(minted?.ok, true, `intent не выдан: ${minted?.error}`);

  const doc = makeDocument();
  const closes = [];
  const panelSender = { id: EXT_ID, url: `chrome-extension://${EXT_ID}/panel.html`, tab: { id: 7 } };
  const page = {
    document: doc,
    location: { href: `chrome-extension://${EXT_ID}/panel.html?intent=${minted.nonce}` },
    history: { replaceState() {} },
    navigator: { userActivation: { isActive: true } },
    parent: { postMessage: (message) => closes.push(message) },
    chrome: {
      runtime: {
        id: EXT_ID,
        lastError: null,
        sendMessage: (message, callback) => { void send(message, panelSender).then(callback); },
      },
    },
    TVI18N: { ready: Promise.resolve("en"), apply() {}, t: (key) => key, lang: "en" },
    CustomEvent: class CustomEvent { constructor(type, init) { this.type = type; this.detail = init?.detail; } },
    console: { log() {}, info() {}, warn() {}, error() {}, debug() {} },
    URL,
    URLSearchParams,
    setTimeout,
    clearTimeout,
    Promise,
  };
  page.window = page;
  page.self = page;
  page.globalThis = page;
  vm.createContext(page);
  vm.runInContext(src.intent, page, { filename: "public/intent.js" });
  vm.runInContext(src.supabase, page, { filename: "public/supabase.js" });
  vm.runInContext(src.api, page, { filename: "public/api.js" });
  vm.runInContext(src.panel, page, { filename: "public/panel.js" });

  const $ = (id) => doc.getElementById(id);
  const stand = {
    calls: server.calls,
    rows,
    state,
    closes,
    $,
    send,
    normalize: (path, opts) => sw.tvNormalizeRestRequest(path, opts),
    API: page.API,
    writes: () => server.calls.filter((call) => call.method !== "GET"),
    of: (method, table) => server.calls.filter((call) => (
      call.method === method && call.url.slice(REST.length).startsWith(table)
    )),
    setNote(text) {
      $("tv-note-input").value = text;
      $("tv-note-input").fire("input");
    },
    toggleChoice(wrapId, name) {
      const wrap = $(wrapId);
      const choice = wrap.children.find((child) => (
        child.children.some((span) => span.textContent === name)
      ));
      assert.ok(choice, `в ${wrapId} нет варианта ${name}`);
      choice.fire("click");
    },
    save(event = {}) { $("tv-save").fire("click", event); },
    finish: () => $("tv-finish-title").textContent,
    async settle(rounds = 80) {
      for (let i = 0; i < rounds; i++) await new Promise((resolve) => setImmediate(resolve));
    },
  };

  // Панель поднимается сама. Признак готовности — зарегистрированный обработчик
  // Save (последняя строка `tvRenderSave`), а не `disabled === false`: у пустого
  // элемента это значение и так по умолчанию.
  const ready = () => ($("tv-save").handlers.click || []).length > 0 || stand.finish() !== "";
  for (let i = 0; i < 400 && !ready(); i++) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.ok(($("tv-save").handlers.click || []).length > 0, `панель не поднялась: ${stand.finish()}`);
  assert.equal($("tv-save").disabled, false);
  return stand;
}

const existingPin = (overrides = {}) => ({
  id: PIN_ID,
  img_url: PIN_IMG,
  video_id: null,
  note: "старая заметка",
  collectionIds: [C1],
  tagIds: [T1],
  ...overrides,
});

// Сообщение приходит из vm-realm: сверяем содержимое, а не прототип.
const closed = (stand) => stand.closes.map((message) => message.type);

// После ошибки сохранения панель обязана остаться рабочей: ошибка видима и
// помечена как ошибка, Save виден и доступен, редактор жив, ввод сохранён.
// Иначе «повтор» существует только в closure и пользователю недоступен (F1).
function assertRetryAvailable(stand, { note, label }) {
  assert.equal(stand.$("tv-save").hidden(), false, `${label}: Save скрыт — повтор недоступен`);
  assert.equal(stand.$("tv-save").disabled, false, `${label}: Save заблокирован`);
  assert.equal(stand.$("tv-editor").hidden(), false, `${label}: редактор скрыт`);
  assert.equal(stand.$("tv-note-input").value, note, `${label}: введённая заметка потеряна`);
  const error = stand.$("tv-note");
  assert.equal(error.hidden(), false, `${label}: ошибка не показана`);
  assert.equal(error.classes.has("tv-err"), true, `${label}: ошибка не помечена как ошибка`);
  assert.match(error.textContent, /saveFailedTitle/, `${label}: текст ошибки не про отказ сохранения`);
  assert.equal(stand.finish(), "", `${label}: показан финальный экран вместо рабочей панели`);
}
const notePatches = (stand) => stand.calls.filter((call) => call.method === "PATCH");
const thumbPosts = (stand) => stand.of("POST", "thumbnails");
const rpcPosts = (stand) => stand.of("POST", "rpc/replace_thumbnail_links");

// ============================================ 1. основной дефект PUB-02

test("Pinterest existing: изменена только заметка — один PATCH того же id, ни одного INSERT", async () => {
  const stand = await panelStand({ mode: "pinterest", rows: [existingPin()] });
  stand.setNote("новая заметка");
  stand.save();
  await stand.settle();

  assert.deepEqual(thumbPosts(stand).map((call) => call.url), [], "создана вторая строка Pinterest");
  assert.equal(notePatches(stand).length, 1);
  const patch = notePatches(stand)[0];
  assert.equal(patch.url, `${REST}thumbnails?id=eq.${PIN_ID}&select=id`);
  assert.deepEqual(JSON.parse(patch.body), { note: "новая заметка" }, "в теле PATCH должно быть ровно note");
  // Наборы не менялись → RPC не вызывается, папка и тег остаются на том же id.
  assert.equal(rpcPosts(stand).length, 0);
  assert.deepEqual(stand.rows.length, 1);
  assert.deepEqual(
    { note: stand.rows[0].note, collectionIds: stand.rows[0].collectionIds, tagIds: stand.rows[0].tagIds },
    { note: "новая заметка", collectionIds: [C1], tagIds: [T1] },
  );
  assert.deepEqual(closed(stand), ["tv:panel-close"], "успех обязан закрыть панель");
});

test("Pinterest existing: заметка вместе с папками правит связи ТОГО ЖЕ id", async () => {
  const stand = await panelStand({ mode: "pinterest", rows: [existingPin()] });
  stand.setNote("другая заметка");
  stand.toggleChoice("tv-collections", "Ideas");
  stand.save();
  await stand.settle();

  assert.deepEqual(thumbPosts(stand).map((call) => call.url), []);
  assert.equal(notePatches(stand).length, 1);
  assert.equal(rpcPosts(stand).length, 1);
  assert.deepEqual(JSON.parse(rpcPosts(stand)[0].body), {
    p_thumbnail_id: PIN_ID,
    p_collection_ids: [C1, C2],
    p_tag_ids: null,
  }, "нетронутый набор тегов обязан остаться null");
  assert.deepEqual(stand.rows[0].tagIds, [T1]);
  assert.deepEqual(closed(stand), ["tv:panel-close"]);
});

test("YouTube existing: изменённая заметка тоже правит существующую строку, без POST", async () => {
  const rows = [{ id: YT_ID, img_url: YT_IMG, video_id: YT_VIDEO, note: "было", collectionIds: [], tagIds: [] }];
  const stand = await panelStand({ mode: "youtube", rows });
  stand.setNote("стало");
  stand.save();
  await stand.settle();

  assert.deepEqual(thumbPosts(stand).map((call) => call.url), [], "upsert остаётся путём СОЗДАНИЯ, не обновления");
  assert.equal(notePatches(stand)[0].url, `${REST}thumbnails?id=eq.${YT_ID}&select=id`);
  assert.equal(rows[0].note, "стало");
  assert.deepEqual(closed(stand), ["tv:panel-close"]);
});

// ===================================== 2. отказ загрузки списка ≠ очистка

test("отказ загрузки папок не очищает неизвестный набор", async () => {
  const stand = await panelStand({
    mode: "pinterest",
    rows: [existingPin()],
    override: ({ table, method }) => (
      table === "collections" && method === "GET"
        ? { status: 500, text: JSON.stringify({ message: "boom" }) }
        : null
    ),
  });
  stand.setNote("заметка после отказа списка");
  stand.save();
  await stand.settle();

  assert.equal(notePatches(stand).length, 1, "заметка обязана сохраниться");
  for (const call of rpcPosts(stand)) {
    assert.notDeepEqual(JSON.parse(call.body).p_collection_ids, [], "неизвестный набор ушёл на очистку");
  }
  assert.deepEqual(stand.rows[0].collectionIds, [C1], "папка исчезла из-за отказа GET");
  assert.deepEqual(closed(stand), ["tv:panel-close"]);
});

// ========================================= 3. legacy note > 1000 символов

test("неизменённая legacy-заметка >1000 не обрезается и не уходит в PATCH", async () => {
  const legacy = "л".repeat(1200);
  const stand = await panelStand({ mode: "pinterest", rows: [existingPin({ note: legacy })] });
  assert.equal(stand.$("tv-note-input").value, legacy, "панель обязана показать заметку целиком");
  stand.toggleChoice("tv-tags", "bold");   // меняем только теги
  stand.save();
  await stand.settle();

  assert.deepEqual(notePatches(stand), [], "строка thumbnails не должна трогаться вовсе");
  assert.deepEqual(thumbPosts(stand).map((call) => call.url), []);
  assert.equal(rpcPosts(stand).length, 1);
  assert.equal(stand.rows[0].note, legacy, "legacy-заметка усечена");
  assert.deepEqual(closed(stand), ["tv:panel-close"]);
});

test("новое изменение заметки соблюдает лимит и не усекается молча", async () => {
  const stand = await panelStand({ mode: "pinterest", rows: [existingPin({ note: "л".repeat(1200) })] });
  stand.setNote("н".repeat(1001));
  stand.save();
  await stand.settle();

  assert.deepEqual(stand.writes(), [], "запись ушла в сеть при заметке сверх лимита");
  assert.equal(stand.$("tv-note").textContent, "noteTooLong");
  assert.equal(stand.$("tv-save").disabled, false, "после отказа кнопка обязана вернуться");
  assert.deepEqual(stand.closes, []);

  // И на уровне API: усечения нет, есть отказ до сети.
  const before = stand.calls.length;
  await assert.rejects(() => stand.API.updateThumbnailNote(PIN_ID, "н".repeat(1001)), /Note too long/);
  assert.equal(stand.calls.length, before, "оверсайз дошёл до сети");
});

// =========================================== 4. границы PATCH и sender

test("PATCH заметки пришпилен: один UUID, один select, ни одного лишнего фильтра", async () => {
  const stand = await panelStand({ mode: "pinterest", rows: [existingPin()] });
  const body = JSON.stringify({ note: "ok" });

  assert.doesNotThrow(() => stand.normalize(`thumbnails?id=eq.${PIN_ID}&select=id`, { method: "PATCH", body }));

  for (const path of [
    "thumbnails",
    "thumbnails?select=id",
    `thumbnails?id=eq.${PIN_ID}`,
    `thumbnails?id=eq.${PIN_ID}&select=*`,
    `thumbnails?id=eq.${PIN_ID}&select=id&user_id=eq.user-1`,
    `thumbnails?user_id=eq.user-1&select=id`,
    `thumbnails?id=neq.${PIN_ID}&select=id`,
    `thumbnails?id=in.(${PIN_ID})&select=id`,
    "thumbnails?id=eq.not-a-uuid&select=id",
    `thumbnails?id=eq.${PIN_ID}&select=id&limit=1`,
    `thumbnails?id=eq.${PIN_ID.slice(0, 35)}&select=id`,
  ]) {
    assert.throws(
      () => stand.normalize(path, { method: "PATCH", body }),
      /Supabase route not allowed/,
      `PATCH открылся: ${path}`,
    );
  }

  // Остальные таблицы PATCH не получили, PUT не получил никто.
  for (const table of ["collections", "tags", "channels", "thumbnail_collections", "thumbnail_tags", "rpc/replace_thumbnail_links"]) {
    assert.throws(() => stand.normalize(table, { method: "PATCH", body }), /Supabase route not allowed/);
  }
  for (const table of ["collections", "tags", "thumbnails", "channels", "rpc/replace_thumbnail_links"]) {
    assert.throws(() => stand.normalize(table, { method: "PUT", body }), /Supabase route not allowed/);
  }
});

test("тело PATCH собирается заново и содержит ровно note", async () => {
  const stand = await panelStand({ mode: "pinterest", rows: [existingPin()] });
  const path = `thumbnails?id=eq.${PIN_ID}&select=id`;

  const clean = stand.normalize(path, {
    method: "PATCH",
    headers: { Prefer: "return=minimal", "X-Sneaky": "1" },
    body: JSON.stringify({ note: "текст" }),
  });
  assert.equal(clean.opts.body, JSON.stringify({ note: "текст" }));
  assert.deepEqual(JSON.parse(JSON.stringify(clean.opts.headers)), { Prefer: "return=representation" },
    "чужой Prefer не пробрасывается: ответ нужен для подтверждения замены");

  for (const bad of [
    "{",
    "null",
    '"note"',
    "[]",
    JSON.stringify({}),
    JSON.stringify({ note: "ok", user_id: "user-1" }),
    JSON.stringify({ note: "ok", added_at: "2020-01-01" }),
    JSON.stringify({ note: "ok", views_at: null }),
    JSON.stringify({ user_id: "user-1" }),
    JSON.stringify({ note: null }),
    JSON.stringify({ note: 5 }),
    JSON.stringify({ note: ["ok"] }),
    JSON.stringify({ note: "н".repeat(1001) }),
  ]) {
    assert.throws(
      () => stand.normalize(path, { method: "PATCH", body: bad }),
      /Invalid Supabase body/,
      `тело прошло: ${bad.slice(0, 50)}`,
    );
  }
  assert.throws(() => stand.normalize(path, { method: "PATCH" }), /Invalid Supabase body/);
  assert.throws(() => stand.normalize(path, { method: "PATCH", body: { note: "ok" } }), /Invalid Supabase body/);
  // Ровно на границе лимита тело проходит.
  assert.doesNotThrow(() => stand.normalize(path, { method: "PATCH", body: JSON.stringify({ note: "н".repeat(1000) }) }));
});

test("host page не достаёт до PATCH, и запрос не уходит в сеть", async () => {
  const stand = await panelStand({ mode: "pinterest", rows: [existingPin()] });
  const before = stand.calls.length;
  const blocked = await stand.send({
    type: "tv:sb-rest",
    path: `thumbnails?id=eq.${PIN_ID}&select=id`,
    opts: { method: "PATCH", body: JSON.stringify({ note: "чужими руками" }) },
  }, { id: EXT_ID, url: PIN_SRC, tab: { id: 7 } });

  assert.deepEqual({ ok: blocked.ok, error: blocked.error }, { ok: false, error: "Blocked sender" });
  assert.equal(stand.calls.length, before, "запрос ушёл в сеть от host sender");
  assert.equal(stand.rows[0].note, "старая заметка");
});

test("невалидный UUID и несуществующий id не превращаются в запись", async () => {
  const stand = await panelStand({ mode: "pinterest", rows: [existingPin()] });
  const before = stand.calls.length;
  for (const id of ["", "not-a-uuid", `${PIN_ID} `, `${PIN_ID}'`, "00000000-0000-0000-0000-00000000000"]) {
    await assert.rejects(() => stand.API.updateThumbnailNote(id, "x"), /Invalid thumbnail id/, `id прошёл: ${id}`);
  }
  assert.equal(stand.calls.length, before, "невалидный id дошёл до сети");
});

test("синтетический click со страницы не запускает ни одной записи", async () => {
  const stand = await panelStand({ mode: "pinterest", rows: [existingPin()] });
  stand.setNote("подделка");
  stand.save({ isTrusted: false });
  await stand.settle();

  assert.deepEqual(stand.writes(), []);
  assert.deepEqual(stand.closes, []);
  assert.equal(stand.rows[0].note, "старая заметка");
});

// ========================= 4b. серверная граница владения (отдельно от mocks)

test("чужой id: ноль строк — это отказ, а не успех и не запасной INSERT", async () => {
  // Синтетический сервер повторяет НАБЛЮДАЕМОЕ следствие RLS `own thumbnails
  // update`: строка чужого владельца не попадает под USING, PostgREST отдаёт
  // 200 и пустой массив. Это модель следствия, а не доказательство enforcement.
  const stand = await panelStand({
    mode: "pinterest",
    rows: [existingPin()],
    override: ({ table, method }) => (
      table === "thumbnails" && method === "PATCH" ? { status: 200, text: "[]" } : null
    ),
  });
  stand.setNote("правка чужой строки");
  stand.save();
  await stand.settle();

  assert.equal(notePatches(stand).length, 1);
  assert.deepEqual(thumbPosts(stand).map((call) => call.url), [], "после отказа PATCH появился INSERT");
  assert.equal(rpcPosts(stand).length, 0, "связи не должны трогаться после неподтверждённой заметки");
  assert.deepEqual(stand.closes, [], "панель закрылась как при успехе");
  assertRetryAvailable(stand, { note: "правка чужой строки", label: "чужой id" });
});

test("enforcement владения живёт в SQL, а не в клиенте", { skip: WITH_PRIVATE ? false : "область public: supabase/ вне экспорта" }, () => {
  // Адресная сверка с локальными миграциями: клиент не является источником
  // права на запись. Живая БД в этом пакете не использовалась.
  assert.match(SQL_RLS, /create policy "own thumbnails update" on public\.thumbnails for update/);
  assert.match(SQL_RLS, /using \(auth\.uid\(\) = user_id\)/);
  assert.match(SQL_RLS, /added_at = \(select t\.added_at from public\.thumbnails t where t\.id = thumbnails\.id\)/);
  assert.match(SQL_NOTE, /add constraint thumbnails_note_max_1000/);
  assert.match(SQL_NOTE, /check \(char_length\(coalesce\(note, ''\)\) <= 1000\)/);
  // NOT VALID пропускает только проверку старых строк: новые и ОБНОВЛЯЕМЫЕ
  // строки CHECK по-прежнему проверяет — поэтому неизменённую legacy-заметку
  // нельзя отправлять в PATCH.
  assert.match(SQL_NOTE, /not valid/);
});

// ============================ 5. отказ PATCH не успех, повтор не конкурентен

test("отказ PATCH: панель не закрывается, INSERT не появляется, повтор доступен", async () => {
  const stand = await panelStand({
    mode: "pinterest",
    rows: [existingPin()],
    override: ({ table, method }) => (
      table === "thumbnails" && method === "PATCH"
        ? { status: 403, text: JSON.stringify({ code: "42501" }) }
        : null
    ),
  });
  stand.setNote("отказ сервера");
  stand.save();
  await stand.settle();

  assert.equal(notePatches(stand).length, 1);
  assert.deepEqual(thumbPosts(stand).map((call) => call.url), []);
  assert.deepEqual(stand.closes, []);
  assert.equal(stand.rows[0].note, "старая заметка");
  assertRetryAvailable(stand, { note: "отказ сервера", label: "отказ PATCH" });
});

test("повторное нажатие во время записи не запускает вторую", async () => {
  const stand = await panelStand({ mode: "pinterest", rows: [existingPin()] });
  stand.setNote("однажды");
  stand.save();
  stand.save();   // кнопка уже disabled — браузер обработчик не позовёт
  stand.save();
  await stand.settle();

  assert.equal(notePatches(stand).length, 1, "конкурентная запись");
  assert.deepEqual(closed(stand), ["tv:panel-close"]);
});

// ======================= 6. частичный успех: строка есть, связи не легли

test("создана строка, связи упали — повтор правит тот же id, второй Pinterest-строки нет", async () => {
  let failLinks = true;
  const stand = await panelStand({
    mode: "pinterest",
    rows: [],
    override: ({ table, method }) => (
      failLinks && table === "rpc/replace_thumbnail_links" && method === "POST"
        ? { status: 500, text: JSON.stringify({ code: "XX000" }) }
        : null
    ),
  });
  stand.setNote("первая попытка");
  stand.toggleChoice("tv-collections", "Refs");
  stand.save();
  await stand.settle();

  assert.equal(thumbPosts(stand).length, 1, "строка обязана создаться один раз");
  assert.equal(rpcPosts(stand).length, 1);
  assert.deepEqual(stand.closes, [], "частичный успех не закрывает панель");
  assert.equal(stand.rows.length, 1);
  assert.deepEqual(stand.rows[0].collectionIds, [], "связи не легли — состояние не должно врать");
  assertRetryAvailable(stand, { note: "первая попытка", label: "создание + отказ связей" });

  // Повтор ТЕМ ЖЕ пользовательским нажатием видимой кнопки: заметка уже
  // сохранена вместе со строкой, повторять её нечего.
  failLinks = false;
  stand.save();
  await stand.settle();

  assert.equal(thumbPosts(stand).length, 1, "повтор вставил вторую Pinterest-строку");
  assert.deepEqual(notePatches(stand), [], "заметка уже в созданной строке, PATCH не нужен");
  assert.equal(rpcPosts(stand).length, 2);
  assert.deepEqual(JSON.parse(rpcPosts(stand)[1].body).p_thumbnail_id, stand.rows[0].id);
  assert.deepEqual(stand.rows[0].collectionIds, [C1]);
  assert.deepEqual(closed(stand), ["tv:panel-close"]);
});

test("подтверждённая заметка не пересылается, неподтверждённые связи — пересылаются", async () => {
  // Порядок операций: сначала заметка, потом связи. Поэтому наблюдаемый
  // частичный успех для existing-строки — «заметка легла, связи нет».
  let failLinks = true;
  const stand = await panelStand({
    mode: "pinterest",
    rows: [existingPin()],
    override: ({ table, method }) => (
      failLinks && table === "rpc/replace_thumbnail_links" && method === "POST"
        ? { status: 500, text: JSON.stringify({ code: "XX000" }) }
        : null
    ),
  });
  stand.setNote("заметка легла");
  stand.toggleChoice("tv-collections", "Ideas");
  stand.save();
  await stand.settle();

  assert.equal(notePatches(stand).length, 1);
  assert.equal(rpcPosts(stand).length, 1);
  assert.equal(stand.rows[0].note, "заметка легла", "заметка обязана быть уже сохранена");
  assert.deepEqual(stand.rows[0].collectionIds, [C1], "связи не легли");
  assert.deepEqual(closed(stand), [], "частичный успех не закрывает панель");
  assertRetryAvailable(stand, { note: "заметка легла", label: "PATCH + отказ связей" });
  assert.equal(stand.$("tv-collections").children.filter((choice) => choice.className.endsWith(" on")).length, 2,
    "выбранные наборы обязаны пережить ошибку");

  // Повтор ТЕМ ЖЕ пользовательским нажатием: заметка подтверждена — второй раз
  // не уходит; связи не подтверждены — уходят снова, и тем же id.
  failLinks = false;
  stand.save();
  await stand.settle();

  assert.equal(notePatches(stand).length, 1, "подтверждённая заметка ушла повторно");
  assert.deepEqual(thumbPosts(stand).map((call) => call.url), [], "повтор не имеет права создавать строку");
  assert.equal(rpcPosts(stand).length, 2);
  assert.deepEqual(JSON.parse(rpcPosts(stand)[1].body), {
    p_thumbnail_id: PIN_ID,
    p_collection_ids: [C1, C2],
    p_tag_ids: null,
  });
  assert.deepEqual(stand.rows[0].collectionIds, [C1, C2]);
  assert.deepEqual(closed(stand), ["tv:panel-close"]);
});

// =============================== 7. штатные пути сохранения не сломаны

test("новая Pinterest-обложка создаётся POST и получает связи", async () => {
  const stand = await panelStand({ mode: "pinterest", rows: [] });
  stand.setNote("свежая");
  stand.toggleChoice("tv-collections", "Refs");
  stand.toggleChoice("tv-tags", "bold");
  stand.save();
  await stand.settle();

  assert.equal(thumbPosts(stand).length, 1);
  assert.equal(thumbPosts(stand)[0].url, `${REST}thumbnails`);
  const body = JSON.parse(thumbPosts(stand)[0].body);
  assert.deepEqual(
    { img_url: body.img_url, source_url: body.source_url, note: body.note, video_id: body.video_id },
    { img_url: PIN_IMG, source_url: PIN_SRC, note: "свежая", video_id: undefined },
  );
  assert.deepEqual(notePatches(stand), [], "новая строка не нуждается в PATCH");
  assert.deepEqual(JSON.parse(rpcPosts(stand)[0].body), {
    p_thumbnail_id: PIN_ID,
    p_collection_ids: [C1],
    p_tag_ids: [T1],
  });
  assert.deepEqual(closed(stand), ["tv:panel-close"]);
});

test("новая YouTube-обложка по-прежнему уходит upsert'ом по (user_id, video_id)", async () => {
  const stand = await panelStand({ mode: "youtube", rows: [], newId: YT_ID });
  stand.setNote("ютуб");
  stand.save();
  await stand.settle();

  assert.equal(thumbPosts(stand).length, 1);
  assert.equal(thumbPosts(stand)[0].url, `${REST}thumbnails?on_conflict=user_id,video_id`);
  assert.equal(thumbPosts(stand)[0].headers.Prefer, "resolution=merge-duplicates,return=representation");
  assert.equal(JSON.parse(thumbPosts(stand)[0].body).video_id, YT_VIDEO);
  assert.deepEqual(notePatches(stand), []);
  assert.deepEqual(closed(stand), ["tv:panel-close"]);
});

test("повторное сохранение без изменений не пишет вообще ничего", async () => {
  const stand = await panelStand({ mode: "pinterest", rows: [existingPin()] });
  stand.save();
  await stand.settle();

  assert.deepEqual(stand.writes(), [], "сохранение без изменений обязано быть пустым");
  assert.deepEqual(closed(stand), ["tv:panel-close"]);
});

test("удаление и Follow не затронуты новым путём", async () => {
  const stand = await panelStand({ mode: "pinterest", rows: [existingPin()] });
  stand.$("tv-delete").fire("click");
  stand.$("tv-confirm-delete").fire("click");
  await stand.settle();

  const deletes = stand.calls.filter((call) => call.method === "DELETE");
  assert.equal(deletes.length, 1);
  assert.equal(deletes[0].url, `${REST}thumbnails?id=eq.${PIN_ID}`);
  assert.deepEqual(notePatches(stand), []);
});

// EXT-OPT-01 #42: протяжка выделения из поля за край карточки. Chromium шлёт
// click общему предку — подложке; закрывать можно, только если и нажатие
// началось на ней. Стенд событий не всплывает, поэтому pointerdown подаётся
// прямо на подложку с target из поля, как его увидел бы её слушатель.
test("подложка: нажатие в поле и отпускание на подложке не закрывает панель", async () => {
  const stand = await panelStand({ mode: "pinterest", rows: [existingPin()] });
  stand.setNote("несохранённая");
  stand.$("tv-overlay").fire("pointerdown", { target: stand.$("tv-note-input") });
  stand.$("tv-overlay").fire("click");
  assert.deepEqual(closed(stand), [], "протяжка выделения закрыла панель");
  assert.equal(stand.$("tv-note-input").value, "несохранённая");

  // Контроль: нажатие и отпускание на самой подложке закрывают ровно один раз.
  stand.$("tv-overlay").fire("pointerdown");
  stand.$("tv-overlay").fire("click");
  assert.deepEqual(closed(stand), ["tv:panel-close"]);
});

test("подложка подтверждения удаления: та же защита от протяжки", async () => {
  const stand = await panelStand({ mode: "pinterest", rows: [existingPin()] });
  stand.$("tv-delete").fire("click");
  assert.equal(stand.$("tv-confirm").hidden(), false);
  stand.$("tv-confirm").fire("pointerdown", { target: stand.$("tv-confirm-title") });
  stand.$("tv-confirm").fire("click");
  assert.equal(stand.$("tv-confirm").hidden(), false, "протяжка закрыла подтверждение");
  stand.$("tv-confirm").fire("pointerdown");
  stand.$("tv-confirm").fire("click");
  assert.equal(stand.$("tv-confirm").hidden(), true);
  assert.deepEqual(closed(stand), [], "закрытие подтверждения не закрывает панель");
});


// Сторож PUB-04 (10.10): у карточки .tv-modal нет анимации появления. Пока карточка
// анимируется (opacity/transform), Chromium держит её с тенью отдельным композитным слоем,
// и на реальном экране вокруг панели проступает прямоугольник слоя (с fill-mode both —
// навсегда, с backwards — на время анимации); CDP-снимки стендов этого не видят, поэтому
// регрессию ловит только эта статическая проверка.
// EXT-OPT-01 #46: та же логика для карточки подтверждения удаления — тень 80px над
// blur-подложкой.
test("panel.css: карточки .tv-modal и .tv-confirm-card без анимации появления (шов слоя на реальном экране)", () => {
  const css = readFileSync(tvResolvePath(import.meta.dirname, "..", "panel.css"), "utf8");
  for (const card of ["tv-modal", "tv-confirm-card"]) {
    const block = css.match(new RegExp(`[.]${card}[ ]*[{][^}]*[}]`))?.[0] ?? "";
    assert.ok(block.length > 0, `блок .${card} не найден`);
    assert.doesNotMatch(block, /animation[-a-z]*:/, `.${card}: анимация`);
    assert.doesNotMatch(block, /transition[-a-z]*:[^;]*(opacity|transform)/, `.${card}: transition`);
  }
});

test("panel.css: нет @keyframes без ссылок на них", () => {
  const css = readFileSync(tvResolvePath(import.meta.dirname, "..", "panel.css"), "utf8")
    .replace(/[/][*][\s\S]*?[*][/]/g, "");
  for (const [, name] of css.matchAll(/@keyframes\s+([-\w]+)/g)) {
    const uses = css.match(new RegExp(`animation(?:-name)?\\s*:[^;}]*\\b${name}\\b`, "g")) || [];
    assert.ok(uses.length > 0, `@keyframes ${name} нигде не используется`);
  }
});

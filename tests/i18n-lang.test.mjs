// node --test: язык публичного расширения при закрытом storage.
//
// Проверяем инварианты, а не формулировки:
//   content script НЕ трогает `chrome.storage.local` — он закрыт TRUSTED_CONTEXTS;
//   отказ storage/messaging даёт английский fallback, а не отказ TVI18N.ready;
//   ни один путь не оставляет необработанного Promise rejection;
//   background отдаёт ровно один валидированный код en/es/ru и ничего больше;
//   сессия и Supabase-маршруты для host-страницы по-прежнему закрыты;
//   словарь T и обращения к нему в runtime-файлах совпадают в обе стороны.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { RUNTIME } from "../tools/runtime-files.mjs";

const EXT_ID = "a".repeat(32);
const YT_URL = "https://www.youtube.com/watch?v=dQw4w9WgXcQ";
const DENIED = "Access to storage is not allowed from this context.";
const CONFIG = {
  SUPABASE_URL: "https://project.supabase.co",
  SUPABASE_ANON_KEY: "anon-key",
  AUTH_SITE_URL: "https://thumbsight.com",
};
const CONFIG_SRC = `self.THUMBVAULT_CONFIG = ${JSON.stringify(CONFIG)};`;

const file = (name) => readFile(new URL(`../${name}`, import.meta.url), "utf8");
const src = {
  i18n: await file("i18n.js"),
  intent: await file("intent.js"),
  oauth: await file("oauth.js"),
  background: await file("background.js"),
};

const SESSION = {
  access_token: `access-${"x".repeat(40)}`,
  refresh_token: "refresh-secret-1",
  token_type: "bearer",
  expires_in: 3600,
  expires_at: Math.floor(Date.now() / 1000) + 3600,
  user: { id: "user-1", email: "user@example.com" },
};

function memoryArea(initial = {}) {
  const data = { ...initial };
  const area = {
    data,
    reads: 0,
    async get(keys) {
      area.reads++;
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
  return area;
}

// Реальный service worker: config + intent + oauth + background в одном
// контексте, как их грузит importScripts.
function worker(storage = {}) {
  let listener = null;
  const local = memoryArea(storage);
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
    },
    crypto: globalThis.crypto,
    TextEncoder,
    URL,
    URLSearchParams,
    btoa,
    setTimeout,
    clearTimeout,
    console,
    fetch: async () => { throw new Error("network not expected"); },
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

  const send = (msg, sender) => new Promise((resolve) => {
    const async_ = listener(msg, sender, resolve);
    if (async_ !== true) resolve(undefined);
  });
  return { send, local };
}

const hostSender = (tabId = 7) => ({ id: EXT_ID, url: YT_URL, tab: { id: tabId } });

// Объекты приходят из vm-realm: у них другой прототип, и strict-сравнение с
// литералом падает на этом, а не на содержимом.
const plain = (value) => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)));

// Минимальный DOM: i18n.js трогает только documentElement, querySelectorAll и
// события.
function documentStub() {
  const events = [];
  return {
    events,
    doc: {
      documentElement: { setAttribute() {} },
      querySelectorAll: () => [],
      addEventListener() {},
      dispatchEvent: (event) => { events.push(event); return true; },
    },
  };
}

// DOM с настоящими атрибутами и текстом: и host-страница, и страница расширения
// проверяются одним стендом — разница только в `trusted`. Селекторы вида
// `[data-i18n]` сводятся к проверке наличия атрибута, больше i18n.js ничего не
// спрашивает.
function i18nDom(lang) {
  const events = [];
  const nodes = [];
  const html = { attrs: { lang }, setAttribute(name, value) { html.attrs[name] = value; } };
  const add = (attrs, props = {}) => {
    const el = {
      ...props,
      attrs: { ...attrs },
      dataset: {},
      hasAttribute: (name) => name in el.attrs,
      setAttribute: (name, value) => { el.attrs[name] = value; },
    };
    if (attrs["data-i18n"]) el.dataset.i18n = attrs["data-i18n"];
    if (attrs["data-i18n-placeholder"]) el.dataset.i18nPlaceholder = attrs["data-i18n-placeholder"];
    if (attrs["data-i18n-title"]) el.dataset.i18nTitle = attrs["data-i18n-title"];
    nodes.push(el);
    return el;
  };
  const doc = {
    documentElement: html,
    querySelectorAll: (selector) => nodes.filter((el) => selector.slice(1, -1) in el.attrs),
    addEventListener() {},
    dispatchEvent: (event) => { events.push(event); return true; },
  };
  return { events, doc, html, add };
}

// Загружает i18n.js так, как его видит страница: `trusted` выбирает протокол
// (content script на https против extension page).
function loadI18n({ trusted, chromeStub, host = "www.youtube.com", dom }) {
  const { doc, events } = dom || documentStub();
  const page = {
    document: doc,
    location: trusted
      ? { protocol: "chrome-extension:", host: EXT_ID }
      : { protocol: "https:", host },
    chrome: chromeStub,
    CustomEvent: class CustomEvent {
      constructor(type, init) { this.type = type; this.detail = init?.detail; }
    },
    console,
    setTimeout,
    clearTimeout,
    URL,
  };
  page.globalThis = page;
  vm.createContext(page);
  vm.runInContext(src.i18n, page, { filename: "public/i18n.js" });
  return { page, events, i18n: page.TVI18N };
}

// Storage, закрытый TRUSTED_CONTEXTS: ровно то, что Chrome отвечает content
// script после `setAccessLevel` в oauth.js.
function deniedStorage() {
  const calls = { get: 0, set: 0, listeners: 0 };
  return {
    calls,
    local: {
      get: async () => { calls.get++; throw new Error(DENIED); },
      set: async () => { calls.set++; throw new Error(DENIED); },
    },
    onChanged: { addListener: () => { calls.listeners++; } },
  };
}

function contentChrome(sendMessage, storage = deniedStorage()) {
  return {
    storage,
    runtime: { id: EXT_ID, lastError: null, sendMessage, getURL: (path) => `chrome-extension://${EXT_ID}${path}` },
  };
}

// Необработанный rejection ловится процессом, а не try/catch вокруг вызова:
// именно в такой форме он и наблюдался.
async function withoutUnhandled(body) {
  const seen = [];
  const onReject = (reason) => seen.push(reason);
  process.on("unhandledRejection", onReject);
  try {
    const result = await body();
    for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(seen.map(String), [], "необработанный Promise rejection");
    return result;
  } finally {
    process.off("unhandledRejection", onReject);
  }
}

// ------------------------------------------------------- content script

test("content script получает язык через background, не трогая закрытый storage", async () => {
  await withoutUnhandled(async () => {
    const bg = worker({ tv_lang: "ru", tv_session: SESSION });
    const storage = deniedStorage();
    const sent = [];
    const chromeStub = contentChrome((msg, callback) => {
      sent.push(msg);
      bg.send(msg, hostSender()).then(callback);
    }, storage);

    const { i18n, events } = loadI18n({ trusted: false, chromeStub });
    assert.equal(await i18n.ready, "ru");
    assert.equal(i18n.lang, "ru");
    assert.equal(i18n.t("save"), "Сохранить");

    assert.deepEqual(plain(sent), [{ type: "tv:lang" }]);
    assert.equal(storage.calls.get, 0, "content script не должен читать storage.local");
    assert.equal(storage.calls.set, 0);
    assert.equal(storage.calls.listeners, 0, "слушатель закрытой области не регистрируется");
    assert.deepEqual(events.map((e) => [e.type, e.detail.lang]), [["tv:langchange", "ru"]]);
  });
});

test("прямое чтение storage из content script отказывает — регрессия исходного дефекта", async () => {
  const storage = deniedStorage();
  await assert.rejects(() => storage.local.get("tv_lang"), new RegExp(DENIED.replace(/\./g, "\\.")));
  assert.equal(storage.calls.get, 1);
});

test("недоступный background даёт английский fallback без rejection", async () => {
  await withoutUnhandled(async () => {
    const chromeStub = contentChrome((_msg, callback) => {
      chromeStub.runtime.lastError = { message: "Could not establish connection." };
      callback(undefined);
      chromeStub.runtime.lastError = null;
    });
    const { i18n } = loadI18n({ trusted: false, chromeStub });
    assert.equal(await i18n.ready, "en");
    assert.equal(i18n.t("save"), "Save");
  });
});

test("бросающий sendMessage (осиротевший content script) даёт английский fallback", async () => {
  await withoutUnhandled(async () => {
    const chromeStub = contentChrome(() => { throw new Error("Extension context invalidated."); });
    const { i18n, events } = loadI18n({ trusted: false, chromeStub });
    assert.equal(await i18n.ready, "en");
    assert.deepEqual(events.map((e) => e.detail.lang), ["en"]);
  });
});

test("посторонний код языка в ответе отбрасывается", async () => {
  await withoutUnhandled(async () => {
    for (const lang of ["de", "", null, { toString: () => "ru" }, "ru "]) {
      const chromeStub = contentChrome((_msg, callback) => callback({ ok: true, lang }));
      const { i18n } = loadI18n({ trusted: false, chromeStub });
      assert.equal(await i18n.ready, "en");
    }
  });
});

// ------------------------------------------------------- host DOM (PUB-01)

// Дефект PUB-01: общий `apply()` в content script переписывал html.lang хоста и
// любой его элемент со совпавшими data-i18n*. Проверяется наблюдаемое состояние
// DOM после ready, а не наличие конкретной строки в реализации.
test("host DOM YouTube/Pinterest не меняется переводчиком расширения", async () => {
  for (const host of ["www.youtube.com", "www.pinterest.com"]) {
    await withoutUnhandled(async () => {
      const bg = worker({ tv_lang: "ru", tv_session: SESSION });
      const chromeStub = contentChrome((msg, callback) => {
        bg.send(msg, hostSender()).then(callback);
      });

      const dom = i18nDom("fr");
      // Неизвестный расширению ключ: дефект подставлял сюда само имя ключа.
      const label = dom.add({ "data-i18n": "native-site-label" }, { textContent: "Original site text" });
      // Совпавшие с расширением ключи: дефект подставлял сюда его переводы.
      const search = dom.add({ "data-i18n-placeholder": "findOrCreateFolder" }, { placeholder: "Rechercher sur le site" });
      const action = dom.add({ "data-i18n-title": "close", "aria-label": "Fermer le menu" }, { title: "Fermer le menu" });

      const { i18n, events } = loadI18n({ trusted: false, host, chromeStub, dom });
      assert.equal(await i18n.ready, "ru");
      // Прямой вызов экспортированного apply из content script тоже не должен
      // добираться до страницы: чинится функция, а не один её вызов в init.
      i18n.apply();

      assert.equal(dom.html.attrs.lang, "fr", `${host}: html.lang хоста переписан`);
      assert.equal(label.textContent, "Original site text", `${host}: текст хоста переписан`);
      assert.equal(search.placeholder, "Rechercher sur le site", `${host}: placeholder хоста переписан`);
      assert.equal(action.title, "Fermer le menu", `${host}: title хоста переписан`);
      assert.equal(action.attrs["aria-label"], "Fermer le menu", `${host}: aria-label хоста переписан`);

      // Собственные кнопки content script переводит сам по этому событию.
      assert.equal(i18n.lang, "ru");
      assert.equal(i18n.t("saveThumbnail"), "Сохранить обложку в Thumb Sight");
      assert.equal(i18n.t("saveImage"), "Сохранить изображение в Thumb Sight");
      assert.deepEqual(events.map((e) => [e.type, e.detail.lang]), [["tv:langchange", "ru"]]);
    });
  }
});

// ------------------------------------------------------- extension pages

// Обратная сторона того же фикса: popup и panel — extension-origin документы, и
// их собственный DOM обязан переводиться, включая элементы, добавленные после
// ready (списки папок/тегов, тексты ошибок).
test("popup/panel переводят собственный DOM на EN/ES/RU, включая динамику", async () => {
  await withoutUnhandled(async () => {
    const local = memoryArea({ tv_lang: "es" });
    const chromeStub = {
      storage: { local, onChanged: { addListener() {} } },
      runtime: { id: EXT_ID, lastError: null, getURL: (path) => `chrome-extension://${EXT_ID}${path}` },
    };

    const dom = i18nDom("en");
    const title = dom.add({ "data-i18n": "saveTitle" }, { textContent: "Save to Thumb Sight" });
    const input = dom.add({ "data-i18n-placeholder": "findOrCreateFolder" }, { placeholder: "Find or create a folder…" });
    const close = dom.add({ "data-i18n-title": "close", "aria-label": "Close" }, { title: "Close" });

    const { i18n } = loadI18n({ trusted: true, chromeStub, dom });
    assert.equal(await i18n.ready, "es");
    assert.equal(dom.html.attrs.lang, "es");
    assert.equal(title.textContent, "Guardar en Thumb Sight");
    assert.equal(input.placeholder, "Busca o crea una carpeta…");
    assert.equal(close.title, "Cerrar");
    assert.equal(close.attrs["aria-label"], "Cerrar");

    await i18n.setLang("ru");
    assert.equal(dom.html.attrs.lang, "ru");
    assert.equal(title.textContent, "Сохранить в Thumb Sight");
    assert.equal(input.placeholder, "Найдите или создайте папку…");
    assert.equal(close.title, "Закрыть");
    assert.equal(close.attrs["aria-label"], "Закрыть");

    const dynamic = dom.add({ "data-i18n": "loadingFolders" }, { textContent: "Loading folders…" });
    i18n.apply();
    assert.equal(dynamic.textContent, "Загрузка папок…");

    await i18n.setLang("en");
    assert.equal(dom.html.attrs.lang, "en");
    assert.equal(title.textContent, "Save to Thumb Sight");
    assert.equal(dynamic.textContent, "Loading folders…");
  });
});

test("popup читает и сохраняет язык напрямую", async () => {
  await withoutUnhandled(async () => {
    const local = memoryArea({ tv_lang: "es" });
    let changed = null;
    const chromeStub = {
      storage: { local, onChanged: { addListener: (fn) => { changed = fn; } } },
      runtime: { id: EXT_ID, lastError: null, getURL: (path) => `chrome-extension://${EXT_ID}${path}`, sendMessage: () => assert.fail("popup не ходит за языком в background") },
    };
    const { i18n, events } = loadI18n({ trusted: true, chromeStub });
    assert.equal(await i18n.ready, "es");

    await i18n.setLang("ru");
    assert.equal(local.data.tv_lang, "ru");
    assert.equal(i18n.t("save"), "Сохранить");

    assert.ok(changed, "extension page слушает изменения языка");
    changed({ tv_lang: { newValue: "en" } }, "local");
    assert.equal(i18n.lang, "en");
    assert.deepEqual(events.map((e) => e.detail.lang), ["es", "ru", "en"]);
  });
});

test("пустой storage засевается английским, отказ set не ломает ready", async () => {
  await withoutUnhandled(async () => {
    const local = memoryArea();
    const chromeStub = {
      storage: { local, onChanged: { addListener() {} } },
      runtime: { id: EXT_ID, lastError: null, getURL: (path) => `chrome-extension://${EXT_ID}${path}` },
    };
    assert.equal(await loadI18n({ trusted: true, chromeStub }).i18n.ready, "en");
    assert.equal(local.data.tv_lang, "en");

    const failing = {
      storage: {
        local: { get: async () => ({}), set: async () => { throw new Error("storage unavailable"); } },
        onChanged: { addListener() {} },
      },
      runtime: { id: EXT_ID, lastError: null, getURL: (path) => `chrome-extension://${EXT_ID}${path}` },
    };
    assert.equal(await loadI18n({ trusted: true, chromeStub: failing }).i18n.ready, "en");
  });
});

// ------------------------------------------------------- background

test("background отдаёт только валидированный код языка", async () => {
  for (const [stored, expected] of [["ru", "ru"], ["es", "es"], ["en", "en"], ["de", "en"], [42, "en"], [undefined, "en"]]) {
    const bg = worker(stored === undefined ? { tv_session: SESSION } : { tv_lang: stored, tv_session: SESSION });
    const res = plain(await bg.send({ type: "tv:lang" }, hostSender()));
    assert.deepEqual(res, { ok: true, lang: expected });
    assert.deepEqual(Object.keys(res).sort(), ["lang", "ok"]);
  }
});

test("отказ storage в background тоже даёт английский, а не отказ", async () => {
  const bg = worker();
  bg.local.get = async () => { throw new Error("storage unavailable"); };
  assert.deepEqual(plain(await bg.send({ type: "tv:lang" }, hostSender())), { ok: true, lang: "en" });
});

test("tv:lang не открывает host-странице сессию и Supabase-маршруты", async () => {
  const bg = worker({ tv_lang: "ru", tv_session: SESSION });
  const sender = hostSender();
  for (const msg of [
    { type: "tv:sb-session" },
    { type: "tv:sb-sign-out" },
    { type: "tv:sb-rest", path: "collections?select=id" },
    { type: "tv:sb-function", name: "refresh-views", body: { video_id: "dQw4w9WgXcQ" } },
    { type: "tv:oauth-sign-in" },
    { type: "tv:storage-get", key: "tv_session" },
  ]) {
    assert.deepEqual(plain(await bg.send(msg, sender)), { ok: false, error: "Blocked sender" }, msg.type);
  }
  const lang = plain(await bg.send({ type: "tv:lang" }, sender));
  assert.equal(JSON.stringify(lang).includes(SESSION.refresh_token), false);
  assert.equal(JSON.stringify(lang).includes(SESSION.access_token), false);
});

test("чужое расширение не получает даже язык", async () => {
  const bg = worker({ tv_lang: "ru" });
  const foreign = { id: "b".repeat(32), url: YT_URL, tab: { id: 7 } };
  const offHost = { id: EXT_ID, url: "https://evil.example/", tab: { id: 7 } };
  assert.deepEqual(plain(await bg.send({ type: "tv:lang" }, foreign)), { ok: false, error: "Blocked sender" });
  assert.deepEqual(plain(await bg.send({ type: "tv:lang" }, offHost)), { ok: false, error: "Blocked sender" });
});

// ------------------------------------------------------- словарь
//
// Мёртвый ключ грузится в каждую вкладку YouTube/Pinterest и правится
// переводчиками впустую (EXT-OPT-01 id 7); ключ без перевода показывает
// пользователю сырое имя. Формы обращений — все, что есть в runtime-файлах:
// разметка, прямой вызов, выбор из двух ключей, dataset.i18n, исход панели
// tvFinish и ключи пикера panel.js. Новая форма обращения обязана попасть сюда,
// иначе её ключ этот тест сочтёт мёртвым.
const KEY_REFS = [
  /data-i18n(?:-placeholder|-title)?="(\w+)"/g,
  /\b(?:t|tvT)\(\s*["'](\w+)["']\s*\)/g,
  /\b(?:t|tvT)\([^()]*?\?\s*["'](\w+)["']\s*:\s*["'](\w+)["']\s*\)/g,
  /\bdataset\.i18n(?:Placeholder|Title)?\s*=\s*["'](\w+)["']/g,
  /\btvFinish\(\s*["'](\w+)["']\s*,\s*["'](\w+)["']/g,
  /\b(?:emptyKey|createKey)\s*:\s*["'](\w+)["']/g,
];

test("каждый ключ словаря используется, и каждое обращение есть в словаре на en/es/ru", async () => {
  // Словарь исполняется, а не разбирается построчно: так видны ровно те ключи,
  // что получит t().
  const body = src.i18n.match(/const T = (\{[\s\S]*?\n {2}\});/)?.[1];
  assert.ok(body, "блок T не найден в i18n.js");
  const T = vm.runInNewContext(`(${body})`);

  const used = new Set();
  const files = RUNTIME.filter((name) => /\.(js|html)$/.test(name) && name !== "i18n.js");
  for (const name of files) {
    const text = await file(name);
    for (const re of KEY_REFS) {
      for (const match of text.matchAll(re)) for (const key of match.slice(1)) used.add(key);
    }
  }

  const dead = Object.keys(T).filter((key) => !used.has(key));
  assert.deepEqual(dead, [], "ключи словаря, к которым нет обращений");
  const missing = [...used].filter((key) => !Object.hasOwn(T, key));
  assert.deepEqual(missing, [], "обращения к ключам, которых нет в словаре");
  const untranslated = Object.keys(T).filter((key) => !["en", "es", "ru"].every((lang) => typeof T[key][lang] === "string" && T[key][lang]));
  assert.deepEqual(untranslated, [], "ключи без перевода на en/es/ru");
});

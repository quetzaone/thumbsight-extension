// node --test: сторожа панели и её открытия (EXT-OPT-01 #1/#43, #47, #48, #28).
//
// Поведенческие проверки исполняют настоящие intent.js + modal.js (сторона
// страницы) и supabase.js + api.js (панель) в vm; подставлены только DOM и
// runtime messaging. Статические — читают panel.html/panel.css/panel.js.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const read = (name) => readFileSync(new URL(`../${name}`, import.meta.url), "utf8");
const EXT_ID = "a".repeat(32);

// ------------------------------------------------- #1/#43 повторный вход openPanel

function modalStand() {
  const pending = [];
  const sent = [];
  const mounted = [];
  const toasts = [];
  const node = (tag) => ({
    tag,
    open: false,
    children: [],
    classList: { add() {}, remove() {} },
    dataset: {},
    setAttribute() {},
    addEventListener() {},
    append(...nodes) { this.children.push(...nodes); },
    appendChild(child) { this.children.push(child); return child; },
    remove() {},
    attachShadow() { return node("#shadow"); },
    showModal() { this.open = true; },
    close() { this.open = false; },
  });
  const page = {
    chrome: {
      runtime: {
        id: EXT_ID,
        lastError: null,
        getURL: (path) => `chrome-extension://${EXT_ID}/${String(path).replace(/^\//, "")}`,
        // Ответ придерживается: так выглядит холодный service worker.
        sendMessage: (message, callback) => { sent.push(message); pending.push(callback); },
      },
    },
    document: {
      createElement: (tag) => node(tag),
      getElementById: () => null,
      body: node("body"),
      documentElement: { appendChild: (child) => { mounted.push(child); return child; } },
    },
    navigator: { userActivation: { isActive: true } },
    TVI18N: { t: (key) => { toasts.push(key); return key; } },
    addEventListener() {},
    setTimeout,
    clearTimeout,
    URL,
    console,
  };
  page.window = page;
  page.self = page;
  vm.createContext(page);
  vm.runInContext(read("intent.js"), page, { filename: "public/intent.js" });
  vm.runInContext(read("modal.js"), page, { filename: "public/modal.js" });
  const reply = (response) => pending.shift()(response);
  return { TV: page.TV, sent, mounted, toasts, reply };
}

const trusted = () => ({ isTrusted: true, type: "click" });
const YT = { mode: "youtube", videoId: "dQw4w9WgXcQ" };

test("openPanel: двойной клик до ответа worker — один intent и один mount", async () => {
  const stand = modalStand();
  const first = stand.TV.openPanel(trusted(), YT);
  // Без защиты второй вызов ждал бы своего ответа вечно: гонка с таймером, а
  // не голый await, чтобы регрессия падала, а не вешала прогон.
  const second = await Promise.race([
    stand.TV.openPanel(trusted(), YT),
    new Promise((resolve) => setTimeout(() => resolve("pending"), 50)),
  ]);

  assert.equal(stand.sent.length, 1, "второй клик отправил ещё один tv:open-intent");
  assert.equal(second, false, "второй вызов обязан отказать, пока первый ждёт ответа");
  assert.equal(stand.sent[0].type, "tv:open-intent");

  stand.reply({ ok: true, nonce: "n".repeat(32) });
  assert.equal(await first, true);
  assert.equal(stand.mounted.length, 1, "панель смонтирована не один раз");

  // После ответа флаг снят: следующее открытие снова возможно.
  const again = stand.TV.openPanel(trusted(), YT);
  assert.equal(stand.sent.length, 2);
  stand.reply({ ok: true, nonce: "m".repeat(32) });
  assert.equal(await again, true);
  assert.equal(stand.mounted.length, 2);
});

test("openPanel: отказ worker тоже снимает флаг, недоверенный клик не ставит его", async () => {
  const stand = modalStand();
  assert.equal(await stand.TV.openPanel({ isTrusted: false }, YT), false);
  assert.equal(stand.sent.length, 0);

  const failed = stand.TV.openPanel(trusted(), YT);
  stand.reply({ ok: false, error: "Rate limited" });
  assert.equal(await failed, false);
  assert.deepEqual(stand.toasts, ["openFailed"]);
  assert.equal(stand.mounted.length, 0);

  const retry = stand.TV.openPanel(trusted(), YT);
  assert.equal(stand.sent.length, 2, "после отказа открытие заблокировано навсегда");
  stand.reply({ ok: true, nonce: "r".repeat(32) });
  assert.equal(await retry, true);
});

// -------------------------------------------------------- #47 чип источника

test("panel.html: чип #tv-source пуст и скрыт до claim", () => {
  const chip = read("panel.html").match(/<span([^>]*\bid="tv-source"[^>]*)>([^<]*)<\/span>/);
  assert.ok(chip, "#tv-source не найден");
  assert.equal(chip[2], "", "статический текст чипа виден до ответа claim");
  const classes = (chip[1].match(/\bclass="([^"]*)"/)?.[1] || "").split(/\s+/);
  assert.ok(classes.includes("tv-hidden"), "чип не скрыт до claim");
  assert.match(read("panel.js"), /\$\("tv-source"\)\.textContent = [^\n]*\n\s*tvShow\("tv-source", true\);/,
    "после установки текста чип показывается");
});

// ------------------------------------------------- #48 мёртвые правила panel.css

// Классы, которые не видны ни в разметке, ни в литералах panel.js, но живые.
// Пусто намеренно: появится такой класс — его надо вписать сюда с причиной.
const CLASS_ALLOWLIST = new Map();

test("panel.css: каждый класс-селектор используется panel.html или panel.js", () => {
  const css = read("panel.css").replace(/\/\*[\s\S]*?\*\//g, "");
  const selectors = [...css.matchAll(/([^{}]+)\{/g)]
    .map((m) => m[1].trim())
    .filter((sel) => !sel.startsWith("@") && !/^(from|to|\d+%)$/.test(sel));
  const cssClasses = new Set(selectors.flatMap((sel) => [...sel.matchAll(/\.(-?[_a-zA-Z][\w-]*)/g)].map((m) => m[1])));
  assert.ok(cssClasses.size > 20, "селекторы panel.css не разобраны");

  const htmlClasses = new Set([...read("panel.html").matchAll(/\bclass="([^"]*)"/g)]
    .flatMap((m) => m[1].split(/\s+/).filter(Boolean)));
  // Комментарии panel.js вырезаются, чтобы класс не «жил» только в описании.
  // `//` после пробела или с начала строки — URL в строках не задеваются.
  const js = read("panel.js").replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|\s)\/\/.*$/gm, "$1");
  const jsTokens = new Set([...js.matchAll(/(["'`])((?:\\.|(?!\1)[^\\])*)\1/g)]
    .flatMap((m) => m[2].split(/[^\w-]+/).filter(Boolean)));

  const dead = [...cssClasses].filter((name) => (
    !htmlClasses.has(name) && !jsTokens.has(name) && !CLASS_ALLOWLIST.has(name)
  ));
  assert.deepEqual(dead, [], `мёртвые классы в panel.css: ${dead.join(", ")}`);
});

test("panel.css: каждая объявленная переменная используется", () => {
  const css = read("panel.css").replace(/\/\*[\s\S]*?\*\//g, "");
  const declared = [...css.matchAll(/(--[\w-]+)\s*:/g)].map((m) => m[1]);
  assert.ok(declared.length > 0);
  const unused = declared.filter((name) => !css.includes(`var(${name})`));
  assert.deepEqual(unused, [], `неиспользуемые переменные: ${unused.join(", ")}`);
});

// ------------------------------------------------------ #28 user id без лишних IPC

function apiStand(sessions) {
  const sent = [];
  const page = {
    chrome: {
      runtime: {
        id: EXT_ID,
        lastError: null,
        sendMessage: (message, callback) => {
          sent.push(message);
          if (message.type === "tv:sb-session") {
            const session = sessions.length > 1 ? sessions.shift() : sessions[0];
            queueMicrotask(() => callback({ ok: true, session }));
            return;
          }
          if (message.type === "tv:sb-rest") {
            queueMicrotask(() => callback({ ok: true, data: [{ id: `row-${sent.length}` }] }));
            return;
          }
          queueMicrotask(() => callback({ ok: false, error: `unexpected ${message.type}` }));
        },
      },
    },
    setTimeout,
    clearTimeout,
    URL,
    console,
  };
  page.window = page;
  page.self = page;
  vm.createContext(page);
  vm.runInContext(read("supabase.js"), page, { filename: "public/supabase.js" });
  vm.runInContext(read("api.js"), page, { filename: "public/api.js" });
  const of = (type) => sent.filter((message) => message.type === type);
  const bodies = () => of("tv:sb-rest").filter((m) => m.opts?.method === "POST").map((m) => JSON.parse(m.opts.body));
  return { API: page.API, of, bodies };
}

const USER = { user: { id: "user-1" } };
const VIDEO = "dQw4w9WgXcQ";
const thumb = () => ({
  video_id: VIDEO,
  img_url: `https://i.ytimg.com/vi/${VIDEO}/maxresdefault.jpg`,
  source_url: `https://www.youtube.com/watch?v=${VIDEO}`,
  note: "",
});

test("api: создание папки и сохранение обложки спрашивают сессию один раз", async () => {
  const stand = apiStand([USER]);
  await stand.API.createCollection("Refs");
  await stand.API.saveThumbnail(thumb());
  assert.equal(stand.of("tv:sb-session").length, 1, "user id запрошен повторно");
  assert.deepEqual(stand.bodies().map((body) => body.user_id), ["user-1", "user-1"]);
});

test("api: отсутствие сессии (null) не кешируется", async () => {
  const stand = apiStand([null, USER]);
  await stand.API.createTag("bold");
  await stand.API.createTag("bold");
  await stand.API.createTag("bold");
  assert.equal(stand.of("tv:sb-session").length, 2, "null закешировался или кеш не работает");
  assert.deepEqual(stand.bodies().map((body) => body.user_id), [null, "user-1", "user-1"]);
});

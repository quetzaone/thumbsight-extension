// PUB-02 в реальном Chromium: узкое обновление заметки и доступный пользователю
// повтор сохранения В ТОЙ ЖЕ панели после ошибки (F1).
//
// Запуск:
//   TV_CHROME=<chrome.exe> TV_PLAYWRIGHT_ROOT=<dir-with-node_modules>
//   node extensions/public/tests/pub02-panel-retry.check.mjs
//
// Узкий прибор вместо разрастания общего browser-intent gate: там фикстура
// Supabase не обслуживает PATCH, а повтор означает новую панель. Здесь фикстура
// ведёт синтетическую «базу» (строки, заметки, связи) и реально исполняет
// POST/PATCH/RPC, а повтор делается обычным Playwright-кликом по видимой кнопке
// в том же iframe: без evaluate(click), без force, без ручного снятия hidden.
//
// Ничего настоящего: Pinterest и Supabase подменены route-слоем, имена не
// разрешаются, расширение грузится из санированной копии, реальный config.js не
// читается и не копируется, сессия — вымышленные значения.
process.env.PW_EXPERIMENTAL_SERVICE_WORKER_NETWORK_EVENTS = "1";

import { createRequire } from "node:module";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(
  process.env.TV_PLAYWRIGHT_ROOT
    ? join(resolve(process.env.TV_PLAYWRIGHT_ROOT), "package.json")
    : import.meta.url
);
const { chromium } = require("playwright-core");

const SRC = process.env.TV_EXT || resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CHROME = process.env.TV_CHROME;
if (!CHROME) {
  console.error("Задай TV_CHROME — путь к бинарнику Chrome/Chromium.");
  process.exit(2);
}

const SANITIZED_FILES = [
  "manifest.json", "background.js", "intent.js", "oauth.js", "i18n.js",
  "supabase.js", "api.js", "modal.js", "panel.html", "panel.css", "panel.js",
  "popup.html", "popup.js", "content.css", "content.js", "content-channel.js",
  "content-pinterest.js",
  "_locales/en/messages.json", "_locales/es/messages.json", "_locales/ru/messages.json",
  "icons/icon16.png", "icons/icon48.png", "icons/icon128.png",
];
const NEVER_COPY = new Set(["config.js", "config.example.js"]);

const extDir = mkdtempSync(join(tmpdir(), "tv-pub02-src-"));
for (const rel of SANITIZED_FILES) {
  if (NEVER_COPY.has(rel)) throw new Error(`Файл ${rel} копировать запрещено`);
  const target = join(extDir, rel);
  mkdirSync(dirname(target), { recursive: true });
  copyFileSync(join(SRC, rel), target);
}
const manifest = JSON.parse(readFileSync(join(extDir, "manifest.json"), "utf8"));
const SB_ORIGIN = new URL(manifest.host_permissions[0].replace(/\*$/, "")).origin;
const SYNTHETIC_ANON_KEY = `synthetic-anon-key-${"k".repeat(40)}`;
const SYNTHETIC_CONFIG = `(globalThis.window || globalThis).THUMBVAULT_CONFIG = {
  SUPABASE_URL: "${SB_ORIGIN}",
  SUPABASE_ANON_KEY: "${SYNTHETIC_ANON_KEY}",
  AUTH_SITE_URL: "https://thumbsight.invalid",
};
`;
writeFileSync(join(extDir, "config.js"), SYNTHETIC_CONFIG);

const digest = createHash("sha256").update(Buffer.from(manifest.key, "base64")).digest();
const extensionId = [...digest.subarray(0, 16)]
  .flatMap((byte) => [byte >> 4, byte & 15])
  .map((nibble) => String.fromCharCode(97 + nibble))
  .join("");

const results = [];
const check = (name, ok, detail = "") => {
  results.push({ ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
};

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64"
);
const PIN_IMG = "https://i.pinimg.com/originals/aa/bb/cc.jpg";
const PIN_PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>fixture</title><style>
body{margin:0}.card{position:relative;display:block;margin:20px}img{display:block;width:320px;height:240px}
</style></head><body>
<a class="card" href="/pin/12345/"><img id="pin" src="${PIN_IMG}"></a>
</body></html>`;

const PIN_ROW = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const NEW_ROW = "99999999-9999-4999-8999-999999999999";
const COLLECTION_ID = "11111111-1111-4111-8111-111111111111";
const TAG_ID = "12121212-1212-4121-8121-121212121212";

// --------------------------------------------------- синтетическая «база»
let rows = [];
let linksMode = "ok";
const calls = [];
const blocked = [];
const rowsCount = () => rows.length;
const patches = () => calls.filter((call) => call.method === "PATCH");
const thumbPosts = () => calls.filter((call) => call.method === "POST" && call.path === "/rest/v1/thumbnails");
const rpcPosts = () => calls.filter((call) => call.path.endsWith("/rpc/replace_thumbnail_links"));
const junctionCalls = () => calls.filter((call) => /thumbnail_(collections|tags)/.test(call.path));
const NOTE_PATCH = /^\/rest\/v1\/thumbnails$/;
const UUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

const profileDir = mkdtempSync(join(tmpdir(), "tv-pub02-"));
let ctx = null;
const pageErrors = [];
try {
  ctx = await chromium.launchPersistentContext(profileDir, {
    executablePath: CHROME,
    headless: false,
    args: [
      "--disable-features=DisableLoadExtensionCommandLineSwitch",
      "--host-resolver-rules=MAP * ~NOTFOUND",
      `--disable-extensions-except=${extDir}`,
      `--load-extension=${extDir}`,
    ],
  });
  ctx.on("weberror", (error) => pageErrors.push(String(error.error())));

  await ctx.route(/^https?:\/\//i, (route) => {
    blocked.push(route.request().url());
    return route.abort("blockedbyclient");
  });
  await ctx.route("**://i.pinimg.com/**", (route) => route.fulfill({ contentType: "image/png", body: PNG }));
  await ctx.route("**://*.pinterest.com/**", (route) => route.fulfill({ contentType: "text/html", body: PIN_PAGE }));

  await ctx.route("**://*.supabase.co/**", (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const method = request.method();
    const raw = request.postData() || "";
    let body = null;
    try { body = raw ? JSON.parse(raw) : null; } catch (_) { body = null; }
    calls.push({ method, path: url.pathname, search: url.search, body, prefer: request.headers().prefer ?? null });
    const json = (value, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(value) });

    if (url.pathname.endsWith("/rest/v1/collections")) return json([{ id: COLLECTION_ID, name: "Refs" }]);
    if (url.pathname.endsWith("/rest/v1/tags")) return json([{ id: TAG_ID, name: "bold" }]);

    if (NOTE_PATCH.test(url.pathname)) {
      if (method === "GET") {
        const img = decodeURIComponent((url.searchParams.get("img_url") || "").replace(/^eq\./, ""));
        const found = rows.find((row) => row.img_url === img);
        return json(found ? [{
          id: found.id,
          note: found.note,
          thumbnail_collections: found.collectionIds.map((collection_id) => ({ collection_id })),
          thumbnail_tags: found.tagIds.map((tag_id) => ({ tag_id })),
        }] : []);
      }
      if (method === "POST") {
        const created = {
          id: NEW_ROW,
          note: body?.note ?? "",
          img_url: body?.img_url ?? "",
          collectionIds: [],
          tagIds: [],
        };
        rows.push(created);
        return json([{ id: created.id }]);
      }
      // Настоящая ветка PATCH: одно поле note у одной своей строки. Чужой или
      // несуществующий id даёт НОЛЬ строк — так же, как RLS `own thumbnails
      // update` через `using`.
      if (method === "PATCH") {
        const id = (url.searchParams.get("id") || "").replace(/^eq\./, "");
        const keys = Object.keys(body || {});
        if (!UUID.test(id) || keys.length !== 1 || keys[0] !== "note") {
          return json({ code: "TVGATE", message: "unexpected PATCH shape" }, 400);
        }
        const row = rows.find((item) => item.id === id);
        if (!row) return json([]);
        row.note = body.note;
        return json([{ id: row.id }]);
      }
      if (method === "DELETE") return route.fulfill({ status: 204, body: "" });
    }

    if (url.pathname.endsWith("/rpc/replace_thumbnail_links")) {
      if (linksMode === "deny") return json({ code: "JO010", message: "junction ownership violation" }, 400);
      const row = rows.find((item) => item.id === body?.p_thumbnail_id);
      if (!row) return json({ code: "JO001", message: "unknown thumbnail" }, 404);
      let collections = null;
      let tags = null;
      if (Array.isArray(body.p_collection_ids)) { row.collectionIds = body.p_collection_ids; collections = body.p_collection_ids.length; }
      if (Array.isArray(body.p_tag_ids)) { row.tagIds = body.p_tag_ids; tags = body.p_tag_ids.length; }
      return json({ thumbnail_id: body.p_thumbnail_id, collections, tags });
    }
    // Прямые junction-записи фикстура не обслуживает: попадание сюда — дефект.
    if (/thumbnail_(collections|tags)/.test(url.pathname)) {
      return json({ code: "TVGATE", message: "direct junction write is not expected" }, 500);
    }
    if (url.pathname.includes("/functions/v1/")) return json({});
    return json({});
  });

  const worker = ctx.serviceWorkers()[0] || (await ctx.waitForEvent("serviceworker", { timeout: 15000 }));
  check("расширение загружено под ожидаемым ID из manifest.key", new URL(worker.url()).host === extensionId);
  // Только вымышленные значения; настоящий storage не читается.
  //
  // Сессия кладётся через API расширения (tvSetSession, как в pub07) и только
  // ПОСЛЕ штатного install-сброса. Прежний сырой storage.local.set сразу после
  // появления worker гонялся с onInstalled(install): на Chromium 140 событие
  // приходит позже, и tvBeginInstallStateReset() стирал уже записанную
  // tv_session — панель показывала «Sign in first» (PUB-04 G1). tvSetSession
  // ждёт барьер, снятый в момент вызова, поэтому сначала дожидаемся, что сброс
  // состоялся: на свежем профиле до записи фикстуры единственное
  // зафиксированное изменение слота — сам сброс (tvSessionRevision > 0).
  // Ничего не инструментируется и не подавляется: читаются глобали фона.
  // Событие serviceworker приходит до того, как importScripts объявил глобали
  // фона (наблюдалось: ReferenceError tvSessionRevision), поэтому чтение
  // защищено: необъявленная глобаль значит «ещё не готово», а не отказ.
  const fixture = await worker.evaluate(async (session) => {
    const revision = () => {
      try { return tvSessionRevision; } catch (_) { return -1; }
    };
    const deadline = Date.now() + 20000;
    while (revision() <= 0 && Date.now() < deadline) {
      await new Promise((done) => setTimeout(done, 50));
    }
    if (revision() <= 0) return { ok: false, error: `install-сброс за 20 с не зафиксирован (revision ${revision()})` };
    try {
      await tvInstallStatePromise;
      await chrome.storage.local.set({ tv_lang: "en" });
      await tvSetSession(session);
      const back = await tvGetSession();
      return { ok: back?.refresh_token === session.refresh_token, revision: tvSessionRevision };
    } catch (err) {
      return { ok: false, error: String(err?.message || err) };
    }
  }, {
    access_token: `test-access-${"x".repeat(32)}`,
    refresh_token: `test-refresh-${"y".repeat(32)}`,
    expires_at: Math.floor(Date.now() / 1000) + 3600,
    user: { id: "33333333-3333-4333-8333-333333333333", email: "test@example.invalid" },
  });
  check("фикстура: сессия записана через tvSetSession после install-сброса", fixture.ok, JSON.stringify(fixture));

  const pin = await ctx.newPage();
  await pin.goto("https://www.pinterest.com/");
  await pin.waitForSelector("#tv-pin-btn", { timeout: 15000, state: "attached" });

  async function openPanel() {
    await pin.bringToFront();
    await pin.hover("#pin");
    await pin.waitForFunction(() => document.getElementById("tv-pin-btn").style.display === "flex");
    await pin.click("#tv-pin-btn");
    await pin.waitForSelector("#tv-panel-host", { state: "attached" });
    let panel = null;
    for (let attempt = 0; attempt < 80 && !panel; attempt += 1) {
      panel = pin.frames().find((frame) => frame.url().startsWith(`chrome-extension://${extensionId}/panel.html`)) || null;
      if (!panel) await pin.waitForTimeout(50);
    }
    if (!panel) throw new Error("панель не загрузилась");
    await panel.waitForSelector("#tv-overlay");
    return panel;
  }
  async function clickAndWaitClose(panel, selector) {
    const closed = pin.waitForSelector("#tv-panel-host", { state: "detached" });
    await panel.click(selector);
    await closed;
  }

  // ---------------------------------- 1. existing + изменение заметки → PATCH
  rows = [{ id: PIN_ROW, img_url: PIN_IMG, note: "старая заметка", collectionIds: [COLLECTION_ID], tagIds: [TAG_ID] }];
  {
    const panel = await openPanel();
    await panel.waitForSelector("#tv-delete:not(.tv-hidden)");
    check("дубликат найден: панель показывает сохранённую заметку", await panel.inputValue("#tv-note-input") === "старая заметка");
    await panel.click("#tv-tab-note");
    await panel.fill("#tv-note-input", "новая заметка из браузера");
    const beforeRows = rowsCount();
    await clickAndWaitClose(panel, "#tv-save");

    const patch = patches()[0];
    check("изменение заметки ушло одним PATCH того же id",
      patches().length === 1 && patch?.search === `?id=eq.${PIN_ROW}&select=id`,
      JSON.stringify({ count: patches().length, search: patch?.search }));
    check("тело PATCH — ровно note", JSON.stringify(patch?.body) === JSON.stringify({ note: "новая заметка из браузера" }), JSON.stringify(patch?.body));
    check("Prefer выставил фон, а не вызывающий", patch?.prefer === "return=representation", String(patch?.prefer));
    check("ни одного INSERT: число строк не выросло", thumbPosts().length === 0 && rowsCount() === beforeRows, `${beforeRows} → ${rowsCount()}`);
    check("заметка обновилась в той же строке", rows[0].id === PIN_ROW && rows[0].note === "новая заметка из браузера", JSON.stringify(rows[0]));
    check("исходные папка и тег остались на том же id",
      JSON.stringify(rows[0].collectionIds) === JSON.stringify([COLLECTION_ID])
        && JSON.stringify(rows[0].tagIds) === JSON.stringify([TAG_ID]),
      JSON.stringify(rows[0]));
    check("наборы не менялись → RPC не вызывался", rpcPosts().length === 0);
  }

  // ------------------- 2. создание + отказ связей + повтор В ТОЙ ЖЕ панели
  rows = [];
  calls.length = 0;
  linksMode = "deny";
  {
    const panel = await openPanel();
    await panel.waitForSelector("#tv-collections .tv-choice");
    await panel.click("#tv-tab-note");
    await panel.fill("#tv-note-input", "заметка новой строки");
    await panel.click("#tv-tab-folders");
    await panel.click("#tv-collections .tv-choice");
    await panel.click("#tv-save");

    await panel.waitForSelector("#tv-note.tv-err:not(.tv-hidden)");
    check("частичный успех: строка создана, связи отказали",
      thumbPosts().length === 1 && rowsCount() === 1 && rpcPosts().length === 1 && rows[0].collectionIds.length === 0,
      JSON.stringify({ posts: thumbPosts().length, rpc: rpcPosts().length, rows: rowsCount() }));
    check("панель не закрылась и не ушла на финальный экран",
      !panel.isDetached()
        && await pin.locator("#tv-panel-host").count() === 1
        && await panel.locator("#tv-finish:not(.tv-hidden)").count() === 0);
    check("ошибка видима и помечена как ошибка", await panel.locator("#tv-note.tv-err").count() === 1, (await panel.locator("#tv-note").textContent())?.trim());
    check("Save виден и активен, редактор жив — повтор доступен",
      await panel.locator("#tv-save:not(.tv-hidden)").count() === 1
        && await panel.locator("#tv-save").isEnabled()
        && await panel.locator("#tv-editor:not(.tv-hidden)").count() === 1);
    check("введённая заметка и выбранная папка сохранились",
      await panel.inputValue("#tv-note-input") === "заметка новой строки"
        && await panel.locator("#tv-collections .tv-choice.on").count() === 1);

    // Повтор — обычный пользовательский клик по видимой кнопке в ТОМ ЖЕ iframe.
    linksMode = "ok";
    const postsBeforeRetry = thumbPosts().length;
    await clickAndWaitClose(panel, "#tv-save");

    check("повтор в той же панели закрыл её успехом", panel.isDetached() && await pin.locator("#tv-panel-host").count() === 0);
    check("за обе попытки ровно один INSERT", thumbPosts().length === postsBeforeRetry && thumbPosts().length === 1 && rowsCount() === 1,
      JSON.stringify({ posts: thumbPosts().length, rows: rowsCount() }));
    check("подтверждённая заметка повторно не отправлялась", patches().length === 0, JSON.stringify(patches().map((call) => call.search)));
    check("связи легли на тот же id", rpcPosts().length === 2
      && rpcPosts()[1].body?.p_thumbnail_id === rows[0].id
      && JSON.stringify(rows[0].collectionIds) === JSON.stringify([COLLECTION_ID]),
      JSON.stringify(rows[0]));
    check("заметка новой строки на месте", rows[0].note === "заметка новой строки", rows[0].note);
  }

  check("прямых junction-запросов не было", junctionCalls().length === 0, JSON.stringify(junctionCalls().map((call) => call.path)));
  check("необработанных ошибок страницы не было", pageErrors.length === 0, JSON.stringify(pageErrors));
  check("в сеть уходил только синтетический apikey и только к фикстурам",
    blocked.every((url) => !/supabase\.co|pinterest\.com|pinimg\.com/.test(url)),
    `оборвано ${blocked.length}`);

  const failed = results.filter((result) => !result.ok);
  console.log(`\n${results.length - failed.length}/${results.length} PASS`);
  process.exitCode = failed.length ? 1 : 0;
} finally {
  await ctx?.close().catch(() => {});
  rmSync(profileDir, { recursive: true, force: true });
  rmSync(extDir, { recursive: true, force: true });
}

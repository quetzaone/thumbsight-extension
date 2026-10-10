// PUB-06 в реальном Chromium: зависший необязательный snapshot не удерживает
// уже сохранённую панель дольше одного бюджета.
//
// Запуск:
//   TV_CHROME=<chrome.exe> TV_PLAYWRIGHT_ROOT=<dir-with-node_modules>
//   node extensions/public/tests/pub06-snapshot-budget.check.mjs
//
// Здесь измеряется ровно то, чего нельзя измерить в VM: фактическое время от
// нажатия Save до исчезновения панели в настоящем браузере. Границы тела,
// отмена запроса и поведение общего refresh проверяются VM-набором
// pub06-snapshot-budget.test.mjs.
//
// Ничего настоящего: YouTube и Supabase подменены route-слоем, имена не
// разрешаются, расширение грузится из санированной копии, реальный config.js не
// читается и не копируется, сессия — вымышленные значения. Квоты YouTube не
// расходуются: Edge Function тоже фикстура.
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

const BUDGET_MS = 5000;
// Допуск планировщика: таймер MV3-воркера, runtime messaging и снятие iframe
// занимают конечное время. Нижняя граница важна не меньше верхней — она
// доказывает, что панель ДЕЙСТВИТЕЛЬНО дождалась бюджета, а не закрылась сразу.
const TOLERANCE_MS = 3000;
const FAST_MAX_MS = 3000;

const SANITIZED_FILES = [
  "manifest.json", "background.js", "intent.js", "oauth.js", "i18n.js",
  "supabase.js", "api.js", "modal.js", "panel.html", "panel.css", "panel.js",
  "popup.html", "popup.js", "content.css", "content.js", "content-channel.js",
  "content-pinterest.js",
  "_locales/en/messages.json", "_locales/es/messages.json", "_locales/ru/messages.json",
  "icons/icon16.png", "icons/icon48.png", "icons/icon128.png",
];
const NEVER_COPY = new Set(["config.js", "config.example.js"]);

const extDir = mkdtempSync(join(tmpdir(), "tv-pub06-src-"));
for (const rel of SANITIZED_FILES) {
  if (NEVER_COPY.has(rel)) throw new Error(`Файл ${rel} копировать запрещено`);
  const target = join(extDir, rel);
  mkdirSync(dirname(target), { recursive: true });
  copyFileSync(join(SRC, rel), target);
}
const manifest = JSON.parse(readFileSync(join(extDir, "manifest.json"), "utf8"));
const SB_ORIGIN = new URL(manifest.host_permissions[0].replace(/\*$/, "")).origin;
const SYNTHETIC_ANON_KEY = `synthetic-anon-key-${"k".repeat(40)}`;
writeFileSync(join(extDir, "config.js"), `(globalThis.window || globalThis).THUMBVAULT_CONFIG = {
  SUPABASE_URL: "${SB_ORIGIN}",
  SUPABASE_ANON_KEY: "${SYNTHETIC_ANON_KEY}",
  AUTH_SITE_URL: "https://thumbsight.invalid",
};
`);

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
const FAST_VIDEO = "dQw4w9WgXcQ";
const SLOW_VIDEO = "abcdefghijk";
const YT_PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>fixture</title></head>
<body><ytd-watch-metadata><div id="top-level-buttons-computed"></div></ytd-watch-metadata></body></html>`;

let rows = [];
let snapshotMode = "fast";
const calls = [];
const hungRoutes = [];
const blocked = [];
const fnCalls = () => calls.filter((call) => call.path.includes("/functions/v1/refresh-views"));
const thumbPosts = () => calls.filter((call) => call.method === "POST" && call.path.endsWith("/rest/v1/thumbnails"));

const profileDir = mkdtempSync(join(tmpdir(), "tv-pub06-"));
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
  await ctx.route("**://i.ytimg.com/**", (route) => route.fulfill({ contentType: "image/png", body: PNG }));
  await ctx.route("**://*.youtube.com/**", (route) => route.fulfill({ contentType: "text/html", body: YT_PAGE }));

  await ctx.route("**://*.supabase.co/**", (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const method = request.method();
    let body = null;
    try { body = request.postData() ? JSON.parse(request.postData()) : null; } catch (_) { body = null; }
    calls.push({ method, path: url.pathname, search: url.search, body, at: Date.now() });
    const json = (value, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(value) });

    if (url.pathname.includes("/functions/v1/refresh-views")) {
      // Зависший необязательный шаг: запрос не получает ответа вовсе. Роут
      // держим, чтобы оборвать его в конце прогона.
      if (snapshotMode === "hang") { hungRoutes.push(route); return undefined; }
      return json({ ok: true });
    }
    if (url.pathname.endsWith("/rest/v1/collections")) return json([]);
    if (url.pathname.endsWith("/rest/v1/tags")) return json([]);
    if (url.pathname.endsWith("/rest/v1/thumbnails")) {
      if (method === "GET") {
        const video = decodeURIComponent((url.searchParams.get("video_id") || "").replace(/^eq\./, ""));
        const found = rows.find((row) => row.video_id === video);
        return json(found ? [{ id: found.id, note: found.note, thumbnail_collections: [], thumbnail_tags: [] }] : []);
      }
      if (method === "POST") {
        const created = { id: `2222222${rows.length}-2222-4222-8222-222222222222`, note: body?.note ?? "", video_id: body?.video_id ?? null };
        rows.push(created);
        return json([{ id: created.id }]);
      }
      if (method === "PATCH") return json([{ id: rows[0]?.id }]);
    }
    if (url.pathname.endsWith("/rpc/replace_thumbnail_links")) {
      return json({ thumbnail_id: body?.p_thumbnail_id ?? null, collections: null, tags: null });
    }
    return json({});
  });

  const worker = ctx.serviceWorkers()[0] || (await ctx.waitForEvent("serviceworker", { timeout: 15000 }));
  check("расширение загружено под ожидаемым ID из manifest.key", new URL(worker.url()).host === extensionId);
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
  // фона (наблюдалось на pub02: ReferenceError tvSessionRevision), поэтому
  // чтение защищено: необъявленная глобаль значит «ещё не готово», а не отказ.
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

  async function saveOn(videoId) {
    const page = await ctx.newPage();
    await page.goto(`https://www.youtube.com/watch?v=${videoId}`);
    await page.waitForSelector("#tv-save-btn", { timeout: 15000 });
    await page.click("#tv-save-btn");
    await page.waitForSelector("#tv-panel-host", { state: "attached" });
    let panel = null;
    for (let attempt = 0; attempt < 100 && !panel; attempt += 1) {
      panel = page.frames().find((frame) => frame.url().startsWith(`chrome-extension://${extensionId}/panel.html`)) || null;
      if (!panel) await page.waitForTimeout(50);
    }
    if (!panel) throw new Error("панель не загрузилась");
    await panel.waitForSelector("#tv-save:not(.tv-hidden)");
    await panel.waitForFunction(() => !document.getElementById("tv-save").disabled);
    const closed = page.waitForSelector("#tv-panel-host", { state: "detached", timeout: 30000 });
    const started = Date.now();
    await panel.click("#tv-save");
    await closed;
    const elapsed = Date.now() - started;
    await page.close();
    return elapsed;
  }

  // ------------------------------------------------ 1. быстрый snapshot
  snapshotMode = "fast";
  {
    const elapsed = await saveOn(FAST_VIDEO);
    check("быстрый snapshot: панель закрывается сразу", elapsed < FAST_MAX_MS, `${elapsed} ms`);
    check("быстрый snapshot: Edge Function вызвана ровно один раз", fnCalls().length === 1, String(fnCalls().length));
    check("быстрый snapshot: обложка сохранена один раз", thumbPosts().length === 1 && rows.length === 1, JSON.stringify(rows));
  }

  // ------------------------------------- 2. зависший snapshot в бюджете
  snapshotMode = "hang";
  const postsBefore = thumbPosts().length;
  const fnBefore = fnCalls().length;
  {
    const elapsed = await saveOn(SLOW_VIDEO);
    check(
      `зависший snapshot: панель закрылась в пределах бюджета ${BUDGET_MS} ms (+допуск ${TOLERANCE_MS} ms)`,
      elapsed >= BUDGET_MS - 500 && elapsed <= BUDGET_MS + TOLERANCE_MS,
      `${elapsed} ms`
    );
    check("зависший snapshot: обложка сохранена ровно один раз и не переписана",
      thumbPosts().length === postsBefore + 1 && rows.length === 2,
      JSON.stringify({ posts: thumbPosts().length, rows: rows.length }));
    check("зависший snapshot: Edge Function запрошена один раз и не повторена",
      fnCalls().length === fnBefore + 1, `${fnBefore} → ${fnCalls().length}`);
  }

  // Поздних повторов после закрытия панели быть не должно.
  const fnAfterClose = fnCalls().length;
  const postsAfterClose = thumbPosts().length;
  await new Promise((resolve) => setTimeout(resolve, 2000));
  check("после закрытия панели новых запросов не появилось",
    fnCalls().length === fnAfterClose && thumbPosts().length === postsAfterClose,
    JSON.stringify({ fn: fnCalls().length, posts: thumbPosts().length }));
  check("необработанных ошибок страницы не было", pageErrors.length === 0, JSON.stringify(pageErrors));
  check("наружу не ушло ничего мимо фикстур",
    blocked.every((url) => !/supabase\.co|youtube\.com|ytimg\.com/.test(url)),
    `оборвано ${blocked.length}`);

  const failed = results.filter((result) => !result.ok);
  console.log(`\n${results.length - failed.length}/${results.length} PASS`);
  process.exitCode = failed.length ? 1 : 0;
} finally {
  for (const route of hungRoutes) { try { await route.abort("blockedbyclient"); } catch (_) {} }
  await ctx?.close().catch(() => {});
  rmSync(profileDir, { recursive: true, force: true });
  rmSync(extDir, { recursive: true, force: true });
}

// PUB-07 в реальном Chromium. Проверяются ТРИ РАЗНЫХ утверждения, и они
// намеренно разведены — их смешение и было замечанием F3
// (CODEX-PUBLIC-PUB07-REVIEW-01):
//
//   A. enforcement ПОСЛЕ init текущего запуска: isolated content script не
//      читает слот, доверенный контекст расширения читает;
//   B. сохранение УРОВНЯ ДОСТУПА без нового setAccessLevel: третий запуск идёт
//      с подавленным вызовом, и отказ обязан держаться на прежнем pref;
//   C. сохранение СЕССИИ при обычном перезапуске браузера: наблюдается прямо, с
//      инструментированными причинами onInstalled. Если стенд воспроизводит
//      install, утверждение честно помечается UNVERIFIED и НЕ считается PASS.
//
// Запуск:
//   TV_CHROME=<chrome.exe> TV_PLAYWRIGHT_ROOT=<dir-with-node_modules>
//   node extensions/public/tests/pub07-storage-barrier.check.mjs
//
// Ничего настоящего: YouTube и Supabase подменены route-слоем, имена не
// разрешаются, расширение грузится из САНИРОВАННОЙ КОПИИ по пофайловому
// allowlist, реальный config.js не читается и не копируется, сессия — вымышленные
// значения, профиль — свежий временный каталог.
//
// Инструментация живёт ТОЛЬКО во временной копии; в extensions/public её нет:
//   `tv-probe.js`      — content script в isolated world того же расширения:
//                        снаружи в него не попасть, а отказ обязан получить
//                        именно он;
//   probe в background — второй слушатель onInstalled, который лишь ЗАПИСЫВАЕТ
//                        причину. Штатный install-сброс не подавляется;
//   suppress в oauth   — только для запуска B: вызов setAccessLevel не делается,
//                        чтобы проверялся исключительно сохранённый pref.
process.env.PW_EXPERIMENTAL_SERVICE_WORKER_NETWORK_EVENTS = "1";

import { createRequire } from "node:module";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve, dirname, basename, sep } from "node:path";
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

const extDir = mkdtempSync(join(tmpdir(), "tv-pub07-src-"));
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

// --- content-script пробник (fixture-only) --------------------------------
// Сам ничего не читает по своей инициативе: тест решает, когда спрашивать,
// чтобы вопрос задавался уже ПОСЛЕ завершения init.
writeFileSync(join(extDir, "tv-probe.js"), `// fixture-only, см. pub07-storage-barrier.check.mjs
window.addEventListener("message", async (event) => {
  if (event.source !== window || event.data?.type !== "tv-probe-read") return;
  const out = { key: event.data.key, ok: false, error: "", value: null };
  try {
    const got = await chrome.storage.local.get(event.data.key);
    out.ok = true;
    out.value = got?.[event.data.key] ?? null;
  } catch (err) {
    out.error = String(err && err.message ? err.message : err);
  }
  document.documentElement.setAttribute("data-tv-probe", JSON.stringify(out));
});
document.documentElement.setAttribute("data-tv-probe-ready", "1");
`);
manifest.content_scripts.push({
  matches: ["*://*.youtube.com/*"],
  js: ["tv-probe.js"],
  run_at: "document_idle",
});
writeFileSync(join(extDir, "manifest.json"), JSON.stringify(manifest, null, 2));

// --- инструментация onInstalled (fixture-only) ----------------------------
// ВТОРОЙ слушатель, только наблюдение. Штатный обработчик и install-сброс
// остаются на месте и не подавляются: иначе «зелёный» результат был бы куплен
// отключением проверяемого поведения.
const BACKGROUND_PATH = join(extDir, "background.js");
const PROBE_BACKGROUND = `

// fixture-only instrumentation, см. pub07-storage-barrier.check.mjs
chrome.runtime.onInstalled.addListener((details) => {
  // ОДНА операция записи под уникальным ключом. Прежний read-modify-write терял
  // событие: MV3 успевал усыпить worker между get и set, и причина не
  // фиксировалась вовсе.
  const key = "tv_probe_install_" + Date.now() + "_" + Math.random().toString(36).slice(2, 8);
  try {
    chrome.storage.local.set({ [key]: String(details && details.reason) });
  } catch (_) {}
});
`;
const backgroundPristine = readFileSync(BACKGROUND_PATH, "utf8");
writeFileSync(BACKGROUND_PATH, backgroundPristine + PROBE_BACKGROUND);

// --- подавление setAccessLevel для запуска B ------------------------------
//
// Это ОТДЕЛЬНЫЙ каталог расширения, а не подмена файла в прежнем: замена
// oauth.js между запусками в том же каталоге Chrome не подхватил (наблюдалось:
// счётчик подавления остался 0, барьер не запечатался). Ключ манифеста тот же,
// поэтому ID расширения и его prefs — те же самые, а значит проверяется именно
// сохранённый уровень доступа.
const extDirB = mkdtempSync(join(tmpdir(), "tv-pub07-supp-"));
const CALL_SITE = 'call = area.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" });';
function buildSuppressedCopy() {
  for (const rel of [...SANITIZED_FILES, "config.js", "tv-probe.js"]) {
    const target = join(extDirB, rel);
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(join(extDir, rel), target);
  }
  const oauth = readFileSync(join(extDirB, "oauth.js"), "utf8");
  if (oauth.split(CALL_SITE).length - 1 !== 1) {
    throw new Error("Не найден единственный вызов setAccessLevel — подавление отменено");
  }
  writeFileSync(join(extDirB, "oauth.js"), oauth.split(CALL_SITE).join(
    'self.TV_PROBE_ACCESS_SUPPRESSED = (self.TV_PROBE_ACCESS_SUPPRESSED || 0) + 1;'
    + ' call = Promise.reject(new Error("probe: setAccessLevel suppressed"));'
  ));
}

const digest = createHash("sha256").update(Buffer.from(manifest.key, "base64")).digest();
const extensionId = [...digest.subarray(0, 16)]
  .flatMap((byte) => [byte >> 4, byte & 15])
  .map((nibble) => String.fromCharCode(97 + nibble))
  .join("");

const results = [];
const check = (name, ok, detail = "") => {
  results.push({ ok, name });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
};
const unverified = [];
const markUnverified = (name, detail) => {
  unverified.push(name);
  console.log(`UNVERIFIED  ${name}${detail ? "  — " + detail : ""}`);
};

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64"
);
const VIDEO = "dQw4w9WgXcQ";
const YT_PAGE = `<!doctype html><html lang="fr"><head><meta charset="utf-8"><title>fixture</title></head>
<body><ytd-watch-metadata><div id="top-level-buttons-computed"></div></ytd-watch-metadata></body></html>`;

// Синтетическая сессия: ни одно значение не является настоящим credential.
const SESSION = {
  access_token: `probe-access-${"x".repeat(32)}`,
  refresh_token: `probe-refresh-${"y".repeat(32)}`,
  token_type: "bearer",
  expires_at: Math.floor(Date.now() / 1000) + 3600,
  user: { id: "33333333-3333-4333-8333-333333333333", email: "probe@example.invalid" },
};

const profileDir = mkdtempSync(join(tmpdir(), "tv-pub07-"));
// Оба каталога обязаны быть созданными НАМИ детьми системного Temp: удаляем их
// рекурсивно, поэтому проверяем и родителя, и имя.
for (const dir of [extDir, profileDir, extDirB]) {
  const root = resolve(tmpdir()) + sep;
  const abs = resolve(dir);
  if (!abs.startsWith(root)) throw new Error(`Каталог вне Temp, удаление отменено: ${abs}`);
  if (!basename(abs).startsWith("tv-pub07-")) throw new Error(`Чужое имя каталога: ${abs}`);
}

let rows = [];
const calls = [];
const blocked = [];
const pageErrors = [];
let ctx = null;

async function launch(dir = extDir) {
  const context = await chromium.launchPersistentContext(profileDir, {
    executablePath: CHROME,
    headless: false,
    args: [
      "--disable-features=DisableLoadExtensionCommandLineSwitch",
      "--host-resolver-rules=MAP * ~NOTFOUND",
      `--disable-extensions-except=${dir}`,
      `--load-extension=${dir}`,
    ],
  });
  context.on("weberror", (error) => pageErrors.push(String(error.error())));
  await context.route(/^https?:\/\//i, (route) => {
    blocked.push(route.request().url());
    return route.abort("blockedbyclient");
  });
  await context.route("**://i.ytimg.com/**", (route) => route.fulfill({ contentType: "image/png", body: PNG }));
  await context.route("**://*.youtube.com/**", (route) => route.fulfill({ contentType: "text/html", body: YT_PAGE }));
  await context.route("**://*.supabase.co/**", (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const method = request.method();
    let body = null;
    try { body = request.postData() ? JSON.parse(request.postData()) : null; } catch (_) { body = null; }
    calls.push({ method, path: url.pathname, search: url.search, at: Date.now() });
    const json = (value, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(value) });

    if (url.pathname.includes("/auth/v1/logout")) return json({}, 204);
    if (url.pathname.includes("/functions/v1/refresh-views")) return json({ ok: true });
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
    }
    if (url.pathname.endsWith("/rpc/replace_thumbnail_links")) {
      return json({ thumbnail_id: body?.p_thumbnail_id ?? null, collections: null, tags: null });
    }
    return json({});
  });
  const worker = context.serviceWorkers()[0] || (await context.waitForEvent("serviceworker", { timeout: 20000 }));
  return { context, worker };
}

// Спрашиваем isolated world через main world: пробник слушает postMessage.
async function probeRead(page, key) {
  await page.waitForFunction(() => document.documentElement.hasAttribute("data-tv-probe-ready"), null, { timeout: 15000 });
  await page.evaluate((k) => {
    document.documentElement.removeAttribute("data-tv-probe");
    window.postMessage({ type: "tv-probe-read", key: k }, "*");
  }, key);
  await page.waitForFunction(() => document.documentElement.hasAttribute("data-tv-probe"), null, { timeout: 15000 });
  return JSON.parse(await page.evaluate(() => document.documentElement.getAttribute("data-tv-probe")));
}

// Уровень доступа Chromium хранит в ExtensionPrefs (см. storage_utils.cc:
// storage_local_access_level). Читаем его прямо из СОЗДАННОГО НАМИ временного
// профиля: это прямое наблюдение сохранённого значения, не зависящее ни от
// расширения, ни от повторного вызова setAccessLevel.
function readStoredAccessLevel() {
  for (const rel of [["Default", "Preferences"], ["Default", "Secure Preferences"], ["Preferences"]]) {
    const file = join(profileDir, ...rel);
    let parsed;
    try {
      parsed = JSON.parse(readFileSync(file, "utf8"));
    } catch (_) {
      continue;
    }
    const settings = parsed?.extensions?.settings?.[extensionId];
    if (!settings) continue;
    const keys = Object.keys(settings).filter((key) => /access_level/i.test(key));
    if (keys.length) {
      return { file: rel.join("/"), found: true, values: Object.fromEntries(keys.map((key) => [key, settings[key]])) };
    }
    return { file: rel.join("/"), found: false, values: {} };
  }
  return { file: null, found: false, values: {} };
}

const slotState = (worker) => worker.evaluate(async () => {
  const all = await chrome.storage.local.get(null);
  return {
    session: all?.tv_session?.refresh_token || "",
    lang: all?.tv_lang || "",
    error: all?.tv_oauth_error || "",
    marker: all?.tv_probe_marker || "",
    installed: Object.keys(all || {})
      .filter((key) => key.startsWith("tv_probe_install_"))
      .sort()
      .map((key) => all[key]),
  };
});

try {
  // ======================================================= ЗАПУСК 1 (pristine)
  let launched = await launch();
  ctx = launched.context;
  let worker = launched.worker;

  const version = await ctx.newPage().then(async (page) => {
    const ua = await page.evaluate(() => navigator.userAgent);
    await page.close();
    return (ua.match(/Chrome\/([\d.]+)/) || [])[1] || "unknown";
  });
  console.log(`Chromium: ${version}`);
  console.log(`minimum_chrome_version в манифесте: ${manifest.minimum_chrome_version}`);
  check("расширение загружено под ожидаемым ID из manifest.key", new URL(worker.url()).host === extensionId);
  check("manifest объявляет minimum_chrome_version 140", manifest.minimum_chrome_version === "140");

  const area = await worker.evaluate(() => TV_SESSION_AREA);
  check("носитель на Chrome — storage.local", area === "local", area);
  const accessCalled = await worker.evaluate(() => self.TV_PROBE_ACCESS_SUPPRESSED || 0);
  check("запуск 1 идёт с НАСТОЯЩИМ setAccessLevel (подавления нет)", accessCalled === 0, String(accessCalled));

  // Успешная credential-операция через публичный API проходит ТОЛЬКО если барьер
  // готовности разрешён, то есть setAccessLevel в этом запуске действительно удался.
  const wrote = await worker.evaluate(async (session) => {
    try {
      await tvSetSession(session);
      const back = await tvGetSession();
      return { ok: true, same: back?.refresh_token === session.refresh_token };
    } catch (err) {
      return { ok: false, error: String(err?.message || err) };
    }
  }, SESSION);
  check("A: init завершён успешно — credential-операция прошла", wrote.ok && wrote.same, JSON.stringify(wrote));
  await worker.evaluate(() => chrome.storage.local.set({ tv_lang: "en" }));

  // ---------------------------------------- A: enforcement в ЭТОМ запуске
  const page = await ctx.newPage();
  await page.goto(`https://www.youtube.com/watch?v=${VIDEO}`);

  const probeSession = await probeRead(page, "tv_session");
  check(
    "A: isolated content script НЕ читает tv_session после init",
    probeSession.ok === false && /not allowed|denied|Access/i.test(probeSession.error) && probeSession.value === null,
    JSON.stringify(probeSession)
  );
  const probeLang = await probeRead(page, "tv_lang");
  check("A: область закрыта целиком — tv_lang из content script тоже недоступен", probeLang.ok === false, JSON.stringify(probeLang));

  const mainWorld = await page.evaluate(() => typeof chrome === "undefined" || typeof chrome?.storage === "undefined");
  check("A: page script вообще не имеет chrome.storage", mainWorld === true, String(mainWorld));

  const trusted = await worker.evaluate(async () => !!(await chrome.storage.local.get("tv_session"))?.tv_session?.refresh_token);
  check("A: доверенный контекст расширения читает слот по-прежнему", trusted === true);

  await page.waitForSelector("#tv-save-btn", { timeout: 20000 });
  check("A: триггер на host-странице собран", (await page.evaluate(() => !!document.getElementById("tv-save-btn"))) === true);
  check("A: html.lang host-страницы не переписан (PUB-01)", (await page.evaluate(() => document.documentElement.lang)) === "fr");

  // ---------------------------------------- save не сломан барьером
  await page.click("#tv-save-btn");
  await page.waitForSelector("#tv-panel-host", { state: "attached" });
  let panel = null;
  for (let attempt = 0; attempt < 100 && !panel; attempt += 1) {
    panel = page.frames().find((frame) => frame.url().startsWith(`chrome-extension://${extensionId}/panel.html`)) || null;
    if (!panel) await page.waitForTimeout(50);
  }
  check("A: панель открылась в той же вкладке", !!panel);
  if (panel) {
    await panel.waitForSelector("#tv-save:not(.tv-hidden)", { timeout: 20000 });
    await panel.waitForFunction(() => !document.getElementById("tv-save").disabled);
    const closed = page.waitForSelector("#tv-panel-host", { state: "detached", timeout: 30000 });
    await panel.click("#tv-save");
    await closed;
    check("A: save прошёл через барьер — обложка записана один раз", rows.length === 1, JSON.stringify(rows));
  }
  await page.close();

  // popup видит сессию и умеет выйти
  await worker.evaluate(async (session) => { await tvSetSession(session); }, SESSION);
  const popup = await ctx.newPage();
  try {
    await popup.goto(`chrome-extension://${extensionId}/popup.html`);
    await popup.waitForSelector("#account", { state: "visible", timeout: 20000 });
    check("A: popup видит сессию через барьер", true);
    await popup.waitForSelector("#logoutBtn", { state: "visible", timeout: 20000 });
    await popup.click("#logoutBtn");
    await popup.waitForSelector("#login", { state: "visible", timeout: 20000 });
    const cleared = await worker.evaluate(async () => !(await chrome.storage.local.get("tv_session"))?.tv_session);
    check("A: logout из popup очистил слот", cleared === true);
    const revoked = calls.filter((call) => call.path.includes("/auth/v1/logout"));
    check("A: logout отозвал сессию ровно с scope=local",
      revoked.length >= 1 && revoked.every((call) => call.search.includes("scope=local")),
      JSON.stringify(revoked.map((call) => call.search)));
  } catch (err) {
    check("A: login/logout через popup", false, String(err?.message || err).split("\n")[0]);
  } finally {
    await popup.close().catch(() => {});
  }

  // Готовим состояние для C: сессия + диагностический сентинел.
  await worker.evaluate(async (session) => {
    await tvSetSession(session);
    await chrome.storage.local.set({
      tv_oauth_error: "sentinel-before-restart",
      // Ключ НЕ из пары install-сброса: если он переживёт перезапуск, а пара
      // tv_session/tv_oauth_error нет, значит их именно УДАЛИЛИ, а не потеряли.
      tv_probe_marker: "written-with-session",
    });
  }, SESSION);
  // storage.local пишется асинхронно на диск. Успешный read-back доказывает
  // только память процесса, поэтому перед закрытием даём Chrome время дописать
  // и читаем ещё раз: иначе «слот не сохранился» означало бы потерю последней
  // записи стендом, а не поведение runtime.
  await new Promise((done) => setTimeout(done, 2000));
  const before = await slotState(worker);
  check("A: перед перезапуском слот, язык и сентинел на месте",
    before.session !== "" && before.lang !== "" && before.error !== "",
    JSON.stringify({ ...before, session: before.session ? "есть" : "пусто" }));
  const installedFirst = before.installed.slice();
  console.log(`onInstalled в запуске 1: ${JSON.stringify(installedFirst)}`);

  await ctx.close();
  ctx = null;

  // Профиль закрыт: уровень доступа обязан лежать в его prefs.
  const storedLevel = readStoredAccessLevel();
  console.log(`prefs расширения: ${storedLevel.file || "не найдены"} ${JSON.stringify(storedLevel.values)}`);
  check("B: уровень доступа СОХРАНЁН в prefs профиля после закрытия браузера",
    storedLevel.found === true, JSON.stringify(storedLevel));

  // ======================================================= ЗАПУСК 2 (pristine)
  // Утверждение C: что происходит с сессией при перезапуске браузера.
  launched = await launch();
  ctx = launched.context;
  worker = launched.worker;

  const after = await slotState(worker);
  const installedSecond = after.installed.slice(installedFirst.length);
  console.log(`onInstalled в запуске 2: ${JSON.stringify(installedSecond)}`);

  check("C: storage.local переживает перезапуск браузера", before.lang !== "" && after.lang === before.lang,
    `tv_lang: ${JSON.stringify(before.lang)} → ${JSON.stringify(after.lang)}`);

  if (after.session !== "" && after.session === before.session) {
    check("C: сессия переживает обычный перезапуск браузера", true,
      `onInstalled: ${JSON.stringify(installedSecond)}`);
  } else if (after.marker === before.marker && after.marker !== "") {
    // Маркер записан ТЕМ ЖЕ вызовом, что и сессия, и он уцелел — значит запись
    // до диска дошла, а пару tv_session/tv_oauth_error кто-то удалил.
    if (installedSecond.length) {
      markUnverified("C: сохранение сессии при обычном перезапуске",
        `пара ключей удалена, onInstalled=${JSON.stringify(installedSecond)} — стенд воспроизвёл переустановку, а не обычный restart`);
    } else {
      // Удалена РОВНО пара install-сброса (tv_session + tv_oauth_error), а
      // записанный тем же вызовом маркер уцелел. Отпечаток совпадает, но само
      // событие не зафиксировано, поэтому причину объявлять доказанной нельзя —
      // и PASS здесь тем более невозможен. Gate остаётся открытым.
      markUnverified("C: сохранение сессии при обычном перезапуске",
        "удалена ровно пара install-сброса при уцелевшем маркере, но событие onInstalled не зафиксировано — причина не установлена");
    }
  } else if (installedSecond.includes("install")) {
    // Причина наблюдена прямо, а не выведена из исчезновения ключей. Это
    // объясняет пустой слот, но НЕ доказывает заявленную persistence: стенд с
    // --load-extension ставит расширение заново и штатный install-сброс
    // срабатывает законно. Обычный перезапуск УЖЕ установленного расширения
    // этим стендом не моделируется.
    markUnverified("C: сохранение сессии при обычном перезапуске",
      `слот пуст, onInstalled=${JSON.stringify(installedSecond)} — стенд воспроизвёл install, а не обычный restart`);
  } else {
    // Ни сессии, ни сентинела, при живом языке и без install: последняя запись
    // не дошла до диска. Это предел стенда, а не наблюдение о runtime, и PASS
    // здесь был бы подлогом.
    markUnverified("C: сохранение сессии при обычном перезапуске",
      `слот, сентинел и маркер пусты, onInstalled=${JSON.stringify(installedSecond)} — последняя запись storage не дошла до диска в этом стенде`);
  }

  // Ещё раз enforcement — но это по-прежнему утверждение A для нового запуска,
  // потому что setAccessLevel здесь вызывался.
  const page2 = await ctx.newPage();
  await page2.goto(`https://www.youtube.com/watch?v=${VIDEO}`);
  const probeAfter = await probeRead(page2, "tv_session");
  check("A: enforcement держится и в новом запуске", probeAfter.ok === false && probeAfter.value === null, JSON.stringify(probeAfter));
  await page2.close();

  await ctx.close();
  ctx = null;

  // ============================ ЗАПУСК 3 (setAccessLevel подавлен) — B
  buildSuppressedCopy();
  launched = await launch(extDirB);
  ctx = launched.context;
  worker = launched.worker;

  const suppressed = await worker.evaluate(() => self.TV_PROBE_ACCESS_SUPPRESSED || 0);
  const sealed = await worker.evaluate(async () => {
    try {
      await tvGetSession();
      return "прошло";
    } catch (err) {
      return String(err?.message || err);
    }
  });
  const suppressionApplied = suppressed === 1;
  if (suppressionApplied) {
    check("B: вызов setAccessLevel в этом запуске подавлен", true, String(suppressed));
    check("B: без подтверждения защиты credential-операции запечатаны",
      /storage protection unavailable/.test(sealed), sealed);
  } else {
    // Chrome оставил зарегистрированным расширение из первого каталога, поэтому
    // подменённая копия не загрузилась. Тогда отказ ниже НЕ изолирует
    // сохранённый уровень от нового вызова, и объявлять его доказательством
    // нельзя: доказательством остаётся pref на диске выше.
    markUnverified("B: изоляция от нового setAccessLevel в отдельном запуске",
      `подавление не применилось (счётчик ${suppressed}, credential-путь: ${sealed}) — Chrome загрузил ранее зарегистрированную копию`);
  }

  const page3 = await ctx.newPage();
  await page3.goto(`https://www.youtube.com/watch?v=${VIDEO}`);
  const probeNoCall = await probeRead(page3, "tv_session");
  const probeNoCallLang = await probeRead(page3, "tv_lang");
  const denied = probeNoCall.ok === false && probeNoCall.value === null && probeNoCallLang.ok === false;
  if (suppressionApplied) {
    check("B: уровень доступа сохранился БЕЗ нового setAccessLevel", denied,
      JSON.stringify({ session: probeNoCall, lang: probeNoCallLang }));
  } else {
    check("A: enforcement держится и в третьем запуске", denied,
      JSON.stringify({ session: probeNoCall, lang: probeNoCallLang }));
  }
  await page3.close();

  check("необработанных ошибок страницы не было", pageErrors.length === 0, JSON.stringify(pageErrors.slice(0, 3)));
  check("наружу не ушло ничего мимо фикстур",
    blocked.every((url) => !/supabase\.co|youtube\.com|ytimg\.com/.test(url)),
    `оборвано ${blocked.length}`);
  console.log("NOTE  assertion о трафике смотрит перехваченные запросы, а не весь транспорт браузера.");

  const failed = results.filter((result) => !result.ok);
  console.log(`\n${results.length - failed.length}/${results.length} PASS`);
  if (failed.length) console.log(`FAILED: ${failed.map((item) => item.name).join(" | ")}`);
  if (unverified.length) console.log(`UNVERIFIED (${unverified.length}): ${unverified.join(" | ")}`);
  process.exitCode = failed.length ? 1 : 0;
} finally {
  await ctx?.close().catch(() => {});
  // Абсолютные пути и имена проверены выше; отказ удаления не должен подменять
  // настоящую причину падения.
  for (const dir of [profileDir, extDir, extDirB]) {
    console.log(`cleanup: ${dir}`);
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch (err) {
      console.log(`cleanup не удался, каталог остался: ${dir} — ${String(err?.code || err)}`);
    }
  }
}

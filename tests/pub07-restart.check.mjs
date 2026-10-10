// PUB-07, утверждение C: сессия переживает ОБЫЧНЫЙ перезапуск браузера с уже
// установленным расширением.
//
//   TV_CHROME=<chrome> TV_PLAYWRIGHT_ROOT=<dir-with-node_modules>
//   node extensions/public/tests/pub07-restart.check.mjs
//
// Почему не --load-extension (как pub07-storage-barrier): этот флаг ставит
// расширение заново при КАЖДОМ запуске, onInstalled приходит с reason=install,
// и штатный install-сброс законно чистит слот. Обычный restart им не
// смоделировать — pub07-storage-barrier честно метит C как UNVERIFIED.
//
// Здесь расширение ставится в профиль ОДИН раз, как «Load unpacked», через
// CDP Extensions.loadUnpacked. Команда есть только на browser-level сессии и
// только при --enable-unsafe-extension-debugging. Playwright
// launchPersistentContext такой сессии не даёт (context.browser() у
// persistent-контекста — null), поэтому Chromium запускается напрямую
// (child_process.spawn) с --remote-debugging-pipe, а Playwright подключается
// к этому каналу через chromium.connectOverCDP(transport).
//
//   Запуск 1: loadUnpacked → ID из manifest.key; синтетическая сессия
//             записывается через API расширения (tvSetSession), как в pub07;
//             браузер закрывается CDP Browser.close, ждём выхода процесса
//             (browser.close() у connectOverCDP только отключается — это не
//             закрытие).
//   Запуск 2: ТОТ ЖЕ профиль, без loadUnpacked, без --load-extension и без
//             --enable-unsafe-extension-debugging. Расширение будится
//             открытием его страницы popup.html; затем слот и записи пробника
//             onInstalled читаются из доверенного контекста.
//
// Режим разработчика включается до установки (как это обязан сделать
// пользователь, чтобы увидеть «Load unpacked») через developerPrivate
// страницы chrome://extensions.
//
// Наблюдённый предел стенда (10.10.2026). На Chromium 140 установка через CDP
// записывается в Default/Secure Preferences как unpacked (location 4,
// creation_flags 38) и переживает перезапуск — проверка полноценная. На
// Chromium 151 та же команда пишет creation_flags 32806 (лишний бит 0x8000), и
// после Browser.close и запуска того же профиля запись расширения из prefs
// ИСЧЕЗАЕТ: chrome://extensions пуст, страница расширения —
// ERR_BLOCKED_BY_CLIENT. То есть на 151 установка через CDP переживает
// перезапуск не так, как ручная «Load unpacked», и обычный restart этим
// способом не моделируется; значение бита здесь не установлено. Скрипт в
// этом случае выдаёт UNVERIFIED с этими данными и НЕ считает его PASS.
//
//   PASS — слот с той же синтетической сессией цел, и после перезапуска НЕТ
//          новой записи onInstalled (допустима ровно одна install — от
//          первой установки);
//   FAIL — слот потерян / появился новый install, с данными;
//   UNVERIFIED — стенд не смог установить или разбудить расширение (с точным
//          местом отказа).
//
// Граница та же, что у pub07-storage-barrier: САНИРОВАННАЯ КОПИЯ по
// tools/runtime-files.mjs, синтетический config, вымышленная сессия, свежий
// временный профиль, сеть — route-слой + --host-resolver-rules=MAP * ~NOTFOUND.
// Инструментация (второй слушатель onInstalled, который лишь ЗАПИСЫВАЕТ
// причину) — только во временной копии.
//
// Коды выхода: 0 — PASS; 1 — FAIL; 2 — неверный вызов; 3 — UNVERIFIED.
process.env.PW_EXPERIMENTAL_SERVICE_WORKER_NETWORK_EVENTS = "1";

import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve, dirname, basename, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { NEVER, RUNTIME } from "../tools/runtime-files.mjs";

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

const PREFIX = "tv-restart-";
const extDir = mkdtempSync(join(tmpdir(), `${PREFIX}src-`));
const profileDir = mkdtempSync(join(tmpdir(), PREFIX));
for (const dir of [extDir, profileDir]) {
  const abs = resolve(dir);
  if (!abs.startsWith(resolve(tmpdir()) + sep)) throw new Error(`Каталог вне Temp, удаление отменено: ${abs}`);
  if (!basename(abs).startsWith(PREFIX)) throw new Error(`Чужое имя каталога: ${abs}`);
}

for (const rel of RUNTIME) {
  if (NEVER.has(rel.split("/").pop()) || rel === "config.example.js") throw new Error(`Файл ${rel} копировать запрещено`);
  const target = join(extDir, ...rel.split("/"));
  mkdirSync(dirname(target), { recursive: true });
  copyFileSync(join(SRC, ...rel.split("/")), target);
}
const manifest = JSON.parse(readFileSync(join(extDir, "manifest.json"), "utf8"));
const SB_ORIGIN = new URL(manifest.host_permissions[0].replace(/\*$/, "")).origin;
writeFileSync(join(extDir, "config.js"), `(globalThis.window || globalThis).THUMBVAULT_CONFIG = {
  SUPABASE_URL: "${SB_ORIGIN}",
  SUPABASE_ANON_KEY: "synthetic-anon-key-${"k".repeat(40)}",
  AUTH_SITE_URL: "https://thumbsight.invalid",
};
`);

// Второй слушатель onInstalled, только наблюдение (как в pub07): одна запись
// под уникальным ключом. Штатный обработчик и install-сброс не подавляются.
const BACKGROUND_PATH = join(extDir, "background.js");
writeFileSync(BACKGROUND_PATH, readFileSync(BACKGROUND_PATH, "utf8") + `

// fixture-only instrumentation, см. pub07-restart.check.mjs
chrome.runtime.onInstalled.addListener((details) => {
  const key = "tv_probe_install_" + Date.now() + "_" + Math.random().toString(36).slice(2, 8);
  try {
    chrome.storage.local.set({ [key]: String(details && details.reason) });
  } catch (_) {}
});
`);

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
class StandError extends Error {}

// Синтетическая сессия: ни одно значение не является настоящим credential.
const SESSION = {
  access_token: `probe-access-${"x".repeat(32)}`,
  refresh_token: `probe-refresh-${"y".repeat(32)}`,
  token_type: "bearer",
  expires_at: Math.floor(Date.now() / 1000) + 3600,
  user: { id: "33333333-3333-4333-8333-333333333333", email: "probe@example.invalid" },
};

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

// ------------------------------------------------------------- запуск Chromium
let current = null; // { proc, browser, cdp, exited }
// stderr Chromium (нужен --enable-logging=stderr) — для диагностики отказа
// стенда; печатаются только строки про расширения, путь копии скрыт.
const chromeLog = {};
const extensionLogLines = (label) => (chromeLog[label] || "")
  .split(/\r?\n/)
  .filter((line) => line.includes(extensionId) || line.includes(extDir) || /unpacked/i.test(line))
  .map((line) => line.split(extDir).join("<временная копия>").slice(0, 300))
  .slice(0, 10);

// CDP поверх --remote-debugging-pipe: Chromium читает команды из fd 3 и пишет
// ответы в fd 4, сообщения — JSON, разделитель — нулевой байт. Playwright
// принимает такой канал как ConnectOverCDPTransport.
function pipeTransport(proc) {
  const toChrome = proc.stdio[3];
  const fromChrome = proc.stdio[4];
  const transport = {
    send(message) {
      toChrome.write(JSON.stringify(message) + "\0");
    },
    close() {
      try { toChrome.end(); } catch (_) {}
    },
    onmessage: undefined,
    onclose: undefined,
  };
  let pending = Buffer.alloc(0);
  fromChrome.on("data", (chunk) => {
    pending = Buffer.concat([pending, chunk]);
    let end;
    while ((end = pending.indexOf(0)) !== -1) {
      const text = pending.subarray(0, end).toString("utf8");
      pending = pending.subarray(end + 1);
      transport.onmessage?.(JSON.parse(text));
    }
  });
  fromChrome.on("close", () => transport.onclose?.("pipe closed"));
  toChrome.on("error", () => {});
  return transport;
}

async function startChrome(label, { unsafeExtensionDebugging = false } = {}) {
  const proc = spawn(CHROME, [
    `--user-data-dir=${profileDir}`,
    // Не порт: на Chromium 140 Extensions.loadUnpacked по
    // --remote-debugging-port отвечает «Method not available» (наблюдалось),
    // документирован он для --remote-debugging-pipe.
    "--remote-debugging-pipe",
    "--no-first-run",
    "--no-default-browser-check",
    "--noerrdialogs",
    "--enable-logging=stderr",
    "--disable-background-networking",
    "--disable-component-update",
    "--disable-sync",
    ...(unsafeExtensionDebugging ? ["--enable-unsafe-extension-debugging"] : []),
    "--host-resolver-rules=MAP * ~NOTFOUND",
    "about:blank",
  ], { stdio: ["ignore", "ignore", "pipe", "pipe", "pipe"], windowsHide: false });
  proc.stderr.setEncoding("utf8");
  proc.stderr.on("data", (chunk) => { chromeLog[label] = (chromeLog[label] || "") + chunk; });
  const exited = new Promise((done) => proc.once("exit", (code, signal) => done({ code, signal })));
  let browser;
  try {
    browser = await chromium.connectOverCDP(pipeTransport(proc), { timeout: 20000 });
  } catch (err) {
    proc.kill();
    throw new StandError(`${label}: подключение CDP по pipe — ${String(err?.message || err).split("\n")[0]}`);
  }
  const cdp = await browser.newBrowserCDPSession();
  const context = browser.contexts()[0];
  const blocked = [];
  await context.route(/^https?:\/\//i, (route) => {
    blocked.push(route.request().url());
    return route.abort("blockedbyclient");
  });
  // Supabase отвечает фикстурой, чтобы popup не принял сетевой отказ за
  // повод что-то менять в слоте. Наружу запросы всё равно не уходят.
  await context.route("**://*.supabase.co/**", (route) => route.fulfill({
    status: 200, contentType: "application/json", body: "{}",
  }));
  current = { proc, browser, cdp, context, exited, blocked };
  return current;
}

async function closeChrome(label) {
  const run = current;
  if (!run) return null;
  current = null;
  // Browser.close закрывает процесс; ответ на команду может не успеть прийти.
  await run.cdp.send("Browser.close").catch(() => {});
  const outcome = await Promise.race([run.exited, sleep(20000).then(() => null)]);
  await run.browser.close().catch(() => {});
  if (!outcome) {
    run.proc.kill();
    await run.exited;
    console.log(`${label}: Chromium не вышел за 20 с после Browser.close — процесс убит`);
    return { clean: false };
  }
  console.log(`${label}: Chromium вышел после Browser.close (код ${outcome.code})`);
  return { clean: true, code: outcome.code, blocked: run.blocked };
}

const extWorker = async (context, timeout) => {
  const isOurs = (w) => w.url().startsWith(`chrome-extension://${extensionId}/`);
  const found = context.serviceWorkers().find(isOurs);
  if (found) return found;
  return context.waitForEvent("serviceworker", { predicate: isOurs, timeout }).catch(() => null);
};

const readSlot = (target) => target.evaluate(async () => {
  const all = await chrome.storage.local.get(null);
  return {
    session: all?.tv_session?.refresh_token || "",
    error: all?.tv_oauth_error || "",
    marker: all?.tv_probe_marker || "",
    lang: all?.tv_lang || "",
    installed: Object.keys(all || {})
      .filter((key) => key.startsWith("tv_probe_install_"))
      .sort()
      .map((key) => all[key]),
  };
});

// Что о расширениях знает chrome://extensions (developerPrivate — доверенный
// API этой страницы): состояние, причины отключения, режим разработчика.
async function extensionsInfo(context, { developerMode } = {}) {
  const page = await context.newPage();
  try {
    await page.goto("chrome://extensions/");
    return await page.evaluate(async ({ id, developerMode }) => {
      const api = chrome.developerPrivate;
      if (developerMode !== undefined) await api.updateProfileConfiguration({ inDeveloperMode: developerMode });
      const config = await api.getProfileConfiguration();
      const items = await api.getExtensionsInfo({ includeDisabled: true, includeTerminated: true });
      const item = items.find((entry) => entry.id === id) || null;
      return {
        inDeveloperMode: config.inDeveloperMode,
        items: items.length,
        ours: item && {
          state: item.state, location: item.location, version: item.version,
          disableReasons: Object.entries(item.disableReasons || {}).filter(([, on]) => on).map(([name]) => name),
        },
      };
    }, { id: extensionId, developerMode });
  } finally {
    await page.close().catch(() => {});
  }
}

// Расположение и состояние в prefs закрытого профиля: прямое наблюдение
// того, как Chromium записал установку. Путь копии не печатается.
function readExtensionPrefs() {
  for (const rel of [["Default", "Secure Preferences"], ["Default", "Preferences"]]) {
    try {
      const settings = JSON.parse(readFileSync(join(profileDir, ...rel), "utf8"))?.extensions?.settings?.[extensionId];
      if (settings) {
        return {
          file: rel.join("/"),
          location: settings.location,
          state: settings.state,
          disable_reasons: settings.disable_reasons,
          creation_flags: settings.creation_flags,
        };
      }
    } catch (_) {}
  }
  return null;
}

let fullVersion = "unknown";
try {
  // ===================================================== ЗАПУСК 1: установка
  let run;
  try {
    run = await startChrome("запуск 1", { unsafeExtensionDebugging: true });
  } catch (err) {
    throw err instanceof StandError ? err : new StandError(`запуск 1: подключение CDP — ${String(err?.message || err).split("\n")[0]}`);
  }
  const version = await run.cdp.send("Browser.getVersion");
  fullVersion = (version.product || "").replace(/^[^/]*\//, "") || "unknown";
  console.log(`Chromium: ${fullVersion}`);

  // Пользователь, ставящий распакованное расширение, обязан включить «Режим
  // разработчика» в chrome://extensions — без него кнопки «Load unpacked» нет.
  // Делаем то же самое тем же API, что и переключатель страницы. Без этого шага
  // (наблюдалось на 151) Chromium после перезапуска распакованное расширение
  // не поднимает вовсе: в chrome://extensions 0 элементов, страница
  // расширения — ERR_BLOCKED_BY_CLIENT.
  const devMode = await extensionsInfo(run.context, { developerMode: true });
  console.log(`chrome://extensions до установки: ${JSON.stringify(devMode)}`);
  if (devMode.inDeveloperMode !== true) throw new StandError("запуск 1: режим разработчика не включился");

  let loaded;
  try {
    loaded = await run.cdp.send("Extensions.loadUnpacked", { path: extDir });
  } catch (err) {
    throw new StandError(`CDP Extensions.loadUnpacked (browser-level): ${String(err?.message || err).split("\n")[0]}`);
  }
  console.log(`Extensions.loadUnpacked → ${JSON.stringify(loaded)}`);
  check("loadUnpacked установил расширение под ожидаемым ID из manifest.key", loaded?.id === extensionId,
    `${loaded?.id} / ${extensionId}`);

  let worker = await extWorker(run.context, 20000);
  if (!worker) throw new StandError("запуск 1: service worker после loadUnpacked не появился за 20 с");

  // Сессия пишется ПОСЛЕ того, как onInstalled(install) отработал: так входит
  // настоящий пользователь — через секунды после установки. Без ожидания на
  // Chromium 140 событие приходило уже после записи, и штатный install-сброс
  // стирал только что записанную сессию (наблюдалось: слот пуст, а записанные
  // следом сентинел и маркер целы). Пробник пишет причину вторым слушателем,
  // то есть после того, как штатный слушатель уже поставил барьер сброса.
  const installSeen = await worker.evaluate(async () => {
    for (let i = 0; i < 200; i += 1) {
      const all = await chrome.storage.local.get(null);
      const reasons = Object.keys(all || {}).filter((key) => key.startsWith("tv_probe_install_")).map((key) => all[key]);
      if (reasons.length) return reasons;
      await new Promise((done) => setTimeout(done, 100));
    }
    return [];
  });
  if (!installSeen.length) throw new StandError("запуск 1: onInstalled за 20 с не зафиксирован пробником");

  const wrote = await worker.evaluate(async (session) => {
    try {
      await tvSetSession(session);
      await chrome.storage.local.set({
        tv_oauth_error: "sentinel-before-restart",
        tv_probe_marker: "written-with-session",
        tv_lang: "en",
      });
      const back = await tvGetSession();
      return { ok: true, same: back?.refresh_token === session.refresh_token };
    } catch (err) {
      return { ok: false, error: String(err?.message || err) };
    }
  }, SESSION);
  check("запуск 1: сессия записана через API расширения (барьер пройден)", wrote.ok && wrote.same, JSON.stringify(wrote));
  // storage.local дописывается на диск асинхронно — как в pub07, ждём и
  // перечитываем, прежде чем закрывать.
  await sleep(2000);
  const before = await readSlot(worker);
  check("запуск 1: слот, сентинел и маркер на месте перед закрытием",
    before.session === SESSION.refresh_token && before.error !== "" && before.marker !== "",
    JSON.stringify({ ...before, session: before.session ? "есть" : "пусто" }));
  console.log(`onInstalled в запуске 1: ${JSON.stringify(before.installed)}`);
  check("запуск 1: onInstalled зафиксирован ровно один раз, reason=install",
    JSON.stringify(before.installed) === JSON.stringify(["install"]), JSON.stringify(before.installed));

  const closed1 = await closeChrome("запуск 1");
  check("запуск 1: браузер закрыт штатно (Browser.close, процесс вышел)", closed1?.clean === true, JSON.stringify(closed1?.code ?? null));
  const prefs = readExtensionPrefs();
  console.log(`prefs расширения после запуска 1: ${JSON.stringify(prefs)}`);

  // ============================================ ЗАПУСК 2: обычный перезапуск
  try {
    run = await startChrome("запуск 2");
  } catch (err) {
    throw err instanceof StandError ? err : new StandError(`запуск 2: подключение CDP — ${String(err?.message || err).split("\n")[0]}`);
  }
  // Ни loadUnpacked, ни --load-extension. Будим расширение его страницей.
  const page = await run.context.newPage();
  let opened = null;
  try {
    const response = await page.goto(`chrome-extension://${extensionId}/popup.html`, { timeout: 20000 });
    opened = { ok: true, status: response?.status() ?? null, title: await page.title() };
  } catch (err) {
    opened = { ok: false, error: String(err?.message || err).split("\n")[0] };
  }
  if (!opened.ok) {
    const seen = await extensionsInfo(run.context).catch((err) => ({ error: String(err?.message || err).split("\n")[0] }));
    console.log(`chrome://extensions после перезапуска: ${JSON.stringify(seen)}`);
    await closeChrome("запуск 2");
    for (const line of extensionLogLines("запуск 2")) console.log(`stderr Chromium (запуск 2): ${line}`);
    console.log(`prefs расширения после запуска 2: ${JSON.stringify(readExtensionPrefs())}`);
    throw new StandError(`запуск 2: страница расширения не открылась — ${opened.error}`);
  }
  check("запуск 2: страница расширения открылась без повторной установки — расширение пережило перезапуск",
    true, JSON.stringify(opened));
  console.log(`chrome://extensions после перезапуска: ${JSON.stringify(await extensionsInfo(run.context))}`);

  // Слот читается со страницы расширения (доверенный контекст) — сразу, до
  // любых действий пользователя; затем то же из service worker.
  const fromPage = await readSlot(page);
  worker = await extWorker(run.context, 20000);
  const fromWorker = worker ? await readSlot(worker) : null;
  console.log(`service worker после пробуждения: ${worker ? worker.url() : "не появился за 20 с"}`);
  const after = fromPage;
  console.log(`onInstalled всего после перезапуска: ${JSON.stringify(after.installed)}`);
  const newInstalls = after.installed.slice(before.installed.length);

  check("запуск 2: storage.local пережил перезапуск (tv_lang)", after.lang === before.lang,
    `${JSON.stringify(before.lang)} → ${JSON.stringify(after.lang)}`);
  check("запуск 2: после перезапуска нет новой записи onInstalled",
    newInstalls.length === 0 && JSON.stringify(after.installed) === JSON.stringify(["install"]),
    `новые: ${JSON.stringify(newInstalls)}`);
  check("C: сессия пережила обычный перезапуск браузера (тот же синтетический refresh_token)",
    after.session === SESSION.refresh_token,
    `слот: ${after.session ? (after.session === SESSION.refresh_token ? "тот же" : "другой") : "пуст"}; сентинел: ${after.error ? "цел" : "пуст"}; маркер: ${after.marker ? "цел" : "пуст"}`);
  if (fromWorker) {
    check("запуск 2: service worker видит ту же сессию", fromWorker.session === SESSION.refresh_token,
      fromWorker.session ? "есть" : "пусто");
  } else {
    console.log("NOTE  service worker не появился — слот прочитан только со страницы расширения");
  }
  const accountShown = await page.locator("#account").isVisible().catch(() => false);
  console.log(`popup показывает аккаунт: ${accountShown}`);
  await page.close().catch(() => {});

  const closed2 = await closeChrome("запуск 2");
  check("наружу не ушло ничего мимо route-слоя",
    [...(closed1?.blocked || []), ...(closed2?.blocked || [])].every((url) => !/supabase\.co|youtube\.com|ytimg\.com/.test(url)),
    `оборвано ${(closed1?.blocked || []).length + (closed2?.blocked || []).length}`);
} catch (err) {
  if (err instanceof StandError) {
    markUnverified("C: сохранение сессии при обычном перезапуске", `стенд: ${err.message}`);
  } else {
    check("стенд выполнился без исключений", false, String(err?.stack || err).split("\n").slice(0, 3).join(" | "));
  }
} finally {
  if (current) await closeChrome("уборка");
  for (const dir of [profileDir, extDir]) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
      console.log(`cleanup: ${dir}`);
    } catch (err) {
      console.log(`cleanup не удался, каталог остался: ${dir} — ${String(err?.code || err)}`);
    }
  }
}

const failed = results.filter((result) => !result.ok);
console.log(`\n${results.length - failed.length}/${results.length} PASS`);
if (failed.length) console.log(`FAILED: ${failed.map((item) => item.name).join(" | ")}`);
if (unverified.length) console.log(`UNVERIFIED (${unverified.length}): ${unverified.join(" | ")}`);
const verdict = failed.length ? "FAIL" : unverified.length ? "UNVERIFIED" : "PASS";
console.log(`GATE restart Chromium ${fullVersion}: ${verdict}`);
process.exitCode = failed.length ? 1 : unverified.length ? 3 : 0;

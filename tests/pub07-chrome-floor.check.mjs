// PUB-07 / PUB-04: нижняя граница Chrome из manifest.minimum_chrome_version.
//
//   TV_CHROME=<chrome> TV_PLAYWRIGHT_ROOT=<dir-with-node_modules>
//   node extensions/public/tests/pub07-chrome-floor.check.mjs --expect loaded|refused [--min-chrome <N>]
//
//   --expect loaded   service worker расширения появился (ждём до 20 с), его ID
//                     совпадает с ID из manifest.key, а getManifest().version из
//                     самого worker равна версии манифеста копии;
//   --expect refused  за 20 с worker НЕ появился И найден текст отказа Chromium
//                     именно по минимальной версии (с тем же номером, что в
//                     манифесте). Без текста отказ НЕ считается доказанным:
//                     вердикт UNVERIFIED, а не PASS;
//   --min-chrome <N>  контрольная проба: во ВРЕМЕННОЙ копии поле
//                     minimum_chrome_version заменяется на N. Если на том же
//                     браузере с N расширение грузится, а с исходным значением
//                     нет, — отказ вызван именно полем манифеста, а не стендом.
//
// Где Chromium сообщает причину отказа. Для --load-extension страница
// chrome://extensions ничего не показывает: несостоявшееся расширение не
// становится элементом списка (проверяется и печатается ниже). Причину
// Chromium пишет своим LoadErrorReporter в stderr браузера:
//   "Extension error: Failed to load extension from: <копия>. <причина>"
// Этот stderr Playwright отдаёт только в канал отладки pw:browser, поэтому
// канал включается, а его строки перехватываются и не печатаются целиком.
// Ту же причину Chromium без --noerrdialogs показывает нативным модальным
// окном «Error Loading Extension» — оно не DOM и блокирует запуск, поэтому
// здесь выключено (см. args ниже).
//
// Граница та же, что у pub07-storage-barrier: расширение грузится из
// САНИРОВАННОЙ КОПИИ по пофайловому списку tools/runtime-files.mjs, настоящий
// config.js не читается и не копируется (в копии — синтетический), профиль —
// свежий временный каталог, сеть оборвана route-слоем и
// --host-resolver-rules=MAP * ~NOTFOUND.
//
// Коды выхода: 0 — PASS; 1 — FAIL; 2 — неверный вызов; 3 — UNVERIFIED.
process.env.DEBUG = [process.env.DEBUG, "pw:browser"].filter(Boolean).join(",");

import { createRequire } from "node:module";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve, dirname, basename, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { NEVER, RUNTIME } from "../tools/runtime-files.mjs";

// --- stderr браузера (канал pw:browser) — в память, не на экран -------------
const browserLog = [];
const passThrough = process.stderr.write.bind(process.stderr);
process.stderr.write = (chunk, ...rest) => {
  const text = String(chunk);
  if (text.includes("pw:browser")) {
    browserLog.push(text);
    return true;
  }
  return passThrough(chunk, ...rest);
};

const require = createRequire(
  process.env.TV_PLAYWRIGHT_ROOT
    ? join(resolve(process.env.TV_PLAYWRIGHT_ROOT), "package.json")
    : import.meta.url
);
const { chromium } = require("playwright-core");

const usage = () => {
  console.error("Вызов: node tests/pub07-chrome-floor.check.mjs --expect loaded|refused [--min-chrome <N>]");
  process.exit(2);
};
const argv = process.argv.slice(2);
let expect = null;
let minOverride = null;
for (let i = 0; i < argv.length; i += 1) {
  if (argv[i] === "--expect") expect = argv[++i];
  else if (argv[i] === "--min-chrome") minOverride = argv[++i];
  else usage();
}
if (expect !== "loaded" && expect !== "refused") usage();
if (minOverride !== null && !/^\d{2,4}$/.test(minOverride)) usage();

const SRC = process.env.TV_EXT || resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CHROME = process.env.TV_CHROME;
if (!CHROME) {
  console.error("Задай TV_CHROME — путь к бинарнику Chrome/Chromium.");
  process.exit(2);
}

const PREFIX = "tv-floor-";
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
const declaredMin = manifest.minimum_chrome_version;
if (minOverride !== null) {
  manifest.minimum_chrome_version = minOverride;
  writeFileSync(join(extDir, "manifest.json"), JSON.stringify(manifest, null, 2));
}
const SB_ORIGIN = new URL(manifest.host_permissions[0].replace(/\*$/, "")).origin;
writeFileSync(join(extDir, "config.js"), `(globalThis.window || globalThis).THUMBVAULT_CONFIG = {
  SUPABASE_URL: "${SB_ORIGIN}",
  SUPABASE_ANON_KEY: "synthetic-anon-key-${"k".repeat(40)}",
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
  results.push({ ok, name });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
};
const unverified = [];
const markUnverified = (name, detail) => {
  unverified.push(name);
  console.log(`UNVERIFIED  ${name}${detail ? "  — " + detail : ""}`);
};

// Строки LoadErrorReporter про НАШУ копию: путь копии уникален (mkdtemp).
function loadErrors() {
  const tag = basename(extDir);
  return browserLog
    .join("")
    .split(/\r?\n/)
    .filter((line) => /Extension error:/.test(line) && line.includes(tag))
    .map((line) => line.slice(line.indexOf("Extension error:")));
}

let ctx = null;
try {
  ctx = await chromium.launchPersistentContext(profileDir, {
    executablePath: CHROME,
    headless: false,
    args: [
      "--disable-features=DisableLoadExtensionCommandLineSwitch",
      "--host-resolver-rules=MAP * ~NOTFOUND",
      // Без него отказ загрузки открывает модальное окно Chromium «Error Loading
      // Extension», и запуск браузера стоит до его закрытия (наблюдалось на 139).
      // Строка LoadErrorReporter в stderr пишется и с этим флагом, но только
      // при явном --enable-logging=stderr (без него на Windows stderr пуст).
      "--noerrdialogs",
      "--enable-logging=stderr",
      `--disable-extensions-except=${extDir}`,
      `--load-extension=${extDir}`,
    ],
  });
  const blocked = [];
  await ctx.route(/^https?:\/\//i, (route) => {
    blocked.push(route.request().url());
    return route.abort("blockedbyclient");
  });

  const t0 = Date.now();
  let worker = ctx.serviceWorkers().find((w) => w.url().startsWith("chrome-extension://")) || null;
  if (!worker) {
    try {
      worker = await ctx.waitForEvent("serviceworker", {
        timeout: 20000,
        predicate: (w) => w.url().startsWith("chrome-extension://"),
      });
    } catch (_) {
      worker = null;
    }
  }
  const waited = Date.now() - t0;

  const page = ctx.pages()[0] || (await ctx.newPage());
  await page.goto("chrome://version/");
  const fullVersion = (await page.locator("#version").innerText().catch(() => "")).trim().split(/\s/)[0] || "unknown";
  console.log(`Chromium: ${fullVersion}`);
  console.log(`minimum_chrome_version: манифест ${declaredMin}${minOverride !== null ? `, во временной копии заменён на ${minOverride} (контрольная проба)` : ""}`);
  console.log(`ожидание: ${expect}; service worker: ${worker ? worker.url() : `нет за ${waited} мс`}`);

  // chrome://extensions — что видит пользователь: текст всех shadow-деревьев и
  // список элементов из developerPrivate (доверенный API этой страницы).
  await page.goto("chrome://extensions/");
  await page.waitForTimeout(1500);
  const extPage = await page.evaluate(async (id) => {
    const texts = [];
    const walk = (root) => {
      for (const el of root.querySelectorAll("*")) {
        if (el.shadowRoot) {
          texts.push(el.shadowRoot.textContent || "");
          walk(el.shadowRoot);
        }
      }
    };
    walk(document);
    let items = null;
    try {
      items = (await chrome.developerPrivate.getExtensionsInfo({ includeDisabled: true, includeTerminated: true }))
        .map((item) => ({ id: item.id, state: item.state, version: item.version }));
    } catch (_) {
      items = null;
    }
    const all = texts.join(" ").replace(/\s+/g, " ");
    const hit = all.match(/[^.]*requires[^.]*version[^.]*\./i);
    return { items, requiresText: hit ? hit[0].trim() : "", hasId: all.includes(id) };
  }, extensionId);
  console.log(`chrome://extensions: элементов ${extPage.items === null ? "?" : extPage.items.length} ${JSON.stringify(extPage.items)}; текст про требуемую версию: ${JSON.stringify(extPage.requiresText)}`);

  const errors = loadErrors();
  console.log(`stderr Chromium: перехвачено строк канала pw:browser ${browserLog.length}, ошибок загрузки этой копии ${errors.length}`);
  for (const line of errors) console.log(`stderr Chromium: ${line.replace(extDir, "<временная копия>")}`);
  const effectiveMin = minOverride ?? declaredMin;
  const reasonRe = new RegExp(`requires \\S+ version ${effectiveMin} or greater`, "i");
  const reason = [extPage.requiresText, ...errors].find((text) => reasonRe.test(text)) || "";

  if (expect === "loaded") {
    check("service worker расширения появился (≤ 20 с)", !!worker, worker ? `${waited} мс` : `нет за ${waited} мс`);
    if (worker) {
      const host = new URL(worker.url()).host;
      check("ID загруженного worker == ID из manifest.key", host === extensionId, `${host} / ${extensionId}`);
      const reported = await worker.evaluate(() => ({
        version: chrome.runtime.getManifest().version,
        min: chrome.runtime.getManifest().minimum_chrome_version,
      }));
      check("getManifest().version из worker == версия манифеста копии", reported.version === manifest.version,
        `${reported.version} / ${manifest.version}; minimum_chrome_version=${reported.min}`);
    }
    check("ошибок загрузки этой копии Chromium не сообщил", errors.length === 0, JSON.stringify(errors.length));
  } else {
    check("service worker расширения НЕ появился за 20 с", !worker, worker ? worker.url() : `${waited} мс`);
    check("в chrome://extensions расширения нет", extPage.items === null ? !extPage.hasId : !extPage.items.some((item) => item.id === extensionId),
      JSON.stringify(extPage.items));
    if (!worker) {
      if (reason) {
        check(`отказ именно по minimum_chrome_version ${effectiveMin}`, true, JSON.stringify(reason.replace(extDir, "<временная копия>")));
      } else {
        markUnverified("причина отказа",
          `worker нет, но текста про требуемую версию нет ни в chrome://extensions, ни в stderr Chromium (строк про копию: ${errors.length})`);
      }
    }
  }
  check("наружу не ушло ничего мимо route-слоя", blocked.every((url) => !/supabase\.co|youtube\.com|ytimg\.com/.test(url)),
    `оборвано ${blocked.length}`);

  const failed = results.filter((result) => !result.ok);
  console.log(`\n${results.length - failed.length}/${results.length} PASS`);
  if (failed.length) console.log(`FAILED: ${failed.map((item) => item.name).join(" | ")}`);
  if (unverified.length) console.log(`UNVERIFIED (${unverified.length}): ${unverified.join(" | ")}`);
  const verdict = failed.length ? "FAIL" : unverified.length ? "UNVERIFIED" : "PASS";
  console.log(`GATE floor expect=${expect}${minOverride !== null ? ` min-chrome=${minOverride}` : ""} Chromium ${fullVersion}: ${verdict}`);
  process.exitCode = failed.length ? 1 : unverified.length ? 3 : 0;
} finally {
  await ctx?.close().catch(() => {});
  for (const dir of [profileDir, extDir]) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
      console.log(`cleanup: ${dir}`);
    } catch (err) {
      console.log(`cleanup не удался, каталог остался: ${dir} — ${String(err?.code || err)}`);
    }
  }
}

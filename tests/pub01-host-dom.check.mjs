// PUB-01 в реальном Chromium: переводчик расширения не трогает DOM сайта.
//
// Запуск:
//   TV_CHROME=<chrome.exe> TV_PLAYWRIGHT_ROOT=<dir-with-node_modules>
//   node extensions/public/tests/pub01-host-dom.check.mjs
//
// Ни одна страница не настоящая: YouTube и Pinterest подменены синтетическими
// локальными fixtures через route-слой, остальная сеть оборвана, а имена вообще
// не разрешаются (`--host-resolver-rules=MAP * ~NOTFOUND`). Расширение грузится
// из санированной временной копии; реальный config.js не читается и не
// копируется.
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

// Пофайловый allowlist, а не обход каталога: обход подхватил бы config.js и
// любой новый локальный файл.
const SANITIZED_FILES = [
  "manifest.json", "background.js", "intent.js", "oauth.js", "i18n.js",
  "supabase.js", "api.js", "modal.js", "panel.html", "panel.css", "panel.js",
  "popup.html", "popup.js", "content.css", "content.js", "content-channel.js",
  "content-pinterest.js",
  "_locales/en/messages.json", "_locales/es/messages.json", "_locales/ru/messages.json",
  "icons/icon16.png", "icons/icon48.png", "icons/icon128.png",
];
const NEVER_COPY = new Set(["config.js", "config.example.js"]);

const extDir = mkdtempSync(join(tmpdir(), "tv-pub01-src-"));
for (const rel of SANITIZED_FILES) {
  if (NEVER_COPY.has(rel)) throw new Error(`Файл ${rel} копировать запрещено`);
  const target = join(extDir, rel);
  mkdirSync(dirname(target), { recursive: true });
  copyFileSync(join(SRC, rel), target);
}
const manifest = JSON.parse(readFileSync(join(extDir, "manifest.json"), "utf8"));
const SB_ORIGIN = new URL(manifest.host_permissions[0].replace(/\*$/, "")).origin;
const SYNTHETIC_CONFIG = `(globalThis.window || globalThis).THUMBVAULT_CONFIG = {
  SUPABASE_URL: "${SB_ORIGIN}",
  SUPABASE_ANON_KEY: "synthetic-anon-key-${"k".repeat(40)}",
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

// Контрольные host-элементы: неизвестный расширению ключ (дефект подставлял в
// текст само имя ключа) и два ключа, совпавших с его собственными.
const HOST_MARKUP = `
<span id="fx-label" data-i18n="native-site-label">Original site text</span>
<input id="fx-search" data-i18n-placeholder="findOrCreateFolder" placeholder="Rechercher sur le site">
<button id="fx-action" data-i18n-title="close" title="Fermer le menu" aria-label="Fermer le menu">x</button>
`;
const YT_PAGE = `<!doctype html><html lang="fr"><head><meta charset="utf-8"><title>fixture</title></head>
<body>${HOST_MARKUP}
<ytd-watch-metadata><div id="top-level-buttons-computed"></div></ytd-watch-metadata>
</body></html>`;
const PIN_PAGE = `<!doctype html><html lang="fr"><head><meta charset="utf-8"><title>fixture</title></head>
<body>${HOST_MARKUP}</body></html>`;

const EXPECTED = {
  lang: "fr",
  label: "Original site text",
  placeholder: "Rechercher sur le site",
  title: "Fermer le menu",
  aria: "Fermer le menu",
};

async function hostState(page) {
  return page.evaluate(() => ({
    lang: document.documentElement.getAttribute("lang"),
    label: document.getElementById("fx-label").textContent,
    placeholder: document.getElementById("fx-search").getAttribute("placeholder"),
    title: document.getElementById("fx-action").getAttribute("title"),
    aria: document.getElementById("fx-action").getAttribute("aria-label"),
  }));
}

const profileDir = mkdtempSync(join(tmpdir(), "tv-pub01-"));
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

  const blocked = [];
  // Только http(s): страницы самого расширения через route-слой не проходят, а
  // `continue()` на них Chromium отдаёт как ERR_BLOCKED_BY_CLIENT.
  await ctx.route(/^https?:\/\//i, (route) => {
    blocked.push(route.request().url());
    return route.abort("blockedbyclient");
  });
  await ctx.route("**://*.youtube.com/**", (route) => route.fulfill({ contentType: "text/html", body: YT_PAGE }));
  await ctx.route("**://*.pinterest.com/**", (route) => route.fulfill({ contentType: "text/html", body: PIN_PAGE }));

  // ID проверяется по реально загруженному service worker, а не только по
  // digest manifest.key: расхождение выглядело бы как ERR_BLOCKED_BY_CLIENT.
  const worker = ctx.serviceWorkers()[0] || (await ctx.waitForEvent("serviceworker", { timeout: 15000 }));
  const loadedId = new URL(worker.url()).host;
  check("расширение загружено под ожидаемым ID из manifest.key", loadedId === extensionId, `${loadedId} / ${extensionId}`);

  // Язык выбирается в popup — это документ extension-origin, ему перевод и
  // запись языка разрешены.
  const popup = await ctx.newPage();
  await popup.goto(`chrome-extension://${loadedId}/popup.html`);
  await popup.waitForFunction(() => globalThis.TVI18N && document.documentElement.lang === "en");
  await popup.evaluate(() => globalThis.TVI18N.setLang("ru"));
  const popupState = await popup.evaluate(() => ({
    lang: document.documentElement.getAttribute("lang"),
    signOut: document.querySelector("[data-i18n='signOut']")?.textContent,
    hint: document.querySelector("[data-i18n='accountHint']")?.textContent,
  }));
  check(
    "popup (extension-origin) переведён на RU, включая html.lang",
    popupState.lang === "ru" && popupState.signOut === "Выйти" && popupState.hint?.startsWith("Сохраняйте обложки"),
    JSON.stringify(popupState)
  );

  for (const [label, url, triggerId, expectedTitle] of [
    ["YouTube", "https://www.youtube.com/watch?v=dQw4w9WgXcQ", "#tv-save-btn", "Сохранить обложку в Thumb Sight"],
    ["Pinterest", "https://www.pinterest.com/pin/1234567890/", "#tv-pin-btn", "Сохранить изображение в Thumb Sight"],
  ]) {
    const page = await ctx.newPage();
    await page.goto(url);
    await page.waitForSelector(triggerId, { state: "attached", timeout: 15000 });
    // Кнопка появилась и язык уже применён — момент, в который дефект успевал
    // переписать страницу.
    const state = await hostState(page);
    const diff = Object.entries(EXPECTED).filter(([key, value]) => state[key] !== value);
    check(`${label}: html.lang, текст, placeholder, title и aria-label хоста не изменились`, diff.length === 0, JSON.stringify(state));

    const own = await page.evaluate((selector) => {
      const el = document.querySelector(selector);
      return { title: el?.getAttribute("title"), aria: el?.getAttribute("aria-label") };
    }, triggerId);
    check(`${label}: собственная кнопка расширения подписана на RU`, own.title === expectedTitle && own.aria === expectedTitle, JSON.stringify(own));
    await page.close();
  }

  check("необработанных ошибок страницы за прогон не было", pageErrors.length === 0, JSON.stringify(pageErrors));
  check(
    "наружу не ушло ничего, кроме подменённых fixtures",
    blocked.every((url) => !/youtube\.com|pinterest\.com/.test(url)),
    `оборвано ${blocked.length}: ${[...new Set(blocked.map((url) => new URL(url).origin))].join(" ")}`
  );

  const failed = results.filter((result) => !result.ok);
  console.log(`\n${results.length - failed.length}/${results.length} PASS`);
  process.exitCode = failed.length ? 1 : 0;
} finally {
  await ctx?.close().catch(() => {});
  rmSync(profileDir, { recursive: true, force: true });
  rmSync(extDir, { recursive: true, force: true });
}

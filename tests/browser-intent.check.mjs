// Реальный Chromium + распакованная САНИРОВАННАЯ копия extensions/public/.
// Hostile fixture проверяет clickjacking/WAR/forged-message границы и атомарную
// замену наборов через rpc/replace_thumbnail_links — без prod traffic.
//
// Запуск:
//   TV_CHROME=<chrome.exe> TV_PLAYWRIGHT_ROOT=<dir-with-node_modules>
//   node extensions/public/tests/browser-intent.check.mjs
//
// Расширение НИКОГДА не грузится из рабочего дерева напрямую: в temp-каталог
// копируется явный allowlist файлов, а config.js генерируется синтетическим.
// Реальный extensions/public/config.js не читается и не копируется.

// Весь Supabase-трафик расширения уходит из его service worker'а, а сетевые
// события SW Playwright отдаёт route-слою только с этим флагом. Ставится до
// загрузки playwright-core — позже он уже не читается.
process.env.PW_EXPERIMENTAL_SERVICE_WORKER_NETWORK_EVENTS = "1";

import { createRequire } from "node:module";
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
const { PNG: PngCodec } = require("pngjs");
const pixelmatchModule = require("pixelmatch");
const pixelmatch = pixelmatchModule.default || pixelmatchModule;

const SRC = process.env.TV_EXT || resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CHROME = process.env.TV_CHROME;
const SCREENSHOT_DIR = process.env.TV_SCREENSHOT_DIR || "";
if (!CHROME) {
  console.error("Задай TV_CHROME — путь к бинарнику Chrome/Chromium.");
  process.exit(2);
}
if (SCREENSHOT_DIR) mkdirSync(SCREENSHOT_DIR, { recursive: true });

// ------------------------------------------------ санированная копия расширения
// Список перечислен пофайлово, а не собран обходом каталога: обход подхватил бы
// config.js, локальные заметки и любой новый файл автоматически. Всё, чего здесь
// нет, в изолированный Chromium не попадает.
const SANITIZED_FILES = [
  "manifest.json",
  "background.js",
  "intent.js",
  "oauth.js",
  "i18n.js",
  "supabase.js",
  "api.js",
  "modal.js",
  "panel.html",
  "panel.css",
  "panel.js",
  "popup.html",
  "popup.js",
  "content.css",
  "content.js",
  "content-channel.js",
  "content-pinterest.js",
  "_locales/en/messages.json",
  "_locales/es/messages.json",
  "_locales/ru/messages.json",
  "icons/icon16.png",
  "icons/icon48.png",
  "icons/icon128.png",
];
// Явный отказ: если кто-то допишет секретный файл в allowlist, копия не соберётся.
const NEVER_COPY = new Set(["config.js", "config.example.js"]);

const extDir = mkdtempSync(join(tmpdir(), "tv-ext-src-"));
for (const rel of SANITIZED_FILES) {
  if (NEVER_COPY.has(rel)) throw new Error(`Файл ${rel} копировать запрещено`);
  const target = join(extDir, rel);
  mkdirSync(dirname(target), { recursive: true });
  copyFileSync(join(SRC, rel), target);
}

const manifest = JSON.parse(readFileSync(join(extDir, "manifest.json"), "utf8"));
// Origin берётся из манифеста (публичный пин, он же в config.example.js), а не из
// реального config.js. Он обязан совпадать с host_permissions и connect-src, иначе
// Chromium зарубил бы запрос до route-слоя и мы бы проверяли не тот путь.
const SB_ORIGIN = new URL(manifest.host_permissions[0].replace(/\*$/, "")).origin;
const SYNTHETIC_ANON_KEY = `synthetic-anon-key-${"k".repeat(40)}`;
const SYNTHETIC_CONFIG = `(globalThis.window || globalThis).THUMBVAULT_CONFIG = {
  SUPABASE_URL: "${SB_ORIGIN}",
  SUPABASE_ANON_KEY: "${SYNTHETIC_ANON_KEY}",
  AUTH_SITE_URL: "https://thumbsight.invalid",
};
`;
writeFileSync(join(extDir, "config.js"), SYNTHETIC_CONFIG);

const EXT = extDir;
const copiedFiles = readdirSync(EXT, { recursive: true, withFileTypes: true })
  .filter((entry) => entry.isFile())
  .map((entry) => join(entry.parentPath || entry.path, entry.name).slice(EXT.length + 1).split("\\").join("/"))
  .sort();
const expectedFiles = [...SANITIZED_FILES, "config.js"].sort();
const copyIsExact = JSON.stringify(copiedFiles) === JSON.stringify(expectedFiles);
const configIsSynthetic = readFileSync(join(EXT, "config.js"), "utf8") === SYNTHETIC_CONFIG;

const manifestKey = manifest.key;
const manifestDigest = createHash("sha256").update(Buffer.from(manifestKey, "base64")).digest();
const extensionId = [...manifestDigest.subarray(0, 16)]
  .flatMap((byte) => [byte >> 4, byte & 15])
  .map((nibble) => String.fromCharCode("a".charCodeAt(0) + nibble))
  .join("");

const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
};

function screenshotDifference(before, after) {
  const a = PngCodec.sync.read(before);
  const b = PngCodec.sync.read(after);
  if (a.width !== b.width || a.height !== b.height) return 1;
  const changed = pixelmatch(a.data, b.data, null, a.width, a.height, { threshold: 0.1 });
  return changed / (a.width * a.height);
}

const WATCH_PAGE = `<!doctype html><html><head><style>
body{margin:0;min-height:100vh;background:linear-gradient(135deg,#5b21b6,#0f766e);color:#fff;font:24px system-ui}
.fixture{margin:48px;padding:40px;border-radius:24px;background:rgba(255,255,255,.18)}
ytd-compact-video-renderer{position:fixed;right:48px;top:140px;display:block;width:240px;height:135px}
ytd-compact-video-renderer ytd-thumbnail{position:relative;display:block;width:240px;height:135px}
ytd-compact-video-renderer img{width:240px;height:135px}
</style></head><body>
<div class="fixture">Current YouTube tab</div>
<ytd-watch-metadata><div id="top-level-buttons-computed"></div></ytd-watch-metadata>
<ytd-compact-video-renderer id="related-tile"><ytd-thumbnail><a id="thumbnail" href="/watch?v=dQw4w9WgXcQ"><img src="https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg"></a></ytd-thumbnail></ytd-compact-video-renderer>
</body></html>`;

const SHORTS_PAGE = `<!doctype html><html><head><style>
body{margin:0;min-height:100vh;background:#111;color:#fff;font:24px system-ui}
ytd-reel-player-overlay-renderer #actions{position:fixed;right:48px;top:180px;display:flex;flex-direction:column;align-items:center}
.native-action{width:48px;height:48px;margin:0 0 8px;border-radius:50%;background:#333}
</style></head><body>
<ytd-reel-video-renderer is-active><ytd-reel-player-overlay-renderer><div id="actions"><div class="native-action"></div><div class="native-action"></div></div></ytd-reel-player-overlay-renderer></ytd-reel-video-renderer>
</body></html>`;

// Страница канала со всеми тремя ловушками из CODEX-EXT-CHANNEL-IDENTITY-TRIAGE-01:
// generic `og:title`, посторонняя channel-ссылка карточки и чужой externalId
// первым в блобе. Ожидаемый результат один — CHANNEL_ID / CHANNEL_NAME.
const CHANNEL_ID = "UCaaaaaaaaaaaaaaaaaaaaaa";
const CHANNEL_NAME = "Test channel";
const OTHER_CHANNEL_ID = "UCbbbbbbbbbbbbbbbbbbbbbb";
const CHANNEL_AVATAR = `https://yt3.ggpht.com/${CHANNEL_ID}=s900`;
const CHANNEL_INITIAL_DATA = JSON.stringify({
  responseContext: { externalId: OTHER_CHANNEL_ID },
  metadata: {
    channelMetadataRenderer: {
      title: CHANNEL_NAME,
      externalId: CHANNEL_ID,
      ownerUrls: ["http://www.youtube.com/@example"],
      avatar: { thumbnails: [{ url: CHANNEL_AVATAR, width: 900, height: 900 }] },
      vanityChannelUrl: "http://www.youtube.com/@example",
    },
  },
}).replace(/\//g, "\\/");

const CHANNEL_PAGE = `<!doctype html><html><head><style>
ytd-thumbnail{position:relative;display:block;width:320px;height:180px}
ytd-thumbnail img,ytd-moving-thumbnail-renderer{position:absolute;inset:0;width:320px;height:180px}
</style>
<link rel="canonical" href="https://www.youtube.com/@example">
<meta property="og:url" content="https://www.youtube.com/@example">
<meta property="og:title" content="YouTube">
<script>window.ytInitialData=${CHANNEL_INITIAL_DATA};</script>
</head><body><yt-page-header-renderer><h1>${CHANNEL_NAME}</h1></yt-page-header-renderer>
<a id="foreign-channel-link" style="display:none" href="/channel/${OTHER_CHANNEL_ID}">Other channel</a>
<ytd-rich-item-renderer id="video-tile"><ytd-thumbnail>
  <a id="thumbnail" href="/watch?v=dQw4w9WgXcQ"><img src="https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg"></a>
  <ytd-moving-thumbnail-renderer id="moving-preview"></ytd-moving-thumbnail-renderer>
</ytd-thumbnail></ytd-rich-item-renderer>
</body></html>`;

// Второй канал существует только как ответ сервера. Документ первой страницы к
// нему никогда не переписывается — так YouTube и ведёт себя при переходе внутри
// сайта (живое наблюдение, §13 CLAUDE-EXT-CHANNEL-IDENTITY-FIX-01).
const SECOND_CHANNEL_ID = `UC${"c".repeat(21)}1`;
const SECOND_CHANNEL_NAME = "Second channel";
const SECOND_CHANNEL_AVATAR = `https://yt3.ggpht.com/${SECOND_CHANNEL_ID}=s900`;
const SECOND_CHANNEL_PAGE = `<!doctype html><html><head>
<link rel="canonical" href="https://www.youtube.com/@second">
<meta property="og:title" content="YouTube">
<script>window.ytInitialData=${JSON.stringify({
  responseContext: { externalId: OTHER_CHANNEL_ID },
  metadata: {
    channelMetadataRenderer: {
      title: SECOND_CHANNEL_NAME,
      externalId: SECOND_CHANNEL_ID,
      ownerUrls: ["http://www.youtube.com/@second"],
      avatar: { thumbnails: [{ url: SECOND_CHANNEL_AVATAR, width: 900, height: 900 }] },
      vanityChannelUrl: "http://www.youtube.com/@second",
    },
  },
}).replace(/\//g, "\\/")};</script>
</head><body><yt-page-header-renderer><h1>${SECOND_CHANNEL_NAME}</h1></yt-page-header-renderer></body></html>`;

// ------------------------------------------------------------------------ R3
// Подставной 302 с разрешённого адреса на запрещённый. Страница по адресу
// НАЗНАЧЕНИЯ — полноценная запись текущего маршрута: пройди редирект, канал бы
// резолвился и ушёл бы в Supabase. Поэтому доказательством служит не `null`, а
// ноль запросов к самому адресу назначения.
const channelPage = (handle, id, name) => `<!doctype html><html><head>
<link rel="canonical" href="https://www.youtube.com/${handle}">
<meta property="og:title" content="YouTube">
<script>window.ytInitialData=${JSON.stringify({
  metadata: {
    channelMetadataRenderer: {
      title: name,
      externalId: id,
      ownerUrls: [`http://www.youtube.com/${handle}`],
      avatar: { thumbnails: [{ url: `https://yt3.ggpht.com/${id}=s900`, width: 900, height: 900 }] },
      vanityChannelUrl: `http://www.youtube.com/${handle}`,
    },
  },
}).replace(/\//g, "\\/")};</script>
</head><body><yt-page-header-renderer><h1>${name}</h1></yt-page-header-renderer></body></html>`;

const DIRECT_CHANNEL_ID = `UC${"e".repeat(21)}3`;
const DIRECT_CHANNEL_NAME = "Direct channel";
// Первый адрес — другой origin, но ТОТ ЖЕ ключ канала: проверку маршрута он
// проходит и отсекается только границей origin. Второй — вовсе снаружи.
const REDIRECTS = [
  { handle: "@hopmobile", to: "https://m.youtube.com/@hopmobile" },
  { handle: "@hopaway", to: "https://outside.example.invalid/@hopaway" },
];
const FORBIDDEN_ORIGINS = REDIRECTS.map(({ to }) => new URL(to).origin);

const PIN_PAGE = `<!doctype html><html><head><style>
body{margin:0}.feed{display:flex;gap:24px}.card{position:relative;display:block;margin:20px}img,video{display:block;width:320px;height:240px}
.deep-overlay{position:absolute;inset:0;z-index:2}
</style></head><body>
<div data-test-id="closeup-body-image-container"><img id="pin-main" src="https://i.pinimg.com/originals/44/55/66.jpg"></div>
<div class="feed">
  <a class="card" href="/pin/12345/"><img id="pin" src="https://i.pinimg.com/originals/aa/bb/cc.jpg"></a>
  <a class="card" href="/pin/23456/"><video id="pin-video-1" poster="https://i.pinimg.com/originals/dd/ee/ff.jpg" muted></video></a>
  <a class="card" href="/pin/34567/"><video id="pin-video-2" poster="https://i.pinimg.com/originals/11/22/33.jpg" muted></video></a>
  <div class="card" data-test-id="pinWrapper"><a href="/pin/45678/"><img id="pin-deep" style="height:120px" src="https://i.pinimg.com/originals/77/88/99.jpg"></a><div class="deep-overlay" style="height:120px"><div><div><div><div><div><div><div><div><div><button id="pin-deep-overlay">Save</button></div></div></div></div></div></div></div></div></div></div></div>
</div>
</body></html>`;

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64"
);

const THUMB_ID = "22222222-2222-4222-8222-222222222222";
const COLLECTION_ID = "11111111-1111-4111-8111-111111111111";
const TAG_ID = "12121212-1212-4121-8121-121212121212";
const RPC_PATH = "/rest/v1/rpc/replace_thumbnail_links";

const profileDir = mkdtempSync(join(tmpdir(), "tv-ext-"));
let ctx = null;
try {
  ctx = await chromium.launchPersistentContext(profileDir, {
    executablePath: CHROME,
    headless: false,
    // Branded Chrome 137+ ignores unpacked-extension command-line switches
    // unless this developer-test feature is explicitly re-enabled.
    // `--host-resolver-rules` — жёсткий бэкстоп под запрет prod-трафика: любой
    // запрос, который не перехватил route-слой, умирает на разрешении имени и
    // физически не покидает машину.
    args: [
      "--disable-features=DisableLoadExtensionCommandLineSwitch",
      "--host-resolver-rules=MAP * ~NOTFOUND",
      `--disable-extensions-except=${EXT}`,
      `--load-extension=${EXT}`,
    ],
  });

check("расширение загружено из санированной копии, а не из рабочего дерева", EXT !== SRC && copyIsExact, copiedFiles.length + " файлов");
check("config.js в копии — синтетический, реальный не читался и не копировался", configIsSynthetic);

const requests = [];
let storedThumbnail = null;
let lastSavedNote = "";
let served = 0;
const apikeys = new Set();
const blocked = [];
const forbiddenHits = [];
const rpcCalls = [];
const junctionCalls = [];
const channelCalls = [];
const collectionPosts = [];
const collectionRows = [];
const tagRows = [];

// Ожидание состояния фикстуры, а не паузa: условие проверяется до дедлайна и
// невыполненное условие роняет прогон, а не проходит по таймауту.
async function waitForFixture(predicate, label, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (predicate()) return;
    if (Date.now() >= deadline) throw new Error(`Не дождались: ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}
// "ok" | "deny" | "strict-null" — режим ответа RPC для сценариев отказа.
let rpcMode = "ok";
// Переход по редиректу route-слой НЕ перехватывает: продолжение цепочки видно
// только здесь (и умирает на DNS-бэкстопе). Поэтому «ноль запросов к
// запрещённому адресу» считается по событиям запроса, а не по фикстуре — иначе
// проверка молчала бы и при пройденном редиректе.
ctx.on("request", (request) => {
  const url = request.url();
  if (FORBIDDEN_ORIGINS.some((origin) => url.startsWith(`${origin}/`))) forbiddenHits.push(url);
  if (url.includes("supabase.co")) {
    requests.push({ method: request.method(), url });
  }
});

// Catch-all регистрируется ПЕРВЫМ: Playwright выбирает последний подходящий
// обработчик, поэтому фикстуры ниже перекрывают его, а всё непредусмотренное
// обрывается и попадает в отчёт вместо того, чтобы уйти в сеть.
await ctx.route("**/*", (route) => {
  const url = route.request().url();
  // Ресурсы самого расширения сетью не являются — их обрыв просто выключил бы
  // панель и превратил бы все проверки ниже в ложные отказы.
  if (!/^https?:/i.test(url)) return route.continue();
  blocked.push({ method: route.request().method(), url });
  return route.abort("blockedbyclient");
});

await ctx.route("**://i.pinimg.com/**", (route) => route.fulfill({ contentType: "image/png", body: PNG }));
await ctx.route("**://i.ytimg.com/**", (route) => route.fulfill({ contentType: "image/png", body: PNG }));
const youtubeHits = [];
await ctx.route("**://*.youtube.com/**", (route) => {
  const url = route.request().url();
  youtubeHits.push(url);
  const body = url.includes("/@second")
    ? SECOND_CHANNEL_PAGE
    : url.includes("/@example")
      ? CHANNEL_PAGE
      : url.includes("/shorts/")
        ? SHORTS_PAGE
        : WATCH_PAGE;
  return route.fulfill({ contentType: "text/html", body });
});
// Регистрируются ПОСЛЕ общего youtube-обработчика: Playwright берёт последний
// подходящий, поэтому эти адреса перекрывают его.
for (const { handle, to } of REDIRECTS) {
  await ctx.route(`**://www.youtube.com/${handle}`, (route) => {
    youtubeHits.push(route.request().url());
    return route.fulfill({ status: 302, headers: { location: to }, body: "" });
  });
}
await ctx.route("**://www.youtube.com/@direct", (route) => {
  youtubeHits.push(route.request().url());
  return route.fulfill({ contentType: "text/html", body: channelPage("@direct", DIRECT_CHANNEL_ID, DIRECT_CHANNEL_NAME) });
});
await ctx.route("**://*.pinterest.com/**", (route) => route.fulfill({ contentType: "text/html", body: PIN_PAGE }));
await ctx.route("**://*.supabase.co/**", async (route) => {
  const request = route.request();
  const url = new URL(request.url());
  const method = request.method();
  served += 1;
  apikeys.add(request.headers().apikey || "");
  const json = (value, status = 200) => route.fulfill({
    status,
    contentType: "application/json",
    body: JSON.stringify(value),
  });

  if (url.pathname.endsWith("/rest/v1/collections")) {
    if (method === "POST") {
      const body = JSON.parse(request.postData() || "{}");
      collectionPosts.push(String(body.name ?? ""));
      let row = collectionRows.find((item) => item.name === body.name);
      if (!row) {
        row = { id: collectionRows.length ? `1111111${collectionRows.length}-1111-4111-8111-111111111111` : COLLECTION_ID, name: body.name };
        collectionRows.push(row);
      }
      return json([row]);
    }
    return json(collectionRows);
  }
  if (url.pathname.endsWith("/rest/v1/tags")) {
    if (method === "POST") {
      const body = JSON.parse(request.postData() || "{}");
      let row = tagRows.find((item) => item.name === body.name);
      if (!row) {
        row = { id: tagRows.length ? `1212121${tagRows.length}-1212-4121-8121-121212121212` : TAG_ID, name: body.name };
        tagRows.push(row);
      }
      return json([row]);
    }
    return json(tagRows);
  }
  if (url.pathname.endsWith("/rest/v1/channels")) {
    if (method === "POST") {
      const raw = request.postData() || "";
      let body = null;
      try { body = JSON.parse(raw); } catch (_) { body = null; }
      channelCalls.push({ raw, body });
      return json(null);
    }
    return json([]);
  }
  if (url.pathname.endsWith("/rest/v1/thumbnails")) {
    if (method === "POST") {
      const body = JSON.parse(request.postData() || "{}");
      lastSavedNote = body.note || "";
      storedThumbnail = {
        id: THUMB_ID,
        note: lastSavedNote,
        thumbnail_collections: storedThumbnail?.thumbnail_collections || [],
        thumbnail_tags: storedThumbnail?.thumbnail_tags || [],
      };
      return json([storedThumbnail]);
    }
    if (method === "DELETE") {
      storedThumbnail = null;
      return route.fulfill({ status: 204, body: "" });
    }
    return json(storedThumbnail ? [storedThumbnail] : []);
  }
  // Атомарная замена наборов. Форма ответа — та же, что у функции J1:
  // {thumbnail_id, collections, tags}, где счётчик равен null для набора, который
  // не просили менять.
  if (url.pathname.endsWith(RPC_PATH)) {
    const raw = request.postData() || "";
    let body = null;
    try { body = JSON.parse(raw); } catch (_) { body = null; }
    rpcCalls.push({
      method,
      url: request.url(),
      raw,
      body,
      prefer: request.headers().prefer ?? null,
    });
    if (method !== "POST") return json({ code: "42883", message: "method not allowed" }, 405);
    if (rpcMode === "deny") return json({ code: "JO010", message: "junction ownership violation" }, 400);
    // STRICT-дрейф из J1 §R4.2: 200 без единой записи.
    if (rpcMode === "strict-null") return json(null);
    let collections = null;
    let tags = null;
    if (Array.isArray(body?.p_collection_ids)) {
      if (storedThumbnail) storedThumbnail.thumbnail_collections = body.p_collection_ids.map((id) => ({ collection_id: id }));
      collections = body.p_collection_ids.length;
    }
    if (Array.isArray(body?.p_tag_ids)) {
      if (storedThumbnail) storedThumbnail.thumbnail_tags = body.p_tag_ids.map((id) => ({ tag_id: id }));
      tags = body.p_tag_ids.length;
    }
    return json({ thumbnail_id: body?.p_thumbnail_id ?? null, collections, tags });
  }
  // Растяжка проволоки: прямая запись в junction-таблицы больше не должна
  // случаться ни на одной ветке, включая отказ RPC. Фикстура их не обслуживает —
  // любое попадание сюда фиксируется и валит проверку.
  if (url.pathname.endsWith("/rest/v1/thumbnail_collections") || url.pathname.endsWith("/rest/v1/thumbnail_tags")) {
    junctionCalls.push({ method, url: request.url(), body: request.postData() || "" });
    return json({ code: "TVGATE", message: "direct junction write is not expected" }, 500);
  }
  if (url.pathname.includes("/functions/v1/")) return json({});
  return json({});
});

const mutationCount = () => requests.filter((request) => request.method !== "GET").length;
const extensionPages = () => ctx.pages().filter((page) => page.url().startsWith(`chrome-extension://${extensionId}/`));

async function openEmbeddedPanel(hostPage, selector) {
  await hostPage.bringToFront();
  await hostPage.click(selector);
  await hostPage.waitForSelector("#tv-panel-host", { state: "attached" });
  let panel = null;
  for (let attempt = 0; attempt < 80; attempt += 1) {
    panel = hostPage.frames().find((frame) => frame.url().startsWith(`chrome-extension://${extensionId}/panel.html`)) || null;
    if (panel) break;
    await hostPage.waitForTimeout(50);
  }
  if (!panel) throw new Error("Embedded Thumb Sight panel did not load");
  await panel.waitForSelector("#tv-overlay");
  return panel;
}

async function closeEmbeddedPanel(hostPage, panel, selector) {
  await hostPage.bringToFront();
  const closed = hostPage.waitForSelector("#tv-panel-host", { state: "detached" });
  await panel.click(selector);
  await closed;
}

const worker = ctx.serviceWorkers()[0] || await ctx.waitForEvent("serviceworker");
await worker.evaluate(() => chrome.storage.local.set({ tv_lang: "ru" }));

// ------------------------------------------------ hostile YouTube host / anonymous
const page = await ctx.newPage();
await page.goto("https://www.youtube.com/watch?v=dQw4w9WgXcQ");
await page.waitForSelector("#tv-save-btn", { timeout: 15000 });
check("кнопка расширения смонтирована на YouTube", true);
await page.hover("#related-tile ytd-thumbnail");
await page.waitForFunction(() => document.querySelector(".tv-tile-save-btn")?.classList.contains("tv-tile-save-btn-visible"));
check("кнопка расширения появляется на рекомендуемом видео", await page.evaluate(() => {
  const button = document.querySelector(".tv-tile-save-btn");
  return button?.dataset.videoId === "dQw4w9WgXcQ";
}));
if (SCREENSHOT_DIR) await page.screenshot({ path: join(SCREENSHOT_DIR, "host-button.png"), fullPage: true });

const shorts = await ctx.newPage();
await shorts.goto("https://www.youtube.com/shorts/dQw4w9WgXcQ");
await shorts.waitForSelector("#tv-shorts-save-btn", { timeout: 15000 });
check("кнопка расширения смонтирована над действиями Shorts", await shorts.evaluate(() => {
  const button = document.getElementById("tv-shorts-save-btn");
  const actions = document.querySelector("ytd-reel-player-overlay-renderer #actions");
  return button?.parentElement === actions && actions?.firstElementChild === button;
}));
const shortsPanel = await openEmbeddedPanel(shorts, "#tv-shorts-save-btn");
check("trusted click Shorts открывает панель в текущей вкладке", await shorts.locator("#tv-panel-host").count() === 1);
await closeEmbeddedPanel(shorts, shortsPanel, "#tv-close");

const beforeSyntheticPages = ctx.pages().length;
await page.evaluate((id) => {
  const button = document.getElementById("tv-save-btn");
  button.click();
  button.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  button.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));

  // Hostile page пытается управлять старой геометрией, встроить panel WAR и
  // подделать прежний postMessage transport.
  const old = document.getElementById("tv-panel-frame");
  if (old) {
    Object.assign(old.style, {
      inset: "auto",
      width: "1px",
      height: "1px",
      opacity: "0",
      zIndex: "2147483647",
      pointerEvents: "auto",
    });
  }
  const forged = document.createElement("iframe");
  forged.id = "hostile-panel";
  forged.src = `chrome-extension://${id}/panel.html?intent=${"x".repeat(32)}`;
  forged.style = "position:fixed;inset:0;opacity:.01;z-index:2147483647";
  document.body.appendChild(forged);
  window.postMessage({
    source: "thumb-sight-host",
    type: "intent",
    nonce: "x".repeat(32),
  }, "*");
}, extensionId);
await page.waitForTimeout(750);

check("synthetic host click → 0 новых страниц", ctx.pages().length === beforeSyntheticPages);
check("synthetic host click → 0 Supabase requests", requests.length === 0, `requests: ${requests.length}`);
check("synthetic click не создаёт легитимный overlay", (await page.locator("#tv-panel-host").count()) === 0);
check("forged postMessage → 0 mutations", mutationCount() === 0);
check("forged iframe отклонён до mutations", mutationCount() === 0);
await page.evaluate(() => document.getElementById("hostile-panel")?.remove());

const beforeAnonymousPages = ctx.pages().length;
const anonymousPanel = await openEmbeddedPanel(page, "#tv-save-btn");
await anonymousPanel.waitForFunction(() => document.body.innerText.includes("Сначала войдите"));
await anonymousPanel.waitForTimeout(500);
check("trusted click не открыл новую вкладку", ctx.pages().length === beforeAnonymousPages);
check("panel открыта overlay в текущей вкладке", await page.locator("#tv-panel-host").count() === 1);
check("без второго подтверждения → 0 mutations", mutationCount() === 0);
check("anonymous panel не закрывается автоматически", !anonymousPanel.isDetached());
check("host page не видит private iframe DOM в closed shadow root", (await page.locator("#tv-panel-host iframe").count()) === 0);
await anonymousPanel.addStyleTag({ content: "*,*::before,*::after{animation:none!important;transition:none!important}" });
await page.bringToFront();
await page.waitForTimeout(200);
const beforeHostRedress = await page.screenshot();
if (SCREENSHOT_DIR) await page.screenshot({ path: join(SCREENSHOT_DIR, "before-host-redress.png") });
await page.evaluate(() => {
  const host = document.getElementById("tv-panel-host");
  host.style.setProperty("position", "absolute", "important");
  host.style.setProperty("inset", "auto", "important");
  host.style.setProperty("width", "1px", "important");
  host.style.setProperty("height", "1px", "important");
  host.style.setProperty("opacity", ".01", "important");
  host.style.setProperty("transform", "translate(500px, 300px) scale(.01)", "important");
  host.style.setProperty("pointer-events", "none", "important");
});
await page.waitForTimeout(100);
const afterHostRedress = await page.screenshot();
if (SCREENSHOT_DIR) await page.screenshot({ path: join(SCREENSHOT_DIR, "after-host-redress.png") });
const hostRedressDifference = screenshotDifference(beforeHostRedress, afterHostRedress);
check(
  "host CSS не меняет browser top-layer presentation",
  // Backdrop-filter produces a small amount of nondeterministic compositor
  // noise; a real opacity/transform redress changes orders of magnitude more.
  hostRedressDifference < 0.003,
  `changed pixels: ${(hostRedressDifference * 100).toFixed(5)}%`
);
await closeEmbeddedPanel(page, anonymousPanel, "#tv-close");

// Тестовая сессия — только вымышленные значения; реальные storage values не читаются.
await worker.evaluate(async () => {
  await chrome.storage.local.set({
    tv_session: {
      access_token: `test-access-${"x".repeat(32)}`,
      refresh_token: `test-refresh-${"y".repeat(32)}`,
      expires_at: Math.floor(Date.now() / 1000) + 3600,
      user: { id: "33333333-3333-4333-8333-333333333333", email: "test@example.invalid" },
    },
  });
});

// ------------------------------------------- authenticated Follow: 2 clicks
const channel = await ctx.newPage();
await channel.goto("https://www.youtube.com/@example");
await channel.waitForSelector("#tv-follow-btn", { timeout: 15000 });
await channel.waitForSelector(".tv-tile-save-btn", { timeout: 15000 });
check("YouTube moving thumbnail preview remains enabled", await channel.locator("#moving-preview").evaluate((el) => getComputedStyle(el).display !== "none"));
await channel.hover("#video-tile ytd-thumbnail");
await channel.waitForFunction(() => getComputedStyle(document.querySelector(".tv-tile-save-btn")).opacity === "1");
await channel.evaluate(() => {
  const host = document.querySelector("#video-tile ytd-thumbnail");
  const rect = host.getBoundingClientRect();
  const preview = document.createElement("video");
  preview.id = "global-moving-preview";
  Object.assign(preview.style, {
    position: "fixed",
    top: `${rect.top}px`,
    left: `${rect.left}px`,
    width: `${rect.width}px`,
    height: `${rect.height}px`,
    zIndex: "100000",
  });
  document.body.appendChild(preview);
});
await channel.waitForFunction(() => {
  const host = document.querySelector("#video-tile ytd-thumbnail");
  const button = document.querySelector(".tv-tile-save-btn");
  return !host.matches(":hover") && button.parentElement === document.body && getComputedStyle(button).opacity === "1";
});
check("YouTube tile trigger stays above moving preview", await channel.evaluate(() => {
  const button = document.querySelector(".tv-tile-save-btn");
  const preview = document.querySelector("#global-moving-preview");
  const previewZ = Number.parseInt(getComputedStyle(preview).zIndex, 10) || 0;
  return Number.parseInt(getComputedStyle(button).zIndex, 10) > previewZ;
}));
await channel.evaluate(() => {
  const oldHost = document.querySelector("#video-tile ytd-thumbnail");
  const nextHost = oldHost.cloneNode(true);
  oldHost.replaceWith(nextHost);
});
await channel.waitForFunction(() => {
  const host = document.querySelector("#video-tile ytd-thumbnail");
  const button = document.querySelector(".tv-tile-save-btn");
  // Класс на хосте больше не ставится (и cloneNode копировал его — тавтология):
  // проверяем саму кнопку — в body, видна, несёт id плитки и стоит над новым хостом.
  const videoId = new URL(host.querySelector("a#thumbnail").href).searchParams.get("v");
  return button.parentElement === document.body
    && getComputedStyle(button).opacity === "1"
    && button.dataset.videoId === videoId
    && Math.abs(button.getBoundingClientRect().top - (host.getBoundingClientRect().top + 8)) <= 1;
});
check("YouTube trigger is restored after thumbnail replacement", true);
const beforeFollow = mutationCount();
const beforeFollowPages = ctx.pages().length;
const followPanel = await openEmbeddedPanel(channel, "#tv-follow-btn");
await followPanel.waitForSelector("#tv-save:not([disabled])");
check("authenticated panel осталась в исходной вкладке", ctx.pages().length === beforeFollowPages);
check("первый Follow click не мутирует", mutationCount() === beforeFollow);
// Ловушки страницы: generic og:title, чужой externalId первым в блобе и
// посторонняя channel-ссылка. Панель обязана показать текущий канал.
check(
  "панель подтверждает имя текущего канала, а не generic og:title",
  (await followPanel.locator("#tv-note").textContent())?.trim() === CHANNEL_NAME,
  await followPanel.locator("#tv-note").textContent()
);
await followPanel.evaluate(() => document.getElementById("tv-save").click());
await followPanel.waitForTimeout(250);
check("synthetic click внутри panel → 0 mutations", mutationCount() === beforeFollow);

await closeEmbeddedPanel(channel, followPanel, "#tv-save");
check("trusted confirm → ровно одна ожидаемая mutation", mutationCount() === beforeFollow + 1);
check("successful Follow closes the panel immediately", followPanel.isDetached());
await waitForFixture(() => channelCalls.length >= 1, "POST /rest/v1/channels");
check("Follow записал ровно один канал", channelCalls.length === 1, String(channelCalls.length));
check(
  "POST несёт channel_id и name ровно текущего канала",
  channelCalls[0]?.body?.channel_id === CHANNEL_ID && channelCalls[0]?.body?.name === CHANNEL_NAME,
  channelCalls[0]?.raw || ""
);
check(
  "ни чужой externalId, ни generic имя в теле не оказались",
  !(channelCalls[0]?.raw || "").includes(OTHER_CHANNEL_ID) && channelCalls[0]?.body?.name !== "YouTube",
  channelCalls[0]?.raw || ""
);
check(
  "аватар принадлежит тому же каналу",
  channelCalls[0]?.body?.avatar === CHANNEL_AVATAR,
  String(channelCalls[0]?.body?.avatar)
);

// ------------------------ переход канал→канал без перезагрузки (SPA-совместимость)
// YouTube меняет location и canonical, но НЕ переписывает ytInitialData и og:* —
// живое наблюдение, §13 CLAUDE-EXT-CHANNEL-IDENTITY-FIX-01. Документ продолжает
// описывать @example, поэтому назвать текущий канал может только свежий ответ по
// адресу самого маршрута. Здесь это происходит в настоящем isolated world.
const beforeHopHits = youtubeHits.length;
await channel.evaluate(() => {
  history.pushState({}, "", "/@second");
  document.querySelector('link[rel="canonical"]').href = "https://www.youtube.com/@second";
  document.dispatchEvent(new Event("yt-navigate-finish"));
});
await channel.waitForSelector("#tv-follow-btn", { timeout: 15000 });
check(
  "переход канал→канал не перезагрузил документ: метаданные всё ещё от @example",
  await channel.evaluate((stale) =>
    location.pathname === "/@second" &&
    [...document.scripts].some((script) => (script.textContent || "").includes(stale)),
  CHANNEL_ID)
);

const beforeHopFollow = mutationCount();
const hopPanel = await openEmbeddedPanel(channel, "#tv-follow-btn");
await hopPanel.waitForSelector("#tv-save:not([disabled])");
check(
  "после перехода панель называет текущий канал, а не тот, чьи метаданные в документе",
  (await hopPanel.locator("#tv-note").textContent())?.trim() === SECOND_CHANNEL_NAME,
  await hopPanel.locator("#tv-note").textContent()
);
await closeEmbeddedPanel(channel, hopPanel, "#tv-save");
await waitForFixture(() => channelCalls.length >= 2, "POST /rest/v1/channels после перехода");
check("переход канал→канал: ровно одна дополнительная запись", channelCalls.length === 2, String(channelCalls.length));
check(
  "записан текущий канал целиком: id, имя и аватар второго канала",
  channelCalls[1]?.body?.channel_id === SECOND_CHANNEL_ID &&
    channelCalls[1]?.body?.name === SECOND_CHANNEL_NAME &&
    channelCalls[1]?.body?.avatar === SECOND_CHANNEL_AVATAR,
  channelCalls[1]?.raw || ""
);
check(
  "ни устаревший канал документа, ни чужой externalId в теле не оказались",
  !(channelCalls[1]?.raw || "").includes(CHANNEL_ID) && !(channelCalls[1]?.raw || "").includes(OTHER_CHANNEL_ID),
  channelCalls[1]?.raw || ""
);
const hopHits = youtubeHits.slice(beforeHopHits);
check(
  "запрошен ровно один адрес — собственный путь текущего маршрута",
  hopHits.length === 1 && hopHits[0] === "https://www.youtube.com/@second",
  JSON.stringify(hopHits)
);
check("переход канал→канал: ровно одна ожидаемая mutation", mutationCount() === beforeHopFollow + 1);

// ------------------------------------- R3: редирект за границу не запрашивается
// Тот же путь, что и выше, но ответ по собственному адресу маршрута — 302 на
// чужой origin. Граница обязана сработать ДО перехода: запрос к адресу
// назначения не должен уйти вовсе, а не быть отвергнут по факту ответа.
async function hopTo(handle) {
  await channel.evaluate((next) => {
    history.pushState({}, "", next);
    document.querySelector('link[rel="canonical"]').href = `https://www.youtube.com${next}`;
    document.dispatchEvent(new Event("yt-navigate-finish"));
  }, `/${handle}`);
  await channel.waitForSelector("#tv-follow-btn", { timeout: 15000 });
  await channel.bringToFront();
}

for (const { handle, to } of REDIRECTS) {
  await hopTo(handle);
  const beforeHits = youtubeHits.length;
  const beforeForbidden = forbiddenHits.length;
  const beforeRedirectFollow = mutationCount();
  const beforeRedirectChannels = channelCalls.length;
  await channel.click("#tv-follow-btn");
  // Видимый отказ — это и есть конец ожидания: панель не открывается вовсе.
  await channel.waitForSelector('#tv-toast.show[data-kind="error"]', { timeout: 15000 });
  check(`302 → ${to}: отказ показан, панель не открыта`, (await channel.locator("#tv-panel-host").count()) === 0);
  check(
    `302 → ${to}: НОЛЬ запросов к запрещённому адресу`,
    forbiddenHits.length === beforeForbidden,
    JSON.stringify(forbiddenHits.slice(beforeForbidden))
  );
  check(
    `302 → ${to}: запрошен ровно один адрес — собственный путь маршрута`,
    youtubeHits.length === beforeHits + 1 && youtubeHits.at(-1) === `https://www.youtube.com/${handle}`,
    JSON.stringify(youtubeHits.slice(beforeHits))
  );
  check(
    `302 → ${to}: ни записи канала, ни мутаций`,
    channelCalls.length === beforeRedirectChannels && mutationCount() === beforeRedirectFollow,
    `channels ${channelCalls.length}, mutations ${mutationCount()}`
  );
  await channel.evaluate(() => document.getElementById("tv-toast")?.classList.remove("show"));
}

// Позитивный контроль тем же путём: прямой 200 по собственному адресу читается
// и после запрета редиректов — иначе «ноль запросов» выше означало бы лишь то,
// что ридер сломан целиком. Сохранение не подтверждается: счётчик Follow ниже
// проверяет ровно два канала за прогон.
await hopTo("@direct");
const beforeDirectHits = youtubeHits.length;
const directPanel = await openEmbeddedPanel(channel, "#tv-follow-btn");
await directPanel.waitForSelector("#tv-save:not([disabled])");
check(
  "direct-200 контроль: свежий ответ по своему адресу называет текущий канал",
  (await directPanel.locator("#tv-note").textContent())?.trim() === DIRECT_CHANNEL_NAME,
  await directPanel.locator("#tv-note").textContent()
);
check(
  "direct-200 контроль: ровно один запрос, ровно по своему адресу",
  youtubeHits.length === beforeDirectHits + 1 && youtubeHits.at(-1) === "https://www.youtube.com/@direct",
  JSON.stringify(youtubeHits.slice(beforeDirectHits))
);
await closeEmbeddedPanel(channel, directPanel, "#tv-close");

// ------------------------------------------- Enter создаёт папку один раз
const beforeCreate = collectionPosts.length;
const savePanel = await openEmbeddedPanel(page, "#tv-save-btn");
await savePanel.waitForSelector("#tv-new-folder");
check("save-overlay не дублирует глобальный переключатель языка", await savePanel.locator("#tv-lang-button").count() === 0);
await savePanel.fill("#tv-new-folder", "Regression folder");
await savePanel.press("#tv-new-folder", "Enter");
// `innerText.includes("Regression folder")` истинно уже на кнопке
// `+ Создать “Regression folder”`, которая рисуется во время ввода. Ждём
// подтверждающий POST и настоящую выбранную строку (без `tv-create`).
await waitForFixture(
  () => collectionPosts.includes("Regression folder"),
  "успешный POST /rest/v1/collections с именем папки"
);
await savePanel.waitForFunction(() => [...document.querySelectorAll("#tv-collections .tv-choice:not(.tv-create)")]
  .some((row) => row.classList.contains("on") && row.textContent.includes("Regression folder")));
const afterCreate = collectionPosts.length;
check("Enter создаёт папку ровно один раз", afterCreate === beforeCreate + 1, `${beforeCreate} → ${afterCreate}`);
check(
  "созданная папка остаётся в динамическом списке",
  await savePanel.locator("#tv-collections .tv-choice:not(.tv-create)").getByText("Regression folder").count() === 1
);
if (SCREENSHOT_DIR) await savePanel.locator("#tv-overlay").screenshot({ path: join(SCREENSHOT_DIR, "before-note-tab.png") });
await savePanel.evaluate(() => {
  window.__tvNoteTabClicks = 0;
  document.getElementById("tv-tab-note").addEventListener("click", () => window.__tvNoteTabClicks++);
});
await savePanel.click("#tv-tab-note");
const noteTabState = await savePanel.evaluate(() => ({
  clicks: window.__tvNoteTabClicks,
  selected: document.getElementById("tv-tab-note").getAttribute("aria-selected"),
  panelClass: document.getElementById("tv-note-panel").className,
  inputVisible: Boolean(document.getElementById("tv-note-input").offsetParent),
  hitTarget: (() => {
    const rect = document.getElementById("tv-tab-note").getBoundingClientRect();
    const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
    return { id: hit?.id || "", className: hit?.className || "", rect: [rect.left, rect.top, rect.width, rect.height] };
  })(),
}));
check("Note tab becomes visible", noteTabState.selected === "true" && noteTabState.inputVisible, JSON.stringify(noteTabState));
if (!noteTabState.inputVisible) throw new Error(`Note tab did not activate: ${JSON.stringify(noteTabState)}`);
await savePanel.fill("#tv-note-input", "Сильный контраст и ясный фокус");
if (SCREENSHOT_DIR) await savePanel.locator("#tv-overlay").screenshot({ path: join(SCREENSHOT_DIR, "save-panel.png") });
await closeEmbeddedPanel(page, savePanel, "#tv-save");
check("заметка сохраняется вместе с обложкой", lastSavedNote === "Сильный контраст и ясный фокус");
check("YouTube save подтверждает refresh-views snapshot", requests.some((request) => request.url.includes("/functions/v1/refresh-views")));
check("successful save closes the panel immediately", savePanel.isDetached());

// ----------------------------------- атомарная замена наборов: реальная панель
// Всё ниже исполняется настоящей панелью расширения в Chromium: RPC-запросы
// приходят из service worker'а расширения и перехватываются здесь, а прямые
// junction-маршруты фикстурой не обслуживаются вовсе.
const rpcOnly = () => rpcCalls.map((call) => `${call.method} ${new URL(call.url).pathname}${new URL(call.url).search}`);
const sameSet = (value, expected) => Array.isArray(value)
  && value.length === expected.length
  && expected.every((id) => value.includes(id));

check(
  "сохранение папок идёт одним POST на rpc/replace_thumbnail_links",
  rpcCalls.length === 1 && rpcCalls[0].method === "POST" && new URL(rpcCalls[0].url).pathname.endsWith(RPC_PATH) && new URL(rpcCalls[0].url).search === "",
  JSON.stringify(rpcOnly())
);
check(
  "null оставляет незатронутый набор в покое, изменившийся уходит массивом",
  rpcCalls[0]?.body?.p_thumbnail_id === THUMB_ID
    && sameSet(rpcCalls[0]?.body?.p_collection_ids, [COLLECTION_ID])
    && rpcCalls[0]?.body?.p_tag_ids === null,
  rpcCalls[0]?.raw || ""
);
check("Prefer на rpc-маршрут не уходит", rpcCalls[0]?.prefer === null, String(rpcCalls[0]?.prefer));
check("на пути сохранения нет прямых junction-запросов", junctionCalls.length === 0, JSON.stringify(junctionCalls));
check(
  "сервер применил замену — панель прочитает её как оригинал",
  sameSet((storedThumbnail?.thumbnail_collections || []).map((row) => row.collection_id), [COLLECTION_ID])
);

// Оба набора меняются вместе: папки очищаются (`[]`), теги задаются впервые.
const bothPanel = await openEmbeddedPanel(page, "#tv-save-btn");
await bothPanel.waitForSelector("#tv-delete:not(.tv-hidden)");
await bothPanel.click("#tv-collections .tv-choice.on");
await bothPanel.click("#tv-tab-tags");
await bothPanel.fill("#tv-new-tag", "Regression tag");
await bothPanel.press("#tv-new-tag", "Enter");
await bothPanel.waitForFunction(() => document.body.innerText.includes("Regression tag"));
const beforeBoth = rpcCalls.length;
await closeEmbeddedPanel(page, bothPanel, "#tv-save");
check(
  "папки и теги одного сохранения уходят ОДНИМ вызовом",
  rpcCalls.length === beforeBoth + 1,
  `${beforeBoth} → ${rpcCalls.length}`
);
check(
  "[] очищает набор, изменившийся второй набор идёт тем же телом",
  Array.isArray(rpcCalls.at(-1)?.body?.p_collection_ids)
    && rpcCalls.at(-1).body.p_collection_ids.length === 0
    && sameSet(rpcCalls.at(-1)?.body?.p_tag_ids, [TAG_ID]),
  rpcCalls.at(-1)?.raw || ""
);
check(
  "обе стороны применены одной транзакцией фикстуры",
  (storedThumbnail?.thumbnail_collections || []).length === 0
    && sameSet((storedThumbnail?.thumbnail_tags || []).map((row) => row.tag_id), [TAG_ID])
);
check("замена обоих наборов не породила прямых junction-запросов", junctionCalls.length === 0, JSON.stringify(junctionCalls));

// Наборы не менялись — запроса нет вовсе.
const noopPanel = await openEmbeddedPanel(page, "#tv-save-btn");
await noopPanel.waitForSelector("#tv-delete:not(.tv-hidden)");
const beforeNoop = rpcCalls.length;
await closeEmbeddedPanel(page, noopPanel, "#tv-save");
check("при неизменённых наборах запрос не уходит", rpcCalls.length === beforeNoop, `${beforeNoop} → ${rpcCalls.length}`);

// Отказ RPC: без обхода на прямую запись и без ложного успеха.
async function saveExpectingFailure(label) {
  const panel = await openEmbeddedPanel(page, "#tv-save-btn");
  await panel.waitForSelector("#tv-delete:not(.tv-hidden)");
  await panel.click("#tv-collections .tv-choice");
  const before = rpcCalls.length;
  const beforeJunction = junctionCalls.length;
  await panel.click("#tv-save");
  // Отказ сохранения больше не уводит панель на финальный экран: ошибка живёт в
  // слоте #tv-note, редактор и Save остаются доступны для повтора (PUB-02 F1).
  await panel.waitForSelector("#tv-note.tv-err:not(.tv-hidden)");
  check(`${label}: отказ показан пользователю, панель не закрылась`, !panel.isDetached() && await page.locator("#tv-panel-host").count() === 1);
  check(`${label}: ошибка помечена как ошибка, а не как успех`, await panel.locator("#tv-note.tv-err").count() === 1 && await panel.locator("#tv-finish:not(.tv-hidden)").count() === 0);
  check(
    `${label}: панель осталась рабочей — Save и редактор видимы, кнопка активна`,
    await panel.locator("#tv-save:not(.tv-hidden)").count() === 1
      && await panel.locator("#tv-editor:not(.tv-hidden)").count() === 1
      && await panel.locator("#tv-save").isEnabled()
  );
  check(`${label}: ровно один запрос, обхода на прямую запись нет`, rpcCalls.length === before + 1 && junctionCalls.length === beforeJunction, `rpc ${before} → ${rpcCalls.length}, junction ${junctionCalls.length}`);
  check(`${label}: набор на сервере не изменился`, (storedThumbnail?.thumbnail_collections || []).length === 0);
  await closeEmbeddedPanel(page, panel, "#tv-cancel");
}

rpcMode = "deny";
await saveExpectingFailure("отказ 400");
// STRICT-дрейф функции: 200 с пустым телом успехом не считается.
rpcMode = "strict-null";
await saveExpectingFailure("200 + null");

// Повтор В ТОЙ ЖЕ панели, без переоткрытия: пользователь видит ошибку и жмёт
// Save ещё раз. Клик обычный, без force и без снятия hidden руками.
rpcMode = "deny";
const retryPanel = await openEmbeddedPanel(page, "#tv-save-btn");
await retryPanel.waitForSelector("#tv-delete:not(.tv-hidden)");
await retryPanel.click("#tv-collections .tv-choice");
await retryPanel.click("#tv-save");
await retryPanel.waitForSelector("#tv-note.tv-err:not(.tv-hidden)");
check("панель после отказа не переоткрывалась и осталась той же", !retryPanel.isDetached() && await page.locator("#tv-panel-host").count() === 1);
const beforeRetry = rpcCalls.length;
rpcMode = "ok";
await closeEmbeddedPanel(page, retryPanel, "#tv-save");
check("повтор в той же панели сохраняет набор и закрывает её", retryPanel.isDetached() && rpcCalls.length === beforeRetry + 1);
check(
  "повтор записал именно тот набор, который выбрал пользователь",
  sameSet((storedThumbnail?.thumbnail_collections || []).map((row) => row.collection_id), [COLLECTION_ID])
    && sameSet((storedThumbnail?.thumbnail_tags || []).map((row) => row.tag_id), [TAG_ID]),
  JSON.stringify(storedThumbnail)
);

// ------------------------------------------- duplicate: note + explicit delete
const duplicatePanel = await openEmbeddedPanel(page, "#tv-save-btn");
await duplicatePanel.waitForSelector("#tv-delete:not(.tv-hidden)");
check("дубликат загружает сохранённую заметку", await duplicatePanel.inputValue("#tv-note-input") === lastSavedNote);
await duplicatePanel.click("#tv-delete");
await duplicatePanel.waitForSelector("#tv-confirm:not(.tv-hidden)");
check("удаление требует отдельного подтверждения", storedThumbnail !== null);
await closeEmbeddedPanel(page, duplicatePanel, "#tv-confirm-delete");
check("подтверждённое удаление удаляет обложку", storedThumbnail === null);
check("successful removal closes the panel immediately", duplicatePanel.isDetached());

// --------------------------------------------------------------- Pinterest
const pin = await ctx.newPage();
await pin.goto("https://www.pinterest.com/");
await pin.waitForSelector("#tv-pin-btn", { timeout: 15000, state: "attached" });
await pin.mouse.move(5, 5);
await pin.evaluate(() => {
  document.getElementById("tv-pin-btn").style.display = "none";
  document.getElementById("pin").dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
  document.getElementById("pin").dispatchEvent(new PointerEvent("pointerover", { bubbles: true }));
});
await pin.waitForTimeout(250);
check(
  "synthetic mouseover не показывает Pinterest trigger",
  (await pin.evaluate(() => document.getElementById("tv-pin-btn").style.display)) === "none"
);

await pin.hover("#pin");
await pin.waitForFunction(() => document.getElementById("tv-pin-btn").style.display === "flex");
check("Pinterest feed image trigger is bottom-left", await pin.locator("#tv-pin-btn").getAttribute("data-tv-placement") === "bottom-left");
await pin.hover("#pin-video-1");
await pin.waitForFunction(() => document.getElementById("tv-pin-btn").dataset.tvMediaKind === "video");
await pin.hover("#pin-video-2");
await pin.waitForFunction(() => {
  const button = document.getElementById("tv-pin-btn").getBoundingClientRect();
  const video = document.getElementById("pin-video-2").getBoundingClientRect();
  return document.getElementById("tv-pin-btn").dataset.tvMediaKind === "video" && Math.abs(button.left - (video.left + 10)) < 2;
});
check("Pinterest trigger switches between videos without stale target", true);
await pin.hover("#pin");
await pin.evaluate(() => document.getElementById("tv-pin-btn").click());
await pin.waitForTimeout(250);
check("synthetic Pinterest click → 0 extension tabs", extensionPages().length === 0);

const beforePinPages = ctx.pages().length;
const pinPanel = await openEmbeddedPanel(pin, "#tv-pin-btn");
check("trusted Pinterest click остался в текущей вкладке", ctx.pages().length === beforePinPages);
await closeEmbeddedPanel(pin, pinPanel, "#tv-close");

const pinDetail = await ctx.newPage();
await pinDetail.goto("https://es.pinterest.com/pin/1121818588440060487/");
await pinDetail.waitForSelector("#tv-pin-btn", { timeout: 15000, state: "attached" });
await pinDetail.hover("#pin-main");
await pinDetail.waitForFunction(() => document.getElementById("tv-pin-btn").style.display === "flex");
check("Pinterest pin page trigger is top-right", await pinDetail.locator("#tv-pin-btn").getAttribute("data-tv-placement") === "top-right");
await pinDetail.hover("#pin-deep-overlay");
await pinDetail.waitForFunction(() => document.getElementById("tv-pin-btn").dataset.tvPlacement === "bottom-left");
check("Pinterest recommendation overlay resolves through deep card controls", await pinDetail.locator("#tv-pin-btn").getAttribute("data-tv-placement") === "bottom-left");

// --------------------------------------------------------------- Public popup
const popup = await ctx.newPage();
await popup.setViewportSize({ width: 360, height: 640 });
await popup.goto(`chrome-extension://${extensionId}/popup.html`);
await popup.waitForFunction(() => getComputedStyle(document.getElementById("account")).display === "block");
await popup.click("#langButton");
await popup.getByRole("menuitemradio", { name: "Español" }).click();
await popup.waitForFunction(() => document.body.innerText.includes("Sesión iniciada"));
check("язык public popup переключается", true);
await popup.click("#langButton");
await popup.getByRole("menuitemradio", { name: "Русский" }).click();
if (SCREENSHOT_DIR) await popup.screenshot({ path: join(SCREENSHOT_DIR, "public-popup.png"), fullPage: true });

// ------------------------------------------------------- изоляция от продакшена
// Дубль POST мог бы прийти уже после локальной проверки выше, поэтому счётчик
// пересматривается в конце прогона, когда всё сетевое давно осело.
check(
  "за весь прогон папка создавалась ровно один раз",
  collectionPosts.filter((name) => name === "Regression folder").length === 1,
  JSON.stringify(collectionPosts)
);
// Ровно два Follow за прогон — до перехода и после него — и каждый записал свой
// канал. Счётчик пересматривается в конце, когда всё сетевое давно осело: дубль,
// пришедший позже локальной проверки, был бы виден здесь.
check(
  "за весь прогон канал записывался ровно дважды — по разу на каждый Follow",
  channelCalls.length === 2,
  String(channelCalls.length)
);
check(
  "два Follow записали два РАЗНЫХ канала, каждый — свой",
  channelCalls[0]?.body?.channel_id === CHANNEL_ID && channelCalls[1]?.body?.channel_id === SECOND_CHANNEL_ID,
  channelCalls.map((call) => call?.body?.channel_id).join(" / ")
);
check("прямых junction-запросов не было за весь прогон", junctionCalls.length === 0, JSON.stringify(junctionCalls));
// Счётчик пересматривается в конце: запрос, ушедший позже локальной проверки,
// был бы виден здесь. Регистрируется сама попытка запроса, а не её успех —
// DNS-бэкстоп убил бы её в любом случае, и молчание было бы не доказательством.
check(
  "за весь прогон ни один адрес назначения редиректа не запрашивался",
  forbiddenHits.length === 0,
  JSON.stringify(forbiddenHits)
);
check("весь Supabase-трафик обслужен фикстурой, ни один запрос не ушёл наружу", served >= requests.length && requests.length > 0, `наблюдено ${requests.length}, обслужено ${served}`);
check("в сеть уходил только синтетический apikey", apikeys.size === 1 && apikeys.has(SYNTHETIC_ANON_KEY), [...apikeys].map((key) => key.slice(0, 16)).join(","));
check(
  "непредусмотренная сеть заблокирована и Supabase среди неё нет",
  blocked.every((entry) => !entry.url.includes("supabase.co")),
  `оборвано ${blocked.length}: ${[...new Set(blocked.map((entry) => new URL(entry.url).origin))].join(" ")}`
);

  const failed = results.filter((result) => !result.ok);
  console.log(`\n${results.length - failed.length}/${results.length} PASS`);
  process.exitCode = failed.length ? 1 : 0;
} finally {
  await ctx?.close().catch(() => {});
  rmSync(profileDir, { recursive: true, force: true });
  rmSync(extDir, { recursive: true, force: true });
}

// PUB-04: smoke установочного артефакта — того, что получит пользователь.
//
//   TV_ARTIFACT=<каталог релиза упаковщика> TV_CHROME=<chrome>
//   TV_PLAYWRIGHT_ROOT=<dir-with-node_modules> [TV_SCREENSHOT_DIR=<каталог>]
//   [TV_EXPECT_COMMIT=<40 hex коммита, из которого обязан быть собран артефакт>]
//   node extensions/public/tests/release-artifact.check.mjs
//
// <каталог релиза> — то, что пишет tools/package-release.mjs --out:
//   ThumbSight-Public-Beta-<version>-<date>.zip, <zip>.sha256,
//   <zip>.provenance.json, unpacked/.
//
// Что проверяется:
//   1. Целостность: sha256 ZIP == .sha256 == provenance.zipSha256.
//   2. Состав: собственный читатель ZIP (EOCD → central directory → local
//      header → inflateRaw) — 27 записей, имена с прямыми слэшами, CRC и
//      размеры сходятся, байты каждой записи == unpacked/<путь>, sha256 ==
//      provenance.files.
//   2a. provenance против manifest.json РЕПОЗИТОРИЯ (../manifest.json от этого
//      скрипта): sourceDirty === false, worktreeFiles пуст, sourceCommit — 40
//      hex (== TV_EXPECT_COMMIT, если задан), version / versionName и
//      minimum_chrome_version артефакта равны полям репозитория.
//   3. config.js из ZIP — ТОЛЬКО статически и без печати значений: одно
//      присваивание THUMBVAULT_CONFIG, ровно ключи SUPABASE_URL /
//      SUPABASE_ANON_KEY [/ AUTH_SITE_URL], SUPABASE_URL == origin
//      host_permissions манифеста. В браузер этот файл НЕ грузится.
//   4. Браузер: во временную копию кладутся байты ровно из ZIP, кроме
//      config.js — вместо него синтетический. Расширение поднимается с
//      --load-extension: ID, версия из service worker, popup и его штамп
//      версии, иконка из пакета, content script на подменённой YouTube.
//
// Сеть: route-слой + --host-resolver-rules=MAP * ~NOTFOUND; YouTube — локальная
// фикстура. Профиль и копия — временные каталоги, удаляются за собой.
//
// Коды выхода: 0 — PASS; 1 — FAIL; 2 — неверный вызов.
process.env.PW_EXPERIMENTAL_SERVICE_WORKER_NETWORK_EVENTS = "1";

import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
import { crc32, inflateRawSync } from "node:zlib";
import { fileURLToPath } from "node:url";

const require = createRequire(
  process.env.TV_PLAYWRIGHT_ROOT
    ? join(resolve(process.env.TV_PLAYWRIGHT_ROOT), "package.json")
    : import.meta.url
);
const { chromium } = require("playwright-core");

const ARTIFACT = process.env.TV_ARTIFACT;
const CHROME = process.env.TV_CHROME;
if (!ARTIFACT || !CHROME) {
  console.error("Задай TV_ARTIFACT (каталог релиза упаковщика) и TV_CHROME (путь к Chromium).");
  process.exit(2);
}
const SCREENSHOT_DIR = process.env.TV_SCREENSHOT_DIR || "";

// Публичный ID расширения: производная manifest.key. Смена ID — ломающее
// изменение для пользователей (теряются storage и привязка OAuth), поэтому он
// закреплён здесь явно.
const EXPECTED_ID = "eaglnoljaplmhgmlgahndpgeakebgmfb";
const EXPECTED_ENTRIES = 27;

const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");
const results = [];
const check = (name, ok, detail = "") => {
  results.push({ ok, name });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
  return ok;
};

// ------------------------------------------------------------- файлы релиза
const dir = resolve(ARTIFACT);
const zips = readdirSync(dir).filter((name) => /^ThumbSight-Public-Beta-.+\.zip$/.test(name));
if (zips.length !== 1) {
  console.error(`В ${dir} ожидается ровно один ZIP релиза, найдено ${zips.length}`);
  process.exit(2);
}
const zipName = zips[0];
const zipPath = join(dir, zipName);
const zip = readFileSync(zipPath);
const shaFile = readFileSync(`${zipPath}.sha256`, "utf8");
const provenance = JSON.parse(readFileSync(`${zipPath}.provenance.json`, "utf8"));
const unpackedDir = join(dir, "unpacked");
console.log(`Артефакт: ${zipName}, ${zip.length} байт`);
console.log(`provenance: version ${provenance.version} (${provenance.versionName}), date ${provenance.date}, sourceCommit ${provenance.sourceCommit}, sourceDirty ${provenance.sourceDirty}, worktreeFiles ${JSON.stringify(provenance.worktreeFiles)}`);

// ------------------------------------------------------------- 1. целостность
const zipSha = sha256(zip);
const shaLine = /^([0-9a-f]{64})  (.+)\n$/.exec(shaFile);
check(".sha256 в формате «<hex>  <имя>\\n» и называет этот ZIP", !!shaLine && shaLine[2] === zipName, JSON.stringify(shaFile.slice(0, 80)));
check("sha256 ZIP == .sha256", !!shaLine && shaLine[1] === zipSha, zipSha);
check("sha256 ZIP == provenance.zipSha256", provenance.zipSha256 === zipSha, provenance.zipSha256);
check("размер ZIP == provenance.zipBytes", provenance.zipBytes === zip.length, `${provenance.zipBytes} / ${zip.length}`);

// ------------------------------------------------------------- 2. состав
function readZip(buf) {
  const eocd = buf.length - 22;
  if (eocd < 0 || buf.readUInt32LE(eocd) !== 0x06054b50) throw new Error("EOCD не на месте (комментарий или мусор в хвосте)");
  const count = buf.readUInt16LE(eocd + 10);
  if (buf.readUInt16LE(eocd + 8) !== count) throw new Error("число записей в EOCD не согласовано");
  const cdSize = buf.readUInt32LE(eocd + 12);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  if (cdOffset + cdSize !== eocd) throw new Error("central directory не примыкает к EOCD");
  const entries = [];
  let p = cdOffset;
  for (let i = 0; i < count; i += 1) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error(`central header №${i}`);
    const c = {
      flags: buf.readUInt16LE(p + 8),
      method: buf.readUInt16LE(p + 10),
      crc: buf.readUInt32LE(p + 16),
      csize: buf.readUInt32LE(p + 20),
      usize: buf.readUInt32LE(p + 24),
      nameLen: buf.readUInt16LE(p + 28),
      extraLen: buf.readUInt16LE(p + 30),
      commentLen: buf.readUInt16LE(p + 32),
      localOffset: buf.readUInt32LE(p + 42),
    };
    c.name = buf.toString("utf8", p + 46, p + 46 + c.nameLen);
    p += 46 + c.nameLen + c.extraLen + c.commentLen;
    const l = c.localOffset;
    if (buf.readUInt32LE(l) !== 0x04034b50) throw new Error(`local header ${c.name}`);
    const localNameLen = buf.readUInt16LE(l + 26);
    const localExtraLen = buf.readUInt16LE(l + 28);
    const localName = buf.toString("utf8", l + 30, l + 30 + localNameLen);
    const start = l + 30 + localNameLen + localExtraLen;
    const raw = buf.subarray(start, start + c.csize);
    const data = c.method === 8 ? inflateRawSync(raw) : c.method === 0 ? Buffer.from(raw) : null;
    if (!data) throw new Error(`${c.name}: метод сжатия ${c.method}`);
    entries.push({ ...c, localName, data });
  }
  if (p !== cdOffset + cdSize) throw new Error("central directory длиннее заявленного");
  return entries;
}

function listFiles(root, prefix = "") {
  const out = [];
  for (const ent of readdirSync(root, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${ent.name}` : ent.name;
    if (ent.isDirectory()) out.push(...listFiles(join(root, ent.name), rel));
    else out.push(rel);
  }
  return out;
}

let entries = [];
try {
  entries = readZip(zip);
  check("ZIP читается собственным читателем (EOCD → CD → local → inflateRaw)", true, `${entries.length} записей`);
} catch (err) {
  check("ZIP читается собственным читателем (EOCD → CD → local → inflateRaw)", false, String(err.message));
}
check(`в ZIP ровно ${EXPECTED_ENTRIES} записей`, entries.length === EXPECTED_ENTRIES, String(entries.length));
const names = entries.map((e) => e.name);
const badNames = names.filter((n) => n.includes("\\") || n.startsWith("/") || n.split("/").includes("..") || !/^[A-Za-z0-9_.-]+(\/[A-Za-z0-9_.-]+)*$/.test(n));
check("имена записей — относительные, с прямыми слэшами", badNames.length === 0, JSON.stringify(badNames));
check("имена без повторов, local header == central directory",
  new Set(names).size === names.length && entries.every((e) => e.localName === e.name));
const crcBad = entries.filter((e) => crc32(e.data) >>> 0 !== e.crc || e.data.length !== e.usize).map((e) => e.name);
check("CRC-32 и размеры записей сходятся", crcBad.length === 0, JSON.stringify(crcBad));

const provFiles = new Map((provenance.files || []).map((f) => [f.path, f]));
check("provenance.files перечисляет те же записи", provFiles.size === names.length && names.every((n) => provFiles.has(n)),
  `${provFiles.size} / ${names.length}`);
const shaBad = entries.filter((e) => provFiles.get(e.name)?.sha256 !== sha256(e.data) || provFiles.get(e.name)?.bytes !== e.data.length).map((e) => e.name);
check("sha256 и размер каждой записи == provenance.files", shaBad.length === 0, JSON.stringify(shaBad));
const unpackedList = existsSync(unpackedDir) ? listFiles(unpackedDir).sort() : [];
check("unpacked/ содержит ровно те же файлы", JSON.stringify(unpackedList) === JSON.stringify([...names].sort()),
  `${unpackedList.length} файлов`);
const unpackedBad = entries.filter((e) => {
  try {
    return !readFileSync(join(unpackedDir, ...e.name.split("/"))).equals(e.data);
  } catch (_) {
    return true;
  }
}).map((e) => e.name);
check("байты каждой записи == unpacked/<путь>", unpackedBad.length === 0, JSON.stringify(unpackedBad));

const entry = (name) => entries.find((e) => e.name === name)?.data || null;
const manifestBytes = entry("manifest.json");
const manifest = manifestBytes ? JSON.parse(manifestBytes.toString("utf8")) : {};
check("manifest.version == provenance.version", manifest.version === provenance.version, `${manifest.version} / ${provenance.version}`);
check("manifest.version_name == provenance.versionName", manifest.version_name === provenance.versionName,
  `${manifest.version_name} / ${provenance.versionName}`);
console.log(`manifest: minimum_chrome_version ${manifest.minimum_chrome_version}`);

// ------------------------------------------------------------- 2a. provenance
// Сверки выше только внутренние: артефакт мог быть самосогласованным, но
// собранным из грязного дерева, из чужого коммита, с другой версией или нижней
// границей. Эталон — manifest.json РЕПОЗИТОРИЯ, рядом с которым лежит этот
// скрипт (tests/ → ../manifest.json), а не манифест самого артефакта.
{
  const repoManifestPath = resolve(dirname(fileURLToPath(import.meta.url)), "..", "manifest.json");
  let repoManifest = {};
  try {
    repoManifest = JSON.parse(readFileSync(repoManifestPath, "utf8"));
  } catch (err) {
    check("manifest.json репозитория читается", false, `${repoManifestPath}: ${String(err?.message || err)}`);
  }
  check("provenance.sourceDirty === false (сборка из чистого дерева)", provenance.sourceDirty === false,
    JSON.stringify(provenance.sourceDirty));
  check("provenance.worktreeFiles — пустой массив (все файлы из коммита)",
    Array.isArray(provenance.worktreeFiles) && provenance.worktreeFiles.length === 0,
    JSON.stringify(provenance.worktreeFiles));
  const expectCommit = process.env.TV_EXPECT_COMMIT || "";
  const commitOk = typeof provenance.sourceCommit === "string" && /^[0-9a-f]{40}$/.test(provenance.sourceCommit)
    && (!expectCommit || provenance.sourceCommit === expectCommit);
  check(`provenance.sourceCommit — 40 hex${expectCommit ? " и == TV_EXPECT_COMMIT" : ""}`, commitOk,
    `${provenance.sourceCommit}${expectCommit ? ` / ${expectCommit}` : ""}`);
  check("provenance.version == manifest.json репозитория", typeof repoManifest.version === "string"
    && provenance.version === repoManifest.version, `${provenance.version} / ${repoManifest.version}`);
  check("provenance.versionName == version_name репозитория", typeof repoManifest.version_name === "string"
    && provenance.versionName === repoManifest.version_name, `${provenance.versionName} / ${repoManifest.version_name}`);
  check("minimum_chrome_version артефакта == manifest.json репозитория", typeof repoManifest.minimum_chrome_version === "string"
    && manifest.minimum_chrome_version === repoManifest.minimum_chrome_version,
    `${manifest.minimum_chrome_version} / ${repoManifest.minimum_chrome_version}`);
}

// ------------------------------------------------------------- 3. config.js
// Только форма. Значения не печатаются ни целиком, ни частями.
{
  const text = entry("config.js")?.toString("utf8") ?? "";
  const lines = text.split("\n");
  const head = /^(\(globalThis\.window \|\| globalThis\)|window|globalThis)\.THUMBVAULT_CONFIG = \{$/;
  const pair = /^ {2}([A-Z_]+): "([^"\\]*)",$/;
  const okShape = lines.length >= 4 && head.test(lines[0]) && lines.at(-1) === "" && lines.at(-2) === "}" + ";"
    && lines.slice(1, -2).every((line) => pair.test(line));
  check("config.js — одно присваивание THUMBVAULT_CONFIG из строковых полей", okShape,
    `строк ${lines.length}, присваиваний ${(text.match(/THUMBVAULT_CONFIG\s*=/g) || []).length}`);
  const values = new Map(lines.slice(1, -2).map((line) => pair.exec(line)).filter(Boolean).map((m) => [m[1], m[2]]));
  const keys = [...values.keys()].sort();
  const allowed = [["SUPABASE_ANON_KEY", "SUPABASE_URL"], ["AUTH_SITE_URL", "SUPABASE_ANON_KEY", "SUPABASE_URL"]];
  check("config.js: ровно ключи SUPABASE_URL, SUPABASE_ANON_KEY[, AUTH_SITE_URL]",
    allowed.some((set) => JSON.stringify(set) === JSON.stringify(keys)), JSON.stringify(keys));
  const hostOrigin = (() => {
    try {
      return new URL(String(manifest.host_permissions?.[0] || "").replace(/\*$/, "")).origin;
    } catch (_) {
      return "";
    }
  })();
  check("config.js: SUPABASE_URL == origin host_permissions манифеста",
    !!hostOrigin && values.get("SUPABASE_URL") === hostOrigin, `origin манифеста ${hostOrigin}`);
  const key = values.get("SUPABASE_ANON_KEY") || "";
  check("config.js: SUPABASE_ANON_KEY непуст и имеет форму JWT (значение не печатается)",
    /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(key), `длина ${key.length}`);
}

// ------------------------------------------------------------- 4. браузер
const PREFIX = "tv-artifact-run-";
const runDir = mkdtempSync(join(tmpdir(), PREFIX));
{
  const abs = resolve(runDir);
  if (!abs.startsWith(resolve(tmpdir()) + sep) || !basename(abs).startsWith(PREFIX)) throw new Error(`Каталог вне Temp: ${abs}`);
}
const extDir = join(runDir, "ext");
const profileDir = join(runDir, "profile");
mkdirSync(profileDir, { recursive: true });
for (const e of entries) {
  if (e.name === "config.js") continue; // настоящий config пакета в браузер не идёт
  const target = join(extDir, ...e.name.split("/"));
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, e.data);
}
const SB_ORIGIN = new URL(String(manifest.host_permissions[0]).replace(/\*$/, "")).origin;
writeFileSync(join(extDir, "config.js"), `(globalThis.window || globalThis).THUMBVAULT_CONFIG = {
  SUPABASE_URL: "${SB_ORIGIN}",
  SUPABASE_ANON_KEY: "synthetic-anon-key-${"k".repeat(40)}",
  AUTH_SITE_URL: "https://thumbsight.invalid",
};
`);
const swapped = listFiles(extDir).filter((rel) => rel !== "config.js")
  .filter((rel) => !readFileSync(join(extDir, ...rel.split("/"))).equals(entry(rel)));
check("копия для браузера: все байты из ZIP, кроме подменённого config.js", swapped.length === 0 && listFiles(extDir).length === entries.length,
  `${listFiles(extDir).length} файлов`);

const digest = createHash("sha256").update(Buffer.from(manifest.key || "", "base64")).digest();
const keyId = [...digest.subarray(0, 16)].flatMap((b) => [b >> 4, b & 15]).map((n) => String.fromCharCode(97 + n)).join("");
check("ID из manifest.key == опубликованный ID", keyId === EXPECTED_ID, `${keyId} / ${EXPECTED_ID}`);

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
const YT_PAGE = `<!doctype html><html lang="fr"><head><meta charset="utf-8"><title>fixture</title></head>
<body><ytd-watch-metadata><div id="top-level-buttons-computed"></div></ytd-watch-metadata></body></html>`;

let ctx = null;
let fullVersion = "unknown";
const pageErrors = [];
try {
  ctx = await chromium.launchPersistentContext(profileDir, {
    executablePath: CHROME,
    headless: false,
    args: [
      "--disable-features=DisableLoadExtensionCommandLineSwitch",
      "--host-resolver-rules=MAP * ~NOTFOUND",
      "--noerrdialogs",
      `--disable-extensions-except=${extDir}`,
      `--load-extension=${extDir}`,
    ],
  });
  ctx.on("weberror", (error) => pageErrors.push(String(error.error())));
  const blocked = [];
  await ctx.route(/^https?:\/\//i, (route) => {
    blocked.push(route.request().url());
    return route.abort("blockedbyclient");
  });
  await ctx.route("**://i.ytimg.com/**", (route) => route.fulfill({ contentType: "image/png", body: PNG }));
  await ctx.route("**://*.youtube.com/**", (route) => route.fulfill({ contentType: "text/html", body: YT_PAGE }));
  await ctx.route("**://*.supabase.co/**", (route) => route.fulfill({ status: 200, contentType: "application/json", body: "[]" }));

  const isOurs = (w) => w.url().startsWith("chrome-extension://");
  const worker = ctx.serviceWorkers().find(isOurs)
    || (await ctx.waitForEvent("serviceworker", { predicate: isOurs, timeout: 20000 }).catch(() => null));
  const versionPage = await ctx.newPage();
  await versionPage.goto("chrome://version/");
  fullVersion = (await versionPage.locator("#version").innerText().catch(() => "")).trim().split(/\s/)[0] || "unknown";
  await versionPage.close();
  console.log(`Chromium: ${fullVersion}`);

  if (!check("service worker расширения появился (≤ 20 с)", !!worker)) throw new Error("расширение не загрузилось");
  const loadedId = new URL(worker.url()).host;
  check("ID загруженного расширения == ожидаемый", loadedId === EXPECTED_ID, `${loadedId} / ${EXPECTED_ID}`);
  const swVersion = await worker.evaluate(() => chrome.runtime.getManifest().version);
  check("getManifest().version из worker == provenance.version", swVersion === provenance.version, `${swVersion} / ${provenance.version}`);

  // Иконка из пакета, отданная самим расширением.
  const icon = await worker.evaluate(async () => {
    const res = await fetch(chrome.runtime.getURL("icons/icon128.png"));
    const bytes = new Uint8Array(await res.arrayBuffer());
    let bin = "";
    for (const b of bytes) bin += String.fromCharCode(b);
    return { status: res.status, b64: btoa(bin) };
  });
  const iconBytes = Buffer.from(icon.b64, "base64");
  check("fetch(icons/icon128.png) из worker → 200, PNG-сигнатура, байты из ZIP",
    icon.status === 200 && iconBytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
      && iconBytes.equals(entry("icons/icon128.png")),
    `status ${icon.status}, ${iconBytes.length} байт`);

  // popup и штамп версии: «<суффикс> <база>» из version_name «<база>-<суффикс>».
  const [base, suffix] = String(manifest.version_name).split("-");
  const expectedStamp = suffix ? `${suffix} ${base}` : base;
  const popup = await ctx.newPage();
  await popup.setViewportSize({ width: 380, height: 640 });
  await popup.goto(`chrome-extension://${loadedId}/popup.html`);
  await popup.waitForSelector(".stamp", { timeout: 15000 });
  await popup.waitForFunction(() => globalThis.TVI18N && document.documentElement.lang, null, { timeout: 15000 }).catch(() => {});
  const stamp = (await popup.locator("footer .stamp").innerText()).trim();
  check(`popup открылся, штамп в футере == «${expectedStamp}»`, stamp === expectedStamp, JSON.stringify(stamp));
  if (SCREENSHOT_DIR) {
    mkdirSync(SCREENSHOT_DIR, { recursive: true });
    const major = fullVersion.split(".")[0];
    const shot = join(SCREENSHOT_DIR, `popup-${major}.png`);
    await popup.screenshot({ path: shot, fullPage: true });
    console.log(`снимок popup: ${shot}`);
  }
  await popup.close();

  // content script на подменённой YouTube: кнопка расширения (как в pub01).
  const yt = await ctx.newPage();
  await yt.goto("https://www.youtube.com/watch?v=dQw4w9WgXcQ");
  const injected = await yt.waitForSelector("#tv-save-btn", { state: "attached", timeout: 15000 }).then(() => true).catch(() => false);
  check("content script на YouTube-фикстуре внедрил #tv-save-btn", injected);
  await yt.close();

  check("необработанных ошибок страницы не было", pageErrors.length === 0, JSON.stringify(pageErrors.slice(0, 3)));
  check("наружу не ушло ничего мимо фикстур", blocked.every((url) => !/supabase\.co|youtube\.com|ytimg\.com/.test(url)),
    `оборвано ${blocked.length}`);
} catch (err) {
  check("браузерная часть выполнилась без исключений", false, String(err?.message || err).split("\n")[0]);
} finally {
  await ctx?.close().catch(() => {});
  try {
    rmSync(runDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    console.log(`cleanup: ${runDir}`);
  } catch (err) {
    console.log(`cleanup не удался, каталог остался: ${runDir} — ${String(err?.code || err)}`);
  }
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} PASS`);
if (failed.length) console.log(`FAILED: ${failed.map((r) => r.name).join(" | ")}`);
console.log(`GATE artifact Chromium ${fullVersion}: ${failed.length ? "FAIL" : "PASS"}`);
process.exitCode = failed.length ? 1 : 0;

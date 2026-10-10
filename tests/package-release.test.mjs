// node --test: упаковщик установочного ZIP (tools/package-release.mjs).
//
// Все сборки идут из ВРЕМЕННОЙ КОПИИ расширения, собранной по спискам
// tools/runtime-files.mjs (RUNTIME + SHIPPED_DOCS + TOOLS). Настоящий
// config.js не копируется, не читается и не передаётся: config здесь
// синтетический, его ключ — самодельный JWT с произвольной подписью.
//
// Проверяем не «упало ли», а что именно лежит в пакете: собственный читатель
// ZIP (EOCD → central directory → local header → inflateRaw) сверяет каждую
// запись с байтами исходной копии, а каждый запуск инструмента — успешный и
// отказной — проверяется на отсутствие ключа и его частей в выводе.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync,
  realpathSync, rmSync, statSync, writeFileSync,
} from "node:fs";
import { delimiter, dirname, join, relative, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import { crc32 as zlibCrc32, inflateRawSync } from "node:zlib";
import {
  DOCS, META, NEVER, PACKAGE, RUNTIME, RUNTIME_UNSHIPPED, SHIPPED_DOCS, TEMPLATE, TESTS, TOOLS,
} from "../tools/runtime-files.mjs";

const SRC = resolve(import.meta.dirname, "..");
const PREFIX = "tv-pkg-";
const DATE = "2026-10-10";

const sha = (buf) => createHash("sha256").update(buf).digest("hex");

// ------------------------------------------------------------- временные каталоги

const made = [];
function scratch() {
  const dir = mkdtempSync(join(tmpdir(), PREFIX));
  made.push(dir);
  return dir;
}

// Удаляем только то, что создали сами: прямой ребёнок os.tmpdir с нашим
// префиксом. Ни маски, ни отбора по времени, ни чужих каталогов.
function cleanup() {
  const parent = resolve(tmpdir());
  for (const dir of made.splice(0)) {
    const base = dir.slice(parent.length + 1);
    if (!dir.startsWith(parent + sep) || !base.startsWith(PREFIX) || base.includes(sep)) continue;
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* занято */ }
  }
}
test.after(cleanup);

// Копия расширения по спискам. Настоящий config.js сюда не попадает: его
// нет ни в одном из копируемых списков.
function makeCopy() {
  const root = scratch();
  for (const rel of new Set([...RUNTIME, ...SHIPPED_DOCS, ...TOOLS])) {
    assert.ok(!NEVER.has(rel.split("/").pop()), `в копию попало запрещённое имя ${rel}`);
    const target = join(root, ...rel.split("/"));
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(join(SRC, rel), target);
  }
  assert.equal(existsSync(join(root, "config.js")), false);
  return root;
}

// ------------------------------------------------------------- синтетический config

const MANIFEST = JSON.parse(readFileSync(join(SRC, "manifest.json"), "utf8"));
const ORIGIN = MANIFEST.host_permissions[0].slice(0, -2);
const REF = new URL(ORIGIN).hostname.split(".")[0];
const ZIP_NAME = `ThumbSight-Public-Beta-${MANIFEST.version}-${DATE}.zip`;

const b64 = (obj) => Buffer.from(JSON.stringify(obj)).toString("base64url");
const SIGNATURE = "U3ludGhldGljLXNpZ25hdHVyZS1mb3ItdGVzdHMtb25seQ";

function makeKey({ header = {}, payload = {}, drop = [] } = {}) {
  const head = { alg: "HS256", typ: "JWT", ...header };
  const body = { iss: "supabase", ref: REF, role: "anon", iat: 1700000000, exp: 4102444800, ...payload };
  for (const name of drop) delete body[name];
  return `${b64(head)}.${b64(body)}.${SIGNATURE}`;
}

const KEY = makeKey();
const KEY_PAYLOAD = KEY.split(".")[1];

function configText({ url = ORIGIN, key = KEY, auth = "https://thumbsight.com", lines = null } = {}) {
  const pairs = lines ?? [
    `  SUPABASE_URL: "${url}",`,
    `  SUPABASE_ANON_KEY: "${key}",`,
    ...(auth === null ? [] : [`  AUTH_SITE_URL: '${auth}',`]),
  ];
  return [
    "// synthetic test config: comments must not reach the package",
    "/* block comment */",
    "(globalThis.window || globalThis).THUMBVAULT_CONFIG = {",
    ...pairs,
    "};",
    "",
  ].join("\n");
}

function expectedConfig(auth = "https://thumbsight.com") {
  return [
    "(globalThis.window || globalThis).THUMBVAULT_CONFIG = {",
    `  SUPABASE_URL: "${ORIGIN}",`,
    `  SUPABASE_ANON_KEY: "${KEY}",`,
    ...(auth === null ? [] : [`  AUTH_SITE_URL: "${auth}",`]),
    "};",
    "",
  ].join("\n");
}

function writeConfig(text) {
  const path = join(scratch(), "config.js");
  writeFileSync(path, text);
  return path;
}

// ------------------------------------------------------------- запуск

// Git не должен находить репозиторий выше временного каталога.
const CEILING = [...new Set([resolve(tmpdir()), realpathSync.native(tmpdir())])].join(delimiter);

const transcripts = [];

// Ни один запуск не имеет права напечатать ключ, его payload или подпись.
function assertNoLeak(out, secrets = [KEY, KEY_PAYLOAD, SIGNATURE]) {
  for (const s of secrets) {
    assert.equal(out.includes(s), false, "вывод инструмента содержит ключ или его часть");
  }
}

function pack(root, args, { env = null, secrets } = {}) {
  const r = spawnSync(process.execPath, [join(root, "tools", "package-release.mjs"), ...args], {
    encoding: "utf8",
    env: env ?? { ...process.env, GIT_CEILING_DIRECTORIES: CEILING },
    windowsHide: true,
  });
  const out = `${r.stdout}${r.stderr}`;
  transcripts.push(out);
  assertNoLeak(out, secrets);
  return { status: r.status, out };
}

function build(root, { config = configText(), date = DATE, extra = [], env } = {}) {
  const out = join(scratch(), "release");
  const r = pack(root, ["--config", writeConfig(config), "--out", out, "--date", date, ...extra], { env });
  return { ...r, dir: out, zipPath: join(out, `ThumbSight-Public-Beta-${MANIFEST.version}-${date}.zip`) };
}

const gitProbe = spawnSync("git", ["--version"], { encoding: "utf8", windowsHide: true });
const gitAvailable = !gitProbe.error && gitProbe.status === 0;
const skipNoGit = gitAvailable ? false : "git недоступен в этой среде";

function git(root, args, { autocrlf = "false", encoding = "utf8" } = {}) {
  const r = spawnSync("git", [
    "-C", root,
    "-c", "user.name=tv-test", "-c", "user.email=tv-test@example.invalid",
    "-c", `core.autocrlf=${autocrlf}`, "-c", "commit.gpgsign=false",
    ...args,
  ], { encoding, windowsHide: true, env: { ...process.env, GIT_CEILING_DIRECTORIES: CEILING } });
  assert.equal(r.status, 0, `git ${args.join(" ")}: ${r.stderr}`);
  return encoding === "utf8" ? r.stdout.trim() : r.stdout;
}

// ------------------------------------------------------------- читатель ZIP

function readZip(buf) {
  const eocd = buf.length - 22;
  assert.equal(buf.readUInt32LE(eocd), 0x06054b50, "EOCD не на месте (комментарий или мусор в хвосте)");
  const count = buf.readUInt16LE(eocd + 10);
  assert.equal(buf.readUInt16LE(eocd + 8), count);
  const cdSize = buf.readUInt32LE(eocd + 12);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  assert.equal(cdOffset + cdSize, eocd, "central directory не примыкает к EOCD");

  const entries = [];
  let p = cdOffset;
  for (let i = 0; i < count; i += 1) {
    assert.equal(buf.readUInt32LE(p), 0x02014b50, `central header №${i}`);
    const c = {
      flags: buf.readUInt16LE(p + 8),
      method: buf.readUInt16LE(p + 10),
      time: buf.readUInt16LE(p + 12),
      date: buf.readUInt16LE(p + 14),
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
    assert.equal(buf.readUInt32LE(l), 0x04034b50, `local header ${c.name}`);
    const local = {
      flags: buf.readUInt16LE(l + 6),
      method: buf.readUInt16LE(l + 8),
      time: buf.readUInt16LE(l + 10),
      date: buf.readUInt16LE(l + 12),
      crc: buf.readUInt32LE(l + 14),
      csize: buf.readUInt32LE(l + 18),
      usize: buf.readUInt32LE(l + 22),
      nameLen: buf.readUInt16LE(l + 26),
      extraLen: buf.readUInt16LE(l + 28),
    };
    const localName = buf.toString("utf8", l + 30, l + 30 + local.nameLen);
    const start = l + 30 + local.nameLen + local.extraLen;
    const data = inflateRawSync(buf.subarray(start, start + c.csize));
    entries.push({ ...c, local, localName, data });
  }
  assert.equal(p, cdOffset + cdSize, "central directory длиннее заявленного");
  return entries;
}

const [Y, M, D] = DATE.split("-").map(Number);
const DOS_DATE = ((Y - 1980) << 9) | (M << 5) | D;

function listFiles(dir, prefix = "") {
  const out = [];
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${ent.name}` : ent.name;
    if (ent.isDirectory()) out.push(...listFiles(join(dir, ent.name), rel));
    else out.push(rel);
  }
  return out;
}

// ------------------------------------------------------------- состав списков

test("списки runtime-files существуют в расширении и не содержат запрещённых имён", () => {
  const all = [
    ...RUNTIME, ...RUNTIME_UNSHIPPED, ...TEMPLATE, ...DOCS, ...META, ...PACKAGE, ...TOOLS, ...TESTS, ...SHIPPED_DOCS,
  ];
  for (const rel of new Set(all)) {
    assert.ok(!NEVER.has(rel.split("/").pop()), `${rel} в запрещённых`);
    assert.ok(existsSync(join(SRC, rel)), `нет файла ${rel}`);
  }
  // Срез несёт упаковщик, значит обязан нести и всё, что упаковщик кладёт в ZIP.
  for (const rel of SHIPPED_DOCS) assert.ok(DOCS.includes(rel), `${rel} едет в ZIP, но не в срез исходников`);
  assert.equal(RUNTIME.length, 23);
  assert.deepEqual(SHIPPED_DOCS, ["INSTALL.md", "LICENSE", "THIRD_PARTY_NOTICES.md"]);
  assert.equal(new Set([...RUNTIME, ...SHIPPED_DOCS]).size, 26);
  assert.ok(DOCS.includes("LICENSE"));
  assert.ok(TOOLS.includes("tools/runtime-files.mjs") && TOOLS.includes("tools/package-release.mjs"));
  assert.ok(TESTS.includes("tests/package-release.test.mjs"));
  assert.deepEqual(META, [".gitattributes"]);
});

// Настоящий export-source в новый каталог под os.tmpdir — без заглушек.
function exportSource() {
  const dest = join(scratch(), "export");
  const exp = spawnSync(process.execPath, [join(SRC, "tools", "export-source.mjs"), dest], { encoding: "utf8" });
  assert.equal(exp.status, 0, `${exp.stdout}${exp.stderr}`);
  return dest;
}

test("export-source в пустой каталог проходит verify-sums", () => {
  const dest = exportSource();
  assert.equal(existsSync(join(dest, "config.js")), false);
  for (const rel of [...TOOLS, ...SHIPPED_DOCS, ...META, "tests/package-release.test.mjs"]) {
    assert.ok(existsSync(join(dest, rel)), `в экспорте нет ${rel}`);
  }
  // META едет как есть, байт в байт.
  for (const rel of META) {
    assert.ok(readFileSync(join(dest, rel)).equals(readFileSync(join(SRC, rel))), `${rel} в экспорте не тот`);
  }
  const ver = spawnSync(process.execPath, [join(SRC, "tools", "verify-sums.mjs"), dest], { encoding: "utf8" });
  assert.equal(ver.status, 0, `${ver.stdout}${ver.stderr}`);
  assert.match(ver.stdout, /^OK$/m);
  const sums = readFileSync(join(dest, "SHA256SUMS.txt"), "utf8");
  for (const rel of META) assert.match(sums, new RegExp(`  ${rel.replace(/\./g, "\\.")}$`, "m"), `${rel} нет в SHA256SUMS`);
});

// Путь в другом регистре — то же место на win32 (и на регистронезависимой ФС):
// экспорт обязан отказать, а не начать писать внутрь исходников.
test("export-source: назначение внутри корня копии в другом регистре — код 2, ничего не записано", () => {
  const root = makeCopy(); // TOOLS входят в копию, export-source.mjs тоже
  const flip = (s) => s.replace(/[A-Za-z]/g, (c) => (c === c.toLowerCase() ? c.toUpperCase() : c.toLowerCase()));
  const variants = process.platform === "win32" ? [flip(root), root] : [root];
  for (const base of variants) {
    const dest = join(base, "export-inside");
    const before = listFiles(root).sort();
    const r = spawnSync(process.execPath, [join(root, "tools", "export-source.mjs"), dest], { encoding: "utf8" });
    assert.equal(r.status, 2, `${base}: ${r.stdout}${r.stderr}`);
    assert.match(r.stderr, /Назначение внутри исходников/);
    assert.equal(existsSync(join(root, "export-inside")), false, "каталог назначения создан");
    assert.deepEqual(listFiles(root).sort(), before, "в копии что-то записано");
  }
});

// Другая форма того же пути: короткое имя 8.3 (os.tmpdir на Windows часто
// отдаёт C:\Users\ABCDEF~1\...) против длинного, которое возвращает
// realpathSync.native. Текстовое сравнение их не связывает — инструменты
// обязаны сравнивать канонические пути. Если формы на машине совпадают
// (8.3 отключены, TEMP задан длинным), проверять нечего — случай пропускается.
function pathForms(root) {
  const long = realpathSync.native(root);
  const same = process.platform === "win32" ? long.toLowerCase() === root.toLowerCase() : long === root;
  return same ? null : { short: root, long };
}
const skipNoShortForm = (() => {
  const probe = scratch();
  return pathForms(probe) === null
    ? "короткая (8.3) и длинная формы временного каталога совпадают — обходить нечем"
    : false;
})();

// Корень — полный срез (в нём есть все файлы списков), чтобы без проверки
// инструмент действительно начал писать, а не упал на первом отсутствующем.
test("export-source: назначение внутри копии в другой форме пути (8.3 ↔ длинная) — код 2, ничего не записано", { skip: skipNoShortForm }, () => {
  const root = exportSource();
  const forms = pathForms(root);
  assert.ok(forms, "у копии нет второй формы пути");
  for (const [tool, base] of [[forms.short, forms.long], [forms.long, forms.short]]) {
    const dest = join(base, "export-inside");
    const before = listFiles(root).sort();
    const r = spawnSync(process.execPath, [join(tool, "tools", "export-source.mjs"), dest], { encoding: "utf8" });
    assert.equal(r.status, 2, `инструмент ${tool}, назначение ${dest}: ${r.stdout}${r.stderr}`);
    assert.match(r.stderr, /Назначение внутри исходников/);
    assert.equal(existsSync(join(root, "export-inside")), false, "каталог назначения создан");
    assert.deepEqual(listFiles(root).sort(), before, "в копии что-то записано");
  }
});

// Документы среза публичны (и SHIPPED_DOCS ещё едут в ZIP): абсолютный путь
// чьей-то машины — это не инструкция для читателя. Ловим букву диска с любым
// слэшем, UNC, file:/// и домашние каталоги macOS/Linux.
const LOCAL_PATH = [
  /(?<![A-Za-z])[A-Za-z]:\\[^\s`]*/,
  /(?<![A-Za-z])[A-Za-z]:\/[^\s`]*/,
  /\\\\[A-Za-z0-9._$-]{2,}[^\s`]*/,
  /file:\/\/\/[^\s`]*/i,
  /\/Users\/[^\s`]*/,
  /\/home\/[^\s`]*/,
];

test("документы среза не содержат локальных путей", () => {
  for (const rel of new Set([...DOCS, ...SHIPPED_DOCS, ...META])) {
    const text = readFileSync(join(SRC, rel), "utf8");
    for (const re of LOCAL_PATH) {
      const hit = text.match(re);
      assert.ok(hit === null, `${rel}: локальный путь ${hit?.[0]}`);
    }
  }
});

// Сквозной сценарий из DEVELOPMENT.md: срез исходников → упаковщик из этого
// среза. Ни одного файла в экспорт не дописывается и не подменяется.
test("export-source → package-release из экспорта: 27 записей, байты из экспорта", () => {
  const dest = exportSource();
  const r = build(dest);
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /Файлов в ZIP: 27/);
  assert.match(r.out, /ПРЕДУПРЕЖДЕНИЕ: (каталог не в git-репозитории|git недоступен)/);

  const entries = readZip(readFileSync(r.zipPath));
  const expected = [...RUNTIME, ...SHIPPED_DOCS, "config.js"].sort((a, b) => (a < b ? -1 : 1));
  assert.deepEqual(entries.map((e) => e.name), expected);
  for (const e of entries) {
    const source = e.name === "config.js"
      ? Buffer.from(expectedConfig(), "utf8")
      : readFileSync(join(dest, ...e.name.split("/")));
    assert.ok(e.data.equals(source), `байты ${e.name} не совпали с экспортом`);
  }
  const prov = JSON.parse(readFileSync(`${r.zipPath}.provenance.json`, "utf8"));
  assert.equal(prov.sourceCommit, null);

  // Упаковка ничего не пишет в сам срез: его хеши по-прежнему сходятся.
  const ver = spawnSync(process.execPath, [join(dest, "tools", "verify-sums.mjs"), dest], { encoding: "utf8" });
  assert.equal(ver.status, 0, `${ver.stdout}${ver.stderr}`);
});

// ------------------------------------------------------------- сборка

const COPY = makeCopy();

test("сборка: 27 записей, байты сверены с исходниками, sidecar и unpacked согласованы", () => {
  const r = build(COPY);
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /Файлов в ZIP: 27/);

  const zip = readFileSync(r.zipPath);
  const entries = readZip(zip);
  const names = entries.map((e) => e.name);
  const expected = [...RUNTIME, ...SHIPPED_DOCS, "config.js"].sort((a, b) => (a < b ? -1 : 1));
  assert.equal(entries.length, 27);
  assert.deepEqual(names, expected, "состав или порядок записей");

  for (const e of entries) {
    assert.ok(!e.name.endsWith("/"), `каталоговая запись ${e.name}`);
    assert.ok(!e.name.includes("\\"), `обратный слэш в ${e.name}`);
    assert.ok(!e.name.startsWith("./") && !e.name.startsWith("/"), `ведущий ./ или / в ${e.name}`);
    assert.equal(e.localName, e.name);
    assert.equal(e.method, 8);
    assert.equal(e.flags, 0, "data descriptor или иные флаги");
    assert.equal(e.extraLen, 0);
    assert.equal(e.local.extraLen, 0);
    assert.equal(e.date, DOS_DATE);
    assert.equal(e.time, 0);
    assert.equal(e.local.crc, e.crc);
    assert.equal(e.local.csize, e.csize);
    assert.equal(e.usize, e.data.length);
    assert.equal(zlibCrc32(e.data), e.crc, `CRC32 ${e.name}`);
    const source = e.name === "config.js"
      ? Buffer.from(expectedConfig(), "utf8")
      : readFileSync(join(COPY, ...e.name.split("/")));
    assert.ok(e.data.equals(source), `байты ${e.name} не совпали с исходником`);
  }

  // .sha256
  assert.equal(readFileSync(`${r.zipPath}.sha256`, "utf8"), `${sha(zip)}  ${ZIP_NAME}\n`);

  // provenance
  const provText = readFileSync(`${r.zipPath}.provenance.json`, "utf8");
  assert.ok(!provText.includes("\r") && provText.endsWith("}\n"));
  const prov = JSON.parse(provText);
  assert.deepEqual(Object.keys(prov), [
    "sourceCommit", "sourceDirty", "worktreeFiles", "version", "versionName", "date",
    "publicOnly", "publicConfigValidated", "zipSha256", "zipBytes", "files",
  ]);
  assert.equal(prov.version, MANIFEST.version);
  assert.equal(prov.versionName, MANIFEST.version_name);
  assert.equal(prov.date, DATE);
  assert.equal(prov.publicOnly, true);
  assert.equal(prov.publicConfigValidated, true);
  assert.equal(prov.zipSha256, sha(zip));
  assert.equal(prov.zipBytes, zip.length);
  assert.deepEqual(
    prov.files,
    entries.map((e) => ({ path: e.name, sha256: sha(e.data), bytes: e.data.length })),
  );

  // unpacked/
  const unpacked = join(r.dir, "unpacked");
  assert.deepEqual(listFiles(unpacked).sort(), [...expected].sort());
  // mtime — локальная полночь даты сборки, как DOS-время записей ZIP.
  const midnight = new Date(Y, M - 1, D).getTime();
  for (const e of entries) {
    const file = join(unpacked, ...e.name.split("/"));
    assert.ok(readFileSync(file).equals(e.data), `unpacked/${e.name}`);
    assert.equal(statSync(file).mtimeMs, midnight, `mtime unpacked/${e.name}`);
  }

  // Каталог релиза: ровно ZIP, два sidecar и unpacked/.
  assert.deepEqual(readdirSync(r.dir).sort(), [
    ZIP_NAME, `${ZIP_NAME}.provenance.json`, `${ZIP_NAME}.sha256`, "unpacked",
  ].sort());
  for (const f of [`${ZIP_NAME}.provenance.json`, `${ZIP_NAME}.sha256`]) {
    assert.equal(readFileSync(join(r.dir, f), "utf8").includes(KEY_PAYLOAD), false, `${f} содержит ключ`);
  }
});

test("config без AUTH_SITE_URL принимается, строка в сериализации опускается", () => {
  const r = build(COPY, { config: configText({ auth: null }) });
  assert.equal(r.status, 0, r.out);
  const cfg = readZip(readFileSync(r.zipPath)).find((e) => e.name === "config.js");
  assert.equal(cfg.data.toString("utf8"), expectedConfig(null));
});

test("config в форме window.THUMBVAULT_CONFIG и globalThis.THUMBVAULT_CONFIG принимается", () => {
  for (const target of ["window", "globalThis"]) {
    const text = configText().replace("(globalThis.window || globalThis)", target);
    const r = build(COPY, { config: text });
    assert.equal(r.status, 0, `${target}: ${r.out}`);
  }
});

test("детерминизм: одна дата — одинаковые байты ZIP, другая дата — другие", () => {
  const a = build(COPY);
  const b = build(COPY);
  assert.equal(a.status, 0, a.out);
  assert.equal(b.status, 0, b.out);
  assert.ok(readFileSync(a.zipPath).equals(readFileSync(b.zipPath)), "две сборки с одной датой разошлись");
  const c = build(COPY, { date: "2026-10-11" });
  assert.equal(c.status, 0, c.out);
  assert.ok(!readFileSync(a.zipPath).equals(readFileSync(c.zipPath)), "дата не влияет на байты");
});

// ------------------------------------------------------------- отказы валидатора

const BS = "\\";
const TICK = "`";

const pairsWith = (...extra) => [
  `  SUPABASE_URL: "${ORIGIN}",`,
  `  SUPABASE_ANON_KEY: "${KEY}",`,
  ...extra,
];

const REJECT = [
  ["role service_role", { key: makeKey({ payload: { role: "service_role" } }) }, "key.role"],
  ["чужой ref", { key: makeKey({ payload: { ref: "aaaaaaaaaaaaaaaaaaaa" } }) }, "key.ref"],
  ["чужой origin SUPABASE_URL", { url: "https://aaaaaaaaaaaaaaaaaaaa.supabase.co" }, "config.supabase-url"],
  ["лишний ключ", { lines: pairsWith('  EXTRA_FIELD: "x",') }, "config.unknown-key"],
  ["повтор ключа", { lines: pairsWith(`  SUPABASE_URL: "${ORIGIN}",`) }, "config.duplicate-key"],
  ["вызов функции", { lines: [`  SUPABASE_URL: "${ORIGIN}",`, '  SUPABASE_ANON_KEY: atob("eHg"),'] }, "config.call"],
  ["spread", { lines: pairsWith("  ...globalThis.OTHER,") }, "config.spread"],
  ["getter", { lines: pairsWith('  get AUTH_SITE_URL() { return "https://thumbsight.com"; },') }, "config.getter"],
  ["обратный слэш в строке", { auth: `https:${BS}/${BS}/thumbsight.com` }, "config.string-escape"],
  ["шаблонная строка", { lines: pairsWith(`  AUTH_SITE_URL: ${TICK}https://thumbsight.com${TICK},`) }, "config.template-string"],
  ["не-строковое значение", { lines: pairsWith("  AUTH_SITE_URL: 42,") }, "config.non-string-value"],
  ["просроченный exp", { key: makeKey({ payload: { exp: 1000000000 } }) }, "key.exp"],
  ["exp не число", { key: makeKey({ payload: { exp: "4102444800" } }) }, "key.exp"],
  ["есть sub", { key: makeKey({ payload: { sub: "00000000-0000-0000-0000-000000000000" } }) }, "key.sub"],
  ["префикс sb_secret_", { key: "sb_secret_synthetic0000000000" }, "key.secret-prefix"],
  ["service_role в тексте ключа", { key: "anon.service_role.x" }, "key.service-role"],
  ["AUTH_SITE_URL вне allowlist", { auth: "https://thumbsight.example" }, "config.auth-site-url"],
  ["нет обязательного поля", { lines: [`  SUPABASE_URL: "${ORIGIN}",`] }, "config.missing-key"],
  ["не-JWT ключ", { key: "not-a-jwt" }, "key.not-jwt"],
  ["заголовок JWT не HS256", { key: makeKey({ header: { alg: "none" } }) }, "key.header"],
  ["iss не supabase", { key: makeKey({ payload: { iss: "other" } }) }, "key.iss"],
];

for (const [name, opts, rule] of REJECT) {
  test(`config отклоняется: ${name} → ${rule}`, () => {
    // Ключ этого случая тоже не должен утечь, даже если он «плохой».
    const key = opts.key ?? KEY;
    const parts = key.split(".");
    const secrets = [KEY, KEY_PAYLOAD, SIGNATURE, key, ...(parts.length === 3 ? [parts[1]] : [])];
    const out = join(scratch(), "release");
    const r = pack(COPY, ["--config", writeConfig(configText(opts)), "--out", out, "--date", DATE], { secrets });
    assert.equal(r.status, 1, r.out);
    assert.ok(r.out.includes(`[${rule}]`), `ожидалось правило ${rule}: ${r.out}`);
    assert.equal(existsSync(out), false, "при отказе каталог релиза не создаётся");
  });
}

test("config отклоняется: вторая инструкция", () => {
  const out = join(scratch(), "release");
  const text = `${configText()}globalThis.OTHER = "x";\n`;
  const r = pack(COPY, ["--config", writeConfig(text), "--out", out, "--date", DATE]);
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /\[config\.second-statement\]/);
  assert.equal(existsSync(out), false);
});

test("config отклоняется: чужая цель присваивания", () => {
  const out = join(scratch(), "release");
  const text = configText().replace(".THUMBVAULT_CONFIG", ".OTHER_CONFIG");
  const r = pack(COPY, ["--config", writeConfig(text), "--out", out, "--date", DATE]);
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /\[config\.target\]/);
});

// ------------------------------------------------------------- вызов и каталог

test("неверный вызов — код 2: нет --config, нет --out, кривая дата", () => {
  const out = join(scratch(), "release");
  const cfg = writeConfig(configText());
  for (const args of [
    ["--out", out],
    ["--config", cfg],
    ["--config", cfg, "--out", out, "--date", "2026-02-30"],
    ["--config", cfg, "--out", out, "--unknown"],
  ]) {
    const r = pack(COPY, args);
    assert.equal(r.status, 2, `${args.join(" ")}: ${r.out}`);
  }
  assert.equal(existsSync(out), false);
});

test("отказ при непустом --out, чужой файл не тронут", () => {
  const out = join(scratch(), "release");
  mkdirSync(out);
  writeFileSync(join(out, "keep.txt"), "чужое\n");
  const r = pack(COPY, ["--config", writeConfig(configText()), "--out", out, "--date", DATE]);
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /\[out\.not-empty\]/);
  assert.deepEqual(readdirSync(out), ["keep.txt"]);
  assert.equal(readFileSync(join(out, "keep.txt"), "utf8"), "чужое\n");
});

test("отказ при --out внутри корня расширения", () => {
  const out = join(COPY, "release");
  const r = pack(COPY, ["--config", writeConfig(configText()), "--out", out, "--date", DATE]);
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /\[out\.inside-root\]/);
  assert.equal(existsSync(out), false);
});

test("отказ при --out внутри корня в другой форме пути (8.3 ↔ длинная)", { skip: skipNoShortForm }, () => {
  const root = makeCopy();
  const forms = pathForms(root);
  assert.ok(forms, "у копии нет второй формы пути");
  for (const [tool, base] of [[forms.short, forms.long], [forms.long, forms.short]]) {
    const before = listFiles(root).sort();
    const out = join(base, "release");
    const r = pack(tool, ["--config", writeConfig(configText()), "--out", out, "--date", DATE]);
    assert.equal(r.status, 1, `инструмент ${tool}, --out ${out}: ${r.out}`);
    assert.match(r.out, /\[out\.inside-root\]/);
    assert.equal(existsSync(join(root, "release")), false, "каталог релиза создан внутри корня");
    assert.deepEqual(listFiles(root).sort(), before, "в копии что-то записано");
  }
});

test("отказ при --index внутри корня в другой форме пути (8.3 ↔ длинная)", { skip: skipNoShortForm }, () => {
  const root = makeCopy();
  const forms = pathForms(root);
  assert.ok(forms, "у копии нет второй формы пути");
  const original = JSON.stringify({ schemaVersion: 1, generatedAt: "x", releases: [] }, null, 2);
  writeFileSync(join(root, "release-index.json"), original);
  for (const [tool, base] of [[forms.short, forms.long], [forms.long, forms.short]]) {
    const before = listFiles(root).sort();
    const out = join(scratch(), "release");
    const indexPath = join(base, "release-index.json");
    const r = pack(tool, ["--config", writeConfig(configText()), "--out", out, "--date", DATE, "--index", indexPath]);
    assert.equal(r.status, 1, `инструмент ${tool}, --index ${indexPath}: ${r.out}`);
    assert.match(r.out, /\[index\.inside-root\]/);
    assert.equal(existsSync(out), false, "каталог релиза создан");
    assert.equal(readFileSync(join(root, "release-index.json"), "utf8"), original, "индекс изменён");
    assert.deepEqual(listFiles(root).sort(), before, "в копии что-то записано");
  }
});

test("--index и --out в разных формах одного пути: запись public с верным относительным package", { skip: skipNoShortForm }, () => {
  const base = scratch();
  const forms = pathForms(base);
  assert.ok(forms, "у каталога нет второй формы пути");
  const indexPath = join(forms.short, "release-index.json");
  writeFileSync(indexPath, JSON.stringify({ schemaVersion: 1, generatedAt: "x", releases: [] }, null, 2));
  const out = join(forms.long, "releases", "public", MANIFEST.version_name);
  const r = pack(COPY, ["--config", writeConfig(configText()), "--out", out, "--date", DATE, "--index", indexPath]);
  assert.equal(r.status, 0, r.out);
  const idx = JSON.parse(readFileSync(indexPath, "utf8"));
  assert.equal(idx.releases.length, 1);
  assert.equal(idx.releases[0].package, `releases/public/${MANIFEST.version_name}/${ZIP_NAME}`);
});

// Отказ чтения config называет только правило и код ошибки ФС: путь к файлу
// тоже пришёл от вызывающего и в вывод не идёт.
test("--config по несуществующему пути — [config.unreadable], путь и маркер не напечатаны", () => {
  const marker = `tv-marker-${randomBytes(8).toString("hex")}`;
  const configPath = join(scratch(), marker, "config.js");
  const out = join(scratch(), "release");
  const r = pack(COPY, ["--config", configPath, "--out", out, "--date", DATE]);
  assert.equal(r.status, 1, r.out);
  assert.ok(r.out.includes("[config.unreadable]"), r.out);
  assert.equal(r.out.includes(marker), false, "вывод содержит маркер из пути config");
  assert.equal(r.out.includes(configPath), false, "вывод содержит путь config");
  assert.equal(existsSync(out), false);
});

// ------------------------------------------------------------- git

test("копия вне репозитория: sourceCommit null, предупреждение, успех", { skip: skipNoGit }, (t) => {
  const probe = spawnSync("git", ["-C", COPY, "rev-parse", "--is-inside-work-tree"], {
    encoding: "utf8", windowsHide: true, env: { ...process.env, GIT_CEILING_DIRECTORIES: CEILING },
  });
  if (probe.status === 0) {
    t.skip("временный каталог оказался внутри git-репозитория");
    return;
  }
  const r = build(COPY);
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /ПРЕДУПРЕЖДЕНИЕ: каталог не в git-репозитории/);
  const prov = JSON.parse(readFileSync(`${r.zipPath}.provenance.json`, "utf8"));
  assert.equal(prov.sourceCommit, null);
  assert.equal(prov.sourceDirty, null);
  assert.equal(prov.worktreeFiles, null);
});

test("временный git-репозиторий: чистый — commit; правка — отказ без --allow-dirty, успех с ним", { skip: skipNoGit }, () => {
  const root = makeCopy();
  git(root, ["init", "-q"]);
  git(root, ["add", "-A"]);
  git(root, ["commit", "-q", "-m", "fixture"]);
  const head = git(root, ["rev-parse", "HEAD"]);

  const clean = build(root);
  assert.equal(clean.status, 0, clean.out);
  const cleanProv = JSON.parse(readFileSync(`${clean.zipPath}.provenance.json`, "utf8"));
  assert.equal(cleanProv.sourceCommit, head);
  assert.equal(cleanProv.sourceDirty, false);
  assert.deepEqual(cleanProv.worktreeFiles, []);

  const edited = Buffer.concat([readFileSync(join(root, "popup.js")), Buffer.from("\n// local edit\n")]);
  writeFileSync(join(root, "popup.js"), edited);

  const refused = build(root);
  assert.equal(refused.status, 1, refused.out);
  assert.match(refused.out, /\[git\.dirty\]/);
  assert.equal(existsSync(refused.dir), false);

  const allowed = build(root, { extra: ["--allow-dirty"] });
  assert.equal(allowed.status, 0, allowed.out);
  const prov = JSON.parse(readFileSync(`${allowed.zipPath}.provenance.json`, "utf8"));
  assert.equal(prov.sourceCommit, head);
  assert.equal(prov.sourceDirty, true);
  assert.deepEqual(prov.worktreeFiles.map((f) => f.path), ["popup.js"]);
  const popup = readZip(readFileSync(allowed.zipPath)).find((e) => e.name === "popup.js");
  assert.ok(popup.data.equals(edited), "в ZIP не та версия popup.js");
});

// Исходники пакета = блобы sourceCommit, а не байты конкретной рабочей копии.
// Один коммит в двух копиях — CRLF (core.autocrlf=true) и LF — даёт один ZIP.
test("autocrlf: CRLF-копия и LF-копия одного коммита дают одинаковый ZIP из блобов HEAD", { skip: skipNoGit }, () => {
  const crlf = makeCopy();
  git(crlf, ["init", "-q"]);
  git(crlf, ["config", "core.autocrlf", "true"]);
  git(crlf, ["add", "-A"], { autocrlf: "true" });
  git(crlf, ["commit", "-q", "-m", "fixture"], { autocrlf: "true" });
  // Перевыкладка из коммита: под autocrlf=true текстовые файлы получают CRLF.
  for (const rel of [...RUNTIME, ...SHIPPED_DOCS]) rmSync(join(crlf, ...rel.split("/")));
  git(crlf, ["checkout", "--", "."], { autocrlf: "true" });
  assert.equal(git(crlf, ["status", "--porcelain"], { autocrlf: "true" }), "", "CRLF-копия не чистая");
  const head = git(crlf, ["rev-parse", "HEAD"]);

  const blobs = new Map();
  const crlfFiles = [];
  for (const rel of [...RUNTIME, ...SHIPPED_DOCS]) {
    const blob = git(crlf, ["cat-file", "blob", `HEAD:${rel}`], { encoding: "buffer" });
    blobs.set(rel, blob);
    if (!readFileSync(join(crlf, ...rel.split("/"))).equals(blob)) crlfFiles.push(rel);
  }
  assert.ok(crlfFiles.includes("background.js"), `рабочая копия не разошлась с блобами: ${crlfFiles.join(", ")}`);

  const lfParent = scratch();
  const lf = join(lfParent, "lf");
  git(lfParent, ["clone", "-q", "--config", "core.autocrlf=false", crlf, lf]);
  for (const rel of crlfFiles) {
    assert.ok(readFileSync(join(lf, ...rel.split("/"))).equals(blobs.get(rel)), `LF-копия: ${rel}`);
  }

  const a = build(crlf);
  const b = build(lf);
  assert.equal(a.status, 0, a.out);
  assert.equal(b.status, 0, b.out);
  assert.match(a.out, /Из блобов HEAD/);
  assert.ok(readFileSync(a.zipPath).equals(readFileSync(b.zipPath)), "ZIP одного коммита зависит от копии");

  for (const r of [a, b]) {
    const prov = JSON.parse(readFileSync(`${r.zipPath}.provenance.json`, "utf8"));
    assert.equal(prov.sourceCommit, head);
    assert.equal(prov.sourceDirty, false);
    assert.deepEqual(prov.worktreeFiles, []);
  }
  for (const e of readZip(readFileSync(a.zipPath))) {
    if (e.name === "config.js") continue;
    assert.ok(e.data.equals(blobs.get(e.name)), `${e.name} не равен блобу HEAD`);
  }
});

test("скрытая от git status правка (assume-unchanged) — отказ без --allow-dirty", { skip: skipNoGit }, () => {
  const root = makeCopy();
  git(root, ["init", "-q"]);
  git(root, ["add", "-A"]);
  git(root, ["commit", "-q", "-m", "fixture"]);
  git(root, ["update-index", "--assume-unchanged", "popup.js"]);
  const edited = Buffer.concat([readFileSync(join(root, "popup.js")), Buffer.from("\n// hidden edit\n")]);
  writeFileSync(join(root, "popup.js"), edited);
  assert.equal(git(root, ["status", "--porcelain"]), "", "правка видна git status");

  const refused = build(root);
  assert.equal(refused.status, 1, refused.out);
  assert.match(refused.out, /\[git\.worktree-mismatch\]/);
  assert.equal(existsSync(refused.dir), false);

  const allowed = build(root, { extra: ["--allow-dirty"] });
  assert.equal(allowed.status, 0, allowed.out);
  const prov = JSON.parse(readFileSync(`${allowed.zipPath}.provenance.json`, "utf8"));
  assert.equal(prov.sourceDirty, true);
  assert.deepEqual(prov.worktreeFiles.map((f) => f.path), ["popup.js"]);
});

test("git недоступен (пустой PATH): sourceCommit null и успех", { skip: skipNoGit }, () => {
  const root = makeCopy();
  git(root, ["init", "-q"]);
  git(root, ["add", "-A"]);
  git(root, ["commit", "-q", "-m", "fixture"]);
  const env = {};
  for (const [k, v] of Object.entries(process.env)) if (k.toLowerCase() !== "path") env[k] = v;
  env.PATH = scratch();
  const r = build(root, { env });
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /ПРЕДУПРЕЖДЕНИЕ: git недоступен/);
  const prov = JSON.parse(readFileSync(`${r.zipPath}.provenance.json`, "utf8"));
  assert.equal(prov.sourceCommit, null);
});

// ------------------------------------------------------------- индекс

test("--index: public заменена, admin нетронута, generatedAt обновлён", () => {
  const base = scratch();
  const indexPath = join(base, "release-index.json");
  const admin = {
    variant: "admin",
    version: "1.1.0-private",
    visibility: "owner-only",
    package: "releases/admin/1.1.0-private/ThumbSight-Admin-1.1.0-PRIVATE-2026-08-13.zip",
    bytes: 20330,
    sha256: "e".repeat(64),
  };
  const oldPublic = {
    variant: "public",
    version: "2.8.2-beta",
    visibility: "public-beta",
    browser: "chromium",
    package: "releases/public/2.8.2-beta/ThumbSight-Public-Beta-2.8.2-2026-08-31.zip",
    bytes: 73070,
    sha256: "3".repeat(64),
    sourceCommit: "e".repeat(40),
  };
  const OLD_STAMP = "2026-08-31T08:49:50.4044187Z";
  writeFileSync(indexPath, JSON.stringify({ schemaVersion: 1, generatedAt: OLD_STAMP, releases: [oldPublic, admin] }, null, 2).replace(/\n/g, "\r\n"));

  const out = join(base, "releases", "public", MANIFEST.version_name);
  const before = Date.now();
  const r = pack(COPY, ["--config", writeConfig(configText()), "--out", out, "--date", DATE, "--index", indexPath]);
  assert.equal(r.status, 0, r.out);

  const text = readFileSync(indexPath, "utf8");
  assert.ok(!text.includes("\r") && text.endsWith("}\n"), "индекс: отступ 2 и LF");
  assert.equal(text.includes(KEY_PAYLOAD), false);
  const idx = JSON.parse(text);
  assert.equal(idx.schemaVersion, 1);
  assert.notEqual(idx.generatedAt, OLD_STAMP);
  assert.ok(Date.parse(idx.generatedAt) >= before - 1000, "generatedAt не обновлён");
  assert.equal(idx.releases.length, 2);
  assert.deepEqual(idx.releases[1], admin);

  const zip = readFileSync(join(out, ZIP_NAME));
  const expected = {
    variant: "public",
    version: MANIFEST.version_name,
    visibility: "public-beta",
    browser: "chromium",
    package: `releases/public/${MANIFEST.version_name}/${ZIP_NAME}`,
    bytes: zip.length,
    sha256: sha(zip),
    sourceCommit: null,
  };
  assert.deepEqual(idx.releases[0], expected);
  assert.deepEqual(Object.keys(idx.releases[0]), Object.keys(expected));
  assert.equal(relative(base, join(out, ZIP_NAME)).split(sep).join("/"), expected.package);
});

test("--index: ZIP вне каталога индекса — отказ, ничего не записано", () => {
  const indexDir = scratch();
  const indexPath = join(indexDir, "release-index.json");
  const original = JSON.stringify({ schemaVersion: 1, generatedAt: "x", releases: [] }, null, 2);
  writeFileSync(indexPath, original);
  const out = join(scratch(), "release");
  const r = pack(COPY, ["--config", writeConfig(configText()), "--out", out, "--date", DATE, "--index", indexPath]);
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /\[index\.package-outside\]/);
  assert.equal(existsSync(out), false);
  assert.equal(readFileSync(indexPath, "utf8"), original);
});

// ------------------------------------------------------------- утечки

test("ни один запуск не напечатал ключ, его payload или подпись", () => {
  assert.ok(transcripts.length >= 30, `запусков подозрительно мало: ${transcripts.length}`);
  for (const out of transcripts) assertNoLeak(out);
});

// Штамп версии в popup статичен и не читает манифест: при подъёме версии его
// забывали (2.9.3 — ревью EXT-OPT-01). «beta 2.9.3» ⇐ version_name «2.9.3-beta».
test("штамп версии в popup совпадает с manifest.version_name", () => {
  const html = readFileSync(join(SRC, "popup.html"), "utf8");
  const m = html.match(/<span class="stamp">([^<]+)<\/span>/);
  assert.ok(m, "в popup.html нет <span class=\"stamp\">");
  const [base, suffix] = String(MANIFEST.version_name).split("-");
  assert.equal(m[1], `${suffix} ${base}`);
});

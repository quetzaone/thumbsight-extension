// Упаковщик установочного ZIP публичного Chromium-расширения (PUB-04).
//
//   node tools/package-release.mjs --config <путь к config.js> --out <каталог-релиза>
//        [--date YYYY-MM-DD] [--index <release-index.json>] [--allow-dirty]
//
//   npm run package -- --config <...> --out <...>
//
// Шага сборки у расширения нет: ZIP — это пофайловая выкладка исходников из
// tools/runtime-files.mjs (RUNTIME + SHIPPED_DOCS) плюс СГЕНЕРИРОВАННЫЙ
// config.js. В <каталог-релиза> появляются:
//   ThumbSight-Public-Beta-<version>-<date>.zip
//   <zip>.sha256              «<hex>  <имя zip>» + LF
//   <zip>.provenance.json     источник, версия, хеши каждого файла
//   unpacked/                 те же файлы, что в ZIP, байт в байт; mtime —
//                             локальная полночь --date, как у записей ZIP
//
// Коды выхода: 0 — успех; 1 — отказ проверки или состояния (config, git,
// каталог, исходники, индекс); 2 — неверный вызов.
//
// ------------------------------------------------------------- config
//
// Файл из --config ЧИТАЕТСЯ, но НЕ ИСПОЛНЯЕТСЯ: ни eval, ни new Function,
// ни vm, ни import. Он разбирается собственным токенизатором по узкой
// грамматике — одно присваивание объекта из строковых литералов — и в ZIP
// уходит НОВЫЙ текст, собранный только из проверенных полей. Комментарии и
// всё прочее из исходного файла в пакет не попадает.
//
// Ключ проверяется по ФОРМЕ, а не криптографически: подпись JWT не
// сверяется (секрета подписи у упаковщика нет и быть не должно), живого
// подключения к Supabase нет. Проверяется, что это legacy anon JWT нужного
// проекта, неистёкший и без пользователя, и что он не похож на секретный ключ.
//
// Значение SUPABASE_ANON_KEY не печатается НИКОГДА — ни целиком, ни частями,
// ни в сообщениях об ошибках, ни в provenance и индексе. Отказ называет
// только правило и позицию в файле (строка:столбец).
//
// ------------------------------------------------------------- ZIP
//
// Детерминированный: записи отсортированы по имени, у всех одна отметка
// времени (--date, 00:00), deflate уровня 9, без каталоговых записей, без
// extra-полей, без data descriptor и без zip64. Одни исходники + одна дата
// на одной версии Node (zlib) = одни и те же байты.
//
// ------------------------------------------------------------- байты из git
//
// В git-репозитории «одни исходники» — это блобы коммита, а не байты рабочей
// копии: под core.autocrlf=true (или eol/clean-фильтрами из .gitattributes)
// рабочая копия держит CRLF, а git status при этом чистый. Поэтому для
// каждого файла из списка:
//   * рабочие байты == блоб HEAD          — берутся они (это одно и то же);
//   * отличаются только фильтрами git      — берётся блоб HEAD (git cat-file);
//   * отличаются по содержимому / нет в HEAD — файл «грязный»: без
//     --allow-dirty отказ, с ним — рабочие байты и запись в worktreeFiles
//     provenance (eolFiltered: true, если git при коммите изменил бы байты).
// Итог: чистая сборка воспроизводима из sourceCommit на любой копии и ОС.
// Вне git (публичный экспорт) берутся байты файлов как есть.
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, utimesSync, writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { deflateRawSync } from "node:zlib";
import { NEVER, RUNTIME, SHIPPED_DOCS } from "./runtime-files.mjs";

const ROOT = resolve(import.meta.dirname, "..");

const USAGE = [
  "node tools/package-release.mjs --config <путь к config.js> --out <каталог-релиза>",
  "     [--date YYYY-MM-DD] [--index <release-index.json>] [--allow-dirty]",
].join("\n");

const AUTH_SITES = new Set(["https://thumbsight.com", "https://www.thumbsight.com"]);
const CONFIG_KEYS = new Set(["SUPABASE_URL", "SUPABASE_ANON_KEY", "AUTH_SITE_URL"]);
const REQUIRED_KEYS = ["SUPABASE_URL", "SUPABASE_ANON_KEY"];

// --------------------------------------------------------------- ошибки

class UsageError extends Error {}

// Отказ по правилу. В тексте — только имя правила и безопасная подробность
// (позиция, имя файла), но никогда не значение из config.
class Refusal extends Error {
  constructor(rule, detail = "") {
    super(rule);
    this.rule = rule;
    this.detail = detail;
  }
}

// --------------------------------------------------------------- аргументы

function today() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function parseDate(value) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!m) throw new UsageError("--date: нужен формат YYYY-MM-DD");
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const probe = new Date(Date.UTC(y, mo - 1, d));
  if (probe.getUTCFullYear() !== y || probe.getUTCMonth() !== mo - 1 || probe.getUTCDate() !== d) {
    throw new UsageError("--date: такой даты нет в календаре");
  }
  // Поле даты ZIP (MS-DOS) умеет только 1980..2107.
  if (y < 1980 || y > 2107) throw new UsageError("--date: год вне 1980..2107");
  return { text: value, y, mo, d, utcMs: probe.getTime() };
}

function parseArgs(argv) {
  const opts = { allowDirty: false };
  const valued = new Map([
    ["--config", "config"], ["--out", "out"], ["--date", "date"], ["--index", "index"],
  ]);
  for (let i = 0; i < argv.length; i += 1) {
    let flag = argv[i];
    let value;
    const eq = flag.startsWith("--") ? flag.indexOf("=") : -1;
    if (eq > 0) {
      value = flag.slice(eq + 1);
      flag = flag.slice(0, eq);
    }
    if (flag === "--allow-dirty") {
      if (value !== undefined) throw new UsageError("--allow-dirty не принимает значения");
      opts.allowDirty = true;
      continue;
    }
    const name = valued.get(flag);
    // Значение неизвестного аргумента не печатаем: по ошибке туда может
    // попасть что угодно, вплоть до ключа.
    if (!name) throw new UsageError(`неизвестный аргумент №${i + 1}`);
    if (value === undefined) {
      i += 1;
      value = argv[i];
      if (value === undefined) throw new UsageError(`${flag} без значения`);
    }
    if (value === "") throw new UsageError(`${flag} с пустым значением`);
    if (opts[name] !== undefined) throw new UsageError(`${flag} указан дважды`);
    opts[name] = value;
  }
  if (opts.config === undefined) throw new UsageError("нет --config");
  if (opts.out === undefined) throw new UsageError("нет --out");
  opts.date = parseDate(opts.date ?? today());
  return opts;
}

// --------------------------------------------------------------- манифест

function readManifest() {
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(join(ROOT, "manifest.json"), "utf8"));
  } catch {
    throw new Refusal("manifest.unreadable", "manifest.json не читается как JSON");
  }
  const { version, version_name: versionName } = manifest;
  if (typeof version !== "string" || !/^\d+(\.\d+){0,3}$/.test(version)) {
    throw new Refusal("manifest.version");
  }
  if (typeof versionName !== "string" || !/^[0-9A-Za-z][0-9A-Za-z.+-]*$/.test(versionName)) {
    throw new Refusal("manifest.version-name");
  }
  // SUPABASE_URL обязан совпасть с тем единственным origin, куда расширению
  // вообще разрешено ходить. Источник истины — манифест, а не config.
  const host = Array.isArray(manifest.host_permissions) ? manifest.host_permissions[0] : undefined;
  if (typeof host !== "string" || !host.endsWith("/*")) throw new Refusal("manifest.host-permission");
  const origin = host.slice(0, -2);
  let url;
  try {
    url = new URL(origin);
  } catch {
    throw new Refusal("manifest.host-permission");
  }
  const ref = /^([a-z0-9]+)\.supabase\.co$/.exec(url.hostname)?.[1];
  if (url.protocol !== "https:" || url.origin !== origin || !ref) {
    throw new Refusal("manifest.host-permission");
  }
  return { version, versionName, supabaseOrigin: origin, ref };
}

// --------------------------------------------------------------- токенизатор

// Позиция «строка:столбец» по смещению. Печатается вместо содержимого.
function where(text, index) {
  let line = 1;
  let lineStart = 0;
  for (let i = 0; i < index && i < text.length; i += 1) {
    if (text[i] === "\n") {
      line += 1;
      lineStart = i + 1;
    }
  }
  return `строка ${line}:${index - lineStart + 1}`;
}

const PUNCT = new Set("(){}[].,:;=+-*/!?<>&|%^~@#".split(""));

function tokenize(text) {
  const tokens = [];
  const fail = (rule, index) => { throw new Refusal(rule, where(text, index)); };
  const n = text.length;
  let i = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  while (i < n) {
    const c = text[i];
    if (c === " " || c === "\t" || c === "\r" || c === "\n") {
      i += 1;
      continue;
    }
    if (c === "/" && text[i + 1] === "/") {
      const end = text.indexOf("\n", i);
      i = end < 0 ? n : end + 1;
      continue;
    }
    if (c === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      if (end < 0) fail("config.unterminated-comment", i);
      i = end + 2;
      continue;
    }
    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < n && text[j] !== c) {
        // Escape-последовательности не поддерживаются вовсе: обратный слэш
        // меняет смысл строки, а значениям config он не нужен.
        if (text[j] === "\\") fail("config.string-escape", j);
        if (text[j] === "\n" || text[j] === "\r") fail("config.unterminated-string", i);
        j += 1;
      }
      if (j >= n) fail("config.unterminated-string", i);
      tokens.push({ type: "string", value: text.slice(i + 1, j), pos: i });
      i = j + 1;
      continue;
    }
    if (c === "`") fail("config.template-string", i);
    if (/[A-Za-z_$]/.test(c)) {
      let j = i + 1;
      while (j < n && /[A-Za-z0-9_$]/.test(text[j])) j += 1;
      tokens.push({ type: "ident", value: text.slice(i, j), pos: i });
      i = j;
      continue;
    }
    if (/[0-9]/.test(c)) {
      let j = i + 1;
      while (j < n && /[A-Za-z0-9_.]/.test(text[j])) j += 1;
      tokens.push({ type: "number", pos: i });
      i = j;
      continue;
    }
    if (text.startsWith("...", i)) {
      tokens.push({ type: "punct", value: "...", pos: i });
      i += 3;
      continue;
    }
    if (text.startsWith("||", i)) {
      tokens.push({ type: "punct", value: "||", pos: i });
      i += 2;
      continue;
    }
    if (PUNCT.has(c)) {
      tokens.push({ type: "punct", value: c, pos: i });
      i += 1;
      continue;
    }
    fail("config.unexpected-character", i);
  }
  return tokens;
}

// --------------------------------------------------------------- грамматика

// Ровно одна инструкция:  <цель> = { КЛЮЧ: "строка", ... } ;
//   цель — (globalThis.window || globalThis).THUMBVAULT_CONFIG,
//          window.THUMBVAULT_CONFIG или globalThis.THUMBVAULT_CONFIG.
function parseConfig(text) {
  const tokens = tokenize(text);
  let k = 0;
  const peek = (offset = 0) => tokens[k + offset];
  const isP = (t, v) => t !== undefined && t.type === "punct" && t.value === v;
  const isId = (t, v) => t !== undefined && t.type === "ident" && (v === undefined || t.value === v);
  const fail = (rule, t) => {
    throw new Refusal(rule, t === undefined ? "конец файла" : where(text, t.pos));
  };
  // ident(.ident)*( — вызов функции, в какой бы позиции он ни стоял.
  const callAt = (at) => {
    let j = at;
    if (!isId(tokens[j])) return false;
    j += 1;
    while (isP(tokens[j], ".") && isId(tokens[j + 1])) j += 2;
    return isP(tokens[j], "(");
  };
  const take = (pred, rule) => {
    const t = peek();
    if (!pred(t)) fail(rule, t);
    k += 1;
  };

  if (tokens.length === 0) fail("config.empty", undefined);

  // --- цель присваивания
  if (callAt(k)) fail("config.call", peek());
  if (isP(peek(), "(")) {
    const target = "config.target";
    take((t) => isP(t, "("), target);
    take((t) => isId(t, "globalThis"), target);
    take((t) => isP(t, "."), target);
    take((t) => isId(t, "window"), target);
    take((t) => isP(t, "||"), target);
    take((t) => isId(t, "globalThis"), target);
    take((t) => isP(t, ")"), target);
  } else if (isId(peek(), "window") || isId(peek(), "globalThis")) {
    k += 1;
  } else {
    fail("config.target", peek());
  }
  take((t) => isP(t, "."), "config.target");
  take((t) => isId(t, "THUMBVAULT_CONFIG"), "config.target");
  take((t) => isP(t, "="), "config.target");

  // --- объект
  if (callAt(k)) fail("config.call", peek());
  take((t) => isP(t, "{"), "config.not-object-literal");

  const pairs = new Map();
  while (!isP(peek(), "}")) {
    const t = peek();
    if (t === undefined) fail("config.unterminated-object", t);
    if (isP(t, "...")) fail("config.spread", t);
    if (isP(t, "[")) fail("config.computed-key", t);
    if ((isId(t, "get") || isId(t, "set"))
      && (isId(peek(1)) || peek(1)?.type === "string" || isP(peek(1), "["))) {
      fail("config.getter", t);
    }
    if (t.type !== "ident" && t.type !== "string") fail("config.syntax", t);
    const key = t.value;
    k += 1;
    if (isP(peek(), "(")) fail("config.method", peek());
    if (isP(peek(), ",") || isP(peek(), "}")) fail("config.shorthand", peek());
    take((x) => isP(x, ":"), "config.syntax");

    const v = peek();
    if (v === undefined) fail("config.unterminated-object", v);
    if (callAt(k)) fail("config.call", v);
    if (isP(v, "...")) fail("config.spread", v);
    if (v.type !== "string") fail("config.non-string-value", v);
    k += 1;
    if (!isP(peek(), ",") && !isP(peek(), "}")) {
      fail(isP(peek(), "(") ? "config.call" : "config.value-expression", peek());
    }
    if (pairs.has(key)) fail("config.duplicate-key", t);
    pairs.set(key, { value: v.value, token: t });
    if (isP(peek(), ",")) k += 1;
  }
  k += 1; // }
  if (isP(peek(), ";")) k += 1;
  if (k < tokens.length) fail("config.second-statement", peek());

  for (const [key, { token }] of pairs) {
    // Имя лишнего ключа не печатаем: оно тоже пришло из файла.
    if (!CONFIG_KEYS.has(key)) fail("config.unknown-key", token);
  }
  for (const key of REQUIRED_KEYS) {
    if (!pairs.has(key)) throw new Refusal("config.missing-key", key);
  }
  const out = {};
  for (const [key, { value }] of pairs) out[key] = value;
  return out;
}

// --------------------------------------------------------------- значения

function decodeJwtPart(part, rule) {
  try {
    const value = JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
    if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error();
    return value;
  } catch {
    // Текст исключения JSON.parse цитирует вход — наружу он не идёт.
    throw new Refusal(rule);
  }
}

// Проверка ФОРМЫ ключа, не криптографии: подпись не сверяется.
function checkAnonKey(key, ref, nowSeconds) {
  if (key.startsWith("sb_secret_")) throw new Refusal("key.secret-prefix");
  if (key.includes("service_role")) throw new Refusal("key.service-role");
  const parts = key.split(".");
  if (parts.length !== 3 || parts.some((p) => !/^[A-Za-z0-9_-]+$/.test(p))) {
    throw new Refusal("key.not-jwt");
  }
  const header = decodeJwtPart(parts[0], "key.header");
  const payload = decodeJwtPart(parts[1], "key.payload");
  if (header.alg !== "HS256" || header.typ !== "JWT") throw new Refusal("key.header");
  if (payload.iss !== "supabase") throw new Refusal("key.iss");
  if (payload.ref !== ref) throw new Refusal("key.ref");
  if (payload.role !== "anon") throw new Refusal("key.role");
  if (typeof payload.exp !== "number" || !Number.isFinite(payload.exp) || payload.exp <= nowSeconds) {
    throw new Refusal("key.exp");
  }
  if (Object.hasOwn(payload, "sub")) throw new Refusal("key.sub");
}

function validateConfig(text, { supabaseOrigin, ref }) {
  const cfg = parseConfig(text);
  if (cfg.SUPABASE_URL !== supabaseOrigin) throw new Refusal("config.supabase-url");
  if (cfg.AUTH_SITE_URL !== undefined && !AUTH_SITES.has(cfg.AUTH_SITE_URL)) {
    throw new Refusal("config.auth-site-url");
  }
  checkAnonKey(cfg.SUPABASE_ANON_KEY, ref, Math.floor(Date.now() / 1000));
  return cfg;
}

// Новый текст только из проверенных полей. Кавычек и обратных слэшей в
// значениях быть не может: URL сверены с точными строками, ключ — base64url.
function serializeConfig(cfg) {
  const lines = [
    "(globalThis.window || globalThis).THUMBVAULT_CONFIG = {",
    `  SUPABASE_URL: "${cfg.SUPABASE_URL}",`,
    `  SUPABASE_ANON_KEY: "${cfg.SUPABASE_ANON_KEY}",`,
  ];
  if (cfg.AUTH_SITE_URL !== undefined) lines.push(`  AUTH_SITE_URL: "${cfg.AUTH_SITE_URL}",`);
  lines.push("};", "");
  return lines.join("\n");
}

function loadConfig(path, manifest) {
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    throw new Refusal("config.unreadable", err.code ?? "ошибка чтения");
  }
  try {
    return validateConfig(text, manifest);
  } catch (err) {
    if (err instanceof Refusal) throw err;
    // Любая непредвиденная ошибка разбора — без текста: он мог бы
    // процитировать содержимое файла.
    throw new Refusal("config.internal");
  }
}

// --------------------------------------------------------------- git

function gitInfo(root) {
  const git = (args) => spawnSync("git", ["-C", root, ...args], { encoding: "utf8", windowsHide: true });
  const inside = git(["rev-parse", "--is-inside-work-tree"]);
  if (inside.error || inside.status !== 0 || inside.stdout.trim() !== "true") {
    return {
      commit: null,
      dirty: null,
      warning: inside.error
        ? "git недоступен — sourceCommit: null"
        : "каталог не в git-репозитории (публичный экспорт?) — sourceCommit: null",
    };
  }
  const head = git(["rev-parse", "--verify", "HEAD"]);
  const commit = head.status === 0 ? head.stdout.trim() : "";
  if (!/^[0-9a-f]{40}([0-9a-f]{24})?$/.test(commit)) throw new Refusal("git.head", "HEAD не читается");
  const status = git(["status", "--porcelain", "--", "."]);
  if (status.error || status.status !== 0) throw new Refusal("git.status", "git status завершился ошибкой");
  const changed = status.stdout.split("\n").filter((line) => line.trim() !== "");
  return { commit, dirty: changed.length > 0, changed, root };
}

const gitRun = (root, args, encoding = "utf8") => spawnSync("git", ["-C", root, ...args], {
  encoding, windowsHide: true, maxBuffer: 256 * 1024 * 1024,
});

// Идентификатор блоба по байтам — сверка того, что git cat-file отдал ровно
// тот объект, который назван в дереве HEAD.
function blobId(data, oid) {
  const algo = oid.length === 64 ? "sha256" : "sha1";
  return createHash(algo).update(`blob ${data.length}\0`).update(data).digest("hex");
}

// Блобы HEAD для списка путей (относительно корня расширения).
function headTree(root, rels) {
  const r = gitRun(root, ["ls-tree", "-z", "-r", "HEAD", ...rels]);
  if (r.error || r.status !== 0) throw new Refusal("git.ls-tree", "git ls-tree завершился ошибкой");
  const tree = new Map();
  for (const rec of r.stdout.split("\0")) {
    if (rec === "") continue;
    const m = /^(\d{6}) (\w+) ([0-9a-f]{40}(?:[0-9a-f]{24})?)\t(.+)$/s.exec(rec);
    if (!m) throw new Refusal("git.ls-tree", "неожиданный вывод git ls-tree");
    tree.set(m[4], { mode: m[1], type: m[2], oid: m[3] });
  }
  return tree;
}

function hashObjects(root, rels, filters) {
  const r = gitRun(root, ["hash-object", ...(filters ? [] : ["--no-filters"]), "--", ...rels]);
  if (r.error || r.status !== 0) throw new Refusal("git.hash-object", "git hash-object завершился ошибкой");
  const oids = r.stdout.split("\n").map((s) => s.trim()).filter((s) => s !== "");
  if (oids.length !== rels.length || oids.some((o) => !/^[0-9a-f]{40}([0-9a-f]{24})?$/.test(o))) {
    throw new Refusal("git.hash-object", "неожиданный вывод git hash-object");
  }
  return oids;
}

function catBlob(root, rel, oid) {
  const r = gitRun(root, ["cat-file", "blob", oid], "buffer");
  if (r.error || r.status !== 0 || blobId(r.stdout, oid) !== oid) {
    throw new Refusal("git.cat-file", `${rel}: блоб HEAD не читается`);
  }
  return r.stdout;
}

// Байты файлов списка. Вне git — рабочие; в git — см. «байты из git» в шапке.
function collectSources(rels, git, allowDirty) {
  const working = rels.map((rel) => readSource(rel));
  if (git.commit === null) {
    return { data: working, worktreeFiles: null, fromCommit: [] };
  }
  const tree = headTree(git.root, rels);
  const raw = hashObjects(git.root, rels, false);
  const norm = hashObjects(git.root, rels, true);
  const data = [];
  const worktreeFiles = [];
  const fromCommit = [];
  rels.forEach((rel, i) => {
    const head = tree.get(rel);
    if (head && head.mode === "120000") throw new Refusal("source.link", `${rel} (в HEAD)`);
    if (head && head.type !== "blob") throw new Refusal("source.not-file", `${rel} (в HEAD)`);
    if (head && raw[i] === head.oid) {
      data.push(working[i]);
    } else if (head && norm[i] === head.oid) {
      data.push(catBlob(git.root, rel, head.oid));
      fromCommit.push(rel);
    } else {
      worktreeFiles.push({ path: rel, eolFiltered: raw[i] !== norm[i] });
      data.push(working[i]);
    }
  });
  if (worktreeFiles.length > 0 && !allowDirty) {
    // git status чистый, а файл расходится с HEAD: assume-unchanged,
    // skip-worktree или иной скрытый от status сдвиг.
    const shown = worktreeFiles.slice(0, 10).map((f) => `  ${f.path}`).join("\n");
    throw new Refusal(
      "git.worktree-mismatch",
      `файлов пакета, расходящихся с HEAD при чистом git status: ${worktreeFiles.length} (флаг --allow-dirty разрешает сборку)\n${shown}`,
    );
  }
  return { data, worktreeFiles, fromCommit };
}

// --------------------------------------------------------------- исходники

// Тот же код, что в tools/export-source.mjs. Сравнение текстом обходится
// другой формой того же места: короткое имя 8.3 (C:\Users\ABCDEF~1), subst-диск,
// junction, иной регистр. Поэтому сравниваются канонические пути:
// realpathSync.native ближайшего существующего предка + несуществующий остаток.
function canonicalPath(p) {
  const abs = resolve(p);
  const rest = [];
  let head = abs;
  for (;;) {
    try {
      return join(realpathSync.native(head), ...rest);
    } catch (err) {
      if (err.code !== "ENOENT" && err.code !== "ENOTDIR") throw err;
      const parent = dirname(head);
      if (parent === head) return abs;
      rest.unshift(basename(head));
      head = parent;
    }
  }
}

function isInside(parent, child) {
  const rel = relative(canonicalPath(parent), canonicalPath(child));
  return rel === "" || (!isAbsolute(rel) && rel.split(sep)[0] !== "..");
}

function readSource(rel) {
  const name = rel.split("/").pop();
  if (NEVER.has(name)) throw new Refusal("source.forbidden", rel);
  // Ни один компонент пути не должен быть ссылкой: пакет собирается только
  // из байтов, лежащих в корне расширения.
  const segments = rel.split("/");
  for (let i = 1; i <= segments.length; i += 1) {
    const partial = segments.slice(0, i).join("/");
    let st;
    try {
      st = lstatSync(join(ROOT, partial));
    } catch {
      throw new Refusal("source.missing", rel);
    }
    if (st.isSymbolicLink()) throw new Refusal("source.link", partial);
    if (i === segments.length && !st.isFile()) throw new Refusal("source.not-file", rel);
  }
  return readFileSync(join(ROOT, rel));
}

// --------------------------------------------------------------- ZIP

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// entries: [{ name, data }] уже отсортированы. Время 00:00:00 у всех.
function buildZip(entries, date) {
  const dosDate = ((date.y - 1980) << 9) | (date.mo << 5) | date.d;
  const dosTime = 0;
  if (entries.length > 0xffff) throw new Refusal("zip.too-many-entries");
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const { name, data } of entries) {
    const nameBuf = Buffer.from(name, "utf8");
    const comp = deflateRawSync(data, { level: 9 });
    const crc = crc32(data);
    if (data.length > 0xfffffffe || comp.length > 0xfffffffe || offset > 0xfffffffe) {
      throw new Refusal("zip.needs-zip64", name);
    }

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed: 2.0 (deflate)
    local.writeUInt16LE(0, 6); // flags: без data descriptor
    local.writeUInt16LE(8, 8); // deflate
    local.writeUInt16LE(dosTime, 10);
    local.writeUInt16LE(dosDate, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(comp.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28); // extra
    locals.push(local, nameBuf, comp);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4); // made by: MS-DOS, 2.0
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt16LE(dosTime, 12);
    central.writeUInt16LE(dosDate, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(comp.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30); // extra
    central.writeUInt16LE(0, 32); // comment
    central.writeUInt16LE(0, 34); // disk
    central.writeUInt16LE(0, 36); // internal attrs
    central.writeUInt32LE(0, 38); // external attrs
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBuf);

    offset += local.length + nameBuf.length + comp.length;
  }
  const cd = Buffer.concat(centrals);
  if (offset + cd.length > 0xfffffffe) throw new Refusal("zip.needs-zip64");
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);
  return Buffer.concat([...locals, cd, eocd]);
}

// --------------------------------------------------------------- индекс

function prepareIndex(indexArg, zipPath) {
  const path = resolve(indexArg);
  if (isInside(ROOT, path)) throw new Refusal("index.inside-root", path);
  let data;
  try {
    let text = readFileSync(path, "utf8");
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    data = JSON.parse(text);
  } catch {
    throw new Refusal("index.unreadable", path);
  }
  if (data === null || typeof data !== "object" || !Array.isArray(data.releases)) {
    throw new Refusal("index.shape", "нет массива releases");
  }
  const publicAt = [];
  data.releases.forEach((r, i) => { if (r && r.variant === "public") publicAt.push(i); });
  if (publicAt.length > 1) throw new Refusal("index.ambiguous", "записей variant=public больше одной");
  // Канонические формы с обеих сторон: --index и --out могут прийти в разных
  // формах одного пути (8.3 и длинной), и текстовый relative дал бы «../..».
  const pkg = relative(canonicalPath(dirname(path)), canonicalPath(zipPath));
  if (pkg === "" || isAbsolute(pkg) || pkg.split(sep)[0] === "..") {
    throw new Refusal("index.package-outside", "ZIP не лежит под каталогом индекса");
  }
  return { path, data, publicAt: publicAt[0], pkg: pkg.split(sep).join("/") };
}

function writeIndex(index, record) {
  if (index.publicAt === undefined) index.data.releases.push(record);
  else index.data.releases[index.publicAt] = record;
  index.data.generatedAt = new Date().toISOString();
  const tmp = `${index.path}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(index.data, null, 2) + "\n", { flag: "wx" });
  renameSync(tmp, index.path);
}

// --------------------------------------------------------------- сборка

const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");

function main(argv) {
  const opts = parseArgs(argv);
  const manifest = readManifest();

  const configPath = resolve(opts.config);
  const cfg = loadConfig(configPath, manifest);
  const configText = serializeConfig(cfg);

  const out = resolve(opts.out);
  if (isInside(ROOT, out)) throw new Refusal("out.inside-root", out);
  try {
    if (readdirSync(out).length > 0) throw new Refusal("out.not-empty", out);
  } catch (err) {
    if (err instanceof Refusal) throw err;
    if (err.code === "ENOTDIR") throw new Refusal("out.not-directory", out);
    if (err.code !== "ENOENT") throw err;
  }

  const zipName = `ThumbSight-Public-Beta-${manifest.version}-${opts.date.text}.zip`;
  const zipPath = join(out, zipName);
  const index = opts.index === undefined ? null : prepareIndex(opts.index, zipPath);

  const git = gitInfo(ROOT);
  if (git.warning) console.log(`ПРЕДУПРЕЖДЕНИЕ: ${git.warning}`);
  if (git.dirty && !opts.allowDirty) {
    const shown = git.changed.slice(0, 10).map((line) => `  ${line}`).join("\n");
    throw new Refusal(
      "git.dirty",
      `незакоммиченных изменений: ${git.changed.length} (флаг --allow-dirty разрешает сборку)\n${shown}`,
    );
  }

  // --- состав
  const rels = [...RUNTIME, ...SHIPPED_DOCS];
  const sources = collectSources(rels, git, opts.allowDirty);
  const sourceDirty = git.commit === null ? null : git.dirty || sources.worktreeFiles.length > 0;
  const entries = rels.map((rel, i) => ({ name: rel, data: sources.data[i] }));
  entries.push({ name: "config.js", data: Buffer.from(configText, "utf8") });
  for (const { name } of entries) {
    if (!/^[A-Za-z0-9_.-]+(\/[A-Za-z0-9_.-]+)*$/.test(name) || name.split("/").includes("..")) {
      throw new Refusal("zip.bad-name", name);
    }
  }
  if (new Set(entries.map((e) => e.name)).size !== entries.length) throw new Refusal("zip.duplicate-name");
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

  const zip = buildZip(entries, opts.date);
  const zipSha = sha256(zip);
  const files = entries.map(({ name, data }) => ({ path: name, sha256: sha256(data), bytes: data.length }));
  const provenance = {
    sourceCommit: git.commit,
    sourceDirty,
    // null — вне git; [] — все файлы равны блобам sourceCommit; иначе —
    // файлы, взятые из рабочей копии и в sourceCommit не лежащие.
    worktreeFiles: sources.worktreeFiles,
    version: manifest.version,
    versionName: manifest.versionName,
    date: opts.date.text,
    publicOnly: true,
    publicConfigValidated: true,
    zipSha256: zipSha,
    zipBytes: zip.length,
    files,
  };

  // --- запись: всё уже собрано в памяти, каталог пуст или отсутствует
  mkdirSync(out, { recursive: true });
  writeFileSync(zipPath, zip, { flag: "wx" });
  writeFileSync(`${zipPath}.sha256`, `${zipSha}  ${zipName}\n`, { flag: "wx" });
  writeFileSync(`${zipPath}.provenance.json`, JSON.stringify(provenance, null, 2) + "\n", { flag: "wx" });
  const unpacked = join(out, "unpacked");
  // mtime — локальная полночь --date: DOS-время записей ZIP тоже локальное
  // (без часового пояса), и распаковщик выставит файлам ту же отметку.
  const stamp = new Date(opts.date.y, opts.date.mo - 1, opts.date.d);
  for (const { name, data } of entries) {
    const target = join(unpacked, ...name.split("/"));
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, data, { flag: "wx" });
    utimesSync(target, stamp, stamp);
  }

  if (index) {
    writeIndex(index, {
      variant: "public",
      version: manifest.versionName,
      visibility: "public-beta",
      browser: "chromium",
      package: index.pkg,
      bytes: zip.length,
      sha256: zipSha,
      sourceCommit: git.commit,
    });
  }

  // --- отчёт: имена, размеры, хеши. Значение ключа — никогда.
  const fields = ["SUPABASE_URL", "SUPABASE_ANON_KEY", ...(cfg.AUTH_SITE_URL === undefined ? [] : ["AUTH_SITE_URL"])];
  console.log(`Версия: ${manifest.version} (${manifest.versionName}), дата ${opts.date.text}`);
  console.log(`Источник: ${git.commit ?? "без git"}${sourceDirty ? " (dirty, --allow-dirty)" : ""}`);
  if (sources.fromCommit.length > 0) {
    console.log(`Из блобов HEAD (рабочая копия отличается только фильтрами git, напр. CRLF): ${sources.fromCommit.length} — ${sources.fromCommit.join(", ")}`);
  }
  if (sources.worktreeFiles?.length > 0) {
    const list = sources.worktreeFiles.map((f) => `${f.path}${f.eolFiltered ? " (eol: git изменил бы байты при коммите)" : ""}`);
    console.log(`Из рабочей копии, не из коммита: ${list.length} — ${list.join(", ")}`);
  }
  console.log(`config.js: проверен и сгенерирован, поля ${fields.join(", ")}; значение ключа не выводится`);
  console.log(`Файлов в ZIP: ${files.length}`);
  for (const f of files) console.log(`  ${f.sha256}  ${String(f.bytes).padStart(7)}  ${f.path}`);
  console.log(`ZIP: ${zipPath}`);
  console.log(`  байт: ${zip.length}`);
  console.log(`  sha256: ${zipSha}`);
  console.log(`Рядом: ${zipName}.sha256, ${zipName}.provenance.json, unpacked/ (${files.length} файлов)`);
  if (index) {
    console.log(`Индекс: ${index.path} — запись public ${index.publicAt === undefined ? "добавлена" : "заменена"}`);
  }
}

try {
  main(process.argv.slice(2));
} catch (err) {
  if (err instanceof UsageError) {
    console.error(`Неверный вызов: ${err.message}\n${USAGE}`);
    process.exit(2);
  }
  if (err instanceof Refusal) {
    console.error(`ОТКАЗ [${err.rule}]${err.detail ? ` ${err.detail}` : ""}`);
    process.exit(1);
  }
  // Сюда config уже не доходит (его ошибки обёрнуты в Refusal выше):
  // остаются ошибки файловой системы, их текст — пути, не содержимое.
  console.error(`ОТКАЗ [internal] ${err?.code ?? ""} ${err?.message ?? "непредвиденная ошибка"}`);
  process.exit(1);
}

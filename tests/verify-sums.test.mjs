// node --test: граница чтения у tools/verify-sums.mjs.
//
// Проверяем не «упало ли», а ЧТО ИМЕННО инструмент трогает. Список хешей —
// это ввод: строка в нём не должна превращаться в открытие произвольного
// файла. Поэтому у запрещённых записей проверяется не только ненулевой код
// выхода, но и ФАКТ отсутствия чтения — внешним подменённым readFileSync.
//
// Ни одного настоящего config.js, .env и ни одного настоящего каталога
// backups здесь не создаётся и не открывается: запрещённые имена живут
// только строками в synthetic списке, а карантинный случай проверяется на
// несуществующем пути — правило обязано сработать ДО обращения к диску.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync,
  rmSync, symlinkSync, writeFileSync,
} from "node:fs";
import { join, resolve, sep } from "node:path";
import { tmpdir } from "node:os";

const VERIFIER = resolve(import.meta.dirname, "..", "tools", "verify-sums.mjs");
const PREFIX = "tv-sums-";

const sha = (buf) => createHash("sha256").update(buf).digest("hex");

// Каждый случай — свой одноразовый каталог. Пути наружу не выходят.
const made = [];
function scratch() {
  const dir = mkdtempSync(join(tmpdir(), PREFIX));
  made.push(dir);
  return dir;
}

// Уборка: сначала снимаем собственные ссылки (иначе рекурсивное удаление
// могло бы пойти по ним), потом удаляем только свои каталоги и только после
// сверки абсолютной границы.
const links = [];
function cleanup() {
  for (const link of links.splice(0)) {
    try { rmSync(link, { force: true, recursive: false }); } catch { /* уже нет */ }
  }
  const parent = resolve(tmpdir());
  for (const dir of made.splice(0)) {
    const base = dir.slice(parent.length + 1);
    // Удаляем только то, что создали сами: прямой ребёнок os.tmpdir с нашим
    // префиксом. Ни маски, ни отбора по времени, ни чужих каталогов.
    if (!dir.startsWith(parent + sep) || !base.startsWith(PREFIX) || base.includes(sep)) continue;
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* занято */ }
  }
}
test.after(cleanup);

// Кладёт файлы и список. `sums` — массив [hash, relPath]; hash "auto" берётся
// из реального содержимого одноимённого файла, иначе пишется как есть.
function fixture(files = {}, sums = []) {
  const dir = scratch();
  for (const [rel, body] of Object.entries(files)) {
    const target = join(dir, rel);
    mkdirSync(join(target, ".."), { recursive: true });
    writeFileSync(target, body);
  }
  const lines = sums.map(([hash, rel]) => {
    const value = hash === "auto" ? sha(readFileSync(join(dir, rel))) : hash;
    return `${value}  ${rel}`;
  });
  writeFileSync(join(dir, "SHA256SUMS.txt"), lines.join("\n") + "\n");
  return dir;
}

function run(root, extraArgs = []) {
  const r = spawnSync(process.execPath, [...extraArgs, VERIFIER, root], { encoding: "utf8" });
  return { status: r.status, out: `${r.stdout}${r.stderr}` };
}

// Тот же запуск, но с внешним наблюдателем: каждый readFileSync пишет свой
// путь в журнал. Так видно не «чем кончилось», а что вообще открывалось.
function runSpied(root) {
  const spyDir = scratch();
  const log = join(spyDir, "reads.log");
  const spy = join(spyDir, "spy.cjs");
  writeFileSync(spy, [
    'const fs = require("node:fs");',
    'const orig = fs.readFileSync;',
    `const LOG = ${JSON.stringify(log)};`,
    'fs.readFileSync = function (...args) {',
    '  try { fs.appendFileSync(LOG, String(args[0]) + "\\n"); } catch {}',
    '  return orig.apply(this, args);',
    '};',
  ].join("\n"));

  const res = run(root, ["--require", spy]);
  const reads = existsSync(log)
    ? readFileSync(log, "utf8").split("\n").filter(Boolean)
    : [];
  // Загрузка самих модулей Node нас не интересует — только то, что тул
  // открыл внутри проверяемого каталога.
  const inside = reads.filter((p) => p.toLowerCase().startsWith(root.toLowerCase()));
  return { ...res, reads: inside };
}

const SAFE = "содержимое, которое не жалко\n";

// Умеет ли ОС/учётка вообще делать ссылки: без Developer Mode на Windows
// создание symlink падает с EPERM, и тогда эти два случая честно пропускаются.
const linksAvailable = (() => {
  try {
    const dir = scratch();
    writeFileSync(join(dir, "target.txt"), SAFE);
    symlinkSync(join(dir, "target.txt"), join(dir, "link.txt"), "file");
    return lstatSync(join(dir, "link.txt")).isSymbolicLink();
  } catch {
    return false;
  }
})();
const skipNoLinks = linksAvailable ? false : "ссылки недоступны в этой среде";

// ----------------------------------------------------------- обычная работа

test("валидный список проходит, включая config.example.js и .gitignore", () => {
  const dir = fixture(
    {
      "a.txt": SAFE,
      "sub/b.txt": "второй\n",
      "config.example.js": "// шаблон без ключа\n",
      ".gitignore": "config.js\n",
    },
    [["auto", "a.txt"], ["auto", "sub/b.txt"], ["auto", "config.example.js"], ["auto", ".gitignore"]],
  );
  const r = run(dir);
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /совпало: 4/);
});

test("изменённый файл — отказ", () => {
  const dir = fixture({ "a.txt": SAFE }, [["auto", "a.txt"]]);
  writeFileSync(join(dir, "a.txt"), "подменено\n");
  const r = run(dir);
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /FAIL хеш: a\.txt/);
});

test("пропавший файл — отказ", () => {
  const dir = fixture({ "a.txt": SAFE }, [["auto", "a.txt"]]);
  rmSync(join(dir, "a.txt"));
  const r = run(dir);
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /FAIL нет файла: a\.txt/);
});

// ------------------------------------------- запрещённые имена: отказ и тишина

// Хеш в списке специально ВЕРНЫЙ для одноимённого файла: если бы тул его
// прочитал, он бы отчитался успехом. Значит отказ здесь — это именно отказ
// по имени, а не случайное несовпадение.
for (const name of ["config.js", "CONFIG.JS", "config.js.", ".env", ".ENV.LOCAL", "Config.Js"]) {
  test(`«${name}» — отказ без единого чтения`, () => {
    const dir = fixture({ [name]: SAFE }, [[sha(Buffer.from(SAFE)), name]]);
    const r = runSpied(dir);
    assert.equal(r.status, 1, r.out);
    assert.match(r.out, /запрещено читать этим тулом/);
    assert.deepEqual(
      r.reads.map((p) => p.slice(dir.length + 1)),
      ["SHA256SUMS.txt"],
      `тул открыл лишнее: ${JSON.stringify(r.reads)}`,
    );
  });
}

test("карантинный сегмент — отказ без чтения и без настоящего каталога", () => {
  // Каталога backups здесь НЕ существует: правило обязано сработать до диска,
  // иначе отказ был бы просто «нет файла».
  const dir = fixture({}, [[sha(Buffer.from(SAFE)), "backups/probe.txt"]]);
  const r = runSpied(dir);
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /карантинный каталог/);
  assert.doesNotMatch(r.out, /нет файла/, "отказ пришёл от файловой системы, а не от правила");
  assert.deepEqual(r.reads.map((p) => p.slice(dir.length + 1)), ["SHA256SUMS.txt"]);
  assert.equal(existsSync(join(dir, "backups")), false, "каталог backups не должен появляться");
});

test("карантин в самом пути каталога — отказ до чтения списка", () => {
  // Несуществующий путь: проверка имени идёт раньше любого обращения к диску.
  const r = run(join(tmpdir(), "tv-sums-nonexistent", "backups", "root"));
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /карантинн/);
});

// --------------------------------------------- неоднозначные и опасные формы

test("неоднозначные формы пути отклоняются", () => {
  const cases = [
    ["a.txt ", /хвостовая точка или пробел/],
    ["a.txt.", /хвостовая точка или пробел/],
    [" a.txt", /ведущий пробел/],
    ["a:b.txt", /недопустимый или неоднозначный/],
    ["sub\\b.txt", /недопустимый или неоднозначный/],
    ["NUL", /зарезервированное имя устройства/],
    ["con.txt", /зарезервированное имя устройства/],
    ["../a.txt", /traversal/],
    ["sub/../../a.txt", /traversal/],
    ["./a.txt", /traversal/],
    ["/etc/passwd", /абсолютный/],
    ["C:/Windows/win.ini", /абсолютный/],
    ["", /пуст/],
  ];
  for (const [rel, expected] of cases) {
    const dir = fixture({ "a.txt": SAFE }, [[sha(Buffer.from(SAFE)), rel]]);
    const r = run(dir);
    assert.equal(r.status, 1, `${JSON.stringify(rel)} принят: ${r.out}`);
    assert.match(r.out, expected, `${JSON.stringify(rel)}: ${r.out}`);
  }
});

test("дубль ловится и при разном регистре", () => {
  const dir = fixture({ "a.txt": SAFE }, [["auto", "a.txt"], ["auto", "a.txt"]]);
  const lines = readFileSync(join(dir, "SHA256SUMS.txt"), "utf8").split("\n");
  writeFileSync(join(dir, "SHA256SUMS.txt"), `${lines[0]}\n${lines[1].replace("a.txt", "A.TXT")}\n`);
  const r = run(dir);
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /FAIL дубль/);
});

// ---------------------------------------------------------------- ссылки

test("ссылка в пути записи — отказ, цель не выясняется", { skip: skipNoLinks }, () => {
  const outside = scratch();
  writeFileSync(join(outside, "sample.txt"), "synthetic outside root\n");

  const dir = fixture({}, []);
  const link = join(dir, "link");
  symlinkSync(outside, link, "junction");
  links.push(link);
  writeFileSync(
    join(dir, "SHA256SUMS.txt"),
    `${sha(readFileSync(join(outside, "sample.txt")))}  link/sample.txt\n`,
  );

  const r = runSpied(dir);
  assert.equal(r.status, 1, `файл за пределами каталога был принят: ${r.out}`);
  assert.match(r.out, /ссылка в пути/);
  assert.deepEqual(r.reads.map((p) => p.slice(dir.length + 1)), ["SHA256SUMS.txt"]);
});

test("SHA256SUMS.txt — ссылка: список не читается", { skip: skipNoLinks }, () => {
  const outside = scratch();
  writeFileSync(join(outside, "SHA256SUMS.txt"), "мимо\n");

  const dir = scratch();
  const link = join(dir, "SHA256SUMS.txt");
  symlinkSync(join(outside, "SHA256SUMS.txt"), link, "file");
  links.push(link);

  const r = runSpied(dir);
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /ссылка/);
  assert.deepEqual(r.reads, [], `список всё-таки открыли: ${JSON.stringify(r.reads)}`);
});

// -------------------------------------------------------- настоящий экспорт

test("настоящий экспортированный срез проходит целиком", (t) => {
  const pkgRoot = resolve(import.meta.dirname, "..");
  if (!existsSync(join(pkgRoot, "SHA256SUMS.txt"))) {
    // В monorepo списка нет: он появляется только в экспортированной копии.
    t.skip("SHA256SUMS.txt рядом нет — это не экспортированная копия");
    return;
  }
  const r = run(pkgRoot);
  assert.equal(r.status, 0, r.out);
  const count = Number(r.out.match(/записей: (\d+)/)?.[1] ?? 0);
  assert.ok(count >= 49, `в списке подозрительно мало записей: ${count}`);
  assert.match(r.out, new RegExp(`совпало: ${count}\\b`));
});

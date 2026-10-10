// Экспорт самостоятельного public-only среза исходников.
//
//   node tools/export-source.mjs <каталог-назначения>
//
// Что это НЕ делает:
//   не обходит каталоги рекурсивно — список пофайловый и лежит в
//   tools/runtime-files.mjs;
//   не читает и не копирует настоящий config.js, .env, admin/, supabase/,
//   .git/, node_modules, бэкапы, receipts, результаты прогонов и скриншоты —
//   их здесь просто нет, и тул к ним не обращается даже чтобы исключить;
//   не собирает установочный ZIP (это делает tools/package-release.mjs);
//   не перезаписывает существующий каталог.
//
// Почему пофайлово: обход подхватил бы всё, что случайно оказалось в рабочем
// каталоге, — от личного config.js до чужих временных файлов. Список,
// который надо править руками, — это и есть граница публикации.
import {
  copyFileSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  DOCS, META, NEVER, PACKAGE, RUNTIME, RUNTIME_UNSHIPPED, TEMPLATE, TESTS, TOOLS,
} from "./runtime-files.mjs";

// ------------------------------------------------------------- что экспортируем

// Состав и обоснование каждого списка — в tools/runtime-files.mjs: тот же
// источник читает упаковщик ZIP, чтобы срез и пакет не разошлись.
const FILES = [...RUNTIME, ...RUNTIME_UNSHIPPED, ...TEMPLATE, ...DOCS, ...META, ...PACKAGE, ...TOOLS, ...TESTS];

// Генерируется, а не копируется: в рабочем каталоге такого файла нет.
const GITIGNORE = [
  "# Личная настройка: сюда попадает настоящий ключ. В публичный репозиторий — никогда.",
  "config.js",
  ".env",
  "node_modules/",
  "",
].join("\n");

// ------------------------------------------------------------------- проверки

const SRC = resolve(import.meta.dirname, "..");
const dest = process.argv[2];
if (!dest) {
  console.error("Укажи каталог назначения: node tools/export-source.mjs <каталог>");
  process.exit(2);
}
const OUT = resolve(dest);

// Тот же код, что isInside/canonicalPath в упаковщике. Сравнение текстом
// обходится другой формой того же места: короткое имя 8.3 (C:\Users\ABCDEF~1),
// subst-диск, junction, иной регистр. Поэтому сравниваются канонические пути:
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

if (isInside(SRC, OUT)) {
  console.error(`Назначение внутри исходников: ${OUT}`);
  process.exit(2);
}

let existing = null;
try {
  existing = readdirSync(OUT);
} catch (err) {
  if (err.code !== "ENOENT") throw err;
}
if (existing && existing.length > 0) {
  console.error(`Каталог ${OUT} не пуст — экспорт ничего не перезаписывает. Выбери новый.`);
  process.exit(2);
}

const seen = new Set();
for (const rel of FILES) {
  const name = rel.split("/").pop();
  if (NEVER.has(name)) {
    console.error(`Файл ${rel} экспортировать запрещено`);
    process.exit(2);
  }
  if (seen.has(rel)) {
    console.error(`Файл ${rel} перечислен дважды`);
    process.exit(2);
  }
  seen.add(rel);
  const stat = statSync(join(SRC, rel)); // отсутствие файла — падение, не тихий пропуск
  if (!stat.isFile()) {
    console.error(`${rel} — не обычный файл`);
    process.exit(2);
  }
}

// --------------------------------------------------------------------- экспорт

const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");
const sums = [];

mkdirSync(OUT, { recursive: true });
for (const rel of FILES) {
  const target = join(OUT, rel);
  mkdirSync(dirname(target), { recursive: true });
  copyFileSync(join(SRC, rel), target);
  sums.push(`${sha256(readFileSync(target))}  ${rel}`);
}

writeFileSync(join(OUT, ".gitignore"), GITIGNORE);
sums.push(`${sha256(Buffer.from(GITIGNORE))}  .gitignore`);

sums.sort((a, b) => (a.slice(66) < b.slice(66) ? -1 : 1));
writeFileSync(join(OUT, "SHA256SUMS.txt"), sums.join("\n") + "\n");

console.log(`Экспортировано файлов: ${FILES.length + 1} (включая сгенерированный .gitignore)`);
console.log(`Каталог: ${OUT}`);
console.log("Хеши: SHA256SUMS.txt (сам себя не перечисляет)");

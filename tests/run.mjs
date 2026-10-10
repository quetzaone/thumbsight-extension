// Единая точка запуска Node-проверок расширения.
//
//   node tests/run.mjs internal   — monorepo: public + admin + supabase
//   node tests/run.mjs public     — самостоятельный public-only экспорт
//
// Зачем отдельный раннер, а не переменная окружения в npm-скрипте: задание
// переменной в package.json непортируемо (cmd.exe и sh пишут её по-разному),
// а область проверок должна выбираться одинаково на любой ОС и быть видна
// в самой команде. Неизвестная область — отказ до запуска тестов.
import { readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";

const SCOPES = ["internal", "public"];
const scope = process.argv[2];
if (!SCOPES.includes(scope)) {
  console.error(`Область: ${SCOPES.join(" | ")}. Получено: ${JSON.stringify(scope ?? null)}`);
  process.exit(2);
}

const here = import.meta.dirname;
const files = readdirSync(here)
  .filter((name) => name.endsWith(".test.mjs"))
  .sort()
  .map((name) => `${here}/${name}`);

if (files.length === 0) {
  console.error("В tests/ нет ни одного *.test.mjs — запускать нечего");
  process.exit(2);
}

console.log(`TV_TEST_SCOPE=${scope}, файлов: ${files.length}`);
const run = spawnSync(process.execPath, ["--test", ...files], {
  stdio: "inherit",
  env: { ...process.env, TV_TEST_SCOPE: scope },
});
process.exit(run.status ?? 1);

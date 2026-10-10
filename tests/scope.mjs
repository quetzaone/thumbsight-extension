// Область проверок: какие исходники тестам разрешено читать.
//
//   internal — рабочий monorepo: public + admin + supabase/*.sql;
//   public   — самостоятельный public-only экспорт: соседних admin/backend
//              каталогов физически нет, и они не должны требоваться.
//
// Выбор ВСЕГДА явный. Значение приходит из TV_TEST_SCOPE (его ставит
// tests/run.mjs). Умолчание — internal: public-режим не должен включаться
// сам по себе, иначе monorepo молча перестанет проверять admin.
// Неизвестное значение — отказ при загрузке, а не тихий откат к умолчанию.

const SCOPES = new Set(["internal", "public"]);

const raw = process.env.TV_TEST_SCOPE ?? "internal";
if (!SCOPES.has(raw)) {
  throw new Error(
    `TV_TEST_SCOPE=${JSON.stringify(raw)} — допустимы только "internal" и "public"`,
  );
}

export const SCOPE = raw;

// Доступны ли приватные соседи (extensions/admin, supabase/).
export const WITH_PRIVATE = SCOPE === "internal";

// Варианты расширения, исходники которых тест вправе прочитать.
export const VARIANTS = WITH_PRIVATE ? ["public", "admin"] : ["public"];

// Корень варианта. Public — это ВСЕГДА расширение, внутри которого лежат сами
// тесты: в monorepo `extensions/public/`, в самостоятельном экспорте — корень
// репозитория. Захардкоженный `../../public/` работал только в первом случае.
// Остальные варианты — соседние каталоги monorepo и в экспорт не попадают.
export const variantRoot = (variant) => (
  variant === "public"
    ? new URL("../", import.meta.url)
    : new URL(`../../${variant}/`, import.meta.url)
);

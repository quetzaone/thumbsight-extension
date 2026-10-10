// Пофайловые списки публичного расширения — единый источник для
// tools/export-source.mjs (срез исходников) и tools/package-release.mjs
// (установочный ZIP).
//
// Почему пофайлово: обход подхватил бы всё, что случайно оказалось в рабочем
// каталоге, — от личного config.js до чужих временных файлов. Список,
// который надо править руками, — это и есть граница публикации.
//
// Пути — относительно корня расширения, с прямыми слэшами.

// Байты расширения, которые попадают и в установочный пакет. Тот же состав,
// что в санированной копии браузерных проверок (tests/*.check.mjs).
// config.js здесь нет и быть не может: в ZIP он не копируется, а
// генерируется упаковщиком из проверенных публичных полей.
export const RUNTIME = [
  "manifest.json",
  "background.js", "intent.js", "oauth.js", "i18n.js", "supabase.js", "api.js",
  "modal.js", "panel.html", "panel.css", "panel.js", "popup.html", "popup.js",
  "content.css", "content.js", "content-channel.js", "content-pinterest.js",
  "_locales/en/messages.json", "_locales/es/messages.json", "_locales/ru/messages.json",
  "icons/icon16.png", "icons/icon48.png", "icons/icon128.png",
];

// Незавершённый Firefox-порт: в установочный пакет НЕ входит и готовым XPI не
// является (PUB-04). В исходниках остаётся, потому что ветки этого порта уже
// живут в экспортируемых oauth.js/background.js/intent.js и должны быть
// покрыты тестом, а не молча уехать непроверенными.
export const RUNTIME_UNSHIPPED = ["manifest.firefox.json"];

// Шаблон настройки. Это НЕ рабочий config: ключа в нём нет, только placeholder.
export const TEMPLATE = ["config.example.js"];

// Документы среза исходников. Обязаны включать все SHIPPED_DOCS: срез несёт
// tools/package-release.mjs, а упаковщик кладёт SHIPPED_DOCS в ZIP — без
// INSTALL.md в срезе сборка ZIP из экспорта падает на source.missing.
// Поэтому INSTALL.md едет и в срез, и в пакет; личных путей владельца в нём
// быть не должно (это сторожит tests/package-release.test.mjs).
export const DOCS = ["DEVELOPMENT.md", "INSTALL.md", "THIRD_PARTY_NOTICES.md", "LICENSE"];

// Документы, которые кладутся в установочный ZIP рядом с RUNTIME.
// Лицензия и уведомления о сторонних компонентах обязаны ехать вместе с
// бинарным пакетом, а не только жить в репозитории. Подмножество DOCS.
export const SHIPPED_DOCS = ["INSTALL.md", "LICENSE", "THIRD_PARTY_NOTICES.md"];

// Служебные файлы репозитория. .gitattributes едет в срез как есть: правило
// eol=lf должно действовать и в клонах публичного репозитория, иначе под
// core.autocrlf=true их рабочие копии снова получат CRLF.
export const META = [".gitattributes"];

export const PACKAGE = ["package.json", "package-lock.json"];

export const TOOLS = [
  "tools/export-source.mjs",
  "tools/verify-sums.mjs",
  "tools/runtime-files.mjs",
  "tools/package-release.mjs",
];

// Проверки. Стенды Firefox (firefox-stand*.mjs, firefox-probe/, firefox-stage/)
// не входят: это ручной стенд приостановленного порта, а его юнит-тест читает
// сохранённые отчёты прошлых прогонов — выгружать результаты прогонов нельзя.
export const TESTS = [
  "tests/run.mjs", "tests/scope.mjs",
  "tests/channel-identity.test.mjs",
  "tests/firefox-port.test.mjs",
  "tests/i18n-lang.test.mjs",
  "tests/intent-boundary.test.mjs",
  "tests/junction-rpc.test.mjs",
  "tests/logout-revoke.test.mjs",
  "tests/package-release.test.mjs",
  "tests/pgrst303-recovery.test.mjs",
  "tests/pub02-note-update.test.mjs",
  "tests/pub06-snapshot-budget.test.mjs",
  "tests/pub07-storage-barrier.test.mjs",
  "tests/verify-sums.test.mjs",
  "tests/browser-intent.check.mjs",
  "tests/pub01-host-dom.check.mjs",
  "tests/pub02-panel-retry.check.mjs",
  "tests/pub06-snapshot-budget.check.mjs",
  "tests/pub07-storage-barrier.check.mjs",
  "tests/pub07-chrome-floor.check.mjs",
  "tests/pub07-restart.check.mjs",
  "tests/release-artifact.check.mjs",
];

// Страховка от правки списков «на автомате»: эти имена не экспортируются и
// не копируются в пакет никогда. (config.js в ZIP — сгенерированный файл,
// а не копия рабочего.)
export const NEVER = new Set(["config.js", ".env", ".env.local"]);

// node --test: границы намерения и приватности публичного расширения.
// Покрывает EXT-001 (synthetic host-page actions) и EXT-002 (private metadata
// в общей с host page DOM).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import intent from "../intent.js";

const {
  TV_MESSAGE_POLICY,
  tvIsTrustedGesture,
  tvValidateIntent,
  tvCreateSessionIntentStore,
  tvCreateActionLock,
  tvRandomNonce,
  tvMessageAllowed,
  tvSenderIsAllowed,
} = intent;

const EXT = "a".repeat(32);
const OTHER_EXT = "b".repeat(32);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (name) => readFileSync(join(ROOT, name), "utf8");

const YT_ORIGIN = "https://www.youtube.com/watch?v=dQw4w9WgXcQ";
const PIN_ORIGIN = "https://ru.pinterest.com/pin/12345/";

const YT_INTENT = {
  mode: "youtube",
  videoId: "dQw4w9WgXcQ",
  imageUrl: "https://i.ytimg.com/vi/dQw4w9WgXcQ/maxresdefault.jpg",
  sourceUrl: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
};
const PIN_INTENT = {
  mode: "pinterest",
  imageUrl: "https://i.pinimg.com/originals/aa/bb/cc.jpg",
  sourceUrl: "https://ru.pinterest.com/pin/12345/",
};
const CH_INTENT = {
  mode: "channel",
  channelId: "UC" + "a".repeat(22),
  channelName: "  Пример   канала ",
  channelAvatar: "https://yt3.ggpht.com/abc=s176",
};

const contentSender = (url = YT_ORIGIN, tabId = 7) => ({ id: EXT, url, tab: { id: tabId } });
const panelSender = (tabId = 7) => ({ id: EXT, url: `chrome-extension://${EXT}/panel.html`, tab: { id: tabId } });
const popupSender = () => ({ id: EXT, url: `chrome-extension://${EXT}/popup.html` });

function memoryArea(initial = {}) {
  const data = { ...initial };
  return {
    async get(keys) {
      if (keys === null) return { ...data };
      const list = Array.isArray(keys) ? keys : [keys];
      return Object.fromEntries(list.filter((key) => key in data).map((key) => [key, data[key]]));
    },
    async set(values) {
      Object.assign(data, values);
    },
    async remove(keys) {
      for (const key of Array.isArray(keys) ? keys : [keys]) delete data[key];
    },
    snapshot() {
      return structuredClone(data);
    },
  };
}

function nonceSequence() {
  let n = 0;
  return () => `${String(++n).padStart(2, "0")}${"a".repeat(30)}`;
}

// ---------------------------------------------------------------- EXT-001

test("EXT-001: синтетическое событие страницы не считается намерением", () => {
  const active = { isActive: true };
  assert.equal(tvIsTrustedGesture({ isTrusted: false }, active), false, "programmatic .click()");
  assert.equal(tvIsTrustedGesture({ isTrusted: true }, { isActive: false }), false, "dispatchEvent без activation");
  assert.equal(tvIsTrustedGesture(null, active), false);
  assert.equal(tvIsTrustedGesture({}, active), false);
  assert.equal(tvIsTrustedGesture({ isTrusted: "true" }, active), false);
});

test("EXT-001: реальный клик пользователя проходит", () => {
  assert.equal(tvIsTrustedGesture({ isTrusted: true }, { isActive: true }), true);
  // Браузер без navigator.userActivation — остаётся isTrusted.
  assert.equal(tvIsTrustedGesture({ isTrusted: true }, null), true);
  assert.equal(tvIsTrustedGesture({ isTrusted: true }, undefined), true);
});

test("EXT-001: host page не вправе слать ни один authenticated route", () => {
  for (const type of ["tv:sb-rest", "tv:sb-function", "tv:sb-session", "tv:oauth-sign-in", "tv:sb-sign-out", "tv:claim-intent", "tv:snapshot-stats"]) {
    assert.equal(tvMessageAllowed(type, contentSender(), EXT), false, type);
  }
  assert.equal(tvMessageAllowed("tv:open-intent", contentSender(), EXT), true);
  assert.equal(tvMessageAllowed("tv:ping", contentSender(), EXT), true);
});

test("EXT-001: mutating proxy доступен только extension-origin страницам", () => {
  for (const type of ["tv:sb-rest", "tv:sb-function", "tv:sb-session"]) {
    assert.equal(tvMessageAllowed(type, panelSender(), EXT), true, type);
    assert.equal(tvMessageAllowed(type, popupSender(), EXT), true, type);
  }
  // Popup-only маршруты недоступны отдельной panel tab.
  assert.equal(tvMessageAllowed("tv:oauth-sign-in", panelSender(), EXT), false);
  assert.equal(tvMessageAllowed("tv:sb-sign-out", panelSender(), EXT), false);
  assert.equal(tvMessageAllowed("tv:oauth-sign-in", popupSender(), EXT), true);
});

test("EXT-001: подделанные и неизвестные сообщения отклоняются", () => {
  assert.equal(tvMessageAllowed(undefined, panelSender(), EXT), false);
  assert.equal(tvMessageAllowed("tv:unknown", panelSender(), EXT), false);
  assert.equal(tvMessageAllowed("toString", panelSender(), EXT), false, "prototype pollution");
  assert.equal(tvMessageAllowed("constructor", panelSender(), EXT), false);
  // Чужое расширение и посторонние origins.
  assert.equal(tvMessageAllowed("tv:sb-rest", { ...panelSender(), id: OTHER_EXT }, EXT), false);
  assert.equal(tvMessageAllowed("tv:open-intent", contentSender("https://evil.example/x"), EXT), false);
  assert.equal(tvMessageAllowed("tv:open-intent", contentSender("http://www.youtube.com/"), EXT), false);
  assert.equal(tvMessageAllowed("tv:open-intent", contentSender("https://youtube.com.evil.example/"), EXT), false);
  assert.equal(tvMessageAllowed("tv:open-intent", { id: EXT, url: YT_ORIGIN }, EXT), false, "нет tab id");
  assert.equal(
    tvMessageAllowed("tv:claim-intent", { id: EXT, url: `chrome-extension://${EXT}/popup.html`, tab: { id: 7 } }, EXT),
    false,
    "не panel.html"
  );
  assert.equal(
    tvMessageAllowed("tv:claim-intent", { id: EXT, url: `chrome-extension://${OTHER_EXT}/panel.html`, tab: { id: 7 } }, EXT),
    false,
    "panel.html чужого расширения"
  );
});

test("сохранена прежняя background sender validation", () => {
  assert.equal(tvSenderIsAllowed({ id: EXT }, EXT), true, "sender без url (popup)");
  assert.equal(tvSenderIsAllowed({ id: OTHER_EXT, url: YT_ORIGIN }, EXT), false);
  assert.equal(tvSenderIsAllowed({ url: "https://m.youtube.com/" }, EXT), true);
  assert.equal(tvSenderIsAllowed({ url: "https://www.pinterest.ru/" }, EXT), true);
  assert.equal(tvSenderIsAllowed({ url: "https://evil.example/" }, EXT), false);
  assert.equal(tvSenderIsAllowed({ url: "javascript:alert(1)" }, EXT), false);
  assert.equal(tvSenderIsAllowed({ url: "not a url" }, EXT), false);
});

// ------------------------------------------------- capability / replay

test("capability одноразовый и привязан к исходной вкладке", async () => {
  let now = 1000;
  const area = memoryArea();
  const store = tvCreateSessionIntentStore(area, {
    now: () => now,
    ttlMs: 30000,
    newNonce: nonceSequence(),
  });
  const nonce = await store.mint({ mode: "youtube" }, 7);
  await store.bind(nonce, 41);

  assert.deepEqual(await store.claim(nonce, 41), { mode: "youtube" });
  await assert.rejects(store.claim(nonce, 41), /Invalid capability/, "replay");
  assert.deepEqual(area.snapshot(), {});

  const second = await store.mint({ mode: "youtube" }, 7);
  await store.bind(second, 42);
  await assert.rejects(store.claim(second, 9), /Invalid capability/, "чужая вкладка");
  await assert.rejects(store.claim(second, 42), /Invalid capability/, "сгорел после неудачи");
});

test("capability переживает потерю памяти service worker", async () => {
  const area = memoryArea();
  const nonce = nonceSequence();
  const beforeRestart = tvCreateSessionIntentStore(area, { newNonce: nonce });
  const cap = await beforeRestart.mint({ mode: "pinterest", imageUrl: "public" }, 3);
  await beforeRestart.bind(cap, 17);

  const persisted = JSON.stringify(area.snapshot());
  assert.equal(/access_token|refresh_token|email|collection/i.test(persisted), false);

  // Новый экземпляр имитирует новый MV3 worker с пустой памятью.
  const afterRestart = tvCreateSessionIntentStore(area, { newNonce: nonce });
  assert.deepEqual(await afterRestart.claim(cap, 17), { mode: "pinterest", imageUrl: "public" });
});

test("ранний claim до bind не сжигает легитимный capability", async () => {
  const store = tvCreateSessionIntentStore(memoryArea(), { newNonce: nonceSequence() });
  const cap = await store.mint({ mode: "youtube" }, 7);
  await assert.rejects(store.claim(cap, 41), /Capability pending/);
  await store.bind(cap, 41);
  assert.deepEqual(await store.claim(cap, 41), { mode: "youtube" });
});

test("concurrent/replay claim возвращает intent максимум один раз", async () => {
  const area = memoryArea();
  const store = tvCreateSessionIntentStore(area, { newNonce: nonceSequence() });
  const cap = await store.mint({ mode: "channel" }, 5);
  await store.bind(cap, 19);

  const settled = await Promise.allSettled([store.claim(cap, 19), store.claim(cap, 19)]);
  assert.equal(settled.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(settled.filter((result) => result.status === "rejected").length, 1);
});

test("capability истекает и не подделывается", async () => {
  let now = 1000;
  const store = tvCreateSessionIntentStore(memoryArea(), {
    now: () => now,
    ttlMs: 30000,
    newNonce: nonceSequence(),
  });
  const nonce = await store.mint({ mode: "pinterest" }, 3);
  await store.bind(nonce, 18);
  now += 30001;
  await assert.rejects(store.claim(nonce, 18), /Invalid capability/, "TTL");

  const live = tvCreateSessionIntentStore(memoryArea(), { newNonce: nonceSequence() });
  await live.mint({ mode: "pinterest" }, 3);
  for (const forged of [undefined, null, 42, "", "short", "a".repeat(65), "not/valid+chars===", "__proto__"]) {
    await assert.rejects(live.claim(forged, 3), /Invalid capability/, String(forged));
  }
  await assert.rejects(live.mint({}, "7"), /Invalid intent source/, "tabId должен быть целым");
  await assert.rejects(live.mint({}, -1), /Invalid intent source/);
});

test("очередь capability ограничена", async () => {
  const store = tvCreateSessionIntentStore(memoryArea(), {
    maxPending: 3,
    newNonce: nonceSequence(),
  });
  for (let i = 0; i < 3; i++) await store.mint({ mode: "youtube" }, i);
  await assert.rejects(store.mint({ mode: "youtube" }, 9), /Too many pending intents/);
});

test("Enter и click используют одну action без двойного запуска", async () => {
  let calls = 0;
  let release;
  const action = tvCreateActionLock(async () => {
    calls++;
    await new Promise((resolve) => {
      release = resolve;
    });
  });
  const first = action();
  const second = await action();
  assert.equal(second, false);
  assert.equal(calls, 1);
  release();
  assert.equal(await first, true);

  const panel = read("panel.js");
  assert.equal(panel.includes("addBtn.click()"), false, "Enter не создаёт synthetic click");
  assert.match(panel, /tvOnTrusted\(add, action\)/);
  assert.match(panel, /void action\(\)/);
});

test("nonce случайный и в ожидаемом алфавите", () => {
  const seen = new Set();
  for (let i = 0; i < 200; i++) {
    const n = tvRandomNonce();
    assert.match(n, /^[A-Za-z0-9_-]{22,64}$/);
    seen.add(n);
  }
  assert.equal(seen.size, 200);
});

// --------------------------------------------------------- валидация intent

test("intent нормализуется и привязан к origin отправителя", () => {
  const yt = tvValidateIntent(YT_INTENT, YT_ORIGIN);
  assert.equal(yt.origin, "https://www.youtube.com");
  assert.equal(yt.videoId, "dQw4w9WgXcQ");

  const pin = tvValidateIntent(PIN_INTENT, PIN_ORIGIN);
  assert.equal(pin.origin, "https://ru.pinterest.com");
  assert.equal(pin.videoId, null);

  const ch = tvValidateIntent(CH_INTENT, "https://www.youtube.com/@example");
  assert.equal(ch.channelName, "Пример канала", "текст нормализуется");
  assert.equal(ch.channelAvatar, "https://yt3.ggpht.com/abc=s176");

  // Pinterest-страница не вправе просить YouTube-намерение и наоборот.
  assert.throws(() => tvValidateIntent(YT_INTENT, PIN_ORIGIN), /Invalid intent origin/);
  assert.throws(() => tvValidateIntent(PIN_INTENT, YT_ORIGIN), /Invalid intent origin/);
  assert.throws(() => tvValidateIntent(CH_INTENT, PIN_ORIGIN), /Invalid intent origin/);
  assert.throws(() => tvValidateIntent(YT_INTENT, "https://evil.example/"), /Invalid intent origin/);
  assert.throws(() => tvValidateIntent(YT_INTENT, "http://www.youtube.com/"), /Invalid intent origin/);
});

test("intent отклоняет произвольные destinations и мусор", () => {
  const bad = [
    [{ ...YT_INTENT, mode: "admin" }, /Invalid intent mode/],
    [{ ...YT_INTENT, mode: undefined }, /Invalid intent mode/],
    [{ ...YT_INTENT, videoId: "../../etc" }, /Invalid video id/],
    [{ ...YT_INTENT, videoId: "tooshort" }, /Invalid video id/],
    [{ ...YT_INTENT, imageUrl: "https://evil.example/x.jpg" }, /Invalid image URL/],
    [{ ...YT_INTENT, imageUrl: "http://i.ytimg.com/x.jpg" }, /Invalid image URL/],
    [{ ...YT_INTENT, imageUrl: "javascript:alert(1)" }, /Invalid image URL/],
    [{ ...YT_INTENT, imageUrl: "https://i.ytimg.com.evil.example/x.jpg" }, /Invalid image URL/],
    [{ ...YT_INTENT, sourceUrl: "https://evil.example/watch" }, /Invalid source URL/],
    [{ ...CH_INTENT, channelId: "UCshort" }, /Invalid channel id/],
    [{ ...CH_INTENT, channelId: "XC" + "a".repeat(22) }, /Invalid channel id/],
  ];
  for (const [raw, re] of bad) {
    assert.throws(() => tvValidateIntent(raw, raw.mode === "pinterest" ? PIN_ORIGIN : YT_ORIGIN), re, JSON.stringify(raw).slice(0, 90));
  }
  assert.throws(() => tvValidateIntent(null, YT_ORIGIN), /Invalid intent mode/);

  // Небезопасный avatar-хост просто отбрасывается, а не проносится в запись.
  const ch = tvValidateIntent({ ...CH_INTENT, channelAvatar: "https://evil.example/a.png" }, YT_ORIGIN);
  assert.equal(ch.channelAvatar, "");
});

test("intent содержит только публичные поля host-страницы", () => {
  const keys = Object.keys(tvValidateIntent(YT_INTENT, YT_ORIGIN)).sort();
  assert.deepEqual(keys, ["imageUrl", "mode", "origin", "sourceUrl", "videoId"]);
  // Приписанные атакующим поля не переживают нормализацию.
  const injected = tvValidateIntent({ ...YT_INTENT, collectionIds: ["x"], access_token: "t" }, YT_ORIGIN);
  assert.equal("collectionIds" in injected, false);
  assert.equal("access_token" in injected, false);
});

// ---------------------------------------------------------------- EXT-002

test("EXT-002: panel сообщает host page только безопасную команду закрытия", () => {
  const panel = read("panel.js");
  const closeMessage = panel.match(/window\.parent\.postMessage\(([^;]+)\);/)?.[1] || "";
  assert.match(closeMessage, /tv:panel-close/);
  assert.doesNotMatch(closeMessage, /intent|session|token|folder|email/i);
  const modal = read("modal.js");
  assert.match(modal, /event\.source === tvPanelFrame\.contentWindow/);
  assert.match(modal, /event\.origin === tvPanelOrigin/);
});

test("EXT-002: content scripts не делают authenticated-запросов и не рендерят приватное", () => {
  for (const name of ["content.js", "content-channel.js", "content-pinterest.js", "modal.js"]) {
    const src = read(name);
    assert.equal(/\bAPI\./.test(src), false, `${name}: обращение к API`);
    assert.equal(/\bSB\./.test(src), false, `${name}: обращение к Supabase-прокси`);
    assert.equal(/tv:sb-/.test(src), false, `${name}: authenticated route`);
    for (const word of ["collection", "folder", "папк", "membership", "email"]) {
      assert.equal(src.toLowerCase().includes(word), false, `${name}: упоминание «${word}»`);
    }
  }
});

test("EXT-002: приватный UI объявлен только на extension origin", () => {
  const manifest = JSON.parse(read("manifest.json"));
  const contentJs = manifest.content_scripts.flatMap((entry) => entry.js);
  for (const forbidden of ["api.js", "supabase.js", "config.js", "panel.js"]) {
    assert.equal(contentJs.includes(forbidden), false, `${forbidden} не должен грузиться в host page`);
  }
  assert.deepEqual([...new Set(contentJs)].sort(), ["content-channel.js", "content-pinterest.js", "content.js", "i18n.js", "intent.js", "modal.js"]);

  const panelHtml = read("panel.html");
  for (const needed of ["intent.js", "i18n.js", "supabase.js", "api.js", "panel.js", "panel.css"]) {
    assert.ok(panelHtml.includes(needed), `panel.html грузит ${needed}`);
  }

  const war = manifest.web_accessible_resources.flatMap((entry) => entry.resources);
  assert.equal(war.includes("panel.html"), true, "panel.html доступен только как extension-origin iframe");
  assert.match(read("modal.js"), /attachShadow\(\{ mode: "closed" \}\)/, "presentation shell скрыт в closed shadow root");
  assert.match(read("modal.js"), /createElement\("dialog"\)/, "privileged panel использует browser top layer");
  assert.match(read("modal.js"), /dialog\.showModal\(\)/, "host stacking context не управляет панелью");
  assert.match(read("modal.js"), /createElement\("iframe"\)/, "panel встроена в текущую вкладку");
  assert.doesNotMatch(read("background.js"), /chrome\.tabs\.create|chrome\.windows\.create/, "save/follow не открывает вкладку или окно");
});

test("дизайн-контракт: icon-only триггеры без ложного lifecycle и реальные состояния панели", () => {
  const css = read("content.css");
  const modal = read("modal.js");
  const background = read("background.js");
  const panelHtml = read("panel.html");
  const panelJs = read("panel.js");
  const pinterest = read("content-pinterest.js");
  const channel = read("content-channel.js");

  assert.match(css, /--tv-accent:\s*#2f6fed/);
  assert.equal(/#ff6a2c|#e0853f/i.test(css), false, "старый оранжевый акцент удалён");
  assert.doesNotMatch(css, /data-tv-state="(?:loading|done)"/);
  assert.doesNotMatch(css, /ytd-moving-thumbnail-renderer\s*\{[^}]*display:\s*none/s,
    "YouTube moving thumbnail preview remains available");
  assert.match(channel, /document\.elementsFromPoint/,
    "YouTube trigger tracks the card below a global moving-preview layer");
  assert.match(channel, /document\.body\.appendChild\(tvTileButton\)/,
    "YouTube trigger is portaled above the moving-preview stacking context");
  assert.match(pinterest, /\["IMG", "VIDEO"\]/,
    "Pinterest supports both images and video posters");
  assert.match(pinterest, /addEventListener\("pointermove"/,
    "Pinterest follows the current media under the pointer");
  assert.match(pinterest, /isMainDetailMedia/,
    "Pinterest placement distinguishes the main closeup from recommendations");
  assert.match(pinterest, /data-test-id=\\?"pinWrapper/,
    "Pinterest resolves deep native overlays through the stable pin-card boundary");
  assert.match(pinterest, /PIN_MIN_HEIGHT = 90/,
    "Pinterest accepts short landscape recommendation thumbnails");
  assert.match(modal, /class="tv-mark"/);
  assert.match(background, /sendResponse\(\{ ok: true, nonce \}\)/);
  assert.doesNotMatch(background, /chrome\.tabs\.create|chrome\.windows\.create/);
  assert.doesNotMatch(background, /chrome\.windows\.create\(/);
  assert.match(modal, /attachShadow\(\{ mode: "closed" \}\)/);
  assert.match(modal, /createElement\("dialog"\)/);
  assert.match(modal, /dialog\.showModal\(\)/);
  assert.match(modal, /createElement\("iframe"\)/);
  assert.match(modal, /tv-panel-host/);
  assert.match(modal, /backdrop-filter: blur\(12px\)/);
  assert.match(modal, /TVI18N\.t\("stalePage"\)/);
  assert.match(panelHtml, /id="tv-note-input"/);
  assert.match(panelHtml, /id="tv-confirm-delete"/);
  assert.match(panelHtml, /id="tv-finish"/);
  assert.doesNotMatch(panelHtml, /id="tv-lang-button"/, "save-overlay не содержит переключатель языка");
  assert.match(read("panel.css"), /color-scheme:\s*normal/);
  assert.match(panelJs, /API\.saveThumbnail\(\{[^}]*note \}\)/s);
  assert.match(panelJs, /API\.deleteThumbnail\(existing\.id\)/);
  // Теги по-прежнему сохраняются панелью, но уже не отдельной цепочкой: папки и
  // теги уходят одним атомарным вызовом (junction-rpc.test.mjs).
  assert.match(panelJs, /API\.replaceThumbnailLinks\(saved\.id, \{/);
  assert.match(panelJs, /tagIds: tvSame\(selectedTags, originalTags\)/);
  assert.match(panelHtml, /id="tv-tab-tags"/);
  assert.match(panelHtml, /id="tv-note-count"/);
  assert.equal(panelJs.includes("ids.length === 0"), false, "пустой набор папок больше не означает удаление");
  // PUB-02 заменил `existing && note === originalNote` на узкое обновление той
  // же строки: заметка правится по её id, а неизменённая (в т.ч. legacy >1000)
  // не попадает в запись вообще. Поведенческая проверка — pub02-note-update.test.mjs.
  assert.match(panelJs, /else if \(note !== originalNote\)/,
    "неизменённая legacy-заметка не переписывается и не обрезается");
  assert.match(panelJs, /await API\.updateThumbnailNote\(saved\.id, note\)/,
    "изменённая заметка правит ту же строку, а не создаёт вторую");
  assert.match(panelJs, /note\.length > NOTE_MAX && \(!existing \|\| note !== originalNote\)/,
    "изменённая oversized legacy-заметка требует явного сокращения");
  assert.match(panelJs, /await API\.snapshotStats\(intent\.videoId\)/,
    "snapshot завершается до закрытия панели");
  assert.doesNotMatch(read("api.js"), /note:\s*tvCleanNote\(row\.note\)/,
    "legacy-заметка не обрезается на read boundary");
  assert.match(read("api.js"), /note:\s*tvReadNote\(row\.note\)/);
  assert.match(panelJs, /save\.dataset\.i18n = "follow"/,
    "смена языка сохраняет channel-specific CTA");
  assert.match(panelJs, /\$\("tv-cancel"\)\.dataset\.i18n = "close"/,
    "смена языка сохраняет terminal Close");
  assert.match(panelJs, /delete \$\("tv-collections"\)\.dataset\.i18n/,
    "динамический список не затирается loading-переводом");
  assert.match(panelJs, /tvLanguageRerender = \(\) =>/,
    "динамические списки перерисовываются после смены языка");
  assert.match(panelJs, /create\.textContent = `\+ \$\{tvT\(createKey\)\}/,
    "create-choice использует текущий язык");
  assert.match(panelJs, /channelNote\.dataset\.i18n = "youtubeChannel"/,
    "fallback канала сохраняет i18n-state");
  // PUB-06 убрал предварительный getSession и ограничил весь шаг одним сроком;
  // поведенческое доказательство бюджета — pub06-snapshot-budget.test.mjs.
  assert.match(read("api.js"), /async snapshotStats\(videoId\)[\s\S]*?catch \(e\) \{[\s\S]*?return false;/,
    "best-effort snapshot не превращает свою ошибку в отказ сохранения");
});

// ------------------------------------------------------- манифест-инварианты

test("манифест не расширяет привилегии", () => {
  const manifest = JSON.parse(read("manifest.json"));
  assert.deepEqual(manifest.permissions, ["storage", "identity"]);
  assert.deepEqual(manifest.host_permissions, ["https://tclesjdhmzouzbrdtovm.supabase.co/*"]);
  assert.equal("optional_permissions" in manifest, false);
  assert.equal("externally_connectable" in manifest, false, "страница не должна уметь звонить в background");

  const csp = manifest.content_security_policy.extension_pages;
  assert.match(csp, /script-src 'self'/);
  assert.match(csp, /object-src 'none'/);
  assert.match(csp, /connect-src 'self' https:\/\/tclesjdhmzouzbrdtovm\.supabase\.co;/);
  assert.equal(/connect-src[^;]*\*/.test(csp), false, "никаких произвольных сетевых назначений");
  // Превью обложек — единственная причина расширения img-src.
  assert.match(csp, /img-src 'self' data: https:\/\/i\.ytimg\.com https:\/\/i\.pinimg\.com;/);

  const war = manifest.web_accessible_resources;
  assert.equal(war.length, 1);
  assert.deepEqual(war[0].resources.sort(), ["icons/*", "panel.html"]);
  assert.deepEqual(war[0].matches.sort(), ["*://*.pinterest.com/*", "*://*.pinterest.ru/*", "*://*.youtube.com/*"]);
  const contentMatches = manifest.content_scripts.flatMap((e) => e.matches).sort();
  assert.deepEqual(war[0].matches.sort(), [...new Set(contentMatches)].sort(), "WAR не шире content scripts");
});

test("политика сообщений покрывает ровно обрабатываемые типы", () => {
  const background = read("background.js");
  const handled = [...background.matchAll(/msg\.type === "([^"]+)"/g)].map((m) => m[1]).sort();
  assert.deepEqual(handled, Object.keys(TV_MESSAGE_POLICY).sort());
  // Каждое сообщение проходит через политику до любой работы. Четвёртый
  // аргумент — собственная база адреса расширения (`runtime.getURL("/")`),
  // без неё Firefox-страницы не отличить от чужих: см.
  // security/receipts/CLAUDE-EXT-FIREFOX-IMPLEMENTATION-01.md.
  assert.match(background, /if \(!tvMessageAllowed\(msg\?\.type, sender, chrome\.runtime\.id, TV_SELF_BASE\)\)/);
  assert.match(background, /const TV_SELF_BASE = tvSelfBaseUrl\(\);/);
  assert.ok(
    background.indexOf("tvMessageAllowed") < background.indexOf('msg.type === "tv:ping"'),
    "проверка отправителя предшествует обработке"
  );
});

test("в ответах content script нет токенов", () => {
  for (const name of ["content.js", "content-channel.js", "content-pinterest.js", "modal.js", "intent.js"]) {
    const src = read(name);
    for (const secret of ["access_token", "refresh_token", "SUPABASE_ANON_KEY", "service_role", "apikey", "Authorization"]) {
      assert.equal(src.includes(secret), false, `${name}: ${secret}`);
    }
  }
});

// node --test: определение сохраняемого YouTube-канала в `content-channel.js`.
//
// Три случая из `security/receipts/CODEX-EXT-CHANNEL-IDENTITY-TRIAGE-01.md`
// воспроизводятся здесь как регрессии, плюс современные заголовки, задержка
// метаданных, SPA-переход и противоречивые данные. Инвариант один:
//
//   id, имя и аватар описывают ОДИН канал — тот, на который указывает текущий
//   URL, — либо не возвращается ничего и запись не происходит.
//
// Слово «YouTube» само по себе не запрещено: запрещён источник, который его
// подставляет вместо имени канала.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

const SOURCE = await readFile(new URL("../content-channel.js", import.meta.url), "utf8");

// Тест исполняет только блок определения канала: ниже начинается DOM-обвязка
// (кнопки, MutationObserver, таймеры), которой в vm нет. Маркер пришпилен —
// перенос кода за него уронит эти тесты, а не тихо выключит их.
const MARKER = "\nfunction tvMakeFollowButton(";
const IDENTITY_SOURCE = SOURCE.slice(0, SOURCE.indexOf(MARKER));

test("блок определения канала отделён ровно одним маркером", () => {
  assert.equal(SOURCE.split(MARKER).length - 1, 1);
  assert.match(IDENTITY_SOURCE, /function tvWaitForChannelInfo\(/);
});

// --------------------------------------------------------------- мини-DOM
// Ровно те формы селекторов, которыми пользуется продуктовый код: список через
// запятую, потомок через пробел, tag/#id/.class/[attr="v"]/[attr*="v"].

function compound(part) {
  const bare = part.replace(/\[[^\]]*\]/g, "");
  return {
    tag: bare.match(/^[\w-]+/)?.[0]?.toLowerCase() || "",
    id: bare.match(/#([\w-]+)/)?.[1] || "",
    classes: [...bare.matchAll(/\.([\w-]+)/g)].map((match) => match[1]),
    attrs: [...part.matchAll(/\[([\w-]+)(\*?=)"([^"]*)"\]/g)].map((match) => ({
      name: match[1],
      op: match[2],
      value: match[3],
    })),
  };
}

function matchesCompound(node, selector) {
  if (selector.tag && node.tag !== selector.tag) return false;
  if (selector.id && node.attrs.id !== selector.id) return false;
  const classes = String(node.attrs.class || "").split(/\s+/);
  if (!selector.classes.every((name) => classes.includes(name))) return false;
  return selector.attrs.every(({ name, op, value }) => {
    const actual = node.attrs[name];
    if (actual == null) return false;
    return op === "=" ? String(actual) === value : String(actual).includes(value);
  });
}

function matches(node, selector) {
  return selector.split(",").some((one) => {
    const parts = one.trim().split(/\s+/).map(compound);
    if (!matchesCompound(node, parts[parts.length - 1])) return false;
    let remaining = parts.slice(0, -1);
    let current = node.parent;
    while (remaining.length && current) {
      if (matchesCompound(current, remaining[remaining.length - 1])) remaining = remaining.slice(0, -1);
      current = current.parent;
    }
    return remaining.length === 0;
  });
}

class El {
  constructor(tag, attrs = {}, children = []) {
    this.tag = tag.toLowerCase();
    this.attrs = attrs;
    this.children = [];
    this.parent = null;
    for (const child of children) this.append(child);
  }

  append(child) {
    if (typeof child === "string") this.children.push(child);
    else {
      child.parent = this;
      this.children.push(child);
    }
    return this;
  }

  get parentElement() { return this.parent; }
  get href() { return this.attrs.href; }
  get content() { return this.attrs.content; }
  get src() { return this.attrs.src; }

  get textContent() {
    return this.children.map((child) => (typeof child === "string" ? child : child.textContent)).join("");
  }

  *walk() {
    for (const child of this.children) {
      if (typeof child === "string") continue;
      yield child;
      yield* child.walk();
    }
  }

  querySelector(selector) {
    for (const node of this.walk()) if (matches(node, selector)) return node;
    return null;
  }

  closest(selector) {
    let node = this;
    while (node) {
      if (matches(node, selector)) return node;
      node = node.parent;
    }
    return null;
  }
}

const el = (tag, attrs = {}, children = []) => new El(tag, attrs, children);

// --------------------------------------------------------------- фикстуры

const ID_A = `UC${"a".repeat(22)}`;
const ID_B = `UC${"b".repeat(22)}`;
const AVATAR_A = `https://yt3.ggpht.com/${ID_A}=s900`;
const AVATAR_B = `https://yt3.ggpht.com/${ID_B}=s900`;

// `responseContext.externalId` идёт ПЕРВЫМ намеренно: прежний парсер брал первый
// попавшийся externalId. `siblings` кладутся ПОСЛЕ renderer'а в том же объекте —
// так проверяется, что разбор заканчивается на закрывающей скобке записи.
function initialData({ renderer, siblings = {}, escapeSlashes = false }) {
  const json = JSON.stringify({
    responseContext: { externalId: ID_B },
    metadata: { channelMetadataRenderer: renderer, ...siblings },
  });
  return `window.ytInitialData = ${escapeSlashes ? json.replace(/\//g, "\\/") : json};`;
}

// Запись настоящей формы: так YouTube и описывает канал.
function renderer({ id, title, path, avatar = AVATAR_A, description = "Описание канала" }) {
  return {
    title,
    description,
    rssUrl: `https://www.youtube.com/feeds/videos.xml?channel_id=${id}`,
    externalId: id,
    ownerUrls: [`http://www.youtube.com${path}`],
    avatar: { thumbnails: [{ url: avatar, width: 900, height: 900 }] },
    isFamilySafe: true,
    vanityChannelUrl: `http://www.youtube.com${path}`,
  };
}

const metadataScript = ({ escapeSlashes = false, ...fields }) =>
  initialData({ renderer: renderer(fields), escapeSlashes });

const modernHeader = (name, avatar = "") =>
  el("yt-page-header-renderer", {}, [
    el("div", { id: "avatar" }, [el("img", { src: avatar || AVATAR_A })]),
    el("h1", {}, [name]),
  ]);

// Чужая карточка видео с собственным каналом — постоянный житель страницы канала.
const foreignCard = () =>
  el("ytd-rich-item-renderer", {}, [
    el("div", { id: "avatar" }, [el("img", { src: AVATAR_B })]),
    el("ytd-channel-name", {}, [el("span", { id: "text" }, ["Другой канал"])]),
    el("a", { href: `/channel/${ID_B}` }, ["Другой канал"]),
  ]);

function load({ href, head = [], body = [], scripts = [], fetch }) {
  const root = el("html", {}, [el("head", {}, head), el("body", {}, body)]);
  const document = {
    scripts: scripts.map((text) => ({ textContent: text })),
    querySelector: (selector) => root.querySelector(selector),
  };
  const context = vm.createContext({
    document,
    location: new URL(href),
    URL,
    setTimeout,
    clearTimeout,
    console,
    fetch,
    AbortController,
    TextDecoder,
  });
  vm.runInContext(IDENTITY_SOURCE, context);
  return { context, document, root };
}

// Объект приходит из другого realm — копия делает его сравнимым по структуре.
const plain = (value) => (value ? { ...value } : value);
const info = (fixture) => plain(load(fixture).context.tvGetChannelInfo());

// ------------------------------------------------- случай 1: generic og:title

test("generic og:title=YouTube не перекрывает имя канала", () => {
  assert.deepEqual(
    info({
      href: "https://www.youtube.com/@wanted",
      // Голова свежая и подтверждает маршрут — и всё равно og:title не имя канала.
      head: [
        el("meta", { property: "og:title", content: "YouTube" }),
        el("meta", { property: "og:url", content: "https://www.youtube.com/@wanted" }),
        el("link", { rel: "canonical", href: "https://www.youtube.com/@wanted" }),
        el("meta", { property: "og:image", content: AVATAR_B }),
      ],
      body: [modernHeader("Wanted Channel"), foreignCard()],
      scripts: [metadataScript({ id: ID_A, title: "Wanted Channel", path: "/@wanted" })],
    }),
    { channel_id: ID_A, name: "Wanted Channel", avatar: AVATAR_A }
  );
});

test("настоящий канал с именем YouTube сохраняется как YouTube", () => {
  assert.deepEqual(
    info({
      href: "https://www.youtube.com/@youtube",
      head: [
        el("meta", { property: "og:title", content: "YouTube" }),
        el("link", { rel: "canonical", href: "https://www.youtube.com/@youtube" }),
      ],
      body: [modernHeader("YouTube")],
      scripts: [metadataScript({ id: ID_A, title: "YouTube", path: "/@youtube" })],
    }),
    { channel_id: ID_A, name: "YouTube", avatar: AVATAR_A }
  );
});

// -------------------------------------------- случай 2: посторонняя ссылка/id

test("посторонняя channel-ссылка карточки не становится identity", () => {
  assert.deepEqual(
    info({
      href: "https://www.youtube.com/@wanted",
      body: [modernHeader("Wanted Channel"), foreignCard()],
      scripts: [metadataScript({ id: ID_A, title: "Wanted Channel", path: "/@wanted" })],
    }),
    { channel_id: ID_A, name: "Wanted Channel", avatar: AVATAR_A }
  );
});

test("первый externalId в блобе не считается идентичностью страницы", () => {
  // Единственный externalId на странице — чужой, вне channelMetadataRenderer.
  assert.equal(
    info({
      href: "https://www.youtube.com/@wanted",
      body: [modernHeader("Wanted Channel")],
      scripts: [`window.ytInitialData = {"responseContext":{"externalId":"${ID_B}"}};`],
    }),
    null
  );
});

// ------------------------------------------------ случай 3: устаревшие данные

test("старые SPA-метаданные не выдаются за текущий канал", () => {
  assert.deepEqual(
    info({
      href: "https://www.youtube.com/@wanted",
      head: [
        el("link", { rel: "canonical", href: `https://www.youtube.com/channel/${ID_B}` }),
        el("meta", { property: "og:url", content: `https://www.youtube.com/channel/${ID_B}` }),
        el("meta", { property: "og:title", content: "Previous Channel" }),
        el("meta", { property: "og:image", content: AVATAR_B }),
      ],
      body: [modernHeader("Wanted Channel")],
      scripts: [metadataScript({ id: ID_A, title: "Wanted Channel", path: "/@wanted" })],
    }),
    { channel_id: ID_A, name: "Wanted Channel", avatar: AVATAR_A }
  );
});

test("устаревшая голова без подтверждения текущего канала — отказ, а не догадка", () => {
  assert.equal(
    info({
      href: "https://www.youtube.com/@wanted",
      head: [
        el("link", { rel: "canonical", href: `https://www.youtube.com/channel/${ID_B}` }),
        el("meta", { property: "og:title", content: "Previous Channel" }),
      ],
      body: [modernHeader("Wanted Channel")],
      scripts: [metadataScript({ id: ID_B, title: "Previous Channel", path: `/channel/${ID_B}` })],
    }),
    null
  );
});

// ------------------------- CODEX-EXT-CHANNEL-IDENTITY-REVIEW-01: R1 и R2
// Четыре примера ревью. Все четыре воспроизводили неверную identity на
// проверенном парсере (`4318863c…`) и обязаны давать отказ здесь.

const PREVIOUS = { id: ID_B, title: "Previous Channel", path: "/@previous", avatar: AVATAR_B };

test("R1-A: ссылка из description не подтверждает принадлежность канала", () => {
  assert.equal(
    info({
      href: "https://www.youtube.com/@wanted",
      body: [modernHeader("Wanted Channel")],
      scripts: [
        initialData({ renderer: renderer({ ...PREVIOUS, description: "See https://www.youtube.com/@wanted" }) }),
      ],
    }),
    null
  );
});

test("R1-B: соседний объект после renderer не подтверждает принадлежность канала", () => {
  assert.equal(
    info({
      href: "https://www.youtube.com/@wanted",
      body: [modernHeader("Wanted Channel")],
      scripts: [
        initialData({
          renderer: renderer(PREVIOUS),
          siblings: { recommendation: { url: "https://www.youtube.com/@wanted" } },
        }),
      ],
    }),
    null
  );
});

test("R2-1: свежий id маршрута не склеивается со старым заголовком", async () => {
  // Переход начался ДО клика: location уже A, а страница целиком ещё про B.
  const { context, document } = load({
    href: `https://www.youtube.com/channel/${ID_A}`,
    body: [modernHeader("Previous Channel", AVATAR_B)],
    scripts: [initialData({ renderer: renderer(PREVIOUS) })],
  });
  assert.equal(context.tvGetChannelInfo(), null);
  assert.equal(await context.tvWaitForChannelInfo(300), null);

  // Согласованные данные приходят — и только тогда появляется identity.
  document.scripts.push({
    textContent: metadataScript({ id: ID_A, title: "Wanted Channel", path: `/channel/${ID_A}` }),
  });
  assert.deepEqual(plain(await context.tvWaitForChannelInfo(2000)), {
    channel_id: ID_A,
    name: "Wanted Channel",
    avatar: AVATAR_A,
  });
});

test("R2-2: generic голова одна identity не завершает, пока нет заголовка канала", async () => {
  // Голова свежая и частично заполненная; заголовок и скрипты ещё не пришли.
  const { context, document } = load({
    href: "https://www.youtube.com/@wanted",
    head: [
      el("link", { rel: "canonical", href: "https://www.youtube.com/@wanted" }),
      el("meta", { property: "og:url", content: "https://www.youtube.com/@wanted" }),
      el("meta", { itemprop: "channelId", content: ID_A }),
      el("meta", { property: "og:title", content: "YouTube" }),
    ],
  });
  assert.equal(context.tvGetChannelInfo(), null);
  assert.equal(await context.tvWaitForChannelInfo(300), null);

  document.scripts.push({
    textContent: metadataScript({ id: ID_A, title: "Wanted Channel", path: "/@wanted" }),
  });
  assert.equal(plain(await context.tvWaitForChannelInfo(2000))?.name, "Wanted Channel");
});

// ------------------------------------------------------------ прочие границы

test("маршрут /channel/UC… резолвится своей записью метаданных", () => {
  assert.deepEqual(
    info({
      href: `https://www.youtube.com/channel/${ID_A}/videos`,
      body: [modernHeader("Wanted Channel"), foreignCard()],
      scripts: [metadataScript({ id: ID_A, title: "Wanted Channel", path: `/channel/${ID_A}` })],
    }),
    { channel_id: ID_A, name: "Wanted Channel", avatar: AVATAR_A }
  );
});

test("противоречивые подтверждённые id — отказ без записи", () => {
  assert.equal(
    info({
      href: `https://www.youtube.com/channel/${ID_A}`,
      // Без противоречия эта же страница разрешилась бы: запись A подтверждена.
      head: [
        el("link", { rel: "canonical", href: `https://www.youtube.com/channel/${ID_A}` }),
        el("meta", { itemprop: "channelId", content: ID_B }),
      ],
      body: [modernHeader("Wanted Channel")],
      scripts: [metadataScript({ id: ID_A, title: "Wanted Channel", path: `/channel/${ID_A}` })],
    }),
    null
  );
});

test("две записи метаданных на один маршрут — отказ без записи", () => {
  assert.equal(
    info({
      href: "https://www.youtube.com/@wanted",
      body: [modernHeader("Wanted Channel")],
      scripts: [
        metadataScript({ id: ID_A, title: "Wanted Channel", path: "/@wanted" }),
        metadataScript({ id: ID_B, title: "Previous Channel", path: "/@wanted", avatar: AVATAR_B }),
      ],
    }),
    null
  );
});

test("голова с rss channel_id даёт id, но одна identity не завершает", () => {
  const head = [
    el("link", { rel: "canonical", href: "https://www.youtube.com/@wanted" }),
    el("link", {
      rel: "alternate",
      type: "application/rss+xml",
      href: `https://www.youtube.com/feeds/videos.xml?channel_id=${ID_A}`,
    }),
    el("meta", { property: "og:image", content: AVATAR_A }),
  ];
  const page = { href: "https://www.youtube.com/@wanted", head, body: [modernHeader("Wanted Channel", AVATAR_A)] };
  assert.equal(info(page), null);
  // Тот же id из головы противоречит записи о другом канале — тоже отказ.
  assert.equal(
    info({ ...page, scripts: [metadataScript({ id: ID_B, title: "Previous Channel", path: "/@wanted" })] }),
    null
  );
});

test("экранированные слэши и \\u-последовательности в метаданных читаются", () => {
  const escaped = metadataScript({ id: ID_A, title: "", path: "/@wanted", escapeSlashes: true })
    .replace('"title":""', '"title":"\\u041a\\u0430\\u043d\\u0430\\u043b"');
  assert.deepEqual(info({
    href: "https://www.youtube.com/@wanted",
    body: [modernHeader("Заголовок страницы")],
    scripts: [escaped],
  }), { channel_id: ID_A, name: "Канал", avatar: AVATAR_A });
});

test("похожий хост внутри блоба не подтверждает маршрут", () => {
  const forged = metadataScript({ id: ID_A, title: "Wanted Channel", path: "/@wanted" })
    .split("www.youtube.com").join("www.youtube.com.evil.test");
  assert.equal(
    info({ href: "https://www.youtube.com/@wanted", body: [modernHeader("Wanted Channel")], scripts: [forged] }),
    null
  );
});

test("legacy-маршруты /c/ и /user/ подтверждаются своими URL", () => {
  for (const path of ["/c/Wanted", "/user/wanted"]) {
    assert.equal(
      info({
        href: `https://www.youtube.com${path}`,
        body: [modernHeader("Wanted Channel")],
        scripts: [metadataScript({ id: ID_A, title: "Wanted Channel", path })],
      })?.channel_id,
      ID_A,
      path
    );
  }
});

test("страница вне канала не даёт identity", () => {
  assert.equal(
    info({
      href: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
      head: [el("link", { rel: "canonical", href: `https://www.youtube.com/channel/${ID_A}` })],
      body: [modernHeader("Wanted Channel")],
      scripts: [metadataScript({ id: ID_A, title: "Wanted Channel", path: `/channel/${ID_A}` })],
    }),
    null
  );
});

test("запись без заголовка канала identity не завершает", () => {
  assert.equal(
    info({
      href: `https://www.youtube.com/channel/${ID_A}`,
      body: [modernHeader("Wanted Channel")],
      scripts: [metadataScript({ id: ID_A, title: "", path: `/channel/${ID_A}` })],
    }),
    null
  );
});

test("незакрытый объект метаданных отбрасывается, а не додумывается", () => {
  const truncated = metadataScript({ id: ID_A, title: "Wanted Channel", path: "/@wanted" }).slice(0, -30);
  assert.equal(info({ href: "https://www.youtube.com/@wanted", body: [modernHeader("Wanted Channel")], scripts: [truncated] }), null);
});

// ---------------------------------------------------- задержка и SPA-переходы

test("задержавшиеся метаданные дожидаются, а не подменяются догадкой", async () => {
  const { context, document } = load({
    href: "https://www.youtube.com/@wanted",
    body: [modernHeader("Wanted Channel"), foreignCard()],
  });
  assert.equal(context.tvGetChannelInfo(), null);
  const timer = setTimeout(() => {
    document.scripts.push({ textContent: metadataScript({ id: ID_A, title: "Wanted Channel", path: "/@wanted" }) });
  }, 250);
  try {
    assert.deepEqual(plain(await context.tvWaitForChannelInfo(3000)), {
      channel_id: ID_A,
      name: "Wanted Channel",
      avatar: AVATAR_A,
    });
  } finally {
    clearTimeout(timer);
  }
});

test("SPA-переход во время ожидания отменяет результат прошлой страницы", async () => {
  const { context } = load({
    href: "https://www.youtube.com/@wanted",
    body: [modernHeader("Wanted Channel")],
  });
  const startedAt = Date.now();
  const timer = setTimeout(() => {
    context.location = new URL("https://www.youtube.com/@other");
  }, 150);
  try {
    assert.equal(await context.tvWaitForChannelInfo(5000), null);
    assert.ok(Date.now() - startedAt < 2000, "ожидание должно оборваться на смене маршрута");
  } finally {
    clearTimeout(timer);
  }
});

test("ожидание на неразрешимой странице заканчивается отказом, а не догадкой", async () => {
  const { context } = load({
    href: "https://www.youtube.com/@wanted",
    head: [el("link", { rel: "canonical", href: `https://www.youtube.com/channel/${ID_B}` })],
    body: [modernHeader("Wanted Channel"), foreignCard()],
  });
  assert.equal(await context.tvWaitForChannelInfo(300), null);
});

// ------------------------------------ свежий источник для перехода внутри сайта
//
// После перехода без перезагрузки YouTube не переписывает документ: ytInitialData,
// og:* и микроразметка продолжают описывать предыдущий канал, а свежими остаются
// только location, canonical, заголовок вкладки и отрисованная шапка — ни одно из
// них не называет id вместе с именем. Наблюдение живое, см. §13 receipt'а.
// Поэтому по явному клику запрашивается HTML текущего маршрута и читается как
// текст. Правила те же: свидетелем остаётся только собственный адрес записи,
// identity завершает только запись с id и заголовком одного канала.

function fetchedPage(...scriptTexts) {
  const scripts = scriptTexts.map((text) => `<script nonce="x">${text}</script>`).join("");
  return `<!doctype html><html><head><title>Channel</title></head><body>${scripts}</body></html>`;
}

// Ответ читается ровно так же, как настоящий: статус, заголовки, поток, отмена.
function response({
  url = "https://www.youtube.com/@wanted",
  status = 200,
  contentType = "text/html; charset=utf-8",
  body = "",
  chunks = 1,
} = {}) {
  const bytes = new TextEncoder().encode(body);
  const step = Math.max(1, Math.ceil(bytes.length / chunks));
  const state = { cancelled: false, reads: 0, onRead: null };
  let sent = 0;
  return {
    state,
    ok: status >= 200 && status < 300,
    status,
    url,
    headers: { get: (name) => (String(name).toLowerCase() === "content-type" ? contentType : null) },
    body: {
      async cancel() {
        state.cancelled = true;
      },
      getReader: () => ({
        async read() {
          state.reads += 1;
          if (state.onRead) await state.onRead(state.reads);
          if (sent >= bytes.length) return { done: true, value: undefined };
          const value = bytes.slice(sent, sent + step);
          sent += step;
          return { done: false, value };
        },
        async cancel() {
          state.cancelled = true;
        },
      }),
    },
  };
}

function stubFetch(answer) {
  const calls = [];
  const fetch = (url, init) => {
    calls.push({ url, init });
    const made = typeof answer === "function" ? answer(url, init, calls.length) : answer;
    return made instanceof Error ? Promise.reject(made) : Promise.resolve(made);
  };
  fetch.calls = calls;
  return fetch;
}

const wantedRecord = () => metadataScript({ id: ID_A, title: "Wanted Channel", path: "/@wanted" });

// Документ после перехода: запись и og:* от прошлого канала, свежий только
// canonical — ровно та форма, что наблюдалась на живом YouTube.
const staleAfterHop = (extra = {}) => ({
  href: "https://www.youtube.com/@wanted/videos?view=0",
  head: [
    el("link", { rel: "canonical", href: "https://www.youtube.com/@wanted" }),
    el("meta", { property: "og:url", content: `https://www.youtube.com/channel/${ID_B}` }),
    el("meta", { property: "og:title", content: "Previous Channel" }),
    el("meta", { property: "og:image", content: AVATAR_B }),
  ],
  body: [modernHeader("Wanted Channel"), foreignCard()],
  scripts: [metadataScript({ id: ID_B, title: "Previous Channel", path: "/@previous", avatar: AVATAR_B })],
  ...extra,
});

test("переход канал→канал: устаревший документ, свежий ответ — текущий канал", async () => {
  const fetch = stubFetch(response({
    url: "https://www.youtube.com/@wanted/videos",
    body: fetchedPage(wantedRecord()),
  }));
  const { context } = load(staleAfterHop({ fetch }));

  assert.equal(context.tvGetChannelInfo(), null, "один документ ответить не может");
  assert.deepEqual(plain(await context.tvWaitForChannelInfo(2000)), {
    channel_id: ID_A,
    name: "Wanted Channel",
    avatar: AVATAR_A,
  });

  assert.equal(fetch.calls.length, 1, "ровно один запрос");
  // Запрашивается собственный путь маршрута: без query, без фрагмента.
  assert.equal(fetch.calls[0].url, "https://www.youtube.com/@wanted/videos");
  assert.equal(fetch.calls[0].init.credentials, "same-origin");
  // Куда запросу можно уйти, сказано ДО отправки: credentials — про то, что
  // отправляется, а не про адрес. Редирект обязан быть ошибкой, а не вторым
  // запросом, иначе запрещённый адрес запрашивается и лишь потом отвергается.
  assert.equal(fetch.calls[0].init.mode, "same-origin");
  assert.equal(fetch.calls[0].init.redirect, "error");
  assert.ok(fetch.calls[0].init.signal, "запрос обязан быть отменяемым");
});

test("переход видео→канал: в документе нет записи вовсе", async () => {
  const fetch = stubFetch(response({ body: fetchedPage(wantedRecord()) }));
  const { context } = load({
    href: "https://www.youtube.com/@wanted",
    head: [
      el("link", { rel: "canonical", href: "https://www.youtube.com/@wanted" }),
      el("meta", { property: "og:url", content: "https://www.youtube.com/watch?v=dQw4w9WgXcQ" }),
      el("meta", { property: "og:title", content: "Название видео" }),
    ],
    body: [modernHeader("Wanted Channel")],
    fetch,
  });

  assert.equal(context.tvGetChannelInfo(), null);
  assert.deepEqual(plain(await context.tvWaitForChannelInfo(2000)), {
    channel_id: ID_A,
    name: "Wanted Channel",
    avatar: AVATAR_A,
  });
});

test("устаревшая голова не отклоняет достоверный свежий результат", async () => {
  // Голова называет чужой id и потому обездвиживает документ; свежий ответ,
  // полученный по этому же адресу, обязан решить сам.
  const fetch = stubFetch(response({ body: fetchedPage(wantedRecord()) }));
  const { context } = load({
    href: "https://www.youtube.com/@wanted",
    head: [
      el("link", { rel: "canonical", href: "https://www.youtube.com/@wanted" }),
      el("meta", { property: "og:url", content: `https://www.youtube.com/channel/${ID_B}` }),
    ],
    body: [modernHeader("Wanted Channel")],
    scripts: [wantedRecord()],
    fetch,
  });

  assert.equal(context.tvGetChannelInfo(), null, "голова спорит с записью — документ молчит");
  assert.equal(plain(await context.tvWaitForChannelInfo(2000))?.channel_id, ID_A);
});

test("документ ответил — запроса нет вовсе", async () => {
  const fetch = stubFetch(response({
    body: fetchedPage(metadataScript({ id: ID_B, title: "Previous Channel", path: "/@wanted", avatar: AVATAR_B })),
  }));
  const { context } = load({
    href: "https://www.youtube.com/@wanted",
    body: [modernHeader("Wanted Channel")],
    scripts: [wantedRecord()],
    fetch,
  });

  assert.equal(plain(await context.tvWaitForChannelInfo(2000))?.channel_id, ID_A);
  assert.equal(fetch.calls.length, 0);
});

test("страница вне канала не порождает запроса", async () => {
  const fetch = stubFetch(response({ body: fetchedPage(wantedRecord()) }));
  const { context } = load({ href: "https://www.youtube.com/watch?v=dQw4w9WgXcQ", fetch });
  assert.equal(await context.tvWaitForChannelInfo(300), null);
  assert.equal(fetch.calls.length, 0);
});

// ----------------------------------------------- проверки адреса и содержимого

const refuses = (name, made) =>
  test(name, async () => {
    const fetch = stubFetch(made);
    const { context } = load(staleAfterHop({ fetch }));
    assert.equal(await context.tvWaitForChannelInfo(400), null);
  });

refuses("ответ пришёл с другого канала — отказ", response({
  url: "https://www.youtube.com/@other",
  body: fetchedPage(wantedRecord()),
}));

refuses("редирект на consent-стену — отказ", response({
  url: "https://consent.youtube.com/m?continue=https%3A%2F%2Fwww.youtube.com%2F%40wanted",
  body: fetchedPage(wantedRecord()),
}));

refuses("похожий хост в адресе ответа — отказ", response({
  url: "https://www.youtube.com.evil.test/@wanted",
  body: fetchedPage(wantedRecord()),
}));

// R3: ключ маршрута — это НЕ origin. Соседний поддомен называет тот же канал и
// проходит проверку ключа, оставаясь другим адресом.
refuses("другой поддомен youtube в адресе ответа — отказ", response({
  url: "https://m.youtube.com/@wanted",
  body: fetchedPage(wantedRecord()),
}));

refuses("http в адресе ответа — отказ", response({
  url: "http://www.youtube.com/@wanted",
  body: fetchedPage(wantedRecord()),
}));

test("R3: документ не по https запроса не порождает вовсе", async () => {
  const fetch = stubFetch(response({ url: "http://www.youtube.com/@wanted", body: fetchedPage(wantedRecord()) }));
  const { context } = load(staleAfterHop({ href: "http://www.youtube.com/@wanted/videos?view=0", fetch }));
  assert.equal(await context.tvWaitForChannelInfo(400), null);
  assert.equal(fetch.calls.length, 0, "граница проверяется до отправки, а не по ответу");
});

test("R3: редирект — ошибка запроса, а не второй запрос", async () => {
  // Ровно то, чем `redirect: "error"` отвечает в браузере: запрос падает на
  // редиректе, запрошенным остаётся только собственный адрес маршрута.
  const fetch = stubFetch(new TypeError("Failed to fetch"));
  const { context } = load(staleAfterHop({ fetch }));
  assert.equal(await context.tvWaitForChannelInfo(400), null);
  assert.equal(fetch.calls.length, 1);
  assert.equal(fetch.calls[0].url, "https://www.youtube.com/@wanted/videos");
  assert.equal(fetch.calls[0].init.mode, "same-origin");
  assert.equal(fetch.calls[0].init.redirect, "error");
});

refuses("ответ не 200 — отказ", response({ status: 429, body: fetchedPage(wantedRecord()) }));

refuses("ответ не text/html — отказ", response({
  contentType: "application/json",
  body: fetchedPage(wantedRecord()),
}));

refuses("сетевая ошибка — отказ без исключения", new Error("network down"));

refuses("свежий ответ описывает другой канал — отказ", response({
  body: fetchedPage(metadataScript({ id: ID_B, title: "Другой канал", path: "/@other", avatar: AVATAR_B })),
}));

refuses("два разных id на один маршрут в ответе — отказ", response({
  body: fetchedPage(
    wantedRecord(),
    metadataScript({ id: ID_B, title: "Второй претендент", path: "/@wanted", avatar: AVATAR_B })
  ),
}));

refuses("запись без заголовка в ответе identity не завершает", response({
  body: fetchedPage(metadataScript({ id: ID_A, title: "", path: "/@wanted" })),
}));

// R1 в свежем источнике: те же две ловушки, что и в документе.
refuses("R1 в ответе: ссылка из description не подтверждает", response({
  body: fetchedPage(initialData({
    renderer: renderer({
      id: ID_B,
      title: "Previous Channel",
      path: "/@previous",
      avatar: AVATAR_B,
      description: "Смотрите также https://www.youtube.com/@wanted",
    }),
  })),
}));

refuses("R1 в ответе: соседний объект после записи не подтверждает", response({
  body: fetchedPage(initialData({
    renderer: renderer({ id: ID_B, title: "Previous Channel", path: "/@previous", avatar: AVATAR_B }),
    siblings: { recommendation: { url: "https://www.youtube.com/@wanted" } },
  })),
}));

// --------------------------------------------------- лимиты, отмена, повторы

test("ответ больше лимита — отказ, чтение отменено", async () => {
  const huge = response({ body: "x".repeat(9000000), chunks: 3 });
  const { context } = load(staleAfterHop({ fetch: stubFetch(huge) }));
  assert.equal(await context.tvWaitForChannelInfo(400), null);
  assert.ok(huge.state.cancelled, "чтение должно быть отменено, а не дочитано");
});

test("навигация во время чтения обрывает чтение", async () => {
  const streamed = response({ body: fetchedPage(wantedRecord()), chunks: 4 });
  const { context } = load(staleAfterHop({ fetch: stubFetch(streamed) }));
  streamed.state.onRead = (n) => {
    if (n === 2) context.location = new URL("https://www.youtube.com/@other");
  };
  assert.equal(await context.tvWaitForChannelInfo(2000), null);
  assert.ok(streamed.state.cancelled, "чтение должно быть отменено");
});

test("запрос ограничен таймаутом и отменяется", async () => {
  let captured = null;
  const fetch = stubFetch((url, init) => {
    captured = init;
    return new Promise((_, reject) => {
      init.signal.addEventListener("abort", () => reject(new Error("aborted")));
    });
  });
  const { context } = load(staleAfterHop({ fetch }));
  const startedAt = Date.now();
  assert.equal(await context.tvWaitForChannelInfo(150), null);
  assert.ok(captured.signal.aborted, "сигнал отмены должен сработать");
  assert.ok(Date.now() - startedAt < 6000, "ожидание ограничено");
});

test("два одновременных ожидания дают ровно один запрос", async () => {
  const fetch = stubFetch(() => response({
    url: "https://www.youtube.com/@wanted/videos",
    body: fetchedPage(wantedRecord()),
  }));
  const { context } = load(staleAfterHop({ fetch }));
  const [first, second] = await Promise.all([
    context.tvWaitForChannelInfo(2000),
    context.tvWaitForChannelInfo(2000),
  ]);
  assert.equal(plain(first)?.channel_id, ID_A);
  assert.equal(plain(second)?.channel_id, ID_A);
  assert.equal(fetch.calls.length, 1);
});

test("повторный клик на том же маршруте не делает второго запроса", async () => {
  const fetch = stubFetch(() => response({
    url: "https://www.youtube.com/@wanted/videos",
    body: fetchedPage(wantedRecord()),
  }));
  const { context } = load(staleAfterHop({ fetch }));
  assert.equal(plain(await context.tvWaitForChannelInfo(2000))?.channel_id, ID_A);
  assert.equal(plain(await context.tvWaitForChannelInfo(2000))?.channel_id, ID_A);
  assert.equal(fetch.calls.length, 1);
});

test("тело отклонённого ответа не дочитывается", async () => {
  const rejected = [
    ["не 200", response({ status: 429, body: fetchedPage(wantedRecord()) })],
    ["чужой адрес", response({ url: "https://www.youtube.com/@other", body: fetchedPage(wantedRecord()) })],
    ["не html", response({ contentType: "application/json", body: fetchedPage(wantedRecord()) })],
  ];
  for (const [label, made] of rejected) {
    const { context } = load(staleAfterHop({ fetch: stubFetch(made) }));
    assert.equal(await context.tvWaitForChannelInfo(400), null, label);
    assert.ok(made.state.cancelled, `${label}: тело обязано быть закрыто`);
    assert.equal(made.state.reads, 0, `${label}: тело не должно читаться вовсе`);
  }
});

test("навигация до прихода заголовков ответа обрывает его", async () => {
  let made = null;
  const fetch = stubFetch((url) => new Promise((resolve) => {
    setTimeout(() => {
      made = response({ url, body: fetchedPage(wantedRecord()) });
      resolve(made);
    }, 200);
  }));
  const { context } = load(staleAfterHop({ fetch }));

  const pending = context.tvWaitForChannelInfo(2000);
  setTimeout(() => {
    context.location = new URL("https://www.youtube.com/@other");
  }, 60);
  assert.equal(await pending, null);
  await new Promise((resolve) => setTimeout(resolve, 350));
  assert.ok(made.state.cancelled, "тело обязано быть закрыто");
  assert.equal(made.state.reads, 0, "тело не должно читаться вовсе");
});

test("возврат на маршрут во время его запроса присоединяется, а не дублирует", async () => {
  const secondPage = () => response({
    url: "https://www.youtube.com/@second",
    body: fetchedPage(metadataScript({ id: ID_B, title: "Второй канал", path: "/@second", avatar: AVATAR_B })),
  });
  const fetch = stubFetch((url) =>
    url.includes("@second")
      ? secondPage()
      : new Promise((resolve) => setTimeout(() => resolve(response({ url, body: fetchedPage(wantedRecord()) })), 300))
  );
  const { context } = load({
    href: "https://www.youtube.com/@wanted",
    body: [modernHeader("Wanted Channel")],
    fetch,
  });

  // Запрос по первому маршруту ещё в полёте, когда пользователь уходит и
  // возвращается: второй клик обязан ждать тот же запрос.
  const abandoned = context.tvWaitForChannelInfo(2000);
  await new Promise((resolve) => setTimeout(resolve, 50));
  context.location = new URL("https://www.youtube.com/@second");
  assert.equal(plain(await context.tvWaitForChannelInfo(2000))?.channel_id, ID_B);
  assert.equal(await abandoned, null, "уход с маршрута обрывает прошлое ожидание");

  context.location = new URL("https://www.youtube.com/@wanted");
  assert.equal(plain(await context.tvWaitForChannelInfo(2000))?.channel_id, ID_A);
  assert.equal(
    fetch.calls.filter((call) => !call.url.includes("@second")).length,
    1,
    "запрос по первому маршруту не продублирован"
  );
});

test("отказ не кэшируется: следующий клик пробует снова", async () => {
  // Обратное поведение сделало бы маршрут несохраняемым до перезагрузки после
  // одной оборванной попытки — отказ не является ответом.
  let attempt = 0;
  const fetch = stubFetch((url) =>
    (attempt += 1) === 1 ? new Error("network down") : response({ url, body: fetchedPage(wantedRecord()) })
  );
  const { context } = load(staleAfterHop({ fetch }));

  assert.equal(await context.tvWaitForChannelInfo(300), null);
  assert.equal(plain(await context.tvWaitForChannelInfo(2000))?.channel_id, ID_A);
  assert.equal(fetch.calls.length, 2);
});

test("кэш не переносится на другой маршрут", async () => {
  const fetch = stubFetch((url) =>
    url.includes("@second")
      ? response({ url, body: fetchedPage(metadataScript({ id: ID_B, title: "Второй канал", path: "/@second", avatar: AVATAR_B })) })
      : response({ url, body: fetchedPage(wantedRecord()) })
  );
  const { context } = load({
    href: "https://www.youtube.com/@wanted",
    body: [modernHeader("Wanted Channel")],
    fetch,
  });

  assert.equal(plain(await context.tvWaitForChannelInfo(2000))?.channel_id, ID_A);
  context.location = new URL("https://www.youtube.com/@second");
  assert.deepEqual(plain(await context.tvWaitForChannelInfo(2000)), {
    channel_id: ID_B,
    name: "Второй канал",
    avatar: AVATAR_B,
  });
  assert.equal(fetch.calls.length, 2);
});

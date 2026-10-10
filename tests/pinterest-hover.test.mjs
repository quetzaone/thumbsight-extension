// node --test: наведение на Pinterest в `content-pinterest.js` (EXT-OPT-01, ids 12, 13, 14, 23).
//
// Скрипт исполняется в vm целиком на мини-DOM: кадры requestAnimationFrame и
// таймеры прогоняются руками, поэтому счётчики вызовов детерминированы.
// Инварианты:
//   13 — курсор ушёл за окно: мутации не гоняют rAF, кнопка прячется;
//   23 — скрытая кнопка не взводит таймеры, видимая не перевзводит его;
//   12 — один getBoundingClientRect на кандидата при скане контейнера;
//   14 — отсоединённая карточка не держит кнопку и не сохраняется кликом.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

const SOURCE = await readFile(new URL("../content-pinterest.js", import.meta.url), "utf8");

// --------------------------------------------------------------- мини-DOM

function load() {
  const counts = { raf: 0, setTimeout: 0, rect: 0 };
  const rafQueue = [];
  const timers = new Map();
  const docListeners = {};
  const winListeners = {};
  const opened = [];
  let nextTimer = 1;
  let observerCallback = null;
  let pointAt = null;

  class FakeEl {
    constructor(tag, props = {}) {
      this.tagName = tag.toUpperCase();
      this.isConnected = true;
      this.style = {};
      this.dataset = {};
      this.attrs = {};
      this.listeners = {};
      this.children = [];
      this.rect = { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 };
      Object.assign(this, props);
    }
    setAttribute(name, value) { this.attrs[name] = String(value); }
    getAttribute(name) { return this.attrs[name] ?? null; }
    addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
    contains(node) { return node === this || this.children.includes(node); }
    // Карточки без pinWrapper/ссылки: поиск по closest ничего не находит.
    closest() { return null; }
    // Продукт зовёт только querySelectorAll("video, img") — дети и есть медиа.
    querySelectorAll() { return this.children; }
    getBoundingClientRect() {
      counts.rect += 1;
      return this.rect;
    }
  }

  const document = {
    body: { appendChild() {} },
    createElement: (tag) => new FakeEl(tag),
    addEventListener: (type, fn) => { (docListeners[type] ||= []).push(fn); },
    elementFromPoint: () => pointAt,
  };

  const context = vm.createContext({
    document,
    window: {
      scrollX: 0,
      scrollY: 0,
      addEventListener: (type, fn) => { (winListeners[type] ||= []).push(fn); },
    },
    location: new URL("https://www.pinterest.com/"),
    URL,
    navigator: { userActivation: { isActive: true } },
    TV: {
      setTriggerState() {},
      openPanel: (_event, intent) => { opened.push(intent); },
      toast() {},
    },
    TVI18N: { t: (key) => key },
    tvIsTrustedGesture: (event) => event?.isTrusted === true,
    MutationObserver: class {
      constructor(callback) { observerCallback = callback; }
      observe() {}
    },
    requestAnimationFrame: (fn) => {
      counts.raf += 1;
      rafQueue.push(fn);
      return rafQueue.length;
    },
    setTimeout: (fn) => {
      counts.setTimeout += 1;
      const id = nextTimer++;
      timers.set(id, fn);
      return id;
    },
    clearTimeout: (id) => { timers.delete(id); },
  });

  let btn = null;
  const createElement = document.createElement;
  document.createElement = (tag) => {
    const node = createElement(tag);
    if (tag === "button") btn = node;
    return node;
  };
  vm.runInContext(SOURCE, context);
  assert.ok(btn, "скрипт создал кнопку");
  assert.ok(observerCallback, "скрипт подписал MutationObserver");

  const fireDoc = (type, event) => { for (const fn of docListeners[type] || []) fn(event); };

  return {
    btn,
    counts,
    opened,
    FakeEl,
    pendingTimers: () => timers.size,
    pendingFrames: () => rafQueue.length,
    setPoint: (node) => { pointAt = node; },
    pointermove: (x, y) => fireDoc("pointermove", { isTrusted: true, clientX: x, clientY: y }),
    pointerout: (relatedTarget) => fireDoc("pointerout", { isTrusted: true, relatedTarget }),
    mutate: () => observerCallback([]),
    frame: () => {
      const batch = rafQueue.splice(0);
      for (const fn of batch) fn();
    },
    flushTimers: () => {
      const batch = [...timers.values()];
      timers.clear();
      for (const fn of batch) fn();
    },
    click: () => {
      const event = { isTrusted: true, preventDefault() {}, stopPropagation() {} };
      for (const fn of btn.listeners.click || []) fn(event);
    },
  };
}

const rectAt = (left, top, width = 300, height = 300) => ({
  left, top, right: left + width, bottom: top + height, width, height,
});

function pin(env, { tag = "img", src = "https://i.pinimg.com/236x/aa/bb/a.jpg", rect = rectAt(0, 0) } = {}) {
  const props = tag === "video" ? { poster: src } : { src, currentSrc: src };
  return new env.FakeEl(tag, { ...props, rect });
}

// Курсор над пином: кнопка видна и привязана к нему.
function hoverPin(env, media) {
  env.setPoint(media);
  env.pointermove(100, 100);
  env.frame();
  assert.equal(env.btn.style.display, "flex", "кнопка показана над пином");
}

// ------------------------------------------------------------------ id 13

test("13: до первого движения мутации не ставят rAF; первое движение показывает кнопку", () => {
  const env = load();
  for (let i = 0; i < 5; i += 1) env.mutate();
  assert.equal(env.counts.raf, 0, "без точки указателя пересчитывать нечего");
  hoverPin(env, pin(env));
  assert.equal(env.counts.raf, 1);
});

test("13: pointerout за окно (relatedTarget null) — мутации без rAF, кнопка прячется по таймеру", () => {
  const env = load();
  hoverPin(env, pin(env));
  env.pointerout(null);
  const rafBefore = env.counts.raf;
  env.mutate();
  assert.equal(env.counts.raf, rafBefore, "мутация после ухода курсора не ставит кадр");
  assert.equal(env.pendingFrames(), 0);
  env.flushTimers();
  assert.equal(env.btn.style.display, "none");
});

test("13, контроль: pointerout в iframe (relatedTarget задан) кнопку не прячет и точку не забывает", () => {
  const env = load();
  hoverPin(env, pin(env));
  env.pointerout(new env.FakeEl("iframe"));
  const rafBefore = env.counts.raf;
  env.mutate();
  assert.equal(env.counts.raf, rafBefore + 1, "точка жива — мутация пересчитывает");
  env.frame();
  env.flushTimers();
  assert.equal(env.btn.style.display, "flex");
});

// ------------------------------------------------------------------ id 23

test("23: десять мутаций при скрытой кнопке — ни одного setTimeout", () => {
  const env = load();
  env.setPoint(new env.FakeEl("div"));
  env.pointermove(5, 5);
  env.frame();
  const before = env.counts.setTimeout;
  for (let i = 0; i < 10; i += 1) {
    env.mutate();
    env.frame();
  }
  assert.equal(env.counts.setTimeout - before, 0, "новых таймеров на мутациях");
  assert.equal(env.counts.setTimeout, 0, "таймеров с самого начала");
  assert.equal(env.btn.style.display, "none");
});

test("23: видимая кнопка при частых мутациях — таймер скрытия взведён один раз и срабатывает", () => {
  const env = load();
  hoverPin(env, pin(env));
  env.setPoint(new env.FakeEl("div"));
  for (let i = 0; i < 10; i += 1) {
    env.mutate();
    env.frame();
  }
  assert.equal(env.counts.setTimeout, 1, "таймер не перевзводится на каждом кадре");
  assert.equal(env.pendingTimers(), 1);
  env.flushTimers();
  assert.equal(env.btn.style.display, "none");
});

// ------------------------------------------------------------------ id 12

test("12: контейнер со 100 img — getBoundingClientRect не больше одного на кандидата", () => {
  const env = load();
  const grid = new env.FakeEl("div");
  for (let i = 0; i < 100; i += 1) {
    // Все пины подходят по src и размеру, но точка (5, 5) ни в один не попадает.
    const media = pin(env, { rect: rectAt(1000 + (i % 5) * 310, (Math.floor(i / 5)) * 310) });
    grid.children.push(media);
  }
  env.setPoint(grid);
  env.pointermove(5, 5);
  env.counts.rect = 0;
  env.frame();
  assert.ok(env.counts.rect <= 100 + 2, `вызовов getBoundingClientRect: ${env.counts.rect}`);
  assert.equal(env.btn.style.display, "none", "в зазоре кнопки нет");
});

test("12, контроль семантики: VIDEO важнее IMG, чужой src и мелкие узлы не берутся", () => {
  const env = load();
  const card = new env.FakeEl("div");
  card.children.push(
    pin(env, { src: "https://example.com/x.jpg" }), // не i.pinimg.com
    pin(env, { rect: rectAt(0, 0, 100, 60) }), // меньше PIN_MIN_*
    pin(env), // img под точкой
    pin(env, { tag: "video" }), // video под той же точкой
  );
  env.setPoint(card);
  env.pointermove(100, 100);
  env.frame();
  assert.equal(env.btn.style.display, "flex");
  assert.equal(env.btn.dataset.tvMediaKind, "video");
});

// ------------------------------------------------------------------ id 14

test("14: отсоединённая карточка + курсор на кнопке — кнопка скрыта, клик не открывает панель", () => {
  const env = load();
  const media = pin(env);
  hoverPin(env, media);

  // Карточка ушла из DOM; у отсоединённого узла rect нулевой.
  media.isConnected = false;
  media.rect = rectAt(0, 0, 0, 0);

  // Клик до пересчёта: старый пин сохранять нельзя.
  env.click();
  assert.equal(env.opened.length, 0, "клик по отсоединённому пину");

  env.setPoint(env.btn);
  env.mutate();
  env.frame();
  assert.equal(env.btn.style.display, "none", "кнопка не висит над исчезнувшей карточкой");

  env.click();
  assert.equal(env.opened.length, 0, "клик после пересчёта");
});

test("14, контроль: живой пин под кнопкой сохраняется кликом", () => {
  const env = load();
  hoverPin(env, pin(env));
  env.setPoint(env.btn);
  env.mutate();
  env.frame();
  assert.equal(env.btn.style.display, "flex");
  env.click();
  assert.equal(env.opened.length, 1);
  assert.equal(env.opened[0].mode, "pinterest");
  assert.equal(env.opened[0].imageUrl, "https://i.pinimg.com/236x/aa/bb/a.jpg");
});

// YouTube channel pages and video tiles.
// Adds the channel follow button and compact hover buttons for video cards.

function tvIsChannelPage() {
  return /^\/(@|channel\/|c\/|user\/)/.test(location.pathname);
}

// ----------------------------------------------------- current channel identity
//
// A channel page carries metadata for more than one channel: video cards link to
// their own authors, the site head can still describe the page the tab opened on,
// and the initial-data scripts are never rewritten by an SPA navigation. Two rules
// follow, and everything below is one of them:
//
//   1. A source vouches for a channel only through fields in which it states its
//      OWN address. Text near it — a description link, the next object in the
//      blob — is somebody else's statement.
//   2. Only a source that carries an id AND that channel's name completes an
//      identity. An id alone, from any origin including the URL, is not one: it
//      would be paired with whatever name happened to be lying around.
//
// Everything else waits, and then refuses visibly without writing.

const TV_CHANNEL_NAME_MAX = 160;
const TV_CHANNEL_RENDERER_KEY = '"channelMetadataRenderer"';
// Ceiling on one metadata object, not on the page: the renderer is a few KB, and
// an object that does not close inside the budget is dropped rather than guessed.
const TV_CHANNEL_RECORD_BUDGET = 200000;
const TV_CHANNEL_OWNER_URL_MAX = 8;

// The channel a URL addresses, as a comparable key. Everything else — the site
// root, a /watch page, a lookalike host — has no key and can vouch for nothing.
function tvChannelRouteKey(url) {
  try {
    const parsed = new URL(String(url || ""), location.origin);
    if (!/^(?:[\w-]+\.)*youtube\.com$/i.test(parsed.hostname)) return "";
    const path = decodeURIComponent(parsed.pathname);
    const byId = path.match(/^\/channel\/(UC[\w-]{22})(?:\/|$)/);
    if (byId) return `id:${byId[1]}`;
    const byHandle = path.match(/^\/(@[^/]+)(?:\/|$)/);
    if (byHandle) return `handle:${byHandle[1].toLowerCase()}`;
    const byLegacy = path.match(/^\/(c|user)\/([^/]+)(?:\/|$)/);
    if (byLegacy) return `${byLegacy[1]}:${byLegacy[2].toLowerCase()}`;
    return "";
  } catch {
    return "";
  }
}

function tvChannelText(value) {
  return String(value == null ? "" : value).replace(/\s+/g, " ").trim().slice(0, TV_CHANNEL_NAME_MAX);
}

// Complete JSON object starting at `start`, or "" if it does not close inside the
// budget. String-aware, so a brace inside a description or a title cannot end it.
// Slicing instead of scanning text is the whole of the R1 fix: the object ends
// where YouTube ended it, not where a character budget ran out.
function tvSliceJsonObject(text, start, budget) {
  if (text[start] !== "{") return "";
  const end = Math.min(text.length, start + budget);
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let at = start; at < end; at += 1) {
    const character = text[at];
    if (inString) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') inString = true;
    else if (character === "{") depth += 1;
    else if (character === "}" && (depth -= 1) === 0) return text.slice(start, at + 1);
  }
  return "";
}

// Only fields in which the renderer states its own address. `description` links,
// neighbouring objects and any later `externalId` are other people's statements
// and supply nothing — not a witness, not a missing name, not an avatar.
function tvChannelRecord(renderer) {
  if (!renderer || typeof renderer !== "object") return null;
  const id = typeof renderer.externalId === "string" ? renderer.externalId : "";
  if (!/^UC[\w-]{22}$/.test(id)) return null;
  const keys = new Set([`id:${id}`]);
  const ownUrls = [renderer.vanityChannelUrl, renderer.channelUrl];
  if (Array.isArray(renderer.ownerUrls)) ownUrls.push(...renderer.ownerUrls.slice(0, TV_CHANNEL_OWNER_URL_MAX));
  for (const url of ownUrls) {
    // The host is re-validated inside the route key, so a lookalike proves nothing.
    const key = typeof url === "string" ? tvChannelRouteKey(url) : "";
    if (key) keys.add(key);
  }
  const thumbnails = Array.isArray(renderer.avatar?.thumbnails) ? renderer.avatar.thumbnails : [];
  const avatar = thumbnails[thumbnails.length - 1]?.url;
  return {
    id,
    name: typeof renderer.title === "string" ? tvChannelText(renderer.title) : "",
    // The intent layer is the authority on avatar hosts; this only bounds it.
    avatar: typeof avatar === "string" ? avatar.slice(0, 2048) : "",
    keys,
  };
}

// `channelMetadataRenderer` is the one place YouTube states id, title, avatar and
// the channel's own URLs together, so such a record can vouch for itself. It is
// parsed as a bounded JSON object — page code is never executed. The same reading
// serves a script element and fetched HTML: a match that is not a real record for
// this route still vouches for nothing, whatever text it was found in.
function tvChannelRecordsInText(text) {
  const records = [];
  let from = 0;
  for (;;) {
    const at = text.indexOf(TV_CHANNEL_RENDERER_KEY, from);
    if (at < 0) break;
    from = at + TV_CHANNEL_RENDERER_KEY.length;
    const open = text.indexOf("{", from);
    // The key must actually introduce that object; anything else is a mention.
    if (open < 0 || !/^\s*:\s*$/.test(text.slice(from, open))) continue;
    const raw = tvSliceJsonObject(text, open, TV_CHANNEL_RECORD_BUDGET);
    if (!raw) continue;
    from = open + raw.length;
    let renderer = null;
    try { renderer = JSON.parse(raw); } catch { renderer = null; }
    const record = tvChannelRecord(renderer);
    if (record) records.push(record);
  }
  return records;
}

function tvChannelIdentityRecords() {
  const records = [];
  for (const script of document.scripts) records.push(...tvChannelRecordsInText(script.textContent || ""));
  return records;
}

// One identity out of records that state this route, or nothing. Shared by the
// document and by fetched HTML so neither can be resolved by a laxer rule.
function tvChannelIdentityFrom(records, routeKey, stated = []) {
  const own = records.filter((record) => record.keys.has(routeKey));
  // Every id claimed about this route. Two claimants contradict each other and
  // neither is preferred: the caller keeps waiting and then refuses visibly.
  const ids = new Set(own.map((record) => record.id));
  for (const id of stated) ids.add(id);
  if (ids.size !== 1) return null;
  // The name and avatar come from the record that also stated the id, so a page
  // mid-navigation cannot pair a fresh id with the previous channel's title.
  const identity = own.find((record) => record.name);
  return identity ? { channel_id: identity.id, name: identity.name, avatar: identity.avatar } : null;
}

// ------------------------------------------- a record as fresh as the route is
//
// After an in-site navigation YouTube does not rewrite the document: `location`,
// `canonical`, the title and the rendered header are updated, while ytInitialData,
// `og:*` and the microdata still describe the channel the tab arrived from — and
// they stay that way indefinitely. Measured on live pages, not assumed. None of
// the updated things states an id together with a name, so the rules above
// correctly refuse, and no amount of waiting changes that.
//
// The missing statement is therefore requested, once, as part of the explicit
// click that wants to save the channel: a plain same-origin GET of the current
// channel's own path, read as text. Nothing in it is executed and nothing is
// stored. Because it is fetched for this exact address, it is the freshest thing
// available about the route: the stale document neither completes it nor vetoes
// it, and it is held to exactly the same identity rules.

const TV_CHANNEL_FETCH_TIMEOUT = 4000;
// Characters of decoded HTML, against a live channel page measured at ~2.3 MB.
// The body is streamed, so nothing past the cap is ever buffered.
const TV_CHANNEL_FETCH_MAX = 8000000;
const TV_CHANNEL_FETCH_CACHE_MAX = 32;

// Answers that resolved, kept for the page's lifetime, and requests still in
// flight, keyed per route. A refusal is deliberately NOT remembered: a request
// cut short by navigation or a transient network error must not make the route
// unsavable until reload — refusing is not answering.
const tvChannelFetched = new Map();
const tvChannelFetching = new Map();

// Exactly this document's origin, over HTTPS. `credentials` says what may be
// SENT and is not a statement about destinations, so where the request may go is
// stated separately — and stated on the request itself, because a boundary that
// is only checked after the answer has already been fetched from the forbidden
// address is not a boundary. A route key is not an origin either: another
// youtube.com subdomain names the same channel and is still somewhere else.
function tvIsOwnHttpsOrigin(url, origin) {
  try {
    const parsed = new URL(String(url || ""), origin);
    return parsed.protocol === "https:" && parsed.origin === origin;
  } catch {
    return false;
  }
}

async function tvReadChannelHtml(routeKey) {
  // Only this route's own path is ever requested — no query, no fragment, no
  // page-supplied value — and the answer must come back from that same address.
  const origin = location.origin;
  const target = new URL(location.pathname, origin);
  if (tvChannelRouteKey(target.href) !== routeKey) return "";
  if (!tvIsOwnHttpsOrigin(target.href, origin)) return "";

  let timer = null;
  try {
    const controller = new AbortController();
    timer = setTimeout(() => controller.abort(), TV_CHANNEL_FETCH_TIMEOUT);
    const response = await fetch(target.href, {
      credentials: "same-origin",
      // Destination policy, refused before anything leaves: a redirect fails the
      // request instead of becoming a second one, so an address outside this
      // origin is never contacted and only then judged.
      mode: "same-origin",
      redirect: "error",
      signal: controller.signal,
    });
    // A refused answer is also dropped on the floor: an unread body would go on
    // streaming megabytes after the deadline timer has already been cleared.
    const refuse = async () => {
      await response.body?.cancel();
      return "";
    };
    // A consent wall, a sign-in page or another channel answers a different
    // question than the one asked, so only this route's own HTML is read.
    if (!response.ok) return refuse();
    // The same boundary re-read off the answer. This is the second lock, not the
    // first: by now the request has already been refused if it ever pointed
    // anywhere else, and the route key below is about WHICH channel answered.
    if (!tvIsOwnHttpsOrigin(response.url, origin)) return refuse();
    if (tvChannelRouteKey(response.url) !== routeKey) return refuse();
    if (!/^text\/html\b/i.test(response.headers.get("content-type") || "")) return refuse();
    // The user can leave while the headers are still on the way; without this the
    // body would only be dropped once its first chunk arrived.
    if (tvChannelRouteKey(location.href) !== routeKey) return refuse();

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let html = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      html += decoder.decode(value, { stream: true });
      // Oversized answer, or the user has already navigated away: stop pulling.
      if (html.length > TV_CHANNEL_FETCH_MAX || tvChannelRouteKey(location.href) !== routeKey) {
        await reader.cancel();
        return "";
      }
    }
    return html + decoder.decode();
  } catch {
    return "";
  } finally {
    clearTimeout(timer);
  }
}

// One request per route at a time, and one per route per page lifetime once it
// has answered: a second click must not become a second request. Both are keyed
// per route, so leaving a channel and coming back while its request is still in
// flight joins that request instead of starting a rival one.
function tvFetchChannelInfo(routeKey) {
  const cached = tvChannelFetched.get(routeKey);
  if (cached) return Promise.resolve(cached);
  const running = tvChannelFetching.get(routeKey);
  if (running) return running;

  const promise = (async () => {
    const html = await tvReadChannelHtml(routeKey);
    return html ? tvChannelIdentityFrom(tvChannelRecordsInText(html), routeKey) : null;
  })()
    .catch(() => null)
    .then((info) => {
      tvChannelFetching.delete(routeKey);
      if (info) {
        if (tvChannelFetched.size >= TV_CHANNEL_FETCH_CACHE_MAX) tvChannelFetched.clear();
        tvChannelFetched.set(routeKey, info);
      }
      return info;
    });

  tvChannelFetching.set(routeKey, promise);
  return promise;
}

// The head states ids, never a name: `og:title` is site metadata, which is exactly
// why it reads "YouTube" whenever the document is not a channel document. Every id
// it states is collected, not the first one — a head naming two channels is
// contradicting itself and must not be resolved by preferring one of them.
function tvChannelHeadIds() {
  const canonical = document.querySelector('link[rel="canonical"]')?.href || "";
  const ogUrl = document.querySelector('meta[property="og:url"]')?.content || "";
  const keys = new Set();
  for (const url of [canonical, ogUrl]) {
    const key = tvChannelRouteKey(url);
    if (key) keys.add(key);
  }
  if (!keys.size) return null;
  const feed = document.querySelector('link[rel="alternate"][type="application/rss+xml"]')?.href || "";
  const itemprop = tvChannelText(document.querySelector('meta[itemprop="channelId"]')?.content);
  const ids = new Set([...keys].filter((key) => key.startsWith("id:")).map((key) => key.slice(3)));
  if (/^UC[\w-]{22}$/.test(itemprop)) ids.add(itemprop);
  const feedId = String(feed).match(/[?&]channel_id=(UC[\w-]{22})/)?.[1];
  if (feedId) ids.add(feedId);
  return { ids: [...ids], keys };
}

function tvFindChannelTitleElement() {
  return (
    document.querySelector("yt-page-header-renderer h1") ||
    document.querySelector("ytd-c4-tabbed-header-renderer h1") ||
    document.querySelector("#channel-header h1") ||
    document.querySelector("h1.ytd-channel-name") ||
    document.querySelector("h1")
  );
}

// One current channel described by all three fields, or nothing at all — out of
// this document alone. The URL and the head take part only in the id set, so that
// a disagreement is visible; neither can complete a result, because a UC route
// proves the id and proves nothing about a name found nearby.
function tvGetChannelInfo() {
  const routeKey = tvChannelRouteKey(location.href);
  if (!routeKey) return null;

  const head = tvChannelHeadIds();
  const stated = [];
  if (head?.keys.has(routeKey)) stated.push(...head.ids);
  if (routeKey.startsWith("id:")) stated.push(routeKey.slice(3));

  return tvChannelIdentityFrom(tvChannelIdentityRecords(), routeKey, stated);
}

// Metadata arrives late on a first load, and after an in-site navigation it never
// arrives at all — so the document is waited on and the current route's own HTML
// is requested at the same time. An identity resolved for the previous page must
// never be offered for this one, so every path re-checks the route.
//
// Reached only from the trusted click in `tvOnFollow`: the request below is a
// consequence of the user asking to save this channel, never of visiting a page.
async function tvWaitForChannelInfo(timeoutMs = 2500) {
  const startedAt = Date.now();
  const routeKey = tvChannelRouteKey(location.href);
  if (!routeKey) return null;

  // A loaded channel page answers here, with no request at all.
  const loaded = tvGetChannelInfo();
  if (loaded) return loaded;

  const fetched = tvFetchChannelInfo(routeKey);
  let fresh = null;
  let settled = false;
  fetched.then((info) => { fresh = info; settled = true; });

  for (;;) {
    if (tvChannelRouteKey(location.href) !== routeKey) return null;
    const info = tvGetChannelInfo();
    if (info) return info;
    if (fresh) return fresh;
    if (Date.now() - startedAt >= timeoutMs) break;
    // Wake on the next document poll or the moment the answer lands, whichever
    // is first — but never race a promise that has already settled, or the poll
    // would spin instead of waiting.
    const tick = new Promise((resolve) => setTimeout(resolve, 100));
    await (settled ? tick : Promise.race([fetched, tick]));
  }

  // The document never answered; the request may still be in flight.
  const info = await fetched;
  return tvChannelRouteKey(location.href) === routeKey ? info : null;
}

function tvMakeFollowButton() {
  const btn = document.createElement("button");
  btn.id = "tv-follow-btn";
  btn.type = "button";
  btn.className = "tv-yt-btn tv-yt-inline tv-follow-title";
  TV.setTriggerState(btn, "idle");
  btn.title = TVI18N.t("followChannel");
  btn.setAttribute("aria-label", btn.title);
  btn.addEventListener("click", tvOnFollow);
  return btn;
}

document.addEventListener("tv:langchange", () => {
  const follow = document.getElementById("tv-follow-btn");
  if (follow) {
    follow.title = TVI18N.t("followChannel");
    follow.setAttribute("aria-label", follow.title);
  }
  for (const button of document.querySelectorAll(".tv-tile-save-btn")) {
    button.title = TVI18N.t("saveThumbnail");
    button.setAttribute("aria-label", button.title);
  }
});

// Кнопка на странице канала больше ничего не сохраняет и не показывает статус
// подписки: она только открывает extension-origin панель, где пользователь
// подтверждает действие (EXT-001) и где остаются приватные ответы (EXT-002).
async function tvOnFollow(e) {
  e.preventDefault();
  e.stopPropagation();
  if (!tvIsTrustedGesture(e, navigator.userActivation)) return;

  const info = await tvWaitForChannelInfo();
  if (!info) {
    TV.toast(TVI18N.t("channelUnknown"), "error");
    return;
  }

  TV.openPanel(e, {
    mode: "channel",
    channelId: info.channel_id,
    channelName: info.name,
    channelAvatar: info.avatar,
  });
}

function tvFindFollowFallbackAnchor() {
  const sub = document.querySelector(
    "ytd-subscribe-button-renderer, yt-subscribe-button-view-model, #subscribe-button"
  );
  return sub?.parentElement || null;
}

function tvFindChannelTitleAnchor() {
  // Placement only. The rendered header carries no evidence of which route it
  // belongs to, so it never contributes to the saved identity.
  const title = tvFindChannelTitleElement();
  const parent = title?.parentElement;
  if (!title || !parent) return null;
  parent.classList.add("tv-channel-title-host");
  return { parent, after: title };
}

function tvPlaceFollowButton() {
  if (!tvIsChannelPage()) {
    document.getElementById("tv-follow-btn")?.remove();
    return;
  }

  const titleAnchor = tvFindChannelTitleAnchor();
  const anchor = titleAnchor?.parent || tvFindFollowFallbackAnchor();
  if (!anchor) return;

  const existing = document.getElementById("tv-follow-btn");
  if (existing && anchor.contains(existing)) return;
  if (existing) existing.remove();

  const btn = tvMakeFollowButton();
  if (titleAnchor?.after) titleAnchor.after.after(btn);
  else anchor.appendChild(btn);
}

function tvGetVideoIdFromUrl(url) {
  try {
    const u = new URL(url, location.origin);
    if (u.pathname.startsWith("/shorts/")) return u.pathname.split("/")[2] || "";
    return u.searchParams.get("v") || "";
  } catch {
    return "";
  }
}

const TV_VIDEO_TILE_SELECTOR =
  "ytd-rich-item-renderer, ytd-video-renderer, ytd-grid-video-renderer, ytd-compact-video-renderer, ytd-reel-item-renderer, yt-lockup-view-model";

function tvFindTileThumb(tile) {
  return (
    tile.querySelector('a#thumbnail[href*="/watch"]') ||
    tile.querySelector('a#thumbnail[href*="/shorts/"]') ||
    tile.querySelector('a[href*="/watch?v="]') ||
    tile.querySelector('a[href*="/shorts/"]')
  );
}

function tvFindTileThumbHost(tile, thumb) {
  return (
    thumb.closest("ytd-thumbnail") ||
    tile.querySelector("ytd-thumbnail") ||
    thumb.parentElement
  );
}

async function tvOnTileSave(e) {
  e.preventDefault();
  e.stopPropagation();
  if (!tvIsTrustedGesture(e, navigator.userActivation)) return;

  const btn = e.currentTarget;
  const videoId = btn.dataset.videoId;
  if (!videoId) return;

  await TV.openPanel(e, {
    mode: "youtube",
    videoId,
    imageUrl: `https://i.ytimg.com/vi/${videoId}/maxresdefault.jpg`,
    sourceUrl: `https://www.youtube.com/watch?v=${videoId}`,
  });
}

function tvMakeTileButton(videoId) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "tv-tile-save-btn";
  btn.dataset.videoId = videoId;
  btn.title = TVI18N.t("saveThumbnail");
  btn.setAttribute("aria-label", TVI18N.t("saveThumbnail"));
  TV.setTriggerState(btn, "idle");
  btn.addEventListener("click", tvOnTileSave);
  return btn;
}

let tvTileButton = null;
let tvTileHover = null;
let tvTilePointer = null;

function tvEnsureTileButton() {
  if (tvTileButton?.isConnected) return tvTileButton;
  tvTileButton = tvMakeTileButton("");
  // A global trigger has no target until a real video card is hovered.
  tvTileButton.tabIndex = -1;
  document.body.appendChild(tvTileButton);
  return tvTileButton;
}

function tvPositionTileButton(host) {
  const rect = host.getBoundingClientRect();
  const button = tvEnsureTileButton();
  button.style.top = `${rect.top + 8}px`;
  button.style.left = `${rect.left + 8}px`;
}

function tvFindTileAtPoint(x, y) {
  for (const element of document.elementsFromPoint(x, y)) {
    if (element === tvTileButton || tvTileButton?.contains(element)) return tvTileHover?.tile || null;
    const tile = element.closest?.(TV_VIDEO_TILE_SELECTOR);
    if (tile) return tile;
  }

  const previous = tvTileHover;
  if (!previous?.tile?.isConnected) return null;
  const thumb = tvFindTileThumb(previous.tile);
  const host = thumb && tvFindTileThumbHost(previous.tile, thumb);
  if (!host) return null;
  const rect = host.getBoundingClientRect();
  return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom
    ? previous.tile
    : null;
}

function tvRefreshTileHover() {
  if (!tvTilePointer) return;
  const tile = tvFindTileAtPoint(tvTilePointer.x, tvTilePointer.y);
  const thumb = tile && tvFindTileThumb(tile);
  const videoId = tvGetVideoIdFromUrl(thumb?.href || "");
  const host = thumb && tvFindTileThumbHost(tile, thumb);
  const button = tvEnsureTileButton();

  if (!tile || !host || !videoId) {
    tvTileHover = null;
    button.classList.remove("tv-tile-save-btn-visible");
    button.tabIndex = -1;
    return;
  }

  tvTileHover = { tile, host };
  button.dataset.videoId = videoId;
  tvPositionTileButton(host);
  button.tabIndex = 0;
  button.classList.add("tv-tile-save-btn-visible");
}

// Слушатели только запоминают точку: hit-test elementsFromPoint дорогой, а
// pointerover+pointermove+scroll приходят по нескольку за кадр — считаем раз в кадр.
let tvTileHoverScheduled = false;
function tvScheduleTileHover() {
  if (tvTileHoverScheduled) return;
  tvTileHoverScheduled = true;
  requestAnimationFrame(() => {
    tvTileHoverScheduled = false;
    tvRefreshTileHover();
  });
}

document.addEventListener("pointermove", (event) => {
  if (event.isTrusted !== true) return;
  tvTilePointer = { x: event.clientX, y: event.clientY };
  tvScheduleTileHover();
}, { capture: true, passive: true });

document.addEventListener("pointerover", (event) => {
  if (event.isTrusted !== true) return;
  tvTilePointer = { x: event.clientX, y: event.clientY };
  tvScheduleTileHover();
}, { capture: true, passive: true });

window.addEventListener("scroll", tvScheduleTileHover, { passive: true });

// Плитки не размечаем: кнопка — position:fixed в body и ищет плитку под курсором
// сама, а обход всех плиток на каждую мутацию был чистой тратой.
function tvEnhanceVideoTiles() {
  tvEnsureTileButton();
}

let tvChannelLastUrl = location.href;
let tvChannelScheduled = false;

function tvScheduleChannel() {
  if (tvChannelScheduled) return;
  tvChannelScheduled = true;
  requestAnimationFrame(() => {
    tvChannelScheduled = false;
    tvPlaceFollowButton();
    tvEnhanceVideoTiles();
    tvRefreshTileHover();
  });
}

new MutationObserver(() => {
  if (location.href !== tvChannelLastUrl) {
    tvChannelLastUrl = location.href;
    document.getElementById("tv-follow-btn")?.remove();
  }
  tvScheduleChannel();
}).observe(document, { subtree: true, childList: true });

tvScheduleChannel();
document.addEventListener("yt-navigate-finish", tvScheduleChannel);
document.addEventListener("yt-page-data-updated", tvScheduleChannel);
window.addEventListener("pageshow", tvScheduleChannel);
// Резервных setTimeout нет: наблюдатель за subtree уже ловит любую позднюю вставку.

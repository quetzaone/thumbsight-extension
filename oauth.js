const TV_OAUTH_DEFAULT_SITE = "https://thumbsight.com";

function tvOAuthBase64Url(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function tvOAuthRandomToken(byteLength) {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return tvOAuthBase64Url(bytes);
}

async function tvOAuthChallenge(verifier) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return tvOAuthBase64Url(new Uint8Array(digest));
}

function tvOAuthSiteUrl() {
  const configured = self.THUMBVAULT_CONFIG.AUTH_SITE_URL || TV_OAUTH_DEFAULT_SITE;
  const url = new URL(configured);
  const local = url.protocol === "http:" && (url.hostname === "localhost" || url.hostname === "127.0.0.1");
  if (url.protocol !== "https:" && !local) throw new Error("Invalid Thumb Sight auth URL");
  return new URL("/connect", url.origin);
}

function tvOAuthLaunch(url) {
  return new Promise((resolve, reject) => {
    chrome.identity.launchWebAuthFlow({ url, interactive: true }, (responseUrl) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message || "Authorization cancelled"));
        return;
      }
      if (!responseUrl) {
        reject(new Error("Authorization cancelled"));
        return;
      }
      resolve(responseUrl);
    });
  });
}

function tvOAuthSession(value) {
  if (!value || typeof value !== "object") return null;
  if (typeof value.access_token !== "string" || value.access_token.length < 20 || value.access_token.length > 16384) return null;
  if (typeof value.refresh_token !== "string" || !value.refresh_token || value.refresh_token.length > 4096) return null;
  if (!value.user || typeof value.user.id !== "string") return null;
  return {
    access_token: value.access_token,
    refresh_token: value.refresh_token,
    token_type: value.token_type || "bearer",
    expires_in: Number(value.expires_in) || 3600,
    expires_at: Number(value.expires_at) || null,
    user: {
      id: value.user.id,
      email: typeof value.user.email === "string" ? value.user.email : "",
    },
  };
}

// ---------------------------------------------------------------- носитель
//
// Слот `tv_session` (и парный ему `tv_oauth_error`) лежит в РАЗНЫХ областях в
// зависимости от браузера, и выбор делается ОДИН раз, здесь:
//
//   Chrome  — `storage.local`, закрытый `setAccessLevel("TRUSTED_CONTEXTS")`.
//     С PUB-07 это не предположение, а ПРОВЕРЯЕМОЕ условие: раздел «готовность»
//     в конце файла ждёт успешного вызова и печатает слот, если защиты нет.
//     Для `local` метод действует с Chrome 140; ниже он либо отсутствует, либо
//     отвергает эту область, и тогда носитель запечатан на всю активацию;
//   Firefox — `storage.session`. Причина замерена, а не предположена
//     (`security/receipts/CLAUDE-EXT-FIREFOX-PLATFORM-PROBE-01.md`, F1/F3/F4):
//     `setAccessLevel` в Firefox не реализован ни для одной области, поэтому
//     `storage.local` там читается content script'ами и для refresh_token
//     непригоден, а `storage.session` content script'ам недоступен и открыть
//     его нечем.
//
// Fallback'а между областями НЕТ намеренно. «Не получилось в session — пишем в
// local» означало бы тихую выдачу токена content script'ам ровно в тот момент,
// когда что-то пошло не так. Отказ области — это отказ операции, который
// очередь и барьер ниже уже умеют обрабатывать fail-closed.
//
// Ровно то же правило действует и на САМО ОПРЕДЕЛЕНИЕ платформы. Область
// называется только по ПОЛОЖИТЕЛЬНО опознанной схеме собственного адреса:
// `chrome-extension:` → `local`, `moz-extension:` → `session`. Отсутствующий
// или бросающий `runtime.getURL`, неразбираемый адрес и любая другая схема
// дают пустую строку, а она закрывает `tvSessionStore()` — то есть все чтения,
// записи, refresh, logout и install-сброс — ДО обращения к storage и к сети.
// Умолчание `local` здесь было ошибкой того же класса, что и fallback: при
// неизвестной платформе оно выбирало область, которую в Firefox читает content
// script (CODEX-EXT-FIREFOX-IMPLEMENTATION-REVIEW-01, R1).
//
// Цена решения владельца для Firefox-беты: `storage.session` очищается при
// завершении браузера, поэтому после полного перезапуска Firefox расширение
// подключают заново. Выгрузку фоновой страницы область переживает (F10).
function tvSessionAreaName() {
  let base;
  try {
    if (!chrome.runtime || typeof chrome.runtime.getURL !== "function") return "";
    base = chrome.runtime.getURL("/");
  } catch (_) {
    return "";
  }
  let protocol;
  try {
    protocol = new URL(base).protocol;
  } catch (_) {
    return "";
  }
  if (protocol === "moz-extension:") return "session";
  if (protocol === "chrome-extension:") return "local";
  return "";
}

const TV_SESSION_AREA = tvSessionAreaName();

function tvSessionStore() {
  const area = TV_SESSION_AREA ? chrome.storage[TV_SESSION_AREA] : null;
  if (!area) throw new Error("Session storage area unavailable");
  return area;
}

// Держатель общего refresh-flight: `{ promise, base }`, где `base` — РЕВИЗИЯ
// ЗАФИКСИРОВАННОГО (`tvSessionRevision`) на момент старта flight, а не «поколение»
// и не эпоха намерений. По ней после ОТКАЗА flight видно, состоялось ли за время
// запроса настоящее изменение слота. `base === null` означает единственное: секция
// снимка не успела начаться, сравнивать не с чем. Держатель наружу не
// экспортируется и в возврат не попадает.
let tvOAuthRefreshFlight = null;

// Барьер install-сброса. Каждая session-операция снимает его СИНХРОННО в момент
// вызова и ждёт уже внутри своей секции (tvSessionGuarded), а не до постановки
// в очередь.
//
// Он же — единственная печать fail-closed: отказавший сброс оставляет здесь
// отклонённый promise, и пока следующий УСПЕШНЫЙ сброс не поставит сюда новый,
// все чтения, refresh, login/set и logout отказывают, не используя и не
// отзывая старый credential. Отдельного флага нет намеренно: второе состояние
// пришлось бы синхронизировать с этим promise, и они бы разъехались.
let tvInstallStatePromise = Promise.resolve();

const TV_SESSION_SEALED = "Session unavailable: install state reset failed";

// Печать НОСИТЕЛЯ — вторая, независимая от install-сброса. Её ставит неудачная
// проверка защиты области (см. раздел «готовность» в конце файла).
//
// Признак хранится ОТДЕЛЬНО от promise готовности и читается СИНХРОННО. Это не
// дубликат состояния, а разные вопросы:
//
//   `tvCarrierReady` отвечает «проверка ещё идёт или уже закончилась» — его
//     нужно ЖДАТЬ, и ждать можно только внутри секции;
//   `tvCarrierSealError` отвечает «ответ уже известен и он отрицательный» — на
//     него нужно отвечать НЕМЕДЛЕННО, ДО постановки в очередь. Зависшая
//     storage-операция в чужой секции не отменяется ничем, и вставать за ней в
//     хвост, когда ответ уже известен, значило бы подвесить UI вместо отказа.
//
// Признак односторонний: он только ставится. Поздний успех `setAccessLevel`,
// пришедший после таймаута, текущую активацию не открывает; защиту пробует
// заново следующая активация worker.
const TV_CARRIER_UNPROTECTED = "Session unavailable: storage protection unavailable";

// `tvCarrierOpen` — синхронный признак ДОКАЗАННОЙ защиты. Вместе с
// `tvCarrierSealError` он отвечает на вопрос «проверка уже завершилась?», и
// именно поэтому предел ожидания заводится лениво: пока ни один из двух не
// выставлен, проверка идёт. Ставится он ТОЛЬКО если печати ещё нет — поздний
// успех после таймаута не открывает запечатанную активацию.
let tvCarrierOpen = false;
let tvCarrierSealError = null;
let tvCarrierCleanup = null;
let tvCarrierDeadline = null;
let tvCarrierDeadlineTimer = null;

// Одна последовательная очередь критических секций над слотом tv_session
// внутри worker. Через неё проходят ВСЕ операции с этим ключом — и записи
// (logout, новый login, install-сброс, commit refresh), и чтения. Следующая
// секция стартует только после того, как предыдущая завершила ВСЕ свои
// storage-операции, поэтому одновременно начатых защищённых операций не
// бывает и порядок их завершения ничего не решает: chrome.storage такого
// порядка не обещает.
// oauth.js исполняется только в service worker (`importScripts` в
// background.js), других realm-писателей `tv_session` в расширении нет.
let tvSessionQueue = Promise.resolve();

// Два разных счётчика вместо одного «поколения» ревизий 01–07. Одно число не
// могло означать сразу обе вещи:
//
//   ЭПОХА НАМЕРЕНИЙ (tvSessionEpoch) — фенс устаревших записей. Её двигает
//     каждое авторитетное НАМЕРЕНИЕ изменить слот: setter, commit refresh,
//     logout, install-сброс и intent входа. Двигается ДО storage-операции и
//     двигается даже тогда, когда операция потом отказала или намерение
//     отменилось. Так и надо: фенс обязан быть пессимистичным — лучше зря
//     отменить чужую устаревшую запись, чем пропустить её;
//
//   РЕВИЗИЯ ЗАФИКСИРОВАННОГО (tvSessionRevision) — счётчик фактически
//     состоявшихся изменений слота. Увеличивается ТОЛЬКО после успешного
//     set/remove ключа `tv_session`, ни в одном другом месте. Ни отменённый
//     вход, ни отказавшая запись её не двигают.
//
// Ревизия 07 сверяла отказавший refresh с эпохой, то есть считала «намерение
// было» доказательством «состояние изменилось», и отдавала старый credential
// как успешный результат. Сверять факт можно только со счётчиком фактов.
//
// Чтения и снимок для refresh не двигают ни то, ни другое.
let tvSessionEpoch = 0;
let tvSessionRevision = 0;

function tvSessionSection(work) {
  const run = tvSessionQueue.then(work);
  // Хвост не должен застревать на отказе одной секции.
  tvSessionQueue = run.then(() => {}, () => {});
  return run;
}

// Наружу уходит одно стабильное сообщение: причина storage-сбоя — внутренняя
// диагностика, в popup ей делать нечего.
async function tvAwaitInstallBarrier(barrier) {
  try {
    await barrier;
  } catch (_) {
    throw new Error(TV_SESSION_SEALED);
  }
}

// Предел ожидания проверки носителя. Один на активацию, и отсчёт идёт от САМОЙ
// ПРОВЕРКИ, а не от первого вызывающего.
//
// Раньше таймер заводился лениво, из `tvAwaitCarrier`. Это был дефект: если
// `setAccessLevel` завис, а credential-вызывающих ещё нет (UI не открыт, панель
// не звали), печать и уборка не наступали ВООБЩЕ, и старый `tv_session` сколько
// угодно долго оставался в потенциально открытой области
// (CODEX-PUBLIC-PUB07-REVIEW-01, F1). «Одна ограниченная по времени проверка на
// активацию» не может зависеть от того, открыл ли пользователь popup.
//
// Поэтому предел заводится на старте, рядом с самой проверкой, и снимается её
// завершением. Ожидающие операции разделяют ОДИН этот срок и своего бюджета не
// получают.
//
// Это предел ОЖИДАНИЯ, а не отмена: `setAccessLevel` не отменяется и может
// ответить позже. Именно поэтому срабатывание ставит печать — иначе поздний
// успех открыл бы активацию, которой уже отказали.
function tvArmCarrierDeadline() {
  if (tvCarrierDeadline) return tvCarrierDeadline;
  tvCarrierDeadline = new Promise((_, reject) => {
    tvCarrierDeadlineTimer = setTimeout(() => {
      tvCarrierDeadlineTimer = null;
      tvSealCarrier();
      reject(new Error(TV_CARRIER_UNPROTECTED));
    }, TV_CARRIER_TIMEOUT_MS);
  });
  tvCarrierDeadline.catch(() => {});
  return tvCarrierDeadline;
}

function tvDisarmCarrierDeadline() {
  if (tvCarrierDeadlineTimer === null) return;
  clearTimeout(tvCarrierDeadlineTimer);
  tvCarrierDeadlineTimer = null;
}

// То же правило, что у install-барьера: наружу уходит один стабильный текст,
// причина отказа `setAccessLevel` — внутренняя диагностика. Ошибка создаётся
// заново на каждый отказ: один общий экземпляр разошёлся бы стеком по всем
// вызывающим.
//
// Печать проверяется и ПОСЛЕ ожидания: гонка «таймаут и успех в одном такте»
// обязана заканчиваться отказом, а не разрешением.
async function tvAwaitCarrier() {
  if (tvCarrierOpen) return;
  if (tvCarrierSealError) throw new Error(TV_CARRIER_UNPROTECTED);
  // Срок уже идёт со старта активации; здесь его только ЖДУТ, а не заводят.
  // `tvCarrierDeadline` для Firefox и неопознанной платформы пуст — там
  // готовность разрешена сразу, и ждать нечего.
  try {
    await (tvCarrierDeadline ? Promise.race([tvCarrierReady, tvCarrierDeadline]) : tvCarrierReady);
  } catch (_) {
    throw new Error(TV_CARRIER_UNPROTECTED);
  }
  if (tvCarrierSealError) throw new Error(TV_CARRIER_UNPROTECTED);
}

// Секция под барьером install-сброса. Барьер снимается СИНХРОННО, до постановки
// в очередь, а ожидается уже ВНУТРИ секции. Оба свойства обязательны:
//
//   ждать барьер ДО постановки (ревизия 03) — значит пропустить вперёд каждую
//     операцию, вызванную позже: удерживаемый сброс отправлял setter в хвост
//     очереди, и порядок storage переставал совпадать с порядком вызовов;
//   читать tvInstallStatePromise ДИНАМИЧЕСКИ внутри секции — значит ждать
//     сброс, поставленный в очередь ПОЗЖЕ этой секции, то есть за ней самой:
//     взаимоблокировка.
//
// Снимок гарантирует, что ожидаемый сброс стоит в очереди РАНЬШЕ нас и к старту
// секции уже завершён, поэтому ожидание внутри секции всегда мгновенно.
//
// Печать носителя проверяется ДВАЖДЫ, и оба раза обязательны:
//
//   СИНХРОННО, до постановки в очередь — чтобы уже известный отказ отвечал
//     немедленно. Зависший `get`/`remove` в чужой секции блокирует очередь
//     навсегда (отменить storage-операцию нечем), и постановка в хвост
//     превратила бы отказ в вечное ожидание;
//   ВНУТРИ секции — для случая, когда проверка ещё идёт. Ждать её снаружи
//     значило бы ставить секции в очередь не в порядке вызовов.
//
// Готовность носителя от очереди не зависит и уборку не ждёт, поэтому цикла
// «секция ждёт готовность, готовность ждёт секцию» здесь нет.
function tvSessionGuarded(work) {
  if (tvCarrierSealError) return Promise.reject(new Error(TV_CARRIER_UNPROTECTED));
  const barrier = tvInstallStatePromise;
  return tvSessionSection(async () => {
    await tvAwaitCarrier();
    await tvAwaitInstallBarrier(barrier);
    return await work();
  });
}

// Чтение без ожидания install-сброса. Вызывать только ИЗ секции: снаружи это
// несериализованное чтение, а ожидание собственного сброса внутри секции было
// бы взаимоблокировкой.
async function tvReadSession() {
  const { tv_session } = await tvSessionStore().get("tv_session");
  return tvOAuthSession(tv_session);
}

// Публичное чтение сериализовано с записями: потребитель получает
// зафиксированное состояние, а не промежуточное. До ревизии 03 здесь было
// несериализованное чтение — оно могло вернуть сессию, которую выполняющийся
// прямо сейчас logout уже решил удалить.
async function tvGetSession() {
  return await tvSessionGuarded(() => tvReadSession());
}

async function tvSetSession(session) {
  await tvSessionGuarded(async () => {
    tvSessionEpoch++;
    if (session) await tvSessionStore().set({ tv_session: session });
    else await tvSessionStore().remove("tv_session");
    tvSessionRevision++;
  });
}

// Снимок для refresh: оба счётчика и сессия читаются АТОМАРНО в одной секции и
// не увеличиваются. Раздельный снимок был подтверждённым HIGH ревизии 02 — он
// позволял получить уже увеличенный счётчик вместе со старой сессией, которую
// выполняющаяся мутация ещё не успела удалить, и потом пройти сверку в commit.
//
// `flight` передаёт только владелец общего flight; per-caller readback вызывает
// без него. База держателя фиксируется ЗДЕСЬ, синхронно со снимком и ДО чтения
// storage: между присваиванием счётчиков и `flight.base` нет ни одного `await`,
// поэтому база всегда согласована с той же парой epoch/revision.
//
// Ревизия 09 присваивала базу СНАРУЖИ, после успешного `await tvAcquireRefresh()`.
// Отказ первого же `get(tv_session)` оставлял её `null`, и per-caller readback
// терял способность распознать состоявшееся позже изменение: caller получал
// устаревшую storage-ошибку вместо новой сессии или null.
//
// Если install-барьер отклонён, секция отказывает ДО этой строки — база не
// ставится, и sealed остаётся высшим приоритетом.
function tvAcquireRefresh(flight) {
  return tvSessionGuarded(async () => {
    const epoch = tvSessionEpoch;
    const revision = tvSessionRevision;
    if (flight) flight.base = revision;
    return { epoch, revision, session: await tvReadSession() };
  });
}

const TV_REFRESH_FENCED = "Session refresh superseded by a newer session change";

// Единственная авторитетная запись/очистка сессии из refresh. Сверка счётчиков
// и storage-операция — в одной секции, поэтому между ними никакая другая секция
// встать не может.
//
// Решение принимается по ОБОИМ счётчикам снимка, и роли у них разные:
//
//   ЭПОХА решает, можно ли ПИСАТЬ. Фенс обязан отменять запись при любом чужом
//     намерении, даже если то намерение потом не состоялось: пропустить
//     устаревшую запись поверх более нового intent хуже, чем зря её отменить;
//   РЕВИЗИЯ решает, что ВЕРНУТЬ, когда писать нельзя. Отдавать содержимое слота
//     как результат обновления можно только если состоялось настоящее
//     изменение. Иначе в слоте лежит ровно та сессия, с которой refresh
//     начинался, — истёкшая или уже отвергнутая сервером.
//
// Ревизия 08 в этой ветке возвращала `tvReadSession()` безусловно, поэтому
// чужое намерение с ОТКАЗАВШЕЙ записью (failed tvSetSession, failed logout,
// отменённый вход) превращало устаревший credential в успешный результат
// refresh. Теперь такой случай — отказ со стабильным сообщением, без сессии.
async function tvCommitRefresh(epoch, revision, next) {
  return await tvSessionGuarded(async () => {
    if (epoch !== tvSessionEpoch) {
      if (revision !== tvSessionRevision) return await tvReadSession();
      throw new Error(TV_REFRESH_FENCED);
    }
    tvSessionEpoch++;
    if (next) await tvSessionStore().set({ tv_session: next });
    else await tvSessionStore().remove("tv_session");
    tvSessionRevision++;
    return next;
  });
}

// Браузеры могут сохранить storage при удалении и повторной загрузке unpacked
// расширения с тем же стабильным ID. Новый install всегда начинает без сессии;
// обычный update/reload её сохраняет.
//
// Единственная операция БЕЗ барьера — она его и создаёт. Ждать здесь прошлый
// барьер значило бы, что отказавший сброс запрещает следующий, и снять
// fail-closed стало бы нечем. Отказ сброса не застревает в хвосте очереди:
// tvSessionSection гасит его отдельно.
function tvBeginInstallStateReset() {
  tvInstallStatePromise = tvSessionSection(async () => {
    tvSessionEpoch++;
    await tvSessionStore().remove(["tv_session", "tv_oauth_error"]);
    tvSessionRevision++;
  });
  return tvInstallStatePromise;
}

async function tvOAuthRefreshOnce(flight) {
  // Сеть — строго ВНЕ секции: держать очередь на время сетевого запроса значило
  // бы блокировать logout и чтения на всю его длительность.
  // Снимок сам кладёт в держатель РЕВИЗИЮ, а не эпоху: после ОТКАЗА flight
  // вопрос стоит «состоялось ли изменение слота», и отвечать на него может
  // только счётчик состоявшихся изменений.
  const { epoch, revision, session } = await tvAcquireRefresh(flight);
  if (!session?.refresh_token) return null;

  const conf = self.THUMBVAULT_CONFIG;
  const t0 = Date.now();
  const res = await fetch(`${conf.SUPABASE_URL}/auth/v1/token?grant_type=refresh_token`, {
    method: "POST",
    headers: {
      apikey: conf.SUPABASE_ANON_KEY,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ refresh_token: session.refresh_token }),
  });

  if (!res.ok) {
    // Невалидный токен: чистим ровно ту сессию, которую обновляли. Сравнение
    // `refresh_token` для этого больше не нужно и было бы слабее — новый вход
    // может совпасть по токену, а эпохой он отличается всегда.
    if ([400, 401, 403].includes(res.status)) return await tvCommitRefresh(epoch, revision, null);
    throw new Error(`Session refresh temporarily unavailable (${res.status})`);
  }

  const raw = await res.json().catch(() => null);
  const next = tvOAuthSession(raw);
  if (!next) throw new Error("Invalid session refresh response");
  // Срок — по НАШИМ часам от момента запроса: серверный expires_at при часах ПК
  // впереди уже «истёк», и refresh шёл бы перед каждым сообщением.
  const ttl = Number(raw.expires_in);
  if (Number.isFinite(ttl) && ttl > 0) next.expires_at = Math.floor(t0 / 1000) + ttl;

  // Не даём позднему ответу старого refresh перезаписать новый вход или logout.
  return await tvCommitRefresh(epoch, revision, next);
}

// Единственное место, где создаётся общий flight. Держатель публикуется ДО
// создания promise: иначе рано отказавший flight успел бы отработать свой
// `finally` раньше публикации, не снял бы себя и остался бы в переменной уже
// завершённым — следующий вызов переиспользовал бы мёртвый flight.
function tvStartRefreshFlight() {
  const flight = { base: null, promise: null };
  tvOAuthRefreshFlight = flight;
  flight.promise = tvOAuthRefreshOnce(flight).finally(() => {
    if (tvOAuthRefreshFlight === flight) tvOAuthRefreshFlight = null;
  });
  return flight;
}

// Сетевой refresh по-прежнему один на всех, но его результат наружу НЕ отдаётся.
// Возврат общего promise напрямую (ревизия 04) означал, что caller, пришедший
// уже ПОСЛЕ постановки install-сброса, получал доресетную ротированную сессию,
// не пройдя ни новый барьер, ни сериализованное чтение: барьер и секция были
// сняты тем, кто flight начал, — до сброса.
//
// Поэтому каждый caller после общего flight делает СВОЙ guarded readback. Его
// барьер снимается в момент возврата из flight, то есть уже с учётом сброса,
// поставленного в очередь позже: после успешного сброса читается пустой слот
// (null), после отказавшего — секция запечатана.
//
// Readback выполняется и когда flight ОТКАЗАЛ (ревизия 05 делала его только для
// успешного): сетевой отказ refresh и install-сброс — независимые события, и
// отказ сети не отменяет того, что состояние уже авторитетно изменилось. Отдать
// в этом случае старую сетевую ошибку значило бы сказать «обновление не
// удалось, credential прежний» там, где credential уже удалён или слот
// запечатан.
//
// Признак «состояние изменилось» — РЕВИЗИЯ ЗАФИКСИРОВАННОГО, и только она.
// Ревизия 06 сверяла наличие сессии: конкурентный успешный вход оставлял слот
// непустым, и caller получал устаревшую сетевую ошибку вместо новой сессии.
// Ревизия 07 сверяла эпоху намерений — и наступила на зеркальный дефект:
// намерение засчитывалось за факт, поэтому отменённый вход и ОТКАЗАВШАЯ
// storage-операция самого refresh выглядели как «состояние изменилось», и
// caller получал СТАРЫЙ credential как успешный результат.
//
// Сравнивается только `tvSessionRevision`: он растёт исключительно после
// успешного set/remove ключа `tv_session`.
//
// Приоритеты после отказавшего flight:
//   запечатанный барьер — сильнее всего, readback бросает sealed;
//   ревизия изменилась — отдаём authoritative состояние (новая сессия или null
//     после сброса/logout), устаревшую сетевую ошибку отбрасываем;
//   ревизия та же — отдаём ИСХОДНУЮ ошибку: сетевую, storage или фенс из
//     tvCommitRefresh. Старую сессию в этом случае не отдаём никогда: запись не
//     состоялась, и выдавать прежний credential за результат обновления
//     нечестно.
//
// Отказ по фенсу проходит здесь тем же путём, что и все остальные: если между
// фенсом и этим readback успело состояться настоящее изменение, caller получит
// именно его, а не ошибку.
//
// Наружу уходит только session или исходная ошибка: ни эпоха, ни ревизия, ни
// держатель flight вызывающему не видны.
async function tvRefreshSession() {
  const flight = tvOAuthRefreshFlight || tvStartRefreshFlight();
  // Ошибка кладётся в коробку, а не в переменную: `null` и `undefined` — законные
  // значения отказа, и проверять надо факт отказа, а не истинность ошибки.
  let failure = null;
  try {
    await flight.promise;
  } catch (err) {
    failure = { err };
  }
  // Тот же guarded снимок, что берёт сам refresh: одна storage-операция, барьер
  // снимается сейчас — то есть уже с учётом сброса, поставленного позже старта
  // flight, — и счётчики при чтении не двигаются.
  const { revision, session } = await tvAcquireRefresh();
  if (!failure) return session;
  // `base === null` — flight отказал ещё до снимка (например, запечатанный
  // барьер): сравнивать не с чем, исходная ошибка остаётся в силе.
  if (flight.base !== null && revision !== flight.base) return session;
  throw failure.err;
}

async function tvValidSession() {
  const session = await tvGetSession();
  if (!session) return null;
  const now = Math.floor(Date.now() / 1000);
  if (!session.expires_at || now >= session.expires_at - 60) return await tvRefreshSession();
  return session;
}

const TV_LOGOUT_MAX_ATTEMPTS = 3;

// Повторяем только то, что реально может пройти со второй попытки. Обычные 4xx
// (в том числе 401/403) — окончательный ответ сервера, повтор его не изменит.
function tvLogoutRetryable(status) {
  return status === 408 || status === 429 || status >= 500;
}

function tvLogoutReason(status) {
  if (status === 401 || status === 403) return "unauthorized";
  if (status === 429) return "rate_limited";
  if (status >= 500) return "server_error";
  return "unexpected_status";
}

// Возвращает маленький стабильный результат: без токенов, без тела ответа и без
// сырой диагностики — его показывает popup. localCleared всегда true и означает
// ровно одно: захваченная этой секцией старая сессия удалена до первого
// сетевого вызова и назад не возвращается. Это НЕ обещание, что storage потом
// останется пустым — новый вход, начатый после секции, законно его наполняет.
async function tvSignOutSession() {
  // Чтение сессии и её удаление — одна неделимая критическая секция. Новый
  // вход, начатый после этой строки, встанет в очередь ПОСЛЕ неё, поэтому
  // logout не может ни удалить его сессию, ни отозвать его credential:
  // отзывается ровно тот токен, который прочитан здесь, внутри секции.
  // Дальше в storage не пишем вообще. После отказавшего install-сброса секция
  // отказывает до чтения — старый credential не читается и не отзывается.
  const session = await tvSessionGuarded(async () => {
    tvSessionEpoch++;
    const current = await tvReadSession();
    await tvSessionStore().remove("tv_session");
    tvSessionRevision++;
    return current;
  });

  const accessToken = session?.access_token || "";
  if (!accessToken) {
    return { localCleared: true, remoteRevoked: false, hadSession: false, attempts: 0, reason: "no_session" };
  }

  const conf = self.THUMBVAULT_CONFIG;
  // scope=local: web и public/admin расширения держат независимые сессии,
  // global выкинул бы пользователя со всех поверхностей сразу.
  const url = `${conf.SUPABASE_URL}/auth/v1/logout?scope=local`;
  // Короткий ограниченный retry без задержек и фоновых job: credential живёт
  // только в этой функции, поэтому тянуть его дольше нечем и незачем.
  let attempts = 0;
  let reason = "network";

  while (attempts < TV_LOGOUT_MAX_ATTEMPTS) {
    attempts++;
    let res;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: {
          apikey: conf.SUPABASE_ANON_KEY,
          Authorization: `Bearer ${accessToken}`,
        },
      });
    } catch (_) {
      reason = "network";
      continue;
    }
    if (res.ok) {
      return { localCleared: true, remoteRevoked: true, hadSession: true, attempts, reason: "revoked" };
    }
    reason = tvLogoutReason(res.status);
    if (!tvLogoutRetryable(res.status)) break;
  }

  return { localCleared: true, remoteRevoked: false, hadSession: true, attempts, reason };
}

const TV_SIGN_IN_SUPERSEDED = "Sign-in superseded by a newer session change";

async function tvOAuthSignIn(clientId) {
  // Intent входа. Секция ставится СИНХРОННО первым действием — до PKCE, до
  // launchWebAuthFlow и до exchange, — и двигает ЭПОХУ намерений. Дальше intent
  // работает как заявка: любая более поздняя авторитетная операция (logout,
  // install-сброс, другой вход) двигает эпоху ещё раз и тем самым отменяет этот
  // flow.
  //
  // Ревизия 04 фиксировала вход только в момент commit, поэтому поздний
  // результат обгонял решение, принятое ПОСЛЕ его старта: логин, начатый до
  // logout, записывал сессию обратно, а начатый до install-сброса — отменял
  // сброс.
  //
  // Ревизию зафиксированного intent НЕ двигает: намерение войти — ещё не
  // изменение слота. Ревизия 07 не различала эти вещи, поэтому отменённый или
  // отказавший вход выглядел для отказавшего refresh как состоявшаяся запись.
  //
  // Она же — fail-closed до сети: в запечатанном состоянии секция отказывает,
  // и новый credential не выпускается вовсе.
  //
  // К барьеру добавлена проверка САМОГО НОСИТЕЛЯ, и именно здесь, внутри той же
  // первой секции. Ревизия 02 закрывала неопределённую платформу только в
  // операциях слота: вход же доходил до `launchWebAuthFlow` и `exchange` и
  // обнаруживал недоступность области лишь на commit. То есть браузер открывал
  // окно авторизации, сервер выпускал одноразовый код и создавал сессию — при
  // уже известной невозможности сохранить результат
  // (CODEX-EXT-FIREFOX-IMPLEMENTATION-REVIEW-01, Revision 02, остаток R1).
  //
  // Порядок обязателен: `tvSessionStore()` бросает ДО инкремента, поэтому
  // отказавший вход не двигает эпоху и ничью чужую запись не отменяет —
  // намерения, способного что-то записать, здесь так и не возникло. Постановка
  // секции, install-барьер и сам инкремент остались на прежних местах.
  const intent = await tvSessionGuarded(async () => {
    tvSessionStore();
    return ++tvSessionEpoch;
  });

  const verifier = tvOAuthRandomToken(64);
  const state = tvOAuthRandomToken(32);
  const challenge = await tvOAuthChallenge(verifier);
  const redirectUri = chrome.identity.getRedirectURL("auth");
  const connectUrl = tvOAuthSiteUrl();
  connectUrl.search = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
  }).toString();

  try {
    const responseUrl = new URL(await tvOAuthLaunch(connectUrl.href));
    const expectedUrl = new URL(redirectUri);
    if (responseUrl.origin !== expectedUrl.origin || responseUrl.pathname !== expectedUrl.pathname) {
      throw new Error("Invalid authorization redirect");
    }
    if (responseUrl.searchParams.get("state") !== state) throw new Error("Authorization state mismatch");
    const remoteError = responseUrl.searchParams.get("error");
    if (remoteError) throw new Error(`Authorization failed: ${remoteError}`);
    const code = responseUrl.searchParams.get("code") || "";
    if (!/^[A-Za-z0-9_-]{32,256}$/.test(code)) throw new Error("Invalid authorization code");

    const conf = self.THUMBVAULT_CONFIG;
    const t0 = Date.now();
    const exchange = await fetch(`${conf.SUPABASE_URL}/functions/v1/exchange`, {
      method: "POST",
      headers: { apikey: conf.SUPABASE_ANON_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({
        code,
        code_verifier: verifier,
        client_id: clientId,
        redirect_uri: redirectUri,
      }),
    });
    const payload = await exchange.json().catch(() => ({}));
    if (!exchange.ok) throw new Error(`Authorization failed: ${payload.error || exchange.status}`);
    const session = tvOAuthSession(payload);
    if (!session) throw new Error("Invalid session response");
    // Как в refresh: срок от локального времени запроса, а не от часов сервера.
    const ttl = Number(payload.expires_in);
    if (Number.isFinite(ttl) && ttl > 0) session.expires_at = Math.floor(t0 / 1000) + ttl;
    // Авторитетный commit: сверка intent, снятие старой ошибки входа и запись
    // сессии — ОДНА сериализованная секция. Сериализованная, но не атомарная:
    // storage-операции внутри неё могут отказать по отдельности, поэтому важен
    // ПОРЯДОК.
    //
    //   ошибка снимается ПЕРВОЙ — её отказ оставляет слот ровно таким, каким он
    //     был, и новый credential не появляется;
    //   оба счётчика двигаются ПОСЛЕДНИМИ, только после успешной записи сессии.
    //
    // Ревизия 05 делала наоборот (счётчик → set(session) → remove(error)):
    // отказ последнего remove возвращал ошибку входа, хотя credential уже лежал
    // в storage, а сдвинутый счётчик делал intent устаревшим, и catch не имел
    // права ни исправить состояние, ни записать диагностику. Пока эпоха не
    // сдвинута, intent остаётся текущим и catch отрабатывает как при любом
    // другом отказе входа.
    //
    // Эпоху здесь двигать обязательно: снимок refresh, взятый МЕЖДУ intent и
    // commit, имеет ту же эпоху, что и intent, и без этого инкремента поздний
    // commit refresh перезаписал бы только что сохранённый вход.
    //
    // Другая секция между этими шагами встать не может: очередь пропускает
    // следующую секцию только после того, как эта завершила все свои
    // storage-операции.
    const committed = await tvSessionGuarded(async () => {
      if (intent !== tvSessionEpoch) return false;
      await tvSessionStore().remove("tv_oauth_error");
      await tvSessionStore().set({ tv_session: session });
      tvSessionRevision++;
      tvSessionEpoch++;
      return true;
    });
    if (!committed) throw new Error(TV_SIGN_IN_SUPERSEDED);
    return session;
  } catch (err) {
    // Ошибка привязана к тому же intent: устаревший flow не имеет права
    // положить свой отказ поверх более нового успешного входа. Сам отказ записи
    // диагностики причину падения не подменяет.
    await tvSessionGuarded(async () => {
      if (intent !== tvSessionEpoch) return;
      await tvSessionStore().set({ tv_oauth_error: err.message || String(err) });
    }).catch(() => {});
    throw err;
  }
}

// Слот диагностики входа живёт в той же области и в той же очереди, что и
// сессия: popup не должен знать, где он лежит, и не читает storage сам.
// Наружу уходит только текст ошибки, ограниченный по длине.
async function tvGetOAuthError() {
  return await tvSessionGuarded(async () => {
    const { tv_oauth_error } = await tvSessionStore().get("tv_oauth_error");
    return typeof tv_oauth_error === "string" ? tv_oauth_error.slice(0, 500) : "";
  });
}

async function tvClearOAuthError() {
  await tvSessionGuarded(async () => {
    await tvSessionStore().remove("tv_oauth_error");
  });
}

self.tvOAuthSignIn = tvOAuthSignIn;
self.tvGetSession = tvGetSession;
self.tvSetSession = tvSetSession;
self.tvRefreshSession = tvRefreshSession;
self.tvValidSession = tvValidSession;
self.tvSignOutSession = tvSignOutSession;
self.tvBeginInstallStateReset = tvBeginInstallStateReset;
self.tvGetOAuthError = tvGetOAuthError;
self.tvClearOAuthError = tvClearOAuthError;
self.TV_SESSION_AREA = TV_SESSION_AREA;

// --------------------------------------------------------------- готовность
//
// refresh_token остаётся только в доверенных страницах расширения и service
// worker. В Firefox это обеспечивает сам выбор области (`storage.session`
// закрыт content script'ам по построению, см. заголовок раздела «носитель»), в
// Chrome — ТОЛЬКО успешный `setAccessLevel` на `storage.local`: по умолчанию
// эта область content script'ам открыта.
//
// Прежний код вызывал метод и результата не ждал. Отсутствие метода, синхронный
// throw и отклонённый promise подавлялись одинаково, поэтому новый
// refresh_token ложился в открытую область, а признаков этого не было
// (`security/receipts/CLAUDE-PUBLIC-PUB07-DESIGN-01.md`, probe P1–P3).
//
// Проверяются ВСЕ исходы, а не только отсутствие метода. До Chrome 140 метод на
// прототипе есть, но `setAccessLevel` для любой области, кроме `session`,
// ОТВЕРГАЕТСЯ (`139.0.7258.66 extensions/browser/api/storage/storage_api.cc`,
// enforcement только для session; с 140 проверка распространяется и на `local`).
// «Метода нет» — неточная модель Chrome <140, поэтому reject обязателен наравне
// с missing (CODEX-PUBLIC-PUB07-DESIGN-REVIEW-01, первичные источники).
//
// ВАЖНО о пределе обещания: до первого успешного вызова на данном профиле
// область открыта, и уже лежащий там слот предыдущего запуска этот код защитить
// задним числом не может. Он может только не добавить новую запись и попытаться
// убрать старую — см. аварийную уборку ниже.
//
// Одна проверка на активацию, и ОДИН предел ожидания на активацию.
//
// Предел заводится на старте активации (`tvArmCarrierDeadline`, вызов ниже) и
// снимается завершением проверки.
//
// ponytail: 3000 ms — потолок ожидания, а не измеренная latency IPC. Ждёт его
// только ПЕРВАЯ credential-операция активации; если окажется мало, поднимать
// здесь, в одном месте.
const TV_CARRIER_TIMEOUT_MS = 3000;

// Аварийный revoke — не пользовательский logout. У `tvSignOutSession` нет ни
// AbortSignal, ни предела длительности: ограничение числа попыток длительность
// не ограничивает, и при зависшем `fetch` он остаётся pending неограниченно
// (CODEX-PUBLIC-PUB07-DESIGN-REVIEW-01, probe C1). Поэтому у уборки свои
// границы, а обычный logout не меняется.
const TV_CARRIER_REVOKE_BUDGET_MS = 4000;
const TV_CARRIER_REVOKE_MAX_ATTEMPTS = 2;

// Однократная аварийная уборка старого слота. Запускается ровно один раз на
// активацию, из `tvSealCarrier`, и никем не ожидается: отказ UI обязан
// уходить немедленно, а не после сети.
//
// Обходит она РОВНО ОДИН барьер — свой собственный, барьер носителя: иначе
// печать запрещала бы собственную уборку.
//
// Install-барьер уборка СОБЛЮДАЕТ, как любая другая операция со слотом. Раньше
// она шла через `tvSessionSection` напрямую, и это было расхождение с контрактом:
// после отказавшего install-сброса уборка читала старый credential, удаляла его
// и отправляла в logout (REVIEW-01, F2). Прежнее правило запрещает не только
// ВЫДАВАТЬ такой credential вызывающему — оно запрещает его читать и отзывать.
// Сохранённого rejected promise для этого недостаточно; нужно его дождаться.
//
// Дисциплина та же, что у `tvSessionGuarded`, и оба её свойства обязательны:
// снимок барьера берётся СИНХРОННО, до постановки в очередь, а ожидание идёт
// ВНУТРИ секции. Динамическое чтение `tvInstallStatePromise` внутри секции
// означало бы ожидание сброса, поставленного в очередь ПОЗЖЕ уборки, — то есть
// ожидание будущей секции той же очереди и взаимоблокировку.
//
// Отсюда поведение по случаям:
//   сброс уже отказал      → уборка отказывает ДО чтения: ни read, ни remove,
//                            ни revoke, отдельный честный исход;
//   сброс ещё в очереди    → он стоит РАНЬШЕ уборки и к её старту завершён:
//                            успех — слот уже пуст и отзывать нечего, отказ —
//                            уборка отказывает;
//   сброс поставлен ПОЗЖЕ  → снимок уборки его не видит, уборка идёт своим
//                            чередом и ничего не ждёт.
//
// Через очередь секций уборка при этом ПРОХОДИТ: чтение и удаление слота
// сериализованы с остальными storage-операциями.
//
// Остаточный риск назван прямо: если отказали ОБА барьера, старый credential
// остаётся в потенциально открытой области. Расширение отказывается им
// пользоваться, но сделать его нечитаемым не может.
function tvBeginCarrierCleanup() {
  if (tvCarrierCleanup) return tvCarrierCleanup;
  // Снимок берётся здесь, синхронно с решением запустить уборку, — до любого
  // `await` и до постановки секции в очередь.
  tvCarrierCleanup = tvRunCarrierCleanup(tvInstallStatePromise);
  // Никто её не ждёт — гасим unhandled rejection здесь же.
  tvCarrierCleanup.catch(() => {});
  return tvCarrierCleanup;
}

// Три шага — три РАЗДЕЛЬНЫХ исхода. Слияние их в один флаг и было дефектом
// класса «localCleared всегда true»: отказ удаления нельзя выдавать за очистку,
// а неудачное чтение — за отозванный на сервере токен.
async function tvRunCarrierCleanup(installBarrier) {
  const outcome = {
    read: "failed",
    localCleared: false,
    remoteRevoked: false,
    attempts: 0,
    reason: "not_attempted",
  };

  let session;
  let installSealed = false;
  try {
    session = await tvSessionSection(async () => {
      // Снятый СНАРУЖИ снимок install-барьера ожидается ЗДЕСЬ, внутри секции.
      // Отказ означает: ничего не читаем, ничего не удаляем, ничего не отзываем.
      try {
        await installBarrier;
      } catch (_) {
        installSealed = true;
        throw new Error(TV_SESSION_SEALED);
      }
      // Порядок как у logout: эпоха двигается ДО storage-операции (намерение),
      // ревизия — ТОЛЬКО после состоявшегося удаления.
      tvSessionEpoch++;
      const current = await tvReadSession();
      // Отказ удаления не отменяет того, что credential уже прочитан: ниже он
      // ещё может быть отозван на сервере. Поэтому отказ гасится здесь, а не
      // роняет секцию, и `localCleared` остаётся false.
      try {
        await tvSessionStore().remove("tv_session");
        tvSessionRevision++;
        outcome.localCleared = true;
      } catch (_) {
        outcome.localCleared = false;
      }
      outcome.read = current ? "session" : "empty";
      return current;
    });
  } catch (_) {
    // Две разные причины — два разных исхода, и ни в одном из них не заявляются
    // ни очистка, ни серверный отзыв:
    //   install-печать — credential НЕ читался вовсе, и это запрет, а не сбой;
    //   отказ storage  — что лежит в слоте, неизвестно.
    outcome.read = installSealed ? "not_read" : "failed";
    outcome.reason = installSealed ? "install_sealed" : "read_failed";
    return outcome;
  }

  const accessToken = session?.access_token || "";
  if (!accessToken) {
    outcome.reason = "no_session";
    return outcome;
  }

  const conf = self.THUMBVAULT_CONFIG;
  // scope=local, как и в обычном logout: global выкинул бы пользователя со всех
  // поверхностей сразу. Refresh здесь не делается вообще — отзывается ровно тот
  // токен, который прочитан выше.
  const url = `${conf.SUPABASE_URL}/auth/v1/logout?scope=local`;
  const controller = new AbortController();
  const budget = setTimeout(
    () => controller.abort(new Error("Cleanup revoke budget expired")),
    TV_CARRIER_REVOKE_BUDGET_MS
  );
  try {
    while (outcome.attempts < TV_CARRIER_REVOKE_MAX_ATTEMPTS) {
      outcome.attempts++;
      let res;
      try {
        res = await fetch(url, {
          method: "POST",
          headers: {
            apikey: conf.SUPABASE_ANON_KEY,
            Authorization: `Bearer ${accessToken}`,
          },
          signal: controller.signal,
        });
      } catch (_) {
        // Истёкший бюджет — конец, а не повод для следующей попытки.
        if (controller.signal.aborted) {
          outcome.reason = "timeout";
          break;
        }
        outcome.reason = "network";
        continue;
      }
      if (res.ok) {
        outcome.remoteRevoked = true;
        outcome.reason = "revoked";
        break;
      }
      outcome.reason = tvLogoutReason(res.status);
      if (!tvLogoutRetryable(res.status)) break;
    }
  } finally {
    clearTimeout(budget);
  }
  // Ни токена, ни тела ответа: исход — только флаги, счётчик и стабильный код.
  return outcome;
}

function tvSealCarrier() {
  if (tvCarrierSealError) return;
  tvCarrierSealError = new Error(TV_CARRIER_UNPROTECTED);
  tvBeginCarrierCleanup();
}

// Firefox и неопознанная платформа сюда не заходят: в первом случае область
// закрыта по построению и звать нечего, во втором `tvSessionStore()` уже
// закрывает всё со своим прежним сообщением — подменять его здесь незачем.
// Синхронно решённый исход не нуждается в сроке: ждать уже нечего. Флаг ставят
// только ТОЧНО синхронные ветки ниже — угадывания микротасков здесь нет.
let tvCarrierDecidedSync = false;

const tvCarrierReady = TV_SESSION_AREA === "local"
  ? new Promise((resolve, reject) => {
      const area = chrome.storage.local;
      // Отсутствующий метод и отвергнутый вызов — РАЗНЫЕ наблюдения одного
      // исхода, и оба обязательны: до Chrome 140 метод есть, но эту область не
      // принимает.
      if (!area || typeof area.setAccessLevel !== "function") {
        tvCarrierDecidedSync = true;
        reject(new Error(TV_CARRIER_UNPROTECTED));
        return;
      }
      // Ответ подписывается НАПРЯМУЮ, без `Promise.resolve(...)`. Обёртка над
      // чужим thenable добавляет такт ассимиляции, и штатный путь начинал
      // платить за него пределом ожидания: секция очереди успевала дойти до
      // проверки раньше, чем готовность отмечала успех.
      let call;
      try {
        call = area.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" });
      } catch (_) {
        tvCarrierDecidedSync = true;
        reject(new Error(TV_CARRIER_UNPROTECTED));
        return;
      }
      // Реализация обязана вернуть thenable. Если вернула что-то другое —
      // подтверждения защиты у нас нет, и молча считать её включённой нельзя.
      if (!call || typeof call.then !== "function") {
        tvCarrierDecidedSync = true;
        reject(new Error(TV_CARRIER_UNPROTECTED));
        return;
      }
      call.then(resolve, reject);
    })
  : Promise.resolve();

// Срок заводится ЗДЕСЬ, на старте активации, а не при первом вызывающем: иначе
// зависшая проверка без единого credential-вызова не привела бы ни к печати, ни
// к уборке (REVIEW-01, F1). Для Firefox и неопознанной платформы проверки нет —
// там и срока нет.
//
// Срок не нужен там, где исход УЖЕ решён синхронно (метода нет, вызов бросил,
// вернул не-thenable): ждать нечего, печать ставится сразу.
//
// Для настоящего асинхронного вызова срок заводится безусловно. Сэкономить
// таймер и на успехе можно было бы только угадыванием числа микротасков до
// разрешения promise; это ненадёжно (в чужом realm тактов больше), а цена
// ошибки — ровно потерянный срок из F1. Поэтому такой таймер заводится честно,
// снимается завершением проверки и так же честно учитывается в тестах.
if (TV_SESSION_AREA === "local" && !tvCarrierDecidedSync) tvArmCarrierDeadline();

tvCarrierReady.then(
  () => {
    tvDisarmCarrierDeadline();
    if (!tvCarrierSealError) tvCarrierOpen = true;
  },
  () => {
    tvDisarmCarrierDeadline();
    tvSealCarrier();
  }
);

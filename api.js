// Помощники доступа к данным для расширения (поверх SB.rest).
// Используются и на YouTube, и на Pinterest.

const TV_LIMITS = {
  collectionName: 80,
  url: 2048,
  channelName: 160,
  note: 1000,
};

function tvCleanText(value, max = 200) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, max);
}

function tvCleanNote(value) {
  return String(value || "").replace(/\r\n?/g, "\n").slice(0, TV_LIMITS.note);
}

// Legacy rows can predate the canonical limit. Reads must preserve the complete
// value so the panel can distinguish an unchanged legacy note from an explicit
// edit; truncation is only valid at a new-write boundary.
function tvReadNote(value) {
  return String(value || "").replace(/\r\n?/g, "\n");
}

const TV_UUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

// Один срок на весь необязательный snapshot (PUB-06). Значение — выбранный
// default этого пакета, а не измеренная production-latency и не внешний SLA.
// Зеркало этой же константы живёт в background.js: worker не импортирует api.js.
const TV_SNAPSHOT_BUDGET_MS = 5000;
const TV_SNAPSHOT_DONE = Symbol("snapshot-done");
const TV_SNAPSHOT_EXPIRED = Symbol("snapshot-expired");

function tvNormalizeVideoId(videoId) {
  const id = tvCleanText(videoId, 32);
  return /^[A-Za-z0-9_-]{11}$/.test(id) ? id : "";
}

function tvNormalizeChannelId(channelId) {
  const id = tvCleanText(channelId, 32);
  return /^UC[A-Za-z0-9_-]{22}$/.test(id) ? id : "";
}

function tvUrl(value, allowedHosts) {
  const raw = tvCleanText(value, TV_LIMITS.url);
  if (!raw) return "";
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:") return "";
    const host = url.hostname.toLowerCase();
    const allowed = allowedHosts.some((allowedHost) => (
      host === allowedHost || host.endsWith(`.${allowedHost}`)
    ));
    return allowed ? url.href.slice(0, TV_LIMITS.url) : "";
  } catch {
    return "";
  }
}

function tvNormalizeThumbPayload({ video_id, img_url, source_url }) {
  const cleanVideoId = video_id ? tvNormalizeVideoId(video_id) : "";
  if (video_id && !cleanVideoId) throw new Error("Invalid YouTube video id");

  const imageUrl = cleanVideoId
    ? tvUrl(img_url, ["i.ytimg.com"])
    : tvUrl(img_url, ["i.pinimg.com"]);
  if (!imageUrl) throw new Error("Invalid image URL");

  const sourceUrl = cleanVideoId
    ? tvUrl(source_url, ["youtube.com"])
    : tvUrl(source_url, ["pinterest.com", "pinterest.ru"]);
  if (!sourceUrl) throw new Error("Invalid source URL");

  return {
    video_id: cleanVideoId,
    img_url: imageUrl,
    source_url: sourceUrl,
  };
}

const API = {
  // Список папок пользователя (RLS сам отфильтрует чужие).
  async getCollections() {
    return await SB.rest("collections?select=id,name&order=name.asc");
  },

  async getTags() {
    return await SB.rest("tags?select=id,name&order=name.asc");
  },

  // Создать папку. Если такая уже есть (unique user_id,name) — вернуть существующую.
  async createCollection(name) {
    name = tvCleanText(name, TV_LIMITS.collectionName);
    if (!name) throw new Error("Invalid collection name");
    const uid = await SB.userId();
    try {
      const rows = await SB.rest("collections", {
        method: "POST",
        headers: { Prefer: "return=representation" },
        body: JSON.stringify({ user_id: uid, name }),
      });
      return rows[0];
    } catch (e) {
      const existing = await SB.rest(
        `collections?select=id,name&name=eq.${encodeURIComponent(name)}`
      );
      if (existing[0]) return existing[0];
      throw e;
    }
  },

  async createTag(name) {
    name = tvCleanText(name, TV_LIMITS.collectionName);
    if (!name) throw new Error("Invalid tag name");
    const uid = await SB.userId();
    try {
      const rows = await SB.rest("tags", {
        method: "POST",
        headers: { Prefer: "return=representation" },
        body: JSON.stringify({ user_id: uid, name }),
      });
      return rows[0];
    } catch (e) {
      const existing = await SB.rest(`tags?select=id,name&name=eq.${encodeURIComponent(name)}`);
      if (existing[0]) return existing[0];
      throw e;
    }
  },

  // Найти обложку по video_id (YouTube). Вернёт { id, collectionIds } или null.
  async findThumbnailByVideoId(videoId) {
    const rows = await SB.rest(
      `thumbnails?select=id,note,thumbnail_collections(collection_id),thumbnail_tags(tag_id)&video_id=eq.${encodeURIComponent(videoId)}`
    );
    return rows[0] ? unpack(rows[0]) : null;
  },

  // Найти обложку по прямой ссылке на картинку (Pinterest).
  async findThumbnailByImg(imgUrl) {
    const rows = await SB.rest(
      `thumbnails?select=id,note,thumbnail_collections(collection_id),thumbnail_tags(tag_id)&img_url=eq.${encodeURIComponent(imgUrl)}`
    );
    return rows[0] ? unpack(rows[0]) : null;
  },

  // Сохранить обложку и вернуть её строку (с id).
  // YouTube — upsert по (user_id, video_id), повтор не плодит дубли.
  // Pinterest (без video_id) — обычная вставка.
  async saveThumbnail({ video_id, img_url, source_url, note }) {
    const clean = tvNormalizeThumbPayload({ video_id, img_url, source_url });
    const uid = await SB.userId();
    const body = {
      user_id: uid,
      img_url: clean.img_url,
      source_url: clean.source_url,
      note: tvCleanNote(note),
    };
    if (clean.video_id) {
      body.video_id = clean.video_id;
      const rows = await SB.rest("thumbnails?on_conflict=user_id,video_id", {
        method: "POST",
        headers: { Prefer: "resolution=merge-duplicates,return=representation" },
        body: JSON.stringify(body),
      });
      return rows[0];
    }
    const rows = await SB.rest("thumbnails", {
      method: "POST",
      headers: { Prefer: "return=representation" },
      body: JSON.stringify(body),
    });
    return rows[0];
  },

  // Узкое обновление заметки УЖЕ существующей строки (PUB-02). Раньше панель на
  // изменённую заметку звала `saveThumbnail`, и для Pinterest (нет video_id, нет
  // upsert) это был INSERT: заметка уезжала на новую строку, а неизменённые
  // папки/теги оставались на старой. Здесь правится ровно одна своя строка по
  // её id, одним полем; создание новых референсов по-прежнему делает
  // `saveThumbnail`, и фолбэка на INSERT при отказе тут нет и быть не должно.
  //
  // Заметка НЕ усекается: тихий slice на границе записи — это потеря текста без
  // ведома пользователя. Сверх лимита — отказ (панель проверяет длину до сохранения).
  // Право на запись остаётся за сервером: RLS `own thumbnails update` и CHECK
  // `thumbnails_note_max_1000` (даже NOT VALID, он проверяет обновляемые строки).
  async updateThumbnailNote(thumbnailId, note) {
    const id = String(thumbnailId || "");
    if (!TV_UUID.test(id)) throw new Error("Invalid thumbnail id");
    const text = tvReadNote(note);
    if (text.length > TV_LIMITS.note) throw new Error("Note too long");
    const rows = await SB.rest(`thumbnails?id=eq.${id}&select=id`, {
      method: "PATCH",
      headers: { Prefer: "return=representation" },
      body: JSON.stringify({ note: text }),
    });
    // Ноль строк — штатный ответ PostgREST, когда строка не прошла RLS `using`
    // (чужая или удалённая). Это отказ, а не «обновили, просто нечего сказать».
    const row = Array.isArray(rows) ? rows[0] : null;
    if (!row || row.id !== id) throw new Error("Note update not confirmed");
    return { id: row.id };
  },

  // Снимок просмотров/названия/канала через Edge Function (точные цифры с YouTube,
  // один раз в момент сохранения). Best-effort: ошибка тут не должна ронять сохранение.
  //
  // PUB-06: обложка и связи к этому моменту УЖЕ сохранены, поэтому весь
  // необязательный шаг ограничен ОДНИМ сроком `TV_SNAPSHOT_BUDGET_MS` от входа
  // сюда — не по сроку на этап и не по сроку на попытку.
  //
  // Срок вычисляется здесь как КОНЕЧНЫЙ момент и передаётся фону метаданными
  // конверта: фон ждёт только остаток и не заводит себе свежие пять секунд.
  // Иначе задержка доставки сообщения растягивала общий срок — просроченный
  // вызов успевал уйти в сеть уже после того, как панель закрылась
  // (CODEX-PUBLIC-PUB06-REVIEW-01.md, F1). Таймер ниже остаётся: он закрывает
  // случай, когда ответа messaging не будет вовсе — остановленный MV3 worker
  // или осиротевший канал иначе держали бы панель бесконечно.
  //
  // Предварительный `SB.getSession()` убран намеренно: фон и так проверяет
  // сессию перед вызовом и отвечает «Not signed in», а лишний round-trip был
  // ещё одним неограниченным этапом с тем же наблюдаемым итогом (false).
  async snapshotStats(videoId) {
    if (!videoId) return false;
    const deadline = Date.now() + TV_SNAPSHOT_BUDGET_MS;
    let timer = null;
    try {
      const expired = new Promise((resolve) => {
        timer = setTimeout(() => resolve(TV_SNAPSHOT_EXPIRED), Math.max(0, deadline - Date.now()));
      });
      // Конверт собирается здесь, а не в `SB.invokeFunction`: `supabase.js`
      // побайтово общий с admin-сборкой (инвариант «public и admin используют
      // один эквивалентный logout-контракт» в logout-revoke.test.mjs), и класть
      // в общий helper поле, нужное только snapshot, нельзя. Маршрут, проверка
      // отправителя и форма ответа те же самые — `tv:sb-function`; `deadline`
      // остаётся метаданными конверта и в тело Edge-запроса не попадает.
      //
      // Отказ превращается в значение: поздний ответ или поздний reject после
      // истечения срока уже обработан и не станет unhandled rejection.
      const call = SB._send({ type: "tv:sb-function", name: "refresh-views", body: { video_id: videoId }, deadline })
        .then(() => TV_SNAPSHOT_DONE, (error) => error);
      const outcome = await Promise.race([call, expired]);
      if (outcome === TV_SNAPSHOT_DONE) return true;
      console.error("Thumb Sight snapshotStats:", outcome === TV_SNAPSHOT_EXPIRED ? "snapshot budget expired" : outcome);
      return false;
    } catch (e) {
      console.error("Thumb Sight snapshotStats:", e);
      return false;
    } finally {
      clearTimeout(timer);
    }
  },

  // Добавить канал в отслеживаемые (со страницы канала). upsert по (user_id, channel_id).
  async saveChannel({ channel_id, name, avatar }) {
    channel_id = tvNormalizeChannelId(channel_id);
    if (!channel_id) throw new Error("Invalid YouTube channel id");
    name = tvCleanText(name, TV_LIMITS.channelName);
    avatar = tvUrl(avatar, ["yt3.ggpht.com", "googleusercontent.com"]);
    const existing = await SB.rest(
      `channels?select=id&channel_id=eq.${encodeURIComponent(channel_id)}&limit=1`
    );
    if (existing?.[0]) return { created: false, row: existing[0] };

    const uid = await SB.userId();
    try {
      await SB.rest("channels?on_conflict=user_id,channel_id", {
        method: "POST",
        headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
        body: JSON.stringify({ user_id: uid, channel_id, name: name || "", avatar: avatar || "" }),
      });
      return { created: true };
    } catch (e) {
      const afterRace = await SB.rest(
        `channels?select=id&channel_id=eq.${encodeURIComponent(channel_id)}&limit=1`
      );
      if (afterRace?.[0]) return { created: false, row: afterRace[0] };
      throw e;
    }
  },

  async deleteThumbnail(thumbnailId) {
    const id = tvCleanText(thumbnailId, 80);
    if (!id) throw new Error("Invalid thumbnail id");
    await SB.rest(`thumbnails?id=eq.${encodeURIComponent(id)}`, {
      method: "DELETE",
      headers: { Prefer: "return=minimal" },
    });
  },

  // Перезаписать наборы папок и тегов обложки ОДНИМ вызовом проверенного RPC.
  // Раньше это были две неатомарные пары DELETE→POST: успешный DELETE и упавший
  // POST уничтожали набор без пути починки (A-1/A-2/A-3), а вторая сторона связи
  // вообще не проверялась на владение (SEC-1). Оба набора уходят вместе — два
  // параллельных вызова сериализовались бы на одном parent lock.
  //
  // `null` (и отсутствующий ключ) — «не менять этот набор», `[]` — «очистить».
  async replaceThumbnailLinks(thumbnailId, { collectionIds = null, tagIds = null } = {}) {
    if (collectionIds === null && tagIds === null) return null;
    const result = await SB.rest("rpc/replace_thumbnail_links", {
      method: "POST",
      body: JSON.stringify({
        p_thumbnail_id: thumbnailId,
        p_collection_ids: collectionIds,
        p_tag_ids: tagIds,
      }),
    });
    return tvConfirmLinks(result, collectionIds, tagIds);
  },
};

// Функция сама сообщает, какие наборы она заменила. Пустой ответ успехом не
// считается: `ALTER FUNCTION … STRICT` сохраняет имя, тело, гранты и posture, но
// превращает штатный вызов с одним `null` в `200` + `null` без единой записи
// (CLAUDE-JUNCTION-OWNERSHIP-ATOMIC-J1-01.md §R4.2). Фолбэка на прямую запись
// здесь нет и быть не должно — отказ обязан дойти до вызывающего.
function tvConfirmLinks(result, collectionIds, tagIds) {
  const reported = (asked, value) => (asked === null ? value === null : typeof value === "number");
  if (!result || typeof result !== "object"
      || !reported(collectionIds, result.collections)
      || !reported(tagIds, result.tags)) {
    throw new Error("Link replacement not confirmed");
  }
  return result;
}

function unpack(row) {
  return {
    id: row.id,
    note: tvReadNote(row.note),
    collectionIds: (row.thumbnail_collections || []).map((x) => x.collection_id),
    tagIds: (row.thumbnail_tags || []).map((x) => x.tag_id),
  };
}

window.API = API;

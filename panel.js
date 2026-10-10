// Приватный mutating UI: данные и финальные действия остаются в extension-origin.
const $ = (id) => document.getElementById(id);
const NOTE_MAX = 1000;

let tvIntent = null;
let tvDeleteAction = null;
let tvFinishState = null;
let tvLanguageRerender = null;
const tvT = (key) => TVI18N.t(key);

function tvShow(id, visible) { $(id)?.classList.toggle("tv-hidden", !visible); }
function tvClosePanel() {
  if (window.parent !== window) {
    window.parent.postMessage({ type: "tv:panel-close" }, "*");
    return;
  }
  window.close();
}
function tvFinish(titleKey, noteKey, isError = true) {
  tvFinishState = { titleKey, noteKey };
  $("tv-finish-title").textContent = tvT(titleKey);
  $("tv-finish-note").textContent = tvT(noteKey);
  $("tv-finish").classList.toggle("tv-error", isError);
  tvShow("tv-finish", true);
  tvShow("tv-editor", false);
  tvShow("tv-preview", false);
  tvShow("tv-dup", false);
  tvShow("tv-delete", false);
  tvShow("tv-save", false);
  $("tv-cancel").dataset.i18n = "close";
  $("tv-cancel").textContent = tvT("close");
}
function tvNote(message, isError = false) {
  const note = $("tv-note");
  note.textContent = message;
  note.classList.toggle("tv-err", isError);
  tvShow("tv-note", true);
}
function tvOnTrusted(el, handler) {
  el.addEventListener("click", (event) => {
    if (tvIsTrustedGesture(event, navigator.userActivation)) handler(event);
  });
}
function tvSame(a, b) {
  return a.size === b.size && [...a].every((id) => b.has(id));
}

function tvRefreshLanguage() {
  TVI18N.apply();
  if (tvFinishState) {
    $("tv-finish-title").textContent = tvT(tvFinishState.titleKey);
    $("tv-finish-note").textContent = tvT(tvFinishState.noteKey);
  }
  tvLanguageRerender?.();
}
function tvSelectTab(name) {
  for (const tab of ["folders", "tags", "note"]) {
    const selected = tab === name;
    $("tv-tab-" + tab).classList.toggle("on", selected);
    $("tv-tab-" + tab).setAttribute("aria-selected", String(selected));
    tvShow("tv-" + tab + "-panel", selected);
  }
}
function tvRenderChoices({ wrap, values, selected, filter, emptyKey, createKey, onChange, onCreate }) {
  wrap.classList.remove("tv-loading");
  wrap.textContent = "";
  const rawQuery = filter.value.trim();
  const query = rawQuery.toLocaleLowerCase();
  const visible = values.filter((item) => item.name.toLocaleLowerCase().includes(query));
  const exact = values.some((item) => item.name.toLocaleLowerCase() === query);
  if (rawQuery && !exact) {
    const create = document.createElement("button");
    create.type = "button";
    create.className = "tv-choice tv-create";
    create.textContent = `+ ${tvT(createKey)} “${rawQuery}”`;
    tvOnTrusted(create, onCreate);
    wrap.append(create);
  }
  if (!visible.length && !rawQuery) {
    const empty = document.createElement("div");
    empty.className = "tv-empty";
    empty.textContent = tvT(emptyKey);
    wrap.append(empty);
    return;
  }
  for (const item of visible) {
    const choice = document.createElement("button");
    choice.type = "button";
    choice.className = "tv-choice" + (selected.has(item.id) ? " on" : "");
    choice.setAttribute("aria-pressed", String(selected.has(item.id)));
    const check = document.createElement("span");
    check.className = "tv-choice-check";
    check.textContent = "✓";
    const label = document.createElement("span");
    label.textContent = item.name;
    choice.append(check, label);
    tvOnTrusted(choice, () => {
      selected.has(item.id) ? selected.delete(item.id) : selected.add(item.id);
      onChange();
    });
    wrap.append(choice);
  }
}

$("tv-close").addEventListener("click", tvClosePanel);
$("tv-cancel").addEventListener("click", tvClosePanel);
document.addEventListener("tv:langchange", tvRefreshLanguage);
document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape") return;
  if (!$("tv-confirm").classList.contains("tv-hidden")) tvShow("tv-confirm", false);
  else tvClosePanel();
});
// Клик по подложке закрывает, только если и нажатие началось на ней же: при
// протяжке выделения из поля за край карточки Chromium шлёт click общему
// предку, то есть подложке, и заметка терялась (EXT-OPT-01 #42).
let tvDownTarget = null;
for (const id of ["tv-overlay", "tv-confirm"]) $(id).addEventListener("pointerdown", (event) => { tvDownTarget = event.target; });
const tvBackdropClick = (id, event) => event.target === $(id) && tvDownTarget === $(id);
$("tv-overlay").addEventListener("click", (event) => { if (tvBackdropClick("tv-overlay", event)) tvClosePanel(); });
$("tv-confirm-cancel").addEventListener("click", () => tvShow("tv-confirm", false));
$("tv-confirm").addEventListener("click", (event) => { if (tvBackdropClick("tv-confirm", event)) tvShow("tv-confirm", false); });
for (const tab of ["folders", "tags", "note"]) $("tv-tab-" + tab).addEventListener("click", () => tvSelectTab(tab));
tvOnTrusted($("tv-delete"), () => tvShow("tv-confirm", true));
tvOnTrusted($("tv-confirm-delete"), async () => {
  if (!tvDeleteAction) return;
  const button = $("tv-confirm-delete");
  button.disabled = true;
  try { await tvDeleteAction(); tvClosePanel(); }
  catch (error) { console.error("Thumb Sight delete:", error); button.disabled = false; tvShow("tv-confirm", false); tvFinish("removeFailedTitle", "retryNote"); }
});

function tvRenderChannel(intent) {
  $("tv-title").dataset.i18n = "channelTitle";
  $("tv-title").textContent = tvT("channelTitle");
  const channelNote = $("tv-note");
  if (intent.channelName) delete channelNote.dataset.i18n;
  else channelNote.dataset.i18n = "youtubeChannel";
  tvNote(intent.channelName || tvT("youtubeChannel"));
  const save = $("tv-save");
  save.dataset.i18n = "follow";
  save.textContent = tvT("follow");
  save.disabled = false;
  tvShow("tv-save", true);
  tvOnTrusted(save, async () => {
    save.disabled = true;
    try {
      await API.saveChannel({ channel_id: intent.channelId, name: intent.channelName, avatar: intent.channelAvatar });
      tvClosePanel();
    } catch (error) { console.error("Thumb Sight follow:", error); save.disabled = false; tvFinish("channelFailedTitle", "retryNote"); }
  });
}

async function tvRenderSave(intent) {
  const preview = $("tv-preview-img");
  const imageUrl = intent.mode === "youtube"
    ? `https://i.ytimg.com/vi/${intent.videoId}/hqdefault.jpg`
    : intent.imageUrl;
  let previewUrl = intent.imageUrl;
  const fallbackPreview = () => {
    if (!previewUrl.includes("maxresdefault")) return;
    previewUrl = imageUrl;
    preview.src = previewUrl;
  };
  preview.onerror = () => {
    if (intent.mode === "youtube" && intent.videoId) fallbackPreview();
  };
  preview.onload = () => { if (preview.naturalWidth <= 120) fallbackPreview(); };
  preview.src = previewUrl;
  tvShow("tv-preview", true);
  tvShow("tv-editor", true);
  tvShow("tv-save", true);

  const folders = [], tags = [];
  const selectedFolders = new Set(), selectedTags = new Set();
  let originalFolders = new Set(), originalTags = new Set();
  let originalNote = "";
  const folderInput = $("tv-new-folder"), tagInput = $("tv-new-tag");
  let createFolderAction, createTagAction;
  const renderFolders = () => tvRenderChoices({ wrap: $("tv-collections"), values: folders, selected: selectedFolders, filter: folderInput, emptyKey: "noFolders", createKey: "createFolder", onChange: renderFolders, onCreate: () => void createFolderAction?.() });
  const renderTags = () => tvRenderChoices({ wrap: $("tv-tags"), values: tags, selected: selectedTags, filter: tagInput, emptyKey: "noTags", createKey: "createTag", onChange: renderTags, onCreate: () => void createTagAction?.() });
  folderInput.addEventListener("input", renderFolders);
  tagInput.addEventListener("input", renderTags);
  const updateCount = () => {
    const count = $("tv-note-input").value.length;
    $("tv-note-count").textContent = `${count} / ${NOTE_MAX}`;
    $("tv-note-count").classList.toggle("full", count >= NOTE_MAX);
  };
  $("tv-note-input").addEventListener("input", updateCount);

  const create = (kind) => async () => {
    const input = kind === "folder" ? folderInput : tagInput;
    const add = $(kind === "folder" ? "tv-add-folder" : "tv-add-tag");
    const list = kind === "folder" ? folders : tags;
    const selected = kind === "folder" ? selectedFolders : selectedTags;
    try {
      add.disabled = true;
      const value = kind === "folder" ? await API.createCollection(input.value) : await API.createTag(input.value);
      if (!list.some((item) => item.id === value.id)) list.push(value);
      selected.add(value.id);
      input.value = "";
      kind === "folder" ? renderFolders() : renderTags();
    } catch (error) { console.error("Thumb Sight create:", error); tvNote(tvT(kind === "folder" ? "createFolderFailed" : "createTagFailed"), true); }
    finally { add.disabled = false; }
  };
  for (const kind of ["folder", "tag"]) {
    const input = kind === "folder" ? folderInput : tagInput;
    const add = $(kind === "folder" ? "tv-add-folder" : "tv-add-tag");
    const action = tvCreateActionLock(create(kind));
    if (kind === "folder") createFolderAction = action;
    else createTagAction = action;
    tvOnTrusted(add, action);
    input.addEventListener("keydown", (event) => { if (event.key === "Enter" && tvIsTrustedGesture(event, null)) { event.preventDefault(); void action(); } });
  }

  const existingPromise = intent.mode === "youtube" ? API.findThumbnailByVideoId(intent.videoId) : API.findThumbnailByImg(intent.imageUrl);
  const [existingResult, foldersResult, tagsResult] = await Promise.allSettled([
    existingPromise,
    API.getCollections(),
    API.getTags(),
  ]);
  if (existingResult.status === "rejected") {
    console.error("Thumb Sight duplicate lookup:", existingResult.reason);
    tvFinish("loadFailedTitle", "retryNote");
    return;
  }
  const existing = existingResult.value;
  const foldersLoaded = foldersResult.status === "fulfilled";
  const tagsLoaded = tagsResult.status === "fulfilled";
  if (foldersLoaded) {
    delete $("tv-collections").dataset.i18n;
    for (const row of foldersResult.value) if (!folders.some((item) => item.id === row.id)) folders.push(row);
  } else {
    $("tv-collections").dataset.i18n = "foldersFailed";
    $("tv-collections").textContent = tvT("foldersFailed");
    folderInput.disabled = true;
    $("tv-add-folder").disabled = true;
  }
  if (tagsLoaded) {
    delete $("tv-tags").dataset.i18n;
    for (const row of tagsResult.value) if (!tags.some((item) => item.id === row.id)) tags.push(row);
  } else {
    $("tv-tags").dataset.i18n = "tagsFailed";
    $("tv-tags").textContent = tvT("tagsFailed");
    tagInput.disabled = true;
    $("tv-add-tag").disabled = true;
  }
  if (existing) {
    originalFolders = new Set(existing.collectionIds || []);
    originalTags = new Set(existing.tagIds || []);
    for (const id of originalFolders) selectedFolders.add(id);
    for (const id of originalTags) selectedTags.add(id);
    originalNote = existing.note || "";
    $("tv-note-input").value = originalNote;
    updateCount();
    tvShow("tv-dup", true);
    tvShow("tv-delete", true);
    tvDeleteAction = () => API.deleteThumbnail(existing.id);
  }
  if (foldersLoaded) renderFolders();
  if (tagsLoaded) renderTags();
  tvLanguageRerender = () => {
    if (foldersLoaded) renderFolders();
    if (tagsLoaded) renderTags();
  };
  const save = $("tv-save");
  save.disabled = false;
  // Строка, которую правит эта панель: найденная в базе либо созданная в этой
  // попытке. Пока её нет, сохранение её СОЗДАЁТ; как только она появилась,
  // дальше правится именно она. Без этого изменённая заметка уезжала на новый
  // id, а повтор после отказа связей вставлял вторую Pinterest-строку (PUB-02).
  let saved = existing;
  tvOnTrusted(save, async () => {
    save.disabled = true;
    tvShow("tv-note", false);   // новая попытка начинается без прошлой ошибки
    try {
      const note = $("tv-note-input").value;
      if (note.length > NOTE_MAX && (!existing || note !== originalNote)) {
        tvSelectTab("note");
        tvNote(tvT("noteTooLong"), true);
        save.disabled = false;
        return;
      }
      if (!saved) {
        const created = await API.saveThumbnail({ video_id: intent.videoId, img_url: imageUrl, source_url: intent.sourceUrl, note });
        if (!created?.id) throw new Error("Save not confirmed");
        // Заметка уже внутри созданной строки: повтор её не переписывает.
        saved = created;
        originalNote = note;
        tvDeleteAction = () => API.deleteThumbnail(created.id);
      } else if (note !== originalNote) {
        // NOT VALID сохраняет legacy-заметки >1000. Пока такая заметка не
        // менялась, строка thumbnails не трогается вовсе: ни неявного усечения,
        // ни срабатывания CHECK на неизменённом тексте.
        await API.updateThumbnailNote(saved.id, note);
        originalNote = note;
      }
      // Одно сохранение — один вызов. `null` означает «набор не менялся», и если
      // не менялся ни один, запрос не уходит вовсе (прежнее поведение).
      const links = await API.replaceThumbnailLinks(saved.id, {
        collectionIds: tvSame(selectedFolders, originalFolders) ? null : [...selectedFolders],
        tagIds: tvSame(selectedTags, originalTags) ? null : [...selectedTags],
      });
      // Исходное состояние сдвигается только по подтверждённой замене: после
      // отказа повтор обязан отправить наборы снова, после успеха — не обязан.
      if (links) {
        originalFolders = new Set(selectedFolders);
        originalTags = new Set(selectedTags);
      }
      if (intent.mode === "youtube") await API.snapshotStats(intent.videoId);
      tvClosePanel();
    } catch (error) {
      console.error("Thumb Sight save:", error);
      save.disabled = false;
      // Отказ сохранения оставляет панель РАБОЧЕЙ. `tvFinish` прячет редактор и
      // Save (`.tv-hidden { display: none !important }`), и повтор становился
      // пользователю недоступен: введённая заметка, выбранные наборы и уже
      // подтверждённый id жили только в замыкании (F1 в
      // CODEX-PUBLIC-PUB02-REVIEW-01.md). Ошибка показывается в существующем
      // слоте `#tv-note` (role="status", стиль `.tv-err`) существующими
      // переводами; финальный экран остаётся за истёкшим capability, отказом
      // первичной загрузки, Delete и Follow.
      tvNote(`${tvT("saveFailedTitle")}. ${tvT("retryNote")}`, true);
    }
  });
}

function tvSendMessage(message) { return new Promise((resolve) => chrome.runtime.sendMessage(message, (response) => resolve(chrome.runtime.lastError ? null : response))); }
function tvTakeIntentNonce() { const url = new URL(location.href); const nonce = url.searchParams.get("intent") || ""; history.replaceState(null, "", TV_PANEL_PAGE); return nonce; }
async function tvClaimIntent() {
  const nonce = tvTakeIntentNonce();
  for (let attempt = 0; attempt < 40; attempt++) {
    const claimed = await tvSendMessage({ type: "tv:claim-intent", nonce });
    if (claimed?.ok && claimed.intent) return claimed.intent;
    if (claimed?.error !== "Capability pending") break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("Invalid capability");
}
async function tvStart() {
  await TVI18N.ready;
  tvRefreshLanguage();
  try { tvIntent = await tvClaimIntent(); }
  catch { tvFinish("expiredTitle", "expiredNote"); return; }
  // Чип пуст и скрыт в разметке, пока claim не назвал источник: иначе первый
  // кадр Pinterest-панели показывал YOUTUBE (EXT-OPT-01 #47).
  $("tv-source").textContent = tvIntent.mode === "pinterest" ? "PINTEREST" : "YOUTUBE";
  tvShow("tv-source", true);
  if (!await SB.getSession()) { tvFinish("noSessionTitle", "noSessionNote"); return; }
  if (tvIntent.mode === "channel") tvRenderChannel(tvIntent); else await tvRenderSave(tvIntent);
}
tvStart().catch((error) => { console.error("Thumb Sight panel:", error); tvFinish("unexpectedTitle", "retryNote"); });

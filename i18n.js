const TVI18N = (() => {
  const LANGS = ["en", "es", "ru"];
  const NAMES = { en: "English", es: "Español", ru: "Русский" };
  const T = {
    signOutWarn: {
      en: "You are signed out on this device. We could not confirm that the server session ended, so it may still be active. Sign in and out again when you are back online; if you suspect stolen access, change your password in account settings.",
      es: "Se cerró la sesión en este dispositivo. No pudimos confirmar que la sesión del servidor haya terminado: puede seguir activa. Vuelve a iniciar y cerrar sesión cuando tengas conexión; si sospechas de un acceso robado, cambia tu contraseña en los ajustes de la cuenta.",
      ru: "Выход выполнен на этом устройстве. Подтвердить завершение серверной сессии не удалось — она может остаться активной. Повторите вход и выход, когда появится сеть; если подозреваете кражу доступа, смените пароль в настройках аккаунта."
    },
    signInCopy: { en: "Sign in to save thumbnails straight from YouTube and Pinterest.", es: "Inicia sesión para guardar miniaturas directamente desde YouTube y Pinterest.", ru: "Войдите, чтобы сохранять обложки прямо с YouTube и Pinterest." },
    signInBtn: { en: "Sign in with Thumb Sight", es: "Iniciar sesión con Thumb Sight", ru: "Войти через Thumb Sight" },
    signInStatus: { en: "A Thumb Sight tab will open for sign-in.", es: "Se abrirá una pestaña de Thumb Sight para iniciar sesión.", ru: "Откроется вкладка Thumb Sight для входа." },
    opening: { en: "Opening Thumb Sight…", es: "Abriendo Thumb Sight…", ru: "Открываю Thumb Sight…" },
    signInFailed: { en: "Could not sign in", es: "No se pudo iniciar sesión", ru: "Не удалось выполнить вход" },
    signedIn: { en: "Signed in", es: "Sesión iniciada", ru: "Вход выполнен" },
    accountHint: { en: "Save thumbnails with the Thumb Sight button on YouTube and Pinterest.", es: "Guarda miniaturas con el botón de Thumb Sight en YouTube y Pinterest.", ru: "Сохраняйте обложки кнопкой-знаком Thumb Sight на YouTube и Pinterest." },
    openApp: { en: "Open Thumb Sight", es: "Abrir Thumb Sight", ru: "Открыть Thumb Sight" },
    ready: { en: "Extension ready", es: "Extensión lista", ru: "Расширение готово" },
    signOut: { en: "Sign out", es: "Cerrar sesión", ru: "Выйти" },
    saveTitle: { en: "Save to Thumb Sight", es: "Guardar en Thumb Sight", ru: "Сохранить в Thumb Sight" },
    channelTitle: { en: "Follow channel", es: "Seguir canal", ru: "Следить за каналом" },
    youtubeChannel: { en: "YouTube channel", es: "Canal de YouTube", ru: "Канал YouTube" },
    duplicate: { en: "Already in your library — you can update folders and the note.", es: "Ya está en tu biblioteca: puedes actualizar las carpetas y la nota.", ru: "Обложка уже в библиотеке — можно обновить папки и заметку." },
    folders: { en: "Folders", es: "Carpetas", ru: "Папки" },
    tags: { en: "Tags", es: "Etiquetas", ru: "Теги" },
    loadingFolders: { en: "Loading folders…", es: "Cargando carpetas…", ru: "Загрузка папок…" },
    loadingTags: { en: "Loading tags…", es: "Cargando etiquetas…", ru: "Загрузка тегов…" },
    foldersFailed: { en: "Could not load folders", es: "No se pudieron cargar las carpetas", ru: "Не удалось загрузить папки" },
    tagsFailed: { en: "Could not load tags", es: "No se pudieron cargar las etiquetas", ru: "Не удалось загрузить теги" },
    noFolders: { en: "No folders yet — create one below", es: "Aún no hay carpetas: crea una abajo", ru: "Папок пока нет — создайте ниже" },
    noTags: { en: "No tags yet — create one below", es: "Aún no hay etiquetas: crea una abajo", ru: "Тегов пока нет — создайте ниже" },
    findOrCreateFolder: { en: "Find or create a folder…", es: "Busca o crea una carpeta…", ru: "Найдите или создайте папку…" },
    findOrCreateTag: { en: "Find or create a tag…", es: "Busca o crea una etiqueta…", ru: "Найдите или создайте тег…" },
    createFolder: { en: "Create folder", es: "Crear carpeta", ru: "Создать папку" },
    createTag: { en: "Create tag", es: "Crear etiqueta", ru: "Создать тег" },
    createFolderFailed: { en: "Could not create folder", es: "No se pudo crear la carpeta", ru: "Не удалось создать папку" },
    createTagFailed: { en: "Could not create tag", es: "No se pudo crear la etiqueta", ru: "Не удалось создать тег" },
    note: { en: "Note", es: "Nota", ru: "Заметка" },
    notePlaceholder: { en: "What makes it work…", es: "Qué la hace funcionar…", ru: "Чем цепляет…" },
    noteTooLong: { en: "Shorten the note to 1000 characters before saving.", es: "Reduce la nota a 1000 caracteres antes de guardar.", ru: "Сократите заметку до 1000 символов перед сохранением." },
    cancel: { en: "Cancel", es: "Cancelar", ru: "Отмена" },
    save: { en: "Save", es: "Guardar", ru: "Сохранить" },
    follow: { en: "Follow", es: "Seguir", ru: "Следить" },
    close: { en: "Close", es: "Cerrar", ru: "Закрыть" },
    remove: { en: "Remove", es: "Quitar", ru: "Убрать" },
    removeTitle: { en: "Remove this thumbnail from Thumb Sight?", es: "¿Quitar esta miniatura de Thumb Sight?", ru: "Убрать обложку из Thumb Sight?" },
    removeBody: { en: "It disappears from your library and every folder. Copies placed on boards stay — remove them on the board itself. This cannot be undone.", es: "Desaparecerá de tu biblioteca y de todas las carpetas. Las copias colocadas en tableros permanecen: quítalas en el propio tablero. No se puede deshacer.", ru: "Обложка исчезнет из библиотеки и всех папок. Копии, вставленные на борды, останутся — их убирают на самом борде. Отменить нельзя." },
    saveFailedTitle: { en: "Could not save", es: "No se pudo guardar", ru: "Не удалось сохранить" },
    loadFailedTitle: { en: "Could not prepare this thumbnail", es: "No se pudo preparar esta miniatura", ru: "Не удалось подготовить миниатюру" },
    removeFailedTitle: { en: "Could not remove thumbnail", es: "No se pudo quitar la miniatura", ru: "Не удалось удалить обложку" },
    channelFailedTitle: { en: "Could not add channel", es: "No se pudo añadir el canal", ru: "Не удалось добавить канал" },
    retryNote: { en: "Check your connection and try again.", es: "Comprueba tu conexión e inténtalo de nuevo.", ru: "Проверьте соединение и попробуйте ещё раз." },
    noSessionTitle: { en: "Sign in first", es: "Inicia sesión primero", ru: "Сначала войдите" },
    noSessionNote: { en: "Sign in from the extension icon, then try again.", es: "Inicia sesión desde el icono de la extensión y vuelve a intentarlo.", ru: "Войдите через иконку расширения и попробуйте ещё раз." },
    expiredTitle: { en: "This window has expired", es: "Esta ventana ha caducado", ru: "Окно устарело" },
    expiredNote: { en: "Click the Thumb Sight button on the page again.", es: "Vuelve a pulsar el botón de Thumb Sight en la página.", ru: "Нажмите кнопку Thumb Sight на странице ещё раз." },
    unexpectedTitle: { en: "Something went wrong", es: "Algo salió mal", ru: "Что-то пошло не так" },
    openFailed: { en: "Could not open Thumb Sight", es: "No se pudo abrir Thumb Sight", ru: "Не удалось открыть Thumb Sight" },
    stalePage: { en: "Refresh the page after reloading the extension", es: "Actualiza la página después de recargar la extensión", ru: "Обновите страницу после перезагрузки расширения" },
    notVideo: { en: "This is not a video page", es: "Esta no es una página de vídeo", ru: "Это не страница видео" },
    channelUnknown: { en: "Could not identify the channel", es: "No se pudo identificar el canal", ru: "Не удалось определить канал" },
    saveThumbnail: { en: "Save thumbnail to Thumb Sight", es: "Guardar miniatura en Thumb Sight", ru: "Сохранить обложку в Thumb Sight" },
    saveImage: { en: "Save image to Thumb Sight", es: "Guardar imagen en Thumb Sight", ru: "Сохранить изображение в Thumb Sight" },
    followChannel: { en: "Follow channel in Thumb Sight", es: "Seguir canal en Thumb Sight", ru: "Следить за каналом в Thumb Sight" }
  };

  let lang = "en";

  // Страница расширения или content script — определяется сравнением с
  // СОБСТВЕННЫМ адресом из `runtime.getURL("/")`: в Chrome это
  // `chrome-extension://<id>`, в Firefox — `moz-extension://<UUID установки>`.
  // Константа `chrome-extension:` здесь означала бы, что в Firefox popup и
  // panel считают себя content script'ами.
  //
  // В Chrome content script не вправе читать `chrome.storage.local` ПОСЛЕ
  // успешного `setAccessLevel` (раздел «готовность» в oauth.js) и получает
  // «Access to storage is not allowed from this context». До первого успешного
  // вызова и на браузерах, где он отвергается (Chrome <140), область ему
  // открыта — там носитель сессии запечатан, но язык из этой области
  // по-прежнему читаем. В Firefox область доступна content script'у всегда — но
  // путь остаётся ОДИН для всех случаев: язык спрашивается у background
  // сообщением, которое отдаёт ровно один валидированный код en/es/ru.
  // Возвращать content script'у прямое чтение storage «раз в Firefox можно»
  // нельзя: это расширяет его возможности и заводит вторую ветку поведения.
  function selfBase() {
    try {
      const url = new URL(chrome.runtime.getURL("/"));
      return { protocol: url.protocol, host: url.host };
    } catch (_) {
      return null;
    }
  }

  const base = selfBase();
  const trusted = !!base &&
    globalThis.location?.protocol === base.protocol &&
    globalThis.location?.host === base.host;

  // Никогда не бросает: любой отказ storage или messaging — это английский
  // fallback, а не сломанный TVI18N.ready.
  async function readLang() {
    try {
      if (trusted) {
        const stored = await chrome.storage.local.get("tv_lang");
        if (LANGS.includes(stored.tv_lang)) return stored.tv_lang;
        await chrome.storage.local.set({ tv_lang: "en" });
        return "en";
      }
      // Callback-форма намеренно: у promise-формы отсутствующий worker или
      // осиротевший после reload content script дают отказ, а `lastError`
      // достаточно просто прочитать.
      const res = await new Promise((resolve) => {
        chrome.runtime.sendMessage({ type: "tv:lang" }, (response) => {
          void chrome.runtime.lastError;
          resolve(response);
        });
      });
      return LANGS.includes(res?.lang) ? res.lang : "en";
    } catch (_) {
      return "en";
    }
  }

  function t(key) {
    return T[key]?.[lang] || T[key]?.en || key;
  }

  // PUB-01: в content script переводить нечего — DOM принадлежит сайту. Ни
  // html.lang, ни текст, ни placeholder/title/aria-label хоста расширение не
  // трогает. Собственные кнопки content scripts переводят сами по событию
  // `tv:langchange` (content.js, content-pinterest.js, content-channel.js), а
  // popup и panel — документы extension-origin, там `trusted` истинно и всё
  // работает как раньше.
  // ponytail: граница — контекст документа, а не список доверенных узлов:
  // собственных data-i18n элементов расширение в host-DOM не размещает. Если
  // такой узел когда-нибудь появится, сюда придёт явный root-allowlist.
  function apply(root = document) {
    if (!trusted) return;
    root.documentElement?.setAttribute("lang", lang);
    root.querySelectorAll("[data-i18n]").forEach((el) => { el.textContent = t(el.dataset.i18n); });
    root.querySelectorAll("[data-i18n-placeholder]").forEach((el) => { el.placeholder = t(el.dataset.i18nPlaceholder); });
    root.querySelectorAll("[data-i18n-title]").forEach((el) => {
      const value = t(el.dataset.i18nTitle);
      el.title = value;
      if (el.hasAttribute("aria-label")) el.setAttribute("aria-label", value);
    });
  }

  async function init() {
    lang = await readLang();
    apply();
    document.dispatchEvent(new CustomEvent("tv:langchange", { detail: { lang } }));
    return lang;
  }

  async function setLang(next) {
    if (!LANGS.includes(next)) return;
    lang = next;
    await chrome.storage.local.set({ tv_lang: lang });
    apply();
    document.dispatchEvent(new CustomEvent("tv:langchange", { detail: { lang } }));
  }

  // Событий закрытого storage content script всё равно не получает, а вешать
  // слушатель на недоступную область — приглашение к отказу при регистрации.
  // ponytail: на host-странице язык применяется при загрузке; смена языка в
  // popup доезжает до уже открытых вкладок YouTube/Pinterest после их
  // обновления. Push-синхронизация не входит в этот узкий фикс. Сам по себе
  // `tabs.sendMessage` не требует новых host permissions; отдельной проверки
  // потребуют выбор адресатов, валидация сообщений и жизненный цикл подписки.
  if (trusted) {
    chrome.storage.onChanged.addListener((changes, area) => {
      const next = changes.tv_lang?.newValue;
      if (area !== "local" || !LANGS.includes(next) || next === lang) return;
      lang = next;
      apply();
      document.dispatchEvent(new CustomEvent("tv:langchange", { detail: { lang } }));
    });
  }

  // `ready` не отказывает никогда: его ждут popup и panel, а в content script
  // его никто не ждёт — необработанный rejection был бы ровно тем отказом,
  // который здесь чинится.
  const ready = init().catch(() => lang);
  return { LANGS, NAMES, ready, init, setLang, t, apply, get lang() { return lang; } };
})();

globalThis.TVI18N = TVI18N;

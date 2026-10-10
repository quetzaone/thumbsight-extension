// Мини-клиент Supabase для расширения — без npm/сборки. Жизненным циклом токенов
// владеет service worker; этот helper получает только безопасные ответы через
// узкий runtime-message proxy.

const SB = {
  _send(message) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage(message, (response) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        if (!response?.ok) {
          reject(new Error(response?.error || "Background request failed"));
          return;
        }
        resolve(response);
      });
    });
  },

  async getSession() {
    const res = await SB._send({ type: "tv:sb-session" });
    return res.session || null;
  },

  // Отдаёт вызывающему структурный logout result background-а
  // ({ localCleared, remoteRevoked, hadSession, attempts, reason }) — без токенов
  // и без тела ответа Supabase. null означает «результат неизвестен».
  async signOut() {
    const res = await SB._send({ type: "tv:sb-sign-out" });
    return res.result || null;
  },

  // Запрос к REST с авто-токеном и одной повторной попыткой при 401.
  async rest(path, opts = {}) {
    const res = await SB._send({ type: "tv:sb-rest", path, opts });
    return res.data ?? null;
  },

  userId() {
    return SB.getSession().then((s) => s?.user?.id || null);
  },

  async invokeFunction(name, body = {}) {
    const res = await SB._send({ type: "tv:sb-function", name, body });
    return res.data ?? null;
  },
};

window.SB = SB;

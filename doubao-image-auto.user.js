// ==UserScript==
// @name         豆包图像生成助手 v3.5
// @namespace    https://github.com/Frank-jpeg/doubaoshengtuzhushou
// @version      3.5
// @description  支持 TXT 批量文生图、文件夹批量图生图、断点续传；异常后间隔 2 分钟自动重试，单任务最多 3 次，限额或手动停止不重试。
// @author       Codex (UI Redesign by AI)
// @match        https://www.doubao.com/chat/*
// @grant        none
// @run-at       document-start
// @homepageURL  https://github.com/Frank-jpeg/doubaoshengtuzhushou
// @supportURL   https://github.com/Frank-jpeg/doubaoshengtuzhushou/issues
// @updateURL    https://raw.githubusercontent.com/Frank-jpeg/doubaoshengtuzhushou/main/doubao-image-auto.user.js
// @downloadURL  https://raw.githubusercontent.com/Frank-jpeg/doubaoshengtuzhushou/main/doubao-image-auto.user.js
// ==/UserScript==

(function () {
  "use strict";

  if (window.__doubaoImageAutoLoaded__) {
    return;
  }
  window.__doubaoImageAutoLoaded__ = true;

  const SCRIPT_VERSION = "3.5";
  const AUTO_RETRY_DELAY_MS = 2 * 60 * 1000;
  const AUTO_RETRY_MAX_ATTEMPTS = 3;
  const PANEL_ID = "doubao-image-auto-panel";
  const STATUS_ID = "doubao-image-auto-status";
  const TXT_INPUT_ID = "doubao-image-auto-txt";
  const TEXT_NAMING_MODE_ID = "doubao-image-auto-text-naming-mode";
  const DOWNLOAD_COUNT_ID = "doubao-image-auto-download-count";
  const FOLDER_INPUT_ID = "doubao-image-auto-folder";
  const EXTRA_PROMPT_ID = "doubao-image-auto-extra-prompt";
  const REMOVE_WATERMARK_ID = "doubao-image-auto-remove-watermark";
  const RESUME_BUTTON_ID = "doubao-image-auto-resume";
  const CLEAR_RESUME_BUTTON_ID = "doubao-image-auto-clear-resume";
  const RESUME_HINT_ID = "doubao-image-auto-resume-hint";
  const STORAGE_EXTRA_PROMPT = "doubao-image-auto-extra-prompt";
  const STORAGE_REMOVE_WATERMARK = "doubao-image-auto-remove-watermark";
  const STORAGE_TEXT_NAMING_MODE = "doubao-image-auto-text-naming-mode";
  const STORAGE_DOWNLOAD_COUNT = "doubao-image-auto-download-count";
  const STORAGE_COLLAPSED = "doubao-image-auto-collapsed";
  const STORAGE_PANEL_POSITION = "doubao-image-auto-panel-position";
  const STORAGE_RESUME_CHECKPOINT = "doubao-image-auto-resume-checkpoint";
  const RESUME_DB_NAME = "doubao-image-auto-resume-db";
  const RESUME_FILE_STORE = "resume-files";
  const DOWNLOAD_SVG_PATH =
    "M19.207 12.707a1 1 0 0 0-1.414-1.414L13 16.086V2a1 1 0 1 0-2 0v14.086l-4.793-4.793a1 1 0 0 0-1.414 1.414l6.5 6.5c.195.195.45.293.706.293H5a1 1 0 1 0 0 2h14a1 1 0 1 0 0-2h-6.999a1 1 0 0 0 .706-.293z";

  const state = {
    running: false,
    stopRequested: false,
    watermarkHooked: false,
    rawImageUrls: [],
    rawUrlSeen: new Set(),
    statusLines: [],
    batchTotal: 0,
    currentTaskNumber: 0,
    completedTasks: 0,
    currentTaskLabel: "",
    currentDownloadBaseName: "",
    failedTasks: [],
    resumeCheckpoint: null,
    imageModeOpenedAt: 0,
    pendingPrompt: null,
    autoRetryTimer: null,
    autoRetryTicker: null,
    autoRetryAt: 0,
  };

  let resumeDbPromise = null;

  function sleep(ms) {
    return new Promise((resolve) => window.setTimeout(resolve, ms));
  }

  function randomInt(min, max) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
  }

  async function sleepRandom(min, max) {
    await sleep(randomInt(min, max));
  }

  function qs(selector, root = document) {
    return root.querySelector(selector);
  }

  function qsa(selector, root = document) {
    return Array.from(root.querySelectorAll(selector));
  }

  function normalizeText(text) {
    return (text || "").replace(/\s+/g, "");
  }

  function sanitizeFilenamePart(name) {
    return (name || "")
      .replace(/[\\/:*?"<>|]/g, "_")
      .replace(/\s+/g, " ")
      .trim();
  }

  function getFileExtensionFromUrl(url) {
    const cleanUrl = (url || "").split("?")[0];
    const match = cleanUrl.match(/\.([a-zA-Z0-9]+)$/);
    return match ? `.${match[1].toLowerCase()}` : "";
  }

  function getFileExtensionFromBlob(blob) {
    const mime = (blob?.type || "").toLowerCase();
    if (mime.includes("png")) {
      return ".png";
    }
    if (mime.includes("jpeg") || mime.includes("jpg")) {
      return ".jpg";
    }
    if (mime.includes("webp")) {
      return ".webp";
    }
    return "";
  }

  function buildDownloadFilename(index, total, url, blob) {
    const baseName = sanitizeFilenamePart(state.currentDownloadBaseName) || `doubao-${Date.now()}`;
    const suffix = total > 1 ? `-${index + 1}` : "";
    const extension = getFileExtensionFromBlob(blob) || getFileExtensionFromUrl(url) || ".png";
    return `${baseName}${suffix}${extension}`;
  }

  function getVisibleEditor() {
    // chat_input_input is now a wrapper, not the editable element itself.
    const selectors = [
      '[data-testid="chat_input_input"] .ProseMirror[contenteditable="true"]',
      '[data-testid="chat_input_input"] textarea',
      '[data-testid="chat_input_input"] [contenteditable="true"]',
      'textarea[data-testid="chat_input_input"]',
      '.ProseMirror[contenteditable="true"]',
      'textarea[placeholder*="发消息"]',
      'textarea[placeholder*="输入"]',
      '[role="textbox"][contenteditable="true"]',
      '[contenteditable="true"][data-slate-editor="true"]',
      'textarea',
      '[contenteditable="true"]',
    ];
    for (const selector of selectors) {
      const editor = qsa(selector).find((el) => isVisible(el) && !el.closest(`#${PANEL_ID}`));
      if (editor) return editor;
    }
    return null;
  }

  function getClickable(el) {
    if (!el) {
      return null;
    }
    return el.closest('button,a,[role="button"],[tabindex]') || el;
  }

  function getElementText(el) {
    if (!el) {
      return "";
    }
    return normalizeText(
      [
        el.getAttribute?.("aria-label"),
        el.getAttribute?.("title"),
        el.getAttribute?.("data-testid"),
        el.textContent,
      ]
        .filter(Boolean)
        .join(" "),
    );
  }

  function doesTextMatch(actual, expected, exact) {
    return exact ? actual === expected : actual.includes(expected);
  }

  function findVisibleButtonByText(text, options = {}) {
    const { exact = true } = options;
    const expected = normalizeText(text);
    return qsa('button,a,[role="button"],[tabindex],div,span').find((el) => {
      if (!isVisible(el)) {
        return false;
      }
      const clickable = getClickable(el);
      if (!clickable || !isVisible(clickable)) {
        return false;
      }
      return doesTextMatch(getElementText(el), expected, exact) || doesTextMatch(getElementText(clickable), expected, exact);
    }) || null;
  }

  function findVisibleButtonByAnyText(texts, options = {}) {
    for (const text of texts) {
      const found = findVisibleButtonByText(text, options);
      if (found) {
        return found;
      }
    }
    return null;
  }

  function isReferenceUploadInput(el) {
    if (!el || el.type !== "file") {
      return false;
    }
    const accept = (el.accept || "").toLowerCase();
    if (el.webkitdirectory) {
      return false;
    }
    if (!accept) {
      const panel = getImagePanelState?.().panel || getEditorContainer?.();
      return Boolean(panel && panel.contains(el));
    }
    return accept.includes("image") || [".jpg", ".jpeg", ".png", ".webp"].some((ext) => accept.includes(ext));
  }

  function getPanelRoot() {
    return document.getElementById(PANEL_ID)?.shadowRoot || null;
  }

  function getPanelElement(id) {
    const root = getPanelRoot();
    return root ? root.getElementById(id) : null;
  }

  function getTextNamingMode() {
    const select = getPanelElement(TEXT_NAMING_MODE_ID);
    return select?.value || localStorage.getItem(STORAGE_TEXT_NAMING_MODE) || "line";
  }

  function getDownloadCount() {
    const select = getPanelElement(DOWNLOAD_COUNT_ID);
    return select?.value || localStorage.getItem(STORAGE_DOWNLOAD_COUNT) || "all";
  }

  function limitDownloadItems(items) {
    const count = getDownloadCount();
    if (count === "all") {
      return items;
    }
    const numericCount = Number.parseInt(count, 10);
    if (!Number.isFinite(numericCount) || numericCount <= 0) {
      return items;
    }
    return items.slice(0, numericCount);
  }

  function createBatchId() {
    return `doubao-batch-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  }

  function openResumeDb() {
    if (resumeDbPromise) {
      return resumeDbPromise;
    }
    resumeDbPromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(RESUME_DB_NAME, 1);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(RESUME_FILE_STORE)) {
          db.createObjectStore(RESUME_FILE_STORE);
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error("打开断点数据库失败"));
    });
    return resumeDbPromise;
  }

  async function putResumeFile(fileKey, file) {
    const db = await openResumeDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(RESUME_FILE_STORE, "readwrite");
      tx.objectStore(RESUME_FILE_STORE).put(file, fileKey);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error || new Error("保存断点文件失败"));
      tx.onabort = () => reject(tx.error || new Error("保存断点文件失败"));
    });
  }

  async function getResumeFile(fileKey) {
    const db = await openResumeDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(RESUME_FILE_STORE, "readonly");
      const request = tx.objectStore(RESUME_FILE_STORE).get(fileKey);
      request.onsuccess = () => resolve(request.result || null);
      request.onerror = () => reject(request.error || new Error("读取断点文件失败"));
    });
  }

  async function deleteResumeFilesForCheckpoint(checkpoint) {
    const fileKeys = (checkpoint?.tasks || [])
      .filter((task) => task?.kind === "image" && task.fileRef)
      .map((task) => task.fileRef);
    if (!fileKeys.length) {
      return;
    }
    const db = await openResumeDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(RESUME_FILE_STORE, "readwrite");
      const store = tx.objectStore(RESUME_FILE_STORE);
      fileKeys.forEach((fileKey) => store.delete(fileKey));
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error || new Error("清理断点文件失败"));
      tx.onabort = () => reject(tx.error || new Error("清理断点文件失败"));
    });
  }

  function readResumeCheckpoint() {
    const raw = localStorage.getItem(STORAGE_RESUME_CHECKPOINT);
    if (!raw) {
      return null;
    }
    try {
      const parsed = JSON.parse(raw);
      if (!parsed || !Array.isArray(parsed.tasks)) {
        localStorage.removeItem(STORAGE_RESUME_CHECKPOINT);
        return null;
      }
      return parsed;
    } catch (error) {
      console.warn("doubao-image-auto read resume checkpoint failed:", error);
      localStorage.removeItem(STORAGE_RESUME_CHECKPOINT);
      return null;
    }
  }

  function hasResumableCheckpoint(checkpoint = state.resumeCheckpoint) {
    return Boolean(
      checkpoint &&
      Array.isArray(checkpoint.tasks) &&
      checkpoint.tasks.length &&
      Number.isFinite(checkpoint.nextIndex) &&
      checkpoint.nextIndex >= 0 &&
      checkpoint.nextIndex < checkpoint.tasks.length
    );
  }

  function getResumeSummary(checkpoint = state.resumeCheckpoint) {
    if (!checkpoint) {
      return "未检测到断点任务";
    }
    const total = checkpoint.total || checkpoint.tasks.length || 0;
    const nextIndex = Number.isFinite(checkpoint.nextIndex) ? checkpoint.nextIndex : 0;
    const nextTask = checkpoint.tasks[nextIndex];
    const modeText = checkpoint.mode === "image" ? "图生图" : "文生图";
    if (hasResumableCheckpoint(checkpoint)) {
      return `检测到${modeText}断点：第 ${nextIndex + 1}/${total} 个${nextTask?.label ? `，${nextTask.label}` : ""}`;
    }
    return `上次${modeText}任务已完成`;
  }

  function syncResumeControls() {
    const checkpoint = state.resumeCheckpoint;
    const hasResume = hasResumableCheckpoint(checkpoint);
    const hasCheckpoint = Boolean(checkpoint && Array.isArray(checkpoint.tasks) && checkpoint.tasks.length);
    const resumeButton = getPanelElement(RESUME_BUTTON_ID);
    const clearButton = getPanelElement(CLEAR_RESUME_BUTTON_ID);
    const hint = getPanelElement(RESUME_HINT_ID);

    if (resumeButton) {
      resumeButton.disabled = state.running || !hasResume;
      resumeButton.style.opacity = resumeButton.disabled ? "0.6" : "1";
      resumeButton.style.cursor = resumeButton.disabled ? "not-allowed" : "pointer";
    }

    if (clearButton) {
      clearButton.disabled = state.running || !hasCheckpoint;
      clearButton.style.opacity = clearButton.disabled ? "0.6" : "1";
      clearButton.style.cursor = clearButton.disabled ? "not-allowed" : "pointer";
    }

    if (hint) {
      const seconds = Math.max(0, Math.ceil((state.autoRetryAt - Date.now()) / 1000));
      hint.textContent = getResumeSummary(checkpoint) + (state.autoRetryAt
        ? `；${seconds} 秒后自动重试（第 ${(checkpoint?.autoRetryAttempts || 0) + 1}/${AUTO_RETRY_MAX_ATTEMPTS} 次，强制停止可取消）`
        : checkpoint?.autoRetryBlockedReason ? `；自动重试已暂停：${checkpoint.autoRetryBlockedReason}` : "");
      hint.style.color = hasResume ? "#93c5fd" : "#94a3b8";
    }
  }

  function saveResumeCheckpoint(checkpoint) {
    state.resumeCheckpoint = checkpoint;
    if (checkpoint) {
      localStorage.setItem(STORAGE_RESUME_CHECKPOINT, JSON.stringify(checkpoint));
    } else {
      localStorage.removeItem(STORAGE_RESUME_CHECKPOINT);
    }
    syncResumeControls();
    return checkpoint;
  }

  function updateResumeCheckpoint(patch) {
    if (!state.resumeCheckpoint) {
      return null;
    }
    return saveResumeCheckpoint({
      ...state.resumeCheckpoint,
      ...patch,
      updatedAt: new Date().toISOString(),
    });
  }

  async function clearResumeCheckpoint(options = {}) {
    cancelAutoRetry();
    const { preserveStatus = false } = options;
    const checkpoint = state.resumeCheckpoint || readResumeCheckpoint();
    saveResumeCheckpoint(null);
    try {
      await deleteResumeFilesForCheckpoint(checkpoint);
    } catch (error) {
      console.warn("doubao-image-auto clear resume checkpoint failed:", error);
    }
    if (!preserveStatus) {
      setStatus("已清除断点");
    }
  }

  function applyCheckpointProgress(checkpoint) {
    if (!checkpoint) {
      return;
    }
    state.batchTotal = checkpoint.total || checkpoint.tasks.length || 0;
    state.completedTasks = checkpoint.completedTasks || 0;
    state.currentTaskNumber = hasResumableCheckpoint(checkpoint) ? checkpoint.nextIndex + 1 : 0;
    state.currentTaskLabel = checkpoint.tasks?.[checkpoint.nextIndex]?.label || checkpoint.currentTaskLabel || "";
  }

  function cancelAutoRetry() {
    window.clearTimeout(state.autoRetryTimer);
    window.clearInterval(state.autoRetryTicker);
    state.autoRetryTimer = null;
    state.autoRetryTicker = null;
    state.autoRetryAt = 0;
    syncResumeControls();
  }

  function getAutoRetryBlockReason(message) {
    const text = String(message || "");
    if (/触发生成上限|明天再来|(?:次数|额度|配额|积分|余额|限额).{0,24}(?:上限|耗尽|用完|用尽|不足|超限|限制)|(?:达到|超过|超出).{0,18}(?:上限|限额|额度|配额)|(?:quota|credits?|balance).{0,30}(?:exceed|exhaust|insufficient|deplet)|insufficient.{0,20}(?:quota|credits?|balance)/i.test(text)) {
      return "生成限额或额度不足";
    }
    if (/操作.{0,6}频繁|请求.{0,6}频繁|请求过多|频率限制|限流|rate.?limit|too many requests|\b429\b/i.test(text)) {
      return "请求频率受限";
    }
    if (/请.{0,6}登录|登录.{0,8}(?:失效|过期)|未登录|验证码|人机验证|安全验证|账号.{0,8}(?:封禁|限制)|账户.{0,8}(?:封禁|限制)|captcha|unauthorized|forbidden|\b(?:401|403)\b/i.test(text)) {
      return "需要登录或人工验证";
    }
    if (/断点文件丢失|断点图片缺少|缺少提示词|提示词.{0,8}(?:格式错误|必须是文本|未通过校验|写入校验失败)|不支持自动填写|未找到真正可编辑|无法写入文本输入框|\[object Object\]|内容.{0,12}(?:违规|不合规)|违反.{0,12}(?:规定|政策|规范)/i.test(text)) {
      return "需要检查文件、提示词或页面输入框";
    }
    return "";
  }

  async function resumeBatchFromCheckpoint(automatic = false) {
    if (state.running || (automatic && state.stopRequested)) return;
    const checkpoint = state.resumeCheckpoint || readResumeCheckpoint();
    if (!hasResumableCheckpoint(checkpoint)) return;
    cancelAutoRetry();
    applyBatchSettings(checkpoint.settings);
    applyCheckpointProgress(checkpoint);
    await runBatch(checkpoint.tasks.map((task) => ({ ...task })), {
      checkpoint,
      startIndex: checkpoint.nextIndex,
      automaticResume: automatic,
      resumeLabel: `${automatic ? "自动重试" : "继续执行"}：从第 ${checkpoint.nextIndex + 1}/${checkpoint.total || checkpoint.tasks.length} 个任务开始`,
    });
  }

  function scheduleAutoRetry(message) {
    cancelAutoRetry();
    const checkpoint = state.resumeCheckpoint;
    if (state.running || state.stopRequested || checkpoint?.stoppedManually || !hasResumableCheckpoint(checkpoint)) return;
    const blockedReason = getAutoRetryBlockReason(message) || getAutoRetryBlockReason(getGenerationLimitMessage());
    if (blockedReason) {
      updateResumeCheckpoint({ autoRetryBlockedReason: blockedReason });
      setStatus(`自动重试已暂停：${blockedReason}。处理后可手动点击“继续上次”`, true);
      return;
    }
    if ((checkpoint.autoRetryAttempts || 0) >= AUTO_RETRY_MAX_ATTEMPTS) {
      updateResumeCheckpoint({ autoRetryBlockedReason: `已重试 ${AUTO_RETRY_MAX_ATTEMPTS} 次，需手动继续` });
      setStatus(`已自动重试 ${AUTO_RETRY_MAX_ATTEMPTS} 次仍失败，已停止并保留断点；处理后可点击“继续上次”`, true);
      return;
    }
    updateResumeCheckpoint({ autoRetryBlockedReason: "" });
    state.autoRetryAt = Date.now() + AUTO_RETRY_DELAY_MS;
    setStatus(`已保留第 ${checkpoint.nextIndex + 1} 个任务断点，2 分钟后自动重试（第 ${(checkpoint.autoRetryAttempts || 0) + 1}/${AUTO_RETRY_MAX_ATTEMPTS} 次）；“强制停止”可取消`);
    syncResumeControls();
    state.autoRetryTicker = window.setInterval(syncResumeControls, 1000);
    state.autoRetryTimer = window.setTimeout(async () => {
      cancelAutoRetry();
      const current = state.resumeCheckpoint;
      if (state.running || state.stopRequested || current?.stoppedManually ||
          !hasResumableCheckpoint(current) || current.id !== checkpoint.id || current.nextIndex !== checkpoint.nextIndex) return;
      const reason = getAutoRetryBlockReason(getGenerationLimitMessage());
      if (reason) {
        updateResumeCheckpoint({ autoRetryBlockedReason: reason });
        setStatus(`自动重试已暂停：${reason}。处理后可手动点击“继续上次”`, true);
        return;
      }
      try {
        updateResumeCheckpoint({ autoRetryAttempts: (current.autoRetryAttempts || 0) + 1 });
        await resumeBatchFromCheckpoint(true);
      } catch (error) {
        const retryError = error instanceof Error ? error.message : String(error);
        setStatus(retryError, true);
        scheduleAutoRetry(retryError);
      }
    }, AUTO_RETRY_DELAY_MS);
  }

  function stopBatch() {
    state.stopRequested = true;
    cancelAutoRetry();
    updateResumeCheckpoint({ stoppedManually: true, autoRetryBlockedReason: "手动停止" });
    setStatus(state.running ? "正在停止，已取消自动重试" : "已停止，已取消自动重试");
  }

  function captureBatchSettings() {
    return {
      textNamingMode: getTextNamingMode(),
      downloadCount: getDownloadCount(),
      removeWatermark: isRemoveWatermarkEnabled(),
      extraPrompt: getPanelElement(EXTRA_PROMPT_ID)?.value || localStorage.getItem(STORAGE_EXTRA_PROMPT) || "",
    };
  }

  function applyBatchSettings(settings) {
    if (!settings || typeof settings !== "object") {
      return;
    }

    if (typeof settings.textNamingMode === "string") {
      localStorage.setItem(STORAGE_TEXT_NAMING_MODE, settings.textNamingMode);
      const textNamingMode = getPanelElement(TEXT_NAMING_MODE_ID);
      if (textNamingMode) {
        textNamingMode.value = settings.textNamingMode;
      }
    }

    if (typeof settings.downloadCount === "string") {
      localStorage.setItem(STORAGE_DOWNLOAD_COUNT, settings.downloadCount);
      const downloadCount = getPanelElement(DOWNLOAD_COUNT_ID);
      if (downloadCount) {
        downloadCount.value = settings.downloadCount;
      }
    }

    localStorage.setItem(STORAGE_REMOVE_WATERMARK, settings.removeWatermark ? "1" : "0");
    const removeWatermark = getPanelElement(REMOVE_WATERMARK_ID);
    if (removeWatermark) {
      removeWatermark.checked = Boolean(settings.removeWatermark);
    }

    if (typeof settings.extraPrompt === "string") {
      localStorage.setItem(STORAGE_EXTRA_PROMPT, settings.extraPrompt);
      const extraPrompt = getPanelElement(EXTRA_PROMPT_ID);
      if (extraPrompt) {
        extraPrompt.value = settings.extraPrompt;
      }
    }
  }

  function serializeTaskForResume(task, batchId, index) {
    if (task.kind === "image") {
      return {
        kind: "image",
        label: task.label || "",
        prompt: task.prompt || "",
        fileRef: `${batchId}:${index}`,
        fileName: task.file?.name || "",
      };
    }
    return {
      kind: "text",
      label: task.label || "",
      downloadBaseName: task.downloadBaseName || "",
      textNamingMode: task.textNamingMode || getTextNamingMode(),
      prompt: task.prompt || "",
    };
  }

  async function createResumeCheckpoint(mode, tasks) {
    await clearResumeCheckpoint({ preserveStatus: true });
    const batchId = createBatchId();
    const serializedTasks = tasks.map((task, index) => serializeTaskForResume(task, batchId, index));

    if (mode === "image") {
      for (let index = 0; index < tasks.length; index += 1) {
        const task = tasks[index];
        if (task.kind === "image" && task.file) {
          await putResumeFile(serializedTasks[index].fileRef, task.file);
        }
      }
    }

    return saveResumeCheckpoint({
      id: batchId,
      mode,
      total: tasks.length,
      nextIndex: 0,
      completedTasks: 0,
      currentTaskNumber: 0,
      currentTaskLabel: "",
      failedTasks: [],
      lastError: "",
      stoppedManually: false,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      settings: captureBatchSettings(),
      tasks: serializedTasks,
    });
  }

  async function loadTaskFileFromResume(task) {
    if (task.kind !== "image") {
      return null;
    }
    if (task.file instanceof File) {
      return task.file;
    }
    if (!task.fileRef) {
      throw new Error("断点图片缺少文件引用，请重新选择文件夹再启动");
    }
    const storedFile = await getResumeFile(task.fileRef);
    if (!storedFile) {
      throw new Error(`断点文件丢失：${task.label || "未命名图片"}，请重新选择文件夹再启动`);
    }
    task.file = storedFile instanceof File
      ? storedFile
      : new File([storedFile], task.fileName || "resume-image", { type: storedFile.type || "image/png" });
    return task.file;
  }

  async function loadResumeCheckpoint() {
    const checkpoint = readResumeCheckpoint();
    if (!checkpoint) {
      saveResumeCheckpoint(null);
      return null;
    }
    if (!hasResumableCheckpoint(checkpoint)) {
      await clearResumeCheckpoint({ preserveStatus: true });
      return null;
    }
    saveResumeCheckpoint(checkpoint);
    applyCheckpointProgress(checkpoint);
    return checkpoint;
  }

  function renderStatus(isError = false) {
    const el = getPanelElement(STATUS_ID);
    if (!el) {
      return;
    }
    const summary = [
      `总任务: ${state.batchTotal || 0}`,
      `已完成: ${state.completedTasks || 0}`,
      `当前: ${state.currentTaskNumber || 0}/${state.batchTotal || 0}${state.currentTaskLabel ? ` ${state.currentTaskLabel}` : ""}`,
    ];
    const lines = state.statusLines.length ? state.statusLines : ["就绪"];
    el.textContent = `${summary.join(" | ")}\n\n${lines.join("\n")}`;
    el.style.color = isError ? "#ff7875" : "#d9d9d9";
    el.scrollTop = el.scrollHeight;
  }

  function setStatus(message, isError = false) {
    const time = new Date().toLocaleTimeString("zh-CN", { hour12: false });
    state.statusLines.push(`[${time}] ${message}`);
    if (state.statusLines.length > 12) {
      state.statusLines = state.statusLines.slice(-12);
    }
    renderStatus(isError);
  }

  function resetStatus() {
    state.statusLines = [];
    renderStatus(false);
  }

  function addFailedTask(task, reason) {
    state.failedTasks.push({
      label: task.label || "未命名任务",
      reason,
    });
  }

  function isVisible(el) {
    if (!el) {
      return false;
    }
    const rect = el.getBoundingClientRect();
    const style = window.getComputedStyle(el);
    return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
  }

  async function waitFor(getter, timeout = 30000, interval = 200, label = "页面元素") {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      if (state.stopRequested) {
        throw new Error("任务已停止");
      }
      const value = getter();
      if (value) {
        return value;
      }
      await sleep(interval);
    }
    throw new Error(`等待${label}超时`);
  }

  function fireMouse(el, type) {
    el.dispatchEvent(
      new MouseEvent(type, {
        bubbles: true,
        cancelable: true,
        view: window,
      }),
    );
  }

  function humanClick(el) {
    if (!el) {
      throw new Error("点击目标不存在");
    }
    el.scrollIntoView({ block: "center", inline: "center", behavior: "smooth" });
    fireMouse(el, "mousemove");
    fireMouse(el, "mouseover");
    fireMouse(el, "mouseenter");
    fireMouse(el, "mousedown");
    fireMouse(el, "mouseup");
    el.click();
  }

  function humanHover(el) {
    if (!el) {
      throw new Error("悬停目标不存在");
    }
    el.scrollIntoView({ block: "center", inline: "center", behavior: "smooth" });
    fireMouse(el, "mousemove");
    fireMouse(el, "mouseover");
    fireMouse(el, "mouseenter");
  }

  function findClickableNewChatTrigger() {
    const current = qs('[data-testid="create_conversation_button"]');
    if (current && isVisible(current)) return current;
    const nodes = qsa("button,a,div,span");
    for (const node of nodes) {
      const text = (node.textContent || "").replace(/\s+/g, "");
      if (text !== "新对话") {
        continue;
      }
      const clickable = node.closest('button,a,[role="button"]') || node;
      if (isVisible(clickable)) {
        return clickable;
      }
    }
    return null;
  }

  function fireKeyboardShortcut(key, ctrlKey = false, metaKey = false) {
    const target = document.activeElement || document.body;
    const options = {
      key,
      code: `Key${key.toUpperCase()}`,
      bubbles: true,
      cancelable: true,
      ctrlKey,
      metaKey,
    };
    target.dispatchEvent(new KeyboardEvent("keydown", options));
    target.dispatchEvent(new KeyboardEvent("keyup", options));
  }

  async function startFreshConversation() {
    const beforeUrl = location.href;
    const trigger = findClickableNewChatTrigger();
    if (trigger) {
      humanClick(trigger);
    } else {
      fireKeyboardShortcut("k", true, false);
    }

    await sleep(1000);
    await waitFor(
      () => location.href !== beforeUrl || Boolean(findClickableNewChatTrigger()),
      10000,
      200,
      "新建会话",
    );
    await sleep(800);
    state.imageModeOpenedAt = 0;
  }

  function getEditorContainer(editor = getVisibleEditor()) {
    if (!editor) {
      return null;
    }
    return (
      editor.closest('[data-testid="chat_input"]') ||
      editor.closest("form") ||
      editor.closest('[class*="chat"][class*="input"]') ||
      editor.closest('[class*="input"]') ||
      editor.parentElement
    );
  }

  function findButtonNearEditor(texts, options = {}) {
    const editor = getVisibleEditor();
    const root = getEditorContainer(editor) || document;
    for (const text of texts) {
      const expected = normalizeText(text);
      const found = qsa('button,a,[role="button"],[tabindex],div,span', root).find((el) => {
        if (!isVisible(el)) {
          return false;
        }
        const clickable = getClickable(el);
        if (!clickable || !isVisible(clickable)) {
          return false;
        }
        const exact = options.exact !== false;
        return doesTextMatch(getElementText(el), expected, exact) || doesTextMatch(getElementText(clickable), expected, exact);
      });
      if (found) {
        return getClickable(found);
      }
    }
    return null;
  }

  function getImagePanelState() {
    const editor = getVisibleEditor();
    const panel =
      qs('[data-testid="skill-modal-image-creation"]') ||
      qs('[data-testid="skill-modal-image-skill"]') ||
      qs('[data-testid="chat_input"]') ||
      getEditorContainer(editor) ||
      editor?.parentElement ||
      null;
    return {
      panel,
      editor,
      referenceButton:
        qs('[data-testid="image-creation-chat-input-picture-reference-button"]') ||
        findButtonNearEditor(["参考图", "图片参考", "上传图片", "选择图片", "添加图片"], { exact: false }) ||
        getClickable(findVisibleButtonByAnyText(["参考图", "图片参考", "上传图片", "选择图片", "添加图片"], { exact: false })),
      modelButton:
        qs('[data-testid="image-creation-chat-input-picture-model-button"]') ||
        findButtonNearEditor(["Seedream", "模型"], { exact: false }) ||
        getClickable(findVisibleButtonByAnyText(["Seedream", "模型"], { exact: false })),
      ratioButton:
        qs('[data-testid="image-creation-chat-input-picture-ration-button"]') ||
        findButtonNearEditor(["比例", "尺寸", "画幅"], { exact: false }) ||
        getClickable(findVisibleButtonByAnyText(["比例", "尺寸", "画幅"], { exact: false })),
      styleButton:
        qs('[data-testid="image-creation-chat-input-picture-style-button"]') ||
        findButtonNearEditor(["风格"], { exact: false }) ||
        getClickable(findVisibleButtonByText("风格", { exact: false })),
    };
  }

  function isImagePanelReady() {
    const { editor } = getImagePanelState();
    if (!editor || !isVisible(editor)) return false;
    const modal = qs('[data-testid="skill-modal-image-creation"]') ||
      qs('[data-testid="skill-modal-image-skill"]');
    if (modal && isVisible(modal) && modal.contains(editor)) return true;
    const root = getEditorContainer(editor);
    if (!root) return false;
    const buttons = qsa('button,[role="button"]', root).filter(isVisible);
    const hasModel = buttons.some((el) => /Seedream|模型/.test(getElementText(el)));
    const hasRatio = buttons.some((el) => /比例|画幅/.test(getElementText(el)));
    return hasModel && hasRatio;
  }

  function findImageModeTrigger() {
    return (
      qs('[data-testid="skill_bar_button_3"]') ||
      qs('[data-testid*="image"][data-testid*="button"]') ||
      findButtonNearEditor(["图像生成", "图片生成", "AI绘画", "AI作画"], { exact: false }) ||
      getClickable(findVisibleButtonByAnyText(["图像生成", "图片生成", "AI绘画", "AI作画"], { exact: false })) ||
      getClickable(findVisibleButtonByAnyText(["AI创作"], { exact: true }))
    );
  }

  async function openMoreMenuForImageTrigger() {
    const moreButton =
      findButtonNearEditor(["更多"], { exact: true }) ||
      getClickable(findVisibleButtonByText("更多", { exact: true }));
    if (!moreButton) {
      return null;
    }
    humanClick(moreButton);
    await sleep(500);
    return findImageModeTrigger();
  }

  async function ensureImageModeOpen() {
    if (isImagePanelReady()) {
      return getImagePanelState();
    }

    let trigger = findImageModeTrigger();
    if (!trigger) {
      trigger = await openMoreMenuForImageTrigger();
    }

    if (!trigger) {
      throw new Error("没找到图像生成入口");
    }

    humanClick(trigger);
    state.imageModeOpenedAt = Date.now();
    return waitFor(
      () => (isImagePanelReady() ? getImagePanelState() : null),
      15000,
      200,
      "图像生成输入区",
    );
  }

  function normalizePromptText(text) {
    return text.replace(/\r\n?/g, "\n").replace(/\u00a0/g, " ");
  }

  function readEditorValue(editor) {
    if (editor instanceof HTMLTextAreaElement || editor instanceof HTMLInputElement) {
      return editor.value;
    }
    const doc = editor.editor?.view?.state?.doc;
    return doc ? doc.textBetween(0, doc.content.size, "\n") : (editor.innerText || "");
  }

  function assertPromptValue(editor, expected) {
    if (!editor || normalizePromptText(readEditorValue(editor)) !== normalizePromptText(expected)) {
      throw new Error("提示词写入校验失败，已停止发送。请保留断点并检查输入框。");
    }
  }

  function setEditorValue(editor, text) {
    if (typeof text !== "string") {
      throw new Error("提示词必须是文本，已阻止对象被转换成 [object Object]");
    }
    text = normalizePromptText(text);
    editor.focus();
    if (editor instanceof HTMLTextAreaElement || editor instanceof HTMLInputElement) {
      const proto = editor instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
      if (!setter) throw new Error("无法写入文本输入框");
      setter.call(editor, text);
      editor.dispatchEvent(new Event("input", { bubbles: true }));
      editor.dispatchEvent(new Event("change", { bubbles: true }));
    } else if (editor.editor?.view?.state?.schema) {
      // Current Doubao uses Tiptap/ProseMirror. Dispatch a real document
      // transaction so its editor model and React state both receive the text.
      // Build text nodes, never parse prompts as HTML or call ancestor onChange.
      const view = editor.editor.view;
      const { schema, doc, tr } = view.state;
      const paragraphs = text.split("\n").map((line) =>
        schema.nodes.paragraph.create(null, line ? schema.text(line) : null));
      view.dispatch(tr.replaceWith(0, doc.content.size, paragraphs).scrollIntoView());
    } else if (editor.isContentEditable) {
      // Browser input path for other contenteditable implementations.
      // Keep DOM mutations inside the editor's normal input handling.
      const selection = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(editor);
      selection.removeAllRanges();
      selection.addRange(range);
      const changed = text
        ? document.execCommand("insertText", false, text)
        : document.execCommand("delete", false);
      if (!changed && readEditorValue(editor) !== text) {
        throw new Error("当前输入框不支持自动填写，已停止发送");
      }
    } else {
      throw new Error("未找到真正可编辑的输入框，已停止发送");
    }
    assertPromptValue(editor, text);
    return true;
  }

  async function fillPrompt(prompt) {
    state.pendingPrompt = null;
    if (typeof prompt !== "string") throw new Error("提示词格式错误：需要文本");
    await ensureImageModeOpen();
    const editor = await waitFor(
      () => (isImagePanelReady() ? getImagePanelState().editor : null),
      10000, 200, "图像生成输入框",
    );
    humanClick(editor);
    await sleepRandom(180, 420);
    setEditorValue(editor, prompt);
    await sleepRandom(450, 900);
    assertPromptValue(getVisibleEditor(), prompt);
    state.pendingPrompt = prompt;
  }

  function isDisabledElement(el) {
    return Boolean(
      !el ||
      el.disabled ||
      el.getAttribute?.("aria-disabled") === "true" ||
      el.getAttribute?.("disabled") !== null,
    );
  }

  function findSendButton() {
    const directSelectors = [
      '[data-testid="chat_input_send_button"]',
      '[data-testid*="send"][role="button"]',
      'button[data-testid*="send"]',
      'button[aria-label*="发送"]',
      '[role="button"][aria-label*="发送"]',
      'button[title*="发送"]',
      'button[type="submit"]',
    ];
    for (const selector of directSelectors) {
      const direct = qs(selector);
      if (direct && isVisible(direct) && !isDisabledElement(direct)) {
        return direct;
      }
    }

    const editor = getVisibleEditor();
    if (!editor) {
      return null;
    }

    const container = getEditorContainer(editor) || editor.parentElement || document.body;
    const editorRect = editor.getBoundingClientRect();
    const containerRect = container.getBoundingClientRect();
    const rightEdge = Math.max(editorRect.right, containerRect.right);

    const candidates = qsa('button,[role="button"],[tabindex]', container)
      .map((node) => {
        const el = getClickable(node);
        return {
          el,
          rect: el?.getBoundingClientRect(),
          text: getElementText(el),
        };
      })
      .filter(({ el, rect }) => {
        if (!el || !rect || !isVisible(el) || isDisabledElement(el)) {
          return false;
        }
        const centerX = rect.left + rect.width / 2;
        const centerY = rect.top + rect.height / 2;
        return (
          rect.width >= 24 &&
          rect.width <= 76 &&
          rect.height >= 24 &&
          rect.height <= 76 &&
          centerX >= rightEdge - 140 &&
          centerY >= containerRect.top - 8 &&
          centerY <= containerRect.bottom + 8
        );
      })
      .sort((a, b) => {
        const score = (item) => {
          let value = item.el.tagName === "BUTTON" ? 2 : 0;
          if (/发送|send|submit|arrow|paper/i.test(item.text)) {
            value += 10;
          }
          if (/麦克风|语音|录音|mic|voice/i.test(item.text)) {
            value -= 8;
          }
          value += item.rect.left / 1000;
          return value;
        };
        return score(b) - score(a);
      });

    return candidates[0]?.el || null;
  }

  async function submitTask() {
    const sendButton = await waitFor(() => findSendButton(), 8000, 200, "发送按钮");
    await sleepRandom(500, 1400);
    if (state.stopRequested) throw new Error("任务已停止");
    const limitMessage = getGenerationLimitMessage();
    if (limitMessage) throw new Error(`生成受限，已停止：${limitMessage}`);
    if (!isImagePanelReady()) throw new Error("图像生成模式已退出，已停止发送");
    if (typeof state.pendingPrompt !== "string") throw new Error("提示词未通过校验，已停止发送");
    assertPromptValue(getVisibleEditor(), state.pendingPrompt);
    humanClick(sendButton);
    state.pendingPrompt = null;
    await sleepRandom(700, 1300);
  }

  function findAttachmentButton() {
    const textButton =
      findButtonNearEditor(["参考图", "上传", "附件", "图片", "添加"], { exact: false }) ||
      getClickable(findVisibleButtonByAnyText(["参考图", "上传", "附件", "图片", "添加"], { exact: false }));
    if (textButton && isVisible(textButton)) {
      return textButton;
    }

    const editor = getVisibleEditor();
    const container = getEditorContainer(editor);
    if (!editor || !container) {
      return null;
    }
    const editorRect = editor.getBoundingClientRect();
    const containerRect = container.getBoundingClientRect();
    const candidates = qsa('button,[role="button"],[tabindex]', container)
      .map((node) => {
        const el = getClickable(node);
        return { el, rect: el?.getBoundingClientRect(), text: getElementText(el) };
      })
      .filter(({ el, rect, text }) => {
        if (!el || !rect || !isVisible(el) || isDisabledElement(el)) {
          return false;
        }
        const centerX = rect.left + rect.width / 2;
        const centerY = rect.top + rect.height / 2;
        return (
          rect.width >= 24 &&
          rect.width <= 76 &&
          rect.height >= 24 &&
          rect.height <= 76 &&
          centerX <= editorRect.left + 120 &&
          centerY >= containerRect.top - 8 &&
          centerY <= containerRect.bottom + 8 &&
          !/快速|PPT|图像生成|帮我写作|更多|发送|麦克风|语音|mic|send/i.test(text)
        );
      })
      .sort((a, b) => a.rect.left - b.rect.left);
    return candidates[0]?.el || null;
  }

  async function uploadReferenceImage(file) {
    await ensureImageModeOpen();
    let uploadInput = qsa('input[type="file"]').find((el) => isReferenceUploadInput(el));
    if (!uploadInput) {
      const referenceButton = await waitFor(
        () => getImagePanelState().referenceButton || findAttachmentButton(),
        10000,
        200,
        "参考图/上传按钮",
      );
      humanClick(referenceButton);
      await sleep(300);
      uploadInput = await waitFor(
        () => qsa('input[type="file"]').find((el) => isReferenceUploadInput(el)),
        10000,
        200,
        "参考图上传框",
      );
    }

    const transfer = new DataTransfer();
    transfer.items.add(file);
    uploadInput.files = transfer.files;
    uploadInput.dispatchEvent(new Event("input", { bubbles: true }));
    uploadInput.dispatchEvent(new Event("change", { bubbles: true }));
    await sleepRandom(1800, 3200);
  }

  function isGeneratedResultImage(img) {
    if (!img || !isVisible(img)) {
      return false;
    }
    const src = img.currentSrc || img.src || "";
    if (!src || src.startsWith("data:") || src.startsWith("blob:")) {
      return false;
    }
    const className = String(img.className || "");
    // 只认"生成结果容器 / 生成图专属 class"，刻意不用 CDN 域名判断：
    // 侧栏会话头像、会话缩略图、16px UI 图标与生成图同在 imagex-sign.byteimg.com 域名下，
    // 用域名放行会把它们全部当成生成结果（v3.3 的实际故障原因）。
    const inResultContainer = img.closest('[data-testid="mdbox_image"], .image-item-liO_BU, .image-item-img-container-QRWTte');
    if (inResultContainer) {
      return true;
    }
    if (className.includes("image-Q7dBqW") || className.includes("image-item-img-")) {
      return true;
    }
    // 兜底：alt="image" 且已加载出真实尺寸（排除 16px 图标/占位）
    return img.alt === "image" && img.naturalWidth >= 200 && img.naturalHeight >= 200;
  }

  function getImageCards() {
    const images = qsa("img").filter((img) => isGeneratedResultImage(img));
    const cards = images.map((img) => img.closest('[data-testid="mdbox_image"], .image-item-liO_BU, .image-item-img-container-QRWTte') || img);
    // 同一个生成图容器里会挂多张 img（主图 + 悬停叠加层），按 DOM 节点去重
    return Array.from(new Set(cards));
  }

  function getCardImageUrl(card) {
    if (!card) {
      return "";
    }
    if (card.tagName === "IMG") {
      return card.currentSrc || card.src || "";
    }
    const img = card.querySelector('img[alt="image"], img.image-Q7dBqW, img[class*="image-item-img-"]');
    return img ? img.currentSrc || img.src || "" : "";
  }

  function getCardSignature(card) {
    return getCardImageUrl(card);
  }

  function getGenerationLimitMessage() {
    // 只检查最新回复及可见提示，避免旧限额记录或用户提示词阻止新任务。
    let replies = qsa('[data-testid="receive_message"]');
    if (!replies.length) {
      replies = qsa('[data-testid="message_content"], .markdown').filter((el) =>
        !el.closest('[data-testid="send_message"], [data-testid="chat_input_input"], [contenteditable="true"]'),
      );
    }
    const latestReply = replies[replies.length - 1];
    const notices = qsa('[role="alert"], [role="dialog"], [role="status"], [class*="toast"]')
      .filter((el) => isVisible(el) && !el.closest(`#${PANEL_ID}`));
    const nodes = latestReply ? [latestReply, ...notices] : notices;
    return nodes.map((el) => (el.textContent || "").replace(/\s+/g, " ").trim())
      .find((text) => getAutoRetryBlockReason(text)) || "";
  }

  async function waitForNewImages(previousSignatures) {
    const deadline = Date.now() + 60000;
    let stableSince = 0;
    let stableKey = "";

    while (Date.now() < deadline) {
      if (state.stopRequested) throw new Error("任务已停止");
      const limitMessage = getGenerationLimitMessage();
      if (limitMessage) {
        throw new Error(`生成受限，已停止：${limitMessage}`);
      }

      const cards = getImageCards();
      const freshCards = cards.filter((card) => !previousSignatures.has(getCardSignature(card)));
      const key = freshCards.map(getCardSignature).filter(Boolean).join("|");

      if (freshCards.length > 0 && key) {
        if (key === stableKey) {
          if (!stableSince) {
            stableSince = Date.now();
          }
          if (Date.now() - stableSince >= 4000) {
            return freshCards;
          }
        } else {
          stableKey = key;
          stableSince = Date.now();
        }
      }

      await sleep(1000);
    }

    throw new Error("等待新图片生成超时");
  }

  function findDownloadButtonBySvg(container) {
    const candidates = qsa(
      '[data-testid="edit_image_hover_tag_download_btn"], [data-testid="edit_image_hover_tag_download_btn"] *',
      container,
    );

    for (const el of candidates) {
      const root = el.matches('[data-testid="edit_image_hover_tag_download_btn"]')
        ? el
        : el.closest('[data-testid="edit_image_hover_tag_download_btn"]');
      if (!root) {
        continue;
      }
      const paths = qsa("path", root);
      if (paths.some((path) => path.getAttribute("d") === DOWNLOAD_SVG_PATH)) {
        return root.querySelector('[tabindex="0"]') || root;
      }
    }

    return null;
  }

  function findDownloadAction(card) {
    const container = card.closest(".container-dLabXv") || card.parentElement;
    if (!container) {
      return null;
    }

    const exact = container.querySelector('[data-testid="edit_image_hover_tag_download_btn"]');
    if (exact) {
      return exact.querySelector('[tabindex="0"]') || exact;
    }

    const bySvg = findDownloadButtonBySvg(container);
    if (bySvg) {
      return bySvg;
    }

    return qsa("div,button,span", container).find((el) => {
      const text = (el.textContent || "").trim();
      return text === "下载" && !el.closest('[data-testid="edit_image_hover_tag_regenerate_btn"]');
    });
  }

  async function downloadOriginalImages(cards) {
    for (let index = 0; index < cards.length; index += 1) {
      if (state.stopRequested) {
        throw new Error("任务已停止");
      }
      const card = cards[index];
      const url = getCardImageUrl(card);
      if (url) {
        await downloadBlobByUrl(url, index, cards.length, false);
        continue;
      }

      const img = card.querySelector('img[alt="image"]') || card;
      humanHover(img);
      fireMouse(img, "mouseenter");
      fireMouse(img, "mouseover");
      fireMouse(img, "mousemove");
      await sleep(900);
      const action = await waitFor(() => findDownloadAction(card), 8000, 200, "下载按钮");
      humanClick(action);
      setStatus(`正在下载第 ${index + 1}/${cards.length} 张原图`);
      await sleep(1800);
    }
  }

  async function downloadBlobByUrl(url, index, total, watermarkFree = true) {
    const response = await fetch(url, {
      method: "GET",
      mode: "cors",
      cache: "no-store",
    });
    if (!response.ok) {
      throw new Error(`下载失败: ${response.status}`);
    }

    const blob = await response.blob();
    const objectUrl = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = objectUrl;
    anchor.download = buildDownloadFilename(index, total, url, blob);
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(objectUrl);
    setStatus(`正在下载第 ${index + 1}/${total} 张${watermarkFree ? "无水印图" : "原图"}`);
    await sleep(1200);
  }

  async function downloadWatermarkFreeImages(urls) {
    for (let index = 0; index < urls.length; index += 1) {
      if (state.stopRequested) {
        throw new Error("任务已停止");
      }
      await downloadBlobByUrl(urls[index], index, urls.length);
    }
  }

  function updateNodeImageUrls(node) {
    if (!node || typeof node !== "object") {
      return;
    }

    for (const value of Object.values(node)) {
      if (Array.isArray(value)) {
        value.forEach(updateNodeImageUrls);
      } else if (value && typeof value === "object") {
        updateNodeImageUrls(value);
      }
    }

    if (node.image_ori?.url && node.image_ori_no_mark?.url) {
      node.image_ori.url = node.image_ori_no_mark.url;
    }
    if (node.image_url && node.image_url_no_mark) {
      node.image_url = node.image_url_no_mark;
    }
    if (node.url && node.url_no_mark) {
      node.url = node.url_no_mark;
    }
  }

  function findAllKeysInJson(obj, key) {
    const results = [];
    const search = (current) => {
      if (!current || typeof current !== "object") {
        return;
      }
      if (!Array.isArray(current) && Object.prototype.hasOwnProperty.call(current, key)) {
        results.push(current[key]);
      }
      const items = Array.isArray(current) ? current : Object.values(current);
      items.forEach(search);
    };
    search(obj);
    return results;
  }

  function captureRawUrlsFromJson(jsonData) {
    if (!jsonData || typeof jsonData !== "object") {
      return [];
    }

    const urls = [];
    const creations = findAllKeysInJson(jsonData, "creations");
    creations.forEach((creation) => {
      if (!Array.isArray(creation)) {
        return;
      }
      creation.forEach((item) => {
        const rawUrl = item?.image?.image_ori_raw?.url;
        if (!rawUrl) {
          return;
        }
        if (item.image.image_ori) {
          item.image.image_ori.url = rawUrl;
        }
        if (item.image.image_preview) {
          item.image.image_preview.url = rawUrl;
        }
        if (item.image.image_thumb) {
          item.image.image_thumb.url = rawUrl;
        }
        urls.push(rawUrl);
      });
    });
    return Array.from(new Set(urls));
  }

  function appendRawUrls(urls) {
    urls.forEach((url) => {
      if (!state.rawUrlSeen.has(url)) {
        state.rawUrlSeen.add(url);
        state.rawImageUrls.push(url);
      }
    });
  }

  function processRawImagePayload(jsonData) {
    const rawUrls = captureRawUrlsFromJson(jsonData);
    if (rawUrls.length) {
      appendRawUrls(rawUrls);
    }
    updateNodeImageUrls(jsonData);
    return rawUrls;
  }

  function tryCaptureRawUrlsFromText(text) {
    if (!text || !text.includes("creations")) {
      return;
    }
    try {
      const parsed = JSON.parse(text);
      processRawImagePayload(parsed);
    } catch (error) {
      console.warn("doubao-image-auto raw text parse failed:", error);
    }
  }

  async function waitForRawUrlsSince(startIndex, timeout = 12000) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      if (state.stopRequested) {
        throw new Error("任务已停止");
      }
      const rawUrls = state.rawImageUrls.slice(startIndex);
      if (rawUrls.length) {
        return rawUrls;
      }
      await sleep(300);
    }
    return [];
  }

  function enableRemoveWatermarkHook() {
    if (state.watermarkHooked) {
      return;
    }
    state.watermarkHooked = true;

    const originalJSONParse = JSON.parse.bind(JSON);
    const originalFetch = window.fetch.bind(window);
    const originalResponseJson = Response.prototype.json;
    const originalXHROpen = XMLHttpRequest.prototype.open;
    const originalXHRSend = XMLHttpRequest.prototype.send;
    JSON.parse = function patchedJSONParse(text, reviver) {
      const parsed = originalJSONParse(text, reviver);
      try {
        if (isRemoveWatermarkEnabled()) {
          processRawImagePayload(parsed);
        }
      } catch (error) {
        console.warn("doubao-image-auto watermark hook failed:", error);
      }
      return parsed;
    };

    Response.prototype.json = async function patchedResponseJson(...args) {
      const parsed = await originalResponseJson.apply(this, args);
      try {
        if (isRemoveWatermarkEnabled()) {
          processRawImagePayload(parsed);
        }
      } catch (error) {
        console.warn("doubao-image-auto response.json hook failed:", error);
      }
      return parsed;
    };

    window.fetch = async function patchedFetch(...args) {
      const response = await originalFetch(...args);
      if (isRemoveWatermarkEnabled()) {
        response
          .clone()
          .text()
          .then((text) => tryCaptureRawUrlsFromText(text))
          .catch(() => {});
      }
      return response;
    };

    XMLHttpRequest.prototype.open = function patchedOpen(...args) {
      this.__doubaoImageAutoUrl = args[1];
      return originalXHROpen.apply(this, args);
    };

    XMLHttpRequest.prototype.send = function patchedSend(...args) {
      this.addEventListener("load", function onLoad() {
        if (!isRemoveWatermarkEnabled()) {
          return;
        }
        if (typeof this.responseText === "string") {
          tryCaptureRawUrlsFromText(this.responseText);
        }
      });
      return originalXHRSend.apply(this, args);
    };
  }

  function isRemoveWatermarkEnabled() {
    const checkbox = getPanelElement(REMOVE_WATERMARK_ID);
    return checkbox ? checkbox.checked : localStorage.getItem(STORAGE_REMOVE_WATERMARK) === "1";
  }

  function padTaskNumber(value) {
    return String(value).padStart(3, "0");
  }

  function stripBom(text) {
    return String(text || "").replace(/^\uFEFF/, "").trim();
  }

  function splitNamedPromptLine(line) {
    const rawLine = stripBom(line);
    const halfWidthIndex = rawLine.indexOf("|");
    const fullWidthIndex = rawLine.indexOf("｜");
    const chineseBarIndex = rawLine.indexOf("丨");
    const indexes = [halfWidthIndex, fullWidthIndex, chineseBarIndex].filter((index) => index > 0);
    if (!indexes.length) {
      return null;
    }
    const separatorIndex = Math.min(...indexes);
    const name = sanitizeFilenamePart(rawLine.slice(0, separatorIndex).trim());
    const prompt = rawLine.slice(separatorIndex + 1).trim();
    if (!name || !prompt) {
      return null;
    }
    return {
      name,
      prompt,
    };
  }

  function normalizeTextTaskPrompt(task, index) {
    if (task.kind !== "text") {
      return task.prompt || "";
    }
    const namedLine = splitNamedPromptLine(task.prompt || "");
    if (namedLine) {
      if (task.textNamingMode !== "file") {
        task.downloadBaseName = namedLine.name;
        task.label = namedLine.name;
      }
      return namedLine.prompt;
    }
    return task.prompt || `文生图-${padTaskNumber(index + 1)}`;
  }

  async function readTextTasks(file) {
    const content = await file.text();
    const namingMode = getTextNamingMode();
    const txtBaseName = sanitizeFilenamePart((file?.name || "文生图").replace(/\.[^.]+$/, "")) || "文生图";
    return content
      .split(/\r?\n/)
      .map((line) => stripBom(line))
      .filter(Boolean)
      .map((line, index) => {
        const namedLine = splitNamedPromptLine(line);
        const customName = namedLine?.name || "";
        const prompt = namedLine?.prompt || line;
        const taskNumber = index + 1;
        const numberedName = `${txtBaseName}-${padTaskNumber(taskNumber)}`;
        const fallbackName = namingMode === "file" ? numberedName : `文生图-${padTaskNumber(taskNumber)}`;
        const downloadBaseName = namingMode === "file" ? numberedName : (customName || fallbackName);
        return {
          kind: "text",
          label: downloadBaseName,
          downloadBaseName,
          textNamingMode: namingMode,
          prompt,
        };
      })
      .filter((task) => task.prompt);
  }

  function readImageTasks(fileList, extraPrompt) {
    return Array.from(fileList)
      .filter((file) => file.type.startsWith("image/"))
      .sort((a, b) => a.webkitRelativePath.localeCompare(b.webkitRelativePath, "zh-CN"))
      .map((file, index) => ({
        kind: "image",
        label: file.webkitRelativePath || file.name || `图生图 ${index + 1}`,
        file,
        prompt: extraPrompt.trim(),
      }));
  }

  async function runSingleTask(task, index, total) {
    state.currentTaskNumber = index + 1;
    state.currentTaskLabel = task.label;
    setStatus(`任务 ${index + 1}/${total}：准备 ${task.label}`);
    await ensureImageModeOpen();
    const previousSignatures = new Set(getImageCards().map(getCardSignature).filter(Boolean));
    const rawUrlStart = state.rawImageUrls.length;

    if (task.kind === "image") {
      await loadTaskFileFromResume(task);
      setStatus(`任务 ${index + 1}/${total}：上传参考图`);
      await uploadReferenceImage(task.file);
    }

    const prompt = normalizeTextTaskPrompt(task, index);
    state.currentTaskLabel = task.label;
    state.currentDownloadBaseName = task.kind === "image"
      ? sanitizeFilenamePart((task.file?.name || task.fileName || "参考图").replace(/\.[^.]+$/, ""))
      : sanitizeFilenamePart(task.downloadBaseName || task.label || `文生图-${padTaskNumber(index + 1)}`);
    if (!prompt && task.kind === "text") {
      throw new Error("文生图任务缺少提示词");
    }

    setStatus(`任务 ${index + 1}/${total}：填写提示词`);
    await fillPrompt(prompt);

    if (task.kind === "image") {
      setStatus(`任务 ${index + 1}/${total}：等待参考图稳定`);
      await sleepRandom(1800, 3600);
    }

    setStatus(`任务 ${index + 1}/${total}：发送`);
    await submitTask();

    setStatus(`任务 ${index + 1}/${total}：等待生成`);
    const cards = await waitForNewImages(previousSignatures);

    const limitedCards = limitDownloadItems(cards);
    let rawUrls = isRemoveWatermarkEnabled()
      ? await waitForRawUrlsSince(rawUrlStart, 12000)
      : state.rawImageUrls.slice(rawUrlStart);
    if (isRemoveWatermarkEnabled() && cards.length > 0 && rawUrls.length > cards.length) {
      rawUrls = rawUrls.slice(-cards.length);
    }
    rawUrls = limitDownloadItems(rawUrls);
    if (isRemoveWatermarkEnabled() && rawUrls.length) {
      setStatus(`任务 ${index + 1}/${total}：下载 ${rawUrls.length}/${cards.length} 张无水印图`);
      await downloadWatermarkFreeImages(rawUrls);
      state.completedTasks = index + 1;
      setStatus(`任务 ${index + 1}/${total}：完成`);
      return;
    }

    if (isRemoveWatermarkEnabled()) {
      setStatus(`任务 ${index + 1}/${total}：未捕获无水印地址，回退原图下载`);
      await sleep(1200);
    }

    setStatus(`任务 ${index + 1}/${total}：下载 ${limitedCards.length}/${cards.length} 张`);
    await downloadOriginalImages(limitedCards);
    state.completedTasks = index + 1;
    setStatus(`任务 ${index + 1}/${total}：完成`);
  }

  async function runBatch(tasks, options = {}) {
    const {
      checkpoint: initialCheckpoint = null,
      startIndex: initialStartIndex = 0,
      resumeLabel = "",
      automaticResume = false,
    } = options;
    if (state.running) {
      return;
    }
    if (!tasks.length) {
      setStatus("没有可执行任务", true);
      return;
    }
    if (initialStartIndex >= tasks.length) {
      await clearResumeCheckpoint({ preserveStatus: true });
      setStatus("断点任务已经跑完了", true);
      return;
    }

    cancelAutoRetry();
    state.running = true;
    state.stopRequested = false;
    state.resumeCheckpoint = initialCheckpoint;
    state.batchTotal = initialCheckpoint?.total || tasks.length;
    state.currentTaskNumber = 0;
    state.completedTasks = initialCheckpoint?.completedTasks || 0;
    state.currentTaskLabel = "";
    state.failedTasks = Array.isArray(initialCheckpoint?.failedTasks) ? [...initialCheckpoint.failedTasks] : [];
    resetStatus();
    if (resumeLabel) {
      setStatus(resumeLabel);
    } else {
      setStatus(`开始执行，共 ${tasks.length} 个任务`);
    }
    toggleButtons(true);

    let nextResumeIndex = initialStartIndex;
    let retryMessage = null;
    try {
      enableRemoveWatermarkHook();
      if (initialCheckpoint) {
        updateResumeCheckpoint({
          nextIndex: initialStartIndex,
          completedTasks: state.completedTasks,
          currentTaskNumber: initialStartIndex ? initialStartIndex + 1 : 0,
          currentTaskLabel: tasks[initialStartIndex]?.label || "",
          failedTasks: state.failedTasks,
          lastError: "",
          stoppedManually: false,
          autoRetryBlockedReason: "",
          autoRetryAttempts: automaticResume ? initialCheckpoint.autoRetryAttempts || 0 : 0,
        });
      }
      setStatus("正在新建会话");
      await startFreshConversation();
      setStatus("已进入新会话");
      for (let index = initialStartIndex; index < tasks.length; index += 1) {
        if (state.stopRequested) {
          throw new Error("任务已停止");
        }
        nextResumeIndex = index;
        if (state.resumeCheckpoint) {
          updateResumeCheckpoint({
            nextIndex: index,
            completedTasks: state.completedTasks,
            currentTaskNumber: index + 1,
            currentTaskLabel: tasks[index]?.label || "",
            failedTasks: state.failedTasks,
            lastError: "",
            stoppedManually: false,
          });
        }
        await runSingleTask(tasks[index], index, tasks.length);
        nextResumeIndex = index + 1;
        if (state.resumeCheckpoint) {
          updateResumeCheckpoint({
            nextIndex: nextResumeIndex,
            completedTasks: state.completedTasks,
            currentTaskNumber: nextResumeIndex < tasks.length ? nextResumeIndex + 1 : tasks.length,
            currentTaskLabel: tasks[nextResumeIndex]?.label || "",
            failedTasks: state.failedTasks,
            lastError: "",
            stoppedManually: false,
            autoRetryAttempts: 0,
          });
        }
        await sleepRandom(1200, 2600);
      }
      if (state.failedTasks.length) {
        const failedSummary = state.failedTasks.map((item) => `${item.label}（${item.reason}）`).join("；");
        setStatus(`完成，共执行 ${tasks.length} 个任务；失败 ${state.failedTasks.length} 个：${failedSummary}`, true);
      } else {
        setStatus(`完成，共执行 ${tasks.length} 个任务`);
      }
      await clearResumeCheckpoint({ preserveStatus: true });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      retryMessage = message;
      if (state.resumeCheckpoint) {
        updateResumeCheckpoint({
          nextIndex: nextResumeIndex,
          completedTasks: state.completedTasks,
          currentTaskNumber: state.currentTaskNumber,
          currentTaskLabel: state.currentTaskLabel,
          failedTasks: state.failedTasks,
          lastError: message,
          stoppedManually: state.stopRequested,
        });
      }
      setStatus(message, true);
    } finally {
      state.running = false;
      if (state.stopRequested && state.completedTasks < state.batchTotal) {
        setStatus(`已停止，停在第 ${state.currentTaskNumber}/${state.batchTotal} 个任务`, true);
      }
      toggleButtons(false);
      if (retryMessage !== null) scheduleAutoRetry(retryMessage);
    }
  }

  function toggleButtons(disabled) {
    const root = getPanelRoot();
    if (!root) {
      return;
    }
    qsa('button[data-role="action"]', root).forEach((button) => {
      const mode = button.getAttribute("data-mode");
      const shouldDisable = mode === "stop" ? false : disabled;
      button.disabled = shouldDisable;
      button.style.opacity = shouldDisable ? "0.6" : "1";
      button.style.cursor = shouldDisable ? "not-allowed" : "pointer";
    });
    const textNamingMode = getPanelElement(TEXT_NAMING_MODE_ID);
    if (textNamingMode) {
      textNamingMode.disabled = disabled;
      textNamingMode.style.opacity = disabled ? "0.6" : "1";
      textNamingMode.style.cursor = disabled ? "not-allowed" : "pointer";
    }
    const downloadCount = getPanelElement(DOWNLOAD_COUNT_ID);
    if (downloadCount) {
      downloadCount.disabled = disabled;
      downloadCount.style.opacity = disabled ? "0.6" : "1";
      downloadCount.style.cursor = disabled ? "not-allowed" : "pointer";
    }
    syncResumeControls();
  }

  function savePanelState() {
    const extraPrompt = getPanelElement(EXTRA_PROMPT_ID);
    const removeWatermark = getPanelElement(REMOVE_WATERMARK_ID);
    const textNamingMode = getPanelElement(TEXT_NAMING_MODE_ID);
    const downloadCount = getPanelElement(DOWNLOAD_COUNT_ID);
    if (extraPrompt) {
      localStorage.setItem(STORAGE_EXTRA_PROMPT, extraPrompt.value);
    }
    if (removeWatermark) {
      localStorage.setItem(STORAGE_REMOVE_WATERMARK, removeWatermark.checked ? "1" : "0");
    }
    if (textNamingMode) {
      localStorage.setItem(STORAGE_TEXT_NAMING_MODE, textNamingMode.value);
    }
    if (downloadCount) {
      localStorage.setItem(STORAGE_DOWNLOAD_COUNT, downloadCount.value);
    }
  }

  function createPanel() {
    const host = document.createElement("div");
    host.id = PANEL_ID;
    host.style.position = "fixed";
    host.style.top = "24px";
    host.style.right = "24px";
    host.style.width = "360px";
    host.style.height = "min(760px, calc(100vh - 24px))";
    host.style.minHeight = "0";
    host.style.maxHeight = "calc(100vh - 24px)";
    host.style.overflow = "visible";
    host.style.zIndex = "2147483647";
    host.style.transition = "transform 0.28s ease";
    document.body.appendChild(host);

    const shadow = host.attachShadow({ mode: "open" });
    shadow.innerHTML = `
      <style>
        :host {
          --bg-main: rgba(15, 23, 42, 0.85);
          --bg-panel: rgba(255, 255, 255, 0.02);
          --bg-input: rgba(0, 0, 0, 0.25);
          --border-light: rgba(255, 255, 255, 0.08);
          --text-primary: #f8fafc;
          --text-secondary: #94a3b8;
          --accent-blue: #3b82f6;
          --accent-red: #ef4444;
          --radius-lg: 16px;
          --radius-md: 10px;
          --radius-sm: 8px;
          font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
        }
        * { box-sizing: border-box; }
        .panel-container {
          position: relative;
          width: 100%;
          height: 100%;
          min-height: 0;
          display: flex;
          flex-direction: column;
          color: var(--text-primary);
          background: var(--bg-main);
          backdrop-filter: blur(16px);
          -webkit-backdrop-filter: blur(16px);
          border: 1px solid var(--border-light);
          border-radius: var(--radius-lg);
          box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.5), 0 0 0 1px rgba(255, 255, 255, 0.05);
          overflow: hidden;
        }
        .panel-header {
          padding: 16px 20px;
          background: rgba(255, 255, 255, 0.03);
          border-bottom: 1px solid var(--border-light);
          display: flex;
          justify-content: space-between;
          align-items: center;
          cursor: move;
          user-select: none;
        }
        .header-left {
          display: flex;
          align-items: center;
          gap: 10px;
          min-width: 0;
        }
        .panel-header strong {
          font-size: 15px;
          font-weight: 600;
          background: linear-gradient(135deg, #60a5fa, #a78bfa);
          -webkit-background-clip: text;
          -webkit-text-fill-color: transparent;
        }
        .panel-header span {
          font-size: 12px;
          color: var(--text-secondary);
          background: rgba(255, 255, 255, 0.1);
          padding: 2px 6px;
          border-radius: 4px;
        }
        .label-with-tip {
          display: inline-flex;
          align-items: center;
          gap: 6px;
        }
        button.help-tip {
          position: relative;
          width: 16px;
          height: 16px;
          min-width: 16px;
          padding: 0;
          border-radius: 999px;
          border: 1px solid rgba(148, 163, 184, 0.4);
          background: rgba(148, 163, 184, 0.12);
          color: #cbd5e1;
          font-size: 11px;
          line-height: 1;
          font-weight: 700;
        }
        button.help-tip:hover {
          background: rgba(59, 130, 246, 0.18);
          border-color: rgba(96, 165, 250, 0.7);
          color: #eff6ff;
        }
        button.help-tip:hover::after {
          content: attr(data-tooltip);
          position: absolute;
          left: 50%;
          bottom: calc(100% + 8px);
          transform: translateX(-50%);
          width: 240px;
          padding: 8px 10px;
          border-radius: 8px;
          background: rgba(15, 23, 42, 0.96);
          border: 1px solid rgba(148, 163, 184, 0.28);
          color: #e2e8f0;
          font-size: 11px;
          line-height: 1.5;
          white-space: normal;
          text-align: left;
          box-shadow: 0 14px 30px rgba(0, 0, 0, 0.28);
          z-index: 10;
          pointer-events: none;
        }
        button.help-tip:hover::before {
          content: "";
          position: absolute;
          left: 50%;
          bottom: calc(100% + 3px);
          transform: translateX(-50%) rotate(45deg);
          width: 10px;
          height: 10px;
          background: rgba(15, 23, 42, 0.96);
          border-right: 1px solid rgba(148, 163, 184, 0.28);
          border-bottom: 1px solid rgba(148, 163, 184, 0.28);
          z-index: 9;
          pointer-events: none;
        }
        .panel-body {
          padding: 16px 20px;
          min-height: 0;
          flex: 1 1 auto;
          overflow-y: auto;
          display: flex;
          flex-direction: column;
          gap: 16px;
        }
        ::-webkit-scrollbar { width: 6px; }
        ::-webkit-scrollbar-track { background: transparent; }
        ::-webkit-scrollbar-thumb { background: rgba(255, 255, 255, 0.1); border-radius: 10px; }
        ::-webkit-scrollbar-thumb:hover { background: rgba(255, 255, 255, 0.2); }
        .section {
          background: var(--bg-panel);
          border: 1px solid var(--border-light);
          border-radius: var(--radius-md);
          padding: 14px;
          display: flex;
          flex-direction: column;
          gap: 12px;
        }
        .section-title {
          font-size: 13px;
          font-weight: 600;
          color: var(--text-primary);
          display: flex;
          align-items: center;
          gap: 6px;
        }
        .section-title::before {
          content: "";
          display: block;
          width: 3px;
          height: 12px;
          background: var(--accent-blue);
          border-radius: 2px;
        }
        .form-group {
          display: flex;
          flex-direction: column;
          gap: 6px;
        }
        .form-row {
          display: flex;
          justify-content: space-between;
          align-items: center;
        }
        .form-row span {
          font-size: 12px;
          color: var(--text-secondary);
        }
        .hint {
          font-size: 11px;
          color: var(--text-secondary);
          line-height: 1.4;
        }
        input[type="file"], textarea, select {
          width: 100%;
          background: var(--bg-input);
          border: 1px solid var(--border-light);
          color: var(--text-primary);
          border-radius: var(--radius-sm);
          padding: 8px 12px;
          font-size: 12px;
          outline: none;
          transition: all 0.2s ease;
        }
        select {
          width: 65%;
          cursor: pointer;
        }
        select option {
          background: #1e293b;
        }
        input[type="file"] {
          padding: 6px;
        }
        input[type="file"]::file-selector-button {
          background: rgba(255, 255, 255, 0.1);
          border: 1px solid rgba(255, 255, 255, 0.05);
          color: var(--text-primary);
          padding: 6px 12px;
          border-radius: 6px;
          margin-right: 12px;
          cursor: pointer;
          transition: background 0.2s;
          font-size: 12px;
          font-weight: 500;
        }
        input[type="file"]::file-selector-button:hover {
          background: rgba(255, 255, 255, 0.15);
        }
        input:focus, textarea:focus, select:focus {
          border-color: var(--accent-blue);
          box-shadow: 0 0 0 2px rgba(59, 130, 246, 0.15);
        }
        textarea {
          min-height: 64px;
          resize: vertical;
        }
        .checkbox-row {
          display: flex;
          align-items: center;
          gap: 8px;
          font-size: 12px;
          color: var(--text-primary);
          cursor: pointer;
          user-select: none;
        }
        .checkbox-row input[type="checkbox"] {
          width: auto;
          accent-color: var(--accent-blue);
          width: 14px;
          height: 14px;
          cursor: pointer;
        }
        .actions-grid {
          display: grid;
          grid-template-columns: 1fr 1fr;
          gap: 10px;
        }
        button {
          border: none;
          border-radius: var(--radius-sm);
          padding: 10px;
          font-size: 13px;
          font-weight: 600;
          cursor: pointer;
          display: flex;
          justify-content: center;
          align-items: center;
          gap: 6px;
          transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1);
        }
        button:active { transform: scale(0.97); }
        button:disabled { opacity: 0.5; cursor: not-allowed; transform: none; filter: grayscale(50%); }
        button.edge-toggle {
          position: absolute;
          top: 50%;
          left: -32px;
          transform: translateY(-50%);
          width: 32px;
          height: 84px;
          padding: 0;
          border-radius: 12px 0 0 12px;
          border: 1px solid rgba(255, 255, 255, 0.12);
          border-right: none;
          background: rgba(15, 23, 42, 0.72);
          color: #dbeafe;
          display: flex;
          flex-direction: column;
          justify-content: center;
          align-items: center;
          gap: 6px;
          z-index: 3;
          backdrop-filter: blur(14px);
          -webkit-backdrop-filter: blur(14px);
        }
        button.edge-toggle:hover {
          background: rgba(30, 41, 59, 0.92);
          box-shadow: 0 8px 20px rgba(15, 23, 42, 0.35);
        }
        button.edge-toggle:active {
          transform: none;
        }
        .toggle-chevron {
          font-size: 16px;
          line-height: 1;
          transition: transform 0.25s ease;
        }
        .toggle-label {
          font-size: 10px;
          line-height: 1.2;
          text-align: center;
          writing-mode: vertical-lr;
        }
        .btn-primary { background: linear-gradient(135deg, #3b82f6, #2563eb); color: white; border: 1px solid rgba(255,255,255,0.1); }
        .btn-primary:hover:not(:disabled) { box-shadow: 0 4px 12px rgba(59, 130, 246, 0.3); }
        .btn-secondary { background: linear-gradient(135deg, #10b981, #059669); color: white; border: 1px solid rgba(255,255,255,0.1); }
        .btn-secondary:hover:not(:disabled) { box-shadow: 0 4px 12px rgba(16, 185, 129, 0.3); }
        .btn-muted { background: rgba(255, 255, 255, 0.08); color: #e2e8f0; border: 1px solid rgba(255,255,255,0.1); }
        .btn-muted:hover:not(:disabled) { background: rgba(255, 255, 255, 0.14); }
        .btn-danger { background: transparent; color: var(--accent-red); border: 1px solid rgba(239, 68, 68, 0.5); width: 100%; margin-top: -2px; }
        .btn-danger:hover:not(:disabled) { background: rgba(239, 68, 68, 0.1); border-color: var(--accent-red); }
        .status-box {
          background: #000;
          border: 1px solid var(--border-light);
          border-radius: var(--radius-sm);
          padding: 12px;
          font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
          font-size: 11px;
          line-height: 1.5;
          min-height: 100px;
          max-height: 160px;
          overflow-y: auto;
          white-space: pre-wrap;
          word-break: break-word;
          box-shadow: inset 0 2px 4px rgba(0,0,0,0.3);
        }
      </style>
      <div class="panel-container" id="panel-container">
        <button id="doubao-image-auto-toggle" class="edge-toggle" type="button" title="收起面板" data-collapsed="0">
          <span class="toggle-chevron">‹</span>
          <span class="toggle-label">收起</span>
        </button>
        <div class="panel-header">
          <div class="header-left">
            <strong>豆包图像生成助手</strong>
          </div>
          <span>v${SCRIPT_VERSION}</span>
        </div>
        <div class="panel-body">
          <div class="section">
            <div class="section-title">文生图批量</div>
            <div class="form-group">
              <input id="${TXT_INPUT_ID}" type="file" accept=".txt" />
              <div class="hint">TXT格式：一行一个，格式为"文件名丨提示词" 或直接提示词</div>
            </div>
            <div class="form-row">
              <span class="label-with-tip">
                命名方式
                <button
                  class="help-tip"
                  type="button"
                  title="上传的TXT文件按照 文件名丨提示词 的格式，下载时自动用丨前面的名字命名。"
                  data-tooltip="上传的TXT文件按照 文件名丨提示词 的格式，下载时自动用丨前面的名字命名。"
                >?</button>
              </span>
              <select id="${TEXT_NAMING_MODE_ID}">
                <option value="line">按“文件名丨提示词”命名</option>
                <option value="file">按文件自动编号命名</option>
              </select>
            </div>
            <div class="form-row">
              <span>下载张数</span>
              <select id="${DOWNLOAD_COUNT_ID}">
                <option value="1">1</option>
                <option value="2">2</option>
                <option value="3">3</option>
                <option value="4">4</option>
                <option value="all">全部</option>
              </select>
            </div>
          </div>
          <div class="section">
            <div class="section-title">图生图批量</div>
            <div class="form-group">
              <input id="${FOLDER_INPUT_ID}" type="file" accept=".jpg,.jpeg,.png,.webp" webkitdirectory directory multiple />
            </div>
            <div class="form-group">
              <textarea id="${EXTRA_PROMPT_ID}" placeholder="附加提示词，非必填..."></textarea>
            </div>
            <label class="checkbox-row">
              <input id="${REMOVE_WATERMARK_ID}" type="checkbox" />
              <span>下载时尝试去除水印</span>
            </label>
          </div>
          <div class="actions-grid">
            <button class="btn-primary" data-role="action" data-mode="text">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="7 10 12 15 17 10"></polyline><line x1="12" y1="15" x2="12" y2="3"></line></svg>
              文生图
            </button>
            <button class="btn-secondary" data-role="action" data-mode="image">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect><circle cx="8.5" cy="8.5" r="1.5"></circle><polyline points="21 15 16 10 5 21"></polyline></svg>
              图生图
            </button>
          </div>
          <div class="actions-grid">
            <button class="btn-muted" data-role="action" data-mode="resume" id="${RESUME_BUTTON_ID}">
              继续上次
            </button>
            <button class="btn-muted" data-role="action" data-mode="clear-resume" id="${CLEAR_RESUME_BUTTON_ID}">
              清除断点
            </button>
          </div>
          <div id="${RESUME_HINT_ID}" class="hint">未检测到断点任务</div>
          <button class="btn-danger" data-role="action" data-mode="stop">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect></svg>
            强制停止
          </button>
          <div id="${STATUS_ID}" class="status-box">终端就绪...</div>
        </div>
      </div>
    `;

    const extraPrompt = shadow.getElementById(EXTRA_PROMPT_ID);
    const removeWatermark = shadow.getElementById(REMOVE_WATERMARK_ID);
    const textNamingMode = shadow.getElementById(TEXT_NAMING_MODE_ID);
    const downloadCount = shadow.getElementById(DOWNLOAD_COUNT_ID);
    const toggleButton = shadow.getElementById("doubao-image-auto-toggle");
    const collapsedTransform = "translateX(calc(100% + 24px))";
    const panelHeader = shadow.querySelector(".panel-header");
    const storedPosition = (() => {
      try {
        const value = JSON.parse(localStorage.getItem(STORAGE_PANEL_POSITION) || "null");
        return value && Number.isFinite(value.left) && Number.isFinite(value.top) ? value : null;
      } catch {
        return null;
      }
    })();
    const clampPanelPosition = (left, top) => {
      const width = host.offsetWidth || 360;
      const height = host.offsetHeight || 0;
      return {
        left: Math.max(8, Math.min(left, window.innerWidth - width - 8)),
        top: Math.max(8, Math.min(top, window.innerHeight - Math.min(height, window.innerHeight) - 8)),
      };
    };
    const setPanelPosition = (left, top, persist = true) => {
      const position = clampPanelPosition(left, top);
      host.style.left = `${position.left}px`;
      host.style.top = `${position.top}px`;
      host.style.right = "auto";
      if (persist) {
        localStorage.setItem(STORAGE_PANEL_POSITION, JSON.stringify(position));
      }
    };
    if (storedPosition) {
      setPanelPosition(storedPosition.left, storedPosition.top, false);
    }
    window.addEventListener("resize", () => {
      const rect = host.getBoundingClientRect();
      setPanelPosition(rect.left, rect.top, false);
    });
    if (panelHeader) {
      let dragState = null;
      panelHeader.addEventListener("pointerdown", (event) => {
        if (event.button !== 0 || event.target instanceof Element && event.target.closest("button")) {
          return;
        }
        const rect = host.getBoundingClientRect();
        dragState = { offsetX: event.clientX - rect.left, offsetY: event.clientY - rect.top };
        panelHeader.setPointerCapture?.(event.pointerId);
        event.preventDefault();
      });
      panelHeader.addEventListener("pointermove", (event) => {
        if (!dragState) return;
        setPanelPosition(event.clientX - dragState.offsetX, event.clientY - dragState.offsetY);
      });
      const stopDragging = (event) => {
        if (!dragState) return;
        dragState = null;
        panelHeader.releasePointerCapture?.(event.pointerId);
      };
      panelHeader.addEventListener("pointerup", stopDragging);
      panelHeader.addEventListener("pointercancel", stopDragging);
    }
    const applyCollapsedState = (collapsed) => {
      host.style.transform = collapsed ? collapsedTransform : "translateX(0)";
      if (toggleButton) {
        toggleButton.dataset.collapsed = collapsed ? "1" : "0";
        toggleButton.title = collapsed ? "展开面板" : "收起面板";
        const label = toggleButton.querySelector(".toggle-label");
        const chevron = toggleButton.querySelector(".toggle-chevron");
        if (label) {
          label.textContent = collapsed ? "展开" : "收起";
        }
        if (chevron) {
          chevron.style.transform = collapsed ? "rotate(180deg)" : "rotate(0deg)";
        }
      }
      localStorage.setItem(STORAGE_COLLAPSED, collapsed ? "1" : "0");
    };
    extraPrompt.value = localStorage.getItem(STORAGE_EXTRA_PROMPT) || "";
    removeWatermark.checked = localStorage.getItem(STORAGE_REMOVE_WATERMARK) === "1";
    textNamingMode.value = localStorage.getItem(STORAGE_TEXT_NAMING_MODE) || "line";
    downloadCount.value = localStorage.getItem(STORAGE_DOWNLOAD_COUNT) || "all";
    applyCollapsedState(localStorage.getItem(STORAGE_COLLAPSED) === "1");
    extraPrompt.addEventListener("input", savePanelState);
    removeWatermark.addEventListener("change", savePanelState);
    textNamingMode.addEventListener("change", savePanelState);
    downloadCount.addEventListener("change", savePanelState);
    syncResumeControls();
    if (toggleButton) {
      toggleButton.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        applyCollapsedState(toggleButton.dataset.collapsed !== "1");
      });
    }

    shadow.addEventListener("click", async (event) => {
      try {
        const target = event.target;
        const button = target instanceof Element ? target.closest('button[data-role="action"]') : null;
        if (!button) {
          return;
        }

        const mode = button.getAttribute("data-mode");
        if (mode === "stop") {
          stopBatch();
          return;
        }

        if (mode === "resume") {
          const checkpoint = state.resumeCheckpoint || readResumeCheckpoint();
          if (!hasResumableCheckpoint(checkpoint)) {
            setStatus("没有可继续的断点任务", true);
            return;
          }
          await resumeBatchFromCheckpoint();
          return;
        }

        if (mode === "clear-resume") {
          if (!state.resumeCheckpoint && !readResumeCheckpoint()) {
            setStatus("没有可清除的断点", true);
            return;
          }
          await clearResumeCheckpoint();
          return;
        }

        if (mode === "text") {
          const txtInput = getPanelElement(TXT_INPUT_ID);
          const txtFile = txtInput?.files && txtInput.files[0];
          if (!txtFile) {
            setStatus("请先选择 TXT 文件", true);
            return;
          }
          const tasks = await readTextTasks(txtFile);
          if (!tasks.length) {
            setStatus("TXT 里没有有效提示词", true);
            return;
          }
          const checkpoint = await createResumeCheckpoint("text", tasks);
          runBatch(tasks, { checkpoint, startIndex: 0 });
          return;
        }

        if (mode === "image") {
          const folderInput = getPanelElement(FOLDER_INPUT_ID);
          const tasks = readImageTasks(folderInput?.files || [], extraPrompt.value || "");
          if (!tasks.length) {
            setStatus("请先选择图片文件夹", true);
            return;
          }
          const checkpoint = await createResumeCheckpoint("image", tasks);
          runBatch(tasks, { checkpoint, startIndex: 0 });
        }
      } catch (error) {
        setStatus(error instanceof Error ? `按钮点击失败：${error.message}` : `按钮点击失败：${String(error)}`, true);
      }
    });
  }

  async function init() {
    enableRemoveWatermarkHook();
    if (document.getElementById(PANEL_ID)) {
      return;
    }
    await loadResumeCheckpoint();
    createPanel();
    resetStatus();
    if (hasResumableCheckpoint()) {
      setStatus(getResumeSummary());
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => {
      void init();
    }, { once: true });
  } else {
    void init();
  }
})();

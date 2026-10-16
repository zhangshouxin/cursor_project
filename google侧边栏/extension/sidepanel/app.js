const API_BASE = "http://127.0.0.1:8787";
const STORAGE_KEY = "sidebar_sessions_v1";
const MAX_SESSIONS = 40;
const WELCOME =
  "页面会在侧边栏左侧打开。首次请点状态旁的调试图标，打开 Allow remote debugging，以便 Playwright MCP 连接当前 Chrome（不再新开窗口）。";

const state = {
  sessionId: null,
  sessions: [], // { id, title, createdAt, updatedAt, messages, bubbles }
  messages: [],
  bubbles: [],
  pendingFiles: [],
  busy: false,
};

const $ = (sel) => document.querySelector(sel);
const messagesEl = $("#messages");
const statusEl = $("#status");
const pendingEl = $("#pending");
const promptEl = $("#prompt");
const formEl = $("#chat-form");
const fileInput = $("#file-input");
const mcpTitleEl = $("#mcp-title");
const sessionTitleEl = $("#session-title");
const historyPanel = $("#history-panel");
const historyList = $("#history-list");
const historyEmpty = $("#history-empty");

function uid() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function setStatus(online, text) {
  statusEl.textContent = text;
  statusEl.classList.toggle("online", online);
  statusEl.classList.toggle("offline", !online);
}

async function api(path, options = {}) {
  const res = await fetch(`${API_BASE}${path}`, options);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `请求失败 (${res.status})`);
  return data;
}

function scrollBottom() {
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

function escapeHtml(str) {
  return String(str)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function linkifyHtml(text) {
  const escaped = escapeHtml(text);
  return escaped.replace(
    /(https?:\/\/[^\s<>"']+)/g,
    (url) =>
      `<a class="msg-link" href="${url}" data-url="${url}" target="_blank" rel="noopener noreferrer">${url}</a>`
  );
}

function bindLinkClicks(root) {
  root.querySelectorAll("a.msg-link, a.download-link").forEach((a) => {
    a.addEventListener("click", (e) => {
      e.preventDefault();
      const url = a.getAttribute("data-url") || a.getAttribute("href");
      if (!url) return;
      // 侧边栏内 <a> 常无法直接下载，改用新标签打开
      chrome.tabs.create({ url, active: true });
    });
  });
}

function renderBubbleEl(bubble) {
  if (bubble.kind === "attachment") {
    const el = document.createElement("div");
    el.className = "bubble attachment";
    el.innerHTML = `<div class="label">已加入会话 · ${escapeHtml(bubble.name)}</div>
      <div class="preview">${escapeHtml(bubble.preview || "")}</div>`;
    return el;
  }
  if (bubble.kind === "download") {
    const el = document.createElement("div");
    el.className = "bubble download";
    const label = escapeHtml(bubble.displayName || "Excel 文件");
    el.innerHTML = `<div class="label">📥 下载 Excel · ${label}</div>
      <a class="download-link" href="${escapeHtml(bubble.url)}" data-url="${escapeHtml(bubble.url)}">点击下载文件</a>
      <div class="preview">${escapeHtml(bubble.url)}</div>`;
    bindLinkClicks(el);
    return el;
  }
  const el = document.createElement("div");
  el.className = `bubble ${bubble.role}`;
  if (bubble.role === "assistant" || bubble.role === "tool" || bubble.role === "system") {
    el.innerHTML = linkifyHtml(bubble.text || "");
    bindLinkClicks(el);
  } else {
    el.textContent = bubble.text;
  }
  return el;
}

function paintMessages() {
  messagesEl.innerHTML = "";
  for (const b of state.bubbles) {
    messagesEl.appendChild(renderBubbleEl(b));
  }
  scrollBottom();
}

function addBubble(role, text, persist = true) {
  const bubble = { role, text };
  if (persist) state.bubbles.push(bubble);
  const el = renderBubbleEl(bubble);
  messagesEl.appendChild(el);
  scrollBottom();
  if (persist) scheduleSave();
  return el;
}

function addAttachmentBubble(name, preview, persist = true) {
  const bubble = { kind: "attachment", name, preview };
  if (persist) state.bubbles.push(bubble);
  const el = renderBubbleEl(bubble);
  messagesEl.appendChild(el);
  scrollBottom();
  if (persist) scheduleSave();
}

function addToolBubble(text) {
  return addBubble("tool", text);
}

function addDownloadBubble(url, displayName) {
  const bubble = {
    kind: "download",
    url,
    displayName: displayName || "Excel 文件",
    text: url,
  };
  state.bubbles.push(bubble);
  const el = renderBubbleEl(bubble);
  messagesEl.appendChild(el);
  scrollBottom();
  scheduleSave();
  return el;
}

function setBusy(busy) {
  state.busy = busy;
  $("#send-btn").disabled = busy;
  $("#btn-attach")?.classList.toggle("is-disabled", busy);
  if (fileInput) fileInput.disabled = busy;
  $("#btn-new").disabled = busy;
  $("#btn-history").disabled = busy;
  const debugBtn = $("#btn-debug");
  if (debugBtn) debugBtn.disabled = busy;
}

function renderPending() {
  if (!state.pendingFiles.length) {
    pendingEl.hidden = true;
    pendingEl.innerHTML = "";
    return;
  }
  pendingEl.hidden = false;
  pendingEl.innerHTML = state.pendingFiles
    .map(
      (f, i) =>
        `<span class="pending-chip">${escapeHtml(f.name)}
          <button type="button" data-drop="${i}" aria-label="移除">×</button>
        </span>`
    )
    .join("");
}

function titleFromMessages(messages) {
  const firstUser = messages.find(
    (m) => m.role === "user" && !String(m.content).startsWith("【上传文件：")
  );
  if (!firstUser) return "新会话";
  const text = String(firstUser.content)
    .split("\n【系统】")[0]
    .replace(/\s+/g, " ")
    .trim();
  return text.slice(0, 28) || "新会话";
}

function getCurrentSession() {
  return state.sessions.find((s) => s.id === state.sessionId) || null;
}

function syncCurrentIntoList() {
  const cur = getCurrentSession();
  if (!cur) return;
  cur.messages = state.messages;
  cur.bubbles = state.bubbles;
  cur.updatedAt = Date.now();
  cur.title = titleFromMessages(state.messages) || cur.title || "新会话";
  sessionTitleEl.textContent = cur.title;
}

let saveTimer = null;
function scheduleSave() {
  syncCurrentIntoList();
  clearTimeout(saveTimer);
  saveTimer = setTimeout(persistSessions, 200);
}

async function persistSessions() {
  syncCurrentIntoList();
  const payload = {
    currentId: state.sessionId,
    sessions: state.sessions
      .slice()
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, MAX_SESSIONS),
  };
  state.sessions = payload.sessions;
  await chrome.storage.local.set({ [STORAGE_KEY]: payload });
}

async function loadSessions() {
  const data = await chrome.storage.local.get(STORAGE_KEY);
  const stored = data[STORAGE_KEY];
  if (stored?.sessions?.length) {
    state.sessions = stored.sessions;
    const id =
      stored.currentId && state.sessions.some((s) => s.id === stored.currentId)
        ? stored.currentId
        : state.sessions[0].id;
    await switchToSession(id, false);
    return;
  }
  await createNewSession(false);
}

function createSessionObject() {
  const now = Date.now();
  return {
    id: uid(),
    title: "新会话",
    createdAt: now,
    updatedAt: now,
    messages: [],
    bubbles: [{ role: "system", text: WELCOME }],
  };
}

async function createNewSession(save = true) {
  if (state.busy) return;
  syncCurrentIntoList();
  const session = createSessionObject();
  state.sessions.unshift(session);
  state.sessionId = session.id;
  state.messages = [];
  state.bubbles = session.bubbles.slice();
  state.pendingFiles = [];
  renderPending();
  sessionTitleEl.textContent = session.title;
  paintMessages();
  closeHistory();
  if (save) await persistSessions();
}

async function switchToSession(id, save = true) {
  syncCurrentIntoList();
  const session = state.sessions.find((s) => s.id === id);
  if (!session) return;
  state.sessionId = session.id;
  state.messages = Array.isArray(session.messages) ? session.messages.slice() : [];
  state.bubbles = Array.isArray(session.bubbles) ? session.bubbles.slice() : [];
  state.pendingFiles = [];
  renderPending();
  sessionTitleEl.textContent = session.title || "会话";
  paintMessages();
  closeHistory();
  if (save) await persistSessions();
}

async function deleteSession(id, ev) {
  ev?.stopPropagation?.();
  if (!confirm("确定删除该会话？删除后无法恢复。")) return;
  const idx = state.sessions.findIndex((s) => s.id === id);
  if (idx < 0) return;
  state.sessions.splice(idx, 1);
  if (!state.sessions.length) {
    await createNewSession(true);
    return;
  }
  if (state.sessionId === id) {
    await switchToSession(state.sessions[0].id, true);
  } else {
    await persistSessions();
    renderHistoryList();
  }
}

function formatTime(ts) {
  try {
    return new Date(ts).toLocaleString();
  } catch {
    return "";
  }
}

function renderHistoryList() {
  const list = state.sessions
    .slice()
    .sort((a, b) => b.updatedAt - a.updatedAt);
  historyList.innerHTML = "";
  historyEmpty.hidden = list.length > 0;
  for (const s of list) {
    const li = document.createElement("li");
    li.className = `history-item${s.id === state.sessionId ? " active" : ""}`;
    li.innerHTML = `
      <div class="main">
        <div class="title">${escapeHtml(s.title || "未命名会话")}</div>
        <div class="meta">${escapeHtml(formatTime(s.updatedAt))} · ${s.messages?.length || 0} 条消息</div>
      </div>
      <button type="button" class="del" data-del="${s.id}">删除</button>
    `;
    li.addEventListener("click", () => {
      if (state.busy) return;
      switchToSession(s.id);
    });
    historyList.appendChild(li);
  }
}

function openHistory() {
  syncCurrentIntoList();
  renderHistoryList();
  historyPanel.hidden = false;
}

function closeHistory() {
  historyPanel.hidden = true;
}

async function checkHealth() {
  try {
    const data = await api("/api/health");
    setStatus(true, data.hasApiKey ? "已连接" : "已连接 · 缺 API Key");
    if (data.playwrightMcp?.ok) {
      mcpTitleEl.textContent = `Playwright MCP · CDP · ${data.playwrightMcp.toolCount} 工具`;
    } else {
      mcpTitleEl.textContent = "Playwright MCP · CDP 连接当前 Chrome";
    }
  } catch {
    setStatus(false, "离线");
    mcpTitleEl.textContent = "服务离线";
  }
}

async function uploadAndStage(file) {
  const form = new FormData();
  form.append("file", file);
  const data = await api("/api/upload", { method: "POST", body: form });
  state.pendingFiles.push({
    name: data.name,
    text: data.text,
    preview: data.preview,
    size: data.size,
    storedName: data.storedName,
    absPath: data.absPath,
    engine: data.engine,
  });
  renderPending();
}

function commitPendingFilesToSession() {
  if (!state.pendingFiles.length) return;
  for (const f of state.pendingFiles) {
    const meta = [
      `【上传文件：${f.name}】`,
      f.storedName ? `存储文件名：${f.storedName}` : "",
      f.absPath ? `绝对路径：${f.absPath}` : "",
      f.engine ? `文档引擎：${f.engine}` : "",
      "",
      "短预览：",
      f.preview || f.text || "",
    ]
      .filter(Boolean)
      .join("\n");
    state.messages.push({
      role: "user",
      content: meta,
    });
    addAttachmentBubble(f.name, f.preview);
  }
  state.pendingFiles = [];
  renderPending();
}

async function openLeftTab(url) {
  const [current] = await chrome.tabs.query({
    active: true,
    currentWindow: true,
  });
  const tab = await chrome.tabs.create({
    url,
    active: true,
    windowId: current?.windowId,
    index: current?.index != null ? current.index + 1 : undefined,
  });
  if (tab?.windowId != null) {
    await chrome.windows.update(tab.windowId, { focused: true });
  }
  return tab;
}

function resolveOpenUrl(text) {
  const m = text.match(/https?:\/\/[^\s<>"']+/i);
  if (m) return m[0];
  if (/打开/.test(text) || /playwright/i.test(text)) {
    if (/百度/.test(text)) return "https://www.baidu.com";
    if (/谷歌|google/i.test(text)) return "https://www.google.com";
    if (/github/i.test(text)) return "https://github.com";
  }
  return null;
}

async function sendChat(userText) {
  const text = (userText || "").trim();
  const hasPending = state.pendingFiles.length > 0;
  if (!text && !hasPending) return;

  commitPendingFilesToSession();

  let finalText = text;
  if (text) {
    const openUrl = resolveOpenUrl(text);
    if (openUrl) {
      try {
        const tab = await openLeftTab(openUrl);
        addToolBubble(`已在侧边栏左侧打开 · ${openUrl}`);
        finalText =
          `${text}\n\n【系统】已在用户当前 Chrome、侧边栏左侧打开标签页：${openUrl}` +
          `（tabId=${tab?.id}）。请通过 Playwright MCP（CDP）连接该浏览器并操作此页，不要再 launch 新窗口。`;
      } catch (err) {
        addBubble("system", `左侧打开失败：${err.message}`);
      }
    }
    state.messages.push({ role: "user", content: finalText });
    addBubble("user", text);
  } else {
    state.messages.push({
      role: "user",
      content: "请结合我刚上传到会话中的文件进行分析与总结。",
    });
    addBubble("user", "请分析刚上传的文件");
  }

  setBusy(true);
  const thinking = addBubble("system", "Playwright MCP 执行中…", false);

  try {
    const result = await api("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages: state.messages }),
    });

    thinking.remove();

    if (result.route) {
      addBubble("system", `Agents 路由 → ${result.route}`);
    }

    for (const step of result.steps || []) {
      if (step.type === "tool_call") {
        const preview =
          step.args?.url ||
          step.args?.element ||
          step.args?.ref ||
          step.args?.text ||
          step.args?.filename ||
          "";
        const label = String(step.name || "").startsWith("browser")
          ? "MCP"
          : "工具";
        addToolBubble(
          `${label} ${step.name}${preview ? ` · ${String(preview).slice(0, 80)}` : ""}`
        );
      } else if (step.type === "tool_result") {
        addToolBubble(
          `${step.ok === false ? "失败" : "结果"} · ${step.name}\n${step.preview || ""}`.trim()
        );
        if (step.download_url) {
          addDownloadBubble(step.download_url, step.displayName);
        }
      }
    }

    for (const d of result.downloads || []) {
      if (d?.url) addDownloadBubble(d.url, d.displayName);
    }

    addBubble("assistant", result.reply);
    state.messages.push({ role: "assistant", content: result.reply });
    await persistSessions();
    checkHealth();
  } catch (err) {
    thinking.remove();
    let msg = err.message;
    if (/cdp|debug|connect|ECONNREFUSED|endpoint|浏览器/i.test(msg)) {
      msg +=
        "\n请先点状态旁的调试图标，在页面中打开 Allow remote debugging，然后重试。";
    }
    addBubble("system", msg);
    await persistSessions();
  } finally {
    setBusy(false);
  }
}

formEl.addEventListener("submit", async (e) => {
  e.preventDefault();
  if (state.busy) return;
  const text = promptEl.value;
  promptEl.value = "";
  await sendChat(text);
});

$("#btn-new").addEventListener("click", () => createNewSession(true));
$("#btn-history").addEventListener("click", () => openHistory());
$("#btn-history-close").addEventListener("click", () => closeHistory());

historyList.addEventListener("click", (e) => {
  const id = e.target?.dataset?.del;
  if (!id) return;
  deleteSession(id, e);
});

$("#btn-debug")?.addEventListener("click", async () => {
  try {
    await openLeftTab("chrome://inspect/#remote-debugging");
    addBubble(
      "system",
      "请在左侧开启 “Allow remote debugging for this browser instance”，然后回侧边栏继续。"
    );
  } catch (err) {
    addBubble("system", err.message);
  }
});

fileInput.addEventListener("change", async () => {
  const file = fileInput.files?.[0];
  fileInput.value = "";
  if (!file || state.busy) return;
  try {
    setBusy(true);
    await uploadAndStage(file);
  } catch (err) {
    addBubble("system", err.message);
  } finally {
    setBusy(false);
  }
});

pendingEl.addEventListener("click", (e) => {
  const i = e.target?.dataset?.drop;
  if (i == null) return;
  state.pendingFiles.splice(Number(i), 1);
  renderPending();
});

["dragenter", "dragover"].forEach((evt) => {
  formEl.addEventListener(evt, (e) => {
    e.preventDefault();
    formEl.classList.add("dragover");
  });
});
["dragleave", "drop"].forEach((evt) => {
  formEl.addEventListener(evt, (e) => {
    e.preventDefault();
    formEl.classList.remove("dragover");
  });
});
formEl.addEventListener("drop", async (e) => {
  const file = e.dataTransfer?.files?.[0];
  if (!file || state.busy) return;
  try {
    setBusy(true);
    await uploadAndStage(file);
  } catch (err) {
    addBubble("system", err.message);
  } finally {
    setBusy(false);
  }
});

promptEl.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    formEl.requestSubmit();
  }
});

await loadSessions();
checkHealth();
setInterval(checkHealth, 8000);

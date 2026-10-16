const fs = require("fs");
const path = require("path");
const { randomUUID } = require("crypto");
const express = require("express");
const cors = require("cors");
const dotenv = require("dotenv");

dotenv.config({ path: path.join(__dirname, ".env") });

const LLM_API_KEY = String(process.env.LLM_API_KEY || process.env.DEEPSEEK_API_KEY || "").trim();
const LLM_BASE_URL = String(
  process.env.LLM_BASE_URL || process.env.OLLAMA_BASE_URL || "https://api.deepseek.com/v1"
).replace(/\/$/, "");
const LLM_MODEL = process.env.LLM_MODEL || process.env.OLLAMA_MODEL || "deepseek-chat";
const MAX_HISTORY = Number(process.env.MAX_HISTORY || 12);
const HUB_HOST = process.env.HUB_HOST || "0.0.0.0";
const HUB_PORT = Number(process.env.HUB_PORT || 8787);
const LINGZHU_AK = String(process.env.LINGZHU_AK || "").trim();
const GLASSES_SYSTEM_PROMPT =
  process.env.GLASSES_SYSTEM_PROMPT ||
  "你是智能眼镜上的小信助手。用简短口语中文回答。不要使用 Markdown、列表或表情。不要透露思考过程。";
const PHOTO_PROMPT =
  "用简短口语中文说明这张照片里有什么，有没有报错或指示灯异常。不要使用 Markdown、列表或表情。不要透露思考过程。看不清就直接说看不清。";

const THINK_BLOCK = /<think>[\s\S]*?<\/think>/gi;
const NEWS_SOURCES = ["https://60s-api.viki.moe/v2/60s", "https://60s.viki.moe/v2/60s"];
const LOG_DIR = path.join(__dirname, "logs");
const CONV_LOG_PATH = path.join(LOG_DIR, "conversations.log");
const STATIC_DIR = path.join(__dirname, "static");
const PHOTO_DIR = path.join(__dirname, "photos");
const MAX_PHOTO_BYTES = 8 * 1024 * 1024;

fs.mkdirSync(LOG_DIR, { recursive: true });
fs.mkdirSync(PHOTO_DIR, { recursive: true });

const sessions = new Map();

function cleanText(text) {
  if (!text) {
    return "";
  }
  return String(text).replace(THINK_BLOCK, "").trim();
}

function pickText(value) {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

function extractUserText(payload) {
  if (!payload || typeof payload !== "object") {
    return "";
  }
  const direct = pickText(payload.text);
  if (direct) {
    return direct;
  }
  for (const key of ["content", "query", "input"]) {
    const value = pickText(payload[key]);
    if (value) {
      return value;
    }
  }

  const messages = payload.message || payload.messages || [];
  if (!Array.isArray(messages)) {
    return "";
  }
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const item = messages[i];
    if (!item || typeof item !== "object") {
      continue;
    }
    const role = item.role;
    if (role && role !== "user") {
      continue;
    }
    if (pickText(item.text)) {
      return pickText(item.text);
    }
    if (pickText(item.content)) {
      return pickText(item.content);
    }
    if (Array.isArray(item.content)) {
      const parts = [];
      for (const part of item.content) {
        if (part && typeof part === "object" && (part.type == null || part.type === "text")) {
          const text = pickText(part.text) || pickText(part.content);
          if (text) {
            parts.push(text);
          }
        }
      }
      if (parts.length) {
        return parts.join("\n");
      }
    }
  }
  return "";
}

function lastUserMessage(messages) {
  if (!Array.isArray(messages)) {
    return "";
  }
  return extractUserText({ messages });
}

function assistantFromOpenai(payload) {
  if (!payload || typeof payload !== "object") {
    return "";
  }
  const choices = payload.choices || [];
  if (!choices.length) {
    return "";
  }
  const message = choices[0].message || {};
  return messageText(message.content);
}

function messageText(content) {
  if (typeof content === "string") {
    return cleanText(content);
  }
  if (!Array.isArray(content)) {
    return "";
  }
  const parts = [];
  for (const part of content) {
    if (typeof part === "string") {
      parts.push(part);
    } else if (part && typeof part.text === "string") {
      parts.push(part.text);
    }
  }
  return cleanText(parts.join(""));
}

function completionsUrl() {
  return LLM_BASE_URL.endsWith("/v1")
    ? `${LLM_BASE_URL}/chat/completions`
    : `${LLM_BASE_URL}/v1/chat/completions`;
}

function modelsUrl() {
  if (LLM_BASE_URL.endsWith("/v1")) {
    return `${LLM_BASE_URL}/models`;
  }
  if (LLM_API_KEY) {
    return `${LLM_BASE_URL}/models`;
  }
  return `${LLM_BASE_URL}/v1/models`;
}

function authHeaders() {
  return LLM_API_KEY ? { Authorization: `Bearer ${LLM_API_KEY}` } : {};
}

function providerName() {
  return LLM_API_KEY ? "deepseek" : "ollama";
}

function historyFor(sessionId) {
  const items = sessions.get(sessionId) || [];
  return [{ role: "system", content: GLASSES_SYSTEM_PROMPT }, ...items.slice(-MAX_HISTORY)];
}

function remember(sessionId, role, content) {
  const items = sessions.get(sessionId) || [];
  items.push({ role, content });
  if (items.length > MAX_HISTORY) {
    items.splice(0, items.length - MAX_HISTORY);
  }
  sessions.set(sessionId, items);
}

function ssePack(event, data) {
  const payload = typeof data === "string" ? data : JSON.stringify(data);
  return `event: ${event}\ndata: ${payload}\n\n`;
}

function clientHost(req) {
  const raw = (req.ip || req.socket.remoteAddress || "-").replace(/^::ffff:/, "");
  return raw || "-";
}

function logPhoto(client, filename, bytes) {
  const stamp = new Date().toLocaleString("sv-SE", { hour12: false }).replace("T", " ");
  const line = `${stamp} [photo] client=${client} file=${filename} bytes=${bytes}`;
  console.log(line);
  fs.appendFileSync(CONV_LOG_PATH, `${line}\n`, "utf8");
}

const PHOTO_FILE_NAME = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z-[a-f0-9]+\.(jpg|jpeg|png|webp)$/i;

function photoTakenAt(filename, stat) {
  const match = String(filename || "").match(PHOTO_FILE_NAME);
  if (!match) {
    return stat.mtime;
  }
  return new Date(
    Date.UTC(
      Number(match[1]),
      Number(match[2]) - 1,
      Number(match[3]),
      Number(match[4]),
      Number(match[5]),
      Number(match[6])
    )
  );
}

function formatPhotoMinute(date) {
  const parts = new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(date);
  const pick = (type) => {
    const part = parts.find((item) => item.type === type);
    return part ? part.value : "";
  };
  return `${pick("year")}-${pick("month")}-${pick("day")} ${pick("hour")}:${pick("minute")}`;
}

function listPhotoGroups() {
  const names = fs.readdirSync(PHOTO_DIR);
  const photos = [];
  for (const name of names) {
    if (!PHOTO_FILE_NAME.test(name)) {
      continue;
    }
    const full = path.join(PHOTO_DIR, name);
    let stat;
    try {
      stat = fs.statSync(full);
    } catch (error) {
      continue;
    }
    if (!stat.isFile()) {
      continue;
    }
    const takenAt = photoTakenAt(name, stat);
    photos.push({
      name,
      takenAt: takenAt.getTime(),
      minute: formatPhotoMinute(takenAt),
      url: `/v1/photos/files/${encodeURIComponent(name)}`,
      downloadUrl: `/v1/photos/download/${encodeURIComponent(name)}`,
    });
  }
  photos.sort((a, b) => a.takenAt - b.takenAt || a.name.localeCompare(b.name));
  const groups = [];
  for (const photo of photos) {
    const last = groups[groups.length - 1];
    if (!last || last.minute !== photo.minute) {
      groups.push({ minute: photo.minute, photos: [photo] });
      continue;
    }
    last.photos.push(photo);
  }
  return groups;
}

function photoExtension(mimeType) {
  if (mimeType === "image/jpeg" || mimeType === "image/jpg") {
    return "jpg";
  }
  if (mimeType === "image/png") {
    return "png";
  }
  if (mimeType === "image/webp") {
    return "webp";
  }
  return "";
}

function decodePhotoBody(body) {
  const payload = body && typeof body === "object" ? body : {};
  let mimeType = String(payload.mimeType || "")
    .split(";")[0]
    .trim()
    .toLowerCase();
  let raw = String(payload.data || payload.image || payload.src || "");
  const packed = raw.match(/^data:([^;,]+)(;base64)?,([\s\S]+)$/i);
  if (packed) {
    mimeType = mimeType || packed[1].trim().toLowerCase();
    raw = packed[3];
  }
  raw = raw.replace(/\s/g, "");
  if (!raw) {
    const error = new Error("缺少图片数据");
    error.statusCode = 400;
    throw error;
  }
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(raw)) {
    const error = new Error("图片数据不是 base64");
    error.statusCode = 400;
    throw error;
  }
  const buffer = Buffer.from(raw, "base64");
  if (!buffer.length) {
    const error = new Error("图片内容为空");
    error.statusCode = 400;
    throw error;
  }
  if (buffer.length > MAX_PHOTO_BYTES) {
    const error = new Error("图片超过 8MB");
    error.statusCode = 413;
    throw error;
  }
  const extension = photoExtension(mimeType || "image/webp");
  if (!extension) {
    const error = new Error("只接收 webp、jpeg、png");
    error.statusCode = 415;
    throw error;
  }
  return {
    mimeType: extension === "jpg" ? "image/jpeg" : `image/${extension}`,
    extension,
    buffer,
  };
}

function logDialogue(channel, sessionId, role, text, client = "-") {
  const cleaned = cleanText(text);
  if (!cleaned) {
    return;
  }
  const stamp = new Date().toLocaleString("sv-SE", { hour12: false }).replace("T", " ");
  const line = `${stamp} [${channel}] client=${client} session=${sessionId} ${
    role === "user" ? "问" : "答"
  }: ${cleaned}`;
  console.log(line);
  fs.appendFileSync(CONV_LOG_PATH, `${line}\n`, "utf8");
}

function normalizeRequestPath(rawPath) {
  const raw = rawPath || "/";
  let decoded = raw;
  try {
    decoded = decodeURIComponent(raw);
  } catch (error) {
    decoded = raw;
  }
  let candidate = decoded;
  if (candidate.startsWith("/") && candidate.slice(1).startsWith("http")) {
    candidate = candidate.slice(1);
  }
  if (candidate.startsWith("http://") || candidate.startsWith("https://")) {
    try {
      return new URL(candidate).pathname || "/";
    } catch (error) {
      return raw;
    }
  }
  return raw;
}

function sendError(res, status, detail) {
  res.status(status).json({ detail });
}

async function describePhoto(photo) {
  const dataUrl = `data:${photo.mimeType};base64,${photo.buffer.toString("base64")}`;
  const response = await upstreamChat(
    [
      {
        role: "user",
        content: [
          { type: "text", text: PHOTO_PROMPT },
          { type: "image_url", image_url: { url: dataUrl, detail: "low" } },
        ],
      },
    ],
    false,
    { disableThinking: true, timeoutMs: 55000 }
  );
  const body = await response.json();
  const text = assistantFromOpenai(body);
  if (!text) {
    const error = new Error("模型没有返回图片分析");
    error.statusCode = 502;
    throw error;
  }
  return text;
}

async function upstreamChat(messages, stream, options = {}) {
  const body = {
    model: LLM_MODEL,
    messages,
    stream,
  };
  if (!LLM_API_KEY) {
    body.think = false;
  } else if (options.disableThinking) {
    body.thinking = { type: "disabled" };
  }
  const response = await fetch(completionsUrl(), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...authHeaders(),
    },
    body: JSON.stringify(body),
    signal: options.timeoutMs ? AbortSignal.timeout(options.timeoutMs) : undefined,
  });
  if (!response.ok) {
    const text = await response.text();
    const error = new Error(`上游模型调用失败: ${response.status} ${text.slice(0, 200)}`);
    error.statusCode = 502;
    throw error;
  }
  return response;
}

async function* iterateLines(response) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) {
      break;
    }
    buffer += decoder.decode(value, { stream: true });
    let index = buffer.indexOf("\n");
    while (index >= 0) {
      yield buffer.slice(0, index).replace(/\r$/, "");
      buffer = buffer.slice(index + 1);
      index = buffer.indexOf("\n");
    }
  }
  if (buffer) {
    yield buffer.replace(/\r$/, "");
  }
}

function asList(value) {
  return Array.isArray(value) ? value : [];
}

function normalizeNewsItems(payload, limit) {
  let candidates = [];
  if (Array.isArray(payload)) {
    candidates = payload;
  } else if (payload && typeof payload === "object") {
    const data = payload.data;
    if (Array.isArray(data)) {
      candidates = data;
    } else if (data && typeof data === "object") {
      candidates = asList(data.news || data.items);
    }
    if (!candidates.length) {
      candidates = asList(payload.news || payload.items);
    }
  }

  const items = [];
  for (let index = 0; index < candidates.length; index += 1) {
    if (items.length >= limit) {
      break;
    }
    const raw = candidates[index];
    if (typeof raw === "string") {
      const title = raw.replace(/^\s*\d+[\.、]\s*/, "").trim();
      if (!title) {
        continue;
      }
      items.push({ id: `news-${index}`, title, summary: title, source: "60s" });
      continue;
    }
    if (!raw || typeof raw !== "object") {
      continue;
    }
    const title = String(raw.title || raw.content || raw.text || "")
      .replace(/^\s*\d+[\.、]\s*/, "")
      .trim();
    if (!title) {
      continue;
    }
    items.push({
      id: String(raw.id || `news-${index}`),
      title,
      summary: String(raw.summary || title),
      source: String(raw.source || "60s"),
    });
  }
  return items;
}

function extractDelta(rawLine) {
  const line = rawLine.trim();
  if (!line.startsWith("data:")) {
    return "";
  }
  const raw = line.slice(5).trim();
  if (!raw || raw === "[DONE]") {
    return "";
  }
  try {
    const data = JSON.parse(raw);
    const delta = (((data.choices || [])[0] || {}).delta || {}).content;
    return delta ? cleanText(delta) : "";
  } catch (error) {
    return "";
  }
}

const app = express();
app.disable("x-powered-by");
app.use(cors());
app.use((req, res, next) => {
  const [pathname, query = ""] = (req.url || "/").split("?");
  const normalized = normalizeRequestPath(pathname);
  if (normalized !== pathname) {
    req.url = query ? `${normalized}?${query}` : normalized;
  }
  next();
});
const jsonParser = express.json({ limit: "2mb" });
const photoParser = express.json({ limit: "12mb" });
app.use((req, res, next) => {
  const pathname = (req.url || "/").split("?")[0];
  if (req.method === "POST" && pathname === "/v1/photos") {
    return photoParser(req, res, next);
  }
  return jsonParser(req, res, next);
});
if (fs.existsSync(STATIC_DIR)) {
  app.use("/static", express.static(STATIC_DIR));
}

app.get("/", (_req, res) => {
  res.sendFile(path.join(STATIC_DIR, "index.html"));
});

app.get("/health", async (_req, res) => {
  try {
    const response = await fetch(modelsUrl(), { headers: authHeaders() });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    const payload = await response.json();
    let models = [];
    if (payload && typeof payload === "object") {
      if (Array.isArray(payload.models)) {
        models = payload.models.map((item) => item && item.name).filter(Boolean);
      } else if (Array.isArray(payload.data)) {
        models = payload.data.map((item) => item && item.id).filter(Boolean);
      }
    }
    res.json({
      ok: true,
      provider: providerName(),
      upstream: LLM_BASE_URL,
      model: LLM_MODEL,
      models,
      error: null,
    });
  } catch (error) {
    res.json({
      ok: false,
      provider: providerName(),
      upstream: LLM_BASE_URL,
      model: LLM_MODEL,
      models: [],
      error: String(error.message || error),
    });
  }
});

app.get("/v1", (_req, res) => {
  res.json({
    object: "api",
    base: "/v1",
    model: LLM_MODEL,
    upstream: LLM_BASE_URL,
    provider: providerName(),
    endpoints: ["/health", "/v1/models", "/v1/chat/completions", "/v1/news/brief", "/v1/photos"],
  });
});

app.get("/v1/models", async (_req, res) => {
  try {
    const response = await fetch(modelsUrl(), { headers: authHeaders() });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    res.json(await response.json());
  } catch (error) {
    sendError(res, 502, `无法读取上游模型: ${error.message || error}`);
  }
});

app.get("/v1/news/brief", async (req, res) => {
  const topic = String(req.query.topic || "today");
  const size = Math.max(1, Math.min(Number(req.query.limit || 6), 8));
  let lastError = null;
  for (const url of NEWS_SOURCES) {
    try {
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      const payload = await response.json();
      const items = normalizeNewsItems(payload, size);
      if (!items.length) {
        continue;
      }
      const data = payload && typeof payload === "object" ? payload.data : {};
      const updated =
        data && typeof data === "object" ? String(data.updated || data.date || "") : "";
      res.json({ topic, source: "60s", updatedAt: updated, items });
      return;
    } catch (error) {
      lastError = error;
    }
  }
  sendError(res, 502, `新闻源不可用: ${lastError}`);
});

app.get("/photos", (_req, res) => {
  res.sendFile(path.join(STATIC_DIR, "photos.html"));
});

app.get("/v1/photos", (_req, res) => {
  res.json({ groups: listPhotoGroups() });
});

app.get("/v1/photos/download/:name", (req, res) => {
  const name = path.basename(req.params.name || "");
  if (!PHOTO_FILE_NAME.test(name)) {
    sendError(res, 404, "照片不存在");
    return;
  }
  const file = path.join(PHOTO_DIR, name);
  if (!fs.existsSync(file)) {
    sendError(res, 404, "照片不存在");
    return;
  }
  res.download(file, name);
});

app.use("/v1/photos/files", express.static(PHOTO_DIR, { index: false, dotfiles: "deny" }));

app.post("/v1/photos", async (req, res) => {
  let saved;
  try {
    const photo = decodePhotoBody(req.body);
    const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
    const filename = `${stamp}-${randomUUID().slice(0, 8)}.${photo.extension}`;
    fs.writeFileSync(path.join(PHOTO_DIR, filename), photo.buffer);
    const client = clientHost(req);
    logPhoto(client, filename, photo.buffer.length);
    saved = {
      ok: true,
      id: filename,
      file: filename,
      mimeType: photo.mimeType,
      bytes: photo.buffer.length,
      url: `/v1/photos/files/${filename}`,
      analysis: "",
      analysisError: "",
      client,
      photo,
    };
  } catch (error) {
    sendError(res, error.statusCode || 400, error.message || "图片保存失败");
    return;
  }

  try {
    saved.analysis = await describePhoto(saved.photo);
    logDialogue("xiaoxin", saved.client, "user", "这张照片里有什么", saved.client);
    logDialogue("xiaoxin", saved.client, "assistant", saved.analysis, saved.client);
  } catch (error) {
    saved.analysisError = error.message || "图片分析失败";
    const stamp = new Date().toLocaleString("sv-SE", { hour12: false }).replace("T", " ");
    console.log(`${stamp} [photo] client=${saved.client} 分析失败: ${saved.analysisError}`);
  }

  res.json({
    ok: saved.ok,
    id: saved.id,
    file: saved.file,
    mimeType: saved.mimeType,
    bytes: saved.bytes,
    url: saved.url,
    analysis: saved.analysis,
    analysisError: saved.analysisError,
  });
});

app.post("/v1/glasses/reset", (req, res) => {
  const sessionId = String((req.body && req.body.session_id) || "default");
  sessions.delete(sessionId);
  res.json({ session_id: sessionId, status: "cleared" });
});

app.post("/v1/glasses/chat", async (req, res) => {
  const text = extractUserText(req.body || {});
  if (!text) {
    sendError(res, 400, "缺少用户文本");
    return;
  }
  const sessionId = String((req.body && (req.body.session_id || req.body.message_id)) || "default");
  const client = clientHost(req);
  remember(sessionId, "user", text);
  logDialogue("glasses", sessionId, "user", text, client);
  const messages = historyFor(sessionId);

  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();
  res.write(ssePack("asr", { type: "asr", session_id: sessionId, text }));

  try {
    const response = await upstreamChat(messages, true);
    const collected = [];
    for await (const line of iterateLines(response)) {
      const piece = extractDelta(line);
      if (!piece) {
        continue;
      }
      collected.push(piece);
      res.write(
        ssePack("delta", {
          type: "delta",
          session_id: sessionId,
          text: piece,
        })
      );
    }
    const answer = cleanText(collected.join(""));
    if (answer) {
      remember(sessionId, "assistant", answer);
      logDialogue("glasses", sessionId, "assistant", answer, client);
    }
    res.write(
      ssePack("done", {
        type: "done",
        session_id: sessionId,
        text: answer,
      })
    );
    res.end();
  } catch (error) {
    if (!res.headersSent) {
      sendError(res, error.statusCode || 502, error.message || "上游模型调用失败");
      return;
    }
    res.end();
  }
});

app.post("/v1/chat/completions", async (req, res) => {
  const payload = req.body || {};
  const client = clientHost(req);
  const sessionId = String(payload.session_id || payload.user || client || "xiaoxin");
  const question = lastUserMessage(payload.messages);
  if (question) {
    logDialogue("xiaoxin", sessionId, "user", question, client);
  }

  try {
    if (payload.stream) {
      const response = await upstreamChat(payload.messages || [], true);
      res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("Connection", "keep-alive");
      res.flushHeaders();

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      const collected = [];
      while (true) {
        const { value, done } = await reader.read();
        if (done) {
          break;
        }
        res.write(Buffer.from(value));
        buffer += decoder.decode(value, { stream: true });
        let index = buffer.indexOf("\n");
        while (index >= 0) {
          const line = buffer.slice(0, index);
          buffer = buffer.slice(index + 1);
          const piece = extractDelta(line);
          if (piece) {
            collected.push(piece);
          }
          index = buffer.indexOf("\n");
        }
      }
      const answer = cleanText(collected.join(""));
      if (answer) {
        logDialogue("xiaoxin", sessionId, "assistant", answer, client);
      }
      res.end();
      return;
    }

    const response = await upstreamChat(payload.messages || [], false);
    const body = await response.json();
    const answer = assistantFromOpenai(body);
    if (answer) {
      logDialogue("xiaoxin", sessionId, "assistant", answer, client);
    }
    res.json(body);
  } catch (error) {
    sendError(res, error.statusCode || 502, error.message || "上游模型调用失败");
  }
});

app.post("/metis/agent/api/sse", async (req, res) => {
  if (LINGZHU_AK) {
    const token = String(req.get("authorization") || "")
      .replace(/^Bearer\s+/i, "")
      .trim();
    if (token !== LINGZHU_AK) {
      sendError(res, 401, "unauthorized");
      return;
    }
  }

  const payload = req.body || {};
  const text = extractUserText(payload);
  if (!text) {
    sendError(res, 400, "缺少用户文本");
    return;
  }

  const messageId = String(payload.message_id || randomUUID());
  const agentId = String(payload.agent_id || "leqi-local");
  const client = clientHost(req);
  remember(messageId, "user", text);
  logDialogue("lingzhu", messageId, "user", text, client);
  const messages = historyFor(messageId);

  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  try {
    const response = await upstreamChat(messages, true);
    const collected = [];
    for await (const line of iterateLines(response)) {
      const piece = extractDelta(line);
      if (!piece) {
        continue;
      }
      collected.push(piece);
      res.write(
        ssePack("message", {
          role: "agent",
          type: "answer",
          answer_stream: piece,
          message_id: messageId,
          agent_id: agentId,
          is_finish: false,
        })
      );
    }
    const answer = cleanText(collected.join(""));
    if (answer) {
      remember(messageId, "assistant", answer);
      logDialogue("lingzhu", messageId, "assistant", answer, client);
    }
    res.write(
      ssePack("message", {
        role: "agent",
        type: "answer",
        answer_stream: "",
        message_id: messageId,
        agent_id: agentId,
        is_finish: true,
      })
    );
    res.write(ssePack("done", "[DONE]"));
    res.end();
  } catch (error) {
    if (!res.headersSent) {
      sendError(res, error.statusCode || 502, error.message || "上游模型调用失败");
      return;
    }
    res.end();
  }
});

app.get("/metis/agent/api/health", async (_req, res) => {
  const response = await fetch(`http://127.0.0.1:${HUB_PORT}/health`);
  const status = await response.json();
  res.json({ status: status.ok ? "ok" : "error", ...status });
});

app.listen(HUB_PORT, HUB_HOST, () => {
  console.log(`对话日志: ${CONV_LOG_PATH}`);
  console.log(`lan-hub 已启动 http://${HUB_HOST}:${HUB_PORT}`);
});

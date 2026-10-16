import "dotenv/config";
import cors from "cors";
import express from "express";
import fs from "fs";
import multer from "multer";
import path from "path";
import { fileURLToPath } from "url";
import { chat, docsMcpStatus, getModelName, hasApiKey } from "./ai.js";
import { downloadsDir, extractFileText, truncate } from "./files.js";
import { persistUploadedDocument } from "./documents.js";
import { closePlaywrightMcp, mcpHealth } from "./mcp-playwright.js";
import { closeOpenDocsMcp } from "./mcp-opendocs.js";
import { closeGoDocsMcp } from "./mcp-godocs.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const uploadDir = path.join(__dirname, "..", "uploads");
fs.mkdirSync(uploadDir, { recursive: true });
fs.mkdirSync(downloadsDir, { recursive: true });

const app = express();
const port = Number(process.env.PORT) || 8787;

app.use(cors({ origin: true }));
app.use(express.json({ limit: "4mb" }));

/** 安全下载：仅允许 downloads 目录内的 .xlsx，支持中文展示名 */
app.get("/downloads/:name", async (req, res) => {
  try {
    const name = path.basename(req.params.name);
    if (!name || name.includes("..") || !name.endsWith(".xlsx")) {
      return res.status(400).json({ error: "无效文件名" });
    }
    const filePath = path.join(downloadsDir, name);
    await fs.promises.access(filePath, fs.constants.R_OK);

    let displayName = name;
    try {
      const meta = JSON.parse(
        await fs.promises.readFile(`${filePath}.meta.json`, "utf8")
      );
      if (meta?.displayName) displayName = meta.displayName;
    } catch {
      // no meta
    }

    const asciiName = displayName.replace(/[^\x20-\x7E]/g, "_") || "export.xlsx";
    res.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    );
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(displayName)}`
    );
    return res.sendFile(filePath);
  } catch {
    return res.status(404).json({ error: "文件不存在" });
  }
});

app.use("/downloads", express.static(downloadsDir));

const upload = multer({
  dest: uploadDir,
  limits: { fileSize: 15 * 1024 * 1024 },
});

app.get("/api/health", async (_req, res) => {
  const [mcp, docs] = await Promise.all([mcpHealth(), docsMcpStatus()]);
  res.json({
    ok: true,
    hasApiKey: hasApiKey(),
    model: getModelName(),
    playwrightMcp: mcp,
    docsMcp: docs,
  });
});

app.post("/api/chat", async (req, res) => {
  try {
    const { messages = [] } = req.body || {};
    if (!Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ error: "messages 不能为空" });
    }
    const result = await chat({ messages });
    res.json(result);
  } catch (err) {
    console.error("[chat]", err);
    res.status(err.status || 500).json({ error: err.message || "聊天失败" });
  }
});

app.post("/api/upload", upload.single("file"), async (req, res) => {
  const file = req.file;
  if (!file) return res.status(400).json({ error: "未收到文件" });

  try {
    const stored = await persistUploadedDocument(file.path, file.originalname);
    let text = "";
    try {
      text = truncate(await extractFileText(stored.absPath, file.originalname));
    } catch (parseErr) {
      console.warn(
        "[upload] 本地预览解析失败，仍保留文件供 MCP:",
        parseErr.message
      );
      text = `（本地预览解析失败：${parseErr.message}。请通过文档 MCP 读取。）`;
    }

    res.json({
      id: file.filename,
      name: file.originalname,
      size: file.size,
      mime: file.mimetype,
      text,
      preview: text.slice(0, 800),
      storedName: stored.storedName,
      absPath: stored.absPath,
      engine: stored.engine,
    });
  } catch (err) {
    console.error("[upload]", err);
    res.status(err.status || 500).json({ error: err.message || "文件解析失败" });
  } finally {
    fs.promises.unlink(file.path).catch(() => {});
  }
});

app.use((err, _req, res, _next) => {
  if (err instanceof multer.MulterError) {
    return res.status(400).json({ error: err.message });
  }
  console.error(err);
  res.status(500).json({ error: "服务器错误" });
});

const server = app.listen(port, () => {
  console.log(`AI sidebar server listening on http://127.0.0.1:${port}`);
  console.log("Playwright / OpenDocs / GoDocs MCP start on first use");
});

async function shutdown() {
  await Promise.allSettled([
    closePlaywrightMcp(),
    closeOpenDocsMcp(),
    closeGoDocsMcp(),
  ]);
  server.close(() => process.exit(0));
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

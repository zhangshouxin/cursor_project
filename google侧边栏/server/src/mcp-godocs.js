import path from "path";
import { fileURLToPath } from "url";
import { createMcpBridge } from "./mcp-bridge.js";
import { resolveBinary } from "./mcp-bin.js";
import { documentsDir } from "./documents.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** 非 Office 格式（txt/md/csv/图片等）→ go-docs-mcp */
function createBridge() {
  const command = resolveBinary({
    envKey: "GODOCS_MCP_BIN",
    candidates: ["go-docs-mcp"],
    hint: "请安装：go install github.com/drolosoft/go-docs-mcp@latest，或设置 GODOCS_MCP_BIN",
  });

  return createMcpBridge({
    label: "godocs-mcp",
    command,
    args: [],
    env: {
      DOCS_MCP_DIR: documentsDir,
    },
    cwd: path.resolve(__dirname, ".."),
  });
}

let bridge;

function getBridge() {
  if (!bridge) bridge = createBridge();
  return bridge;
}

export async function listGoDocsTools() {
  return getBridge().listOpenAITools({ namePrefix: "godocs__" });
}

export async function callGoDocsTool(prefixedName, args = {}) {
  const name = String(prefixedName || "").replace(/^godocs__/, "");
  // go-docs 只认 DOCS_MCP_DIR 下的 filename，自动剥掉路径
  const next = { ...(args || {}) };
  if (typeof next.filename === "string") {
    next.filename = path.basename(next.filename);
  }
  if (typeof next.file_path === "string" && !next.filename) {
    next.filename = path.basename(next.file_path);
    delete next.file_path;
  }
  return getBridge().callTool(name, next);
}

export async function closeGoDocsMcp() {
  if (bridge) await bridge.close();
}

export async function goDocsHealth() {
  try {
    resolveBinary({
      envKey: "GODOCS_MCP_BIN",
      candidates: ["go-docs-mcp"],
      hint: "请运行 server/scripts/install-doc-mcps.sh 或设置 GODOCS_MCP_BIN",
    });
  } catch (err) {
    return { ok: false, error: err.message, pending: false };
  }
  return getBridge().health();
}

export async function probeGoDocsMcp() {
  const tools = await listGoDocsTools();
  return { ok: true, toolCount: tools.length };
}

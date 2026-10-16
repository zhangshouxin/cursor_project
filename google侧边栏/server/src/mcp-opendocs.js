import path from "path";
import { fileURLToPath } from "url";
import { createMcpBridge } from "./mcp-bridge.js";
import { resolveBinary } from "./mcp-bin.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function createBridge() {
  const command = resolveBinary({
    envKey: "OPENDOCS_MCP_BIN",
    candidates: ["office-oxide-mcp", "opendocswork-mcp"],
    hint: "请安装：cargo install office-oxide-mcp，或设置 OPENDOCS_MCP_BIN",
  });

  return createMcpBridge({
    label: "opendocs-mcp",
    command,
    args: ["--transport", "stdio"],
    cwd: path.resolve(__dirname, ".."),
  });
}

let bridge;

function getBridge() {
  if (!bridge) bridge = createBridge();
  return bridge;
}

export async function listOpenDocsTools() {
  return getBridge().listOpenAITools({ namePrefix: "office__" });
}

export async function callOpenDocsTool(prefixedName, args = {}) {
  const name = String(prefixedName || "").replace(/^office__/, "");
  return getBridge().callTool(name, args);
}

export async function closeOpenDocsMcp() {
  if (bridge) await bridge.close();
}

export async function openDocsHealth() {
  try {
    resolveBinary({
      envKey: "OPENDOCS_MCP_BIN",
      candidates: ["office-oxide-mcp", "opendocswork-mcp"],
      hint: "请运行 server/scripts/install-doc-mcps.sh 或设置 OPENDOCS_MCP_BIN",
    });
  } catch (err) {
    return { ok: false, error: err.message, pending: false };
  }
  return getBridge().health();
}

export async function probeOpenDocsMcp() {
  const tools = await listOpenDocsTools();
  return { ok: true, toolCount: tools.length };
}

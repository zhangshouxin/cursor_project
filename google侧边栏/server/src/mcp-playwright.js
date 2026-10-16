import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const mcpConfigPath = path.resolve(__dirname, "../../mcp/config.json");
const playwrightBundlePath = path.resolve(
  __dirname,
  "../node_modules/@playwright/mcp/node_modules/playwright-core/lib/coreBundle.js"
);

/**
 * 连接到已打开的 Chrome 时，个别标签的 page.title() 没有超时。
 * Playwright MCP 会在每次工具返回前读取全部标签标题，一个卡住的标签会拖死整次调用，
 * 客户端 60 秒后报 Request timed out。这里给标题和计数加上 3 秒上限。
 */
function ensureSkipInternalPages() {
  let source;
  try {
    source = fs.readFileSync(playwrightBundlePath, "utf8");
  } catch {
    return;
  }
  const original = `      _onPageCreated(page) {
        const tab2 = new Tab(this, page, (tab3) => this._onPageClosed(tab3));`;
  if (!source.includes(original)) return;
  const patched = `      _onPageCreated(page) {
        let pageUrl = "";
        try {
          pageUrl = page.url() || "";
        } catch {
          pageUrl = "";
        }
        if (/^(chrome-extension|chrome|chrome-untrusted|devtools|edge):/.test(pageUrl))
          return;
        const tab2 = new Tab(this, page, (tab3) => this._onPageClosed(tab3));`;
  fs.writeFileSync(playwrightBundlePath, source.replace(original, patched));
  console.log("[playwright-mcp] skip internal pages for file chooser");
}

function ensureHeaderSnapshotTimeout() {
  let source;
  try {
    source = fs.readFileSync(playwrightBundlePath, "utf8");
  } catch {
    return;
  }
  const original = `      async headerSnapshot() {
        let title;
        let consoleCounts = { total: 0, errors: 0, warnings: 0 };
        if (!this.crashed) {
          await this._raceAgainstModalStates(async () => {
            title = await this.page.title();
          });
          consoleCounts = await this.consoleMessageCount();
        }`;
  if (!source.includes(original)) return;
  const patched = `      async headerSnapshot() {
        let title;
        let consoleCounts = { total: 0, errors: 0, warnings: 0 };
        if (!this.crashed) {
          const withTimeout = (promise, ms) => Promise.race([
            promise,
            new Promise((_, reject) => setTimeout(() => reject(new Error("header snapshot timed out")), ms))
          ]);
          await this._raceAgainstModalStates(async () => {
            try {
              title = await withTimeout(this.page.title(), 3e3);
            } catch {
              title = title || "";
            }
          });
          try {
            consoleCounts = await withTimeout(this.consoleMessageCount(), 3e3);
          } catch {
          }
        }`;
  fs.writeFileSync(playwrightBundlePath, source.replace(original, patched));
  console.log("[playwright-mcp] patched headerSnapshot timeout");
}

let clientPromise = null;

/**
 * 连接到「用户当前正在用的 Chrome」（侧边栏所在窗口），
 * 而不是再 launch 一个新窗口。
 *
 * 需要先在该 Chrome 打开：
 *   chrome://inspect/#remote-debugging
 * 并开启 “Allow remote debugging for this browser instance”。
 */
function createTransport() {
  ensureSkipInternalPages();
  ensureHeaderSnapshotTimeout();
  const mcpCli = path.resolve(
    __dirname,
    "../node_modules/@playwright/mcp/cli.js"
  );

  return new StdioClientTransport({
    command: process.execPath,
    args: [
      mcpCli,
      "--cdp-endpoint=chrome",
      `--config=${mcpConfigPath}`,
    ],
    stderr: "pipe",
  });
}

export async function getPlaywrightMcp() {
  if (!clientPromise) {
    clientPromise = (async () => {
      const transport = createTransport();
      const client = new Client(
        { name: "google-sidebar-ai", version: "1.0.0" },
        { capabilities: {} }
      );

      transport.stderr?.on("data", (buf) => {
        const text = buf.toString().trim();
        if (text) console.error("[playwright-mcp]", text);
      });

      await client.connect(transport);
      console.log("[playwright-mcp] connected via CDP → user Chrome");
      return client;
    })().catch((err) => {
      clientPromise = null;
      throw err;
    });
  }
  return clientPromise;
}

/** 把 MCP tools 转成 OpenAI / DeepSeek function calling 格式 */
export async function listOpenAITools() {
  const client = await getPlaywrightMcp();
  const listed = await client.listTools();
  return (listed.tools || []).map((tool) => ({
    type: "function",
    function: {
      name: tool.name,
      description: tool.description || tool.name,
      parameters: tool.inputSchema || { type: "object", properties: {} },
    },
  }));
}

export async function callMcpTool(name, args = {}) {
  const client = await getPlaywrightMcp();
  const result = await client.callTool({
    name,
    arguments: args && typeof args === "object" ? args : {},
  });

  const texts = [];
  const content = result.content || [];
  for (const part of content) {
    if (part.type === "text") texts.push(part.text);
    else texts.push(JSON.stringify(part));
  }

  return {
    ok: !result.isError,
    text: texts.join("\n").trim() || (result.isError ? "工具执行失败" : "OK"),
    raw: result,
  };
}

export async function closePlaywrightMcp() {
  if (!clientPromise) return;
  try {
    const client = await clientPromise;
    await client.close();
  } catch {
    // ignore
  } finally {
    clientPromise = null;
  }
}

export async function mcpHealth() {
  if (!clientPromise) {
    return { ok: false, pending: true, message: "not started" };
  }
  try {
    const tools = await listOpenAITools();
    return { ok: true, toolCount: tools.length, mode: "cdp-chrome" };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

import path from "path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

/**
 * 通用 stdio MCP 客户端工厂（懒连接、单例）
 * @param {{
 *   label: string,
 *   command: string,
 *   args?: string[],
 *   env?: Record<string, string>,
 *   cwd?: string,
 * }} options
 */
export function createMcpBridge(options) {
  const {
    label,
    command,
    args = [],
    env,
    cwd,
  } = options;

  let clientPromise = null;

  async function getClient() {
    if (!clientPromise) {
      clientPromise = (async () => {
        const transport = new StdioClientTransport({
          command,
          args,
          env: env ? { ...process.env, ...env } : undefined,
          cwd,
          stderr: "pipe",
        });

        const client = new Client(
          { name: `google-sidebar-${label}`, version: "1.0.0" },
          { capabilities: {} }
        );

        transport.stderr?.on("data", (buf) => {
          const text = buf.toString().trim();
          if (text) console.error(`[${label}]`, text);
        });

        await client.connect(transport);
        console.log(`[${label}] connected`);
        return client;
      })().catch((err) => {
        clientPromise = null;
        throw err;
      });
    }
    return clientPromise;
  }

  async function listOpenAITools({ namePrefix = "" } = {}) {
    const client = await getClient();
    const listed = await client.listTools();
    return (listed.tools || []).map((tool) => {
      const name = namePrefix ? `${namePrefix}${tool.name}` : tool.name;
      return {
        type: "function",
        function: {
          name,
          description: tool.description || tool.name,
          parameters: tool.inputSchema || { type: "object", properties: {} },
        },
        _mcpName: tool.name,
      };
    });
  }

  async function callTool(name, args = {}) {
    const client = await getClient();
    const result = await client.callTool({
      name,
      arguments: args && typeof args === "object" ? args : {},
    });

    const texts = [];
    for (const part of result.content || []) {
      if (part.type === "text") texts.push(part.text);
      else texts.push(JSON.stringify(part));
    }

    return {
      ok: !result.isError,
      text: texts.join("\n").trim() || (result.isError ? "工具执行失败" : "OK"),
      raw: result,
    };
  }

  async function close() {
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

  async function health() {
    try {
      // 仅确认可执行文件可解析；未连接时视为已安装待启动
      if (!clientPromise) {
        return { ok: true, pending: true, message: "installed, not started", label };
      }
      const tools = await listOpenAITools();
      return { ok: true, toolCount: tools.length, label };
    } catch (err) {
      return { ok: false, error: err.message, label };
    }
  }

  return {
    label,
    getClient,
    listOpenAITools,
    callTool,
    close,
    health,
  };
}

import {
  Agent,
  Runner,
  OpenAIProvider,
  tool,
  setTracingDisabled,
  setOpenAIAPI,
} from "@openai/agents";
import { callMcpTool, listOpenAITools } from "./mcp-playwright.js";
import {
  callOpenDocsTool,
  listOpenDocsTools,
  openDocsHealth,
} from "./mcp-opendocs.js";
import {
  callGoDocsTool,
  listGoDocsTools,
  goDocsHealth,
} from "./mcp-godocs.js";
import { generateExcelFile, truncate } from "./files.js";
import { documentsDir } from "./documents.js";

const apiKey =
  process.env.AI_API_KEY || process.env.OPENAI_API_KEY || "missing-key";
const baseURL =
  process.env.AI_BASE_URL ||
  process.env.OPENAI_BASE_URL ||
  "https://api.deepseek.com/v1";
const model =
  process.env.AI_MODEL || process.env.OPENAI_MODEL || "deepseek-chat";

const publicBase =
  process.env.PUBLIC_BASE_URL ||
  `http://127.0.0.1:${process.env.PORT || 8787}`;

setTracingDisabled(true);
setOpenAIAPI("chat_completions");

const provider = new OpenAIProvider({
  apiKey,
  baseURL,
  useResponses: false,
});

const runner = new Runner({
  modelProvider: provider,
  model,
  modelSettings: { temperature: 0.3 },
});

export function hasApiKey() {
  return Boolean(process.env.AI_API_KEY || process.env.OPENAI_API_KEY);
}

export function getModelName() {
  return model;
}

const LLM_INSTRUCTIONS = `你是 Chrome 侧边栏里的 AI 助手（纯对话 / 轻量文件预览 / Excel 生成）。

你可以：
1. 回答问题；消息里可能有【上传文件】摘要预览，复杂文档应交给文档专家用 MCP 深读
2. 调用 generate_excel 生成 .xlsx 并返回 download_url
3. 表格单元格里的图片 URL 会自动嵌入

规则：
- 用户要求生成/导出 Excel 时必须调用 generate_excel
- 用简洁中文回复
- 不要假装操作了浏览器或深度解析了大文档`;

const BROWSER_INSTRUCTIONS = `你是 Chrome 侧边栏里的浏览器自动化助手。浏览器自动化通过 **Playwright MCP**，已用 CDP 连接到用户「当前这扇 Chrome」（侧边栏所在窗口），不要再开新浏览器窗口。

你可以：
1. 使用 Playwright MCP 工具操作网页：导航、快照、点击、填写、多标签等
2. 跨多轮对话持续操作；新开的标签会出现在侧边栏左侧主内容区
3. 必要时也可调用 generate_excel 导出表格
4. 回答与当前页面相关的问题

规则：
- 「打开百度 / 用 playwright 打开 xxx」→ 优先 browser_tabs 创建新标签，再 navigate 到目标 URL（百度=https://www.baidu.com）
- 若已有标签，用 browser_tabs list/select 切换，不要重复乱开
- 操作页面前先 snapshot，用返回的 ref 去 click/type/fill
- 若工具报错与 remote debugging / CDP 有关，提示用户打开 chrome://inspect/#remote-debugging 并开启 Allow remote debugging
- 以 accessibility snapshot 为准
- 用简洁中文回复`;

const OFFICE_DOC_INSTRUCTIONS = `你是 Office 文档专家，工具来自 opendocswork-mcp（office-oxide-mcp），工具名带 office__ 前缀。

负责：Word(.doc/.docx) / Excel(.xls/.xlsx 等) / PowerPoint(.ppt/.pptx) / PDF 的读写、编辑、填 PDF 表单、布局分析等。

规则：
- 消息中的「绝对路径」填入 file_path / output_path（必须用绝对路径）
- 读取优先 office__office_read 或 office__to_md / office__get_document_info
- 填 PDF 表单：先 office__office_list_pdf_fields，再 office__office_fill_pdf_form；输出写到 documents 目录新文件
- 创建/改写 Word、Excel、PPT 用对应 office__office_* 工具
- 非 Office 格式不要硬处理，说明应走通用文档专家
- 用简洁中文回复；操作结果说明用了哪些文件路径
- 文档目录：${documentsDir}`;

const GENERAL_DOC_INSTRUCTIONS = `你是通用文档读取专家，工具来自 go-docs-mcp，工具名带 godocs__ 前缀。

负责：txt / md / csv / 图片(OCR) 等非 Office 格式的读取、搜索、摘要、转 Markdown。不要用于 Word/Excel/PPT/PDF 的深度读写（那些归 Office 专家）。

规则：
- go-docs 只认「存储文件名」filename（不是绝对路径）；用消息里的「存储文件名」字段
- 常用：godocs__read_document、godocs__get_document_summary、godocs__search_document、godocs__convert_to_markdown、godocs__read_image、godocs__ocr_document
- 可用 godocs__list_documents 查看目录内文件
- 用简洁中文回复
- 文档目录：${documentsDir}`;

const TRIAGE_INSTRUCTIONS = `你是路由调度员。根据用户最新问题，把任务交给最合适的专家，不要自己长篇回答。

选择规则：
- 打开/浏览网页、点击、填写网页表单、截图、Playwright/浏览器自动化 → Browser MCP Assistant
- Word / Excel / PPT / PDF 的读取、编辑、生成、填 PDF 表单 → Office Document Assistant
- txt / md / csv / 图片 / 其他非 Office 格式读取、OCR、搜索 → General Document Assistant
- 消息里「文档引擎：office」→ Office Document Assistant；「文档引擎：godocs」→ General Document Assistant
- 普通问答、解释、翻译、仅看短预览、侧边栏 generate_excel 快速导出 → LLM Assistant
- 同时含浏览器操作时优先 Browser；同时含深度文档操作时优先对应文档专家`;

const GENERATE_EXCEL_PARAMETERS = {
  type: "object",
  properties: {
    filename: {
      type: "string",
      description: "文件名（可不含 .xlsx），例如 销售汇总",
    },
    sheet_name: {
      type: "string",
      description: "单个工作表名称，默认 Sheet1",
    },
    headers: {
      type: "array",
      items: { type: "string" },
      description: "表头列名",
    },
    rows: {
      type: "array",
      description:
        "数据行（二维数组）。图片请直接填图片 URL 字符串。若提供 headers，则 rows 不含表头",
      items: {
        type: "array",
        items: {
          anyOf: [
            { type: "string" },
            { type: "number" },
            { type: "boolean" },
            { type: "null" },
          ],
        },
      },
    },
    sheets: {
      type: "array",
      description: "多工作表时使用；若提供则优先于 sheet_name/headers/rows",
      items: {
        type: "object",
        properties: {
          name: { type: "string" },
          headers: { type: "array", items: { type: "string" } },
          rows: {
            type: "array",
            items: {
              type: "array",
              items: {
                anyOf: [
                  { type: "string" },
                  { type: "number" },
                  { type: "boolean" },
                  { type: "null" },
                ],
              },
            },
          },
        },
      },
    },
    embed_images: {
      type: "boolean",
      description: "是否把单元格中的图片 URL 嵌入为图片，默认 true",
    },
  },
};

function createGenerateExcelTool() {
  return tool({
    name: "generate_excel",
    description:
      "将表格数据生成 .xlsx 并保存到服务器，返回下载 URL。单元格中的图片 URL（http/https）会自动下载并嵌入为真正图片。用户要求生成/导出 Excel 时调用。",
    parameters: GENERATE_EXCEL_PARAMETERS,
    strict: false,
    async execute(args, runContext) {
      const info = await generateExcelFile({
        ...args,
        publicBase,
      });
      const payload = {
        ok: true,
        message: "Excel 已生成",
        filename: info.filename,
        displayName: info.displayName,
        size: info.size,
        sheets: info.sheets,
        rows: info.rows,
        embedded_images: info.embedded_images,
        failed_images: info.failed_images,
        download_url: info.download_url,
      };
      const downloads = runContext?.context?.downloads;
      if (Array.isArray(downloads) && info.download_url) {
        downloads.push({
          name: "generate_excel",
          url: info.download_url,
          displayName: args?.filename
            ? `${String(args.filename).replace(/\.xlsx$/i, "")}.xlsx`
            : info.displayName || "Excel 文件",
        });
      }
      return JSON.stringify(payload, null, 2);
    },
  });
}

async function loadMcpFunctionTools() {
  const openaiTools = await listOpenAITools();
  return openaiTools.map((t) => {
    const name = t.function?.name || t.name;
    const description = t.function?.description || name;
    const parameters = t.function?.parameters || {
      type: "object",
      properties: {},
    };
    return tool({
      name,
      description,
      parameters,
      strict: false,
      async execute(args) {
        const result = await callMcpTool(name, args || {});
        return truncate(result.text, 24000);
      },
    });
  });
}

function mapPrefixedTools(openaiTools, callFn) {
  return openaiTools.map((t) => {
    const name = t.function?.name || t.name;
    const description = t.function?.description || name;
    const parameters = t.function?.parameters || {
      type: "object",
      properties: {},
    };
    return tool({
      name,
      description,
      parameters,
      strict: false,
      async execute(args) {
        const result = await callFn(name, args || {});
        return truncate(result.text, 24000);
      },
    });
  });
}

async function loadOpenDocsToolsSafe() {
  try {
    const listed = await listOpenDocsTools();
    return {
      ok: true,
      tools: mapPrefixedTools(listed, callOpenDocsTool),
      toolCount: listed.length,
    };
  } catch (err) {
    console.warn("[chat] OpenDocs MCP 不可用:", err.message);
    return { ok: false, tools: [], error: err.message };
  }
}

async function loadGoDocsToolsSafe() {
  try {
    const listed = await listGoDocsTools();
    return {
      ok: true,
      tools: mapPrefixedTools(listed, callGoDocsTool),
      toolCount: listed.length,
    };
  } catch (err) {
    console.warn("[chat] GoDocs MCP 不可用:", err.message);
    return { ok: false, tools: [], error: err.message };
  }
}

function toAgentInput(messages) {
  return (messages || [])
    .filter((m) => m && (m.role === "user" || m.role === "assistant"))
    .map((m) => ({
      role: m.role,
      content: String(m.content ?? ""),
    }));
}

function parseToolArgs(raw) {
  if (!raw) return {};
  if (typeof raw === "object") return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function extractSteps(result) {
  const steps = [];
  for (const item of result.newItems || []) {
    if (item.type === "handoff_call_item") {
      const name = item.rawItem?.name || "handoff";
      steps.push({
        type: "handoff",
        name,
        args: parseToolArgs(item.rawItem?.arguments),
        to: item.rawItem?.name,
      });
      continue;
    }
    if (item.type === "handoff_output_item") {
      steps.push({
        type: "handoff_result",
        name: item.rawItem?.name || "handoff",
        summary: item.targetAgent?.name || "switched",
        preview: `已交给 ${item.targetAgent?.name || "专家"}`,
        ok: true,
      });
      continue;
    }
    if (item.type === "tool_call_item") {
      const name = item.rawItem?.name || "tool";
      steps.push({
        type: "tool_call",
        name,
        args: parseToolArgs(item.rawItem?.arguments),
      });
      continue;
    }
    if (item.type === "tool_call_output_item") {
      const name = item.rawItem?.name || "tool";
      const text =
        typeof item.output === "string"
          ? item.output
          : JSON.stringify(item.output ?? "");
      steps.push({
        type: "tool_result",
        name,
        summary: name,
        preview: truncate(text, 600),
        ok: !/失败|error|Error/i.test(text.slice(0, 80)),
      });
    }
  }
  return steps;
}

function makeFallbackDocAgent(name, handoffDescription, reason) {
  return new Agent({
    name,
    handoffDescription,
    instructions: `文档 MCP 当前不可用：${reason}。请用中文向用户说明如何安装/配置，并基于消息里的短预览尽量回答；不要假装调用了文档工具。`,
    tools: [],
    model,
  });
}

async function buildTriageAgent({ mcpOk, mcpError, officeDocs, goDocs }) {
  const excelTool = createGenerateExcelTool();
  const llmAgent = new Agent({
    name: "LLM Assistant",
    handoffDescription:
      "普通问答、翻译总结、短预览、侧边栏 generate_excel；不需要浏览器或深度文档 MCP 时使用",
    instructions: LLM_INSTRUCTIONS,
    tools: [excelTool],
    model,
  });

  let browserAgent;
  if (mcpOk) {
    const mcpTools = await loadMcpFunctionTools();
    browserAgent = new Agent({
      name: "Browser MCP Assistant",
      handoffDescription:
        "需要打开网页、点击、填写、截图、页面搜索或 Playwright/浏览器自动化时使用",
      instructions: BROWSER_INSTRUCTIONS,
      tools: [...mcpTools, excelTool],
      model,
    });
  } else {
    browserAgent = new Agent({
      name: "Browser MCP Assistant",
      handoffDescription:
        "用户提到浏览器/网页操作时使用（当前 MCP 不可用，请向用户说明原因）",
      instructions:
        BROWSER_INSTRUCTIONS +
        `\n\n注意：当前 Playwright MCP 不可用（${mcpError || "未知错误"}）。请用中文说明无法做浏览器自动化，并提示开启 remote debugging；仍可回答一般问题或建议用户稍后再试。不要调用不存在的浏览器工具。`,
      tools: [excelTool],
      model,
    });
  }

  const officeAgent = officeDocs.ok
    ? new Agent({
        name: "Office Document Assistant",
        handoffDescription:
          "Word/Excel/PPT/PDF 读写、编辑、填 PDF 表单（opendocswork-mcp / office-oxide-mcp）",
        instructions: OFFICE_DOC_INSTRUCTIONS,
        tools: [...officeDocs.tools, excelTool],
        model,
      })
    : makeFallbackDocAgent(
        "Office Document Assistant",
        "Word/Excel/PPT/PDF 处理（当前 OpenDocs MCP 不可用）",
        officeDocs.error || "未知错误"
      );

  const generalDocAgent = goDocs.ok
    ? new Agent({
        name: "General Document Assistant",
        handoffDescription:
          "txt/md/csv/图片等非 Office 格式读取、OCR、搜索（go-docs-mcp）",
        instructions: GENERAL_DOC_INSTRUCTIONS,
        tools: goDocs.tools,
        model,
      })
    : makeFallbackDocAgent(
        "General Document Assistant",
        "非 Office 文档读取（当前 GoDocs MCP 不可用）",
        goDocs.error || "未知错误"
      );

  return Agent.create({
    name: "Triage",
    instructions: TRIAGE_INSTRUCTIONS,
    handoffs: [llmAgent, browserAgent, officeAgent, generalDocAgent],
    model,
  });
}

/**
 * OpenAI Agents SDK 编排：Triage → LLM / Browser / Office Docs / General Docs
 */
export async function chat({ messages, maxToolRounds = 12 }) {
  if (!hasApiKey()) {
    const err = new Error("未配置 AI_API_KEY，请在 server/.env 中设置");
    err.status = 503;
    throw err;
  }

  let mcpOk = true;
  let mcpError;
  try {
    await listOpenAITools();
  } catch (err) {
    mcpOk = false;
    mcpError = err.message;
    console.warn("[chat] Playwright MCP 不可用:", mcpError);
  }

  const [officeDocs, goDocs] = await Promise.all([
    loadOpenDocsToolsSafe(),
    loadGoDocsToolsSafe(),
  ]);

  const triage = await buildTriageAgent({
    mcpOk,
    mcpError,
    officeDocs,
    goDocs,
  });
  const context = { downloads: [] };
  const input = toAgentInput(messages);

  const result = await runner.run(triage, input, {
    context,
    maxTurns: Math.max(4, maxToolRounds + 2),
  });

  const lastAgentName = result.lastAgent?.name || "Triage";
  const steps = extractSteps(result);

  let engine = "agents-sdk:llm";
  if (/Browser/i.test(lastAgentName)) {
    engine = mcpOk ? "agents-sdk:browser-mcp" : "agents-sdk:browser-fallback";
  } else if (/Office Document/i.test(lastAgentName)) {
    engine = officeDocs.ok
      ? "agents-sdk:opendocs-mcp"
      : "agents-sdk:opendocs-fallback";
  } else if (/General Document/i.test(lastAgentName)) {
    engine = goDocs.ok
      ? "agents-sdk:godocs-mcp"
      : "agents-sdk:godocs-fallback";
  }

  return {
    reply: String(result.finalOutput || "").trim() || "未能生成回复",
    model,
    steps,
    downloads: context.downloads,
    engine,
    route: lastAgentName,
  };
}

/** 供 health 探测（不强制拉起 MCP 进程） */
export async function docsMcpStatus() {
  const [office, godocs] = await Promise.all([openDocsHealth(), goDocsHealth()]);
  return { office, godocs, documentsDir };
}

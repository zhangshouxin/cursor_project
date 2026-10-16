# Chrome 侧边栏 AI 助手 + Playwright MCP

侧边栏负责对话与文件；**浏览器自动化走官方 Playwright MCP**（`@playwright/mcp`）。

## 架构

```
Chrome 侧边栏扩展
    → 本地 Express (8787) + DeepSeek
        → OpenAI Agents SDK（Triage）
            ├─ LLM Assistant（问答 / generate_excel）
            ├─ Browser MCP Assistant（Playwright）
            ├─ Office Document Assistant（opendocswork-mcp：Word/Excel/PPT/PDF）
            └─ General Document Assistant（go-docs-mcp：txt/md/csv/图片等）
```

Triage 按意图与上传文件扩展名分流。上传文件会落到 `server/documents/`，供文档 MCP 读取。

### 文档 MCP 安装

```bash
cd server
bash scripts/install-doc-mcps.sh
# 或手动：
#   cargo install --git https://github.com/Aimino-Tech/opendocswork-mcp
#   go install github.com/drolosoft/go-docs-mcp@latest
# 并在 .env 设置 OPENDOCS_MCP_BIN / GODOCS_MCP_BIN（可选，默认查 PATH 与 server/bin）
```

go-docs 可选依赖：`poppler`（PDF）、`tesseract`（OCR）、`pandoc`（DOCX，本项目 Office 文件优先走 OpenDocs）。

同时项目根目录配置了 Cursor MCP（`.cursor/mcp.json`），可在 Cursor 里直接用同一套 Playwright MCP。

## 快速开始

### 1. 启动侧边栏后端

```bash
cd server
cp .env.example .env   # 配置 AI_API_KEY
npm install
npm start
```

## 重要：在侧边栏左侧操作（不要新窗口）

Playwright MCP 已改为 **CDP 连接当前 Chrome**（侧边栏所在窗口）。

一次性设置：

1. 侧边栏点「开启调试」，或手动打开 `chrome://inspect/#remote-debugging`
2. 开启 **Allow remote debugging for this browser instance**
3. 再说「打开百度…」——页面会出现在侧边栏左侧，MCP 在同一窗口继续操作

「打开」类指令还会先由扩展在左侧创建标签，再交给 MCP 接管。

### 2. 加载扩展

`chrome://extensions` → 开发者模式 → 加载 `extension` 目录。

### 3. （可选）在 Cursor 里用 Playwright MCP

已写入 `.cursor/mcp.json`。打开 **Cursor Settings → MCP**，确认 `playwright` 已启用；必要时 Reload。

也可单独启动：

```bash
cd server
npm run mcp
```

## 能力

- 对话 + 文件分析（侧边栏）
  - Word：`.docx`（推荐）、`.doc`（弱解析）
  - Excel：`.xlsx` / `.xls` / `.xlsm` / `.xlsb` / `.ods`
  - 其它：PDF、txt/md/csv/json 等
  - **生成 Excel**：AI 可调用 `generate_excel`，文件保存在 `server/downloads/`，返回 `/downloads/...` 下载地址
  - 单元格中的图片网络地址会自动下载并**嵌入为真正图片**（失败则保留 URL 文本）
  - 下载链接为 ASCII 路径，侧边栏内可点击下载
- Playwright MCP：导航、accessibility snapshot、按 ref 点击/填写、多标签等
- 多轮会话共享同一 MCP 浏览器会话；侧边栏支持新建/历史会话

## 配置

- `server/.env`：DeepSeek / 兼容 OpenAI 的 Key
- `mcp/config.json`：Playwright MCP 浏览器选项（默认本机 Chrome、headed）

## API

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/health` | 健康检查（含 MCP 状态） |
| POST | `/api/chat` | AI 会话（Agents SDK 路由：LLM 或 Playwright MCP） |
| POST | `/api/upload` | 上传解析文件 |

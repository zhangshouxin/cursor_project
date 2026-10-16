import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** 上传文件持久化目录（go-docs DOCS_MCP_DIR + office 绝对路径共用） */
export const documentsDir = path.resolve(__dirname, "..", "documents");

fs.mkdirSync(documentsDir, { recursive: true });

/** Word / Excel / PPT / PDF → opendocs（office-oxide-mcp） */
export const OFFICE_EXTS = new Set([
  ".doc",
  ".docx",
  ".xls",
  ".xlsx",
  ".xlsm",
  ".xlsb",
  ".ppt",
  ".pptx",
  ".pdf",
]);

export function isOfficeDocument(filename = "") {
  return OFFICE_EXTS.has(path.extname(filename).toLowerCase());
}

function safeBaseName(originalName = "file") {
  const base = path
    .basename(originalName)
    .replace(/[^\w.\u4e00-\u9fff()-]+/g, "_");
  return base || "file";
}

/**
 * 将 multer 临时文件保存到 documents/，供文档 MCP 使用
 */
export async function persistUploadedDocument(tempPath, originalName) {
  const ext = path.extname(originalName || "").toLowerCase();
  const stem = path.basename(safeBaseName(originalName), ext) || "file";
  const stamp = Date.now().toString(36);
  const storedName = `${stem}_${stamp}${ext}`;
  const absPath = path.join(documentsDir, storedName);
  await fs.promises.copyFile(tempPath, absPath);
  return {
    storedName,
    absPath,
    engine: isOfficeDocument(originalName) ? "office" : "godocs",
  };
}

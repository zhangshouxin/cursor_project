import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import ExcelJS from "exceljs";
import mammoth from "mammoth";
import pdfParse from "pdf-parse";
import * as XLSX from "xlsx";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const downloadsDir = path.join(__dirname, "..", "downloads");

const TEXT_EXTS = new Set([
  ".txt",
  ".md",
  ".csv",
  ".json",
  ".js",
  ".ts",
  ".tsx",
  ".jsx",
  ".py",
  ".html",
  ".css",
  ".xml",
  ".yml",
  ".yaml",
  ".log",
]);

const WORD_EXTS = new Set([".docx", ".doc"]);
const EXCEL_EXTS = new Set([".xlsx", ".xls", ".xlsm", ".xlsb", ".ods"]);

/**
 * 读取 Word（.docx / .doc）正文。
 * .docx 用 mammoth；.doc 为旧版二进制，尝试按文本兜底，失败则提示另存为 docx。
 */
export async function extractWordText(buffer, ext) {
  if (ext === ".docx") {
    const result = await mammoth.extractRawText({ buffer });
    return (result.value || "").trim();
  }

  if (ext === ".doc") {
    const raw = buffer.toString("utf8");
    const chunks = raw
      .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, " ")
      .replace(/\s{2,}/g, " ")
      .match(/[\u4e00-\u9fffA-Za-z0-9，。！？、；：""''（）【】\s.,;:!?()[\]-]{8,}/g);
    const text = (chunks || []).join("\n").trim();
    if (text.length >= 40) {
      return (
        text +
        "\n\n（提示：当前为旧版 .doc 弱解析，建议另存为 .docx 以获得更准确文本）"
      );
    }
    throw Object.assign(
      new Error("暂无法可靠解析旧版 .doc，请另存为 .docx 后重试"),
      { status: 400 }
    );
  }

  throw Object.assign(new Error(`不支持的 Word 类型：${ext}`), { status: 400 });
}

/**
 * 读取 Excel（.xlsx / .xls / .xlsm 等）为可读文本。
 * 每个工作表输出为「表名 + TSV 行列」。
 */
export async function extractExcelText(buffer, { maxRowsPerSheet = 2000 } = {}) {
  const workbook = XLSX.read(buffer, {
    type: "buffer",
    cellDates: true,
    dense: false,
  });

  if (!workbook.SheetNames?.length) {
    return "";
  }

  const parts = [];
  for (const name of workbook.SheetNames) {
    const sheet = workbook.Sheets[name];
    if (!sheet) continue;

    const rows = XLSX.utils.sheet_to_json(sheet, {
      header: 1,
      raw: false,
      defval: "",
      blankrows: false,
    });

    const limited = rows.slice(0, maxRowsPerSheet);
    const lines = limited.map((row) =>
      (Array.isArray(row) ? row : [])
        .map((cell) => String(cell ?? "").replace(/\t|\n|\r/g, " ").trim())
        .join("\t")
    );

    const body = lines.join("\n").trim();
    if (!body) {
      parts.push(`【工作表：${name}】\n（空表）`);
      continue;
    }

    let block = `【工作表：${name}】\n${body}`;
    if (rows.length > maxRowsPerSheet) {
      block += `\n…（已截断，共 ${rows.length} 行，仅保留前 ${maxRowsPerSheet} 行）`;
    }
    parts.push(block);
  }

  return parts.join("\n\n").trim();
}

function sanitizeFilename(name) {
  const base = String(name || "export")
    .replace(/[\\/:*?"<>|]/g, "_")
    .replace(/\s+/g, "_")
    .slice(0, 80);
  return base.replace(/\.xlsx$/i, "") || "export";
}

/** 磁盘与 URL 仅使用 ASCII，避免中文路径下载失败 */
function asciiStoredName() {
  const stamp = new Date()
    .toISOString()
    .replace(/[:.]/g, "-")
    .replace("T", "_")
    .slice(0, 19);
  const rand = Math.random().toString(36).slice(2, 8);
  return `export_${stamp}_${rand}.xlsx`;
}

function normalizeSheet({ name, headers, rows }) {
  const sheetName = String(name || "Sheet1").slice(0, 31) || "Sheet1";
  const data = [];
  if (Array.isArray(headers) && headers.length) {
    data.push(headers.map((h) => (h == null ? "" : h)));
  }
  if (Array.isArray(rows)) {
    for (const row of rows) {
      if (Array.isArray(row)) data.push(row.map((c) => (c == null ? "" : c)));
      else if (row && typeof row === "object") {
        if (Array.isArray(headers) && headers.length) {
          data.push(headers.map((h) => (row[h] == null ? "" : row[h])));
        } else {
          data.push(Object.values(row).map((c) => (c == null ? "" : c)));
        }
      }
    }
  }
  return { sheetName, data };
}

const IMAGE_URL_RE =
  /^https?:\/\/[^\s]+\.(png|jpe?g|gif|webp|bmp)(\?[^\s]*)?$/i;
const IMAGE_URL_LOOSE_RE = /^https?:\/\/[^\s]+$/i;

function looksLikeImageUrl(value) {
  if (typeof value !== "string") return false;
  const v = value.trim();
  if (!/^https?:\/\//i.test(v)) return false;
  if (IMAGE_URL_RE.test(v)) return true;
  // 淘宝/CDN 等无扩展名图片地址
  return (
    IMAGE_URL_LOOSE_RE.test(v) &&
    /(img|image|pic|photo|cdn|alicdn|tbcdn|jpg|jpeg|png|webp)/i.test(v)
  );
}

function extFromContentType(contentType = "") {
  const t = contentType.toLowerCase();
  if (t.includes("png")) return "png";
  if (t.includes("jpeg") || t.includes("jpg")) return "jpeg";
  if (t.includes("gif")) return "gif";
  if (t.includes("webp")) return "png"; // exceljs 对 webp 支持弱，按 png 尝试
  if (t.includes("bmp")) return "jpeg";
  return "jpeg";
}

function extFromUrl(url) {
  try {
    const pathname = new URL(url).pathname.toLowerCase();
    if (pathname.endsWith(".png")) return "png";
    if (pathname.endsWith(".gif")) return "gif";
    if (pathname.endsWith(".webp")) return "png";
    if (pathname.endsWith(".jpg") || pathname.endsWith(".jpeg")) return "jpeg";
  } catch {
    // ignore
  }
  return null;
}

async function fetchImageBuffer(url, { timeoutMs = 15000 } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    let referer = "https://www.taobao.com/";
    try {
      const u = new URL(url);
      referer = `${u.protocol}//${u.host}/`;
      if (/(alicdn|tbcdn|taobao|tmall)/i.test(u.host)) {
        referer = "https://item.taobao.com/";
      }
    } catch {
      // ignore
    }

    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        Accept: "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
        Referer: referer,
      },
      redirect: "follow",
    });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }
    const contentType = res.headers.get("content-type") || "";
    if (
      contentType &&
      !contentType.startsWith("image/") &&
      !contentType.includes("octet-stream")
    ) {
      throw new Error(`非图片类型: ${contentType}`);
    }
    const ab = await res.arrayBuffer();
    const buffer = Buffer.from(ab);
    if (buffer.length < 32) throw new Error("图片内容过小");
    const extension =
      extFromUrl(url) || extFromContentType(contentType) || "jpeg";
    return { buffer, extension };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 生成 Excel 并保存到 downloads 目录，返回下载信息。
 * 单元格中的图片 URL 会下载并嵌入为真正图片（失败则保留 URL 文本）。
 */
export async function generateExcelFile({
  filename,
  sheet_name,
  headers,
  rows,
  sheets,
  publicBase = "http://127.0.0.1:8787",
  embed_images = true,
} = {}) {
  await fs.mkdir(downloadsDir, { recursive: true });

  const sheetDefs =
    Array.isArray(sheets) && sheets.length
      ? sheets
      : [{ name: sheet_name || "Sheet1", headers, rows: rows || [] }];

  if (!sheetDefs.length) {
    throw Object.assign(new Error("没有可写入的表格数据"), { status: 400 });
  }

  const workbook = new ExcelJS.Workbook();
  workbook.creator = "sidebar-ai";
  workbook.created = new Date();

  let totalRows = 0;
  let embeddedImages = 0;
  let failedImages = 0;
  const imageCache = new Map();

  async function getImage(url) {
    if (imageCache.has(url)) return imageCache.get(url);
    const p = fetchImageBuffer(url)
      .then((img) => {
        imageCache.set(url, img);
        return img;
      })
      .catch((err) => {
        imageCache.set(url, null);
        throw err;
      });
    imageCache.set(url, p);
    return p;
  }

  for (const def of sheetDefs) {
    const { sheetName, data } = normalizeSheet(def);
    if (!data.length) data.push([""]);

    const ws = workbook.addWorksheet(sheetName, {
      properties: { defaultRowHeight: 18 },
      views: [{ state: "frozen", ySplit: def.headers?.length ? 1 : 0 }],
    });

    const colCount = Math.max(1, ...data.map((r) => r.length));
    for (let c = 1; c <= colCount; c++) {
      ws.getColumn(c).width = 18;
    }

    totalRows += Math.max(0, data.length - (def.headers?.length ? 1 : 0));

    for (let r = 0; r < data.length; r++) {
      const rowValues = data[r] || [];
      const excelRow = ws.getRow(r + 1);
      let rowHasImage = false;

      for (let c = 0; c < Math.max(colCount, rowValues.length); c++) {
        const raw = rowValues[c];
        const cell = excelRow.getCell(c + 1);
        const text = raw == null ? "" : String(raw);

        if (embed_images && looksLikeImageUrl(text)) {
          try {
            const img = await getImage(text.trim());
            if (!img) throw new Error("下载失败");
            const imageId = workbook.addImage({
              buffer: img.buffer,
              extension: img.extension,
            });
            // 先清空文字，再嵌入图片
            cell.value = "";
            ws.addImage(imageId, {
              tl: { col: c, row: r },
              ext: { width: 96, height: 96 },
              editAs: "oneCell",
            });
            embeddedImages += 1;
            rowHasImage = true;
            ws.getColumn(c + 1).width = Math.max(ws.getColumn(c + 1).width || 12, 16);
          } catch {
            cell.value = text;
            failedImages += 1;
          }
        } else if (typeof raw === "number") {
          cell.value = raw;
        } else if (typeof raw === "boolean") {
          cell.value = raw;
        } else {
          cell.value = text;
        }
      }

      excelRow.height = rowHasImage ? 80 : r === 0 && def.headers?.length ? 22 : 18;
      if (r === 0 && def.headers?.length) {
        excelRow.font = { bold: true };
      }
      excelRow.commit();
    }
  }

  const displayBase = sanitizeFilename(filename);
  const displayName = `${displayBase}.xlsx`;
  const storedName = asciiStoredName();
  const filePath = path.join(downloadsDir, storedName);
  const metaPath = `${filePath}.meta.json`;

  await workbook.xlsx.writeFile(filePath);
  const stat = await fs.stat(filePath);
  await fs.writeFile(
    metaPath,
    JSON.stringify({
      displayName,
      createdAt: new Date().toISOString(),
      embeddedImages,
      failedImages,
    }),
    "utf8"
  );

  const base = String(publicBase || "").replace(/\/$/, "");
  const downloadUrl = `${base}/downloads/${storedName}`;

  return {
    ok: true,
    filename: storedName,
    displayName,
    path: filePath,
    size: stat.size,
    sheets: sheetDefs.length,
    rows: totalRows,
    embedded_images: embeddedImages,
    failed_images: failedImages,
    download_url: downloadUrl,
  };
}

export async function extractFileText(filePath, originalName) {
  const ext = path.extname(originalName || filePath).toLowerCase();
  const buffer = await fs.readFile(filePath);

  if (ext === ".pdf") {
    const data = await pdfParse(buffer);
    return data.text?.trim() || "";
  }

  if (WORD_EXTS.has(ext)) {
    return extractWordText(buffer, ext);
  }

  if (EXCEL_EXTS.has(ext)) {
    return extractExcelText(buffer);
  }

  if (TEXT_EXTS.has(ext) || !ext) {
    return buffer.toString("utf8").trim();
  }

  throw Object.assign(
    new Error(`暂不支持解析该文件类型：${ext || "未知"}`),
    { status: 400 }
  );
}

export function truncate(text, max = 24000) {
  if (!text) return "";
  if (text.length <= max) return text;
  return text.slice(0, max) + "\n\n…（内容已截断）";
}

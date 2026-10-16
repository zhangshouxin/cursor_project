import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { execFileSync } from "child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const localBinDir = path.resolve(__dirname, "..", "bin");

function which(cmd) {
  try {
    const out = execFileSync("which", [cmd], { encoding: "utf8" }).trim();
    return out || null;
  } catch {
    return null;
  }
}

/**
 * 解析 MCP 可执行文件路径
 * 优先环境变量 → server/bin/ → PATH
 */
export function resolveBinary({ envKey, candidates = [], hint = "" }) {
  const fromEnv = process.env[envKey];
  if (fromEnv && fs.existsSync(fromEnv)) return fromEnv;

  for (const name of candidates) {
    const local = path.join(localBinDir, name);
    if (fs.existsSync(local)) return local;
    const found = which(name);
    if (found) return found;
  }

  const names = candidates.join(" / ");
  const err = new Error(
    `未找到 MCP 可执行文件（${names}）${hint ? `。${hint}` : ""}`
  );
  err.code = "MCP_BIN_MISSING";
  throw err;
}

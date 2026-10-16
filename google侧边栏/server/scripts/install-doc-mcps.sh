#!/usr/bin/env bash
# 安装文档 MCP 二进制到 server/bin/
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BIN="$ROOT/bin"
SRC="$ROOT/.mcp-src"
mkdir -p "$BIN" "$SRC"
export PATH="${HOME}/.cargo/bin:${HOME}/go/bin:${HOME}/.local/go/bin:/opt/homebrew/bin:${PATH}"

echo "==> OpenDocs (office-oxide-mcp)"
if [ -x "$BIN/office-oxide-mcp" ]; then
  echo "already present: $BIN/office-oxide-mcp"
elif command -v cargo >/dev/null 2>&1; then
  if [ ! -f "$SRC/opendocswork-mcp/Cargo.toml" ]; then
    curl -L --connect-timeout 30 --max-time 600 --retry 5 \
      -o /tmp/opendocs-main.tar.gz \
      "https://codeload.github.com/Aimino-Tech/opendocswork-mcp/tar.gz/refs/heads/main"
    rm -rf "$SRC/opendocswork-mcp" "$SRC/opendocswork-mcp-main"
    tar -xzf /tmp/opendocs-main.tar.gz -C "$SRC"
    mv "$SRC/opendocswork-mcp-main" "$SRC/opendocswork-mcp"
  fi
  (cd "$SRC/opendocswork-mcp" && cargo build --release)
  cp -f "$SRC/opendocswork-mcp/target/release/office-oxide-mcp" "$BIN/office-oxide-mcp"
  echo "installed $BIN/office-oxide-mcp"
else
  echo "跳过：未找到 cargo"
fi

echo "==> GoDocs (go-docs-mcp)"
if [ -x "$BIN/go-docs-mcp" ]; then
  echo "already present: $BIN/go-docs-mcp"
elif command -v go >/dev/null 2>&1; then
  if [ ! -f "$SRC/go-docs-mcp/go.mod" ]; then
    curl -L --connect-timeout 30 --max-time 600 --retry 5 \
      -o /tmp/godocs-main.tar.gz \
      "https://codeload.github.com/drolosoft/go-docs-mcp/tar.gz/refs/heads/main"
    rm -rf "$SRC/go-docs-mcp" "$SRC/go-docs-mcp-main"
    tar -xzf /tmp/godocs-main.tar.gz -C "$SRC"
    mv "$SRC/go-docs-mcp-main" "$SRC/go-docs-mcp"
  fi
  (cd "$SRC/go-docs-mcp" && GOPROXY="${GOPROXY:-https://goproxy.cn,direct}" GOSUMDB=off go build -o "$BIN/go-docs-mcp" .)
  echo "installed $BIN/go-docs-mcp"
else
  echo "跳过：未找到 go"
fi

echo "完成。可写入 server/.env："
echo "OPENDOCS_MCP_BIN=$BIN/office-oxide-mcp"
echo "GODOCS_MCP_BIN=$BIN/go-docs-mcp"

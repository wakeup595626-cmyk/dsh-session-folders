#!/bin/bash
# @dsh-external/dsh-session-folders — 零依赖拷贝构建。
# host 与 client 源码都是免编译 JS，本脚本只做拷贝/包装：
#   src/index.js        -> lib/index.js   （host，ESM 原样）
#   src/client/index.js -> lib/client.js  （包 __ModuleLoader__ 头尾）
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

mkdir -p lib
cp src/index.js lib/index.js
node scripts/build-client.mjs

echo "=== Build complete (copy mode) ==="

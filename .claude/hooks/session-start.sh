#!/bin/bash
# SessionStart フック：セッション開始時に依存を解決し、npm run check / build:web が即実行できる状態にする。
# このリポジトリは依存を proto/ に集約している（ルートに package.json は無い）。
# 同期実行・冪等・非対話。ローカル/リモート両方で走る（node_modules があれば npm install はほぼ即時）。
set -euo pipefail

PROJECT_DIR="${CLAUDE_PROJECT_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
PROTO_DIR="$PROJECT_DIR/proto"

if [ ! -f "$PROTO_DIR/package.json" ]; then
  echo "session-start: proto/package.json が無いためスキップ" >&2
  exit 0
fi

cd "$PROTO_DIR"
# 依存インストール（キャッシュ活用のため ci ではなく install・監査/資金メッセージは抑制）
npm install --no-audit --no-fund
echo "session-start: proto の依存を解決しました（npm install 完了）" >&2

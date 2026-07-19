# roguelike-ai-design — 『深蝕 — The Corroding Deep』

NetHack 系ローグライクの現代化（個人開発・設計＋プロトタイプ）。実行時 LLM ゼロ・完全オフライン・決定論（seed 固定）。
本体は web PWA として公開：https://yasu12ctb-dev.github.io/roguelike-ai-design/

## ドキュメント（この順で読む）
1. `CLAUDE.md` — セッション引き継ぎ・現在地・技術メモ（開発の起点）
2. `design-snapshot.md` — 設計思想と確定事項（正典）
3. `prototype-spec.md` — 実装仕様（UI 基準 §10 含む）
4. `ROADMAP.md` — マイルストン
5. `proto/README.md` — 実行方法・構成の詳細

## ローカル開発（Node 22・依存は `proto/` に集約）
```bash
git clone https://github.com/yasu12ctb-dev/roguelike-ai-design.git
cd roguelike-ai-design/proto
npm install
npm run check          # 受理ゲート→typecheck→各QA→golden→build:web（CI と同順・push 前必須）
npm run build:web      # web/app.js を生成
npx serve web          # 等の静的サーバで web/ を開いて PWA を試す
node --experimental-strip-types src/cli.ts --new   # 対話型CLI（情緒検証の本番）
```
`.nvmrc`（Node 22）と SessionStart フック（`.claude/hooks/session-start.sh`＝セッション開始時に `proto` の依存を自動解決）を同梱。

## 開発フロー
feature ブランチ → PR → CI（`npm run check` 相当）green → マージ → GitHub Pages デプロイ確認。
実装の正本は GitHub（コード/コミット）。設計変更は必ず「議論 → 明示承認 → snapshot/spec へ反映」（詳細は `CLAUDE.md`）。

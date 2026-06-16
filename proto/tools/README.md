# tools — ローカル用の開発ツール（CIには含めない）

## playtest.mjs — 自動テストプレイ（実ブラウザ）
Playwright で実ブラウザに本体（`web/`）を読み込み、街歩き／シートの選択／潜行・戦闘をファジングして、
**JS例外（バグ）の収集**と**節目スクショ**を行う。リモート（Web版 Claude）はブラウザCDNが遮断され動かないため、**ローカルで実行**する。

### セットアップ（初回のみ）
```sh
cd proto
npm i -D playwright          # もしくは: npm i -g playwright
npx playwright install chromium
```

### 実行
```sh
cd proto
npm run build:web            # web/app.js を最新に
node tools/playtest.mjs            # ヘッドレス・400手・スクショは tools/shots/
HEADED=1 SLOWMO=120 node tools/playtest.mjs   # 実ブラウザを「見ながら」ゆっくり
STEPS=800 SEED=42 EXPLORE=0.5 node tools/playtest.mjs
```

### 出力
- `tools/shots/*.png` … 画面遷移のスクリーンショット
- 標準出力 … 手数・シート処理数・**JS例外/console.error の件数と内容**（0件なら ✅）

### 環境変数
| 変数 | 既定 | 説明 |
|---|---|---|
| `HEADED` | 0 | 1 で実ブラウザ表示（横で観察） |
| `SLOWMO` | 0/80 | 操作間ウェイト(ms) |
| `STEPS` | 400 | 手数 |
| `SEED` | 12345 | 乱択シード（再現用） |
| `EXPLORE` | 0.4 | シート選択の冒険度（高いほど多様な選択肢を踏む） |
| `PORT` | 8731 | 内蔵静的サーバのポート |

### 注意
- これは**ファジング（ランダム操作）**であって上手なプレイではない。目的は「クラッシュ／例外／表示崩れ」の発見と画面確認。
- スクショ（`tools/shots/`）は `.gitignore` 済み。

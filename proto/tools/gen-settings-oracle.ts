// 設定シートの「凍結 oracle」生成器（U1a・一度きり実行・以後更新禁止）。
//
// ★重要な規律（Codex 実装時必須条件1）：
//   本生成器は **refactor 後の `buildSettingLabels()` / `SETTING_DEFS` を一切 import しない**。
//   期待値は **基準 commit 6a537d197d23865f578832ba56e88a753dc38825（v0.166.0）の legacy
//   `settingsSheet`** から採取した *独立した* 転記である（下記 LEGACY_* がその転記）。
//   実装と期待値が同根になると誤りを検出できないため、この独立性が検査の生命線。
//
// ★転記の正しさは機械照合する：生成した全ラベル文字列が、基準 commit のソース
//   （`git show <BASE>:proto/src/web/main.ts`）に**実在すること**を検査してから書き出す。
//   ＝「手で写した」ことに起因する取り違えを構造的に排除する。
//
// 実行: node --experimental-strip-types tools/gen-settings-oracle.ts [--force]
//   既存 fixture があれば --force なしでは上書きしない（誤再生成の防止）。
//   CI（npm run check）では実行しない。検査側は fixture を読むだけ。

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const BASE_COMMIT = "6a537d197d23865f578832ba56e88a753dc38825";
const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT = join(__dirname, "fixtures", "settings-oracle.json");

// ---- legacy（基準 commit）からの転記 ---------------------------------------
// 以下はすべて基準 commit の `settingsSheet` 内の式をそのまま写したもの。
// 新実装のモジュールは参照しない（＝独立期待値）。
const SZJP = { lg: "大", md: "中", sm: "小" } as const;
const volJp = (v: number) => (v < 0.45 ? "小" : v < 0.72 ? "中" : "大");

/** 表示順（legacy の opts 配列と同順）。id は U1a で新設する安定 ID。 */
const LEGACY_ORDER = [
  "help", "audio-mute", "bgm-toggle", "bgm-volume", "sfx-volume",
  "dpad-toggle", "dpad-position", "dpad-size", "dpad-autorun",
  "lunge-button", "guard-button", "log-size",
  "save-export", "save-import", "dev-tools", "world-reset", "close",
] as const;

/** グループ見出し（legacy で header を持つ項目と同じ位置・同じ文字列）。 */
const LEGACY_HEADERS: Record<string, string> = {
  "help": "あそびかた",
  "audio-mute": "音",
  "dpad-toggle": "操作・表示",
  "save-export": "データ",
};

/** 状態に依存しないラベル（legacy の固定文字列）。 */
const LEGACY_FIXED: Record<string, string> = {
  "help": "❓ あそびかた・記号の凡例",
  "save-export": "💾 セーブを書き出す（バックアップ）",
  "save-import": "📂 セーブを読み込む（復元）",
  "dev-tools": "🔧 テスト",
  "world-reset": "⟲ 世界を最初からやり直す",
  "close": "閉じる",
};

/** 状態で変わるラベル＝「その項目自身の値 → 表示文字列」（legacy の三項式/テンプレを転記）。 */
const LEGACY_VARIABLE: Record<string, Record<string, string>> = {
  "audio-mute": { "true": "♪ 音を出す", "false": "🔇 すべての音を消す" },
  "bgm-toggle": { "true": "🎵 BGM：オン → オフ", "false": "🎵 BGM：オフ → オン" },
  "bgm-volume": Object.fromEntries((["小", "中", "大"] as const).map((j) => [j, `🎵 BGM音量：${j}（小→中→大）`])),
  "sfx-volume": Object.fromEntries((["小", "中", "大"] as const).map((j) => [j, `🔊 効果音音量：${j}（小→中→大）`])),
  "dpad-toggle": { "true": "🕹 方向パッド：オン → オフ", "false": "🕹 方向パッド：オフ → オン" },
  "dpad-position": {
    "right": "🕹 方向パッドの位置：右下（右下→左下→中央）",
    "left": "🕹 方向パッドの位置：左下（右下→左下→中央）",
    "center": "🕹 方向パッドの位置：中央（右下→左下→中央）",
  },
  "dpad-size": Object.fromEntries((["lg", "md", "sm"] as const).map((s) => [s, `🕹 方向パッドの大きさ：${SZJP[s]}（大→中→小）`])),
  "dpad-autorun": { "true": "🕹 長押しで連続移動：オン → オフ", "false": "🕹 長押しで連続移動：オフ → オン" },
  "lunge-button": { "true": "🥾 踏み込みボタン表示：オン → オフ", "false": "🥾 踏み込みボタン表示：オフ → オン" },
  "guard-button": { "true": "🛡 受け流しボタン表示（剣）：オン → オフ", "false": "🛡 受け流しボタン表示（剣）：オフ → オン" },
  "log-size": Object.fromEntries((["sm", "md", "lg"] as const).map((s) => [s, `🔤 文字サイズ：${SZJP[s]}（小→中→大）`])),
};

// ---- 転記の機械照合（基準 commit の実ソースに全文字列が在ることを確認） -------
function legacySource(): string {
  return execFileSync("git", ["show", `${BASE_COMMIT}:proto/src/web/main.ts`], {
    encoding: "utf8", maxBuffer: 64 * 1024 * 1024,
  });
}

/** テンプレ由来のラベルは legacy ソースに完全一致では現れないので、可変部を除いた断片で照合する。 */
function fragmentsOf(label: string): string[] {
  // 「：<可変>（…）」の可変部だけを外し、前後の固定断片で照合する。
  const m = label.match(/^(.*：)(.*?)(（.*）)$/);
  if (m) return [m[1], m[3]];
  return [label];
}

function verifyTranscription(src: string): string[] {
  const problems: string[] = [];
  const check = (label: string, where: string) => {
    for (const frag of fragmentsOf(label)) {
      if (!src.includes(frag)) problems.push(`${where}: 基準ソースに見つからない断片 ${JSON.stringify(frag)}（ラベル ${JSON.stringify(label)}）`);
    }
  };
  for (const [id, label] of Object.entries(LEGACY_FIXED)) check(label, `fixed/${id}`);
  for (const [id, map] of Object.entries(LEGACY_VARIABLE)) for (const [k, label] of Object.entries(map)) check(label, `variable/${id}/${k}`);
  for (const [id, h] of Object.entries(LEGACY_HEADERS)) if (!src.includes(`"${h}"`)) problems.push(`header/${id}: 基準ソースに見出し ${JSON.stringify(h)} が無い`);
  // 件数・被覆
  const covered = new Set([...Object.keys(LEGACY_FIXED), ...Object.keys(LEGACY_VARIABLE)]);
  for (const id of LEGACY_ORDER) if (!covered.has(id)) problems.push(`order/${id}: fixed にも variable にも無い`);
  if (LEGACY_ORDER.length !== 17) problems.push(`order の件数が 17 でない（${LEGACY_ORDER.length}）`);
  return problems;
}

// ---- 出力 -------------------------------------------------------------------
const force = process.argv.includes("--force");
if (existsSync(OUT) && !force) {
  console.error(`[gen-settings-oracle] 既存の凍結 oracle があるため中止（意図的な再生成のみ --force）: ${OUT}`);
  console.error("  ※ 凍結 oracle は挙動不変の基準点。再生成すると実装と期待値が同時に動き検査が無意味になる。");
  process.exit(1);
}

const src = legacySource();
const problems = verifyTranscription(src);
if (problems.length) {
  console.error("[gen-settings-oracle] 転記の照合に失敗（基準 commit のソースと不一致）:");
  for (const p of problems) console.error("  - " + p);
  process.exit(1);
}

const oracle = {
  "//": [
    "設定シートの凍結 oracle（U1a）。挙動不変の基準点。**通常は更新禁止**。",
    "由来 = 基準 commit の legacy settingsSheet から採取した独立期待値であり、",
    "refactor 後の buildSettingLabels()/SETTING_DEFS を入力にしていない。",
    "検査（tools/settings-parity.ts）はこのデータを読むだけで、再生成しない。",
  ],
  version: 1,
  baseCommit: BASE_COMMIT,
  baseAppVersion: "0.166.0",
  source: "legacy settingsSheet（proto/src/web/main.ts）",
  order: LEGACY_ORDER,
  headers: LEGACY_HEADERS,
  fixedLabels: LEGACY_FIXED,
  variableLabels: LEGACY_VARIABLE,
};

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify(oracle, null, 2) + "\n", "utf8");
const nLabels = Object.keys(LEGACY_FIXED).length + Object.values(LEGACY_VARIABLE).reduce((a, m) => a + Object.keys(m).length, 0);
console.log(`[gen-settings-oracle] 書き出し: ${OUT}`);
console.log(`  基準 commit=${BASE_COMMIT.slice(0, 7)} / 項目 ${LEGACY_ORDER.length} / ラベル文字列 ${nLabels}（固定 ${Object.keys(LEGACY_FIXED).length}＋可変 ${nLabels - Object.keys(LEGACY_FIXED).length}）`);
console.log("  転記の照合 OK（全断片が基準ソースに実在）");

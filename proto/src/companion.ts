// 同行（相棒）の契約・金属等級ロジック（4-14C / 4-4E）。
// ブラウザセーフ＝DOM/fs 非依存・純粋関数のみ。Web（main.ts）とテスト（companion-check.ts）が共有し、
// 式のドリフト（再実装ズレ）を防ぐ。orchestration（world/log/盤上への反映）は main.ts 側に残す。

import type { World } from "./types.ts"; // 型のみ＝ブラウザセーフ（実績スコアの引き出しに使用）

/** 金属6等級ラベル。index 0..4=生者の段／5=ミスリル（秘銀）。プレイヤーは生きて至る特別路あり（4-4E 改訂）。 */
export const GRADE_LABELS = [
  "アイアン（新参）", "ブロンズ（駆け出し）", "シルバー（一人前）",
  "ゴールド（精鋭）", "プラチナ（英傑）", "ミスリル（秘銀・神話）",
] as const;
export const LIVING_GRADE_CAP = 4; // 相棒/NPCはプラチナ止まり（companionGradeFor 用）。プレイヤーのみミスリルへ至れる。

// プレイヤー等級＝レベルと実績の両ゲート（4-4E 改訂・2026-06-23 ユーザー承認）。
// 旧「レベル帯のみ・Lv12でプラチナ飽和」を廃し Lv50 スケールへ再配分＋実績ゲートを足す＝
// 「精鋭/英傑」がレベルだけでなく偉業の証になる。ミスリル(5)は生者の特別路＝クリア後限定（厳しめ）。
export const PLAYER_LV_GATE  = [1, 7, 16, 28, 42, 50]; // 各段の最低レベル（鉄/銅/銀/金/白金/秘銀）
export const PLAYER_ACH_GATE = [0, 0, 2, 5, 10, 20];   // 各段の最低実績スコア
export const MITHRIL_GRADE = 5;

/** 実績スコア＝達成依頼 + 印×2 + 伝説×2 + クリア×4（いずれも World 蓄積＝世代越え）。 */
export function playerAchievement(questsDone: number, seals: number, legends: number, ascended: number): number {
  return questsDone + seals * 2 + legends * 2 + ascended * 4;
}
/** プレイヤー等級（0..5）＝レベルゲートと実績ゲートの両方を満たす最高段。
 *  ミスリルはさらにクリア後（ascended≥1）限定＝生きて至る稀有な頂点（adventurers.md M4 の生存ミスリルに並ぶ）。 */
export function playerGrade(level: number, ach: number, ascended: number): number {
  let g = 0;
  for (let k = 1; k <= MITHRIL_GRADE; k++) {
    if (level < PLAYER_LV_GATE[k] || ach < PLAYER_ACH_GATE[k]) break;
    if (k === MITHRIL_GRADE && ascended < 1) break; // 生存ミスリルはクリア後のみ（厳しめ）
    g = k;
  }
  return g;
}
/** World から実績スコアを引く（main.ts / actors.ts / world.ts 共有）。 */
export function worldAchievement(world: World): number {
  const legends = (world.tracked ?? []).filter((t) => t.source === "player_legend").length;
  return playerAchievement(world.questsDone ?? 0, (world.seals ?? []).length, legends, world.ascended ?? 0);
}
/** World＋現在レベルからプレイヤー等級を引く薄いラッパ。 */
export function worldPlayerGrade(world: World, level: number): number {
  return playerGrade(level, worldAchievement(world), world.ascended ?? 0);
}
/** 等級index→ラベル（範囲外は鉄）。 */
export const rankLabel = (grade: number): string => GRADE_LABELS[grade] ?? GRADE_LABELS[0];

// 相棒の昇格ゲート（4-4E「生存と偉業で1段ずつ」）。段kへ上がるには bond（生還の蓄積）と
// feats（偉業＝ボス撃破/山場決着）の両方が要る＝滅多に上がらない。
// 通算：ブロンズ 生還3+偉業1／シルバー 7+2／ゴールド 12+4／プラチナ 18+6（プラチナ＝生者上限）。
export const COMP_SURVIVAL_GATE = [0, 3, 7, 12, 18];
export const COMP_FEAT_GATE = [0, 1, 2, 4, 6];
/** bond（生還）と feats（偉業）の両ゲートで段を決める。現在等級（＝設定由来の初期）は下回らない。順に開く。 */
export function companionGradeFor(bond: number, feats: number, currentGrade: number): number {
  let g = currentGrade;
  for (let k = currentGrade + 1; k <= LIVING_GRADE_CAP; k++) {
    if (bond >= COMP_SURVIVAL_GATE[k] && feats >= COMP_FEAT_GATE[k]) g = k;
    else break; // 下の段の条件を満たさなければ上は開かない
  }
  return g;
}

// 雇用（契約・4-14C）。前金は等級で変動。
export const HIRE_FEE_BASE = 12; // 前金の基礎。実額＝HIRE_FEE_BASE×(等級+1)＋レベル係数（深部の金経済に追従）。
export const hireFee = (grade: number, level = 0): number => HIRE_FEE_BASE * (grade + 1) + level * 4;
/** 雇用時の実効等級＝設定等級と蓄積等級（再雇用の昇格）の高い方。生者はプラチナ止まり。 */
export const effectiveHireGrade = (actorGrade: number | undefined, storedGrade: number | undefined): number =>
  Math.min(LIVING_GRADE_CAP, Math.max(actorGrade ?? 0, storedGrade ?? 0));
/** 同行中の金貨折半：相棒の取り分（金貨のみ・50%）。負/0 は 0。 */
export const companionCut = (amount: number): number => (amount > 0 ? Math.floor(amount / 2) : 0);

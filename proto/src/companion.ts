// 同行（相棒）の契約・金属等級ロジック（4-14C / 4-4E）。
// ブラウザセーフ＝DOM/fs 非依存・純粋関数のみ。Web（main.ts）とテスト（companion-check.ts）が共有し、
// 式のドリフト（再実装ズレ）を防ぐ。orchestration（world/log/盤上への反映）は main.ts 側に残す。

/** 金属6等級ラベル。index 0..4=生者の段／5=ミスリル（秘銀・死後の称号）。プレイヤー・相棒で共有。 */
export const GRADE_LABELS = [
  "アイアン（新参）", "ブロンズ（駆け出し）", "シルバー（一人前）",
  "ゴールド（精鋭）", "プラチナ（英傑）", "ミスリル（秘銀・神話）",
] as const;
export const LIVING_GRADE_CAP = 4; // 生者はプラチナ止まり。ミスリルは死後＝legendApprove で授かる。

/** プレイヤーのレベル帯→金属index（4-4 ギルド・4-4E）。 */
export function levelGrade(level: number): number {
  if (level >= 12) return 4;
  if (level >= 8) return 3;
  if (level >= 5) return 2;
  if (level >= 3) return 1;
  return 0;
}
export const rankLabel = (level: number): string => GRADE_LABELS[levelGrade(level)];

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
export const HIRE_FEE_BASE = 12; // 前金の基礎。実額＝HIRE_FEE_BASE×(等級+1)＝アイアン12…プラチナ60。
export const hireFee = (grade: number): number => HIRE_FEE_BASE * (grade + 1);
/** 雇用時の実効等級＝設定等級と蓄積等級（再雇用の昇格）の高い方。生者はプラチナ止まり。 */
export const effectiveHireGrade = (actorGrade: number | undefined, storedGrade: number | undefined): number =>
  Math.min(LIVING_GRADE_CAP, Math.max(actorGrade ?? 0, storedGrade ?? 0));
/** 同行中の金貨折半：相棒の取り分（金貨のみ・50%）。負/0 は 0。 */
export const companionCut = (amount: number): number => (amount > 0 ? Math.floor(amount / 2) : 0);

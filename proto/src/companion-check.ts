// 同行（契約・金属等級 4-14C/4-4E）の純粋ロジックの決定論テスト。
// 実行：node --experimental-strip-types src/companion-check.ts
import {
  GRADE_LABELS, LIVING_GRADE_CAP, playerGrade, playerAchievement, rankLabel, companionGradeFor,
  hireFee, effectiveHireGrade, companionCut,
} from "./companion.ts";
import { companionMaxHp, companionDmg } from "./dungeon.ts";

let pass = 0, fail = 0;
function eq(label: string, got: unknown, want: unknown) {
  if (JSON.stringify(got) === JSON.stringify(want)) { pass++; }
  else { fail++; console.log(`  ❌ ${label}: got=${JSON.stringify(got)} want=${JSON.stringify(want)}`); }
}

console.log("== プレイヤー等級（レベル×実績の両ゲート・4-4E 改訂） ==");
eq("ラベル6段", GRADE_LABELS.length, 6);
eq("LIVING_CAP", LIVING_GRADE_CAP, 4);
eq("rankLabel index", rankLabel(3), "ゴールド（精鋭）");
// 実績スコア＝依頼 + 印×2 + 伝説×2 + クリア×4
eq("実績スコア", playerAchievement(3, 5, 1, 1), 3 + 10 + 2 + 4);
// 両ゲート：レベルだけでは精鋭になれない（実績ゲートで止まる）
eq("Lv50実績0→ブロンズ止まり", playerGrade(50, 0, 0), 1);
eq("Lv9実績2→ブロンズ(銀はLv16要)", playerGrade(9, 2, 0), 1);
eq("Lv16実績2→シルバー", playerGrade(16, 2, 0), 2);
eq("Lv28実績5→ゴールド", playerGrade(28, 5, 0), 3);
eq("Lv42実績10→プラチナ", playerGrade(42, 10, 0), 4);
eq("Lv50実績20クリア前→プラチナ止まり", playerGrade(50, 20, 0), 4);
eq("Lv50実績20クリア後→ミスリル", playerGrade(50, 20, 1), 5);
eq("Lv49実績20クリア後→プラチナ(Lv不足)", playerGrade(49, 20, 1), 4);

console.log("== 昇格の両ゲート（生存+偉業） ==");
eq("初期0", companionGradeFor(0, 0, 0), 0);
eq("生還足るが偉業不足→据置", companionGradeFor(3, 0, 0), 0);
eq("生還3+偉業1→ブロンズ", companionGradeFor(3, 1, 0), 1);
eq("生還7+偉業1→偉業不足でブロンズ止まり", companionGradeFor(7, 1, 0), 1);
eq("生還7+偉業2→シルバー", companionGradeFor(7, 2, 0), 2);
eq("生還12+偉業4→ゴールド", companionGradeFor(12, 4, 0), 3);
eq("生還18+偉業6→プラチナ", companionGradeFor(18, 6, 0), 4);
eq("プラチナ超えはCAP", companionGradeFor(99, 99, 4), 4);
eq("途中で偉業詰まり(12,2)→シルバー止まり", companionGradeFor(12, 2, 0), 2);
eq("初期等級は下回らない", companionGradeFor(0, 0, 3), 3);
eq("ゴールド開始+条件満たし→プラチナ", companionGradeFor(18, 6, 3), 4);

console.log("== 雇用（前金 / 実効等級 / 折半） ==");
eq("前金 等級別", [0, 1, 2, 3, 4].map(hireFee), [12, 24, 36, 48, 60]);
eq("実効等級=設定と蓄積の高い方", effectiveHireGrade(0, 3), 3);
eq("実効等級 蓄積なし", effectiveHireGrade(2, undefined), 2);
eq("実効等級 CAP", effectiveHireGrade(4, 5), 4);
eq("実効等級 未設定", effectiveHireGrade(undefined, undefined), 0);
eq("折半45→22", companionCut(45), 22);
eq("折半1→0", companionCut(1), 0);
eq("折半0→0", companionCut(0), 0);
eq("折半負→0", companionCut(-5), 0);
eq("折半100→50", companionCut(100), 50);

console.log("== 相棒の強さスケール（4-4E） ==");
eq("HP 等級別", [0, 1, 2, 3, 4].map(companionMaxHp), [10, 13, 16, 19, 22]);
eq("攻撃 等級別", [0, 1, 2, 3, 4].map(companionDmg), [2, 3, 4, 5, 6]);

// --- 契約シナリオ（再雇用で昇格が継続するか＝生者NPC蓄積の意味づけ） ---
console.log("== 契約シナリオ：雇用→生還で昇格→解散→再雇用で再開 ==");
{
  // 生者NPCの蓄積記録（main.ts の world.actors 記録の純粋モデル）
  let rec = { grade: 0, bond: 0, feats: 0 }; // アイアンの新人を初雇用
  // 何度か潜って生還＋偉業（ボス撃破）を積む
  const survivals = [
    { bond: 1, feat: 0 }, { bond: 1, feat: 1 }, { bond: 1, feat: 0 }, // 生還3・偉業1 → ブロンズ
    { bond: 1, feat: 1 }, { bond: 1, feat: 0 }, { bond: 1, feat: 0 }, { bond: 1, feat: 0 }, // 生還7・偉業2 → シルバー
  ];
  for (const s of survivals) {
    rec.bond += s.bond; rec.feats += s.feat;
    rec.grade = companionGradeFor(rec.bond, rec.feats, rec.grade); // 昇格判定
  }
  eq("7生還2偉業でシルバーに昇格", rec.grade, 2);
  // 解散→生者NPCに rec が残る。再雇用時の実効等級＝蓄積を再開
  const actorConfigGrade = 0; // 設定は新人だったが…
  const reGrade = effectiveHireGrade(actorConfigGrade, rec.grade);
  eq("再雇用で蓄積等級から再開（シルバー）", reGrade, 2);
  eq("再雇用の前金は等級ぶん上がる", hireFee(reGrade), 36);
}

console.log(`\n=== companion-check: ${pass} pass / ${fail} fail ===`);
if (fail > 0) process.exit(1);

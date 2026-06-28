// バランス実数レポート（デスクトップQA・A）。実行: node --experimental-strip-types tools/balance-report.ts
//   sim-combat（深度別HPコスト%）を補う第三の視点＝v0.63.x で入った新係数の「実数」を表に：
//   ①abyssalScale(D50超)の効き ②難易度3モードの実数差 ③統治者の大命(noble)報酬分布。
//   純エンジンの公開式を直接評価（決定論・副作用なし）。
import { scaleKind, abyssalScale, regularHpAt, depthDmgBonus, MONSTER_KINDS } from "../src/dungeon.ts";
import { DIFFICULTY, diffMods, type Difficulty } from "../src/difficulty.ts";

const pad = (s: any, n: number) => String(s).padEnd(n);
const padN = (s: any, n: number) => String(s).padStart(n);

// 代表種＝tier 中位の素のモンスター（深度係数は scaleKind が乗せる）。
const REP = MONSTER_KINDS.reduce((a, b) => (Math.abs(b.tier - 3) < Math.abs(a.tier - 3) ? b : a));
// エリアボス公開式（makeAreaBoss と同値・world 非依存部分）。
const bossHp = (d: number, m = DIFFICULTY.easy) => Math.round((regularHpAt(d) * 4 + 20) * m.enemyHp * abyssalScale(d));
const bossDmg = (d: number, m = DIFFICULTY.easy) => Math.round((5 + depthDmgBonus(d)) * m.enemyDmg * abyssalScale(d)) + m.dmgFloor;

console.log("═══════════════════════════════════════════════════════════════");
console.log(" バランス実数レポート（v0.63.x）  代表種=" + REP.name + " tier" + REP.tier);
console.log("═══════════════════════════════════════════════════════════════\n");

// ───────── ① abyssalScale（D50超の難易度逓増・ABYSSAL_K=0.05）─────────
console.log("【①】abyssalScale（深度50超の難化カーブ）  easy基準");
console.log("  depth | ×scale | 雑魚HP/dmg | ボスHP/dmg | ボスHP比(対D48)");
const bossRef48 = bossHp(48);
for (const d of [42, 48, 50, 55, 60, 64, 70, 80]) {
  const k = scaleKind(REP, d);
  const mark = d > 50 ? "←深淵帯" : "";
  console.log(
    `  ${padN(d, 4)}  | ${abyssalScale(d).toFixed(2)}   | ${padN(k.hp, 4)}/${padN(k.dmg, 3)}   | ${padN(bossHp(d), 5)}/${padN(bossDmg(d), 3)}  | ×${(bossHp(d) / bossRef48).toFixed(2)} ${mark}`,
  );
}
console.log("  ※ depth≤50 は ×1.00 厳密不変（golden 安全）。大命の slay 目標 D56/64・descend D52-58。\n");

// ───────── ② 難易度3モードの実数差 ─────────
console.log("【②】難易度3モードの実数差（同一深度の同一種・ボス）");
const modes: Difficulty[] = ["easy", "normal", "hard"];
for (const d of [1, 10, 25, 40, 50]) {
  console.log(`  -- 深度 ${d} --`);
  console.log("     mode   | 雑魚HP/dmg | ボスHP/dmg | exposure×/xp×/townHeal");
  for (const md of modes) {
    const m = DIFFICULTY[md];
    const k = scaleKind(REP, d, m);
    console.log(
      `     ${pad(md, 6)} | ${padN(k.hp, 4)}/${padN(k.dmg, 3)}   | ${padN(bossHp(d, m), 5)}/${padN(bossDmg(d, m), 3)}  | ×${m.exposure}/×${m.xp}/${m.townHeal}`,
    );
  }
}
console.log("  ※ normal=HP×1.25 dmg×1.25+床1／hard=HP×1.5 dmg×1.4+床2。dmgFloor が序盤(深度1)から噛む。\n");

// ───────── ③ 統治者の大命（noble）報酬分布 ─────────
const CAP = 1500; // v0.63.4 是正（旧700）
const cap = (g: number) => Math.min(CAP, Math.round(g));
console.log("【③】統治者の大命 報酬（NOBLE_REWARD_CAP=" + CAP + "・式の直接評価・難度順 slay>reclaim>descend）");
console.log("  kind     | 目標深度 | 素の報酬 | 実報酬(cap) | 上限張付");
const rows: [string, number, number][] = [
  ["slay", 56, 56 * 22],        // 最難（ボス撃破）
  ["slay", 64, 64 * 22],
  ["reclaim", 38, (38 * 8 + 20) * 2.4], // 中（化石回収）
  ["reclaim", 50, (50 * 8 + 20) * 2.4],
  ["descend", 52, 52 * 12],     // 保険（到達のみ）
  ["descend", 58, 58 * 12],
];
let capped = 0;
for (const [kind, d, raw] of rows) {
  const real = cap(raw);
  const hit = real >= CAP;
  if (hit) capped++;
  console.log(`  ${pad(kind, 8)} | ${padN(d, 6)}   | ${padN(Math.round(raw), 6)}   | ${padN(real, 7)}     | ${hit ? "★YES" : "no"}`);
}
console.log(`  → 上限張付 ${capped}/${rows.length}。難度順（slay 1232-1408 > reclaim 778-1008 > descend 624-696）で金貨が難度差を反映。`);
console.log("  ※ 加えて relic 33%（鑑定済+3遺物＋称号）＋questsDone+=2。\n");

console.log("═══════════════════════════════════════════════════════════════");
console.log(" 調整ノブ：ABYSSAL_K(0.05) / DIFFICULTY係数 / NOBLE_REWARD_CAP(1500)・slay×22・reclaim×2.4・descend×12 / relic率0.33");
console.log("═══════════════════════════════════════════════════════════════");

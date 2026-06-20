// 深蝕 exposure 系統の追加検証（v2 リワーク・純算術）。実行: node --experimental-strip-types tools/sim-exposure.ts
// PR #119 で異物drip／聖遺物drip は是正済み。本simは残る観点を評価：
//   ①術使用の累積（heart係数）②牙(fang)曲線 ③回復ノードの相殺力 ④3源の合算ダイブ収支。
import { SPELLS } from "../src/spells.ts";
import type { Character } from "../src/types.ts";

// --- main.ts と同じ定数（手写し・乖離検知用にコメントで出典） ---
const CORRUPTION_DRAIN_FROM = 1.5;   // 牙の発動閾値
const CORRUPTION_DRAIN_STEP = 2.0;   // +この深度ごとに bite +1
const CORRUPTION_DRAIN_CAP = 2;      // 毎手 bite 上限
const REST_CLEANSE = 0.8;            // 安息所：exposure -0.8（一度きり）
const SPRING_HEAL_FRAC = 0.6;        // 回復の泉：maxHP×0.6
const RELIC_EXPOSURE_PER_TURN = 0.015; // PR #119 後（旧0.03）
const ODDITY_DESCENT_MULT = 10;      // 異物：降下ごと equipExposure×10×heart
const CLEANSE_SPELL = -0.6;          // 解呪術 cleanse

// heartFactor（progression.ts と同式）。遺物 calm は無視（base）。
const heartFactor = (heart: number) => Math.max(0.3, 1 - (heart - 2) * 0.12);
// 牙の毎手ダメージ
const fang = (exp: number) =>
  exp < CORRUPTION_DRAIN_FROM ? 0 : Math.min(CORRUPTION_DRAIN_CAP, 1 + Math.floor((exp - CORRUPTION_DRAIN_FROM) / CORRUPTION_DRAIN_STEP));

console.log("=== heartFactor（深蝕の染み込み係数・全源に乗る）===");
console.log("heart |", [1,2,3,4,5,6,8,10,16].map(h=>`h${h}`).join("  "));
console.log("係数  |", [1,2,3,4,5,6,8,10,16].map(h=>heartFactor(h).toFixed(2)).join("  "));
console.log("※heart8 で下限0.3に到達＝それ以上の心投資は深蝕軽減に無効（HP/他に回る）。");

console.log("\n=== ① 術使用の累積：牙(1.5)に達するまでの詠唱回数（解呪・安息所なしの素の天井）===");
console.log("術コスト帯ごとに『連続詠唱で1.5に届く手数』を心別に。低コスト識術(0.06)〜断罪(0.50)。");
console.log("cost  | h2    h4    h6    h8(下限)");
for (const cost of [0.06, 0.12, 0.15, 0.20, 0.30, 0.40, 0.50]) {
  const row = [2,4,6,8].map(h => Math.ceil(CORRUPTION_DRAIN_FROM / (cost * heartFactor(h))));
  console.log(`${cost.toFixed(2)}  | ${row.map(n=>String(n).padStart(4)).join("  ")}`);
}
console.log("※『何もせず素で1.5』ではなく『術を連打した場合のみ』牙が立つ＝術は資源、乱用に圧。");

console.log("\n=== ② 牙(fang)曲線：exposure → 毎手HPドレイン（死の螺旋の有無）===");
console.log("exp  |", [1.4,1.5,2.0,3.5,3.6,5.0,8.0,20].map(e=>e.toFixed(1)).join("  "));
console.log("bite |", [1.4,1.5,2.0,3.5,3.6,5.0,8.0,20].map(e=>String(fang(e)).padStart(3)).join("    "));
console.log("※上限2/手で頭打ち＝青天井の即死スパイラル無し。1.5で噛み始め3.6で最大。");

console.log("\n=== ③ 回復ノードの相殺力（術コスト換算）===");
console.log(`安息所 -${REST_CLEANSE}/泉 maxHP×${SPRING_HEAL_FRAC}。安息所は術 cost 何発ぶんを帳消しにするか（heart別）。`);
console.log("       | h2     h4     h6     h8");
for (const cost of [0.15, 0.20, 0.30]) {
  const row = [2,4,6,8].map(h => (REST_CLEANSE / (cost * heartFactor(h))).toFixed(1));
  console.log(`cost${cost.toFixed(2)}| ${row.map(s=>s.padStart(5)).join("  ")} 発`);
}

console.log("\n=== ④ 合算ダイブ収支：10階潜行・各階で術5発＋探索100手（聖遺物なし）===");
console.log("『標準的な攻略者』が10階潜るときの深蝕到達点。異物の有無で対比。心別。");
console.log("構成: 各階 中コスト術0.20×5発＝詠唱累積／異物=両方(equipExp 0.05)で降下9回課金／安息所は5階に1回。");
function diveSim(heart: number, oddity: boolean) {
  const hf = heartFactor(heart);
  let exp = 0, totalBite = 0;
  const equipExp = oddity ? 0.05 : 0;
  for (let fl = 1; fl <= 10; fl++) {
    // 各階：術5発
    for (let s = 0; s < 5; s++) exp += 0.20 * hf;
    // 探索100手：受動累積ゼロ（v2）。ただし exp>=1.5 なら毎手 fang。
    for (let t = 0; t < 100; t++) { const b = fang(exp); totalBite += b; }
    // 5階で安息所1回
    if (fl === 5) exp = Math.max(0, exp - REST_CLEANSE);
    // 降下課金（次階へ・10階目はしない）
    if (fl < 10) exp += equipExp * ODDITY_DESCENT_MULT * hf;
  }
  return { exp, totalBite };
}
console.log("heart | 異物なし: 最終exp / 牙総ダメ | 異物あり: 最終exp / 牙総ダメ");
for (const h of [2,4,6,8]) {
  const a = diveSim(h, false), b = diveSim(h, true);
  console.log(`h${String(h).padStart(2)}   |   ${a.exp.toFixed(2)} / ${a.totalBite}              |   ${b.exp.toFixed(2)} / ${b.totalBite}`);
}
console.log("※牙総ダメが探索100手×階で累積＝高expを放置して探索すると牙で削られ続ける（安息所/解呪/帰還を促す）。");

console.log("\n=== 参考：spells.ts コスト分布（源①の実体）===");
const byCost: Record<string, number> = {};
for (const s of SPELLS) { const k = s.cost.toFixed(2); byCost[k] = (byCost[k]||0)+1; }
console.log("cost別 術数:", Object.entries(byCost).sort().map(([c,n])=>`${c}:${n}`).join("  "));
console.log(`総術数 ${SPELLS.length}・最安 ${Math.min(...SPELLS.map(s=>s.cost))}・最高 ${Math.max(...SPELLS.map(s=>s.cost))}`);

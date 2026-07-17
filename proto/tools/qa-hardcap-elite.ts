// バグ1（elite スポーンの hardcap 未チェック）の受入検証（デスクトップ Claude Code 用）。
// 狙い＝genFloor を深部×難易度×多シードで生成し、floor.monsters.length <= monsterHardcap(depth, mods) を全件 assert する。
//
// ★重要な検証結果（2026-07-17）：修正は elite 分岐（depth>=5 かつ depth%8!==0 の非ボス階）の hardcap 超過は解消したが、
//   報告された具体例「depth80×easy で 61>60」自体は再現し続ける。原因は elite ではなく、
//   depth%8===0（エリアボス階）の「エリアボス push」（src/dungeon.ts 内 `boss: "area"` の push）が
//   hardcap 未チェックのまま残っているため。depth>=68（easy の countCap が hardcap(60) に到達する帯）かつ
//   depth%8===0（72/80/88/96…）で、主配置ループが countCap=60 まで敵を詰めた直後にボスが無条件で+1 され 61>60 になる
//   （100/100 seed で再現＝決定論的・rng 依存ではない）。normal/hard は countCap の上限(60)が hardcap(最大80)を
//   下回るため発生しない＝easy 限定の現象。
//   ⇒ 本スクリプトは①elite 分岐単体（depth%8!==0）の受入と②全深度（ボス階含む）の受入を分けて報告する。
//   ②は現状 FAIL のまま＝タスク説明の「バグ1修正」は不完全（ゲーム本体の追加修正が必要＝本セッションでは対象外＝報告のみ）。
// 実行: node --experimental-strip-types tools/qa-hardcap-elite.ts
import { genFloor, monsterHardcap, type Floor } from "../src/dungeon.ts";
import { diffMods, SELECTABLE_DIFFICULTIES } from "../src/difficulty.ts";
import { newWorld } from "../src/world.ts";

let CHECKS = 0, FAIL = 0;
let eliteChecks = 0, eliteFail = 0;
let allChecks = 0, allFail = 0;
const eliteProblems: string[] = [];
const allProblems: string[] = [];

const REQUIRED_DEPTHS = [60, 68, 80]; // タスク指定
const EXTRA_DEPTHS = [40, 50, 55, 61, 62, 63, 65, 69, 72, 88, 90, 96, 100]; // 境界探索（72/88/96=depth%8==0 の追加ケース含む）
const DEPTHS = [...new Set([...REQUIRED_DEPTHS, ...EXTRA_DEPTHS])];
const SEEDS = 150;

for (const diff of SELECTABLE_DIFFICULTIES) {
  const mods = diffMods(diff);
  for (const depth of DEPTHS) {
    const cap = monsterHardcap(depth, mods);
    let eliteSeenThisDepth = 0;
    for (let seed = 1; seed <= SEEDS; seed++) {
      const w = newWorld(seed * 97 + depth * 13 + 3);
      w.difficulty = diff;
      let f: Floor;
      try {
        f = genFloor(w, depth);
      } catch (e: any) {
        allFail++; allChecks++;
        allProblems.push(`genFloor throw diff=${diff} depth=${depth} seed=${seed}: ${e?.message}`);
        continue;
      }
      const n = f.monsters.length;
      const within = n <= cap;
      const isBossFloor = depth >= 8 && depth % 8 === 0;
      const hasElite = f.monsters.some((m) => m.boss === "elite");
      if (hasElite) eliteSeenThisDepth++;

      // ①全深度（ボス階含む）＝タスク要求どおりの全件チェック
      allChecks++;
      if (!within) { allFail++; if (allProblems.length < 40) allProblems.push(`[ALL] monsters(${n}) > hardcap(${cap}) diff=${diff} depth=${depth} seed=${seed} bossFloor=${isBossFloor} elite=${hasElite} boss=${f.monsters.some(m=>m.boss==="area")}`); }

      // ②elite 分岐単体＝ボス階（depth%8===0）を除外した非ボス深度のみで elite 修正の有効性を検証
      if (!isBossFloor) {
        eliteChecks++;
        if (!within) { eliteFail++; if (eliteProblems.length < 40) eliteProblems.push(`[ELITE-ONLY] monsters(${n}) > hardcap(${cap}) diff=${diff} depth=${depth} seed=${seed} elite=${hasElite}`); }
      }
    }
  }
}

CHECKS = allChecks; FAIL = allFail;

console.log(`== qa-hardcap-elite ==`);
console.log(`①elite分岐単体（非ボス階のみ）: checks=${eliteChecks} fail=${eliteFail}`);
if (eliteFail) console.log(eliteProblems.join("\n"));
console.log(eliteFail === 0 ? "  ✅ elite 分岐の hardcap 修正は有効（非ボス階で超過0）" : "  ❌ elite 分岐も超過あり");
console.log(`②全深度（ボス階含む・タスク要求の全件チェック）: checks=${allChecks} fail=${allFail}`);
if (allFail) console.log(allProblems.join("\n"));
console.log(allFail === 0 ? "  ✅ 全件 hardcap 以内" : "  ❌ 超過あり＝depth%8===0（エリアボス階）かつ easy かつ depth>=72 帯で area boss の無条件 push が原因（elite とは別経路・未修正）");

if (allFail > 0) process.exit(1);

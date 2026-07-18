// バグ1（hardcap 超過）の受入検証（デスクトップ Claude Code 用）。
// 狙い＝genFloor を深部×難易度×多シードで生成し、floor.monsters.length <= monsterHardcap(depth, mods) を全件 assert する。
//
// ★経緯と現況（2026-07-17 検出 → 同日 v0.155.0 #370 で完全修正済み）：当初の elite 分岐修正だけでは
//   depth%8===0（エリアボス階）の「必須ボス push」が hardcap 未チェックのまま残り「depth80×easy で 61>60」が再現していた
//   （本コメントの旧版が FAIL を報告していたのはこの時点の記録）。その後、本体 `src/dungeon.ts` に
//   **必須ボス枠の予約**（`count = min(…, countCap, monsterHardcap - bossSlots)`・bossSlots=エリアボス+深淵の主）が入り、
//   ①elite 分岐単体（depth%8!==0）・②全深度（ボス階含む）の**両方とも現在は PASS**（①4,950＋②7,200 checks／0 fail）。
//   本スクリプトはその回帰固定として①②を分けて報告する。軽量版は tools/hardcap-check.ts（npm run check 同梱）。
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

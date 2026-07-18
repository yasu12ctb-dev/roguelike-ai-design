// hardcap-check（軽量・npm run check 同梱・2026-07-18 外部レビュー統合＝v0.155.0 バグ修正 #370 の回帰固定）。
// 狙い＝「フロアの敵総数 ≤ monsterHardcap(depth,mods)」の不変条件を、超過が実際に起きた帯（深部・ボス階含む）に絞って毎回検査する。
//   - depth 24/40＝normal・hard のスケール値（64/80）の直接 assert 帯
//   - depth 72/77/80＝easy の countCap が hardcap(60) に達する帯＝旧バグ（ボス push 61>60）が再現していた帯（72/80 はボス階）
// 全深度×多シードの網羅は tools/qa-hardcap-elite.ts / qa-hardcap-scan.ts（手動）が担う＝ここは秒速の受理ゲート。
// 実行: node --experimental-strip-types tools/hardcap-check.ts
import { genFloor, monsterHardcap, MONSTER_HARDCAP } from "../src/dungeon.ts";
import { newWorld } from "../src/world.ts";
import { DIFFICULTY, EASY_MODS, type Difficulty } from "../src/difficulty.ts";

let checks = 0, fail = 0;
const ok = (cond: boolean, msg: string) => { checks++; if (!cond) { fail++; console.error(`  ❌ ${msg}`); } };

// 1) monsterHardcap の値そのもの（stress-engine checkHardcapValues と同旨の最小版）
ok(monsterHardcap(1, EASY_MODS) === MONSTER_HARDCAP, "easy d1=60");
ok(monsterHardcap(80, EASY_MODS) === MONSTER_HARDCAP, "easy d80=60（easy は常に60）");
ok(monsterHardcap(24, DIFFICULTY.normal) === 64, "normal d24=64");
ok(monsterHardcap(40, DIFFICULTY.hard) === 80, "hard d40=80");
ok(monsterHardcap(80, DIFFICULTY.normal) === 80, "normal d80=80（+20上限）");

// 2) genFloor 実生成の不変条件（超過が起きた帯に絞る＝軽量）
const DIFFS: Difficulty[] = ["easy", "normal", "hard"];
for (const diff of DIFFS) {
  for (const depth of [24, 40, 72, 77, 80]) {
    for (let s = 1; s <= 6; s++) {
      const w = newWorld((s * 7919 + depth) >>> 0);
      w.difficulty = diff;
      const f = genFloor(w, depth);
      const cap = monsterHardcap(depth, f.diff ?? EASY_MODS);
      ok(f.monsters.length <= cap, `monsters>${cap} (${f.monsters.length}) d${depth} ${diff} s${s}`);
      if (depth % 8 === 0) ok(f.monsters.some((m) => m.boss === "area"), `area boss 欠落 d${depth} ${diff} s${s}`);
    }
  }
}

console.log(`== hardcap-check：${checks} checks / ${fail} fail ==`);
if (fail > 0) process.exit(1);
console.log("  ✅ 敵総数は常に monsterHardcap 以内・ボス階の必須ボスは必ず配置（枠予約）");

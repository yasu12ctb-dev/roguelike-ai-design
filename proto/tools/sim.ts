// 終始シビア数値の純算術検証（ボット不要・式そのものを評価）。実行: node --experimental-strip-types tools/sim.ts
// 設計意図「Lv≈深度」を前提に、各深度で (1)1v1 交換比 (2)XP ペーシング (3)迷宮規模 を表化。
import { maxHp, meleeDmg, xpToNext, xpForKill, XP_KILL_MUL } from "../src/progression.ts";
import { regularHpAt, depthDmgBonus } from "../src/dungeon.ts";
import type { Character } from "../src/types.ts";

// レベルLの「均衡近接ビルド」キャラ（体/力を交互に投資・武器なし）。
function meleeChar(L: number, weaponDmg = 0): Character {
  const added = L - 1;
  const body = 2 + Math.ceil(added / 2);
  const power = 2 + Math.floor(added / 2);
  return {
    stats: { body, power, reason: 2, heart: 2 }, level: L,
    equipment: { weapon: weaponDmg ? { dmg: weaponDmg } : null, armor: null, relic: null, bag: null },
  } as unknown as Character;
}
const cumXp = (L: number) => { let s = 0; for (let l = 1; l < L; l++) s += xpToNext(l); return s; };

console.log("=== ① 1v1 交換比（Lv=深度・武器なし／+中級武器+3 を併記）===");
console.log("depth | maxHP atk(素/+3) | 雑魚HP 雑魚dmg | 殺すのに必要手数(素/+3) | 死ぬまでの被弾 | 交換比(素/+3)  ※比<1=1v1で先に死ぬ");
for (const d of [1, 3, 5, 8, 10, 15, 20, 25, 30, 40]) {
  const c0 = meleeChar(d, 0), c3 = meleeChar(d, 3);
  const hp = maxHp(c0);
  const atk0 = meleeDmg(c0), atk3 = meleeDmg(c3);
  const zhp = regularHpAt(d);
  const zdmg = 2 + depthDmgBonus(d); // tier中央=base2 と仮定（rat1/beetle1/snake2/ghoul2/wisp3/wraith3/ogre4）
  const k0 = Math.ceil(zhp / atk0), k3 = Math.ceil(zhp / atk3);
  const die = Math.ceil(hp / zdmg);
  const r0 = (die / k0), r3 = (die / k3);
  console.log(
    `D${String(d).padStart(2)}   | ${String(hp).padStart(3)}   ${String(atk0).padStart(2)}/${String(atk3).padStart(2)}      |`
    + ` ${String(zhp).padStart(3)}    ${String(zdmg).padStart(2)}      |`
    + ` ${String(k0).padStart(2)} / ${String(k3).padStart(2)} 手             |`
    + ` ${String(die).padStart(2)} 発         |`
    + ` ${r0.toFixed(2)} / ${r3.toFixed(2)}`);
}

console.log("\n=== ② XP ペーシング（Lv≈深度を維持できるか）===");
console.log(`XP_KILL_MUL=${XP_KILL_MUL}。kill XP=round(雑魚HP×${XP_KILL_MUL})。1レベル上げる必要kill数 vs その階の敵数。`);
console.log("depth | xpToNext(L) | kill XP | 1Lv上げる撃破数 | 階の敵数 | 余裕(敵数/必要撃破)  ※<1=1階全滅でも1Lv上がらない");
for (const d of [1, 3, 5, 8, 10, 15, 20, 25, 30, 40]) {
  const need = xpToNext(d);
  const kxp = xpForKill(regularHpAt(d));
  const killsPerLv = need / kxp;
  const W = 36 + Math.min(d, 50), H = 42 + Math.min(d, 50);
  const monCount = Math.min(Math.round((W * H) / 120) + Math.floor(d / 3), 42);
  const slack = monCount / killsPerLv;
  console.log(
    `D${String(d).padStart(2)}   | ${String(need).padStart(4)}        | ${String(kxp).padStart(3)}     |`
    + ` ${killsPerLv.toFixed(1).padStart(5)} 体        | ${String(monCount).padStart(3)} 体   | ${slack.toFixed(2)}`);
}

console.log("\n=== ③ 迷宮規模（探索量＝下り階段の見つけにくさ）===");
console.log("depth | 寸法 W×H | 床面積目安 | 部屋数 | 敵数 | 宝箱  ※1マス幅L字通路・全可視ではない");
for (const d of [1, 5, 10, 20, 30, 40, 50]) {
  const W = 36 + Math.min(d, 50), H = 42 + Math.min(d, 50);
  const rooms = Math.max(8, Math.round((W * H) / 72));
  const monCount = Math.min(Math.round((W * H) / 120) + Math.floor(d / 3), 42);
  const chest = Math.max(2, Math.round((W * H) / 1300)) + Math.min(d >> 4, 2);
  console.log(`D${String(d).padStart(2)}   | ${W}×${H}  | ${W * H} 区画 | ~${rooms}    | ${monCount}   | ~${chest}`);
}

console.log("\n=== 参考：レベルアップに必要な累積XP ===");
for (const L of [5, 10, 20, 30, 40, 50]) console.log(`Lv${L} まで累積 ${cumXp(L)} XP`);

import { genFloor, monsterHardcap } from "../src/dungeon.ts";
import { diffMods, SELECTABLE_DIFFICULTIES } from "../src/difficulty.ts";
import { newWorld } from "../src/world.ts";

for (const diff of SELECTABLE_DIFFICULTIES) {
  const mods = diffMods(diff);
  for (let depth = 50; depth <= 100; depth++) {
    const cap = monsterHardcap(depth, mods);
    let exceededCount = 0, eliteCount = 0, bossCount = 0, maxN = 0;
    for (let seed = 1; seed <= 60; seed++) {
      const w = newWorld(seed * 97 + depth * 13 + 3);
      w.difficulty = diff;
      const f = genFloor(w, depth);
      const n = f.monsters.length;
      if (n > maxN) maxN = n;
      if (n > cap) {
        exceededCount++;
        if (f.monsters.some((m) => m.boss === "elite")) eliteCount++;
        if (f.monsters.some((m) => m.boss === "area")) bossCount++;
      }
    }
    if (exceededCount > 0) {
      console.log(`diff=${diff} depth=${depth} cap=${cap} maxN=${maxN} exceeded=${exceededCount}/60 eliteInvolved=${eliteCount} bossInvolved=${bossCount} depth%8=${depth % 8}`);
    }
  }
}
console.log("scan done");

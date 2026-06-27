// F: 決定論プロパティ＋パリティ（デスクトップ Claude Code 用）。
// golden は代表 seed の単発フィンガープリント。本検査は「同 seed の操作を同一プロセスで二度走らせ byte 一致」を
// 多 seed で確認＝隠れたグローバル可変状態・Set/Map の反復順・オブジェクトキー順など、単発実行では露見しない
// 非決定論を炙り出す。Swift 完全再実装の核「同 seed→同結果」を広く保証する。
// 実行: node --experimental-strip-types tools/determinism.ts
import { makeRng } from "../src/rng.ts";
import { genFloor, planMonsters, resolveMonsters, mapIdx } from "../src/dungeon.ts";
import { newWorld, createCharacter, fossilizeCurrent, advanceArcs, intervene, recordRediscovery } from "../src/world.ts";
import { SELECTABLE_DIFFICULTIES } from "../src/difficulty.ts";
import type { World, Lineage } from "../src/types.ts";

let FAIL = 0, CHECKS = 0;
const problems: string[] = [];

// id 正規化：world.ts の newId は「プロセス・グローバルな idCounter」由来（seed 非依存）。
// 実プロセスでは毎回 counter=0 から始まり完全再現するが、同一プロセスで world を複数作ると id がずれる。
// よって「シードに由来する決定論」を正しく見るため、id パターン（prefix_base36）を出現順の安定キーへ
// 写像してから比較する（ジオメトリ/敵/hp/座標など seed 由来の値の差だけを検出する）。
function canon(obj: any): string {
  const map = new Map<string, string>();
  const ID = /^[a-z]+_[0-9a-z]+$/; // fossil_2 / tracked_3 / nemesis_fossil_5 など
  const walk = (v: any): any => {
    if (typeof v === "string") { if (ID.test(v)) { if (!map.has(v)) map.set(v, `#id${map.size}`); return map.get(v); } return v; }
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === "object") { const o: any = {}; for (const k of Object.keys(v)) o[k] = walk(v[k]); return o; }
    return v;
  };
  return JSON.stringify(walk(obj));
}
function eq(a: any, b: any, m: string) { CHECKS++; if (canon(a) !== canon(b)) { FAIL++; if (problems.length < 40) problems.push(m); } }

// 1. rng ストリーム：同 seed で同じ乱数列（mulberry32 一本）
for (let s = 1; s <= 200; s++) {
  const a = makeRng(s), b = makeRng(s);
  const sa: number[] = [], sb: number[] = [];
  for (let i = 0; i < 50; i++) { sa.push(a.next()); sb.push(b.int(1000)); }
  for (let i = 0; i < 50; i++) { sa.push(0); } // placeholder（型合わせ）
  const a2 = makeRng(s), b2 = makeRng(s);
  const x: number[] = [], y: number[] = [];
  for (let i = 0; i < 100; i++) { x.push(a2.next()); y.push(b2.next()); }
  eq(x, y, `rng s${s}: 同 seed で next() 列が一致しない`);
}

// 2. genFloor：同 (seed, depth, difficulty) で同じフロア（タイル/敵/宝箱/階段すべて）
for (let s = 1; s <= 60; s++) {
  for (const diff of SELECTABLE_DIFFICULTIES) {
    for (const depth of [1, 8, 16, 24, 40, 50]) {
      const w1 = newWorld(s * 11 + 1); w1.difficulty = diff;
      const w2 = newWorld(s * 11 + 1); w2.difficulty = diff;
      const f1 = genFloor(w1, depth), f2 = genFloor(w2, depth);
      eq(f1, f2, `genFloor s${s} d${depth} ${diff}: フロアが一致しない（非決定論）`);
    }
  }
}

// 3. 戦闘シーケンス：同 seed で planMonsters/resolveMonsters の結果が完全一致
function runCombat(seed: number, depth: number, diff: string) {
  const w = newWorld(seed); w.difficulty = diff as any;
  const f = genFloor(w, depth);
  const rng = makeRng(seed * 7 + depth);
  const player = { x: f.stairsUp.x, y: f.stairsUp.y };
  const trace: any[] = [];
  for (let t = 0; t < 40; t++) {
    planMonsters(f, player, rng, null, null);
    // プレイヤー＝最寄り敵へ一歩（決定論）
    let tm: any = null, td = 1e9;
    for (const m of f.monsters) { if (m.hp <= 0) continue; const d = Math.abs(m.x - player.x) + Math.abs(m.y - player.y); if (d < td) { td = d; tm = m; } }
    if (tm) { if (td <= 1) tm.hp -= 5; else { const nx = player.x + Math.sign(tm.x - player.x), ny = player.y + Math.sign(tm.y - player.y); if (f.tiles[mapIdx(f, nx, ny)] === 1) { player.x = nx; player.y = ny; } } }
    const res = resolveMonsters(f, player, null, null);
    trace.push({ t, mons: f.monsters.map((m) => ({ x: m.x, y: m.y, hp: m.hp })), hits: res.hits.map((h) => h.dmg), px: player.x, py: player.y });
  }
  return trace;
}
for (let s = 1; s <= 50; s++) {
  for (const diff of SELECTABLE_DIFFICULTIES) {
    const depth = [9, 24, 40][s % 3];
    eq(runCombat(s * 13 + 5, depth, diff), runCombat(s * 13 + 5, depth, diff), `combat s${s} d${depth} ${diff}: 戦闘トレースが一致しない`);
  }
}

// 4. 世界 lifecycle：同 seed で多世代の進行（化石化/弧/系譜/干渉）が完全一致
function runLife(seed: number, diff: string): World {
  const w = newWorld(seed); w.difficulty = diff as any;
  for (let gen = 0; gen < 15; gen++) {
    const anc = w.fossils.filter((f) => f.kind === "character").slice(-1)[0];
    const lin: Lineage = anc ? (gen % 2 ? { relation: "pupil", ancestorFossilId: anc.id } : { relation: "blood", ancestorFossilId: anc.id, chosenSpells: (anc.spells ?? []).slice(0, 2) }) : { relation: "none" };
    const ch = createCharacter(w, `世代${gen}`, "wanderer", lin);
    ch.depth = 5 + gen * 3; ch.exposure = (gen % 5) * 0.4;
    const prev = w.fossils.filter((f) => f.kind === "character").slice(-1)[0];
    if (prev) { recordRediscovery(w, prev.id); if (gen % 3 === 0) intervene(w, prev.id, "requiem"); }
    fossilizeCurrent(w, (["combat", "exposure", "fall", "mercy"] as const)[gen % 4] as any, { choice: (["accept", "guard_relic", "curse_dungeon", "leave_will"] as const)[gen % 4] } as any);
    advanceArcs(w);
  }
  return w;
}
for (let s = 1; s <= 40; s++) {
  for (const diff of SELECTABLE_DIFFICULTIES) {
    eq(runLife(s * 17 + 3, diff), runLife(s * 17 + 3, diff), `lifecycle s${s} ${diff}: 多世代の世界状態が一致しない`);
  }
}

console.log(`=== determinism 完了：${CHECKS} checks / ${FAIL} fail ===`);
for (const p of problems) console.log("  ❌ " + p);
if (FAIL === 0) console.log("  ✅ engine は完全決定論（同 seed→同結果・rng/genFloor/戦闘/多世代）");
process.exit(FAIL > 0 ? 1 : 0);

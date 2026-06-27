// A: セーブ移行・往復ファジング（デスクトップ Claude Code 用）。
// 狙い＝旧セーブ（新フィールド欠落）が migrateWorld 後に「エンジンが動く完全な World」になるか、
//   往復(stringify→parse→migrate)が冪等か、レガシー keepsake 形式が壊れず移行されるか。
// CLAUDE.md の「migrate 非破壊バックフィル」の主張をファジングで裏取りする。
// 実行: node --experimental-strip-types tools/stress-save.ts
import {
  newWorld, createCharacter, fossilizeCurrent, advanceArcs, migrateWorld, SAVE_VERSION,
} from "../src/world.ts";
import { genFloor, planMonsters, resolveMonsters, mapIdx } from "../src/dungeon.ts";
import { maxHp } from "../src/progression.ts";
import { makeRng } from "../src/rng.ts";
import type { World, Character, Lineage, Fossil } from "../src/types.ts";

let FAIL = 0, CHECKS = 0;
const problems: string[] = [];
function bad(m: string) { FAIL++; if (problems.length < 100) problems.push(m); }
function ok(c: boolean, m: string) { CHECKS++; if (!c) bad(m); }
const fin = (n: any) => typeof n === "number" && Number.isFinite(n);
const clone = (w: World): any => JSON.parse(JSON.stringify(w));

// 「エンジンが動く完全な World か」＝必須フィールドの存在・型・有限性 ＋ 実操作で throw しない。
function assertValid(tag: string, w: World) {
  const reqArr = ["fossils", "tracked", "chronicle", "flags", "actors", "quests", "stash", "stashGear", "arcs", "echoes", "keepsakes", "seals", "bestiary"];
  for (const k of reqArr) ok(Array.isArray((w as any)[k]), `${tag}: ${k} が配列でない`);
  const reqNum = ["generation", "diveCount", "ascended", "questsDone", "recognizedGrade", "raidCooldown", "memorialCooldown", "plagueCooldown"];
  for (const k of reqNum) ok(fin((w as any)[k]), `${tag}: ${k} が有限数でない (${(w as any)[k]})`);
  ok(typeof w.difficulty === "string", `${tag}: difficulty 未設定`);
  ok(typeof w.homeUnlocked === "boolean", `${tag}: homeUnlocked 未設定`);
  ok(w.version === SAVE_VERSION, `${tag}: version が ${SAVE_VERSION} でない (${w.version})`);
  for (const t of w.tracked) { ok(fin(t.beat), `${tag}: tracked.beat 非有限`); ok(fin(t.drift ?? 0), `${tag}: tracked.drift 非有限`); }
  if (w.current) {
    const ch = w.current;
    ok(ch.stats && fin(ch.stats.body) && fin(ch.stats.power) && fin(ch.stats.reason) && fin(ch.stats.heart), `${tag}: current.stats 不正`);
    ok(fin(ch.level) && fin(ch.xp) && fin(ch.gold), `${tag}: current.level/xp/gold 不正`);
    ok(Array.isArray(ch.spells) && Array.isArray(ch.loadout) && Array.isArray(ch.gearBag), `${tag}: current の配列欠落`);
    ok(!!ch.equipment, `${tag}: current.equipment 欠落`);
    ok(fin(maxHp(ch)), `${tag}: maxHp(current) 非有限`);
  }
  if (w.keepsakes) for (const k of w.keepsakes as any[]) ok(typeof k.id === "string", `${tag}: keepsake.id 欠落 ${JSON.stringify(k)}`);
}

// 移行後の World でエンジンの代表操作が throw しないか（壊れたデータで落ちないこと）。
function assertOperable(tag: string, w: World) {
  try {
    // 次世代キャラ作成（系譜あり/なし）
    const anc = w.fossils.filter((f) => f.kind === "character").slice(-1)[0];
    const lin: Lineage = anc ? { relation: "pupil", ancestorFossilId: anc.id } : { relation: "none" };
    const ch = createCharacter(w, "移行後", "wanderer", lin);
    ok(fin(ch.level) && ch.level >= 1 && fin(maxHp(ch)), `${tag}: createCharacter 後の不正値`);
    ch.depth = 10; ch.exposure = 1.0;
    // 階生成＋1手戦闘
    const f = genFloor(w, 8);
    const rng = makeRng(w.seed + 1);
    const player = { x: f.stairsUp.x, y: f.stairsUp.y };
    planMonsters(f, player, rng, null, null);
    resolveMonsters(f, player, null, null);
    ok(f.tiles[mapIdx(f, f.stairsDown.x, f.stairsDown.y)] === 1, `${tag}: 移行後 genFloor 階段不正`);
    // 化石化＋弧前進
    fossilizeCurrent(w, "combat" as any, { choice: "accept" } as any);
    advanceArcs(w);
  } catch (e: any) { bad(`${tag}: 移行後の操作で throw: ${e.message}`); }
}

// リッチな現行世界を作る（多世代・相棒/依頼/弧/化石/拾得品/印を積む）。
function buildRichWorld(seed: number): World {
  const w = newWorld(seed);
  w.difficulty = (["easy", "normal", "hard"] as const)[seed % 3];
  for (let gen = 0; gen < 12; gen++) {
    const anc = w.fossils.filter((f) => f.kind === "character").slice(-1)[0];
    let lin: Lineage = { relation: "none" };
    if (anc) lin = gen % 2 ? { relation: "pupil", ancestorFossilId: anc.id } : { relation: "blood", ancestorFossilId: anc.id, chosenSpells: (anc.spells ?? []).slice(0, 2) };
    const ch = createCharacter(w, `世代${gen}`, "wanderer", lin);
    ch.depth = 5 + gen * 3; ch.exposure = (gen % 5) * 0.4; ch.gold = gen * 12;
    (w.keepsakes as any[]).push({ id: "ks_letter", gen: w.generation, depth: ch.depth });
    if (gen % 3 === 0) (w.seals as any[]).push("abyss_boss");
    if (gen % 4 === 0) (w.quests as any[]).push({ id: `q${gen}`, kind: "reach", targetDepth: 20, reward: 50, claimed: false } as any);
    if (gen === 2) w.companion = { name: "相棒", actor: { name: "相棒", archetype: "wanderer", gearTags: ["剣"], grade: 2 }, alive: true, grade: 2, feats: 1, bond: 2, exposure: 0.5, traits: [] } as any;
    fossilizeCurrent(w, (["combat", "exposure", "fall", "mercy"] as const)[gen % 4] as any, { choice: (["accept", "guard_relic", "curse_dungeon", "leave_will"] as const)[gen % 4] } as any);
    advanceArcs(w);
  }
  return w;
}

// 旧セーブが欠きうるフィールド（migrateWorld がバックフィルする対象）。
const STRIP_FIELDS = [
  "actors", "flags", "quests", "stash", "stashGear", "homeUnlocked", "arcs", "tracked", "raidCooldown",
  "memorialCooldown", "plagueCooldown", "diveCount", "echoes", "keepsakes", "difficulty", "seals",
  "ascended", "questsDone", "recognizedGrade", "bestiary",
];
const STRIP_CURRENT = ["stats", "level", "xp", "spells", "loadout", "equipment", "gold", "gearBag"];

console.log("== stress-save 開始 ==");
const t0 = Date.now();

// 1. 往復の冪等性（migrate(parse(stringify(w))) を二度通して同一）
for (let seed = 1; seed <= 40; seed++) {
  const w = buildRichWorld(seed * 7 + 1);
  const once = migrateWorld(clone(w));
  assertValid(`roundtrip s${seed}`, once);
  const twice = migrateWorld(clone(once));
  ok(JSON.stringify(once) === JSON.stringify(twice), `roundtrip s${seed}: migrate が冪等でない`);
  assertOperable(`roundtrip s${seed}`, migrateWorld(clone(w)));
}
console.log(`  往復/冪等 done (${CHECKS} checks, ${FAIL} fail)`);

// 2. 旧セーブ・シミュレーション：新フィールドを欠落させた退行コピーを migrate して検証
const rng = makeRng(12345);
for (let seed = 1; seed <= 30; seed++) {
  const base = buildRichWorld(seed * 13 + 2);
  // 2a. 各フィールドを単独欠落
  for (const fld of STRIP_FIELDS) {
    const c = clone(base); delete c[fld]; c.version = 5;
    const m = migrateWorld(c); assertValid(`strip[${fld}] s${seed}`, m); assertOperable(`strip[${fld}] s${seed}`, m);
  }
  for (const fld of STRIP_CURRENT) {
    const c = clone(base); if (c.current) delete c.current[fld]; c.version = 5;
    const m = migrateWorld(c); assertValid(`strip.current[${fld}] s${seed}`, m); assertOperable(`strip.current[${fld}] s${seed}`, m);
  }
  // 2b. ランダムな複数欠落（旧セーブが複数の新フィールドを一気に欠く現実形）
  for (let trial = 0; trial < 20; trial++) {
    const c = clone(base);
    for (const fld of STRIP_FIELDS) if (rng.next() < 0.4) delete c[fld];
    for (const fld of STRIP_CURRENT) if (c.current && rng.next() < 0.4) delete c.current[fld];
    if (rng.next() < 0.3 && c.town) delete c.town.memorials;
    if (rng.next() < 0.3) c.current = null; // 街にいる世界（current 無し）
    c.version = [0, 2, 5, 7, 8][trial % 5]; // いろいろな旧版数
    const m = migrateWorld(c); assertValid(`combo s${seed} t${trial}`, m); assertOperable(`combo s${seed} t${trial}`, m);
  }
}
console.log(`  旧セーブ退行 done (${CHECKS} checks, ${FAIL} fail)`);

// 3. レガシー keepsake 形式（旧 {title,story} → id 参照へ移行）
{
  const w = buildRichWorld(99);
  (w as any).keepsakes = [
    { title: "宛名のない手紙", story: "古い本文", gen: 1, depth: 5 }, // 旧11題の既知
    { title: "削られた名札", story: "別の本文", gen: 2, depth: 8 },
    { title: "未知の題", story: "未知本文", gen: 3, depth: 9 },        // フォールバック legacy:題
  ];
  (w as any).version = 6;
  const m = migrateWorld(clone(w));
  assertValid("legacy-keepsake", m);
  const ids = (m.keepsakes as any[]).map((k) => k.id);
  ok(ids.includes("ks_letter"), `legacy keepsake: 宛名のない手紙→ks_letter 失敗 (${ids})`);
  ok(ids.includes("ks_nameplate"), `legacy keepsake: 削られた名札→ks_nameplate 失敗`);
  ok(ids.some((i) => i.startsWith("legacy:")), `legacy keepsake: 未知題のフォールバックid 失敗`);
  ok((m.keepsakes as any[]).every((k) => k.story === undefined), `legacy keepsake: story が落ちていない（本文重複）`);
}
console.log(`  レガシー keepsake done (${CHECKS} checks, ${FAIL} fail)`);

// 4. 完全に空/壊れた World（web の try/catch は別途。ここはエンジン migrate の最低保証）
for (const broken of [{}, { generation: 1 }, { current: {} }, { tracked: [{ id: "x", name: "y", source: "seeded", arcType: "doom" }] }] as any[]) {
  try { const m = migrateWorld(clone(broken)); assertValid(`broken ${JSON.stringify(broken).slice(0, 20)}`, m); }
  catch (e: any) { bad(`broken World で migrate throw: ${JSON.stringify(broken).slice(0, 30)} → ${e.message}`); }
}
console.log(`  壊れ World done (${CHECKS} checks, ${FAIL} fail)`);

console.log(`\n=== stress-save 完了：${CHECKS} checks / ${FAIL} fail / ${((Date.now() - t0) / 1000).toFixed(1)}s ===`);
for (const p of problems) console.log("  ❌ " + p);
if (FAIL === 0) console.log("  ✅ セーブ移行・往復すべて健全（migrate 非破壊バックフィルを裏取り）");
process.exit(FAIL > 0 ? 1 : 0);

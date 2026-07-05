// 実エンジン戦闘シム（横断E・ヘッドレス検証の第二ルート）。実行: node --experimental-strip-types tools/sim-combat.ts
//   既存 tools/sim.ts は 1v1 の純算術（理論値）。本シムは **実際の敵AI（planMonsters/resolveMonsters）と
//   特殊能力(4-11G ranged/venom/leech/breeder)** を回し、能力ごとの「実コスト」を測る第二ルート。
//
//   プレイヤー＝**近接のみ・術なし・会心なし**＝強さの下限（保守的）。実プレイヤーは術/回復/会心/相棒/消耗品で上振れ。
//   ※エンジン側に会心は無い（line 3392 castSpell 経路の sfx("crit") は演出のみ・素手は flat meleeDmg）＝この下限は妥当。
//
//   指標A（主）＝**1体あたりHPコスト**：1v1 で1体倒すのに失う HP（最大HPの%）。深度正規化・包囲/膠着の人工物なし。
//     →「この深度でこの敵を1体倒すとHPバーの何%が溶けるか」。降順ソートで突出種が即わかる。N体パックは概ね N×。
//   指標B（副）＝**パック実戦**：実フロア相当の混成5体を回し WIN/DEATH/STALEMATE を分類。
//     回復予算（resource economy のモデル）を1つだけ与え「下限プレイヤー」を「素手の床」から「素人」へ引き上げる。
import { makeRng } from "../src/rng.ts";
import { planMonsters, resolveMonsters, scaleKind, MONSTER_KINDS, regularHpAt, depthDmgBonus, genFloor, FODDER_MUL } from "../src/dungeon.ts";
import { maxHp, meleeDmg, armorReduce } from "../src/progression.ts";
import { newWorld } from "../src/world.ts";
import type { Difficulty } from "../src/difficulty.ts";
import type { Character } from "../src/types.ts";
import type { Floor, Monster, MonsterKind, Pos } from "../src/dungeon.ts";

const VENOM_TURNS = 4;
const venomDmgAt = (d: number) => Math.min(3, Math.max(1, Math.round(d * 0.08))); // VENOM_DMG_CAP=3（横断E・main.ts と同値）

/** 深度相応の「ちゃんと潜ってきた」近接ビルド：level=depth、ステは体力寄り、装備は深度スケール。 */
function meleeChar(L: number, weaponDmg: number, armorRed: number): Character {
  const added = L - 1;
  const body = 2 + Math.ceil(added / 2), power = 2 + Math.floor(added / 2);
  return { name: "Sim", level: L, stats: { body, power, reason: 2, heart: 2 }, depth: L,
    equipment: { weapon: { dmg: weaponDmg }, armor: { reduce: armorRed }, relic: null, bag: null } } as unknown as Character;
}
const GEAR = (d: number) => ({ w: Math.round(d * 0.3) + 3, a: Math.round(d * 0.12) }); // 深度相応の武具（武器+N相当/防具）
const cheb = (a: Pos, b: Pos) => Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));
const isFloor = (f: Floor, x: number, y: number) => x >= 0 && y >= 0 && x < f.w && y < f.h && f.tiles[y * f.w + x] === 1;
const occupied = (f: Floor, x: number, y: number) => f.monsters.some((m) => m.hp > 0 && m.x === x && m.y === y);

/** 壁縁つきの開けた小部屋（包囲は起きるが「全フロア17体同時」の非現実は避ける／kiter も壁際で詰む）。 */
function arena(size = 11): Floor {
  const w = size, h = size, tiles = new Array(w * h).fill(1);
  for (let x = 0; x < w; x++) { tiles[x] = 0; tiles[(h - 1) * w + x] = 0; }
  for (let y = 0; y < h; y++) { tiles[y * w] = 0; tiles[y * w + w - 1] = 0; }
  return { w, h, tiles, monsters: [], fossils: [], chests: [], shrines: [], returnDoor: null, depth: 0, explored: new Array(w * h).fill(true), stairsUp: { x: 1, y: 1 }, stairsDown: { x: w - 2, y: h - 2 } } as unknown as Floor;
}
function placePack(f: Floor, center: Pos, kinds: MonsterKind[]): void {
  const ring: Pos[] = [];
  for (let r = 2; r <= 4; r++) for (let a = 0; a < 8; a++) {
    const x = center.x + Math.round(r * Math.cos(a * Math.PI / 4)), y = center.y + Math.round(r * Math.sin(a * Math.PI / 4));
    if (isFloor(f, x, y) && !(x === center.x && y === center.y)) ring.push({ x, y });
  }
  kinds.forEach((k, i) => { const p = ring[(i * 3) % ring.length] ?? { x: center.x + 1, y: center.y }; f.monsters.push({ id: `m${i}`, kind: k, hp: k.hp, x: p.x, y: p.y, awake: true, intent: null } as Monster); });
}

/** プレイヤーの一手：最寄りの生存敵へ。隣接なら殴る、でなければ1歩詰める（貪欲・greedy melee）。 */
function playerStep(f: Floor, p: Pos, dmg: number): { p: Pos; killed: number } {
  const alive = f.monsters.filter((m) => m.hp > 0);
  let t: Monster | null = null, bd = Infinity;
  for (const m of alive) { const d = cheb(p, m); if (d < bd) { bd = d; t = m; } }
  if (!t) return { p, killed: 0 };
  if (cheb(p, t) <= 1) { t.hp -= dmg; return { p, killed: t.hp <= 0 ? 1 : 0 }; }
  const sx = Math.sign(t.x - p.x), sy = Math.sign(t.y - p.y);
  for (const c of [{ x: p.x + sx, y: p.y + sy }, { x: p.x + sx, y: p.y }, { x: p.x, y: p.y + sy }])
    if (isFloor(f, c.x, c.y) && !occupied(f, c.x, c.y)) return { p: c, killed: 0 };
  return { p, killed: 0 };
}

// ---------- 指標A：1v1 の1体あたりHPコスト ----------
interface Cost { ttk: number; hpLostPct: number; died: boolean; poison: number; absorbedExtra: number; rangedHits: number }
function solo(L: number, depth: number, kind: MonsterKind, seed: number): Cost {
  const f = arena(11), center: Pos = { x: 5, y: 5 };
  placePack(f, center, [kind]);
  const m0 = f.monsters[0];
  const ch = meleeChar(L, GEAR(depth).w, GEAR(depth).a);
  const hpMax = maxHp(ch), dmg = meleeDmg(ch), armor = armorReduce(ch);
  let hp = hpMax, p: Pos = { ...center }, poison = 0, pd = 0, poisonTot = 0, ranged = 0, dealt = 0;
  const rng = makeRng((seed ^ (depth * 40503) ^ (L * 97)) >>> 0);
  for (let turn = 1; turn <= 400; turn++) {
    if (m0.hp <= 0) {
      // leech は途中で回復した分だけ「実効HP」が膨らむ＝倒すのに余計に殴った量で測る。
      return { ttk: turn - 1, hpLostPct: Math.round(100 * (hpMax - hp) / hpMax), died: false, poison: poisonTot, absorbedExtra: Math.max(0, dealt - m0.kind.hp), rangedHits: ranged };
    }
    const before = m0.hp;
    const st = playerStep(f, p, dmg); p = st.p;
    if (m0.hp < before) dealt += before - m0.hp; // 与えたダメージ（leech 回復で hp が戻ると差が縮む）
    const rangedBefore = m0.kind.ability === "ranged" && cheb(p, m0) >= 2;
    planMonsters(f, p, rng);
    const res = resolveMonsters(f, p);
    for (const h of res.hits) { if (h.target !== "player") continue;
      if (rangedBefore) ranged++;
      hp -= Math.max(1, h.dmg - armor); if (h.effect === "poison") { poison = VENOM_TURNS; pd = venomDmgAt(depth); } }
    if (poison > 0) { poison--; hp -= pd; poisonTot += pd; }
    if (hp <= 0) return { ttk: turn, hpLostPct: 100, died: true, poison: poisonTot, absorbedExtra: Math.max(0, dealt - m0.kind.hp), rangedHits: ranged };
  }
  return { ttk: 400, hpLostPct: Math.round(100 * (hpMax - hp) / hpMax), died: hp <= 0, poison: poisonTot, absorbedExtra: Math.max(0, dealt - m0.kind.hp), rangedHits: ranged };
}

// ---------- 指標B：パック実戦（混成5体）WIN/DEATH/STALEMATE ----------
interface Pack { outcome: "WIN" | "DEATH" | "STALE"; hpLostPct: number; turns: number; killed: number; peak: number; heals: number }
function pack(L: number, depth: number, kinds: MonsterKind[], seed: number, healBudget: number, healAmt: number): Pack {
  const f = arena(11), center: Pos = { x: 5, y: 5 };
  placePack(f, center, kinds);
  const ch = meleeChar(L, GEAR(depth).w, GEAR(depth).a);
  const hpMax = maxHp(ch), dmg = meleeDmg(ch), armor = armorReduce(ch);
  let hp = hpMax, p: Pos = { ...center }, poison = 0, pd = 0, killed = 0, peak = kinds.length, heals = 0;
  const rng = makeRng((seed ^ (depth * 40503) ^ (L * 97)) >>> 0);
  for (let turn = 1; turn <= 200; turn++) {
    const alive = f.monsters.filter((m) => m.hp > 0);
    if (!alive.length) return { outcome: "WIN", hpLostPct: Math.round(100 * (hpMax - hp) / hpMax), turns: turn, killed, peak, heals };
    peak = Math.max(peak, alive.length);
    // 回復予算：HPが35%を割ったら1回使う（消耗品/治癒術1詠唱ぶん＝resource economy のモデル）。
    if (hp < hpMax * 0.35 && heals < healBudget) { hp = Math.min(hpMax, hp + Math.round(hpMax * healAmt)); heals++; }
    const st = playerStep(f, p, dmg); p = st.p; killed += st.killed;
    planMonsters(f, p, rng);
    const res = resolveMonsters(f, p);
    for (const h of res.hits) { if (h.target !== "player") continue;
      hp -= Math.max(1, h.dmg - armor); if (h.effect === "poison") { poison = VENOM_TURNS; pd = venomDmgAt(depth); } }
    if (poison > 0) { poison--; hp -= pd; }
    if (hp <= 0) return { outcome: "DEATH", hpLostPct: 100, turns: turn, killed, peak, heals };
  }
  return { outcome: "STALE", hpLostPct: Math.round(100 * (hpMax - hp) / hpMax), turns: 200, killed, peak, heals }; // 膠着＝倒し切れず（kiter等）
}

const SEEDS = [11, 22, 33, 44, 55, 66, 77, 88];
const kindByKey = (key: string) => MONSTER_KINDS.find((k) => k.key === key)!;
const avg = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / (xs.length || 1);
const DEPTHS = [10, 20, 30, 40, 50];

console.log("=== 実エンジン戦闘シム：能力別の実コスト（近接のみ・術/回復なし＝プレイヤー下限）===\n");

// --- 指標A：その深度で出現する各種を1v1。能力タグ付きで「1体あたりHPコスト%」降順 ---
console.log("【指標A】1体あたりHPコスト（1v1・全快開始・近接のみ）  ＝『1体倒すとHPバーの何%が溶けるか』");
console.log("  各行: 種(能力)  HP% / TTK手 / 毒 / leech余剰 / 遠隔被弾  ※8seed平均。HP%が突出＝その敵/能力が割高\n");
for (const d of DEPTHS) {
  const pool = MONSTER_KINDS.filter((k) => k.minDepth <= d && (k.maxDepth === undefined || d <= k.maxDepth) && k.tier <= 4);
  const rows = pool.map((k) => {
    const cs = SEEDS.map((s) => solo(d, d, scaleKind(k, d), s));
    return { k, hp: Math.round(avg(cs.map((c) => c.hpLostPct))), ttk: +avg(cs.map((c) => c.ttk)).toFixed(1),
      poison: Math.round(avg(cs.map((c) => c.poison))), absorb: Math.round(avg(cs.map((c) => c.absorbedExtra))),
      ranged: +avg(cs.map((c) => c.rangedHits)).toFixed(1), died: cs.some((c) => c.died) };
  }).sort((a, b) => b.hp - a.hp);
  console.log(`-- 深度 ${d}（プレイヤー Lv${d}・maxHP ${maxHp(meleeChar(d, 0, 0))}・与ダメ ${meleeDmg(meleeChar(d, GEAR(d).w, 0))}）--`);
  for (const r of rows) {
    const ab = r.k.ability ? `[${r.k.ability}]` : "";
    const warn = r.died ? " ⚠1体で死" : r.hp >= 60 ? " ⚠割高" : "";
    console.log(`   ${(r.k.name + ab).padEnd(14)} HP ${String(r.hp).padStart(3)}% | TTK ${String(r.ttk).padStart(4)} | 毒 ${String(r.poison).padStart(2)} | leech余 ${String(r.absorb).padStart(3)} | 遠隔 ${String(r.ranged).padStart(4)}${warn}`);
  }
  console.log("");
}

// --- 指標B：実フロア相当の混成5体パック。回復予算ありで WIN/DEATH/STALEMATE ---
console.log("【指標B】混成5体パック（実フロア相当）  回復予算=2回×35%（消耗品/治癒術のモデル）");
console.log("  depth: WIN% / DEATH% / STALE% / 勝時HP損% / 平均撃破 / 敵ピーク / 平均回復回数\n");
for (const d of DEPTHS) {
  const pool = MONSTER_KINDS.filter((k) => k.minDepth <= d && (k.maxDepth === undefined || d <= k.maxDepth) && k.tier <= 4);
  const r = makeRng((d * 2654435761) >>> 0);
  const rs = SEEDS.map((s) => {
    const kinds = [0, 1, 2, 3, 4].map(() => scaleKind(pool[r.int(pool.length)], d));
    return pack(d, d, kinds, s, 2, 0.35);
  });
  const win = rs.filter((x) => x.outcome === "WIN"), death = rs.filter((x) => x.outcome === "DEATH"), stale = rs.filter((x) => x.outcome === "STALE");
  console.log(`  D${String(d).padStart(2)} | WIN ${String(Math.round(100 * win.length / rs.length)).padStart(3)}% | DEATH ${String(Math.round(100 * death.length / rs.length)).padStart(3)}% | STALE ${String(Math.round(100 * stale.length / rs.length)).padStart(3)}% | 勝HP損 ${String(win.length ? Math.round(avg(win.map((x) => x.hpLostPct))) : 0).padStart(3)}% | 撃破 ${avg(rs.map((x) => x.killed)).toFixed(1)} | ピーク ${Math.max(...rs.map((x) => x.peak))} | 回復 ${avg(rs.map((x) => x.heals)).toFixed(1)}`);
}

console.log("\n※ 下限ビルド（近接のみ・会心/術なし）。実プレイヤーは術/回復ノード/会心/相棒/消耗品で大きく上振れ。");
console.log("※ 指標Aで『1体のHP%』が深度を通じて概ね一定なら終始シビアが効いている。突出種＝要調整。");
console.log("※ 指標BのDEATHは『回復2回でも沈む』＝設計通り（深部は素の近接だけでは押し切れない＝術/相棒が必須）。STALEはkiter膠着。");

// --- 指標C：構成別パック（能力の「混成時の限界コスト」を切り出す）---
//   1v1 では無害だった ranged も「近接3体に足止めされながら撃たれる」と刺さる、を測る。
//   全構成 5体・回復予算2回×35%。baseline(近接5) との DEATH%/勝HP損% の差＝その能力の限界寄与。
console.log("\n【指標C】構成別パック（混成時の能力寄与）  回復予算=2回×30%・各3体");
console.log("  対照=近接3（生存可能域）。各能力を『近接1＋能力2』で混ぜ、平均HP損%（死=100）で連続比較＝その能力の限界寄与\n");
const meleeFillKey = (d: number) => d >= 40 ? "brute" : d >= 28 ? "ogre" : d >= 22 ? "reaver" : d >= 12 ? "hound" : "ghoul";
const M = meleeFillKey, rangedKey = (d: number) => d >= 36 ? "seer" : d >= 18 ? "archer" : "spitter";
const venomKey = (d: number) => d >= 34 ? "wailer" : d >= 30 ? "slug" : d >= 16 ? "spore" : "viper";
const leechKey = (d: number) => d >= 26 ? "drainer" : "leecher", breedKey = (d: number) => d >= 32 ? "mother" : "brood";
const COMPS: { label: string; kinds: (d: number) => string[] }[] = [
  { label: "近接3（対照）", kinds: (d) => [M(d), M(d), M(d)] },
  { label: "近接1+遠隔2", kinds: (d) => [M(d), rangedKey(d), rangedKey(d)] },
  { label: "近接1+毒2  ", kinds: (d) => [M(d), venomKey(d), venomKey(d)] },
  { label: "近接1+吸命2", kinds: (d) => [M(d), leechKey(d), leechKey(d)] },
  { label: "近接1+増殖2", kinds: (d) => [M(d), breedKey(d), breedKey(d)] },
];
for (const comp of COMPS) {
  const cells = DEPTHS.map((d) => {
    const rs = SEEDS.map((s) => pack(d, d, comp.kinds(d).map((k) => scaleKind(kindByKey(k), d)), s, 2, 0.30));
    const hpAvg = Math.round(avg(rs.map((x) => x.hpLostPct))); // 死=100 を含む連続指標
    const death = Math.round(100 * rs.filter((x) => x.outcome === "DEATH").length / rs.length);
    return `D${d}:HP損${String(hpAvg).padStart(3)}%${death ? `(死${death})` : "      "}`;
  });
  console.log(`  ${comp.label}  ${cells.join(" ")}`);
}
console.log("  ※平均HP損%が対照(近接3)より高い能力＝足止め戦で余計に削られる＝混成時に効く。(死N)=N%が死亡。");

// ---------- 指標D：実フロア踏破（A｜群れ増量の検証）：genFloor 実フロアを stairsUp→stairsDown 踏破 ----------
//   pack（固定5体arena）は「フロアの敵密度」を測れない。本指標は実 genFloor を fodderMul=0（対照）と
//   fodderMul=FODDER_MUL（増量後）で生成し、下限プレイヤー（近接のみ・回復予算あり）に踏破させ、
//   「1フロア踏破のHPコスト%」「DEATH率」「同時隣接ピーク（＝地形の流入制御）」を実測して比較する。
//   合格基準：増量後のHPコスト%がベースライン比 +25% 以内・DEATH率が既存帯から逸脱しない。
function bfsNext(f: Floor, from: Pos, to: Pos): Pos | null {
  const W = f.w, H = f.h, prev = new Int32Array(W * H).fill(-1);
  const si = from.y * W + from.x; prev[si] = si;
  const q: Pos[] = [from];
  for (let h = 0; h < q.length; h++) {
    const c = q[h];
    if (c.x === to.x && c.y === to.y) break;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
      const nx = c.x + dx, ny = c.y + dy;
      if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
      const i = ny * W + nx;
      if (prev[i] !== -1 || f.tiles[i] !== 1) continue;
      prev[i] = c.y * W + c.x; q.push({ x: nx, y: ny });
    }
  }
  const ti = to.y * W + to.x;
  if (prev[ti] === -1) return null;
  let cur = ti;
  while (prev[cur] !== si && prev[cur] !== cur) cur = prev[cur];
  return { x: cur % W, y: Math.floor(cur / W) };
}
interface Traverse { outcome: "REACH" | "DEATH" | "STALE"; hpLostPct: number; turns: number; kills: number; monsters: number; peakAdj: number; heals: number }
function floorRun(diff: Difficulty, depth: number, fodderMul: number, seed: number, healBudget: number, healAmt: number): Traverse {
  const w = newWorld((seed ^ 0xf0dde5) >>> 0); w.difficulty = diff; w.diveCount = (seed % 5);
  const f = genFloor(w, depth, { fodderMul });
  const monsters0 = f.monsters.length;
  const ch = meleeChar(depth, GEAR(depth).w, GEAR(depth).a);
  const hpMax = maxHp(ch), dmg = meleeDmg(ch), armor = armorReduce(ch);
  let hp = hpMax, p: Pos = { ...f.stairsUp }, poison = 0, pd = 0, kills = 0, peakAdj = 0, heals = 0;
  const rng = makeRng((seed ^ (depth * 40503) ^ 0x5a1d) >>> 0);
  for (let turn = 1; turn <= 900; turn++) {
    if (p.x === f.stairsDown.x && p.y === f.stairsDown.y)
      return { outcome: "REACH", hpLostPct: Math.round(100 * (hpMax - hp) / hpMax), turns: turn, kills, monsters: monsters0, peakAdj, heals };
    if (hp < hpMax * 0.35 && heals < healBudget) { hp = Math.min(hpMax, hp + Math.round(hpMax * healAmt)); heals++; }
    const adj = f.monsters.filter((m) => m.hp > 0 && Math.max(Math.abs(m.x - p.x), Math.abs(m.y - p.y)) <= 1 && Math.hypot(m.x - p.x, m.y - p.y) <= 8);
    const adjAll = f.monsters.filter((m) => m.hp > 0 && Math.max(Math.abs(m.x - p.x), Math.abs(m.y - p.y)) <= 1);
    peakAdj = Math.max(peakAdj, adjAll.length);
    if (adjAll.length) { // 隣接の生存敵（最小HP優先＝掃討）を殴る
      const t = adjAll.reduce((a, b) => (b.hp < a.hp ? b : a));
      t.hp -= dmg; if (t.hp <= 0) kills++;
    } else { // stairsDown へ一歩（空きマスのみ）
      const nx = bfsNext(f, p, f.stairsDown);
      if (nx && !f.monsters.some((m) => m.hp > 0 && m.x === nx.x && m.y === nx.y)) p = nx;
    }
    planMonsters(f, p, rng);
    const res = resolveMonsters(f, p);
    for (const h of res.hits) { if (h.target !== "player") continue;
      hp -= Math.max(1, h.dmg - armor); if (h.effect === "poison") { poison = VENOM_TURNS; pd = venomDmgAt(depth); } }
    if (poison > 0) { poison--; hp -= pd; }
    if (hp <= 0) return { outcome: "DEATH", hpLostPct: 100, turns: turn, kills, monsters: monsters0, peakAdj, heals };
  }
  return { outcome: "STALE", hpLostPct: Math.round(100 * (hpMax - hp) / hpMax), turns: 900, kills, monsters: monsters0, peakAdj, heals };
}
console.log(`\n【指標D】実フロア踏破（A｜群れ増量の検証）  FODDER_MUL=${FODDER_MUL}・回復予算=4回×40%・${SEEDS.length}seed`);
console.log("  各セル: 敵数 / HP損% / DEATH% / 同時隣接ピーク  ＝『対照(fodder0)』→『増量(fodderX)』  ※HP損%の増分が+25%以内なら合格\n");
const FDEPTHS = [3, 8, 15, 25, 35, 50];
for (const diff of ["easy", "normal", "hard"] as Difficulty[]) {
  console.log(`-- 難易度 ${diff} --`);
  for (const d of FDEPTHS) {
    const base = SEEDS.map((s) => floorRun(diff, d, 0, s, 4, 0.40));
    const inc = SEEDS.map((s) => floorRun(diff, d, FODDER_MUL, s, 4, 0.40));
    const hp0 = Math.round(avg(base.map((x) => x.hpLostPct))), hp1 = Math.round(avg(inc.map((x) => x.hpLostPct)));
    const dth0 = Math.round(100 * base.filter((x) => x.outcome === "DEATH").length / base.length);
    const dth1 = Math.round(100 * inc.filter((x) => x.outcome === "DEATH").length / inc.length);
    const mon0 = Math.round(avg(base.map((x) => x.monsters))), mon1 = Math.round(avg(inc.map((x) => x.monsters)));
    const pk0 = Math.max(...base.map((x) => x.peakAdj)), pk1 = Math.max(...inc.map((x) => x.peakAdj));
    const delta = hp0 > 0 ? Math.round(100 * (hp1 - hp0) / hp0) : (hp1 > 0 ? 999 : 0);
    const flag = delta > 25 ? " ⚠+25%超" : "";
    console.log(`  D${String(d).padStart(2)} | 敵 ${String(mon0).padStart(2)}→${String(mon1).padStart(2)} | HP損 ${String(hp0).padStart(3)}%→${String(hp1).padStart(3)}%(Δ${delta >= 0 ? "+" : ""}${delta}%) | 死 ${String(dth0).padStart(3)}%→${String(dth1).padStart(3)}% | 隣接ピーク ${pk0}→${pk1}${flag}`);
  }
}
console.log("  ※敵数は増えても『同時隣接ピーク』が1〜3に留まれば地形（幅1通路）の流入制御が効いている＝逃げ場あり。");


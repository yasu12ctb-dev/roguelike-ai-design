// 緊張感リワーク PR3（v0.152.0｜主経路ガード）受入検証シム。
//   実行: cd proto && node --experimental-strip-types tools/sim-tension.ts
//
// 目的＝v0.151.0 の大部屋集中で「脅威がスキップ可能な部屋へ寄り、最短路がむしろ空く（直行 rush の易化）」ことが判明
//   →PR3 は全域散布枠の敵のうち深度別 2〜4 体だけを stairsUp→stairsDown の 4近傍BFS最短路上へ再配置（追加スポーンなし・
//   RNG非消費）して是正した。3アームで A/B し、①直行 rush の易化が解消したか ②大部屋戦を殺していないか を実測する。
//
// ★3アーム（後加工での before 再現はしない＝genFloor の opts 切替が正）：
//   before（v0.150 相当）＝genFloor(w, depth, {roomBias:0, routeGuards:0}) ＋ f.rooms 削除（部屋aggro off）
//       ＝roomBias:0 で roomTargets が空＝主配置は全域散布・RNG列も v0.150 と一致。f.rooms 削除で個別LOS起床に戻す。
//   mid  （v0.151 相当）＝genFloor(w, depth, {routeGuards:0}) ＝A（大部屋集中）＋部屋aggro on・主経路ガードのみ off。
//   after（v0.152＝現行）＝genFloor(w, depth) ＝全機能 on。
//   ※同一 world seed ゆえマップ幾何（部屋/タイル/階段）は3アーム完全同一。差は敵の配置・起床のみ。
//   ※mid と after は roomBias 既定で RNG 列が完全一致し、route guards は RNG を消費しない＝両者は「経路ガードの
//     再配置ぶんだけ」異なる（＝再配置数は id 突合で厳密に数えられる／PR3 は追加スポーンなし＝総数は mid==after 厳密一致）。
//
// シムの限界（明記）：
//   ・プレイヤー＝情報完全の下限bot（近接のみ・術/会心/相棒/消耗品なし・最寄り/最小HP優先の貪欲）。
//     ＝HP損は「上限（最悪寄り）」、ゼロ被弾率は「下限」。実プレイヤーは術/回復/位置取りで大きく上振れ。
//   ・通路チョークは実 genFloor の幅1 L字通路をそのまま使うので実機同等。ただし bot の経路は BFS 最短で、
//     人間が意図的に通路へ引き込む立ち回りは再現しない＝「1対1に持ち込む腕」は測っていない（構造的な遭遇の出方を測る）。
//   ・explore の HP損/CLEAR は下限bot（AoE/押し出し/会心なし）では部屋戦が構造的に致死＝クリップ＝参考外。有効信号は交戦構造。
import { makeRng } from "../src/rng.ts";
import { planMonsters, resolveMonsters, genFloor, monsterHardcap } from "../src/dungeon.ts";
import { maxHp, meleeDmg, armorReduce } from "../src/progression.ts";
import { newWorld } from "../src/world.ts";
import { diffMods } from "../src/difficulty.ts";
import type { Difficulty } from "../src/difficulty.ts";
import type { Character } from "../src/types.ts";
import type { Floor, Monster, Pos } from "../src/dungeon.ts";

type Arm = "before" | "mid" | "after";

const VENOM_TURNS = 4;
const venomDmgAt = (d: number) => Math.min(3, Math.max(1, Math.round(d * 0.08)));
const cheb = (a: Pos, b: Pos) => Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));
const isFloor = (f: Floor, x: number, y: number) => x >= 0 && y >= 0 && x < f.w && y < f.h && f.tiles[y * f.w + x] === 1;
const occ = (f: Floor, x: number, y: number) => f.monsters.some((m) => m.hp > 0 && m.x === x && m.y === y);
const enemyAt = (f: Floor, x: number, y: number) => f.monsters.find((m) => m.hp > 0 && m.x === x && m.y === y);
const NB = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]] as const;

/** 敵 m の予告（intent=attack）が (x,y) を塗るか。cells（形つき/範囲）にも対応。 */
function intentHits(m: Monster, x: number, y: number): boolean {
  const it = m.intent; if (!it || it.type !== "attack") return false;
  if (it.cells) return it.cells.some((c) => c.x === x && c.y === y);
  return it.x === x && it.y === y;
}
/** (x,y) に立ったとき次手番に喰らう予告ダメージ合計（軽減後）。＝テレグラフ1手先読みの被弾見積り。 */
function threatAt(f: Floor, x: number, y: number, armor: number, ignore?: string): number {
  let sum = 0;
  for (const m of f.monsters) if (m.hp > 0 && m.id !== ignore && intentHits(m, x, y)) sum += Math.max(1, m.kind.dmg - armor);
  return sum;
}

function meleeChar(L: number, weaponDmg: number, armorRed: number): Character {
  const added = L - 1;
  const body = 2 + Math.ceil(added / 2), power = 2 + Math.floor(added / 2);
  return { name: "Sim", level: L, stats: { body, power, reason: 2, heart: 2 }, depth: L,
    equipment: { weapon: { dmg: weaponDmg }, armor: { reduce: armorRed }, relic: null, bag: null } } as unknown as Character;
}
const GEAR = (d: number) => ({ w: Math.round(d * 0.3) + 3, a: Math.round(d * 0.12) });

function makeWorld(diff: Difficulty, seed: number) {
  const w = newWorld((seed ^ 0xf0dde5) >>> 0); w.difficulty = diff; w.diveCount = seed % 5; return w;
}

/** アームに応じた genFloor opts（正：後加工でなく opts 切替）。 */
function genArm(depth: number, seed: number, arm: Arm): Floor {
  const w = makeWorld("normal", seed);
  const opts = arm === "before" ? { roomBias: 0, routeGuards: 0 }
    : arm === "mid" ? { routeGuards: 0 }
      : undefined; // after＝全機能 on
  return genFloor(w, depth, opts);
}

/** engine と同一の 4近傍BFS 最短路（stairsUp→stairsDown・DIRS 順も一致）。route[0]=上り, 末尾=下り。 */
function shortestRoute(f: Floor): Pos[] {
  const W = f.w, H = f.h, prev = new Int32Array(W * H).fill(-1);
  const start = f.stairsUp.y * W + f.stairsUp.x, goal = f.stairsDown.y * W + f.stairsDown.x;
  const q = [start]; prev[start] = start;
  const DIRS = [[0, -1], [1, 0], [0, 1], [-1, 0]] as const;
  for (let h = 0; h < q.length && prev[goal] === -1; h++) {
    const cur = q[h], cx = cur % W, cy = (cur / W) | 0;
    for (const [dx, dy] of DIRS) {
      const nx = cx + dx, ny = cy + dy;
      if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
      const ni = ny * W + nx;
      if (prev[ni] !== -1 || f.tiles[ni] !== 1) continue;
      prev[ni] = cur; q.push(ni);
    }
  }
  if (prev[goal] === -1) return [];
  const route: Pos[] = [];
  for (let cur = goal; cur !== start; cur = prev[cur]) route.push({ x: cur % W, y: (cur / W) | 0 });
  route.push({ x: f.stairsUp.x, y: f.stairsUp.y }); route.reverse();
  return route;
}

/** 壁のみを考慮した target からの BFS 距離場（進行度スコア用）。 */
function distField(f: Floor, target: Pos): Int32Array {
  const W = f.w, H = f.h, dist = new Int32Array(W * H).fill(-1);
  const si = target.y * W + target.x; dist[si] = 0;
  const q: Pos[] = [target];
  for (let h = 0; h < q.length; h++) {
    const c = q[h];
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
      const nx = c.x + dx, ny = c.y + dy;
      if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
      const i = ny * W + nx;
      if (dist[i] !== -1 || f.tiles[i] !== 1) continue;
      dist[i] = dist[c.y * W + c.x] + 1; q.push({ x: nx, y: ny });
    }
  }
  return dist;
}
type Room = { x: number; y: number; w: number; h: number };
const roomCenter = (r: Room): Pos => ({ x: r.x + (r.w >> 1), y: r.y + (r.h >> 1) });

interface Run {
  outcome: "REACH" | "DEATH" | "STALE";
  hpLostPct: number; tookHit: boolean; monsters0: number; peakAlive: number;
  engHist: number[];      // index=同時交戦数(awake敵 cheb≤2), value=そのターン数
  pressureTurns: number;  // 交戦(≥1)のターン数
  turnsGe2: number;       // ≥2 のターン数
  encounters: number;     // 道中で一度でも交戦（awake・cheb≤2）した敵の実数（＝実遭遇数）
}
/**
 * テレグラフ1手先読みの「decisive-dodge 踏破ボット」。mode で目的を切替える：
 *   "descend" ＝ stairsDown へ直行（＝速く降りるプレイの臨界経路露出を測る）。
 *   "explore" ＝ 敵の多い部屋 上位3室を訪ねてから stairsDown へ（＝部屋戦の体験を測る）。
 *   毎手：目標へ距離が縮む空きマスへ進む。前進先が予告なら同等進度で予告ゼロのマスへ横退避（避けられる一撃は避ける）。
 *   前方が敵で塞がれたら最短側の敵を殴って割る。＝膠着せず ~経路長で踏破し、避けられない被弾だけ受ける（＝緊張）。
 */
function traverse(f: Floor, depth: number, seed: number, healBudget: number, healAmt: number,
                  mode: "descend" | "explore", roomsGeom: Room[]): Run {
  const monsters0 = f.monsters.filter((m) => m.hp > 0).length;
  const ch = meleeChar(depth, GEAR(depth).w, GEAR(depth).a);
  const hpMax = maxHp(ch), dmg = meleeDmg(ch), armor = armorReduce(ch);
  let hp = hpMax, px = f.stairsUp.x, py = f.stairsUp.y, poison = 0, pd = 0, heals = 0, tookHit = false, peakAlive = monsters0;
  const engHist: number[] = [], engPush = (n: number) => { engHist[n] = (engHist[n] ?? 0) + 1; };
  let pressureTurns = 0, turnsGe2 = 0;
  const seen = new Set<string>();
  const rng = makeRng((seed ^ (depth * 40503) ^ 0x5a1d) >>> 0);

  let targets: Pos[] = [f.stairsDown];
  if (mode === "explore") {
    const explor = roomsGeom.filter((r) => cheb(roomCenter(r), f.stairsUp) > 3 && cheb(roomCenter(r), f.stairsDown) > 3);
    const withCount = explor.map((r) => ({ c: roomCenter(r),
      n: f.monsters.filter((m) => m.hp > 0 && m.x >= r.x && m.x < r.x + r.w && m.y >= r.y && m.y < r.y + r.h).length }));
    const top = withCount.filter((r) => r.n > 0).sort((a, b) => b.n - a.n).slice(0, 3).map((r) => r.c);
    top.sort((a, b) => cheb(a, f.stairsUp) - cheb(b, f.stairsUp));
    targets = [...top, f.stairsDown];
  }
  let ti = 0;
  let dist = distField(f, targets[ti]);
  const distAt = (x: number, y: number) => { const d = dist[y * f.w + x]; return d < 0 ? 1e9 : d; };
  const advanceTarget = () => { if (ti < targets.length - 1) { ti++; dist = distField(f, targets[ti]); } };

  planMonsters(f, { x: px, y: py }, rng);
  for (let turn = 1; turn <= 900; turn++) {
    if (px === targets[ti].x && py === targets[ti].y) {
      if (ti === targets.length - 1) return { outcome: "REACH", hpLostPct: Math.round(100 * (hpMax - hp) / hpMax), tookHit, monsters0, peakAlive, engHist, pressureTurns, turnsGe2, encounters: seen.size };
      advanceTarget();
    } else if (ti < targets.length - 1 && cheb({ x: px, y: py }, targets[ti]) <= 1) {
      advanceTarget();
    }
    peakAlive = Math.max(peakAlive, f.monsters.filter((m) => m.hp > 0).length);
    if (hp < hpMax * 0.35 && heals < healBudget) { hp = Math.min(hpMax, hp + Math.round(hpMax * healAmt)); heals++; }

    const engArr = f.monsters.filter((m) => m.hp > 0 && m.awake && cheb(m, { x: px, y: py }) <= 2);
    for (const m of engArr) seen.add(m.id);
    const engagers = engArr.length;
    engPush(engagers);
    if (engagers >= 1) pressureTurns++;
    if (engagers >= 2) turnsGe2++;

    const cur = distAt(px, py);
    const free = NB.map(([dx, dy]) => ({ x: px + dx, y: py + dy })).filter((c) => isFloor(f, c.x, c.y) && !occ(f, c.x, c.y));
    const prog = free.filter((c) => distAt(c.x, c.y) < cur).sort((a, b) => distAt(a.x, a.y) - distAt(b.x, b.y));
    if (prog.length) {
      let dest = prog[0];
      if (threatAt(f, dest.x, dest.y, armor) > 0) {
        const safe = free.filter((c) => distAt(c.x, c.y) <= distAt(dest.x, dest.y) + 1 && threatAt(f, c.x, c.y, armor) === 0)
          .sort((a, b) => distAt(a.x, a.y) - distAt(b.x, b.y));
        if (safe.length) dest = safe[0];
      }
      px = dest.x; py = dest.y;
    } else {
      let blk: Monster | undefined, bd = Infinity;
      for (const [dx, dy] of NB) { const e = enemyAt(f, px + dx, py + dy); if (e && distAt(px + dx, py + dy) < bd) { bd = distAt(px + dx, py + dy); blk = e; } }
      if (blk) blk.hp -= dmg;
      else { const s = [{ x: px, y: py }, ...free].sort((a, b) => threatAt(f, a.x, a.y, armor) - threatAt(f, b.x, b.y, armor))[0]; px = s.x; py = s.y; }
    }

    const res = resolveMonsters(f, { x: px, y: py });
    for (const h of res.hits) { if (h.target !== "player") continue;
      const took = Math.max(1, h.dmg - armor); hp -= took; tookHit = true;
      if (h.effect === "poison") { poison = VENOM_TURNS; pd = venomDmgAt(depth); } }
    if (poison > 0) { poison--; hp -= pd; if (pd > 0) tookHit = true; }
    if (hp <= 0) return { outcome: "DEATH", hpLostPct: 100, tookHit: true, monsters0, peakAlive, engHist, pressureTurns, turnsGe2, encounters: seen.size };
    planMonsters(f, { x: px, y: py }, rng);
  }
  return { outcome: "STALE", hpLostPct: Math.round(100 * (hpMax - hp) / hpMax), tookHit, monsters0, peakAlive, engHist, pressureTurns, turnsGe2, encounters: seen.size };
}

const SEEDS: number[] = [];
for (let s = 1; s <= 48; s++) SEEDS.push(s * 101 + 7);
const DEPTHS = [10, 20, 30, 40];
const ARMS: Arm[] = ["before", "mid", "after"];
const HEAL_BUDGET = 4, HEAL_AMT = 0.40;
const avg = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / (xs.length || 1);
const pct = (n: number, d: number) => Math.round(100 * n / (d || 1));
const median = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b); const n = s.length; return n ? (n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2) : 0; };

interface Agg {
  hpLost: number; clear: number; death: number; stale: number; zeroHit: number;
  ge2Frac: number; encounters: number; peakAlive: number; monsters0: number;
  engShare: number[]; // 交戦ターン(≥1)中の同時交戦数分布 %：index 1,2,3,4+
}
function aggregate(runs: Run[]): Agg {
  const n = runs.length;
  const pressureTot = runs.reduce((a, r) => a + r.pressureTurns, 0);
  const ge2Tot = runs.reduce((a, r) => a + r.turnsGe2, 0);
  const share = [0, 0, 0, 0];
  for (const r of runs) for (let k = 1; k < r.engHist.length; k++) {
    const c = r.engHist[k] ?? 0; if (!c) continue;
    if (k === 1) share[0] += c; else if (k === 2) share[1] += c; else if (k === 3) share[2] += c; else share[3] += c;
  }
  const shareTot = share.reduce((a, b) => a + b, 0);
  return {
    hpLost: Math.round(avg(runs.map((r) => r.hpLostPct))),
    clear: pct(runs.filter((r) => r.outcome === "REACH").length, n),
    death: pct(runs.filter((r) => r.outcome === "DEATH").length, n),
    stale: pct(runs.filter((r) => r.outcome === "STALE").length, n),
    zeroHit: pct(runs.filter((r) => !r.tookHit).length, n),
    ge2Frac: pct(ge2Tot, pressureTot),
    encounters: +avg(runs.map((r) => r.encounters)).toFixed(1),
    peakAlive: Math.round(avg(runs.map((r) => r.peakAlive))),
    monsters0: Math.round(avg(runs.map((r) => r.monsters0))),
    engShare: share.map((s) => pct(s, shareTot)),
  };
}

/** 1フロア（genFloor opts でアーム化）＋部屋幾何。traverse は before で部屋aggro off にする。 */
function armFloor(depth: number, seed: number, arm: Arm): { floor: Floor; rooms: Room[] } {
  const f = genArm(depth, seed, arm);
  const rooms = ((f.rooms ?? []) as Room[]).slice();
  if (arm === "before") (f as { rooms?: unknown }).rooms = undefined; // 部屋aggro を発火させない＝個別LOS起床（v0.150）
  return { floor: f, rooms };
}
function runArm(depth: number, arm: Arm, mode: "descend" | "explore"): Run[] {
  return SEEDS.map((s) => {
    const { floor, rooms } = armFloor(depth, s, arm);
    return traverse(floor, depth, s, HEAL_BUDGET, HEAL_AMT, mode, rooms);
  });
}

// ---- 構造メトリクス（bot 非依存） ----
interface RoomFill { perRoom: number; emptyPct: number; battlePct: number; fivePct: number; maxRoom: number; buckets: number[] }
function roomFill(depth: number, arm: Arm): RoomFill {
  const roomCounts: number[] = [];
  for (const s of SEEDS) {
    const { floor, rooms } = armFloor(depth, s, arm);
    const explor = rooms.filter((r) => cheb(roomCenter(r), floor.stairsUp) > 3 && cheb(roomCenter(r), floor.stairsDown) > 3);
    for (const r of explor) {
      const n = floor.monsters.filter((m) => m.hp > 0 && m.x >= r.x && m.x < r.x + r.w && m.y >= r.y && m.y < r.y + r.h).length;
      roomCounts.push(n);
    }
  }
  const tot = roomCounts.length || 1;
  const buckets = [
    pct(roomCounts.filter((n) => n === 0).length, tot),
    pct(roomCounts.filter((n) => n >= 1 && n <= 2).length, tot),
    pct(roomCounts.filter((n) => n >= 3 && n <= 4).length, tot),
    pct(roomCounts.filter((n) => n >= 5).length, tot),
  ];
  return {
    perRoom: +avg(roomCounts).toFixed(1),
    emptyPct: pct(roomCounts.filter((n) => n === 0).length, tot),
    battlePct: pct(roomCounts.filter((n) => n >= 3).length, tot),
    fivePct: pct(roomCounts.filter((n) => n >= 5).length, tot),
    maxRoom: Math.max(0, ...roomCounts),
    buckets,
  };
}
/** 最短路タイル上に初期配置で立つ敵の平均数（アーム別・bot 非依存）。 */
function routeOnCount(depth: number, arm: Arm): number {
  const vals: number[] = [];
  for (const s of SEEDS) {
    const { floor } = armFloor(depth, s, arm);
    const route = shortestRoute(floor);
    if (!route.length) { vals.push(0); continue; }
    const onPath = new Set(route.map((p) => p.x + "," + p.y));
    vals.push(floor.monsters.filter((m) => m.hp > 0 && onPath.has(m.x + "," + m.y)).length);
  }
  return +avg(vals).toFixed(2);
}
/** 経路ガードの再配置数（mid=routeGuards:0 と after=既定 を同一 world seed で二重生成し、id 突合で位置差分を数える）。
 *  ★mid/after は RNG 列が完全一致（route guards は RNG 非消費）。ただし後段 fodder の randomFloorAway は
 *    「占有マスを拒否（RNG非消費）」ゆえ、guard が動かした先/元の占有変化で fodder（f系・esc系）の着地が連鎖的にずれ、
 *    素朴な全 id 差分は過大計上になる。guard が動かすのは主配置枠（id="m{depth}_*"＝fodder より前に確定・以後不動）
 *    だけなので、この接頭辞に限定すれば guard の再配置ぶんだけを厳密に数えられる。 */
function relocationCounts(depth: number): number[] {
  const prefix = `m${depth}_`;
  return SEEDS.map((s) => {
    const after = genArm(depth, s, "after");
    const mid = genArm(depth, s, "mid");
    const midPos = new Map(mid.monsters.filter((m) => m.id.startsWith(prefix)).map((m) => [m.id, m.x + "," + m.y]));
    let moved = 0;
    for (const m of after.monsters) {
      if (!m.id.startsWith(prefix)) continue;
      const mp = midPos.get(m.id);
      if (mp !== undefined && mp !== m.x + "," + m.y) moved++;
    }
    return moved;
  });
}

const t3 = (b: number | string, m: number | string, a: number | string) => `${String(b).padStart(3)}→${String(m).padStart(3)}→${String(a).padStart(3)}`;

const t0 = Date.now();
console.log("=== 緊張感リワーク PR3（v0.152.0｜主経路ガード）受入検証 ===");
console.log(`  normal・テレグラフ先読み decisive-dodge bot（近接のみ・下限）・回復予算 ${HEAL_BUDGET}回×${Math.round(HEAL_AMT*100)}%・${SEEDS.length}seed`);
console.log("  before=v0.150（散布・aggro off）／mid=v0.151（大部屋集中＋aggro）／after=v0.152（＋主経路ガード）\n");

// ---- 事前計算（アーム×深度・モード別のアグリゲート／構造メトリクス）----
type PerDepth<T> = Record<number, T>;
const descAgg: PerDepth<Record<Arm, Agg>> = {}, explAgg: PerDepth<Record<Arm, Agg>> = {};
const fill: PerDepth<Record<Arm, RoomFill>> = {}, routeOn: PerDepth<Record<Arm, number>> = {}, reloc: PerDepth<number[]> = {};
for (const d of DEPTHS) {
  descAgg[d] = {} as Record<Arm, Agg>; explAgg[d] = {} as Record<Arm, Agg>;
  fill[d] = {} as Record<Arm, RoomFill>; routeOn[d] = {} as Record<Arm, number>;
  for (const arm of ARMS) {
    descAgg[d][arm] = aggregate(runArm(d, arm, "descend"));
    explAgg[d][arm] = aggregate(runArm(d, arm, "explore"));
    fill[d][arm] = roomFill(d, arm);
    routeOn[d][arm] = routeOnCount(d, arm);
  }
  reloc[d] = relocationCounts(d);
}

// ---- 表0｜構造：部屋の詰まり具合 ----
console.log("【表0｜構造】探索部屋の詰まり具合（bot非依存・before→mid→after）");
console.log("  深度 | 部屋あたり敵数 | 空室率%(スカスカ) | 大部屋3+体率% | 大部屋5+体率% | 最多部屋");
for (const d of DEPTHS) {
  const b = fill[d].before, m = fill[d].mid, a = fill[d].after;
  console.log(`  D${String(d).padStart(2)}  | ${t3(b.perRoom, m.perRoom, a.perRoom)} | ${t3(b.emptyPct, m.emptyPct, a.emptyPct)}%  | ${t3(b.battlePct, m.battlePct, a.battlePct)}% | ${t3(b.fivePct, m.fivePct, a.fivePct)}% | ${t3(b.maxRoom, m.maxRoom, a.maxRoom)}`);
}
console.log("  ── 部屋fill分布 [空0 / 1-2 / 3-4 / 5+]%");
for (const d of DEPTHS) {
  const b = fill[d].before, m = fill[d].mid, a = fill[d].after;
  console.log(`  D${String(d).padStart(2)} before[${b.buckets.join("/")}] mid[${m.buckets.join("/")}] after[${a.buckets.join("/")}]`);
}

// ---- 表1｜最短路の露出＋経路ガード再配置数 ----
console.log("\n【表1｜最短路の露出】最短路タイル上の初期敵数（before→mid→after）＋ 経路ガード再配置数");
console.log("  深度 | 経路上の初期敵数(平均) | 再配置数[中央値/最小/最大] | ガード設定値");
for (const d of DEPTHS) {
  const rc = reloc[d];
  const setPoint = d < 20 ? 2 : d < 30 ? 3 : 4;
  console.log(`  D${String(d).padStart(2)}  | ${t3(routeOn[d].before, routeOn[d].mid, routeOn[d].after)}      |   ${String(median(rc)).padStart(3)} / ${Math.min(...rc)} / ${Math.max(...rc)}         |   ${setPoint}`);
}

// ---- 表2｜直行プレイ（rush 難度）----
console.log("\n【表2｜直行】stairs 直行“速攻プレイ”bot ＝rush 難度（before→mid→after）");
console.log("  深度 |   HP損%      | CLEAR%      | DEATH%      | ゼロ被弾%    | 実遭遇数(before→mid→after) | 交戦T中≥2体率");
for (const d of DEPTHS) {
  const b = descAgg[d].before, m = descAgg[d].mid, a = descAgg[d].after;
  console.log(`  D${String(d).padStart(2)}  | ${t3(b.hpLost, m.hpLost, a.hpLost)}% | ${t3(b.clear, m.clear, a.clear)}% | ${t3(b.death, m.death, a.death)}% | ${t3(b.zeroHit, m.zeroHit, a.zeroHit)}% | ${t3(b.encounters, m.encounters, a.encounters)}       | ${t3(b.ge2Frac, m.ge2Frac, a.ge2Frac)}%`);
}

// ---- 表3｜探索プレイ（部屋戦の交戦構造）----
console.log("\n【表3｜探索】敵の多い部屋 上位3室を戦う“探索プレイ”bot ＝部屋戦の交戦構造（HP損/CLEARは下限では致死クリップ＝参考外）");
console.log("  深度 | HP損%(参考外)| CLEAR%(参考外)| ゼロ被弾%   | 交戦T中≥2体率 | 同時交戦分布[1/2/3/4+]% (after)");
for (const d of DEPTHS) {
  const b = explAgg[d].before, m = explAgg[d].mid, a = explAgg[d].after;
  console.log(`  D${String(d).padStart(2)}  | ${t3(b.hpLost, m.hpLost, a.hpLost)}% | ${t3(b.clear, m.clear, a.clear)}% | ${t3(b.zeroHit, m.zeroHit, a.zeroHit)}% | ${t3(b.ge2Frac, m.ge2Frac, a.ge2Frac)}% | [${a.engShare.join("/")}]`);
}

// ---- 表4｜密度天井（C の過剰チェック＋静的総数の不変性・hardcap 超過）----
console.log("\n【表4｜密度天井】静的敵総数（before→mid→after）＋ 生存ピーク ＋ HARDCAP 超過");
console.log("  深度 | monsterHardcap(normal) | 静的敵数(初期) | 生存ピーク(探索) | 最大初期敵数(全arm) | 超過?");
let hardcapExceed = 0;
for (const d of DEPTHS) {
  const cap = monsterHardcap(d, diffMods("normal"));
  const b = explAgg[d].before, m = explAgg[d].mid, a = explAgg[d].after;
  // 全アーム・全 seed の最大初期敵数（hardcap 超過検査）
  let mx = 0;
  for (const arm of ARMS) for (const s of SEEDS) mx = Math.max(mx, genArm(d, s, arm).monsters.filter((z) => z.hp > 0).length);
  const over = mx > cap; if (over) hardcapExceed++;
  console.log(`  D${String(d).padStart(2)}  |          ${String(cap).padStart(2)}            | ${t3(b.monsters0, m.monsters0, a.monsters0)}  |  ${t3(b.peakAlive, m.peakAlive, a.peakAlive)}   |        ${String(mx).padStart(2)}           | ${over ? "★超過" : "なし"}`);
}

// ---- 静的総数の不変性（mid==after 厳密／before vs mid）----
let midAfterEq = 0, beforeMidEq = 0, tot = 0;
for (const d of DEPTHS) for (const s of SEEDS) {
  const nb = genArm(d, s, "before").monsters.filter((z) => z.hp > 0).length;
  const nm = genArm(d, s, "mid").monsters.filter((z) => z.hp > 0).length;
  const na = genArm(d, s, "after").monsters.filter((z) => z.hp > 0).length;
  if (nm === na) midAfterEq++;
  if (nb === nm) beforeMidEq++;
  tot++;
}

// ==== 受入判定 ====
console.log("\n================ 受入条件の判定 ================");
const pf = (ok: boolean) => (ok ? "PASS" : "FAIL");

// 条件1：after の直行 CLEAR ≦ before比 +10pt（v0.151 の逆転の解消）
console.log("\n[条件1] 直行 CLEAR：after − before ≦ +10pt（v0.151 mid の rush 易化の解消）");
let c1 = true;
for (const d of DEPTHS) {
  const b = descAgg[d].before.clear, m = descAgg[d].mid.clear, a = descAgg[d].after.clear;
  const dMid = m - b, dAft = a - b, ok = dAft <= 10; c1 &&= ok;
  console.log(`  D${String(d).padStart(2)}: before ${b}% / mid ${m}%(Δ${dMid >= 0 ? "+" : ""}${dMid}) / after ${a}%(Δ${dAft >= 0 ? "+" : ""}${dAft})  → ${pf(ok)}`);
}
console.log(`  条件1 総合：${pf(c1)}`);

// 条件2：after の DEATH ≧ before比 −10pt 以内
console.log("\n[条件2] 直行 DEATH：after ≧ before − 10pt（beforeより10pt超は悪化させない）");
let c2 = true;
for (const d of DEPTHS) {
  const b = descAgg[d].before.death, a = descAgg[d].after.death;
  const delta = a - b, ok = delta >= -10; c2 &&= ok;
  console.log(`  D${String(d).padStart(2)}: before ${b}% / after ${a}%(Δ${delta >= 0 ? "+" : ""}${delta})  → ${pf(ok)}`);
}
console.log(`  条件2 総合：${pf(c2)}`);

// 条件3：大部屋3+率・5+率が mid 比で各 −2pt 以内（大部屋戦を殺さない）
console.log("\n[条件3] 大部屋3+率・5+率：after ≧ mid − 2pt（大部屋戦を殺していない）");
let c3 = true;
for (const d of DEPTHS) {
  const m = fill[d].mid, a = fill[d].after;
  const d3 = a.battlePct - m.battlePct, d5 = a.fivePct - m.fivePct, ok = d3 >= -2 && d5 >= -2; c3 &&= ok;
  console.log(`  D${String(d).padStart(2)}: 3+率 mid ${m.battlePct}%→after ${a.battlePct}%(Δ${d3 >= 0 ? "+" : ""}${d3}) / 5+率 mid ${m.fivePct}%→after ${a.fivePct}%(Δ${d5 >= 0 ? "+" : ""}${d5})  → ${pf(ok)}`);
}
console.log(`  条件3 総合：${pf(c3)}`);

// 条件4：経路上再配置数の中央値が 2〜4
console.log("\n[条件4] 経路ガード再配置数の中央値 ∈ [2,4]");
let c4 = true;
for (const d of DEPTHS) {
  const med = median(reloc[d]), setPoint = d < 20 ? 2 : d < 30 ? 3 : 4, ok = med >= 2 && med <= 4; c4 &&= ok;
  console.log(`  D${String(d).padStart(2)}: 中央値 ${med}（設定値 ${setPoint}・最小${Math.min(...reloc[d])}/最大${Math.max(...reloc[d])}）  → ${pf(ok)}`);
}
console.log(`  条件4 総合：${pf(c4)}`);

// 条件5：静的敵総数がアーム間で不変・hardcap 超過 0
console.log("\n[条件5] 静的敵総数の不変性 ＆ HARDCAP 超過 0");
const c5mid = midAfterEq === tot, c5cap = hardcapExceed === 0;
console.log(`  mid==after（PR3 は追加スポーンなし＝厳密一致すべき）：${midAfterEq}/${tot}（${pct(midAfterEq, tot)}%）  → ${pf(c5mid)}`);
console.log(`  before==mid（A の RNG 分岐で elite ロールが分かれ ±1 しうる＝参考）：${beforeMidEq}/${tot}（${pct(beforeMidEq, tot)}%）`);
console.log(`  HARDCAP 超過フロア数：${hardcapExceed}  → ${pf(c5cap)}`);
const c5 = c5mid && c5cap;
console.log(`  条件5 総合：${pf(c5)}`);

// 条件6：実行時間
const secs = ((Date.now() - t0) / 1000).toFixed(1);
const c6 = Number(secs) <= 300;
console.log(`\n[条件6] 実行時間：${secs}s（数分＝≤300s 目安）  → ${pf(c6)}`);

// ==== 総合 ====
const all = c1 && c2 && c3 && c4 && c5 && c6;
console.log("\n================ 総合判定 ================");
console.log(`  条件1(rush CLEAR):${pf(c1)}  条件2(DEATH):${pf(c2)}  条件3(大部屋戦):${pf(c3)}  条件4(再配置数):${pf(c4)}  条件5(総数/cap):${pf(c5)}  条件6(時間):${pf(c6)}`);
console.log(`  ★総合：${all ? "合格" : "要調整"}`);

console.log("\n※ before＝genFloor(roomBias:0,routeGuards:0)＋f.rooms 削除＝v0.150 近似（後加工でなく opts 切替が正）。");
console.log("※ bot＝情報完全の近接下限（術/会心/相棒/消耗品なし・通路へ引き込む腕は未再現）＝HP損は上限寄り・ゼロ被弾率は下限。");
console.log("※ explore の HP損/CLEAR は下限botでは部屋戦が構造的に致死＝参考外。有効信号は交戦構造（≥2体率・分布）。");

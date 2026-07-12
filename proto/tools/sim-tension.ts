// 緊張感リワーク フェーズ1（v0.151.0）の before/after 検証シム。
//   実行: cd proto && node --experimental-strip-types tools/sim-tension.ts
//
// 目的＝normal で「A｜部屋の広さ比例配置」「部屋aggro（入室一斉起床）」「C｜HARDCAP 深度スケール」を
//   織り込む前後で、①1フロア踏破の平均HP損失% ②同時交戦数（隣接敵数）の分布と『2体以上』頻度
//   ③被弾ゼロ踏破率 ④CLEAR(到達)率、がどう動くかを実 genFloor / planMonsters / resolveMonsters で実測する。
//
// 実装の要点（ツールのみ・engine 非改変）：
//   AFTER  = genFloor(normal) をそのまま踏破。f.rooms を保持＝planMonsters が部屋aggro を自動適用。
//            A（部屋比例配置）は genFloor 内で notEasy ゆえ自動適用。C（monsterHardcap 深部+）も normal で自動。
//   BEFORE = 同 seed で genFloor(normal) を生成し、v0.150 相当へ後退させる：
//            (1) 主配置ループの敵（id="m{depth}_*"）を全域ランダム散布へ置き直す（randomFloorAway）＝A を無効化。
//                ※fodder(f*) / 護衛(esc*) / ボス(boss*/elite*) は v0.150 でも存在＝据え置き。
//            (2) f.rooms を消す＝planMonsters の部屋aggro が発火しない＝個別LOS起床（従来）に戻す。
//            ※C（動的スポーン上限）は before/after とも normal 係数のまま＝静的敵数は同一（クローン）ゆえ
//              C の寄与は「踏破中の breeder/wanderer が到達しうる密度天井」に限られ、本試験の深度では周縁的。
//              → 静的敵数・同時交戦ピークを併記して C の密度天井が過剰でないかを別途可視化する。
//
// シムの限界（明記）：
//   ・プレイヤー=情報完全の下限bot（近接のみ・術/会心/相棒/消耗品なし・最寄り/最小HP優先の貪欲）。
//     ＝HP損は「上限（最悪寄り）」、被弾ゼロ率は「下限」。実プレイヤーは術/回復/位置取りで大きく上振れ。
//   ・通路チョークは実 genFloor の幅1 L字通路をそのまま使うので実機同等。ただし bot の経路は BFS 最短で、
//     人間が意図的に通路へ引き込む立ち回りは再現しない＝「1対1に持ち込む腕」は測っていない（構造的な遭遇の出方を測る）。
import { makeRng } from "../src/rng.ts";
import { planMonsters, resolveMonsters, genFloor, randomFloorAway, monsterHardcap } from "../src/dungeon.ts";
import { maxHp, meleeDmg, armorReduce } from "../src/progression.ts";
import { newWorld } from "../src/world.ts";
import { diffMods } from "../src/difficulty.ts";
import type { Difficulty } from "../src/difficulty.ts";
import type { Character } from "../src/types.ts";
import type { Floor, Monster, Pos } from "../src/dungeon.ts";

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

/** BEFORE 化：主配置ループの敵を全域散布へ戻し、部屋aggro を無効化（f.rooms 除去）。 */
function toBefore(f: Floor, depth: number, seed: number): Floor {
  const srng = makeRng((seed ^ 0xbef0a5) >>> 0);
  const prefix = `m${depth}_`;
  for (const m of f.monsters) {
    if (m.hp > 0 && m.id.startsWith(prefix)) {
      const np = randomFloorAway(f, srng, f.stairsUp, 5);
      if (np) { m.x = np.x; m.y = np.y; }
    }
  }
  (f as { rooms?: unknown }).rooms = undefined; // 部屋aggro を発火させない＝個別LOS起床（v0.150）
  return f;
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
}
/**
 * テレグラフ1手先読みの「decisive-dodge 踏破ボット」。mode で目的を切替える：
 *   "descend" ＝ stairsDown へ直行（＝速く降りるプレイの臨界経路露出を測る）。
 *   "explore" ＝ 各部屋の中心を順に訪ね（＝loot/探索プレイ）てから stairsDown へ（＝部屋戦の体験を測る）。
 *   毎手：目標へ距離が縮む空きマスへ進む。前進先が予告なら同等進度で予告ゼロのマスへ横退避（避けられる一撃は避ける）。
 *   前方が敵で塞がれたら最短側の敵を殴って割る。＝膠着せず ~経路長で踏破し、避けられない被弾だけ受ける（＝緊張）。
 * roomsGeom は探索対象の部屋矩形（before/after で幾何同一）。
 */
function traverse(f: Floor, depth: number, seed: number, healBudget: number, healAmt: number,
                  mode: "descend" | "explore", roomsGeom: Room[]): Run {
  const monsters0 = f.monsters.filter((m) => m.hp > 0).length;
  const ch = meleeChar(depth, GEAR(depth).w, GEAR(depth).a);
  const hpMax = maxHp(ch), dmg = meleeDmg(ch), armor = armorReduce(ch);
  let hp = hpMax, px = f.stairsUp.x, py = f.stairsUp.y, poison = 0, pd = 0, heals = 0, tookHit = false, peakAlive = monsters0;
  const engHist: number[] = [], engPush = (n: number) => { engHist[n] = (engHist[n] ?? 0) + 1; };
  let pressureTurns = 0, turnsGe2 = 0;
  const rng = makeRng((seed ^ (depth * 40503) ^ 0x5a1d) >>> 0);

  // 目標キュー：explore=「敵の多い部屋 上位3室」を近い順に訪ねて（＝rework が作る“戦場”を実地で戦う）→ stairsDown。
  //   ＝全室総なめ（＝全滅必至の非現実）でなく「道中いくつか loot する」現実的な探索プレイ。descend=stairsDown 直行。
  let targets: Pos[] = [f.stairsDown];
  if (mode === "explore") {
    const explor = roomsGeom.filter((r) => cheb(roomCenter(r), f.stairsUp) > 3 && cheb(roomCenter(r), f.stairsDown) > 3);
    const withCount = explor.map((r) => ({ c: roomCenter(r),
      n: f.monsters.filter((m) => m.hp > 0 && m.x >= r.x && m.x < r.x + r.w && m.y >= r.y && m.y < r.y + r.h).length }));
    const top = withCount.filter((r) => r.n > 0).sort((a, b) => b.n - a.n).slice(0, 3).map((r) => r.c);
    top.sort((a, b) => cheb(a, f.stairsUp) - cheb(b, f.stairsUp)); // 近い順に訪ねる
    targets = [...top, f.stairsDown];
  }
  let ti = 0;
  let dist = distField(f, targets[ti]);
  const distAt = (x: number, y: number) => { const d = dist[y * f.w + x]; return d < 0 ? 1e9 : d; };
  const advanceTarget = () => { if (ti < targets.length - 1) { ti++; dist = distField(f, targets[ti]); } };

  planMonsters(f, { x: px, y: py }, rng);
  for (let turn = 1; turn <= 900; turn++) {
    // 目標到達判定：最終目標(stairsDown)なら踏破成功、途中目標(部屋中心近傍)なら次へ。
    if (px === targets[ti].x && py === targets[ti].y) {
      if (ti === targets.length - 1) return { outcome: "REACH", hpLostPct: Math.round(100 * (hpMax - hp) / hpMax), tookHit, monsters0, peakAlive, engHist, pressureTurns, turnsGe2 };
      advanceTarget();
    } else if (ti < targets.length - 1 && cheb({ x: px, y: py }, targets[ti]) <= 1) {
      advanceTarget(); // 部屋中心の隣接まで来たら訪問済みとみなし次へ（中心が敵で埋まっていても前進）
    }
    peakAlive = Math.max(peakAlive, f.monsters.filter((m) => m.hp > 0).length);
    if (hp < hpMax * 0.35 && heals < healBudget) { hp = Math.min(hpMax, hp + Math.round(hpMax * healAmt)); heals++; }

    // 同時交戦数＝起床している生存敵で cheb≤2（＝迫っている数）。1体＝1対1／≥2＝群れ。
    const engagers = f.monsters.filter((m) => m.hp > 0 && m.awake && cheb(m, { x: px, y: py }) <= 2).length;
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
    if (hp <= 0) return { outcome: "DEATH", hpLostPct: 100, tookHit: true, monsters0, peakAlive, engHist, pressureTurns, turnsGe2 };
    planMonsters(f, { x: px, y: py }, rng);
  }
  return { outcome: "STALE", hpLostPct: Math.round(100 * (hpMax - hp) / hpMax), tookHit, monsters0, peakAlive, engHist, pressureTurns, turnsGe2 };
}

const SEEDS: number[] = [];
for (let s = 1; s <= 48; s++) SEEDS.push(s * 101 + 7);
const DEPTHS = [10, 20, 30, 40];
const HEAL_BUDGET = 4, HEAL_AMT = 0.40;
const avg = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / (xs.length || 1);
const pct = (n: number, d: number) => Math.round(100 * n / (d || 1));

interface Agg {
  runs: Run[];
  hpLost: number; clear: number; death: number; stale: number; zeroHit: number;
  ge2Frac: number; pressureTurns: number; peakAlive: number; monsters0: number;
  engShare: number[]; // 交戦ターン(≥1)中の同時交戦数分布 %：index 1,2,3,4+
}
function aggregate(runs: Run[]): Agg {
  const n = runs.length;
  const pressureTot = runs.reduce((a, r) => a + r.pressureTurns, 0);
  const ge2Tot = runs.reduce((a, r) => a + r.turnsGe2, 0);
  // 交戦ターン中の同時交戦数分布（1,2,3,4+）
  const share = [0, 0, 0, 0]; // 1,2,3,>=4
  for (const r of runs) for (let k = 1; k < r.engHist.length; k++) {
    const c = r.engHist[k] ?? 0; if (!c) continue;
    if (k === 1) share[0] += c; else if (k === 2) share[1] += c; else if (k === 3) share[2] += c; else share[3] += c;
  }
  const shareTot = share.reduce((a, b) => a + b, 0);
  return {
    runs,
    hpLost: Math.round(avg(runs.map((r) => r.hpLostPct))),
    clear: pct(runs.filter((r) => r.outcome === "REACH").length, n),
    death: pct(runs.filter((r) => r.outcome === "DEATH").length, n),
    stale: pct(runs.filter((r) => r.outcome === "STALE").length, n),
    zeroHit: pct(runs.filter((r) => !r.tookHit).length, n),
    ge2Frac: pct(ge2Tot, pressureTot),
    pressureTurns: Math.round(avg(runs.map((r) => r.pressureTurns))),
    peakAlive: Math.round(avg(runs.map((r) => r.peakAlive))),
    monsters0: Math.round(avg(runs.map((r) => r.monsters0))),
    engShare: share.map((s) => pct(s, shareTot)),
  };
}

/** 1フロア分の floor＋部屋幾何を作る（mode=before なら v0.150 化）。structural/traverse で共用。 */
function armFloor(depth: number, seed: number, arm: "before" | "after"): { floor: Floor; rooms: Room[] } {
  const w = makeWorld("normal", seed);
  const f = genFloor(w, depth);
  const rooms = ((f.rooms ?? []) as Room[]).slice(); // 幾何は before/after 同一
  if (arm === "before") toBefore(f, depth, seed);
  return { floor: f, rooms };
}
function runArm(depth: number, arm: "before" | "after", mode: "descend" | "explore"): Run[] {
  return SEEDS.map((s) => {
    const { floor, rooms } = armFloor(depth, s, arm);
    return traverse(floor, depth, s, HEAL_BUDGET, HEAL_AMT, mode, rooms);
  });
}

// ---- 構造メトリクス（bot 非依存）：部屋の「詰まり具合」＝『広い部屋がスカスカ』が埋まったか ----
//   ★平均『部屋あたり敵数』は総数・部屋数不変ゆえ before/after でほぼ同じ＝単独では大部屋集中の効果を隠す。
//     効果は「分布の二極化」に出る＝空室(0)が増え、同時に“戦場”(≥3・≥5)の割合と最多部屋が増える。
//     ゆえに fill 分布バケット [0 / 1-2 / 3-4 / 5+]% を併記してこの二極化を可視化する（＝問い a① の核）。
interface RoomFill { perRoom: number; emptyPct: number; battlePct: number; maxRoom: number; buckets: number[] }
function roomFill(depth: number, arm: "before" | "after"): RoomFill {
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
    emptyPct: pct(roomCounts.filter((n) => n === 0).length, roomCounts.length),
    battlePct: pct(roomCounts.filter((n) => n >= 3).length, roomCounts.length),
    maxRoom: Math.max(0, ...roomCounts),
    buckets,
  };
}

const arrow = (x: number | string, y: number | string) => `${String(x).padStart(3)}→${String(y).padStart(3)}`;

console.log("=== 緊張感リワーク フェーズ1（v0.151.0）before/after 検証 ===");
console.log(`  normal・テレグラフ先読み decisive-dodge bot（近接のみ・下限）・回復予算 ${HEAL_BUDGET}回×${Math.round(HEAL_AMT*100)}%・${SEEDS.length}seed`);
console.log("  before = A/aggro/C 前（主配置=全域散布・個別LOS起床）／after = 現ライブ（A 部屋比例配置＋部屋aggro＋C 天井）\n");

// ---- 構造（問い a②の核／bot非依存）----
console.log("【表0｜構造】探索部屋の詰まり具合（bot非依存＝『広い部屋がスカスカ』が埋まったか）");
console.log("  深度 | 部屋あたり敵数(before→after) | 空室率%(スカスカ) | ≥3体の“戦場”率% | 最多部屋");
for (const d of DEPTHS) {
  const b = roomFill(d, "before"), a = roomFill(d, "after");
  console.log(`  D${String(d).padStart(2)}  |   ${String(b.perRoom).padStart(4)} → ${String(a.perRoom).padStart(4)}          |  ${arrow(b.emptyPct, a.emptyPct)}%   |  ${arrow(b.battlePct, a.battlePct)}%    | ${arrow(b.maxRoom, a.maxRoom)}`);
}
console.log("  ── 部屋fill分布 [空0 / 1-2 / 3-4 / 5+]%（二極化＝大部屋集中の本体：空室が増え、同時に“戦場”が増える）");
for (const d of DEPTHS) {
  const b = roomFill(d, "before"), a = roomFill(d, "after");
  console.log(`  D${String(d).padStart(2)}  |  before [${b.buckets.join("/")}]  →  after [${a.buckets.join("/")}]`);
}

// ---- 探索プレイ（敵の多い部屋 上位3室を戦う＝rework が狙う体験）：問い (a)② の交戦構造 ----
//   ★HP損/CLEAR は下限bot（近接のみ・AoE/押し出し/会心なし）では部屋戦が構造的に致死＝クリップ（sim-sword の pack4-5 と整合）。
//   ＝この表の有効信号は「交戦T中≥2体率」と「同時交戦分布」（＝群れ度合いの構造・bot挙動に頑健）。HP/CLEAR は参考外。
console.log("\n【表1｜探索】敵の多い部屋 上位3室を戦う“探索プレイ” bot  ＝部屋戦の交戦構造（HP損/CLEARは下限では致死クリップ＝参考外）");
console.log("  深度 |  HP損%(参考外)| CLEAR% | ゼロ被弾%  | 交戦T中≥2体率 | 同時交戦分布[1/2/3/4+]%");
for (const d of DEPTHS) {
  const b = aggregate(runArm(d, "before", "explore"));
  const a = aggregate(runArm(d, "after", "explore"));
  console.log(`  D${String(d).padStart(2)}  | ${arrow(b.hpLost, a.hpLost)}% | ${arrow(b.clear, a.clear)}% | ${arrow(b.zeroHit, a.zeroHit)}%  |  ${arrow(b.ge2Frac, a.ge2Frac)}%   | b[${b.engShare.join("/")}] a[${a.engShare.join("/")}]`);
}

// ---- 直行プレイ（速く下りる＝臨界経路の露出）：rework が rush を難化/易化させたか ----
console.log("\n【表2｜直行】stairs へ直行する“速攻プレイ” bot  ＝臨界経路の露出（rush 難度）");
console.log("  深度 |   HP損%    | CLEAR%    | DEATH%    | ゼロ被弾%   | 交戦T中≥2体率");
for (const d of DEPTHS) {
  const b = aggregate(runArm(d, "before", "descend"));
  const a = aggregate(runArm(d, "after", "descend"));
  console.log(`  D${String(d).padStart(2)}  | ${arrow(b.hpLost, a.hpLost)}% | ${arrow(b.clear, a.clear)}% | ${arrow(b.death, a.death)}% | ${arrow(b.zeroHit, a.zeroHit)}%  |  ${arrow(b.ge2Frac, a.ge2Frac)}%`);
}

// ---- 密度天井：問い (c) C の過剰チェック ----
console.log("\n【表3｜密度天井】C｜HARDCAP 深度スケールの過剰チェック（探索プレイ）");
console.log("  深度 | monsterHardcap(easy/normal) | 静的敵数 | 踏破中の生存ピーク(before→after)");
for (const d of DEPTHS) {
  const b = aggregate(runArm(d, "before", "explore"));
  const a = aggregate(runArm(d, "after", "explore"));
  const capE = monsterHardcap(d, diffMods("easy")), capN = monsterHardcap(d, diffMods("normal"));
  console.log(`  D${String(d).padStart(2)}  |        ${String(capE).padStart(2)} / ${String(capN).padStart(2)}             |  ${arrow(b.monsters0, a.monsters0)}  |   ${arrow(b.peakAlive, a.peakAlive)}`);
}

console.log("\n※ before＝主配置ループ敵を全域散布へ戻し部屋aggro を切った v0.150 近似（fodder クラスタ/護衛/ボスは据置）。");
console.log("※ bot＝情報完全の近接下限（術/会心/相棒/消耗品なし・通路へ引き込む腕は未再現）＝HP損は上限寄り・ゼロ被弾率は下限。");
console.log("※ CLEAR/DEATH の絶対値は下限botゆえ厳しめ＝before→after の“差分”を読むこと（difficulty.ts の CLEAR≥45% 基準とは bot 強度が別）。");

// 武器比較シム（2026-07-11 初版／2026-07-17 PR2＝比較器の忠実度修正）。
//   sim-sword.ts を土台に、剣/槍/薙刀(現行)/薙刀(新案：十字距離2)の4クラスを web の戦闘ルールに忠実に実装し、
//   テレグラフ1手先読みで被弾最小化しつつ掃討する“最適プレイヤー”bot で arena/実地形 戦を戦わせ、
//   武器×深度×pack×地形×変種ごとに 無傷率/HP損/死亡率/STALE率/掃討率 を実測する。
//
//   ★2026-07-17 PR2＝外部レビュー起点の忠実度修正（このPRでは以下3点だけを直した。武器の数値・定数は一切変更していない）：
//     ① 薙刀(bar)の会心成立条件＝main.ts naginataSweep:5156-5221 は「中央(距離2直線)に敵がいて実際に meleeWithPositioning
//        を通した時」だけ crit が立つ（counterTurns の消費もそこでしか起きない）。旧 sim は counterRef.v>0 なら中央が
//        空でも crit=true 扱いにしてしまい、肩だけの命中でも押し出し/stagger が発生する誤り＝修正。
//     ② 剣の受け＝main.ts endTurn:5463-5487 は res.hits を配列順に見て「隣接・非heavy の最初の1発」だけを guard で
//        減衰する（最大威力の1発へ最適適用ではない）。旧 sim は「隣接ヒットの中で最大ダメージの1発」を選んで受けており、
//        本体より過大評価していた＝修正（threatAt の事前評価・実解決の両方）。
//     ③ 剣に踏み込み（main.ts lungeThrough:5091）を追加。bot に踏み込みが無いと、間合いを取り直す遠隔/長柄敵から
//        剣・槍が振り切れず、薙刀（射程2始動）だけが相対的に過大評価される＝剣botに「跡地/背後へ抜ける」候補を追加。
//     ＋ STALE（200手到達＝決着つかず）を死亡/掃討と分離集計（死%＋STALE%＋掃討%＝100%になるよう明示）。
//     ＋ 実 genFloor 由来の地形フィクスチャ（幅1通路・大部屋・混成＝部屋+接続通路）を追加。孤立壁のランダムarenaは
//        幅1通路のチョークを再現しないため、旧集計だけでは槍/薙刀の間合い・死角を見誤る＝実地形での paired 比較を主指標にする。
//        合成arenaは廃止せず「参考」として併記（既存の地形×深度の網羅比較はそのまま残す）。
//
//   ★被ダメは normal 式（chipFrac=0.20）＝main.ts:5485。押し出し(pushEnemy)＝会心のみ・敵をその攻撃射程外に出せば予告一撃キャンセル。
//   ★bot は情報完全（全intent既知）＝人間より上手い＝無傷率は「上限値」。相対比較（どの武器が強い/弱い）に使う。STALE は敗北ではない。
//
//   実行：cd proto && node --experimental-strip-types tools/sim-weapons.ts
import { makeRng } from "../src/rng.ts";
import { planMonsters, resolveMonsters, monsterCanReach, canBurstReach, scaleKind, MONSTER_KINDS, genFloor } from "../src/dungeon.ts";
import { maxHp, meleeDmg, armorReduce } from "../src/progression.ts";
import { diffMods } from "../src/difficulty.ts";
import type { Difficulty, DifficultyMods } from "../src/difficulty.ts";
import type { Character, World } from "../src/types.ts";
import type { Floor, Monster, MonsterKind, Pos } from "../src/dungeon.ts";

// ★武器の数値・定数はすべて本体(main.ts)と同値のまま＝一切変更していない。
const COUNTER_MULT = 1.2, COUNTER_WINDOW = 2, PUSH_WALL_DMG = 4, PUSH_COLLIDE_DMG = 2, SPEAR_ADJ_MUL = 0.5, NAGINATA_STAGGER = 1, NAG_SHOULDER = 0.8;
type WeaponKind = "sword" | "spear" | "naginata_cur" | "naginata_bar";
type LogicalWeapon = "sword" | "spear" | "naginata";
type GuardMode = "full" | "half" | "none";
type PushMode = "all" | "swordOnly";
interface Variant { name: string; guard: GuardMode; push: PushMode; naginata: "cur" | "bar"; swordCritMult?: number; swordShock?: boolean }
/** 論理武器「薙刀」を variant.naginata から実挙動へ解決（cur=旧・隣接3マス弧／bar=v0.150.0・距離2の横3マスバー・隣接は死角）。 */
function resolveWeapon(k: LogicalWeapon, v: Variant): WeaponKind { return k !== "naginata" ? k : v.naginata === "bar" ? "naginata_bar" : "naginata_cur"; }

function mkRnd(seed: number) { let s = seed >>> 0; return () => { s = (s + 0x6d2b79f5) | 0; let t = Math.imul(s ^ (s >>> 15), 1 | s); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const cheb = (ax: number, ay: number, bx: number, by: number) => Math.max(Math.abs(ax - bx), Math.abs(ay - by));
const isFloor = (f: Floor, x: number, y: number) => x >= 0 && y >= 0 && x < f.w && y < f.h && f.tiles[y * f.w + x] === 1;
const monAt = (f: Floor, x: number, y: number): Monster | undefined => f.monsters.find((m) => m.hp > 0 && m.x === x && m.y === y);
const occ = (f: Floor, x: number, y: number, exceptId?: string) => f.monsters.some((m) => m.hp > 0 && m.id !== exceptId && m.x === x && m.y === y);

const CROSS4: [number, number][] = [[1, 0], [-1, 0], [0, 1], [0, -1]];
const DIR8: [number, number][] = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];
const SWEEP_RING: [number, number][] = [[0, -1], [1, -1], [1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1]];

/** 深度相応プレイヤー（Lv≈深度）。武器 dmgOff：剣0／槍・薙刀 −1（剣比−1目安）。 */
function meleeChar(L: number, dmgOff: number): Character {
  const added = L - 1;
  const body = 2 + Math.ceil(added / 2), power = 2 + Math.floor(added / 2);
  const w = Math.round(L * 0.3) + 3 - dmgOff, a = Math.round(L * 0.12);
  return { name: "Sim", level: L, stats: { body, power, reason: 2, heart: 2 }, depth: L,
    equipment: { weapon: { dmg: w }, armor: { reduce: a }, relic: null, bag: null } } as unknown as Character;
}
/** 参考：孤立壁のランダム合成アリーナ（幅1通路のチョークは再現しない）。実地形フィクスチャの対照として残す。 */
function arena(size: number, wallFrac: number, rng: () => number): Floor {
  const w = size, h = size, tiles = new Array(w * h).fill(1);
  for (let x = 0; x < w; x++) { tiles[x] = 0; tiles[(h - 1) * w + x] = 0; }
  for (let y = 0; y < h; y++) { tiles[y * w] = 0; tiles[y * w + w - 1] = 0; }
  if (wallFrac > 0) for (let y = 2; y < h - 2; y++) for (let x = 2; x < w - 2; x++) { if (rng() < wallFrac) tiles[y * w + x] = 0; }
  return { w, h, tiles, monsters: [], fossils: [], chests: [], shrines: [], returnDoor: null, depth: 0, explored: new Array(w * h).fill(true), stairsUp: { x: 1, y: 1 }, stairsDown: { x: w - 2, y: h - 2 } } as unknown as Floor;
}

// ── 実 genFloor 由来の地形フィクスチャ（幅1通路・大部屋・混成） ─────────────────────────────
// 合成アリーナは孤立壁のランダム生成＝幅1通路のチョーク（槍/薙刀の間合いと死角の要）を再現しない。
// 本物の genFloor が吐く tiles をそのまま切り出し、同一 seed・同一盤面・同一 pack を全武器で共有して paired 比較する。
interface MapFixture { name: string; w: number; h: number; tiles: number[]; start: Pos; }
function floorFromFixture(fx: MapFixture): Floor {
  return { w: fx.w, h: fx.h, tiles: fx.tiles.slice(), monsters: [], fossils: [], chests: [], shrines: [], returnDoor: null, depth: 0, explored: new Array(fx.w * fx.h).fill(true), stairsUp: fx.start, stairsDown: fx.start } as unknown as Floor;
}
function cropFixture(src: Floor, x0: number, y0: number, x1: number, y1: number, start: Pos, name: string): MapFixture {
  const w = x1 - x0 + 1, h = y1 - y0 + 1;
  const tiles = new Array(w * h).fill(0);
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
    if (x >= 0 && y >= 0 && x < src.w && y < src.h) tiles[(y - y0) * w + (x - x0)] = src.tiles[y * src.w + x];
  }
  return { name, w, h, tiles, start: { x: start.x - x0, y: start.y - y0 } };
}
/** 幅1・両側が壁の床runを走査し、最長のものを切り出す（実 genFloor のL字通路そのもの）。 */
function findCorridorFixture(src: Floor): MapFixture | null {
  let best: { x0: number; y0: number; x1: number; y1: number; len: number } | null = null;
  for (let y = 1; y < src.h - 1; y++) {
    let s = -1;
    for (let x = 0; x <= src.w; x++) {
      const ok = x < src.w && isFloor(src, x, y) && !isFloor(src, x, y - 1) && !isFloor(src, x, y + 1);
      if (ok) { if (s < 0) s = x; }
      else if (s >= 0) { const len = x - s; if (len >= 6 && (!best || len > best.len)) best = { x0: s, y0: y, x1: x - 1, y1: y, len }; s = -1; }
    }
  }
  for (let x = 1; x < src.w - 1; x++) {
    let s = -1;
    for (let y = 0; y <= src.h; y++) {
      const ok = y < src.h && isFloor(src, x, y) && !isFloor(src, x - 1, y) && !isFloor(src, x + 1, y);
      if (ok) { if (s < 0) s = y; }
      else if (s >= 0) { const len = y - s; if (len >= 6 && (!best || len > best.len)) best = { x0: x, y0: s, x1: x, y1: y - 1, len }; s = -1; }
    }
  }
  if (!best) return null;
  const x0 = Math.max(0, best.x0 - 1), y0 = Math.max(0, best.y0 - 1);
  const x1 = Math.min(src.w - 1, best.x1 + 1), y1 = Math.min(src.h - 1, best.y1 + 1);
  return cropFixture(src, x0, y0, x1, y1, { x: best.x0, y: best.y0 }, `通路(実dungeon 幅1×${best.len})`);
}
/** 最大の部屋（Floor.rooms＝v0.151.0）をそのまま切り出す。 */
function findRoomFixture(src: Floor): MapFixture | null {
  const rooms = ((src as unknown as { rooms?: { x: number; y: number; w: number; h: number }[] }).rooms ?? []).filter((r) => r.w >= 6 && r.h >= 5);
  if (!rooms.length) return null;
  rooms.sort((a, b) => b.w * b.h - a.w * a.h);
  const r = rooms[0];
  const x0 = Math.max(0, r.x - 1), y0 = Math.max(0, r.y - 1), x1 = Math.min(src.w - 1, r.x + r.w), y1 = Math.min(src.h - 1, r.y + r.h);
  return cropFixture(src, x0, y0, x1, y1, { x: r.x + (r.w >> 1), y: r.y + (r.h >> 1) }, `大部屋(実dungeon ${r.w}x${r.h})`);
}
/** 中庸サイズの部屋からBFSで実際に辿れる範囲（＝部屋＋接続通路）を切り出す＝連結を保証した「混成」地形。 */
function findMixedFixture(src: Floor): MapFixture | null {
  const rooms = ((src as unknown as { rooms?: { x: number; y: number; w: number; h: number }[] }).rooms ?? []).filter((r) => r.w * r.h >= 9 && r.w * r.h <= 30);
  if (!rooms.length) return null;
  const r = rooms[Math.floor(rooms.length / 2)];
  const cx = r.x + (r.w >> 1), cy = r.y + (r.h >> 1);
  const seen = new Set<string>([`${cx},${cy}`]);
  const q: Pos[] = [{ x: cx, y: cy }];
  let qi = 0, minX = cx, maxX = cx, minY = cy, maxY = cy;
  while (qi < q.length && seen.size < 90) {
    const c = q[qi++];
    minX = Math.min(minX, c.x); maxX = Math.max(maxX, c.x); minY = Math.min(minY, c.y); maxY = Math.max(maxY, c.y);
    for (const [dx, dy] of CROSS4) {
      const nx = c.x + dx, ny = c.y + dy, k = `${nx},${ny}`;
      if (seen.has(k) || !isFloor(src, nx, ny)) continue;
      seen.add(k); q.push({ x: nx, y: ny });
    }
  }
  const x0 = Math.max(0, minX - 1), y0 = Math.max(0, minY - 1), x1 = Math.min(src.w - 1, maxX + 1), y1 = Math.min(src.h - 1, maxY + 1);
  return cropFixture(src, x0, y0, x1, y1, { x: cx, y: cy }, "混成(実dungeon 部屋+通路)");
}
function fakeWorld(seed: number): World {
  return { seed, generation: 0, diveCount: 0, difficulty: "normal", current: null, fossils: [], tracked: [], town: {} } as unknown as World;
}
/** depth ごとに数seed試し、最も条件に合う（長い通路／広い部屋／見つかり次第の混成）ものを採用。 */
function buildFixturesForDepth(depth: number): { corridor: MapFixture | null; room: MapFixture | null; mixed: MapFixture | null } {
  let corridor: MapFixture | null = null, room: MapFixture | null = null, mixed: MapFixture | null = null;
  for (let s = 1; s <= 6; s++) {
    const src = genFloor(fakeWorld((depth * 977 + s * 104729) >>> 0), depth);
    const c = findCorridorFixture(src); if (c && (!corridor || Math.max(c.w, c.h) > Math.max(corridor.w, corridor.h))) corridor = c;
    const r = findRoomFixture(src); if (r && (!room || r.w * r.h > room.w * room.h)) room = r;
    const m = findMixedFixture(src); if (m && !mixed) mixed = m;
  }
  return { corridor, room, mixed };
}

// ── 被ダメ（normal 式）：max(1, ceil(rawDmg*chip), rawDmg-armor)。rawDmg=max(1,kind.dmg)（scaleKind 済み）──
const rawDmg = (m: Monster) => Math.max(1, m.kind.dmg);
const takenFrom = (m: Monster, armor: number, chip: number) => Math.max(1, Math.ceil(rawDmg(m) * chip), rawDmg(m) - armor);
function intentHits(m: Monster, x: number, y: number): boolean {
  const it = m.intent; if (!it || it.type !== "attack") return false;
  if (it.cells) return it.cells.some((c) => c.x === x && c.y === y);
  return it.x === x && it.y === y;
}
/** クローン床（monsters を独立コピー＝候補評価で非破壊にpush/killを適用）。tiles は読み取り専用で共有。 */
function cloneFloor(f: Floor): Floor {
  return { ...f, monsters: f.monsters.map((m) => ({ ...m, intent: m.intent ? { ...m.intent } : m.intent })) } as Floor;
}
/** 押し出しの実適用（web pushEnemy 忠実：壁+4／敵衝突±2／空き移動＋射程外なら予告 wait 化）。
 *  ★export＝tools/qa-sim-push-parity.ts（PR2 parity 検証・2026-07-18）が runtime(main.ts pushEnemy) との
 *  一致を assert するために直接呼ぶ。武器の数値・挙動は一切変更していない（export のみの追加）。 */
export function realPush(f: Floor, E: Monster, px: number, py: number): void {
  const dx = Math.sign(E.x - px), dy = Math.sign(E.y - py); if (dx === 0 && dy === 0) return;
  const nx = E.x + dx, ny = E.y + dy;
  if (!isFloor(f, nx, ny)) { E.hp -= PUSH_WALL_DMG; }
  else if (occ(f, nx, ny, E.id) || (nx === px && ny === py)) {
    const other = f.monsters.find((mm) => mm.hp > 0 && mm.x === nx && mm.y === ny);
    if (other) { E.hp -= PUSH_COLLIDE_DMG; other.hp -= PUSH_COLLIDE_DMG; }
  } else {
    E.x = nx; E.y = ny;
    // v0.155 bug2 同期（main.ts:5090）：相対移動させた敵の“古い move 予告”を wait に潰す。さもないと後段の
    // resolveMonsters がその stale move を適用して押し出し位置を上書きする（薙刀の会心押し出し等を過小評価する乖離）。
    if (E.hp > 0 && E.intent?.type === "move") E.intent = { type: "wait" };
  }
  if (E.hp > 0 && E.intent?.type === "attack" && E.intent.x === px && E.intent.y === py) {
    const still = E.kind.ability === "burst" ? canBurstReach(f, E.x, E.y, px, py) : monsterCanReach(f, E.x, E.y, px, py, E.kind.reach ?? 1);
    if (!still) E.intent = { type: "wait" };
  }
}
/** main.ts pushBlocker(main.ts:5012) 相当（味方/相棒/召喚は sim では未モデル化＝対象外）。 */
function pushBlockerSim(f: Floor, x: number, y: number): "wall" | "enemy" | "clear" {
  if (!isFloor(f, x, y)) return "wall";
  if (occ(f, x, y)) return "enemy";
  return "clear";
}
/** ★MECH-3：main.ts lungeThrough(main.ts:5091) 忠実＝敵の跡地が空けばそこへ、塞がりで敵生存なら背後へ、どちらも塞がりはその場。 */
function lungeDest(f: Floor, mon: Monster, px: number, py: number, dx: number, dy: number): Pos {
  const sx = Math.sign(dx), sy = Math.sign(dy);
  const ox = mon.x, oy = mon.y;
  const bx = ox + sx, by = oy + sy;
  if (pushBlockerSim(f, ox, oy) === "clear") return { x: ox, y: oy };
  if (mon.hp > 0 && pushBlockerSim(f, bx, by) === "clear") return { x: bx, y: by };
  return { x: px, y: py };
}
/** 選択された攻撃を床に適用（会心＝counterRef 消費・押し出し／薙刀stagger）。base=meleeDmg（武器補正済み）。 */
function applyAttack(f: Floor, px: number, py: number, counterRef: { v: number }, dx: number, dy: number, weapon: WeaponKind, base: number, pushOn: boolean, swordCritMult = COUNTER_MULT, swordShock = false): void {
  const crit = counterRef.v > 0;
  const critMult = weapon === "sword" ? swordCritMult : COUNTER_MULT;
  const cdmg = crit ? Math.round(base * critMult) : base;
  if (weapon === "sword") {
    const E = monAt(f, px + dx, py + dy); if (!E) return;
    E.hp -= cdmg; if (crit) counterRef.v = 0;
    if (crit && pushOn && swordShock) { // 剣のみ会心で全隣接敵を押し出す（衝撃波＝群れの中で間合いを作る）
      for (const m of f.monsters) if (m.hp > 0 && cheb(px, py, m.x, m.y) <= 1) { realPush(f, m, px, py); }
    } else if (E.hp > 0 && crit && pushOn) realPush(f, E, px, py);
  } else if (weapon === "spear") {
    const mon = monAt(f, px + dx, py + dy);
    const mon2 = isFloor(f, px + dx, py + dy) ? monAt(f, px + 2 * dx, py + 2 * dy) : undefined;
    const primary = mon ?? mon2; if (!primary) return;
    let dmg = cdmg; if (crit) counterRef.v = 0;
    if (primary === mon) dmg = Math.max(1, Math.round(dmg * SPEAR_ADJ_MUL));
    primary.hp -= dmg;
    const secondary = mon && mon2 && mon2 !== primary ? mon2 : null;
    if (secondary) secondary.hp -= base;
    if (primary.hp > 0 && crit && pushOn) realPush(f, primary, px, py);
  } else if (weapon === "naginata_cur") {
    const E = monAt(f, px + dx, py + dy); if (!E) return;
    const ci = SWEEP_RING.findIndex(([rx, ry]) => rx === dx && ry === dy);
    const sides: Monster[] = [];
    if (ci >= 0) for (const off of [-1, 1]) { const [sx, sy] = SWEEP_RING[(ci + off + 8) % 8]; const sm = monAt(f, px + sx, py + sy); if (sm && sm !== E) sides.push(sm); }
    E.hp -= cdmg; if (crit) counterRef.v = 0;
    for (const sm of sides) sm.hp -= base;
    if (crit && pushOn) for (const m of [E, ...sides]) if (m.hp > 0) { realPush(f, m, px, py); m.stunned = Math.max(m.stunned ?? 0, NAGINATA_STAGGER); }
  } else {
    // naginata_bar（v0.150.0・main.ts naginataSweep:5156-5221）：中央=距離2直線／肩=距離2±1（常に80%・会心なし）。隣接=完全死角。
    // ★MECH-1 修正：会心は「中央(primary)がいて meleeWithPositioning 相当を通した時」だけ成立する（本体は
    //   `if (center) { const hitR = meleeWithPositioning(...); crit = hitR.crit; }` の内側でしか crit を立てない＝
    //   中央が空なら counterTurns（=counterRef.v）は一切消費されない）。旧 sim は counterRef.v>0 なら中央不在でも
    //   crit=true 扱いにしており、肩だけの命中でも押し出し/stagger が発生する誤りだった。
    const cx = px + 2 * dx, cy = py + 2 * dy;
    const [ox, oy] = dx === 0 ? [1, 0] : [0, 1];
    const primary = monAt(f, cx, cy);
    const s1 = monAt(f, cx + ox, cy + oy), s2 = monAt(f, cx - ox, cy - oy);
    const sides = [s1, s2].filter((s): s is Monster => !!s && s !== primary);
    if (!primary && sides.length === 0) return; // バーに敵なし＝薙げない（隣接の敵は斬れない）
    const sd = Math.max(1, Math.round(base * NAG_SHOULDER)); // 肩＝常に基礎ダメ80%（会心・proc なし）
    for (const sm of sides) sm.hp -= sd;
    let critCenter = false;
    if (primary) {
      critCenter = counterRef.v > 0; // 中央にだけ meleeWithPositioning 相当を適用
      const dmg = critCenter ? Math.round(base * critMult) : base;
      primary.hp -= dmg;
      if (critCenter) counterRef.v = 0;
    }
    if (critCenter && pushOn) for (const m of [primary, ...sides]) if (m && m.hp > 0) { realPush(f, m, px, py); m.stunned = Math.max(m.stunned ?? 0, NAGINATA_STAGGER); }
  }
}
/** 候補評価：この行動後（px,py で評価）の被弾見込み。guard=剣の受け（full=隣接1撃を無効化／half=半減）。
 *  ★MECH-2 修正：main.ts endTurn:5463-5487 は res.hits を配列順に見て「隣接・非heavy の最初の1発」だけを受ける
 *  （最大威力の1発を選んで最適適用するのではない）。旧実装は「隣接ヒットの中で最大ダメージの1発」を選んでおり過大評価だった。 */
function threatAt(f: Floor, px: number, py: number, armor: number, chip: number, guard: GuardMode | "off"): number {
  const hits: { d: number; adj: boolean; heavy: boolean }[] = [];
  for (const m of f.monsters) if (m.hp > 0 && intentHits(m, px, py)) hits.push({ d: takenFrom(m, armor, chip), adj: cheb(px, py, m.x, m.y) <= 1, heavy: (m.intent as { heavy?: boolean } | null)?.heavy === true });
  let sum = hits.reduce((a, h) => a + h.d, 0);
  if (guard === "full" || guard === "half") {
    const idx = hits.findIndex((h) => h.adj && !h.heavy); // main.ts:5463＝配列順で最初の1発
    if (idx >= 0) sum -= guard === "full" ? hits[idx].d : Math.floor(hits[idx].d / 2);
  }
  return sum;
}
/** 到達可能マスを距離昇順で返す（8方向BFS）。合成arena／実地形フィクスチャの両方で pack 配置に使う汎用の間合い分散。 */
function bfsOrder(f: Floor, start: Pos): Pos[] {
  const seen = new Set<string>([`${start.x},${start.y}`]);
  const q: Pos[] = [start];
  const out: Pos[] = [];
  let qi = 0;
  while (qi < q.length) {
    const c = q[qi++];
    for (const [dx, dy] of DIR8) {
      const nx = c.x + dx, ny = c.y + dy, k = `${nx},${ny}`;
      if (seen.has(k) || !isFloor(f, nx, ny)) continue;
      seen.add(k); out.push({ x: nx, y: ny }); q.push({ x: nx, y: ny });
    }
  }
  return out;
}

interface Run { cleared: boolean; died: boolean; stale: boolean; hpLostPct: number; noDamage: boolean; turns: number; atkless: number }
function fight(depth: number, weapon: WeaponKind, variant: Variant, pack: MonsterKind[], seed: number, wallFrac: number, mods: DifficultyMods, fixture?: MapFixture): Run {
  const arng = mkRnd((seed ^ 0xa5e4) >>> 0);
  const f = fixture ? floorFromFixture(fixture) : arena(13, wallFrac, arng);
  const dmgOff = weapon === "sword" ? 0 : 1;
  const ch = meleeChar(depth, dmgOff);
  const hpMax = maxHp(ch), base = meleeDmg(ch), armor = armorReduce(ch), chip = mods.chipFrac;
  const canGuard = weapon === "sword" && variant.guard !== "none";
  const pushOn = variant.push === "all" || weapon === "sword"; // swordOnly＝剣のみ押し出し（薙刀は stagger も失う）
  let hp = hpMax, px: number, py: number, counter = 0, dmgTotal = 0, atkless = 0;
  const rng = makeRng((seed ^ (depth * 40503) ^ 0x5c0d) >>> 0);
  if (fixture) { px = fixture.start.x; py = fixture.start.y; }
  else {
    px = 6; py = 6;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) f.tiles[(py + dy) * f.w + (px + dx)] = 1;
  }
  // pack 配置：@からのBFS距離順マスへ間引いて置く（合成arena/実地形フィクスチャ共通）。
  const order = bfsOrder(f, { x: px, y: py });
  pack.forEach((k, i) => {
    const p = order[(i * 2) % Math.max(1, order.length)] ?? order[i % Math.max(1, order.length)] ?? { x: px + 1, y: py };
    if (isFloor(f, p.x, p.y) && !(p.x === px && p.y === py) && !f.monsters.some((m) => m.x === p.x && m.y === p.y)) {
      f.monsters.push({ id: `m${i}`, kind: k, hp: k.hp, x: p.x, y: p.y, awake: true, intent: null } as Monster);
    }
  });

  planMonsters(f, { x: px, y: py }, rng);
  for (let turn = 1; turn <= 200; turn++) {
    if (!f.monsters.some((m) => m.hp > 0)) return { cleared: true, died: false, stale: false, hpLostPct: Math.round(100 * (hpMax - hp) / hpMax), noDamage: dmgTotal === 0, turns: turn, atkless };
    if (counter > 0) counter--;
    const alive = f.monsters.filter((m) => m.hp > 0);
    let nearD = Infinity; for (const m of alive) nearD = Math.min(nearD, cheb(px, py, m.x, m.y));

    type Cand = { kind: "attack" | "lunge" | "move" | "wait" | "guard"; dx: number; dy: number; dmg: number; kill: number; closer: number; setup: number; isAtk: number };
    const cands: Cand[] = [];
    const isBar = weapon === "naginata_bar";
    const dirs = (weapon === "spear" || isBar) ? CROSS4 : DIR8; // 槍・距離2薙刀は十字4方向のみ
    // 薙刀の間合い取り直しヒューリスティック：隣接（死角＋被弾源）を嫌い、距離2直線（次に薙げる）を好む。
    const naginataSetup = (nx: number, ny: number): number => {
      if (!isBar) return 0;
      let s = 0;
      for (const m of alive) { const dd = cheb(nx, ny, m.x, m.y); const card = nx === m.x || ny === m.y;
        if (dd <= 1) s -= 3; else if (dd === 2 && card) s += 3; else if (dd === 2) s += 1; }
      return s;
    };
    for (const [dx, dy] of dirs) {
      // 攻撃候補：クローンに適用し、掃討後の被弾見込みと撃破数を評価
      const cf = cloneFloor(f);
      const cRef = { v: counter };
      applyAttack(cf, px, py, cRef, dx, dy, weapon, base, pushOn, variant.swordCritMult ?? COUNTER_MULT, variant.swordShock ?? false);
      const killedNow = cf.monsters.filter((m) => m.hp <= 0).length;
      const origDead = f.monsters.filter((m) => m.hp <= 0).length;
      if (killedNow !== origDead || !sameHp(f, cf)) {
        const kills = killedNow - origDead;
        cands.push({ kind: "attack", dx, dy, dmg: threatAt(cf, px, py, armor, chip, "off"), kill: kills, closer: 0, setup: 5, isAtk: 1 });
      }
      // ★MECH-3：踏み込み（剣のみ・main.ts lungeThrough:5091）。crit/押し出しを捨てる代わりに敵の跡地/背後へ抜ける。
      //   逃げる（間合いを取り直す）遠隔/長柄敵を追う、または群れの中で位置を変える択。これが無いと剣・槍だけが
      //   「詰めても逃げられる」相手を過小評価し、薙刀（射程2始動＝そもそも詰める必要が薄い）が相対的に過大評価される。
      if (weapon === "sword") {
        const cf2 = cloneFloor(f);
        const E = monAt(cf2, px + dx, py + dy);
        if (E) {
          E.hp -= base; // lunge：meleeWithPositioning に lunge:true を渡すため crit は常に false（counter 非消費）
          const dest = lungeDest(cf2, E, px, py, dx, dy);
          cands.push({ kind: "lunge", dx, dy, dmg: threatAt(cf2, dest.x, dest.y, armor, chip, "off"), kill: E.hp <= 0 ? 1 : 0, closer: 0, setup: 2, isAtk: 1 });
        }
      }
    }
    if (!cands.some((c) => c.kind === "attack" || c.kind === "lunge")) atkless++; // 敵は生存中なのに一手も攻撃できない＝薙刀のストレス指標
    if (canGuard && alive.some((m) => intentHits(m, px, py) && cheb(px, py, m.x, m.y) <= 1)) {
      cands.push({ kind: "guard", dx: 0, dy: 0, dmg: threatAt(f, px, py, armor, chip, variant.guard), kill: 0, closer: 0, setup: 0, isAtk: 0 });
    }
    for (const [dx, dy] of [[0, 0], ...DIR8] as [number, number][]) {
      const nx = px + dx, ny = py + dy;
      if (!(dx === 0 && dy === 0)) { if (!isFloor(f, nx, ny) || occ(f, nx, ny)) continue; }
      let nd = Infinity; for (const m of alive) nd = Math.min(nd, cheb(nx, ny, m.x, m.y));
      cands.push({ kind: dx === 0 && dy === 0 ? "wait" : "move", dx, dy, dmg: threatAt(f, nx, ny, armor, chip, "off"), kill: 0, closer: nearD - nd, setup: naginataSetup(nx, ny), isAtk: 0 });
    }
    // 薙刀は setup（距離2直線を作る／隣接を避ける）を closer より優先＝敵に張り付かれても間合いを取り直す割り切り。
    cands.sort((a, b) => a.dmg - b.dmg || b.kill - a.kill || b.setup - a.setup || b.closer - a.closer || b.isAtk - a.isAtk);
    const act = cands[0];

    let guardArmed = false;
    if (act.kind === "attack") { const cRef = { v: counter }; applyAttack(f, px, py, cRef, act.dx, act.dy, weapon, base, pushOn, variant.swordCritMult ?? COUNTER_MULT, variant.swordShock ?? false); counter = cRef.v; }
    else if (act.kind === "lunge") {
      const E = monAt(f, px + act.dx, py + act.dy);
      if (E) { E.hp -= base; const dest = lungeDest(f, E, px, py, act.dx, act.dy); px = dest.x; py = dest.y; }
    }
    else if (act.kind === "guard") { guardArmed = true; }
    else { px += act.dx; py += act.dy; }

    const res = resolveMonsters(f, { x: px, y: py });
    // ★MECH-2：guard 中は res.hits の配列順で「隣接・非heavy の最初の1発」だけを full=無効化／half=半減（＋反撃の好機）。
    const playerHits = res.hits.filter((h) => h.target === "player");
    let guardIdx = -1;
    if (guardArmed && (variant.guard === "full" || variant.guard === "half")) {
      for (let i = 0; i < playerHits.length; i++) {
        const h = playerHits[i];
        if (h.effect !== "heavy" && cheb(px, py, h.monster.x, h.monster.y) <= 1) { guardIdx = i; break; }
      }
      if (guardIdx >= 0) counter = COUNTER_WINDOW;
    }
    for (let i = 0; i < playerHits.length; i++) {
      let d = takenFrom(playerHits[i].monster, armor, chip);
      if (i === guardIdx) d = variant.guard === "full" ? 0 : Math.ceil(d * 0.5); // main.ts:5487＝防具軽減後に半減
      hp -= d; dmgTotal += d;
    }
    if (res.dodges.length > 0 && hp > 0) counter = COUNTER_WINDOW;
    if (hp <= 0) return { cleared: false, died: true, stale: false, hpLostPct: 100, noDamage: false, turns: turn, atkless };
    planMonsters(f, { x: px, y: py }, rng);
  }
  return { cleared: false, died: false, stale: true, hpLostPct: Math.round(100 * (hpMax - hp) / hpMax), noDamage: dmgTotal === 0, turns: 200, atkless };
}
function sameHp(a: Floor, b: Floor): boolean { for (let i = 0; i < a.monsters.length; i++) if (a.monsters[i].hp !== b.monsters[i].hp || a.monsters[i].x !== b.monsters[i].x || a.monsters[i].y !== b.monsters[i].y) return false; return true; }

// ── pack 構成：注目種（形つき arc/slam/beam・突進 charge・長柄 reach2・炸裂 burst）を必ず混ぜる ──
function makePack(depth: number, mods: DifficultyMods, size: number, rng: () => number): MonsterKind[] {
  const pool = MONSTER_KINDS.filter((k) => k.minDepth <= depth && (k.maxDepth === undefined || depth <= k.maxDepth) && k.minDepth <= 50);
  const notable = (k: MonsterKind) => !!k.ability && ["arc", "slam", "beam", "burst", "charge"].includes(k.ability) || (k.reach ?? 1) >= 2;
  const weight = (k: MonsterKind) => {
    const ab = k.ability;
    if (ab === "arc" || ab === "slam" || ab === "beam") return 4;
    if (ab === "charge" || (k.reach ?? 1) >= 2) return 3;
    if (ab === "ranged") return 2;
    if (ab === "burst") return 1;
    return 1;
  };
  const wpool: MonsterKind[] = []; for (const k of pool) for (let i = 0; i < weight(k); i++) wpool.push(k);
  const out: MonsterKind[] = [];
  for (let i = 0; i < size; i++) out.push(wpool[Math.floor(rng() * wpool.length)]);
  // size>=2 で注目種が0なら末尾を差し替え（必ず混ぜる）
  if (size >= 2 && !out.some(notable)) { const nk = pool.filter(notable); if (nk.length) out[out.length - 1] = nk[Math.floor(rng() * nk.length)]; }
  return out.map((k) => scaleKind(k, depth, mods));
}

// ---------- 集計 ----------
interface CellStat { noDmg: number; avgHp: number; death: number; stale: number; clrT: number; clr: number; stall: number; }
function aggregate(runs: Run[]): CellStat {
  const n = runs.length;
  const noDmg = Math.round(100 * runs.filter((r) => r.cleared && r.noDamage).length / n);
  const avgHp = Math.round(runs.reduce((a, r) => a + r.hpLostPct, 0) / n);
  const death = Math.round(100 * runs.filter((r) => r.died).length / n);
  const stale = Math.round(100 * runs.filter((r) => r.stale).length / n); // ★死亡/掃討と分離（決着つかず＝敗北ではない）
  const cleared = runs.filter((r) => r.cleared);
  const clrT = cleared.length ? Math.round(cleared.reduce((a, r) => a + r.turns, 0) / cleared.length) : 0;
  const totTurns = runs.reduce((a, r) => a + r.turns, 0);
  const stall = Math.round(100 * runs.reduce((a, r) => a + r.atkless, 0) / Math.max(1, totTurns)); // 攻撃不能手番の割合(%)
  return { noDmg, avgHp, death, stale, clrT, clr: Math.round(100 * cleared.length / n), stall };
}
const cellCache = new Map<string, CellStat>();

// ---------- 実行 ----------
const SEEDS = Array.from({ length: 60 }, (_, i) => i + 1);
const DEPTHS = [10, 20, 30];
const PACKS = [1, 2, 3, 5];
const DIFF: Difficulty = "normal";
const MODS = diffMods(DIFF);
const TERRAIN = [{ name: "開所", wall: 0 }, { name: "障害物", wall: 0.18 }];
const WEAPONS: { k: LogicalWeapon; label: string }[] = [
  { k: "sword", label: "剣    " }, { k: "spear", label: "槍    " },
  { k: "naginata", label: "薙刀  " },
];
// LIVE＝ユーザー承認・main.ts 実装済みの v0.150.0 仕様（剣:受half+会心衝撃波／薙刀:距離2の横3マスバー・肩80%・隣接死角）。
// 参考＝薙刀だけ旧仕様(隣接3マス弧)に差し替えた対照（剣・槍は LIVE と同一）＝改定の delta を見る。
const VARIANTS: Variant[] = [
  { name: "LIVE v0.150(剣:受half+会心衝撃波／薙刀:距離2バー・肩80%・隣接死角)", guard: "half", push: "all", naginata: "bar", swordShock: true },
  { name: "参考:旧薙刀(隣接3マス弧／剣・槍は LIVE と同一)", guard: "half", push: "all", naginata: "cur", swordShock: true },
];

function cell(depth: number, wk: LogicalWeapon, variant: Variant, size: number, wallFrac: number): CellStat {
  const key = `A|${depth}|${wk}|${variant.name}|${size}|${wallFrac}`;
  const hit = cellCache.get(key); if (hit) return hit;
  const weapon = resolveWeapon(wk, variant);
  const runs = SEEDS.map((s) => {
    const rnd = mkRnd((s ^ (depth << 8) ^ (size << 16) ^ (Math.round(wallFrac * 100) << 22)) >>> 0);
    const pack = makePack(depth, MODS, size, rnd);
    return fight(depth, weapon, variant, pack, s, wallFrac, MODS);
  });
  const stat = aggregate(runs); cellCache.set(key, stat); return stat;
}
function cellFixture(fx: MapFixture, tag: string, depth: number, wk: LogicalWeapon, variant: Variant, size: number, seeds: number[]): CellStat {
  const key = `F|${tag}|${depth}|${wk}|${variant.name}|${size}`;
  const hit = cellCache.get(key); if (hit) return hit;
  const weapon = resolveWeapon(wk, variant);
  const runs = seeds.map((s) => {
    const rnd = mkRnd((s ^ (depth << 8) ^ (size << 16) ^ 0x9e3779) >>> 0);
    const pack = makePack(depth, MODS, size, rnd);
    return fight(depth, weapon, variant, pack, s, 0, MODS, fx);
  });
  const stat = aggregate(runs); cellCache.set(key, stat); return stat;
}

console.log("武器比較シム＝テレグラフ1手先読みで被弾最小化する“最適プレイヤー”（上限値）。難易度normal・注目種(形/突進/長柄/炸裂)を必ず混入。");
console.log("  剣=万能8方向(受け半減+会心衝撃波=全隣接押出+踏み込み)／槍=十字距離1-2貫通(距離1×0.5・剣比dmg-1)／薙刀(v0.150 bar)=十字距離2の横3マスバー・中央100%/肩80%・隣接(距離1)は完全死角・剣比dmg-1。");
console.log("  ★PR2 忠実度修正＝①薙刀の会心は中央ヒット限定②受けは配列順で最初の隣接1発のみ③剣に踏み込み(lungeThrough)を追加。詳細はファイル冒頭コメント。武器の数値は無変更。\n");
console.log("  各セル表記＝ 無傷%|HP損%|死N%|停N%|掃N% （無傷=被弾ゼロ掃討率／HP損=maxHp比平均／死=死亡率／停=STALE=200手決着つかず／掃=クリア率。死+停+掃=100%）\n");

// ======== ① 実地形フィクスチャ比較（本命：genFloor 実配置・paired） ========
console.log("\n\n======== ①実地形フィクスチャ比較（genFloor実配置。同depth内は同fixture/同seed/同packを全武器で共有＝paired）========");
const SEEDS_FX = Array.from({ length: 30 }, (_, i) => i + 1);
const FX_VARIANT = VARIANTS[0]; // LIVE のみ（本体一致の検証が目的）
const FX_BY_DEPTH = new Map<number, ReturnType<typeof buildFixturesForDepth>>();
for (const depth of DEPTHS) FX_BY_DEPTH.set(depth, buildFixturesForDepth(depth));

for (const depth of DEPTHS) {
  const fx = FX_BY_DEPTH.get(depth)!;
  console.log(`\n  ── D${depth} ──`);
  for (const [tag, f] of [["通路", fx.corridor], ["大部屋", fx.room], ["混成", fx.mixed]] as [string, MapFixture | null][]) {
    if (!f) { console.log(`   ${tag}: (該当地形が見つからず・このdepthはスキップ)`); continue; }
    console.log(`   ${tag}[${f.w}x${f.h}] "${f.name}"   pack:  1体                    2体                    3体                    5体`);
    for (const w of WEAPONS) {
      const cols = PACKS.map((sz) => { const c = cellFixture(f, `${tag}${depth}`, depth, w.k, FX_VARIANT, sz, SEEDS_FX); return `${String(c.noDmg).padStart(3)}|${String(c.avgHp).padStart(2)}|死${String(c.death).padStart(2)}|停${String(c.stale).padStart(2)}|掃${String(c.clr).padStart(3)}`; });
      console.log(`      ${w.label}        ${cols.join("   ")}`);
    }
  }
}

console.log("\n\n======== 武器序列＝①実地形フィクスチャ 全セル平均（3地形×3深度×4pack＝旧集計(剣67/槍33/薙刀85)との比較用）========");
{
  const sums: Record<LogicalWeapon, { nd: number; hp: number; dt: number; st: number; cl: number; n: number }> = {
    sword: { nd: 0, hp: 0, dt: 0, st: 0, cl: 0, n: 0 }, spear: { nd: 0, hp: 0, dt: 0, st: 0, cl: 0, n: 0 }, naginata: { nd: 0, hp: 0, dt: 0, st: 0, cl: 0, n: 0 },
  };
  for (const depth of DEPTHS) {
    const fx = FX_BY_DEPTH.get(depth)!;
    for (const [tag, f] of [["通路", fx.corridor], ["大部屋", fx.room], ["混成", fx.mixed]] as [string, MapFixture | null][]) {
      if (!f) continue;
      for (const w of WEAPONS) for (const sz of PACKS) {
        const c = cellFixture(f, `${tag}${depth}`, depth, w.k, FX_VARIANT, sz, SEEDS_FX);
        const s = sums[w.k]; s.nd += c.noDmg; s.hp += c.avgHp; s.dt += c.death; s.st += c.stale; s.cl += c.clr; s.n++;
      }
    }
  }
  console.log("  武器 :  無傷%平均 / HP損%平均 / 死%平均 / STALE%平均 / 掃討%平均");
  for (const w of WEAPONS) {
    const s = sums[w.k];
    console.log(`   ${w.label}:  ${(s.nd / s.n).toFixed(0).padStart(3)}    /  ${(s.hp / s.n).toFixed(0).padStart(3)}   /  ${(s.dt / s.n).toFixed(0).padStart(3)}  /  ${(s.st / s.n).toFixed(0).padStart(3)}      /  ${(s.cl / s.n).toFixed(0).padStart(3)}`);
  }
}
console.log("  読み方：無傷%高＝被弾ゼロで捌ける（強い）。死%高＝崩れる（弱い）。STALE%高＝倒し切れず長引く（間合いを作れているが火力/命中機会が足りない＝弱さの別側面、死とは違う）。掃討%＝クリア到達率。");

// ======== ②参考：合成アリーナ（孤立壁・ランダムwall。幅1通路のチョークは非再現） ========
console.log("\n\n======== ②参考：合成アリーナ（孤立壁のランダムwall・幅1通路チョークは非再現＝旧来の比較） ========");
for (const v of VARIANTS) {
  console.log(`\n############ ${v.name} ############`);
  for (const t of TERRAIN) {
    for (const depth of DEPTHS) {
      console.log(`  ── ${t.name} D${depth} ──   pack:  1体                 2体                 3体                 5体`);
      for (const w of WEAPONS) {
        const cols = PACKS.map((sz) => { const c = cell(depth, w.k, v, sz, t.wall); return `${String(c.noDmg).padStart(3)}|${String(c.avgHp).padStart(2)}|死${String(c.death).padStart(2)}|停${String(c.stale).padStart(2)}|掃${String(c.clr).padStart(3)}`; });
        console.log(`     ${w.label}              ${cols.join("  ")}`);
      }
    }
  }
}
// ── 全セル平均の武器序列（2地形×3深度×4pack=24セル平均・pack1〜5込み）──
console.log("\n\n======== 武器序列＝②合成アリーナ 全24セル(2地形×3深度×4pack)平均 ========");
for (const v of VARIANTS) {
  console.log(`\n[${v.name}]  武器 :  無傷%平均 / HP損%平均 / 死%平均 / STALE%平均 / 掃討%平均`);
  for (const w of WEAPONS) {
    let nd = 0, hp = 0, dt = 0, st = 0, cl = 0, n = 0;
    for (const t of TERRAIN) for (const depth of DEPTHS) for (const sz of PACKS) { const c = cell(depth, w.k, v, sz, t.wall); nd += c.noDmg; hp += c.avgHp; dt += c.death; st += c.stale; cl += c.clr; n++; }
    console.log(`   ${w.label}:  ${(nd / n).toFixed(0).padStart(3)}    /  ${(hp / n).toFixed(0).padStart(3)}   /  ${(dt / n).toFixed(0).padStart(3)}  /  ${(st / n).toFixed(0).padStart(3)}      /  ${(cl / n).toFixed(0).padStart(3)}`);
  }
}
console.log("\n読み方：無傷%高＝その武器で被弾ゼロで捌ける（=強い）。HP損%・死%高＝崩れやすい（=弱い）。掃討%低＋STALE%高＝倒し切れない（間合いは作れるが決定力不足）。");
console.log("bot は情報完全＝実プレイヤーより上手い＝無傷%は上限。相対（武器間の優劣）を見る。STALE は敗北ではなく「決着がつかない」の別枠。");

// ── 薙刀ストレス指標（答え(d)）＝『距離2を作れず一手も薙げない』手番の割合(%)。高い＝間合い取り直しで手を空費＝ストレス ──
console.log("\n\n======== 薙刀(bar)ストレス＝攻撃不能手番の割合(%)〔敵生存中に一手も薙げなかった手番/総手番〕（②合成アリーナ基準）========");
console.log("  ※高いほど『隣接に張り付かれ間合いを作れない』＝ストレス。地形×深度×pack別（LIVE v0.150 の薙刀のみ）。");
for (const t of TERRAIN) {
  console.log(`  ── ${t.name} ──   pack:  1体    2体    3体    5体`);
  for (const depth of DEPTHS) {
    const cols = PACKS.map((sz) => `${String(cell(depth, "naginata", VARIANTS[0], sz, t.wall).stall).padStart(3)}%`);
    console.log(`     D${String(depth).padStart(2)}                ${cols.join("   ")}`);
  }
}
console.log("\n★シムの限界：bot は全 intent 既知＝無傷%は上限（人間はもっと被弾）／②の合成アリーナは幅1通路のチョークを再現せず＝①の実地形フィクスチャで補う／");
console.log("  持ち替え・押し出しの読み合い・押し出しキャンセルの妙手は近似（bot は薙刀では持ち替えず『退く』でのみ間合いを取る。剣の踏み込みは MECH-3 準拠で追加済み）。");

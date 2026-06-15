// ダンジョン層：フロア生成・視界(FOV)・モンスター（UI非依存の純ロジック）
// フロアは world.seed × 世代 × 深度 から決定論的に生成される。

import { makeRng, type Rng } from "./rng.ts";
import type { World, Fossil } from "./types.ts";

// 表示ビューポート（DOMグリッド）のサイズ。マップ自体はこれより大きく、カメラが @ を追う。
export const VIEW_W = 21;
export const VIEW_H = 23;

export type Tile = 0 | 1; // 0=岩盤(壁) 1=床
export interface Pos { x: number; y: number; }

export interface MonsterKind {
  key: string; glyph: string; name: string;
  hp: number; dmg: number; minDepth: number; erratic: number; // erratic=ランダム移動率
  tier: number; // 強さの段（1=雑魚 … 5=最危険）。記号=種類／色=tier で可視化（4-11F）。
}
// 記号＝種類（小文字=並／大文字=強）、色＝tier。深いほど上位種が混じり緊張感が増す。
export const MONSTER_KINDS: MonsterKind[] = [
  { key: "rat",    glyph: "r", name: "大鼠",     hp: 3,  dmg: 1, minDepth: 1,  erratic: 0.3,  tier: 1 },
  { key: "beetle", glyph: "k", name: "鎧蟲",     hp: 8,  dmg: 1, minDepth: 1,  erratic: 0.1,  tier: 2 }, // 硬い・低火力（一撃で倒せない壁）
  { key: "bat",    glyph: "b", name: "洞蝙蝠",   hp: 2,  dmg: 1, minDepth: 2,  erratic: 0.6,  tier: 1 },
  { key: "snake",  glyph: "s", name: "石蛇",     hp: 5,  dmg: 2, minDepth: 5,  erratic: 0.2,  tier: 2 },
  { key: "ghoul",  glyph: "g", name: "屍喰らい", hp: 7,  dmg: 2, minDepth: 9,  erratic: 0.1,  tier: 3 },
  { key: "wisp",   glyph: "w", name: "迷い火",   hp: 4,  dmg: 3, minDepth: 13, erratic: 0.4,  tier: 3 },
  { key: "wraith", glyph: "W", name: "怨霊",     hp: 10, dmg: 3, minDepth: 16, erratic: 0.15, tier: 4 },
  { key: "ogre",   glyph: "O", name: "石鬼",     hp: 14, dmg: 4, minDepth: 22, erratic: 0.05, tier: 5 },
];

/** 敵の次手のテレグラフ（4-11A 読める盤面）。move=ここへ動く / attack=このマスを討つ */
export type MonsterIntent =
  | { type: "attack"; x: number; y: number }
  | { type: "move"; x: number; y: number }
  | { type: "wait" };

export interface Monster extends Pos {
  id: string; kind: MonsterKind; hp: number; awake: boolean;
  intent: MonsterIntent | null;  // 次ターンに実行する予告（プレイヤーに見える）
  stunned?: number;              // >0 の間は行動不能（静止の眼：4-11F③）
  boss?: "elite" | "area";       // 中ボス（奥の強敵）／エリアボス（節目の山場）：4-11F
  fossilId?: string;             // 出自の化石（敵性化した探索者）。⑤鎮め筋の対象（4-11D）
}
export interface FossilEntity extends Pos {
  id: string; fossilId: string; resolved: boolean; // resolved=このフロアで対面済み
}
export interface Chest extends Pos {
  id: string; opened: boolean;   // 宝箱（開けると中身を抽選：4-12 chest）
  relic?: boolean;               // 聖遺物（奉献の試練・深淵帯の主が守る：4-13B）
}

export interface Floor {
  depth: number;
  w: number; h: number;          // マップ寸法（深度でスケール。ビューより大きい）
  tiles: Tile[];                 // w * h
  stairsUp: Pos; stairsDown: Pos;
  monsters: Monster[];
  fossils: FossilEntity[];
  chests: Chest[];
  explored: boolean[];           // 既踏破（記憶表示用）
}

/** マップ座標 → tiles/explored の添字（フロアの幅で決まる） */
export const mapIdx = (f: Floor, x: number, y: number) => y * f.w + x;
export const inBounds = (f: Floor, x: number, y: number) => x >= 0 && y >= 0 && x < f.w && y < f.h;
export const tileAt = (f: Floor, x: number, y: number): Tile => (inBounds(f, x, y) ? f.tiles[mapIdx(f, x, y)] : 0);

// ---------- フロア生成（部屋＋L字通路。順次接続なので必ず連結） ----------
interface Room { x: number; y: number; w: number; h: number; }
const center = (r: Room): Pos => ({ x: r.x + (r.w >> 1), y: r.y + (r.h >> 1) });

export function genFloor(world: World, depth: number, opts?: { abyss?: boolean }): Floor {
  const rng = makeRng((world.seed ^ (depth * 2654435761) ^ (world.generation * 97) ^ (opts?.abyss ? 0x5eed : 0)) >>> 0);
  // マップ寸法：深いほど広い（毎回ランダムな形）。常に VIEW より大きく、カメラがスクロールする。
  const W = 24 + Math.min(depth, 26);
  const H = 28 + Math.min(depth, 26);
  const tiles: Tile[] = new Array(W * H).fill(0);
  const gi = (x: number, y: number) => y * W + x;
  const rooms: Room[] = [];

  const carveRoom = (r: Room) => {
    for (let y = r.y; y < r.y + r.h; y++) for (let x = r.x; x < r.x + r.w; x++) tiles[gi(x, y)] = 1;
  };
  const carve = (x: number, y: number) => { tiles[gi(x, y)] = 1; };
  // 部屋同士に2マスの岩を残す＝部屋と通路が見分けられる（開放的すぎる大広間を防ぐ）。
  const overlaps = (a: Room) =>
    rooms.some((b) => a.x - 2 < b.x + b.w && b.x - 2 < a.x + a.w && a.y - 2 < b.y + b.h && b.y - 2 < a.y + a.h);
  const dist2 = (a: Room, b: Room) => {
    const ca = center(a), cb = center(b);
    return (ca.x - cb.x) ** 2 + (ca.y - cb.y) ** 2;
  };
  // L字の1マス幅通路で2部屋の中心を結ぶ
  const carveCorridor = (a: Room, b: Room) => {
    let { x: ax, y: ay } = center(a);
    const { x: bx, y: by } = center(b);
    if (rng.next() < 0.5) {
      for (; ax !== bx; ax += Math.sign(bx - ax)) carve(ax, ay);
      for (; ay !== by; ay += Math.sign(by - ay)) carve(ax, ay);
    } else {
      for (; ay !== by; ay += Math.sign(by - ay)) carve(ax, ay);
      for (; ax !== bx; ax += Math.sign(bx - ax)) carve(ax, ay);
    }
    carve(bx, by);
  };

  // 小部屋を多めに、稀に大広間を一つ二つ。面積に比例して多数置く（大部屋ばかりを脱却）。
  const targetRooms = Math.max(8, Math.round((W * H) / 72));
  for (let tries = 0; tries < targetRooms * 22 && rooms.length < targetRooms; tries++) {
    const big = rng.next() < 0.16;
    const w = big ? 6 + rng.int(5) : 3 + rng.int(3); // 大:6-10 / 小:3-5
    const h = big ? 5 + rng.int(3) : 3 + rng.int(2); // 大:5-7 / 小:3-4
    const x = 1 + rng.int(W - w - 2), y = 1 + rng.int(H - h - 2);
    const r = { x, y, w, h };
    if (!overlaps(r)) { rooms.push(r); carveRoom(r); }
  }

  // 接続：最近傍を順につないで全室連結（迷路的な木）。leaf＝行き止まりが自然に残る。
  const connected = new Set<number>([0]);
  while (connected.size < rooms.length) {
    let bestA = -1, bestB = -1, best = Infinity;
    for (let a = 0; a < rooms.length; a++) {
      if (!connected.has(a)) continue;
      for (let b = 0; b < rooms.length; b++) {
        if (connected.has(b)) continue;
        const d = dist2(rooms[a], rooms[b]);
        if (d < best) { best = d; bestA = a; bestB = b; }
      }
    }
    if (bestB < 0) break;
    carveCorridor(rooms[bestA], rooms[bestB]);
    connected.add(bestB);
  }
  // 一部にループを足す（回遊性。行き止まりは残しつつ一本道を崩す）。
  for (let i = 0; i < rooms.length; i++) {
    if (rng.next() >= 0.2) continue;
    let bj = -1, bd = Infinity;
    for (let j = 0; j < rooms.length; j++) {
      if (j === i) continue;
      const d = dist2(rooms[i], rooms[j]);
      if (d < bd) { bd = d; bj = j; }
    }
    if (bj >= 0) carveCorridor(rooms[i], rooms[bj]);
  }

  // 階段：上り＝最初の部屋、下り＝上りから最も遠い部屋（潜行が一筆書きにならない距離を確保）。
  const stairsUp = center(rooms[0]);
  let farIdx = rooms.length - 1, farD = -1;
  for (let i = 1; i < rooms.length; i++) {
    const d = dist2(rooms[0], rooms[i]);
    if (d > farD) { farD = d; farIdx = i; }
  }
  const stairsDown = center(rooms[farIdx]);

  const floor: Floor = {
    depth, w: W, h: H, tiles, stairsUp, stairsDown,
    monsters: [], fossils: [], chests: [],
    explored: new Array(W * H).fill(false),
  };

  // ---------- モンスター配置（マップ面積＋深度でスケール。大マップでも密度を確保） ----------
  const pool = MONSTER_KINDS.filter((k) => k.minDepth <= depth);
  const count = Math.min(Math.round((W * H) / 135) + Math.floor(depth / 3), 20);
  for (let i = 0; i < count; i++) {
    const kind = pool[rng.int(pool.length)];
    const p = randomFloorAway(floor, rng, stairsUp, 5);
    if (p) floor.monsters.push({ id: `m${depth}_${i}`, kind, hp: kind.hp, x: p.x, y: p.y, awake: false, intent: null });
  }

  // ---------- ボス配置（4-11F：エリアボス＝深度節目で下り階段を守る／中ボス＝奥の部屋の強敵） ----------
  if (depth >= 8 && depth % 8 === 0) {
    const { kind, fossilId } = makeAreaBoss(world, depth, rng);
    const bp = freeFloorNear(floor, stairsDown);
    if (bp) floor.monsters.push({ id: `boss${depth}`, kind, hp: kind.hp, x: bp.x, y: bp.y, awake: true, intent: null, boss: "area", fossilId });
  } else if (depth >= 5 && rng.next() < 0.3) {
    const base = pool.reduce((a, b) => (b.tier > a.tier ? b : a));
    const kind: MonsterKind = {
      ...base, key: `elite${depth}`, name: `手負いの${base.name}`,
      hp: Math.round(base.hp * 2.4) + depth, dmg: base.dmg + 1, tier: Math.min(5, base.tier + 1),
    };
    const p = randomFloorAway(floor, rng, stairsUp, 8);
    if (p) floor.monsters.push({ id: `elite${depth}`, kind, hp: kind.hp, x: p.x, y: p.y, awake: false, intent: null, boss: "elite" });
  }

  // ---------- 宝箱配置（深いほど少し増える。入口から離して＝奥/行き止まりに置く） ----------
  const chestCount = 1 + Math.min(depth >> 3, 3) + (rng.next() < 0.5 ? 1 : 0);
  for (let i = 0; i < chestCount; i++) {
    const p = randomFloorAway(floor, rng, stairsUp, 6);
    if (p) floor.chests.push({ id: `c${depth}_${i}`, x: p.x, y: p.y, opened: false });
  }

  // ---------- 深淵帯（奉献の試練・4-13B）：最奥の主が聖遺物を守る ----------
  if (opts?.abyss) {
    const { kind, fossilId } = makeAreaBoss(world, depth, rng);
    const lord: MonsterKind = {
      ...kind, key: `abyss${depth}`,
      name: fossilId ? kind.name.replace("成れの果て", "成れの果て――深淵の主") : "深淵の主",
      hp: Math.round(kind.hp * 1.8) + 20, dmg: kind.dmg + 3, tier: 5,
    };
    const bp = freeFloorNear(floor, stairsDown) ?? stairsDown;
    floor.monsters.push({ id: "abyss_lord", kind: lord, hp: lord.hp, x: bp.x, y: bp.y, awake: true, intent: null, boss: "area", fossilId });
    // 聖遺物：主のかたわら（下り階段側＝上り階段＝脱出路から最も遠い）
    const rp = freeFloorNear(floor, bp) ?? bp;
    floor.chests.push({ id: "relic", x: rp.x, y: rp.y, opened: false, relic: true });
  }
  return floor;
}

/** 帰還の試練（4-13C）：聖遺物を奪った者を追う怨霊を1体、プレイヤー近くに湧かせる。 */
export function spawnPursuer(f: Floor, rng: Rng, player: Pos, depth: number, n: number): Monster | null {
  const p = randomFloorAway(f, rng, player, 4);
  if (!p) return null;
  const base = MONSTER_KINDS[MONSTER_KINDS.length - 1]; // 石鬼＝最上位
  const kind: MonsterKind = {
    ...base, key: `pursuer${depth}_${n}`, glyph: "W", name: "追い縋る怨霊",
    hp: 8 + depth, dmg: 3 + (depth >> 4), erratic: 0.1, tier: 4,
  };
  const m: Monster = { id: `pursuer_${depth}_${n}`, kind, hp: kind.hp, x: p.x, y: p.y, awake: true, intent: null };
  f.monsters.push(m);
  return m;
}

/** エリアボスの種別＋出自。可能なら過去の探索者化石の名を冠する（敵性化＝⑤鎮め筋の対象）。 */
function makeAreaBoss(world: World, depth: number, rng: Rng): { kind: MonsterKind; fossilId?: string } {
  const pool = world.fossils.filter((f) => f.kind === "character" || f.kind === "explorer");
  const src = pool.length ? rng.pick(pool) : null;
  const name = src ? `${src.origin.name}の成れの果て` : "深淵の主";
  const kind: MonsterKind = { key: `boss${depth}`, glyph: "Ω", name, hp: 20 + depth * 2, dmg: 4 + (depth >> 3), minDepth: depth, erratic: 0.05, tier: 5 };
  return { kind, fossilId: src?.id };
}

/** p の近傍（外周をスパイラル）で空いた床タイルを探す。なければ null。 */
function freeFloorNear(f: Floor, p: Pos): Pos | null {
  for (let r = 1; r <= 5; r++) {
    for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
      if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
      const x = p.x + dx, y = p.y + dy;
      if (tileAt(f, x, y) !== 1) continue;
      if (f.monsters.some((m) => m.x === x && m.y === y)) continue;
      if ((x === f.stairsUp.x && y === f.stairsUp.y) || (x === f.stairsDown.x && y === f.stairsDown.y)) continue;
      return { x, y };
    }
  }
  return null;
}

/** from から minDist 以上離れた床タイルを返す */
export function randomFloorAway(f: Floor, rng: Rng, from: Pos, minDist: number): Pos | null {
  for (let tries = 0; tries < 80; tries++) {
    const x = 1 + rng.int(f.w - 2), y = 1 + rng.int(f.h - 2);
    if (tileAt(f, x, y) !== 1) continue;
    if (Math.hypot(x - from.x, y - from.y) < minDist) continue;
    if (f.monsters.some((m) => m.x === x && m.y === y)) continue;
    if (f.fossils.some((e) => e.x === x && e.y === y)) continue;
    if (f.chests.some((c) => c.x === x && c.y === y)) continue;
    if ((x === f.stairsUp.x && y === f.stairsUp.y) || (x === f.stairsDown.x && y === f.stairsDown.y)) continue;
    return { x, y };
  }
  return null;
}

/** 化石をフロアに実体として置く（再会重み 4-7 の結果を受け取る） */
export function placeFossil(f: Floor, rng: Rng, player: Pos, fossil: Fossil): boolean {
  const p = randomFloorAway(f, rng, player, 6);
  if (!p) return false;
  f.fossils.push({ id: `fe_${fossil.id}`, fossilId: fossil.id, resolved: false, x: p.x, y: p.y });
  return true;
}

// ---------- 視界（Bresenham LOS・半径制） ----------
export const FOV_RADIUS = 7;

function losClear(f: Floor, x0: number, y0: number, x1: number, y1: number): boolean {
  let dx = Math.abs(x1 - x0), dy = -Math.abs(y1 - y0);
  const sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
  let err = dx + dy, x = x0, y = y0;
  for (;;) {
    if (x === x1 && y === y1) return true;
    if (!(x === x0 && y === y0) && tileAt(f, x, y) === 0) return false; // 壁が遮る
    const e2 = 2 * err;
    if (e2 >= dy) { err += dy; x += sx; }
    if (e2 <= dx) { err += dx; y += sy; }
  }
}

/** 可視セル集合を返し、explored を更新する */
export function computeFov(f: Floor, p: Pos): Set<number> {
  const vis = new Set<number>();
  for (let y = Math.max(0, p.y - FOV_RADIUS); y <= Math.min(f.h - 1, p.y + FOV_RADIUS); y++) {
    for (let x = Math.max(0, p.x - FOV_RADIUS); x <= Math.min(f.w - 1, p.x + FOV_RADIUS); x++) {
      if (Math.hypot(x - p.x, y - p.y) > FOV_RADIUS + 0.5) continue;
      if (losClear(f, p.x, p.y, x, y)) {
        vis.add(mapIdx(f, x, y));
        f.explored[mapIdx(f, x, y)] = true;
      }
    }
  }
  return vis;
}

// ---------- モンスターのターン（テレグラフ＝予告 → 実行の2段：4-11A） ----------
export interface MonsterHit { monster: Monster; dmg: number; }
export interface Resolution { hits: MonsterHit[]; dodges: Monster[]; }

const monsterDmg = (m: Monster, f: Floor) => m.kind.dmg + (f.depth >= 20 ? 1 : 0);

const occupiedBy = (f: Floor, x: number, y: number, self: Monster) =>
  f.monsters.some((m) => m !== self && m.hp > 0 && m.x === x && m.y === y) ||
  f.fossils.some((e) => e.x === x && e.y === y);

/** 各モンスターの次手を決め、intent に予告として書く（プレイヤーが見て動ける）。
 *  覚醒判定もここで行う：新たに気づいた敵はまず予告し、実行は次ターン（理不尽な不意打ちを排す）。 */
export function planMonsters(f: Floor, player: Pos, rng: Rng): void {
  for (const m of f.monsters) {
    if (m.hp <= 0) { m.intent = null; continue; }
    if (m.stunned && m.stunned > 0) { m.stunned--; m.intent = { type: "wait" }; continue; } // 静止の眼
    const d = Math.hypot(m.x - player.x, m.y - player.y);
    if (!m.awake && d <= FOV_RADIUS && losClear(f, m.x, m.y, player.x, player.y)) m.awake = true;
    if (!m.awake) { m.intent = null; continue; }

    if (d < 1.5) { // 隣接 → プレイヤーの現在マスを討つと予告（退けば空振り＝見切り）
      m.intent = { type: "attack", x: player.x, y: player.y };
      continue;
    }
    // 追跡。erratic 率でぶれるが、ぶれた結果も予告に出るので盤面は読める
    let dx = Math.sign(player.x - m.x), dy = Math.sign(player.y - m.y);
    if (rng.next() < m.kind.erratic) { dx = rng.int(3) - 1; dy = rng.int(3) - 1; }
    const cand: Pos[] = [
      { x: m.x + dx, y: m.y + dy },
      { x: m.x + dx, y: m.y },
      { x: m.x, y: m.y + dy },
    ];
    let dest: Pos | null = null;
    for (const c of cand) {
      if (tileAt(f, c.x, c.y) === 1 && !(c.x === player.x && c.y === player.y) && !occupiedBy(f, c.x, c.y, m)) { dest = c; break; }
    }
    m.intent = dest ? { type: "move", x: dest.x, y: dest.y } : { type: "wait" };
  }
}

/** 予告した intent を実行する。攻撃は確定命中・確定ダメージ（miss無し）だが、
 *  予告マスから退いていれば空振り（見切り）＝負けは読み違えとして納得できる（4-11A）。 */
export function resolveMonsters(f: Floor, player: Pos): Resolution {
  const hits: MonsterHit[] = [];
  const dodges: Monster[] = [];
  for (const m of f.monsters) {
    if (m.hp <= 0 || !m.intent) continue;
    if (m.intent.type === "attack") {
      if (player.x === m.intent.x && player.y === m.intent.y) hits.push({ monster: m, dmg: monsterDmg(m, f) });
      else dodges.push(m); // 予告マスから退いた＝見切り
    } else if (m.intent.type === "move") {
      const { x, y } = m.intent;
      if (tileAt(f, x, y) === 1 && !(x === player.x && y === player.y) && !occupiedBy(f, x, y, m)) { m.x = x; m.y = y; }
    }
    m.intent = null;
  }
  return { hits, dodges };
}

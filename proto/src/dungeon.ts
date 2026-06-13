// ダンジョン層：フロア生成・視界(FOV)・モンスター（UI非依存の純ロジック）
// フロアは world.seed × 世代 × 深度 から決定論的に生成される。

import { makeRng, type Rng } from "./rng.ts";
import type { World, Fossil } from "./types.ts";

export const FLOOR_W = 21;
export const FLOOR_H = 23;

export type Tile = 0 | 1; // 0=岩盤(壁) 1=床
export interface Pos { x: number; y: number; }

export interface MonsterKind {
  key: string; glyph: string; name: string;
  hp: number; dmg: number; minDepth: number; erratic: number; // erratic=ランダム移動率
}
export const MONSTER_KINDS: MonsterKind[] = [
  { key: "rat",   glyph: "r", name: "大鼠",     hp: 3, dmg: 1, minDepth: 1,  erratic: 0.3 },
  { key: "bat",   glyph: "b", name: "洞蝙蝠",   hp: 2, dmg: 1, minDepth: 2,  erratic: 0.6 },
  { key: "snake", glyph: "s", name: "石蛇",     hp: 4, dmg: 2, minDepth: 5,  erratic: 0.2 },
  { key: "ghoul", glyph: "g", name: "屍喰らい", hp: 6, dmg: 2, minDepth: 10, erratic: 0.1 },
  { key: "wisp",  glyph: "w", name: "迷い火",   hp: 3, dmg: 3, minDepth: 16, erratic: 0.4 },
];

export interface Monster extends Pos {
  id: string; kind: MonsterKind; hp: number; awake: boolean;
}
export interface FossilEntity extends Pos {
  id: string; fossilId: string; resolved: boolean; // resolved=このフロアで対面済み
}

export interface Floor {
  depth: number;
  tiles: Tile[];                 // FLOOR_W * FLOOR_H
  stairsUp: Pos; stairsDown: Pos;
  monsters: Monster[];
  fossils: FossilEntity[];
  explored: boolean[];           // 既踏破（記憶表示用）
}

const idx = (x: number, y: number) => y * FLOOR_W + x;
export const inBounds = (x: number, y: number) => x >= 0 && y >= 0 && x < FLOOR_W && y < FLOOR_H;
export const tileAt = (f: Floor, x: number, y: number): Tile => (inBounds(x, y) ? f.tiles[idx(x, y)] : 0);

// ---------- フロア生成（部屋＋L字通路。順次接続なので必ず連結） ----------
interface Room { x: number; y: number; w: number; h: number; }
const center = (r: Room): Pos => ({ x: r.x + (r.w >> 1), y: r.y + (r.h >> 1) });

export function genFloor(world: World, depth: number): Floor {
  const rng = makeRng((world.seed ^ (depth * 2654435761) ^ (world.generation * 97)) >>> 0);
  const tiles: Tile[] = new Array(FLOOR_W * FLOOR_H).fill(0);
  const rooms: Room[] = [];

  const carveRoom = (r: Room) => {
    for (let y = r.y; y < r.y + r.h; y++) for (let x = r.x; x < r.x + r.w; x++) tiles[idx(x, y)] = 1;
  };
  const overlaps = (a: Room) =>
    rooms.some((b) => a.x - 1 < b.x + b.w && b.x - 1 < a.x + a.w && a.y - 1 < b.y + b.h && b.y - 1 < a.y + a.h);

  const targetRooms = 5 + rng.int(2);
  for (let tries = 0; tries < 60 && rooms.length < targetRooms; tries++) {
    const w = 4 + rng.int(4), h = 3 + rng.int(3);
    const x = 1 + rng.int(FLOOR_W - w - 2), y = 1 + rng.int(FLOOR_H - h - 2);
    const r = { x, y, w, h };
    if (!overlaps(r)) { rooms.push(r); carveRoom(r); }
  }
  // L字通路で順次接続
  for (let i = 1; i < rooms.length; i++) {
    let { x: ax, y: ay } = center(rooms[i - 1]);
    const { x: bx, y: by } = center(rooms[i]);
    const xFirst = rng.next() < 0.5;
    const carve = (x: number, y: number) => { tiles[idx(x, y)] = 1; };
    if (xFirst) {
      for (; ax !== bx; ax += Math.sign(bx - ax)) carve(ax, ay);
      for (; ay !== by; ay += Math.sign(by - ay)) carve(ax, ay);
    } else {
      for (; ay !== by; ay += Math.sign(by - ay)) carve(ax, ay);
      for (; ax !== bx; ax += Math.sign(bx - ax)) carve(ax, ay);
    }
    carve(bx, by);
  }

  const stairsUp = center(rooms[0]);
  const stairsDown = center(rooms[rooms.length - 1]);

  const floor: Floor = {
    depth, tiles, stairsUp, stairsDown,
    monsters: [], fossils: [],
    explored: new Array(FLOOR_W * FLOOR_H).fill(false),
  };

  // ---------- モンスター配置（深いほど多く・強く） ----------
  const pool = MONSTER_KINDS.filter((k) => k.minDepth <= depth);
  const count = Math.min(2 + (depth >> 2), 6);
  for (let i = 0; i < count; i++) {
    const kind = pool[rng.int(pool.length)];
    const p = randomFloorAway(floor, rng, stairsUp, 5);
    if (p) floor.monsters.push({ id: `m${depth}_${i}`, kind, hp: kind.hp, x: p.x, y: p.y, awake: false });
  }
  return floor;
}

/** from から minDist 以上離れた床タイルを返す */
export function randomFloorAway(f: Floor, rng: Rng, from: Pos, minDist: number): Pos | null {
  for (let tries = 0; tries < 80; tries++) {
    const x = 1 + rng.int(FLOOR_W - 2), y = 1 + rng.int(FLOOR_H - 2);
    if (tileAt(f, x, y) !== 1) continue;
    if (Math.hypot(x - from.x, y - from.y) < minDist) continue;
    if (f.monsters.some((m) => m.x === x && m.y === y)) continue;
    if (f.fossils.some((e) => e.x === x && e.y === y)) continue;
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
  for (let y = Math.max(0, p.y - FOV_RADIUS); y <= Math.min(FLOOR_H - 1, p.y + FOV_RADIUS); y++) {
    for (let x = Math.max(0, p.x - FOV_RADIUS); x <= Math.min(FLOOR_W - 1, p.x + FOV_RADIUS); x++) {
      if (Math.hypot(x - p.x, y - p.y) > FOV_RADIUS + 0.5) continue;
      if (losClear(f, p.x, p.y, x, y)) {
        vis.add(idx(x, y));
        f.explored[idx(x, y)] = true;
      }
    }
  }
  return vis;
}

// ---------- モンスターのターン ----------
export interface MonsterHit { monster: Monster; dmg: number; }

/** 全モンスターを1ターン動かす。プレイヤーに隣接していれば攻撃（命中分を返す）。 */
export function stepMonsters(f: Floor, player: Pos, rng: Rng): MonsterHit[] {
  const hits: MonsterHit[] = [];
  const occupied = (x: number, y: number) =>
    f.monsters.some((m) => m.hp > 0 && m.x === x && m.y === y) ||
    f.fossils.some((e) => e.x === x && e.y === y);

  for (const m of f.monsters) {
    if (m.hp <= 0) continue;
    const d = Math.hypot(m.x - player.x, m.y - player.y);
    if (!m.awake && d <= FOV_RADIUS && losClear(f, m.x, m.y, player.x, player.y)) m.awake = true;
    if (!m.awake) continue;

    if (d < 1.5) { // 隣接 → 攻撃
      hits.push({ monster: m, dmg: m.kind.dmg + (f.depth >= 20 ? 1 : 0) });
      continue;
    }
    // 移動：基本は追跡、erratic 率でランダム
    let dx = Math.sign(player.x - m.x), dy = Math.sign(player.y - m.y);
    if (rng.next() < m.kind.erratic) { dx = rng.int(3) - 1; dy = rng.int(3) - 1; }
    const cand: Pos[] = [
      { x: m.x + dx, y: m.y + dy },
      { x: m.x + dx, y: m.y },
      { x: m.x, y: m.y + dy },
    ];
    for (const c of cand) {
      if (tileAt(f, c.x, c.y) === 1 && !(c.x === player.x && c.y === player.y) && !occupied(c.x, c.y)) {
        m.x = c.x; m.y = c.y; break;
      }
    }
  }
  return hits;
}

export const cellIndex = idx;

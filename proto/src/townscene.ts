// 第2層・歩ける街（snapshot §4-4B）の純粋ロジック。
// ブラウザセーフ：DOM も fs も使わない。地形はデータ駆動（content/town.json）。
// 乱数はエンジンの Rng を注入（決定論を壊さない）。群衆は使い捨て＝world に保存しない。

import type { Rng } from "./rng.ts";

export interface Pos { x: number; y: number; }

export type TownTile =
  | "void" | "floor" | "wall" | "bldg" | "noble"
  | "door" | "gate" | "ngate" | "exit" | "rug";

export interface KeeperDef {
  sign: string; color: string; place: string; name: string; title: string;
  line: string; acts: string[]; actorId: string | null;
}
export interface BuildingDef {
  kind: string; x: number; y: number; w: number; h: number;
  door: [number, number]; zone: string;
}
export interface GuardDef {
  x: number; y: number; glyph: string; color: string;
  name: string; line: string; locked: boolean;
}
export interface PropDef {
  x: number; y: number; glyph: string; color: string; glow?: boolean; line?: string;
}
export interface CrowdKind { glyph: string; color: string; label: string; lines: string[]; }
export interface TownData {
  width: number; height: number;
  view: { w: number; h: number };
  start: Pos; gate: Pos;
  gateFrame: [number, number][];
  partitionWallY: number;
  nobleRects: [number, number, number, number][];
  nobleGate: Pos;
  keepers: Record<string, KeeperDef>;
  buildings: BuildingDef[];
  guards: GuardDef[];
  props: PropDef[];
  crowd: { spawnCount: number; kinds: Record<string, CrowdKind>; weights: string[] };
}

/** 街路を歩く群衆（ephemeral：保存しない）。 */
export interface CrowdActor { x: number; y: number; kind: string; }

export type Scene = "town" | "interior";

export interface TownGrid {
  data: TownData;
  tiles: TownTile[][]; // [y][x]
  doorMap: Map<string, string>; // "x,y" -> building kind
  guardMap: Map<string, GuardDef>;
  propMap: Map<string, PropDef>;
}

const key = (x: number, y: number): string => `${x},${y}`;

/** content/town.json から実行時グリッドを一度だけ構築する。 */
export function buildTownGrid(data: TownData): TownGrid {
  const { width: W, height: H } = data;
  const tiles: TownTile[][] = Array.from({ length: H }, () => Array<TownTile>(W).fill("floor"));
  const rect = (x: number, y: number, w: number, h: number, t: TownTile): void => {
    for (let j = y; j < y + h; j++) {
      for (let i = x; i < x + w; i++) {
        if (tiles[j] && tiles[j][i] !== undefined) tiles[j][i] = t;
      }
    }
  };
  // 外周
  for (let x = 0; x < W; x++) { tiles[0][x] = "wall"; tiles[H - 1][x] = "wall"; }
  for (let y = 0; y < H; y++) { tiles[y][0] = "wall"; tiles[y][W - 1] = "wall"; }

  const doorMap = new Map<string, string>();
  for (const b of data.buildings) {
    rect(b.x, b.y, b.w, b.h, "bldg");
    tiles[b.door[1]][b.door[0]] = "door";
    doorMap.set(key(b.door[0], b.door[1]), b.kind);
  }

  // 封鎖ゾーン（貴族街）：仕切り壁＋居館シルエット＋閉ざされた門
  for (let x = 1; x < W - 1; x++) tiles[data.partitionWallY][x] = "wall";
  for (const [x, y, w, h] of data.nobleRects) rect(x, y, w, h, "noble");
  tiles[data.nobleGate.y][data.nobleGate.x] = "ngate";

  // 迷宮の口（門の構造物）
  for (const [x, y] of data.gateFrame) {
    if (tiles[y] && tiles[y][x] !== undefined) tiles[y][x] = "bldg";
  }
  tiles[data.gate.y][data.gate.x] = "gate";

  const guardMap = new Map<string, GuardDef>();
  for (const g of data.guards) guardMap.set(key(g.x, g.y), g);

  const propMap = new Map<string, PropDef>();
  for (const p of data.props) propMap.set(key(p.x, p.y), p);

  return { data, tiles, doorMap, guardMap, propMap };
}

export function townTileAt(g: TownGrid, x: number, y: number): TownTile {
  return g.tiles[y]?.[x] ?? "void";
}

/** 床（景物が無い）か。歩行・群衆配置の基準。 */
function isFloorCell(g: TownGrid, x: number, y: number): boolean {
  return townTileAt(g, x, y) === "floor" && !g.propMap.has(key(x, y));
}

/** 街路として歩けるか（床 or 門。景物は塞ぐ）。看板/群衆/門番は移動側で先に判定する。 */
export function isWalkableTown(g: TownGrid, x: number, y: number): boolean {
  const t = townTileAt(g, x, y);
  return (t === "floor" || t === "gate") && !g.propMap.has(key(x, y));
}

// ---------------- 屋内シーン ----------------
export interface Interior {
  kind: string; w: number; h: number;
  tiles: TownTile[][];
  keeperPos: Pos; exitPos: Pos;
}

const IW = 11, IH = 8;

export function buildInterior(kind: string): Interior {
  const tiles: TownTile[][] = Array.from({ length: IH }, () => Array<TownTile>(IW).fill("floor"));
  for (let x = 0; x < IW; x++) { tiles[0][x] = "wall"; tiles[IH - 1][x] = "wall"; }
  for (let y = 0; y < IH; y++) { tiles[y][0] = "wall"; tiles[y][IW - 1] = "wall"; }
  // 棚・調度
  tiles[1][1] = "bldg"; tiles[1][2] = "bldg"; tiles[1][IW - 2] = "bldg"; tiles[1][IW - 3] = "bldg";
  tiles[2][1] = "bldg"; tiles[2][IW - 2] = "bldg";
  // カウンター（中央に隙間）
  for (let i = 4; i <= 6; i++) tiles[2][i] = "bldg";
  tiles[2][5] = "floor";
  tiles[4][5] = "rug";
  let keeperPos: Pos = { x: 5, y: 1 };
  if (kind === "house") {
    for (let i = 4; i <= 6; i++) tiles[2][i] = "floor"; // 民家はカウンターなし
    keeperPos = { x: 5, y: 2 };
  }
  const exitPos: Pos = { x: 5, y: IH - 2 };
  tiles[exitPos.y][exitPos.x] = "exit";
  return { kind, w: IW, h: IH, tiles, keeperPos, exitPos };
}

// ---------------- 群衆（使い捨て・Rng 注入） ----------------
export function crowdAt(crowd: CrowdActor[], x: number, y: number): CrowdActor | undefined {
  return crowd.find((a) => a.x === x && a.y === y);
}

export function spawnCrowd(g: TownGrid, rng: Rng, player: Pos): CrowdActor[] {
  const { width: W, height: H, crowd: cfg } = g.data;
  const out: CrowdActor[] = [];
  let tries = 0;
  while (out.length < cfg.spawnCount && tries < 4000) {
    tries++;
    const x = 1 + rng.int(W - 2);
    const y = 9 + rng.int(H - 10); // 貴族街（壁より上）には湧かせない
    if (!isFloorCell(g, x, y)) continue;
    if (x === player.x && y === player.y) continue;
    if (out.some((a) => a.x === x && a.y === y)) continue;
    out.push({ x, y, kind: cfg.weights[rng.int(cfg.weights.length)] });
  }
  return out;
}

const DIRS: [number, number][] = [[0, -1], [0, 1], [-1, 0], [1, 0]];

export function wanderCrowd(g: TownGrid, rng: Rng, crowd: CrowdActor[], player: Pos): void {
  for (const a of crowd) {
    if (rng.next() < 0.4) continue;
    // 方向をシャッフル（Rng 由来）
    const dirs = DIRS.slice();
    for (let i = dirs.length - 1; i > 0; i--) {
      const j = rng.int(i + 1);
      const tmp = dirs[i]; dirs[i] = dirs[j]; dirs[j] = tmp;
    }
    for (const [dx, dy] of dirs) {
      const x = a.x + dx, y = a.y + dy;
      if (!isFloorCell(g, x, y)) continue;
      if (x === player.x && y === player.y) continue;
      if (crowdAt(crowd, x, y)) continue;
      if (g.doorMap.has(key(x, y)) || g.guardMap.has(key(x, y))) continue;
      a.x = x; a.y = y;
      break;
    }
  }
}

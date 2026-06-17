// ダンジョン層：フロア生成・視界(FOV)・モンスター（UI非依存の純ロジック）
// フロアは world.seed × 世代 × 深度 から決定論的に生成される。

import { makeRng, type Rng } from "./rng.ts";
import type { World, Fossil, Actor } from "./types.ts";

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

// 深度係数（終始シビア・無限スケール 4-11F②）。種の堅さ（早期の差）に深度ぶんを上乗せ＝
// 深いほど堅く痛い。撃破XPは kind.hp 由来なので、スポーン時に深度ぶんを焼き込めば XP も深度連動する（Lv≈深度）。
export const depthHpBonus = (depth: number) => Math.round(depth * 1.6);
export const depthDmgBonus = (depth: number) => Math.round(depth * 0.18);
/** その深度の「標準的な雑魚」HP（6+1.6d）＝ボス/エリート/追手の算出基準。 */
export const regularHpAt = (depth: number) => 6 + depthHpBonus(depth);
/** 種＋深度係数の実体（雑魚スポーンに使う。hp/dmg を深度ぶん底上げ＝撃破XP・被ダメも深度連動）。 */
export const scaleKind = (k: MonsterKind, depth: number): MonsterKind =>
  ({ ...k, hp: k.hp + depthHpBonus(depth), dmg: k.dmg + depthDmgBonus(depth) });

/** 敵の次手のテレグラフ（4-11A 読める盤面）。move=ここへ動く / attack=このマスを討つ */
export type MonsterIntent =
  | { type: "attack"; x: number; y: number }
  | { type: "move"; x: number; y: number }
  | { type: "wait" };

export interface Monster extends Pos {
  id: string; kind: MonsterKind; hp: number; awake: boolean;
  intent: MonsterIntent | null;  // 次ターンに実行する予告（プレイヤーに見える）
  stunned?: number;              // >0 の間は行動不能（静止の眼：4-11F③）
  slowed?: number;               // >0 の間は1手おきにしか動けない（鈍り：4-11F③）
  fear?: number;                 // >0 の間は標的から逃げる（畏れ：4-11F③）
  confused?: number;             // >0 の間はランダム移動（惑乱：4-11F③）
  rooted?: number;               // >0 の間は移動不可（隣接なら攻撃は可）（縛鎖：4-11F③）
  weak?: number;                 // >0 の間は攻撃力減（蝕み：4-11F③）。減算量は WEAK_AMT
  poison?: number;               // >0 の間は毎手 poisonDmg を受ける（腐喰＝継続ダメ：4-11F③）
  poisonDmg?: number;            // 腐喰の1手あたりダメージ（詠唱時の理で決まる）
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
// 同行（相棒）の盤上エンティティ（4-14C）。潜行中だけ生きる ephemeral。@に追従し隣接攻撃、テレグラフを出す。
export interface CompanionEntity extends Pos {
  hp: number; maxHp: number;
  intent: MonsterIntent | null;  // 次手の予告（モンスターと同じ語彙＝決定論・読める盤面）
  stunned?: number;
  erratic?: number;              // 連帯深蝕で生じる挙動のぶれ率（Phase B：奇癖→逸脱。0=正気）
  crisisShown?: boolean;         // 危険化（C）の決断を今のエピソードで提示済みか（Phase B）
  dmg?: number;                  // 攻撃力（4-4E：等級で変動。未設定なら COMPANION_DMG）
}
// フロアに横たわる手負いの冒険者（4-14C 入口B：救助＝相棒化／見捨て＝後世の宿敵）。
export interface DownedActor extends Pos {
  id: string; actor: Actor;
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
  downed?: DownedActor | null;   // 手負いの冒険者（任意。enterFloor が稀に配置：4-14C）
}

/** マップ座標 → tiles/explored の添字（フロアの幅で決まる） */
export const mapIdx = (f: Floor, x: number, y: number) => y * f.w + x;
export const inBounds = (f: Floor, x: number, y: number) => x >= 0 && y >= 0 && x < f.w && y < f.h;
export const tileAt = (f: Floor, x: number, y: number): Tile => (inBounds(f, x, y) ? f.tiles[mapIdx(f, x, y)] : 0);

// ---------- フロア生成（部屋＋L字通路。順次接続なので必ず連結） ----------
interface Room { x: number; y: number; w: number; h: number; }
const center = (r: Room): Pos => ({ x: r.x + (r.w >> 1), y: r.y + (r.h >> 1) });

export function genFloor(world: World, depth: number, opts?: { abyss?: boolean }): Floor {
  // seed に潜行回数(diveCount)を混ぜる＝同一世代でも潜行ごとに別ダンジョン（生還→再潜行での宝箱/XP farm を根絶）。
  const rng = makeRng((world.seed ^ (depth * 2654435761) ^ (world.generation * 97) ^ ((world.diveCount ?? 0) * 40503) ^ (opts?.abyss ? 0x5eed : 0)) >>> 0);
  // マップ寸法：深いほど広い（毎回ランダムな形）。常に VIEW より大きく、カメラがスクロールする。
  // 旧 24+/28+（最大50×54）は手狭との FB を受け拡張（2026-06-17）。深度50で頭打ち＝最大 86×92（≒7,912・約2.9倍）。
  // 部屋数/敵数/宝箱は面積比で自動追従＝広いほど探索量・滞在ターン（＝深蝕の蓄積）が増え手応えになる。
  const W = 36 + Math.min(depth, 50);
  const H = 42 + Math.min(depth, 50);
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
  const count = Math.min(Math.round((W * H) / 120) + Math.floor(depth / 3), 42); // 出現率・上限を拡張面積に追従（20→42）
  for (let i = 0; i < count; i++) {
    const kind = scaleKind(pool[rng.int(pool.length)], depth); // 深度係数を焼き込む（HP/dmg/XP連動）
    const p = randomFloorAway(floor, rng, stairsUp, 5);
    if (p) floor.monsters.push({ id: `m${depth}_${i}`, kind, hp: kind.hp, x: p.x, y: p.y, awake: false, intent: null });
  }

  // ---------- ボス配置（4-11F：エリアボス＝深度節目で下り階段を守る／中ボス＝奥の部屋の強敵） ----------
  if (depth >= 8 && depth % 8 === 0) {
    const { kind, fossilId } = makeAreaBoss(world, depth, rng);
    const bp = freeFloorNear(floor, stairsDown);
    if (bp) floor.monsters.push({ id: `boss${depth}`, kind, hp: kind.hp, x: bp.x, y: bp.y, awake: true, intent: null, boss: "area", fossilId });
  } else if (depth >= 5 && rng.next() < 0.3) {
    const base = scaleKind(pool.reduce((a, b) => (b.tier > a.tier ? b : a)), depth); // 深度スケール済みの最上位種
    const kind: MonsterKind = {
      ...base, key: `elite${depth}`, name: `手負いの${base.name}`,
      hp: Math.round(base.hp * 2), dmg: base.dmg + 1, tier: Math.min(5, base.tier + 1), // 雑魚と area ボスの中間
    };
    const p = randomFloorAway(floor, rng, stairsUp, 8);
    if (p) floor.monsters.push({ id: `elite${depth}`, kind, hp: kind.hp, x: p.x, y: p.y, awake: false, intent: null, boss: "elite" });
  }

  // ---------- 宝箱配置（深いほど少し増える。入口から離して＝奥/行き止まりに置く） ----------
  // 宝箱も面積に追従（拡張に合わせ増やす）。最小2＋深度の僅かな上乗せ。d1≈2-3 / d50≈7-8。
  const chestCount = Math.max(2, Math.round((W * H) / 1300)) + Math.min(depth >> 4, 2) + (rng.next() < 0.5 ? 1 : 0);
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
      hp: Math.round(kind.hp * 1.4) + 40, dmg: kind.dmg + 2, tier: 5, // area ボス（既に深度スケール済）を更に増強
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
    hp: Math.round(regularHpAt(depth) * 1.3), dmg: 2 + depthDmgBonus(depth), erratic: 0.1, tier: 4,
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
  // エリアボス＝雑魚baseline×4+20・dmg＝雑魚+4（硬め維持＝止め/距離/弱体/回復/遠距離の駆け引き前提 4-11F）
  const kind: MonsterKind = { key: `boss${depth}`, glyph: "Ω", name, hp: regularHpAt(depth) * 4 + 20, dmg: 5 + depthDmgBonus(depth), minDepth: depth, erratic: 0.05, tier: 5 };
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
export interface MonsterHit { monster: Monster; dmg: number; target: "player" | "companion"; }
export interface Resolution { hits: MonsterHit[]; dodges: Monster[]; }
/** 相棒の一手の結果（プレイヤー手番末に解決）。 */
export interface CompanionResolution { hit: Monster | null; dmg: number; }

// dmg は kind に深度係数を焼き込み済み（scaleKind / ボス・エリート・追手とも）。蝕み（weak）中は減算（下限1）。
export const WEAK_AMT = 4;
const monsterDmg = (m: Monster, _f: Floor) => Math.max(1, m.kind.dmg - (m.weak && m.weak > 0 ? WEAK_AMT : 0));
/** 相棒の攻撃力（等級なし時のフォールバック＝控えめの固定値。最終調整は横断E）。 */
export const COMPANION_DMG = 2;

/** 相棒の強さ＝金属等級で変動（4-4E）。設定ランクが上の相棒ほど頼れる。
 *  HP: アイアン10 → プラチナ22／攻撃: アイアン2 → プラチナ6。 */
export function companionMaxHp(grade: number): number {
  return 10 + Math.max(0, Math.min(5, grade)) * 3;
}
export function companionDmg(grade: number): number {
  return 2 + Math.max(0, Math.min(5, grade));
}

// 移動先が他者で塞がっているか（モンスター同士・化石・相棒・手負いと重ならない）。
const occupiedBy = (f: Floor, x: number, y: number, self: Monster | null, comp?: Pos | null) =>
  f.monsters.some((m) => m !== self && m.hp > 0 && m.x === x && m.y === y) ||
  f.fossils.some((e) => e.x === x && e.y === y) ||
  (!!comp && comp.x === x && comp.y === y) ||
  (!!f.downed && f.downed.x === x && f.downed.y === y);

/** 各モンスターの次手を決め、intent に予告として書く（プレイヤーが見て動ける）。
 *  覚醒判定もここで行う：新たに気づいた敵はまず予告し、実行は次ターン（理不尽な不意打ちを排す）。
 *  相棒がいる場合は @ と相棒のうち近い方を標的にする（4-14C）。 */
export function planMonsters(f: Floor, player: Pos, rng: Rng, companion?: CompanionEntity | null): void {
  const comp = companion && companion.hp > 0 ? companion : null;
  for (const m of f.monsters) {
    if (m.hp <= 0) { m.intent = null; continue; }
    if (m.weak && m.weak > 0) m.weak--; // 蝕み（攻撃減）の残り手数を消費
    if (m.stunned && m.stunned > 0) { m.stunned--; m.intent = { type: "wait" }; continue; } // 静止の眼
    if (m.slowed && m.slowed > 0) { m.slowed--; if (m.slowed % 2 === 1) { m.intent = { type: "wait" }; continue; } } // 鈍り＝1手おき
    const dPlayer = Math.hypot(m.x - player.x, m.y - player.y);
    const dComp = comp ? Math.hypot(m.x - comp.x, m.y - comp.y) : Infinity;
    // 覚醒：プレイヤー or 相棒のいずれかを視認したら起きる
    if (!m.awake) {
      if (dPlayer <= FOV_RADIUS && losClear(f, m.x, m.y, player.x, player.y)) m.awake = true;
      else if (comp && dComp <= FOV_RADIUS && losClear(f, m.x, m.y, comp.x, comp.y)) m.awake = true;
    }
    if (!m.awake) { m.intent = null; continue; }

    if (m.confused && m.confused > 0) { // 惑乱＝ランダムによろめく（標的を見失う）
      m.confused--;
      const cx = rng.int(3) - 1, cy = rng.int(3) - 1;
      const c = { x: m.x + cx, y: m.y + cy };
      m.intent = (tileAt(f, c.x, c.y) === 1 && !(c.x === player.x && c.y === player.y) && !occupiedBy(f, c.x, c.y, m, comp))
        ? { type: "move", x: c.x, y: c.y } : { type: "wait" };
      continue;
    }

    // 標的＝近い方（同距離はプレイヤー優先）
    const target = comp && dComp < dPlayer ? comp : player;
    const d = comp && dComp < dPlayer ? dComp : dPlayer;
    if (m.rooted && m.rooted > 0) { // 縛鎖＝その場に縫い止める（隣接なら討てるが動けない）
      m.rooted--;
      m.intent = d < 1.5 ? { type: "attack", x: target.x, y: target.y } : { type: "wait" };
      continue;
    }
    if (m.fear && m.fear > 0) { // 畏れ＝標的から逃げる（隣接でも攻撃しない）
      m.fear--;
      let fx = Math.sign(m.x - target.x), fy = Math.sign(m.y - target.y);
      if (fx === 0 && fy === 0) fx = 1;
      const flee: Pos[] = [{ x: m.x + fx, y: m.y + fy }, { x: m.x + fx, y: m.y }, { x: m.x, y: m.y + fy }];
      let dest: Pos | null = null;
      for (const c of flee) {
        if (tileAt(f, c.x, c.y) === 1 && !(c.x === player.x && c.y === player.y) && !occupiedBy(f, c.x, c.y, m, comp)) { dest = c; break; }
      }
      m.intent = dest ? { type: "move", x: dest.x, y: dest.y } : { type: "wait" };
      continue;
    }
    if (d < 1.5) { // 隣接 → 標的の現在マスを討つと予告（退けば空振り＝見切り）
      m.intent = { type: "attack", x: target.x, y: target.y };
      continue;
    }
    // 追跡。erratic 率でぶれるが、ぶれた結果も予告に出るので盤面は読める
    let dx = Math.sign(target.x - m.x), dy = Math.sign(target.y - m.y);
    if (rng.next() < m.kind.erratic) { dx = rng.int(3) - 1; dy = rng.int(3) - 1; }
    const cand: Pos[] = [
      { x: m.x + dx, y: m.y + dy },
      { x: m.x + dx, y: m.y },
      { x: m.x, y: m.y + dy },
    ];
    let dest: Pos | null = null;
    for (const c of cand) {
      if (tileAt(f, c.x, c.y) === 1 && !(c.x === player.x && c.y === player.y) && !occupiedBy(f, c.x, c.y, m, comp)) { dest = c; break; }
    }
    m.intent = dest ? { type: "move", x: dest.x, y: dest.y } : { type: "wait" };
  }
}

/** 予告した intent を実行する。攻撃は確定命中・確定ダメージ（miss無し）だが、
 *  予告マスから退いていれば空振り（見切り）＝負けは読み違えとして納得できる（4-11A）。
 *  攻撃の標的は予告マスに居る者＝@ なら player ヒット、相棒なら companion ヒット。 */
export function resolveMonsters(f: Floor, player: Pos, companion?: CompanionEntity | null): Resolution {
  const comp = companion && companion.hp > 0 ? companion : null;
  const hits: MonsterHit[] = [];
  const dodges: Monster[] = [];
  for (const m of f.monsters) {
    if (m.hp <= 0 || !m.intent) continue;
    if (m.intent.type === "attack") {
      if (player.x === m.intent.x && player.y === m.intent.y) hits.push({ monster: m, dmg: monsterDmg(m, f), target: "player" });
      else if (comp && comp.x === m.intent.x && comp.y === m.intent.y) hits.push({ monster: m, dmg: monsterDmg(m, f), target: "companion" });
      else dodges.push(m); // 予告マスから退いた＝見切り
    } else if (m.intent.type === "move") {
      const { x, y } = m.intent;
      if (tileAt(f, x, y) === 1 && !(x === player.x && y === player.y) && !occupiedBy(f, x, y, m, comp)) { m.x = x; m.y = y; }
    }
    m.intent = null;
  }
  return { hits, dodges };
}

/** 相棒の次手を予告（@に追従し、隣接した覚醒敵を討つ）。
 *  通常は決定論で rng を消費しないが、連帯深蝕で erratic>0 になると rng でぶれる（Phase B・テレグラフされる）。 */
export function planCompanion(f: Floor, player: Pos, comp: CompanionEntity, rng?: Rng): void {
  if (comp.hp <= 0) { comp.intent = null; return; }
  if (comp.stunned && comp.stunned > 0) { comp.stunned--; comp.intent = { type: "wait" }; return; }
  // 連帯深蝕の逸脱：奇癖が出ると、追従も攻撃も投げ出して当て所なく彷徨う（読める＝テレグラフ）。
  if (rng && comp.erratic && comp.erratic > 0 && rng.next() < comp.erratic) {
    const dx = rng.int(3) - 1, dy = rng.int(3) - 1;
    const x = comp.x + dx, y = comp.y + dy;
    const ok = tileAt(f, x, y) === 1 && !(x === player.x && y === player.y) && !occupiedBy(f, x, y, null, null);
    comp.intent = ok ? { type: "move", x, y } : { type: "wait" };
    return;
  }
  // 隣接する生きた敵がいれば討つ（最も近い＝最小添字で安定選択）
  const foe = f.monsters.find((m) => m.hp > 0 && Math.max(Math.abs(m.x - comp.x), Math.abs(m.y - comp.y)) <= 1);
  if (foe) { comp.intent = { type: "attack", x: foe.x, y: foe.y }; return; }
  // さもなくば @ に追従（隣接なら待機）
  const dp = Math.max(Math.abs(player.x - comp.x), Math.abs(player.y - comp.y));
  if (dp <= 1) { comp.intent = { type: "wait" }; return; }
  const dx = Math.sign(player.x - comp.x), dy = Math.sign(player.y - comp.y);
  const cand: Pos[] = [{ x: comp.x + dx, y: comp.y + dy }, { x: comp.x + dx, y: comp.y }, { x: comp.x, y: comp.y + dy }];
  for (const c of cand) {
    const blocked = (c.x === player.x && c.y === player.y) || occupiedBy(f, c.x, c.y, null, null);
    if (tileAt(f, c.x, c.y) === 1 && !blocked) { comp.intent = { type: "move", x: c.x, y: c.y }; return; }
  }
  comp.intent = { type: "wait" };
}

/** 相棒の予告を実行（攻撃＝予告マスの敵に確定ダメージ／移動＝空きへ一歩）。撃破した敵を返す。 */
export function resolveCompanion(f: Floor, player: Pos, comp: CompanionEntity): CompanionResolution {
  if (comp.hp <= 0 || !comp.intent) return { hit: null, dmg: 0 };
  let res: CompanionResolution = { hit: null, dmg: 0 };
  if (comp.intent.type === "attack") {
    const { x, y } = comp.intent;
    const m = f.monsters.find((mm) => mm.hp > 0 && mm.x === x && mm.y === y);
    const dmg = comp.dmg ?? COMPANION_DMG;
    if (m) { m.hp -= dmg; res = { hit: m, dmg }; }
  } else if (comp.intent.type === "move") {
    const { x, y } = comp.intent;
    if (tileAt(f, x, y) === 1 && !(x === player.x && y === player.y) && !occupiedBy(f, x, y, null, null)) { comp.x = x; comp.y = y; }
  }
  comp.intent = null;
  return res;
}

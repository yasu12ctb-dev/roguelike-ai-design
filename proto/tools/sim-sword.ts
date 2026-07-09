// 守勢の剣シム（2026-07-09・ユーザーFB「序盤で死ななくならないか？」検証）。
//   実エンジン（planMonsters/resolveMonsters/scaleKind）＋web の位置取り戦闘（会心=counterTurns×1.2／押し出し pushEnemy／
//   フェーズ2③押し出しキャンセル＝monsterCanReach で射程外なら予告 wait 化）を忠実に再現し、
//   「テレグラフを1手先読みして被弾を最小化しつつ敵を掃討する“最適な守勢の剣プレイヤー”」に arena 戦を戦わせ被ダメ/死亡を実測。
//   ＝「序盤〜中盤で剣の位置取りが被弾を消し尽くして無双になるか（＝死んで継承の核が崩れるか）」を定量判定。
//
//   ★arena は壁縁つきの開けた部屋＝剣の押し出し/カイトに最も有利な best-case。ここで無傷なら実ダンジョン（壁だらけ）でも無傷。
//   ★botは被弾を消す方向の“上限”＝実プレイヤーはここまで完璧に読まない＝この上限で無双でなければ杞憂。
import { makeRng } from "../src/rng.ts";
import { planMonsters, resolveMonsters, monsterCanReach, scaleKind, MONSTER_KINDS } from "../src/dungeon.ts";
import { maxHp, meleeDmg, armorReduce } from "../src/progression.ts";
import { diffMods } from "../src/difficulty.ts";
import type { Difficulty } from "../src/difficulty.ts";
import type { Character } from "../src/types.ts";
import type { Floor, Monster, MonsterKind, Pos } from "../src/dungeon.ts";

const COUNTER_MULT = 1.2, COUNTER_WINDOW = 2, PUSH_WALL_DMG = 4;
function mkRnd(seed: number) { let s = seed >>> 0; return () => { s = (s + 0x6d2b79f5) | 0; let t = Math.imul(s ^ (s >>> 15), 1 | s); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const cheb = (ax: number, ay: number, bx: number, by: number) => Math.max(Math.abs(ax - bx), Math.abs(ay - by));
const isFloor = (f: Floor, x: number, y: number) => x >= 0 && y >= 0 && x < f.w && y < f.h && f.tiles[y * f.w + x] === 1;
const occ = (f: Floor, x: number, y: number, exceptId?: string) => f.monsters.some((m) => m.hp > 0 && m.id !== exceptId && m.x === x && m.y === y);

function meleeChar(L: number): Character {
  const added = L - 1;
  const body = 2 + Math.ceil(added / 2), power = 2 + Math.floor(added / 2);
  const w = Math.round(L * 0.3) + 3, a = Math.round(L * 0.12);
  return { name: "Sim", level: L, stats: { body, power, reason: 2, heart: 2 }, depth: L,
    equipment: { weapon: { dmg: w }, armor: { reduce: a }, relic: null, bag: null } } as unknown as Character;
}
/** 壁縁つきの部屋。wallFrac>0 で内部に柱（障害物）を撒く＝実ダンジョンの壁/角/通路を再現（押し出しキャンセルが失敗しうる）。 */
function arena(size: number, wallFrac: number, rng: () => number): Floor {
  const w = size, h = size, tiles = new Array(w * h).fill(1);
  for (let x = 0; x < w; x++) { tiles[x] = 0; tiles[(h - 1) * w + x] = 0; }
  for (let y = 0; y < h; y++) { tiles[y * w] = 0; tiles[y * w + w - 1] = 0; }
  if (wallFrac > 0) for (let y = 2; y < h - 2; y++) for (let x = 2; x < w - 2; x++) { if (rng() < wallFrac) tiles[y * w + x] = 0; } // 内部に柱を撒く（開始まわりは呼び側でクリア）
  return { w, h, tiles, monsters: [], fossils: [], chests: [], shrines: [], returnDoor: null, depth: 0, explored: new Array(w * h).fill(true), stairsUp: { x: 1, y: 1 }, stairsDown: { x: w - 2, y: h - 2 } } as unknown as Floor;
}

function intentHits(m: Monster, x: number, y: number): boolean {
  const it = m.intent; if (!it || it.type !== "attack") return false;
  if (it.cells) return it.cells.some((c) => c.x === x && c.y === y);
  return it.x === x && it.y === y;
}
function estimateThreat(f: Floor, x: number, y: number, cancelled: Set<string>, armor: number): number {
  let sum = 0;
  for (const m of f.monsters) if (m.hp > 0 && !cancelled.has(m.id) && intentHits(m, x, y)) sum += Math.max(1, m.kind.dmg - armor);
  return sum;
}
/** 判断用の押し出しシミュレート（非破壊）：射程外に出れば cancelled に入れる。 */
function simPush(f: Floor, E: Monster, px: number, py: number, cancelled: Set<string>): void {
  const dx = Math.sign(E.x - px), dy = Math.sign(E.y - py); if (dx === 0 && dy === 0) return;
  const nx = E.x + dx, ny = E.y + dy; let ex = E.x, ey = E.y;
  if (isFloor(f, nx, ny) && !occ(f, nx, ny, E.id) && !(nx === px && ny === py)) { ex = nx; ey = ny; }
  if (E.intent?.type === "attack" && E.intent.x === px && E.intent.y === py && !monsterCanReach(f, ex, ey, px, py, E.kind.reach ?? 1)) cancelled.add(E.id);
}
/** 押し出しの実適用（③④）。 */
function realPush(f: Floor, E: Monster, px: number, py: number): void {
  const dx = Math.sign(E.x - px), dy = Math.sign(E.y - py); if (dx === 0 && dy === 0) return;
  const nx = E.x + dx, ny = E.y + dy;
  if (isFloor(f, nx, ny) && !occ(f, nx, ny, E.id) && !(nx === px && ny === py)) { E.x = nx; E.y = ny; }
  else if (!isFloor(f, nx, ny)) { E.hp -= PUSH_WALL_DMG; if (E.hp <= 0) return; }
  if (E.hp > 0 && E.intent?.type === "attack" && E.intent.x === px && E.intent.y === py && !monsterCanReach(f, E.x, E.y, px, py, E.kind.reach ?? 1)) E.intent = { type: "wait" };
}

interface Run { cleared: boolean; died: boolean; hpLostPct: number; noDamage: boolean }
/** arena で pack を掃討し切るまで戦う守勢の剣プレイヤー。テレグラフ1手先読みで被弾最小＋敵へ接近。wallFrac>0=障害物あり。 */
function swordArena(diff: Difficulty, depth: number, pack: MonsterKind[], seed: number, wallFrac: number): Run {
  const arng = mkRnd((seed ^ 0xa5e4) >>> 0);
  const f = arena(13, wallFrac, arng);
  const ch = meleeChar(depth);
  const hpMax = maxHp(ch), baseDmg = meleeDmg(ch), armor = armorReduce(ch);
  let hp = hpMax, px = 6, py = 6, counter = 0, dmgTotal = 0;
  const rng = makeRng((seed ^ (depth * 40503) ^ 0x5c0d) >>> 0);
  for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) f.tiles[(py + dy) * f.w + (px + dx)] = 1; // 開始マス＋周囲は床（柱で即詰みを避ける）
  // pack を中心の周囲の床マスへ配置（障害物ありでも有効な床のみ）
  const ring: Pos[] = []; for (let r = 2; r <= 5; r++) for (let a = 0; a < 12; a++) { const x = px + Math.round(r * Math.cos(a * Math.PI / 6)), y = py + Math.round(r * Math.sin(a * Math.PI / 6)); if (isFloor(f, x, y) && !(x === px && y === py) && !ring.some((q) => q.x === x && q.y === y)) ring.push({ x, y }); }
  pack.forEach((k, i) => { const p = ring[(i * 2) % Math.max(1, ring.length)] ?? { x: px + 1, y: py }; if (!f.monsters.some((m) => m.x === p.x && m.y === p.y)) f.monsters.push({ id: `m${i}`, kind: k, hp: k.hp, x: p.x, y: p.y, awake: true, intent: null } as Monster); });

  planMonsters(f, { x: px, y: py }, rng);
  for (let turn = 1; turn <= 300; turn++) {
    if (!f.monsters.some((m) => m.hp > 0)) return { cleared: true, died: false, hpLostPct: Math.round(100 * (hpMax - hp) / hpMax), noDamage: dmgTotal === 0 };
    if (counter > 0) counter--;
    const alive = f.monsters.filter((m) => m.hp > 0);
    let nearD = Infinity; for (const m of alive) nearD = Math.min(nearD, cheb(px, py, m.x, m.y));

    type Cand = { kind: "attack" | "move" | "wait"; E?: Monster; nx: number; ny: number; dmg: number; kill: number; closer: number; isAtk: number };
    const cands: Cand[] = [];
    for (const E of alive) { // 攻撃候補（隣接）
      if (cheb(px, py, E.x, E.y) > 1) continue;
      const cancelled = new Set<string>(); const crit = counter > 0;
      const dmg = crit ? Math.round(baseDmg * COUNTER_MULT) : baseDmg; const willKill = E.hp - dmg <= 0;
      if (willKill) cancelled.add(E.id); else if (crit) simPush(f, E, px, py, cancelled);
      cands.push({ kind: "attack", E, nx: px, ny: py, dmg: estimateThreat(f, px, py, cancelled, armor), kill: willKill ? 1 : 0, closer: 0, isAtk: 1 });
    }
    for (const [dx, dy] of [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]] as const) { // 移動＋待機
      const nx = px + dx, ny = py + dy;
      if (!(dx === 0 && dy === 0)) { if (!isFloor(f, nx, ny) || occ(f, nx, ny)) continue; }
      let nd = Infinity; for (const m of alive) nd = Math.min(nd, cheb(nx, ny, m.x, m.y));
      cands.push({ kind: dx === 0 && dy === 0 ? "wait" : "move", nx, ny, dmg: estimateThreat(f, nx, ny, new Set(), armor), kill: 0, closer: nearD - nd, isAtk: 0 });
    }
    // 選択：①被弾最小 ②撃破優先 ③（掃討のため）敵へ接近 ④攻撃優先（膠着回避）
    cands.sort((a, b) => a.dmg - b.dmg || b.kill - a.kill || b.closer - a.closer || b.isAtk - a.isAtk);
    const act = cands[0];

    if (act.kind === "attack" && act.E) {
      const E = act.E, crit = counter > 0; const dmg = crit ? Math.round(baseDmg * COUNTER_MULT) : baseDmg;
      E.hp -= dmg; if (crit) counter = 0;
      if (E.hp > 0 && crit) realPush(f, E, px, py);
    } else { px = act.nx; py = act.ny; }

    const res = resolveMonsters(f, { x: px, y: py });
    for (const h of res.hits) { if (h.target !== "player") continue; const d = Math.max(1, h.dmg - armor); hp -= d; dmgTotal += d; }
    if (res.dodges.length > 0 && hp > 0) counter = COUNTER_WINDOW;
    if (hp <= 0) return { cleared: false, died: true, hpLostPct: 100, noDamage: false };
    planMonsters(f, { x: px, y: py }, rng);
  }
  return { cleared: false, died: false, hpLostPct: Math.round(100 * (hpMax - hp) / hpMax), noDamage: dmgTotal === 0 }; // STALE（掃討し切れず）
}

/** 深度 D で出現する種から pack を組む（scaleKind で深度＋難易度スケール）。全 tier（ボスは MONSTER_KINDS に無い＝含まれない）。 */
function makePack(depth: number, diff: Difficulty, size: number, rng: () => number): MonsterKind[] {
  const mods = diffMods(diff);
  const pool = MONSTER_KINDS.filter((k) => k.minDepth <= depth && (k.maxDepth === undefined || depth <= k.maxDepth));
  const use = pool.length ? pool : MONSTER_KINDS.filter((k) => k.minDepth <= depth);
  const out: MonsterKind[] = [];
  for (let i = 0; i < size; i++) out.push(scaleKind(use[Math.floor(rng() * use.length)], depth, mods));
  return out;
}

// ---------- 実行：round2＝caveat を潰す（障害物あり geometry・pack サイズ掃引 1〜5・深層 d40・全 tier） ----------
const SEEDS = Array.from({ length: 60 }, (_, i) => i + 1);
const DEPTHS = [2, 4, 6, 8, 11, 14, 18, 24, 30, 40];
const DIFF: Difficulty = "normal"; // 標準難易度で代表（easy/hard は round1 で傾向確認済み）

function cell(diff: Difficulty, depth: number, size: number, wallFrac: number): { noDmg: number; avgHp: number; clr: number } {
  const runs = SEEDS.map((s) => { const rnd = mkRnd((s ^ (depth << 8) ^ (size << 16) ^ (Math.round(wallFrac * 100) << 22)) >>> 0); return swordArena(diff, depth, makePack(depth, diff, size, rnd), s, wallFrac); });
  const clr = runs.filter((r) => r.cleared).length;
  const noDmg = runs.filter((r) => r.cleared && r.noDamage).length;
  const avgHp = runs.reduce((a, r) => a + r.hpLostPct, 0) / runs.length;
  return { noDmg: Math.round(100 * noDmg / runs.length), avgHp: Math.round(avgHp), clr: Math.round(100 * clr / runs.length) };
}

console.log("守勢の剣シム round2＝テレグラフ1手先読みで被弾最小化する“最適プレイヤー”（上限）。60seed・難易度normal・全tier。");
console.log("  ★caveat を潰す：①障害物あり arena（壁/角/通路を再現＝押し出しキャンセルが失敗しうる）②pack 1〜5体 ③深層 d40 まで。\n");

for (const geo of [{ name: "開所（障害物なし＝best-case）", wall: 0 }, { name: "障害物あり（wall12%＝実ダンジョン寄り）", wall: 0.12 }]) {
  console.log(`================ ${geo.name} ================`);
  console.log("  無傷掃討% ＝ 被弾ゼロで掃討できた割合（高い＝剣で無双）。［平均HP損%］。掃討し切れず(STALE)は割愛。");
  console.log("  深度 \\ 敵数   1体      2体      3体      4体      5体");
  for (const depth of DEPTHS) {
    const cols = [1, 2, 3, 4, 5].map((sz) => { const c = cell(DIFF, depth, sz, geo.wall); return `${String(c.noDmg).padStart(3)}%[${String(c.avgHp).padStart(2)}]`; });
    console.log(`  D${String(depth).padStart(2)}      ${cols.join("  ")}`);
  }
  console.log("");
}
console.log("  読み方：数字=無傷掃討%（被弾ゼロ率）／[]=平均HP損%。");
console.log("  ・1体列が高い＝開所の単体戦は剣で無傷（想定内）。障害物ありで下がる＝壁際は反撃を喰らう。");
console.log("  ・敵数が増える/深いほど無傷%が落ちHP損が増える＝群れ・深部は位置取りでは消し切れない＝終始シビアが効く。");
console.log("  ・これは“最適に読む上限”＝実プレイヤーはここまで完璧でない＝この上限で群れ/深部が崩れるなら実プレイはより厳しい。");

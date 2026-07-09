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
/** 壁縁つきの開けた部屋（押し出し/カイトが最も効く best-case）。 */
function arena(size = 11): Floor {
  const w = size, h = size, tiles = new Array(w * h).fill(1);
  for (let x = 0; x < w; x++) { tiles[x] = 0; tiles[(h - 1) * w + x] = 0; }
  for (let y = 0; y < h; y++) { tiles[y * w] = 0; tiles[y * w + w - 1] = 0; }
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
/** arena で pack を掃討し切るまで戦う守勢の剣プレイヤー。テレグラフ1手先読みで被弾最小＋敵へ接近。 */
function swordArena(diff: Difficulty, depth: number, pack: MonsterKind[], seed: number): Run {
  const f = arena(11);
  const ch = meleeChar(depth);
  const hpMax = maxHp(ch), baseDmg = meleeDmg(ch), armor = armorReduce(ch);
  let hp = hpMax, px = 5, py = 5, counter = 0, dmgTotal = 0;
  const rng = makeRng((seed ^ (depth * 40503) ^ 0x5c0d) >>> 0);
  // pack をリング状に配置
  const ring: Pos[] = []; for (let r = 2; r <= 4; r++) for (let a = 0; a < 8; a++) { const x = 5 + Math.round(r * Math.cos(a * Math.PI / 4)), y = 5 + Math.round(r * Math.sin(a * Math.PI / 4)); if (isFloor(f, x, y) && !(x === 5 && y === 5)) ring.push({ x, y }); }
  pack.forEach((k, i) => { const p = ring[(i * 3) % ring.length] ?? { x: 6, y: 5 }; f.monsters.push({ id: `m${i}`, kind: k, hp: k.hp, x: p.x, y: p.y, awake: true, intent: null } as Monster); });

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

/** 深度 D で出現する種から pack を組む（scaleKind で深度＋難易度スケール）。size 体。 */
function makePack(depth: number, diff: Difficulty, size: number, rng: () => number): MonsterKind[] {
  const mods = diffMods(diff);
  const pool = MONSTER_KINDS.filter((k) => k.minDepth <= depth && (k.maxDepth === undefined || depth <= k.maxDepth) && k.tier <= 3); // 序盤帯＝雑魚〜中位（ボス級は除外）
  const use = pool.length ? pool : MONSTER_KINDS.filter((k) => k.minDepth <= depth);
  const out: MonsterKind[] = [];
  for (let i = 0; i < size; i++) out.push(scaleKind(use[Math.floor(rng() * use.length)], depth, mods));
  return out;
}

// ---------- 実行：序盤〜中盤（d1〜24）を「1対1（開所＝剣の best-case）」と「3体の群れ」で ----------
const SEEDS = Array.from({ length: 40 }, (_, i) => i + 1);
const DEPTHS = [2, 4, 6, 8, 11, 14, 18, 24];
const DIFFS: Difficulty[] = ["easy", "normal", "hard"];
function mkRnd(seed: number) { let s = seed >>> 0; return () => { s = (s + 0x6d2b79f5) | 0; let t = Math.imul(s ^ (s >>> 15), 1 | s); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

console.log("守勢の剣シム＝テレグラフ1手先読みで被弾最小化する“最適プレイヤー”が、開所(arena)で pack を掃討。");
console.log("  ★arena は壁縁つきの開けた部屋＝押し出し/カイトに最も有利な best-case（ここで無傷なら実ダンジョンでも無傷）。");
console.log("  各セル: 掃討% / 死亡% / 無傷掃討% / 平均HP損%  ＝『剣は序盤の戦闘を被弾ゼロで捌けるか（死んで継承の核が崩れるか）』\n");
for (const scen of [{ name: "1対1（開所＝best-case）", size: 1 }, { name: "3体の群れ", size: 3 }]) {
  console.log(`================ シナリオ：${scen.name} ================`);
  for (const diff of DIFFS) {
    console.log(`-- 難易度 ${diff} --`);
    for (const depth of DEPTHS) {
      const runs = SEEDS.map((s) => { const rnd = mkRnd((s ^ (depth << 8) ^ (scen.size << 16)) >>> 0); return swordArena(diff, depth, makePack(depth, diff, scen.size, rnd), s); });
      const clr = runs.filter((r) => r.cleared).length, died = runs.filter((r) => r.died).length;
      const noDmg = runs.filter((r) => r.cleared && r.noDamage).length;
      const avgHp = Math.round(runs.reduce((a, r) => a + r.hpLostPct, 0) / runs.length);
      const pct = (n: number) => `${Math.round(100 * n / runs.length)}%`.padStart(4);
      console.log(`  D${String(depth).padStart(2)} | 掃討 ${pct(clr)} | 死亡 ${pct(died)} | 無傷掃討 ${pct(noDmg)} | 平均HP損 ${String(avgHp).padStart(3)}%`);
    }
  }
}
console.log("\n  ※1対1で『無傷掃討%』が高い＝開所の単体戦は被弾ゼロで捌ける（剣の位置取りの狙いどおり・想定内）。");
console.log("  ※群れで『無傷掃討%』が低い/『HP損』が残る＝複数同時攻撃は消し切れない＝群れ・クラスタが難易度を保つ。");
console.log("  ※死亡% がゼロでも、群れで HP を削られるなら“消耗→回復資源→いずれ事故死”＝死んで継承の核は残る。");

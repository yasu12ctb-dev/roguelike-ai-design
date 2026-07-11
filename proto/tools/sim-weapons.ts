// 武器比較シム（2026-07-11・ユーザーFB「剣が一番弱い／受けがあっても弱い／吹き飛ばしを剣専用にすべきか？」検証）。
//   sim-sword.ts を土台に、剣/槍/薙刀(現行)/薙刀(新案：十字距離2)の4クラスを web の戦闘ルールに忠実に実装し、
//   テレグラフ1手先読みで被弾最小化しつつ掃討する“最適プレイヤー”bot で arena 戦を戦わせ、
//   武器×深度×pack×地形×変種ごとに 無傷率/HP損/死亡率/クリア手数 を実測する。
//
//   ★被ダメは normal 式（chipFrac=0.20）＝main.ts:5432。会心=見切り(counter)×1.2＋押し出し(pushEnemy)＝
//     押し出しで敵をその攻撃射程外に出せば予告一撃をキャンセル（無傷）。受け（剣専用）＝隣接1撃を無効化。
//   ★bot は情報完全（全intent既知）＝人間より上手い＝無傷率は「上限値」。相対比較（どの武器が強い/弱い）に使う。
//
//   実行：cd proto && node --experimental-strip-types tools/sim-weapons.ts
import { makeRng } from "../src/rng.ts";
import { planMonsters, resolveMonsters, monsterCanReach, canBurstReach, scaleKind, MONSTER_KINDS } from "../src/dungeon.ts";
import { maxHp, meleeDmg, armorReduce } from "../src/progression.ts";
import { diffMods } from "../src/difficulty.ts";
import type { Difficulty, DifficultyMods } from "../src/difficulty.ts";
import type { Character } from "../src/types.ts";
import type { Floor, Monster, MonsterKind, Pos } from "../src/dungeon.ts";

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
function arena(size: number, wallFrac: number, rng: () => number): Floor {
  const w = size, h = size, tiles = new Array(w * h).fill(1);
  for (let x = 0; x < w; x++) { tiles[x] = 0; tiles[(h - 1) * w + x] = 0; }
  for (let y = 0; y < h; y++) { tiles[y * w] = 0; tiles[y * w + w - 1] = 0; }
  if (wallFrac > 0) for (let y = 2; y < h - 2; y++) for (let x = 2; x < w - 2; x++) { if (rng() < wallFrac) tiles[y * w + x] = 0; }
  return { w, h, tiles, monsters: [], fossils: [], chests: [], shrines: [], returnDoor: null, depth: 0, explored: new Array(w * h).fill(true), stairsUp: { x: 1, y: 1 }, stairsDown: { x: w - 2, y: h - 2 } } as unknown as Floor;
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
/** 押し出しの実適用（web pushEnemy 忠実：壁+4／敵衝突±2／空き移動＋射程外なら予告 wait 化）。 */
function realPush(f: Floor, E: Monster, px: number, py: number): void {
  const dx = Math.sign(E.x - px), dy = Math.sign(E.y - py); if (dx === 0 && dy === 0) return;
  const nx = E.x + dx, ny = E.y + dy;
  if (!isFloor(f, nx, ny)) { E.hp -= PUSH_WALL_DMG; }
  else if (occ(f, nx, ny, E.id) || (nx === px && ny === py)) {
    const other = f.monsters.find((mm) => mm.hp > 0 && mm.x === nx && mm.y === ny);
    if (other) { E.hp -= PUSH_COLLIDE_DMG; other.hp -= PUSH_COLLIDE_DMG; }
  } else { E.x = nx; E.y = ny; }
  if (E.hp > 0 && E.intent?.type === "attack" && E.intent.x === px && E.intent.y === py) {
    const still = E.kind.ability === "burst" ? canBurstReach(f, E.x, E.y, px, py) : monsterCanReach(f, E.x, E.y, px, py, E.kind.reach ?? 1);
    if (!still) E.intent = { type: "wait" };
  }
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
  } else { // naginata_bar（v0.150.0）：振った十字方向の距離2に横3マスバー。中央=100%（会心/proc）／肩=×0.8（会心なし）。距離1は完全死角。
    // main.ts naginataSweep 忠実：発火は3バーセルのいずれかに敵がいる時のみ（隣接=距離1には一切触れない）。LOS/床ゲートなし（敵は必ず床上）。
    const cx = px + 2 * dx, cy = py + 2 * dy;
    const [ox, oy] = dx === 0 ? [1, 0] : [0, 1];               // 進行方向に垂直な肩オフセット
    const primary = monAt(f, cx, cy);
    const s1 = monAt(f, cx + ox, cy + oy), s2 = monAt(f, cx - ox, cy - oy);
    const sides = [s1, s2].filter((s): s is Monster => !!s && s !== primary);
    if (!primary && sides.length === 0) return;               // バーに敵なし＝薙げない（隣接の敵は斬れない）
    const sd = Math.max(1, Math.round(base * NAG_SHOULDER));   // 肩＝基礎ダメ80%（会心・proc なし）
    for (const sm of sides) sm.hp -= sd;
    if (primary) { primary.hp -= cdmg; if (crit) counterRef.v = 0; }
    if (crit && pushOn) for (const m of [primary, ...sides]) if (m && m.hp > 0) { realPush(f, m, px, py); m.stunned = Math.max(m.stunned ?? 0, NAGINATA_STAGGER); }
  }
}
/** 候補評価：この行動後（px,py で評価）の被弾見込み。guard=剣の受け（full=隣接1撃を無効化／half=半減）。 */
function threatAt(f: Floor, px: number, py: number, armor: number, chip: number, guard: GuardMode | "off"): number {
  const hits: { d: number; adj: boolean }[] = [];
  for (const m of f.monsters) if (m.hp > 0 && intentHits(m, px, py)) hits.push({ d: takenFrom(m, armor, chip), adj: cheb(px, py, m.x, m.y) <= 1 });
  let sum = hits.reduce((a, h) => a + h.d, 0);
  if (guard === "full" || guard === "half") {
    let best = 0; for (const h of hits) if (h.adj && h.d > best) best = h.d; // 受けは最大の隣接1撃に当てる（解決と同じ＝最大の1発を消す）
    sum -= guard === "full" ? best : Math.floor(best / 2); // full=無効化／half=半減（節約分＝floor(d/2)）
  }
  return sum;
}

interface Run { cleared: boolean; died: boolean; hpLostPct: number; noDamage: boolean; turns: number; atkless: number }
function fight(depth: number, weapon: WeaponKind, variant: Variant, pack: MonsterKind[], seed: number, wallFrac: number, mods: DifficultyMods): Run {
  const arng = mkRnd((seed ^ 0xa5e4) >>> 0);
  const f = arena(13, wallFrac, arng);
  const dmgOff = weapon === "sword" ? 0 : 1;
  const ch = meleeChar(depth, dmgOff);
  const hpMax = maxHp(ch), base = meleeDmg(ch), armor = armorReduce(ch), chip = mods.chipFrac;
  const canGuard = weapon === "sword" && variant.guard !== "none";
  const pushOn = variant.push === "all" || weapon === "sword"; // swordOnly＝剣のみ押し出し（薙刀は stagger も失う）
  let hp = hpMax, px = 6, py = 6, counter = 0, dmgTotal = 0, atkless = 0;
  const rng = makeRng((seed ^ (depth * 40503) ^ 0x5c0d) >>> 0);
  for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) f.tiles[(py + dy) * f.w + (px + dx)] = 1;
  const ring: Pos[] = []; for (let r = 2; r <= 5; r++) for (let a = 0; a < 12; a++) { const x = px + Math.round(r * Math.cos(a * Math.PI / 6)), y = py + Math.round(r * Math.sin(a * Math.PI / 6)); if (isFloor(f, x, y) && !(x === px && y === py) && !ring.some((q) => q.x === x && q.y === y)) ring.push({ x, y }); }
  pack.forEach((k, i) => { const p = ring[(i * 2) % Math.max(1, ring.length)] ?? { x: px + 1, y: py }; if (!f.monsters.some((m) => m.x === p.x && m.y === p.y)) f.monsters.push({ id: `m${i}`, kind: k, hp: k.hp, x: p.x, y: p.y, awake: true, intent: null } as Monster); });

  planMonsters(f, { x: px, y: py }, rng);
  for (let turn = 1; turn <= 200; turn++) {
    if (!f.monsters.some((m) => m.hp > 0)) return { cleared: true, died: false, hpLostPct: Math.round(100 * (hpMax - hp) / hpMax), noDamage: dmgTotal === 0, turns: turn, atkless };
    if (counter > 0) counter--;
    const alive = f.monsters.filter((m) => m.hp > 0);
    let nearD = Infinity; for (const m of alive) nearD = Math.min(nearD, cheb(px, py, m.x, m.y));

    type Cand = { kind: "attack" | "move" | "wait" | "guard"; dx: number; dy: number; dmg: number; kill: number; closer: number; setup: number; isAtk: number };
    const cands: Cand[] = [];
    const beforeAlive = alive.length;
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
      if (killedNow === origDead && sameHp(f, cf)) continue; // この方向は何も起きない＝非攻撃（無効）
      const kills = killedNow - origDead;
      cands.push({ kind: "attack", dx, dy, dmg: threatAt(cf, px, py, armor, chip, "off"), kill: kills, closer: 0, setup: 5, isAtk: 1 });
    }
    if (!cands.some((c) => c.kind === "attack")) atkless++; // 敵は生存中なのに一手も攻撃できない＝薙刀のストレス指標（間合い取り直しに費やす手番）
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
    else if (act.kind === "guard") { guardArmed = true; }
    else { px += act.dx; py += act.dy; }

    const res = resolveMonsters(f, { x: px, y: py });
    // 被弾：guard 中は最大の隣接近接1撃を full=無効化／half=半減（＋反撃の好機）
    const playerHits = res.hits.filter((h) => h.target === "player");
    let guardIdx = -1;
    if (guardArmed && (variant.guard === "full" || variant.guard === "half")) {
      let bestD = -1;
      for (let i = 0; i < playerHits.length; i++) { const h = playerHits[i]; if (cheb(px, py, h.monster.x, h.monster.y) <= 1) { const d = takenFrom(h.monster, armor, chip); if (d > bestD) { bestD = d; guardIdx = i; } } }
      if (guardIdx >= 0) counter = COUNTER_WINDOW;
    }
    for (let i = 0; i < playerHits.length; i++) {
      let d = takenFrom(playerHits[i].monster, armor, chip);
      if (i === guardIdx) d = variant.guard === "full" ? 0 : Math.ceil(d * 0.5);
      hp -= d; dmgTotal += d;
    }
    if (res.dodges.length > 0 && hp > 0) counter = COUNTER_WINDOW;
    if (hp <= 0) return { cleared: false, died: true, hpLostPct: 100, noDamage: false, turns: turn, atkless };
    planMonsters(f, { x: px, y: py }, rng);
    if (beforeAlive === 0) break;
  }
  return { cleared: false, died: false, hpLostPct: Math.round(100 * (hpMax - hp) / hpMax), noDamage: dmgTotal === 0, turns: 200, atkless };
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

function cell(depth: number, wk: LogicalWeapon, variant: Variant, size: number, wallFrac: number) {
  const weapon = resolveWeapon(wk, variant);
  const runs = SEEDS.map((s) => {
    const rnd = mkRnd((s ^ (depth << 8) ^ (size << 16) ^ (Math.round(wallFrac * 100) << 22)) >>> 0);
    const pack = makePack(depth, MODS, size, rnd);
    return fight(depth, weapon, variant, pack, s, wallFrac, MODS);
  });
  const n = runs.length;
  const noDmg = Math.round(100 * runs.filter((r) => r.cleared && r.noDamage).length / n);
  const avgHp = Math.round(runs.reduce((a, r) => a + r.hpLostPct, 0) / n);
  const death = Math.round(100 * runs.filter((r) => r.died).length / n);
  const cleared = runs.filter((r) => r.cleared);
  const clrT = cleared.length ? Math.round(cleared.reduce((a, r) => a + r.turns, 0) / cleared.length) : 0;
  const totTurns = runs.reduce((a, r) => a + r.turns, 0);
  const stall = Math.round(100 * runs.reduce((a, r) => a + r.atkless, 0) / Math.max(1, totTurns)); // 攻撃不能手番の割合(%)
  return { noDmg, avgHp, death, clrT, clr: Math.round(100 * cleared.length / n), stall };
}

console.log("武器比較シム＝テレグラフ1手先読みで被弾最小化する“最適プレイヤー”（上限値）。60seed・難易度normal・注目種(形/突進/長柄/炸裂)を必ず混入。");
console.log("  剣=万能8方向(受け半減+会心衝撃波=全隣接押出)／槍=十字距離1-2貫通(距離1×0.5・剣比dmg-1)／薙刀(v0.150 bar)=十字距離2の横3マスバー・中央100%/肩80%・隣接(距離1)は完全死角・剣比dmg-1。");
console.log("  ★薙刀 bot：隣接の敵は斬れず被弾源＝『間合いを取り直す』割り切りを実装（setup ヒューリスティックで距離2直線を作り隣接を避ける・攻撃不能なら退く一手を使う）。");
console.log("  被ダメ=normal式 max(1, ceil(rawDmg×0.20), rawDmg-防具)。会心=見切り×1.2＋押出（射程外に出せば予告一撃キャンセル）。\n");
console.log("  各セル表記＝ 無傷%|HP損%|死%|掃討% （無傷=被弾ゼロ掃討率／HP損=maxHp比平均／死=死亡率／掃討=クリア率。掃討低＋HP損低＝間合いを作れず倒し切れずSTALE）\n");

for (const v of VARIANTS) {
  console.log(`\n############ ${v.name} ############`);
  for (const t of TERRAIN) {
    for (const depth of DEPTHS) {
      console.log(`  ── ${t.name} D${depth} ──   pack:  1体              2体              3体              5体`);
      for (const w of WEAPONS) {
        const cols = PACKS.map((sz) => { const c = cell(depth, w.k, v, sz, t.wall); return `${String(c.noDmg).padStart(3)}|${String(c.avgHp).padStart(2)}|${String(c.death).padStart(2)}|${String(c.clr).padStart(3)}`; });
        console.log(`     ${w.label}              ${cols.join("  ")}`);
      }
    }
  }
}
// ── 全セル平均の武器序列（2地形×3深度×4pack=24セル平均・pack1〜5込み）──
console.log("\n\n======== 武器序列＝全24セル(2地形×3深度×4pack)平均 ========");
for (const v of VARIANTS) {
  console.log(`\n[${v.name}]  武器 :  無傷%平均 / HP損%平均 / 死%平均 / 掃討%平均`);
  for (const w of WEAPONS) {
    let nd = 0, hp = 0, dt = 0, cl = 0, n = 0;
    for (const t of TERRAIN) for (const depth of DEPTHS) for (const sz of PACKS) { const c = cell(depth, w.k, v, sz, t.wall); nd += c.noDmg; hp += c.avgHp; dt += c.death; cl += c.clr; n++; }
    console.log(`   ${w.label}:  ${(nd / n).toFixed(0).padStart(3)}    /  ${(hp / n).toFixed(0).padStart(3)}   /  ${(dt / n).toFixed(0).padStart(3)}  /  ${(cl / n).toFixed(0).padStart(3)}`);
  }
}
console.log("\n読み方：無傷%高＝その武器で被弾ゼロで捌ける（=強い）。HP損%・死%高＝崩れやすい（=弱い）。掃討%低＝倒し切れない。");
console.log("bot は情報完全＝実プレイヤーより上手い＝無傷%は上限。相対（武器間の優劣）を見る。");

// ── 薙刀ストレス指標（答え(d)）＝『距離2を作れず一手も薙げない』手番の割合(%)。高い＝間合い取り直しで手を空費＝ストレス ──
console.log("\n\n======== 薙刀(bar)ストレス＝攻撃不能手番の割合(%)〔敵生存中に一手も薙げなかった手番/総手番〕========");
console.log("  ※高いほど『隣接に張り付かれ間合いを作れない』＝ストレス。地形×深度×pack別（LIVE v0.150 の薙刀のみ）。");
for (const t of TERRAIN) {
  console.log(`  ── ${t.name} ──   pack:  1体    2体    3体    5体`);
  for (const depth of DEPTHS) {
    const cols = PACKS.map((sz) => `${String(cell(depth, "naginata", VARIANTS[0], sz, t.wall).stall).padStart(3)}%`);
    console.log(`     D${String(depth).padStart(2)}                ${cols.join("   ")}`);
  }
}
console.log("\n★シムの限界：bot は全 intent 既知＝無傷%は上限（人間はもっと被弾）／障害物地形は幅1通路のチョークを再現せず＝通路で薙刀/槍が刺さる場面を過小評価／");
console.log("  持ち替え・押し出しの読み合い・押し出しキャンセルの妙手は近似（bot は薙刀では持ち替えず『退く』でのみ間合いを取る）。");

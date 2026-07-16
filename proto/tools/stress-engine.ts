// エンジン多シード stress（デスクトップ Claude Code 用・純エンジンの堅牢性検査）。
// 目的：crash / NaN / 不変条件違反（到達不能な階段・敵総数超過・座標逸脱・HP発散）を多シードで炙り出す。
// 実行: node --experimental-strip-types tools/stress-engine.ts
import { makeRng } from "../src/rng.ts";
import {
  genFloor, planMonsters, resolveMonsters, planCompanion, resolveCompanion,
  spawnPursuer, genRaidField, bfsPath, reachableSet, mapIdx, scaleKind, MONSTER_KINDS,
  MONSTER_HARDCAP, monsterHardcap, companionMaxHp,
  type Floor, type CompanionEntity, type Monster,
} from "../src/dungeon.ts";
import { diffMods } from "../src/difficulty.ts";
import {
  newWorld, createCharacter, fossilizeCurrent, fossilizeCompanion, fossilizeAbandoned,
  advanceArcs, intervene, accrueArcWarp, recordRediscovery, awardSeal,
} from "../src/world.ts";
import { SELECTABLE_DIFFICULTIES } from "../src/difficulty.ts";
import { maxHp } from "../src/progression.ts";
import type { Character, Lineage, Fossil } from "../src/types.ts";

// フロアの実際の敵上限（v0.151.0・monsterHardcap＝easy=60据え置き／normal/hard は深度20超で+1/階・最大80）。
// raid のフロアは f.diff が未設定＝easy相当の60が正しい（genRaidField は diff を焼き込まない）。
function capFor(f: Floor): number { return monsterHardcap(f.depth, f.diff ?? diffMods("easy")); }

let FAIL = 0, CHECKS = 0;
const problems: string[] = [];
function bad(msg: string) { FAIL++; if (problems.length < 80) problems.push(msg); }
function ok(cond: boolean, msg: string) { CHECKS++; if (!cond) bad(msg); }
const finite = (n: number) => typeof n === "number" && Number.isFinite(n);

// tiles 上の連結成分 flood（霧 explored を無視＝生成器の真の連結性を見る）。bfsPath は explored 限定なので不可。
function reachTiles(f: Floor, from: { x: number; y: number }): Set<number> {
  const seen = new Set<number>(); const si = mapIdx(f, from.x, from.y);
  if (f.tiles[si] !== 1) return seen;
  seen.add(si); const q = [from];
  for (let h = 0; h < q.length; h++) {
    const c = q[h];
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
      const nx = c.x + dx, ny = c.y + dy;
      if (nx < 0 || ny < 0 || nx >= f.w || ny >= f.h) continue;
      const i = mapIdx(f, nx, ny);
      if (seen.has(i) || f.tiles[i] !== 1) continue;
      seen.add(i); q.push({ x: nx, y: ny });
    }
  }
  return seen;
}

// ---- 1. genFloor 到達性・整合（全深度×全難易度） ----
function checkFloors() {
  for (const diff of SELECTABLE_DIFFICULTIES) {
    for (let seed = 1; seed <= 40; seed++) {
      const w = newWorld(seed * 7 + 1);
      w.difficulty = diff;
      for (const depth of [1, 2, 5, 9, 16, 24, 32, 40, 50]) {
        let f: Floor;
        try { f = genFloor(w, depth); } catch (e: any) { bad(`genFloor throw d${depth} ${diff} seed${seed}: ${e.message}`); continue; }
        // 階段は床の上
        ok(f.tiles[mapIdx(f, f.stairsUp.x, f.stairsUp.y)] === 1, `stairsUp not floor d${depth} ${diff} s${seed}`);
        ok(f.tiles[mapIdx(f, f.stairsDown.x, f.stairsDown.y)] === 1, `stairsDown not floor d${depth} ${diff} s${seed}`);
        // up から down へ到達可能（プレイヤーが詰まない）＝tiles 連結で検査
        const reach = reachTiles(f, f.stairsUp);
        ok(reach.has(mapIdx(f, f.stairsDown.x, f.stairsDown.y)), `no path up→down d${depth} ${diff} s${seed}`);
        // 敵数 <= HARDCAP（難易度・深度で可変＝monsterHardcap）・全敵が床・座標有限
        const cap = capFor(f);
        ok(f.monsters.length <= cap, `monsters>${cap} (${f.monsters.length}) d${depth} ${diff} s${seed}`);
        for (const m of f.monsters) {
          ok(finite(m.x) && finite(m.y) && finite(m.hp) && finite(m.kind.dmg), `monster nonfinite d${depth} ${diff} s${seed} ${m.kind.key}`);
          ok(f.tiles[mapIdx(f, m.x, m.y)] === 1, `monster off-floor d${depth} ${diff} s${seed} ${m.kind.key}`);
          ok(m.hp > 0, `monster hp<=0 at spawn d${depth} ${diff} s${seed} ${m.kind.key}`);
          // 敵はプレイヤーから到達可能な連結成分に居る（孤島に閉じ込められた敵＝設計上は許容だが要観察）
        }
        // 宝箱・祠も床
        for (const c of f.chests) ok(f.tiles[mapIdx(f, c.x, c.y)] === 1, `chest off-floor d${depth} ${diff} s${seed}`);
        for (const s of (f.shrines ?? [])) ok(f.tiles[mapIdx(f, s.x, s.y)] === 1, `shrine off-floor d${depth} ${diff} s${seed}`);
      }
    }
  }
}

// ---- 2. combat フルループ（planMonsters → player attack → resolveMonsters） ----
function simPlayerDmg(rng: any, depth: number) { return 3 + Math.floor(rng.next() * (6 + depth)); }
function combatLoop(seed: number, depth: number, diff: string, withCompanion: boolean) {
  const w = newWorld(seed); w.difficulty = diff as any;
  let f: Floor;
  try { f = genFloor(w, depth); } catch (e: any) { return bad(`combat genFloor throw: ${e.message}`); }
  const rng = makeRng(seed * 131 + depth);
  const player = { x: f.stairsUp.x, y: f.stairsUp.y };
  let php = 40 + depth * 2;
  let comp: CompanionEntity | null = withCompanion
    ? { x: player.x, y: player.y, hp: companionMaxHp(2, depth), maxHp: companionMaxHp(2, depth), grade: 2, name: "相棒", intent: null, exposure: 0.8, erratic: 0.3 } as any
    : null;
  for (let turn = 0; turn < 220; turn++) {
    if (f.monsters.every((m) => m.hp <= 0) && turn > 4) break;
    try {
      planMonsters(f, player, rng, comp, null);
      if (comp && comp.hp > 0) planCompanion(f, player, comp, rng, null);
    } catch (e: any) { return bad(`planMonsters throw s${seed} d${depth} ${diff}: ${e.message}`); }
    // 不変：intent 座標は盤内
    for (const m of f.monsters) {
      if (!m.intent) continue;
      if (m.intent.type === "attack" || m.intent.type === "move") {
        ok(m.intent.x >= 0 && m.intent.y >= 0 && m.intent.x < f.w && m.intent.y < f.h, `intent OOB s${seed} d${depth} ${m.kind.key} ${m.intent.x},${m.intent.y}`);
      }
    }
    // プレイヤー：最寄りの生存敵へ。隣接なら攻撃、でなければ一歩寄る。
    let target: Monster | null = null, td = 1e9;
    for (const m of f.monsters) { if (m.hp <= 0) continue; const d = Math.abs(m.x - player.x) + Math.abs(m.y - player.y); if (d < td) { td = d; target = m; } }
    if (target) {
      if (td <= 1) target.hp -= simPlayerDmg(rng, depth);
      else {
        const sx = Math.sign(target.x - player.x), sy = Math.sign(target.y - player.y);
        const nx = player.x + sx, ny = player.y + sy;
        if (f.tiles[mapIdx(f, nx, ny)] === 1) { player.x = nx; player.y = ny; }
      }
    }
    let res;
    try {
      res = resolveMonsters(f, player, comp, null);
      if (comp && comp.hp > 0) resolveCompanion(f, player, comp);
    } catch (e: any) { return bad(`resolveMonsters throw s${seed} d${depth} ${diff}: ${e.message}`); }
    for (const h of res.hits) {
      ok(finite(h.dmg) && h.dmg >= 0, `hit dmg nonfinite/neg s${seed} d${depth} ${h.monster.kind.key} dmg=${h.dmg}`);
      if (h.target === "player") php -= h.dmg; else if (comp) comp.hp -= h.dmg;
    }
    // breeder 暴走しない（難易度・深度で可変＝monsterHardcap）
    const combatCap = capFor(f);
    ok(f.monsters.length <= combatCap, `combat monsters>${combatCap} (${f.monsters.length}) s${seed} d${depth} ${diff} turn${turn}`);
    // 全敵座標が盤内・床
    for (const m of f.monsters) {
      if (m.hp <= 0) continue;
      ok(m.x >= 0 && m.y >= 0 && m.x < f.w && m.y < f.h && f.tiles[mapIdx(f, m.x, m.y)] === 1, `monster moved off-floor s${seed} d${depth} ${m.kind.key} (${m.x},${m.y})`);
      ok(finite(m.hp), `monster hp nonfinite s${seed} d${depth} ${m.kind.key}`);
    }
    if (comp) { ok(finite(comp.hp), `comp hp nonfinite s${seed} d${depth}`); if (comp.hp <= 0) comp = null; }
    if (php <= 0) break;
  }
}

// ---- 3. 追手・ボス（genFloor 統合経路） ----
function checkPursuerBoss() {
  for (let seed = 1; seed <= 30; seed++) {
    for (const diff of SELECTABLE_DIFFICULTIES) {
      const w = newWorld(seed * 13); w.difficulty = diff;
      for (const depth of [8, 16, 24, 40, 48]) {
        let f: Floor;
        try { f = genFloor(w, depth); } catch (e: any) { bad(`boss-floor genFloor throw d${depth} ${diff} s${seed}: ${e.message}`); continue; }
        const rng = makeRng(seed + depth);
        const p = spawnPursuer(f, rng, f.stairsUp, depth, 1);
        if (p) ok(f.tiles[mapIdx(f, p.x, p.y)] === 1 && finite(p.hp) && p.hp > 0, `pursuer bad d${depth} ${diff} s${seed}`);
        // ボス階（8の倍数）には area ボスが居る
        const boss = f.monsters.find((m) => m.boss === "area");
        if (depth % 8 === 0) ok(!!boss, `no area boss on d${depth} ${diff} s${seed}`);
        if (boss) ok(finite(boss.hp) && boss.hp > 0 && f.tiles[mapIdx(f, boss.x, boss.y)] === 1, `boss bad d${depth} ${diff} s${seed}`);
      }
    }
  }
}

// ---- 4. 街防衛戦（genRaidField + 多 ally combat） ----
function checkRaid() {
  for (let seed = 1; seed <= 30; seed++) {
    for (const scale of ["small", "medium", "large"] as const) {
      const pd = scale === "large" ? 30 : scale === "medium" ? 18 : 8;
      let rf;
      try { rf = genRaidField(seed * 3, scale, pd); }
      catch (e: any) { bad(`genRaidField throw ${scale} s${seed}: ${e.message}`); continue; }
      const f = rf.floor;
      ok(f.tiles[mapIdx(f, rf.playerStart.x, rf.playerStart.y)] === 1, `raid player off-floor ${scale} s${seed}`);
      for (const sp of rf.allySpots) ok(f.tiles[mapIdx(f, sp.x, sp.y)] === 1, `raid allySpot off-floor ${scale} s${seed}`);
      for (const sp of rf.spawnZone) ok(f.tiles[mapIdx(f, sp.x, sp.y)] === 1, `raid spawnZone off-floor ${scale} s${seed}`);
      // 敵を湧き口へ配置（web の spawnRaidWave 相当を簡略再現）
      const mods = diffMods("normal");
      const srng = makeRng(seed + 7);
      const pool = MONSTER_KINDS.filter((k) => (k.minDepth ?? 1) <= pd && (k.maxDepth ?? 99) >= pd);
      const want = scale === "large" ? 8 : scale === "medium" ? 5 : 3;
      const zone = [...rf.spawnZone];
      for (let i = 0; i < want && zone.length > 0; i++) {
        const sp = zone.splice(srng.int(zone.length), 1)[0];
        const k = scaleKind(pool[srng.int(pool.length)] ?? MONSTER_KINDS[0], pd, mods);
        f.monsters.push({ x: sp.x, y: sp.y, hp: k.hp, kind: k, intent: null } as any);
      }
      // 多 ally を自陣に配置
      const allies: CompanionEntity[] = rf.allySpots.slice(0, 4).map((sp, i) => ({ x: sp.x, y: sp.y, hp: 24, maxHp: 24, grade: 2, name: `味方${i}`, intent: null } as any));
      const rng = makeRng(seed + 99);
      const player = { x: rf.playerStart.x, y: rf.playerStart.y };
      for (let t = 0; t < 40; t++) {
        try {
          planMonsters(f, player, rng, null, allies);
          for (const a of allies) if (a.hp > 0) planCompanion(f, player, a, rng, allies.filter((b) => b !== a));
          resolveMonsters(f, player, null, allies);
          for (const a of allies) if (a.hp > 0) resolveCompanion(f, player, a, allies.filter((b) => b !== a));
        } catch (e: any) { bad(`raid combat throw ${scale} s${seed} t${t}: ${e.message}`); break; }
        // raid フロアは f.diff 未設定＝easy相当の60が正しい cap（genRaidField は diff を焼き込まない）。
        const raidCap = capFor(f);
        ok(f.monsters.length <= raidCap, `raid monsters>${raidCap} ${scale} s${seed}`);
        for (const m of f.monsters) if (m.hp > 0) ok(f.tiles[mapIdx(f, m.x, m.y)] === 1, `raid monster off-floor ${scale} s${seed} ${m.kind.key}`);
        for (let i = 0; i < allies.length; i++) for (let j = i + 1; j < allies.length; j++)
          if (allies[i].hp > 0 && allies[j].hp > 0) ok(!(allies[i].x === allies[j].x && allies[i].y === allies[j].y), `raid ally overlap ${scale} s${seed} t${t}`);
      }
    }
  }
}

// ---- 5. 多世代 world lifecycle（系譜・弧・化石化・印） ----
function checkLifecycle() {
  for (let seed = 1; seed <= 25; seed++) {
    for (const diff of SELECTABLE_DIFFICULTIES) {
      const w = newWorld(seed * 17 + 3); w.difficulty = diff;
      let prevFossil: Fossil | null = null;
      for (let gen = 0; gen < 30; gen++) {
        // 系譜：血縁/弟子/無を循環
        let lineage: Lineage = { relation: "none" };
        const anc = w.fossils.filter((f) => f.kind === "character").slice(-1)[0];
        if (anc) {
          const mode = gen % 3;
          if (mode === 0) lineage = { relation: "blood", ancestorFossilId: anc.id, chosenSpells: (anc.spells ?? []).slice(0, 2) };
          else if (mode === 1) lineage = { relation: "pupil", ancestorFossilId: anc.id };
        }
        let ch: Character;
        try { ch = createCharacter(w, `世代${gen}`, "wanderer", lineage); }
        catch (e: any) { bad(`createCharacter throw ${diff} s${seed} g${gen}: ${e.message}`); continue; }
        ok(finite(ch.level) && ch.level >= 1, `bad level ${diff} s${seed} g${gen} lv=${ch.level}`);
        ok(finite(maxHp(ch)) && maxHp(ch) > 0, `bad maxHp ${diff} s${seed} g${gen}`);
        for (const k of ["body", "power", "reason", "heart"] as const) ok(finite((ch.stats as any)[k]) && (ch.stats as any)[k] >= 1, `bad stat ${k} ${diff} s${seed} g${gen}`);
        // 進行：深蝕・深度・絆を適当に積む
        ch.depth = 5 + (gen % 40);
        ch.exposure = (gen % 7) * 0.5;
        // 因縁・再発見・弧
        if (prevFossil) {
          recordRediscovery(w, prevFossil.id);
          if (gen % 4 === 0) intervene(w, prevFossil.id, "requiem");
          if (gen % 5 === 0) accrueArcWarp(w, prevFossil.id, 0.6);
        }
        if (gen % 6 === 0) awardSeal(w, "abyss_boss", []);
        // 死に方を循環
        const manners = ["combat", "exposure", "fall", "mercy"] as const;
        const acts = ["requiem", "inherit", "leave", "memorial"] as const;
        let fossil: Fossil;
        try { fossil = fossilizeCurrent(w, manners[gen % 4] as any, { choice: acts[gen % 4] } as any); }
        catch (e: any) { bad(`fossilizeCurrent throw ${diff} s${seed} g${gen}: ${e.message}`); continue; }
        ok(!!fossil && finite(fossil.laidDepth), `bad fossil ${diff} s${seed} g${gen}`);
        // 相棒の見捨て/戦死も時々
        if (gen % 7 === 0) {
          const actor = { name: "捨て相棒", archetype: "wanderer", gearTags: [], catchphrase: undefined } as any;
          try { fossilizeAbandoned(w, actor, { depth: ch.depth }); } catch (e: any) { bad(`fossilizeAbandoned throw: ${e.message}`); }
          try { fossilizeCompanion(w, actor, { depth: ch.depth, exposure: 0.9, bond: 2 }); } catch (e: any) { bad(`fossilizeCompanion throw: ${e.message}`); }
        }
        try { advanceArcs(w); } catch (e: any) { bad(`advanceArcs throw ${diff} s${seed} g${gen}: ${e.message}`); }
        // arc warp/drift 有限
        for (const t of (w.tracked ?? [])) ok(finite(t.drift ?? 0) && finite(t.beat ?? 0), `arc nonfinite ${diff} s${seed} g${gen} ${t.id}`);
        prevFossil = fossil;
      }
    }
  }
}

// ---- 0. monsterHardcap 直接ユニット（v0.151.0・easy=60据え置き／normal・hard は深度20超で+1/階・最大80） ----
function checkHardcapValues() {
  for (const depth of [1, 10, 20, 24, 32, 40, 50, 55, 60, 80]) {
    ok(monsterHardcap(depth, diffMods("easy")) === MONSTER_HARDCAP, `easy hardcap should stay ${MONSTER_HARDCAP} at d${depth}`);
  }
  for (const diff of ["normal", "hard"] as const) {
    const mods = diffMods(diff);
    for (const depth of [1, 10, 20, 24, 32, 40, 50, 55, 60, 80]) {
      const expected = MONSTER_HARDCAP + Math.min(20, Math.max(0, depth - 20));
      const got = monsterHardcap(depth, mods);
      ok(got === expected, `${diff} hardcap d${depth} expected ${expected} got ${got}`);
    }
    // レビュー指示の具体値（d24=64・d40以降=80）を直接 assert
    ok(monsterHardcap(24, mods) === 64, `${diff} d24 hardcap should be 64, got ${monsterHardcap(24, mods)}`);
    ok(monsterHardcap(40, mods) === 80, `${diff} d40 hardcap should be 80, got ${monsterHardcap(40, mods)}`);
    ok(monsterHardcap(55, mods) === 80, `${diff} d55 hardcap should be 80, got ${monsterHardcap(55, mods)}`);
    ok(monsterHardcap(60, mods) === 80, `${diff} d60 hardcap should be 80, got ${monsterHardcap(60, mods)}`);
    ok(monsterHardcap(80, mods) === 80, `${diff} d80 hardcap should be 80, got ${monsterHardcap(80, mods)}`);
  }
}

console.log("== stress-engine 開始 ==");
const t0 = Date.now();
checkHardcapValues(); console.log(`  hardcap values done (${CHECKS} checks, ${FAIL} fail)`);
checkFloors(); console.log(`  floors done (${CHECKS} checks, ${FAIL} fail)`);
let c = 0;
for (let seed = 1; seed <= 20; seed++) for (const diff of SELECTABLE_DIFFICULTIES) for (const depth of [3, 9, 18, 28, 40, 50]) { combatLoop(seed * 29 + depth, depth, diff, (c++ % 2) === 0); }
console.log(`  combat done (${CHECKS} checks, ${FAIL} fail)`);
checkPursuerBoss(); console.log(`  pursuer/boss done (${CHECKS} checks, ${FAIL} fail)`);
checkRaid(); console.log(`  raid done (${CHECKS} checks, ${FAIL} fail)`);
checkLifecycle(); console.log(`  lifecycle done (${CHECKS} checks, ${FAIL} fail)`);

console.log(`\n=== stress-engine 完了：${CHECKS} checks / ${FAIL} fail / ${((Date.now() - t0) / 1000).toFixed(1)}s ===`);
for (const p of problems) console.log("  ❌ " + p);
if (FAIL === 0) console.log("  ✅ 不変条件すべて満たす（crash/NaN/逸脱なし）");
process.exit(FAIL > 0 ? 1 : 0);

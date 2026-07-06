// ゴールデンテストベクタ（B柱2・Swift 完全再実装の照合用・4-9/移植）。
//   純粋・決定論エンジン（src/*.ts）を固定 seed で叩き、状態遷移を language-portable な
//   指紋（FNV-1a・english キー＋整数のみ）に畳んで checked-in 期待値と照合する。
//   Swift 版が同じシナリオで同じ指紋を出せば「同 seed 同結果」＝移植の正しさを機械保証できる。
//   実行: node --experimental-strip-types src/golden.ts   （npm run check 同梱）
//   指紋の再生成: node --experimental-strip-types src/golden.ts --print  （EXPECTED を貼り替え）
import { makeRng } from "./rng.ts";
import { newWorld, createCharacter, fossilizeCurrent, advanceArcs } from "./world.ts";
import { genFloor, planMonsters, resolveMonsters } from "./dungeon.ts";
import { xpToNext, xpForKill, maxHp } from "./progression.ts";
import { rollItem, itemValue } from "./items.ts";
import { SPELLS, warpDamage } from "./spells.ts";
import { depthBand, exposureGain } from "./variation.ts";
import type { Character } from "./types.ts";

// --- FNV-1a 32bit（ASCII 文字列専用。指紋入力は english キー＋整数のみ＝言語非依存・Swift で同実装可）---
function fnv1a(s: string): string {
  let h = 0x811c9dc5 >>> 0;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return (h >>> 0).toString(16).padStart(8, "0");
}
// レコーダ：値を「|」区切りで貯め、最後に指紋化。数値は整数前提（float は round して入れる）。
class Rec { parts: string[] = []; add(...xs: (string | number)[]) { for (const x of xs) this.parts.push(String(x)); return this; } hash() { return fnv1a(this.parts.join("|")); } }

// ---------- シナリオ（純粋エンジンの port-critical 面）----------

/** ① RNG（mulberry32）：最も基礎の移植照合。seed→int 列。 */
function gRng(): string {
  const r = new Rec();
  for (const seed of [1, 42, 20260612, 0xdeadbeef]) {
    const rng = makeRng(seed >>> 0);
    for (let i = 0; i < 32; i++) r.add(rng.int(100000));
  }
  return r.hash();
}

/** ② 進行の純粋数式：xpToNext / xpForKill / maxHp（全て整数出力）。 */
function gProgression(): string {
  const r = new Rec();
  for (let lv = 1; lv <= 50; lv++) r.add(xpToNext(lv));
  for (let hp = 1; hp <= 120; hp += 7) r.add(xpForKill(hp));
  for (let body = 2; body <= 24; body++) {
    const ch = { stats: { body, power: 0, reason: 0, heart: 0 }, equipment: {} } as unknown as Character;
    r.add(maxHp(ch));
  }
  return r.hash();
}

/** ③ フロア生成：寸法・床数・階段・敵配置（x,y,種key,hp）を seed×depth で固定。 */
function gGenFloor(): string {
  const r = new Rec();
  for (const seed of [1, 20260612, 777]) {
    for (const depth of [1, 5, 10, 18, 30, 42]) { // ボス階(8の倍数)は別扱い＝避ける
      const w = newWorld(seed >>> 0);
      createCharacter(w, "T", "delver", { relation: "none" });
      const f = genFloor(w, depth);
      const floorTiles = f.tiles.reduce<number>((a, t) => a + (t === 1 ? 1 : 0), 0);
      r.add("F", depth, f.w, f.h, floorTiles, f.stairsUp.x, f.stairsUp.y, f.stairsDown.x, f.stairsDown.y, f.monsters.length);
      for (const m of f.monsters) r.add(m.x, m.y, m.kind.key, m.hp);
    }
  }
  return r.hash();
}

/** ④ 敵AI：plan/resolve を固定プレイヤー経路で N 手回し、intent/位置/hp/被弾を固定（能力含む）。 */
function gMonsterAI(): string {
  const r = new Rec();
  for (const seed of [20260612, 13]) {
    for (const depth of [10, 30, 42]) {
      const w = newWorld(seed >>> 0);
      createCharacter(w, "T", "delver", { relation: "none" });
      // A｜群れ増量（v0.123.0）は genFloor に fodder を足す＝この AI 照合は「AI アルゴリズム」を測る器なので
      // fodderMul:0 に固定＝fodder 追加前の基準フロアで従来どおり検査（monsterAI 指紋は不変を死守）。
      // fodder 自体は tier<=2 の通常雑魚＝新しい AI 経路は無い（配置の網羅は gGenFloor が担う）。
      const f = genFloor(w, depth, { fodderMul: 0 });
      const rng = makeRng((seed ^ (depth * 2654435761)) >>> 0);
      let p = { x: f.stairsUp.x, y: f.stairsUp.y };
      for (let turn = 0; turn < 24; turn++) {
        planMonsters(f, p, rng);
        const res = resolveMonsters(f, p);
        r.add("T", turn, res.hits.length, res.dodges.length);
        for (const h of res.hits) r.add(h.target === "player" ? 0 : 1, h.dmg, h.effect ?? "-");
        // プレイヤーを決定論で動かす（rng は使わず turn 由来＝言語非依存）
        const dx = (turn % 3) - 1, dy = ((turn >> 1) % 3) - 1;
        const nx = p.x + dx, ny = p.y + dy;
        if (nx >= 0 && ny >= 0 && nx < f.w && ny < f.h && f.tiles[ny * f.w + nx] === 1) p = { x: nx, y: ny };
        r.add(p.x, p.y);
      }
      // フロア終局の敵状態（増殖含む総数）
      const alive = f.monsters.filter((m) => m.hp > 0);
      r.add("END", f.monsters.length, alive.length);
      for (const m of f.monsters) r.add(m.x, m.y, m.kind.key, m.hp);
    }
  }
  return r.hash();
}

/** ⑤ アイテム抽選：slot×enchant×価値（整数）を固定 seed で。 */
function gItems(): string {
  const r = new Rec();
  for (const seed of [20260612, 5]) {
    const rng = makeRng(seed >>> 0);
    for (const depth of [1, 12, 28, 44]) {
      for (let i = 0; i < 8; i++) {
        const it = rollItem(depth, rng, i % 5 === 0 ? { boss: true } : {});
        r.add(it.slot, it.enchant ?? 0, Math.round(itemValue(it)));
      }
    }
  }
  return r.hash();
}

/** ⑥ 世界の生死サイクル：世代交代・弧ビート・年代記・化石の堆積を固定。 */
function gWorldLifecycle(): string {
  const r = new Rec();
  const w = newWorld(20260612);
  for (let gen = 0; gen < 8; gen++) {
    const ch = createCharacter(w, "C" + gen, "delver", { relation: "none" });
    ch.depth = 6 + gen * 2;
    fossilizeCurrent(w, "anonymous", { choice: "accept" });
    advanceArcs(w);
    r.add("G", w.generation, w.fossils.length, (w.chronicle ?? []).length, (w.tracked ?? []).length);
    for (const t of w.tracked ?? []) r.add(t.arcType, t.beat, t.terminal ? 1 : 0);
  }
  return r.hash();
}

/** ⑦ 術カタログ＋warpDamage：Swift が同じ術表・同じ威力式を持つことの照合（english キー＋整数）。 */
function gSpells(): string {
  const r = new Rec();
  for (const s of SPELLS) r.add(s.key, Math.round(s.cost * 1000), s.minLevel ?? 0);
  for (let reason = 0; reason <= 20; reason++) r.add(warpDamage(reason));
  return r.hash();
}

/** ⑧ 変質の純粋スカラ：depthBand（english）／exposureGain（×1000 整数化）を深度で固定。 */
function gVariation(): string {
  const r = new Rec();
  for (let d = 1; d <= 52; d++) r.add(depthBand(d), Math.round(exposureGain(d) * 1000));
  return r.hash();
}

const SCENARIOS: Record<string, () => string> = {
  rng: gRng, progression: gProgression, genFloor: gGenFloor,
  monsterAI: gMonsterAI, items: gItems, worldLifecycle: gWorldLifecycle,
  spells: gSpells, variation: gVariation,
};

// checked-in 期待値（--print で再生成して貼り替え）。Swift 移植はこの値を再現すべき正解データ。
const EXPECTED: Record<string, string> = {
  rng: "05bda7cc", progression: "cfe0c82f", genFloor: "f3486769",
  monsterAI: "51d3744d", items: "3758573a", worldLifecycle: "741659d6",
  spells: "0e91b2dc", variation: "54d9a151",
};
// 注：worldLifecycle は 4-14 初期シード化石 2→12 体で更新（純エンジンの決定論変化＝意図的）。
// 注：genFloor は A｜群れ増量（fodder・v0.123.0・FODDER_MUL=0.2）で再生成（1857a403→f3486769）＝設計変更＝Swift 照合の新基準。
// 注：items は武器クラス〈槍〉（v0.124.0・reach:2 の新基5種〔木槍/長槍/十文字槍/大身槍/淵穿ち〕＋刺突槍/萎えの槍へ reach 付与・萎えの槍 dmg 3→2）で再生成（f1e0de5d→d9a8e31b）＝設計変更＝Swift 照合の新基準（他7指紋は byte 一致を裏取り）。
//     monsterAI は fodderMul:0 固定で fodder 追加前の基準フロアを検査＝指紋不変（他6指紋とも byte 一致を裏取り）。
// 注：items は武器クラス〈薙刀〉（v0.127.0・sweep:true の新基4種〔薙鎌/薙刀/大薙刀/夜叉薙〕）で再生成（d9a8e31b→3758573a）＝設計変更＝Swift 照合の新基準（他7指紋は byte 一致を裏取り）。

const printMode = process.argv.includes("--print");
let fail = 0;
const got: Record<string, string> = {};
for (const [name, fn] of Object.entries(SCENARIOS)) {
  const h = fn();
  got[name] = h;
  if (printMode) { console.log(`  ${name}: "${h}",`); continue; }
  const exp = EXPECTED[name];
  if (h === exp) console.log(`  ✅ ${name}: ${h}`);
  else { console.log(`  ✖ ${name}: 期待 ${exp} ≠ 実際 ${h}`); fail++; }
}
if (printMode) { console.log("== golden 指紋（EXPECTED へ貼り替え）=="); console.log(JSON.stringify(got, null, 2)); }
else {
  console.log(`== ゴールデンテスト：${Object.keys(SCENARIOS).length - fail}/${Object.keys(SCENARIOS).length} pass ==`);
  if (fail > 0) { console.log("❌ ゴールデン不一致（純粋エンジンの決定論が変化＝Swift 照合の正解データを要更新）"); process.exit(1); }
}

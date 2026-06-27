// セリフ辻褄・実レンダリング検査（デスクトップ Claude Code 用）。
// event-check は「スロットが充填可能か」を静的に見る。本検査は実際に全本文を描画し、
// 描画後の文面に残る意味レベルの破綻（深度深度・重複助詞・undefined・leftover slot・空アンカー）を炙り出す。
// 実行: node --experimental-strip-types tools/render-check.ts
import { loadContent } from "../src/content-node.ts";
import { fillStoryletText, fillActorText, fillDungeonText, renderRediscovery, renderRumor, renderArcBeat, renderDeathLine, requiemLine, leaveLine, inheritLine } from "../src/render.ts";
import { makeRng } from "../src/rng.ts";
import type { Actor, Fossil, TonePole, TrackedEntity } from "../src/types.ts";

const db = loadContent();
const arr = (db as any).storylets as any[];
let WARN = 0;
const issues: string[] = [];
function flag(id: string, kind: string, detail: string) { WARN++; if (issues.length < 200) issues.push(`[${kind}] ${id}: ${detail}`); }

// 描画後テキストの破綻パターン。「ものの/そのものの」は正しい語なので のの 検出から除外。
function scan(id: string, where: string, t: string) {
  if (/#[a-z_.]+#/.test(t)) flag(id, "leftover-slot", `${where}: ${t.slice(0, 60)}`);
  if (/深度深度/.test(t)) flag(id, "深度深度", `${where}: ${t.slice(0, 60)}`);
  if (/undefined|NaN|\bnull\b/.test(t)) flag(id, "undefined", `${where}: ${t.slice(0, 60)}`);
  const dup = t.replace(/もの/g, "■"); // 「ものの」「そのもの」を潰してから のの を見る
  if (/のの|、、|。。|！。|？。|。、|！、|？、/.test(dup)) flag(id, "重複助詞/句読", `${where}: ${(t.match(/.{0,8}(のの|、、|。。|！。|？。|。、).{0,8}/) || [t.slice(0, 24)])[0]}`);
  if (/[ 　]{2,}/.test(t)) flag(id, "余分な空白", `${where}: ${t.slice(0, 40)}`);
  if (/「」|（）|『』/.test(t)) flag(id, "空括弧", `${where}: ${t.slice(0, 40)}`);
}

// 実在の異名21種（の終わり・形容詞・動詞句が混在）。actor/encounter context をこれらで総当たりして
// #origin_epithet#の… の二重の／非文を炙り出す。
const REAL_EPITHETS = ["辻の", "三度死にかけた", "底知らずの", "口の減らない", "懐かしがりの", "迷い慣れた", "名うての", "影の薄い", "訳ありの", "ひと癖ある", "物静かな", "やけに陽気な", "痩せこけた", "古傷だらけの", "噂好きの", "抜け目ない", "くたびれた", "妙に身綺麗な", "大柄な", "しわがれ声の", "人見知りの"];

// 代表アンカー：全スロットを持つ化石（loss/myth/grudge × 装備1/2 × 口癖/異名有無）
function mkFossil(tone: TonePole, gear: string[], cp?: string, ep?: string, depth = 12): Fossil {
  return {
    id: `test_${tone}`, kind: "character",
    origin: { name: "ロレイン", archetype: "wanderer", gearTags: gear, catchphrase: cp, epithet: ep },
    death: { manner: "combat", finalAct: { choice: "accept" }, depth, generationCreated: 1 },
    exposureAtDeath: 0.5, bondAtDeath: 2, tonePole: tone, interventions: [],
    lastTouchedGeneration: 1, laidDepth: depth,
  } as Fossil;
}
function mkActor(gear: string[], cp?: string, ep?: string): Actor {
  return { name: "カイル", archetype: "wanderer", gearTags: gear, catchphrase: cp, epithet: ep, alive: true };
}

const richFossils: Fossil[] = [];
for (const tone of ["loss", "myth", "grudge"] as TonePole[])
  for (const gear of [["錆びた長剣"], ["古い鎧", "兜"]])
    richFossils.push(mkFossil(tone, gear, "「まだ終わっていない」", "不屈の"));
const richActor = mkActor(["磨かれた短剣"], "「やってみせる」", "韋駄天の");

const ACTORCTX = new Set(["encounter", "street", "tavern", "guild", "shop", "delver", "quest"]);
const DUNGEONCTX = new Set(["dungeon", "chest"]);
const rng = makeRng(99);

// ---- 1. storylet 全文を context 別の fill 関数で描画 ----
for (const s of arr) {
  const ctx = s.context || "encounter";
  const texts: [string, string][] = [];
  if (s.text) texts.push(["text", s.text]);
  for (let i = 0; i < (s.choices || []).length; i++) if (s.choices[i].text) texts.push([`choice[${i}].text`, s.choices[i].text]);
  // effects 内の chronicle/trait もスロットを持つ → 描画
  for (let i = 0; i < (s.choices || []).length; i++)
    for (const e of (s.choices[i].effects || [])) {
      if (typeof e.chronicle === "string") texts.push([`choice[${i}].chronicle`, e.chronicle]);
      if (typeof e.trait === "string") texts.push([`choice[${i}].trait`, e.trait]);
    }
  for (const [where, raw] of texts) {
    try {
      if (DUNGEONCTX.has(ctx)) {
        for (const d of [1, 7, 25, 50]) scan(s.id, where, fillDungeonText(d, raw));
      } else if (ctx === "encounter") {
        for (const f of richFossils) scan(s.id, where, fillStoryletText(f, raw));
        // encounter も異名総当たり（fossil.origin.epithet を差し替え）
        if (/#origin_epithet#/.test(raw)) for (const ep of REAL_EPITHETS) scan(s.id, where, fillStoryletText(mkFossil("loss", ["錆びた剣"], "「…」", ep), raw));
      } else {
        scan(s.id, where, fillActorText(richActor, raw));
        // actor context は実在異名21種で総当たり（#origin_epithet#の… の二重の検出）
        if (/#origin_epithet#/.test(raw)) for (const ep of REAL_EPITHETS) scan(s.id, where, fillActorText(mkActor(["短剣"], "「…」", ep), raw));
      }
    } catch (e: any) {
      // リッチアンカーは全スロットを持つので throw は「未知スロット」を意味する
      flag(s.id, "render-throw", `${where} ctx=${ctx}: ${e.message}`);
    }
  }
}

// ---- 2. 再発見フレーム（renderRediscovery） tone×stage × 口癖有無 ----
import { computeVariation } from "../src/variation.ts";
for (const tone of ["loss", "myth", "grudge"] as TonePole[]) {
  for (const cp of [undefined, "「だが、まだだ」"]) {
    const f = mkFossil(tone, ["錆びた斧"], cp, undefined, 20);
    for (let i = 0; i < 60; i++) {
      try {
        const v = computeVariation(f, makeRng(i * 13 + 1));
        scan(`rediscovery_${tone}`, `cp=${!!cp} i${i}`, renderRediscovery(db, makeRng(i * 7 + 3), f, v));
      } catch (e: any) { flag(`rediscovery_${tone}`, "render-throw", e.message); }
    }
  }
}

// ---- 3. 噂・弧ビート・死の一手・動詞締め ----
for (const f of richFossils) {
  for (let i = 0; i < 40; i++) { try { scan(`rumor_${f.tonePole}`, `i${i}`, renderRumor(db, makeRng(i * 17 + 5), f)); } catch (e: any) { flag(`rumor_${f.tonePole}`, "render-throw", e.message); } }
  for (let i = 0; i < 20; i++) { scan(`requiem_${f.tonePole}`, `i${i}`, requiemLine(f, makeRng(i + 1))); scan(`leave_${f.tonePole}`, `i${i}`, leaveLine(f, makeRng(i + 2))); scan(`inherit_${f.tonePole}`, `i${i}`, inheritLine(f, makeRng(i + 3))); }
}
for (const act of ["accept", "guard_relic", "leave_will", "curse_dungeon"] as const) {
  for (let i = 0; i < 20; i++) { try { scan(`death_${act}`, `i${i}`, renderDeathLine(db, makeRng(i + 1), { choice: act } as any)); } catch (e: any) { flag(`death_${act}`, "render-throw", e.message); } }
}
// 弧ビート（4タイプ × beat 1-3）
for (const arcType of ["doom", "retire", "fall", "lore_drift"] as const) {
  for (let beat = 1; beat <= 3; beat++) {
    const t: TrackedEntity = { id: `t_${arcType}`, name: "ヴェスナ", source: "player_legend", arcType, beat, lastObservedGeneration: 1, originRef: richFossils[0].id } as any;
    for (let i = 0; i < 20; i++) { try { scan(`arc_${arcType}_b${beat}`, `i${i}`, renderArcBeat(db, makeRng(i + 1), t)); } catch (e: any) { flag(`arc_${arcType}_b${beat}`, "render-throw", e.message); } }
  }
}

console.log(`=== render-check 完了：${arr.length} storylets ＋ 派生描画 ===`);
console.log(`検出 ${WARN}件`);
const byKind: Record<string, number> = {};
for (const i of issues) { const k = i.match(/^\[([^\]]+)\]/)?.[1] || "?"; byKind[k] = (byKind[k] || 0) + 1; }
console.log("内訳:", JSON.stringify(byKind));
for (const i of issues.slice(0, 120)) console.log("  ⚠ " + i);

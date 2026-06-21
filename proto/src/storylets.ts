// 遭遇イベント：ストーリーレットの選出と effects 還流（snapshot 4-12・遭-①/②）
// 化石の状況（極/変質段階/死の一手）× プレイヤー状態（絆/未完/深蝕/伏線）で状況を選び、
// 選択の結果を世界状態へ書き戻す。実行時LLMは使わない（条件照合＋テンプレ充填のみ）。

import type { ContentDb } from "./content.ts";
import type { Character, Effect, Fossil, LivingActor, Prereq, Storylet, TownContext, VariationResult, World } from "./types.ts";
import type { Rng } from "./rng.ts";
import { chronicle, getArc, setArc } from "./world.ts";
import { fillStoryletText, fillDungeonText, fillActorText } from "./render.ts";
import { rememberActor } from "./actors.ts";
import { depthBand } from "./variation.ts";
import { grantConsumable, consumableByKey } from "./items.ts";
import { carryCapacity } from "./progression.ts";

/** 報酬（金貨/消耗品）を適用しログ行を返す。全 context 共通（4-12(I)：イベント＝報酬セット）。 */
function applyReward(ch: Character, e: Effect, logs: string[]): void {
  if (e.gold !== undefined && e.gold !== 0) {
    ch.gold = Math.max(0, (ch.gold ?? 0) + e.gold);
    logs.push(e.gold > 0 ? `礼金を受け取った（＋${e.gold}金貨／所持 ${ch.gold}）。` : `金貨を手放した（${e.gold}）。`);
  }
  if (e.item !== undefined) {
    const name = consumableByKey(e.item)?.name ?? e.item;
    logs.push(grantConsumable(ch, e.item, carryCapacity(ch)) ? `${name} を手に入れた。` : `${name} を受け取ったが、持ちきれず手放した。`);
  }
}

/** 長尺アークの前提照合（4-12(I)：世界スコープ）。arc=進行中かつ step/pick が一致／notArc=未開始（done含む）。 */
function arcMatches(p: Prereq, world: World): boolean {
  if (p.notArc !== undefined && (world.arcs ?? []).some((x) => x.key === p.notArc)) return false;
  if (p.arc !== undefined) {
    const a = getArc(world, p.arc);
    if (!a) return false;
    if (p.arcStep !== undefined && a.step !== p.arcStep) return false;
    if (p.arcPick !== undefined && a.pick !== p.arcPick) return false;
  }
  return true;
}

/** 重み付き抽選。ただしアーク段（prereq.arc 指定）があれば最優先＝弧を確実に前進させる。
 *  avoid＝直近に出した id（context別リング）。一般プールからのみ除外し、空になれば諦めて全体から引く
 *  （弧/固有ビートは avoid を無視＝確実に前進させる。P1 ペーシング：同じ話の短期再発を防ぐ）。 */
function pickPreferArc(pool: Storylet[], rng: Rng, avoid?: Set<string>): Storylet | null {
  if (pool.length === 0) return null;
  // 弧（arc）と特定人物（actorId・名簿員の固有ビート）を最優先＝雑踏に埋もれさせず確実に前進させる。
  const priority = pool.filter((s) => s.prerequisites.arc !== undefined || s.prerequisites.actorId !== undefined);
  let p = priority.length ? priority : pool;
  if (!priority.length && avoid && avoid.size) { // 直近に出した話を一般プールから外す（候補が尽きたら全体に戻す）
    const fresh = p.filter((s) => !avoid.has(s.id));
    if (fresh.length) p = fresh;
  }
  if (p.length === 1) return p[0];
  const total = p.reduce((a, s) => a + Math.max(0, s.weight), 0);
  if (total <= 0) return p[0];
  let r = rng.next() * total;
  for (const s of p) { r -= Math.max(0, s.weight); if (r <= 0) return s; }
  return p[p.length - 1];
}

/** 伏線フラグは「この化石/アクター」にスコープする（レンの手記はレンの後続だけを開く）。 */
const scopedFlag = (base: string, id: string) => `${base}@${id}`;
const flagKey = (base: string, fossil: Fossil) => scopedFlag(base, fossil.id);

/** prereq の指定項目すべてに一致するか（未指定はワイルドカード）。 */
function matches(p: Prereq, world: World, ch: Character, fossil: Fossil, v: VariationResult): boolean {
  if (p.tone !== undefined && p.tone !== fossil.tonePole) return false;
  if (p.stage !== undefined && p.stage !== v.stage) return false;
  if (p.finalAct !== undefined && p.finalAct !== fossil.death.finalAct.choice) return false;
  if (p.kind !== undefined && p.kind !== fossil.kind) return false;
  const bond = ch.bonds.find((b) => b.entityRef === fossil.id);
  if (p.minBond !== undefined && (bond?.value ?? 0) < p.minBond) return false;
  if (p.unfinished !== undefined && (bond?.unfinished ?? false) !== p.unfinished) return false;
  if (p.minExposure !== undefined && ch.exposure < p.minExposure) return false;
  if (p.minLevel !== undefined && ch.level < p.minLevel) return false;
  if (p.minDepth !== undefined && ch.depth < p.minDepth) return false;
  if (p.maxDepth !== undefined && ch.depth > p.maxDepth) return false;
  if (p.hasCatchphrase !== undefined && !!fossil.origin.catchphrase !== p.hasCatchphrase) return false;
  const flags = world.flags ?? [];
  if (p.flag !== undefined && !flags.includes(flagKey(p.flag, fossil))) return false;
  if (p.notFlag !== undefined && flags.includes(flagKey(p.notFlag, fossil))) return false;
  return arcMatches(p, world);
}

/** いま発火しうる遭遇（encounter）ストーリーレットの候補（前提を満たすもの）。 */
export function candidateStorylets(
  db: ContentDb, world: World, ch: Character, fossil: Fossil, v: VariationResult,
): Storylet[] {
  return db.storylets.filter(
    (s) => (s.context ?? "encounter") === "encounter" && matches(s.prerequisites, world, ch, fossil, v),
  );
}

/** 化石の状況に合うストーリーレットを重み付きで1つ選ぶ（無ければ null）。 */
export function selectStorylet(
  db: ContentDb, world: World, ch: Character, fossil: Fossil, v: VariationResult, rng: Rng,
  avoid?: Set<string>,
): Storylet | null {
  return pickPreferArc(candidateStorylets(db, world, ch, fossil, v), rng, avoid);
}

/** effects を世界状態へ還流させ、プレイヤーへ見せるログ行を返す（4-12 (A)-3）。 */
export function applyEffects(
  world: World, ch: Character, fossil: Fossil, effects: Effect[],
): string[] {
  const logs: string[] = [];
  for (const e of effects) {
    if (e.bond !== undefined) {
      const bond = ch.bonds.find((b) => b.entityRef === fossil.id);
      if (bond) bond.value += e.bond;
      else ch.bonds.push({ entityRef: fossil.id, value: e.bond, unfinished: false });
    }
    if (e.closeUnfinished) {
      const bond = ch.bonds.find((b) => b.entityRef === fossil.id);
      if (bond) bond.unfinished = false;
    }
    if (e.exposure !== undefined) {
      ch.exposure = Math.max(0, ch.exposure + e.exposure);
      if (e.exposure > 0) logs.push(`深みが、少しだけ滲みた（深蝕 +${e.exposure.toFixed(2)}）。`);
      else if (e.exposure < 0) logs.push(`張りつめていた何かが、わずかに和らいだ（深蝕 ${e.exposure.toFixed(2)}）。`);
    }
    if (e.trait !== undefined) {
      const t = fillStoryletText(fossil, e.trait);
      if (!ch.traits.includes(t)) { ch.traits.push(t); logs.push(`心に刻まれた──「${t}」`); }
    }
    if (e.chronicle !== undefined) {
      chronicle(world, "rediscovery", fillStoryletText(fossil, e.chronicle), [fossil.id]);
    }
    if (e.plant !== undefined) {
      const key = flagKey(e.plant, fossil);
      (world.flags ??= []);
      if (!world.flags.includes(key)) { world.flags.push(key); logs.push("……これは、伏線になる。"); }
    }
    if (e.arc !== undefined) setArc(world, e.arc); // 長尺アーク（4-12(I)）
    applyReward(ch, e, logs); // 報酬（金貨/消耗品）
  }
  return logs;
}

// ---------- ダンジョン環境イベント（context=dungeon。アクター無し：4-12 F） ----------

/** 指定 context のうち、深度帯/深度/レベル（と任意で深蝕の下限）に合うものを重み付きで1つ選ぶ（無ければ null）。
 *  level＝出し分け（語りと深度/レベルの整合：P2）。avoid＝直近の重複回避（P1）。 */
function pickByContext(
  db: ContentDb, context: string, depth: number, rng: Rng,
  exposure = 0, world?: World, level = 1, avoid?: Set<string>,
): Storylet | null {
  const band = depthBand(depth);
  const pool = db.storylets.filter((s) => {
    const p = s.prerequisites;
    if (s.context !== context) return false;
    if (p.depthBand !== undefined && p.depthBand !== band) return false;
    if (p.minDepth !== undefined && depth < p.minDepth) return false;
    if (p.maxDepth !== undefined && depth > p.maxDepth) return false;
    if (p.minLevel !== undefined && level < p.minLevel) return false;
    if (p.minExposure !== undefined && exposure < p.minExposure) return false;
    // 長尺アーク（4-12(I)）の段ゲート。world 未指定（CLI/demo）では arc を確認できないので
    // arc/notArc 付きは除外＝弧イベントが弧未開始のまま漏れ出るのを防ぐ（web は常に world を渡す）。
    return world === undefined ? (p.arc === undefined && p.notArc === undefined) : arcMatches(p, world);
  });
  return pickPreferArc(pool, rng, avoid);
}

/** 現在深度で発火しうるダンジョン環境イベントを重み付きで1つ選ぶ（無ければ null）。world を渡すと長尺アーク段を優先。 */
export function selectDungeonStorylet(
  db: ContentDb, depth: number, rng: Rng, exposure = 0, world?: World, level = 1, avoid?: Set<string>,
): Storylet | null {
  return pickByContext(db, "dungeon", depth, rng, exposure, world, level, avoid);
}

/** 宝箱の中身を抽選（NetHack風：空/拾得/異物/罠）。result を持つ chest 状況を返す。 */
export function rollChestOutcome(
  db: ContentDb, depth: number, rng: Rng, world?: World, level = 1, avoid?: Set<string>,
): Storylet | null {
  return pickByContext(db, "chest", depth, rng, 0, world, level, avoid);
}

/** ダンジョン環境イベントの選択結果を還流させる（アクター無しなので exposure/trait/chronicle のみ）。 */
export function applyDungeonEffects(world: World, ch: Character, depth: number, effects: Effect[]): string[] {
  const logs: string[] = [];
  for (const e of effects) {
    if (e.exposure !== undefined) {
      ch.exposure = Math.max(0, ch.exposure + e.exposure);
      if (e.exposure > 0) logs.push(`深みが、少しだけ滲みた（深蝕 +${e.exposure.toFixed(2)}）。`);
      else if (e.exposure < 0) logs.push(`張りつめていた何かが、わずかに和らいだ（深蝕 ${e.exposure.toFixed(2)}）。`);
    }
    if (e.trait !== undefined) {
      const t = fillDungeonText(depth, e.trait);
      if (!ch.traits.includes(t)) { ch.traits.push(t); logs.push(`手に入れた──「${t}」`); }
    }
    if (e.chronicle !== undefined) {
      chronicle(world, "rediscovery", fillDungeonText(depth, e.chronicle), []);
    }
    if (e.arc !== undefined) setArc(world, e.arc); // 長尺アークの開始/前進/分岐/完了（4-12(I)）
    applyReward(ch, e, logs); // 報酬（金貨/消耗品）
  }
  return logs;
}

// ---------- 街イベント（context=street/tavern/guild/shop。アクター記述子にアンカー：4-12(F)(G)・4-14） ----------

/** 街で生者と会いうる全コンテキスト（現在地未指定時の既定＝場所を問わず街の生者プール全体）。 */
const TOWN_CONTEXTS: readonly TownContext[] = ["street", "tavern", "guild", "shop"];

/** 街ストーリーレットの前提照合（生者アクターにアンカー。flag/notFlag/bond/exposure を actor.id でスコープ）。 */
function townMatches(p: Prereq, world: World, ch: Character, la: LivingActor): boolean {
  if (p.actorId !== undefined && p.actorId !== la.id) return false; // 特定の名簿員にのみ（4-14 イントロ）
  const bond = ch.bonds.find((b) => b.entityRef === la.id);
  if (p.minBond !== undefined && (bond?.value ?? 0) < p.minBond) return false;
  if (p.unfinished !== undefined && (bond?.unfinished ?? false) !== p.unfinished) return false;
  if (p.minExposure !== undefined && ch.exposure < p.minExposure) return false;
  if (p.minLevel !== undefined && ch.level < p.minLevel) return false;
  const flags = world.flags ?? [];
  if (p.flag !== undefined && !flags.includes(scopedFlag(p.flag, la.id))) return false;
  if (p.notFlag !== undefined && flags.includes(scopedFlag(p.notFlag, la.id))) return false;
  // 特定NPCに戻る弧：今会っている生者が、この弧のアンカーNPC本人であること
  if (p.arcActor && p.arc !== undefined) {
    const a = getArc(world, p.arc);
    if (!a || a.actorRef !== la.id) return false;
  }
  return arcMatches(p, world);
}

/**
 * 生者アクターに合う街ストーリーレットを重み付きで1つ選ぶ（無ければ null）。
 * `contexts` ＝現在地が許す場所（4-14：例 酒場なら ["tavern","street"]）。省略時は街の全場所。
 */
export function selectTownStorylet(
  db: ContentDb, world: World, ch: Character, la: LivingActor, rng: Rng,
  contexts: readonly TownContext[] = TOWN_CONTEXTS, avoid?: Set<string>,
): Storylet | null {
  const allow = new Set<string>(contexts);
  const pool = db.storylets.filter((s) => allow.has(s.context ?? "") && townMatches(s.prerequisites, world, ch, la));
  return pickPreferArc(pool, rng, avoid);
}

/** 街イベントの選択結果を還流（生者アクターにアンカー）。bond/plant が立つと lazy に永続化する。 */
export function applyActorEffects(world: World, ch: Character, la: LivingActor, effects: Effect[]): string[] {
  const logs: string[] = [];
  let referenced = false; // この生者が世界に痕跡を残したか＝永続化する根拠（4-12C）
  for (const e of effects) {
    if (e.bond !== undefined) {
      const bond = ch.bonds.find((b) => b.entityRef === la.id);
      if (bond) bond.value += e.bond;
      else ch.bonds.push({ entityRef: la.id, value: e.bond, unfinished: false });
      referenced = true;
    }
    if (e.closeUnfinished) {
      const bond = ch.bonds.find((b) => b.entityRef === la.id);
      if (bond) bond.unfinished = false;
    }
    if (e.exposure !== undefined) {
      ch.exposure = Math.max(0, ch.exposure + e.exposure);
      if (e.exposure > 0) logs.push(`深みが、少しだけ滲みた（深蝕 +${e.exposure.toFixed(2)}）。`);
      else if (e.exposure < 0) logs.push(`張りつめていた何かが、わずかに和らいだ（深蝕 ${e.exposure.toFixed(2)}）。`);
    }
    if (e.trait !== undefined) {
      const t = fillActorText(la.actor, e.trait);
      if (!ch.traits.includes(t)) { ch.traits.push(t); logs.push(`心に刻まれた──「${t}」`); }
    }
    if (e.chronicle !== undefined) {
      chronicle(world, "rediscovery", fillActorText(la.actor, e.chronicle), []);
    }
    if (e.plant !== undefined) {
      const key = scopedFlag(e.plant, la.id);
      (world.flags ??= []);
      if (!world.flags.includes(key)) { world.flags.push(key); logs.push("……また会えそうな気がする。"); }
      referenced = true;
    }
    if (e.arc !== undefined) {
      // anchor 指定なら「今会っている生者」を弧のアンカーに（特定NPCに戻る弧）。生者は永続化。
      setArc(world, e.arc.anchor ? { ...e.arc, actorRef: la.id } : e.arc);
      if (e.arc.anchor) referenced = true;
    }
    applyReward(ch, e, logs); // 報酬（金貨/消耗品）
  }
  if (referenced) rememberActor(world, la); // 参照された生者だけ永続（lazy：4-12C/4-6）
  return logs;
}

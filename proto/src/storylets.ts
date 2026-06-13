// 遭遇イベント：ストーリーレットの選出と effects 還流（snapshot 4-12・遭-①）
// 化石の状況（極/変質段階/死の一手）× プレイヤー状態（絆/未完/深蝕）で状況を選び、
// 選択の結果を世界状態へ書き戻す。実行時LLMは使わない（条件照合＋テンプレ充填のみ）。

import type { ContentDb } from "./content.ts";
import type { Character, Effect, Fossil, Prereq, Storylet, VariationResult, World } from "./types.ts";
import type { Rng } from "./rng.ts";
import { chronicle } from "./world.ts";
import { fillStoryletText } from "./render.ts";

/** prereq の指定項目すべてに一致するか（未指定はワイルドカード）。 */
function matches(p: Prereq, ch: Character, fossil: Fossil, v: VariationResult): boolean {
  if (p.tone !== undefined && p.tone !== fossil.tonePole) return false;
  if (p.stage !== undefined && p.stage !== v.stage) return false;
  if (p.finalAct !== undefined && p.finalAct !== fossil.death.finalAct.choice) return false;
  if (p.kind !== undefined && p.kind !== fossil.kind) return false;
  const bond = ch.bonds.find((b) => b.entityRef === fossil.id);
  if (p.minBond !== undefined && (bond?.value ?? 0) < p.minBond) return false;
  if (p.unfinished !== undefined && (bond?.unfinished ?? false) !== p.unfinished) return false;
  if (p.minExposure !== undefined && ch.exposure < p.minExposure) return false;
  return true;
}

/** 化石の状況に合うストーリーレットを重み付きで1つ選ぶ（無ければ null）。 */
export function selectStorylet(
  db: ContentDb, ch: Character, fossil: Fossil, v: VariationResult, rng: Rng,
): Storylet | null {
  const pool = db.storylets.filter((s) => matches(s.prerequisites, ch, fossil, v));
  if (pool.length === 0) return null;
  if (pool.length === 1) return pool[0];
  const total = pool.reduce((a, s) => a + Math.max(0, s.weight), 0);
  if (total <= 0) return pool[0];
  let r = rng.next() * total;
  for (const s of pool) { r -= Math.max(0, s.weight); if (r <= 0) return s; }
  return pool[pool.length - 1];
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
    }
    if (e.trait !== undefined) {
      const t = fillStoryletText(fossil, e.trait);
      if (!ch.traits.includes(t)) { ch.traits.push(t); logs.push(`心に刻まれた──「${t}」`); }
    }
    if (e.chronicle !== undefined) {
      chronicle(world, "rediscovery", fillStoryletText(fossil, e.chronicle), [fossil.id]);
    }
  }
  return logs;
}

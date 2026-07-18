// 再会・遭遇の重み付け（prototype-spec.md §4.5 / snapshot 4-7）

import type { Character, Fossil, World } from "./types.ts";
import type { Rng } from "./rng.ts";
import { worldTime } from "./world.ts";

const COOLDOWN_FACTOR = 0.2; // 直近観測した相手の重み減衰

function depthProximity(currentDepth: number, laidDepth: number): number {
  const d = Math.abs(currentDepth - laidDepth);
  return Math.max(0, 1 - d / 15); // 15階層離れるとゼロ
}

export function encounterWeight(world: World, ch: Character, fossil: Fossil): number {
  const bond = ch.bonds.find((b) => b.entityRef === fossil.id);
  let w = 1.0; // base
  if (bond?.unfinished) w += 3.0;                       // 未完の因縁（最重視）
  w += 1.0 * (bond?.value ?? fossil.bondAtDeath * 0.5); // 絆・関与度（系譜で薄く引き継ぐ）
  w += 1.5 * depthProximity(ch.depth, fossil.laidDepth);
  const absence = worldTime(world) - fossil.lastTouchedGeneration; // 不在の長さ（worldTime 基準・4-14G）
  w += 0.5 * Math.min(4, absence);
  // クールダウン：直近に触れた相手は出にくい
  if (absence === 0) w *= COOLDOWN_FACTOR;
  return w;
}

/** 現在深度の周辺で、重みに比例して化石を1体抽選（いなければ null）。excludeIds は同一潜行内の再出現防止。
 *  maxDist＝配置側の距離ゲートを抽選候補に前もって課す（web 配置ループ用・PR-1）。
 *  既定 Infinity＝重み（depthProximity・±14 まで）だけで絞る従来挙動＝CLI/demo は不変。 */
export function rollEncounter(world: World, ch: Character, rng: Rng, excludeIds: Set<string> = new Set(), maxDist = Infinity): Fossil | null {
  const candidates = world.fossils.filter(
    (f) => !excludeIds.has(f.id) && !f.retired && depthProximity(ch.depth, f.laidDepth) > 0 // retired＝退隠した先代（生者・守護者）＝亡骸ではない＝遭遇から除外（4-14G）
      && Math.abs(ch.depth - f.laidDepth) <= maxDist,                                        // 配置可能距離の候補だけを引く（無駄撃ち防止・PR-1）
  );
  if (candidates.length === 0) return null;
  const weights = candidates.map((f) => encounterWeight(world, ch, f));
  const total = weights.reduce((a, b) => a + b, 0);
  let r = rng.next() * total;
  for (let i = 0; i < candidates.length; i++) {
    r -= weights[i];
    if (r <= 0) return candidates[i];
  }
  return candidates[candidates.length - 1];
}

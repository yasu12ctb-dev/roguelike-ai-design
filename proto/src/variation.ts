// 変質計算（prototype-spec.md §4.1）と深蝕（§4.3）、トーン極の確定（§4.2）
// 係数はすべて調整前提の初期値。

import type {
  DeathManner, FinalActChoice, Fossil, TonePole, VariationResult, VariationStage,
} from "./types.ts";

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/** 化石の現在の変質状態を lazy に計算する（4-1×4-2×4-10C） */
export function computeVariation(fossil: Fossil, currentGeneration: number): VariationResult {
  const gens = Math.max(0, currentGeneration - fossil.lastTouchedGeneration);
  const depthC = clamp(fossil.death.depth / 50, 0, 1);
  const decay = clamp(gens * 0.15, 0, 1);
  const distort = clamp(depthC * gens * 0.2 + fossil.exposureAtDeath * 0.05, 0, 1);
  const stage: VariationStage = distort < 0.34 ? "weathered" : distort < 0.67 ? "twisting" : "alien";
  const intensity = clamp(distort + fossil.bondAtDeath * 0.05, 0, 1.2);
  return { decay, distort, stage, intensity };
}

/** 死の一手＋死に様 → トーン極（4-10B / §4.2） */
export function resolveTonePole(finalAct: FinalActChoice, manner: DeathManner, bond: number): TonePole {
  let score = 0; // 負=grudge側 / 正=myth側 / 0近傍=loss
  switch (finalAct) {
    case "guard_relic": score += 2; break;
    case "curse_dungeon": score -= 3; break;
    case "leave_will": score += bond >= 2 ? 2 : 0; break;
    case "accept": break;
  }
  if (manner === "betrayed" || manner === "grievous") score -= 1;
  if (manner === "noble") score += 1;
  if (score >= 2) return "myth";
  if (score <= -2) return "grudge";
  return "loss";
}

/** 深度帯（深蝕レート用） */
export function depthBand(depth: number): "shallow" | "mid" | "deep" {
  if (depth <= 8) return "shallow";
  if (depth <= 24) return "mid";
  return "deep";
}

/** 1ターンぶんの深蝕増分（4-10C） */
export function exposureGain(depth: number): number {
  const band = depthBand(depth);
  return band === "shallow" ? 0 : band === "mid" ? 0.02 : 0.06;
}

/** 奇癖が付く深蝕閾値（超えるたびに1つ） */
export const QUIRK_THRESHOLDS = [0.5, 1.2, 2.5];

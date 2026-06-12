// 永続層スキーマ（prototype-spec.md §2 に準拠）

export type TonePole = "loss" | "myth" | "grudge";
export type DeathManner = "noble" | "grievous" | "betrayed" | "peaceful" | "anonymous";
export type FinalActChoice = "guard_relic" | "curse_dungeon" | "leave_will" | "accept";
export type VariationStage = "weathered" | "twisting" | "alien";

export interface World {
  seed: number;
  generation: number;
  current: Character | null;
  fossils: Fossil[];
  tracked: TrackedEntity[];
  chronicle: ChronicleEntry[];
  town: TownState;
}

export interface Character {
  id: string;
  name: string;
  archetype: string;
  lineage: Lineage;
  traits: string[];
  exposure: number;
  depth: number;
  bonds: Bond[];
  alive: boolean;
}

export interface Lineage {
  relation: "blood" | "pupil" | "none";
  ancestorFossilId?: string;
}

export interface Bond {
  entityRef: string;
  value: number;
  unfinished: boolean;
}

export interface FossilOrigin {
  name: string;
  archetype: string;
  gearTags: string[];
  catchphrase?: string;
  epithet?: string;
}

export interface FinalAct {
  choice: FinalActChoice;
  note?: string;
}

export interface Intervention {
  type: "requiem" | "inherit" | "memorial";
  generation: number;
}

export interface Fossil {
  id: string;
  kind: "character" | "explorer" | "relic";
  origin: FossilOrigin;
  death: {
    manner: DeathManner;
    finalAct: FinalAct;
    depth: number;
    generationCreated: number;
  };
  exposureAtDeath: number;
  bondAtDeath: number;
  tonePole: TonePole;
  interventions: Intervention[];
  lastTouchedGeneration: number;
  laidDepth: number;
}

export interface TrackedEntity {
  id: string;
  name: string;
  source: "seeded" | "player_legend" | "nemesis";
  arcType: "retire" | "doom" | "fall" | "lore_drift";
  beat: number;
  lastObservedGeneration: number;
  originRef?: string;
}

export interface ChronicleEntry {
  generation: number;
  kind: "birth" | "death" | "rediscovery" | "intervention" | "legend" | "rumor";
  text: string;
  refs: string[];
}

export interface TownState {
  witnessNpcId: string;
  safety: number;
  memorials: string[];
}

// ---- 鋳造所コンテンツ ----

export interface FragmentTags {
  tone?: TonePole;
  stage?: VariationStage;
  depthBand?: "shallow" | "mid" | "deep";
  archetype?: string;
  finalAct?: FinalActChoice;
}

export interface Fragment {
  id: string;
  slotType: string;
  tags: FragmentTags;
  text: string;
}

export interface SetPiece {
  id: string;
  type: "legend_return" | "grudge_hunt" | "inheritance" | "echo_summon";
  prerequisites: { tone?: TonePole; minBond?: number };
  frame: string;
}

// ---- 変質計算の結果 ----

export interface VariationResult {
  decay: number;
  distort: number;
  stage: VariationStage;
  intensity: number;
}

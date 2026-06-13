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

// ---- 遭遇イベント（ストーリーレット駆動：snapshot 4-12） ----

/** 発火条件。指定された項目すべてに一致する化石/状況でのみ立ち上がる（AND）。 */
export interface Prereq {
  tone?: TonePole;
  stage?: VariationStage;
  finalAct?: FinalActChoice;
  kind?: Fossil["kind"];
  minBond?: number;        // この化石との絆 value がこれ以上
  unfinished?: boolean;    // この化石との未完の因縁の有無
  minExposure?: number;    // プレイヤーの深蝕がこれ以上
}

/** 選択の結果として世界状態へ還流する変化。文字列は origin スロットを充填できる。 */
export interface Effect {
  bond?: number;           // この化石との絆 value への増減
  closeUnfinished?: boolean;
  exposure?: number;       // プレイヤー深蝕への増減
  trait?: string;          // 形質を付与（#origin_name# 等のスロット可）
  chronicle?: string;      // 年代記に一行残す（スロット可）
}

/** 遭遇ノードで立ち上がる状況。遭-① では〈調べる〉分岐を提供する。 */
export interface Storylet {
  id: string;
  prerequisites: Prereq;
  weight: number;
  investigate: {           // 〈調べる〉で明かされる詳細とその還流
    text: string;          // origin スロット可
    effects: Effect[];
  };
}

// ---- 変質計算の結果 ----

export interface VariationResult {
  decay: number;
  distort: number;
  stage: VariationStage;
  intensity: number;
}

// 永続層スキーマ（prototype-spec.md §2 に準拠）

export type TonePole = "loss" | "myth" | "grudge";
export type DeathManner = "noble" | "grievous" | "betrayed" | "peaceful" | "anonymous";
export type FinalActChoice = "guard_relic" | "curse_dungeon" | "leave_will" | "accept";
export type VariationStage = "weathered" | "twisting" | "alien";

export interface World {
  seed: number;
  version?: number;             // セーブ版数（マイグレーション用。未設定=v1）
  generation: number;
  current: Character | null;
  fossils: Fossil[];
  tracked: TrackedEntity[];
  chronicle: ChronicleEntry[];
  town: TownState;
  flags?: string[];             // 伏線フラグ（遭遇の選択が立てる。化石ごとにスコープ：4-12 遭-②）
}

/** ステ4種（4-11F②）。体=最大HP / 力=近接ダメージ / 理=深蝕魔法の素養(③) / 心=深蝕耐性 */
export interface Stats { body: number; power: number; reason: number; heart: number; }

/** 装備（4-11F④・4-11E）。武器=攻撃+ / 防具=被ダメ- / 遺物=パッシブ。異物=未鑑定。 */
export type ItemSlot = "weapon" | "armor" | "relic";
export type RelicKind = "calm" | "reason" | "greed"; // 深蝕レート減 / 理+1 / 撃破XP増
export interface Item {
  id: string; slot: ItemSlot; name: string;
  dmg?: number;             // 武器：近接ダメージ+
  reduce?: number;          // 防具：被ダメージ-
  relic?: RelicKind;        // 遺物：パッシブ種
  exposurePerTurn?: number; // 異物の副作用：装備中の毎ターン深蝕+
  unidentified?: boolean;   // 未鑑定（装備すると判明）
}
export interface Equipment { weapon: Item | null; armor: Item | null; relic: Item | null; }

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
  stats: Stats;
  level: number;
  xp: number;                   // 次のレベルまでの蓄積（敵撃破で増える）
  spells: string[];             // 習得した深蝕魔法のキー（4-11F③・SpellKey）
  equipment: Equipment;         // 装備スロット（4-11F④）
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
  hasCatchphrase?: boolean;// 化石が口癖を持つ/持たない（#origin_catchphrase# を使う本文の安全ガード）
  depthBand?: "shallow" | "mid" | "deep"; // 深度帯（ダンジョン文脈の発火条件）
  flag?: string;           // この化石に立った伏線フラグが有る（遭-②：伏線→後続）
  notFlag?: string;        // この化石に立った伏線フラグが無い（重複発火を防ぐ）
}

/** 選択の結果として世界状態へ還流する変化。文字列は origin スロットを充填できる。 */
export interface Effect {
  bond?: number;           // この化石との絆 value への増減
  closeUnfinished?: boolean;
  exposure?: number;       // プレイヤー深蝕への増減
  trait?: string;          // 形質を付与（#origin_name# 等のスロット可）
  chronicle?: string;      // 年代記に一行残す（スロット可）
  plant?: string;          // 伏線フラグを立てる（この化石にスコープ。後続の prereq.flag が拾う）
}

/** 遭遇ノードの動詞ぶんの本文と還流（〈調べる〉〈捜索〉が各々持つ）。 */
export interface StoryletBranch {
  text: string;            // origin スロット可
  effects: Effect[];
}

/** ダンジョン環境イベントの選択肢（context=dungeon。アクター無し・#depth# スロット可）。 */
export interface StoryletChoice {
  label: string;
  text?: string;           // 選んだ結果の地の文
  effects: Effect[];
}

/** イベントの発生場所＝コンテキスト（4-12(F)。混合せず、コンテキスト内で大量×重み）。 */
export type StoryletContext = "encounter" | "dungeon" | "town" | "quest" | "chest";

/** 状況。encounter は investigate/search、dungeon は text+choices、chest は result を使う（4-12 F）。 */
export interface Storylet {
  id: string;
  context?: StoryletContext;     // 省略時 = "encounter"（化石/アクターとの出会い）
  prerequisites: Prereq;
  weight: number;
  investigate?: StoryletBranch;  // 〈調べる〉：状況・lore の掘り下げ（encounter）
  search?: StoryletBranch;       // 〈捜索〉：周辺の遺品・手がかり（伏線を立てうる・encounter）
  text?: string;                 // 状況の地の文（dungeon。#depth# スロット可）
  choices?: StoryletChoice[];    // 環境イベントの選択肢（dungeon）
  result?: StoryletBranch;       // 開封結果（chest。開けると自動適用。空/拾得/異物/罠）
}

// ---- 変質計算の結果 ----

export interface VariationResult {
  decay: number;
  distort: number;
  stage: VariationStage;
  intensity: number;
}

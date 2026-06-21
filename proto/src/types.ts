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
  flags?: string[];             // 伏線フラグ（遭遇の選択が立てる。化石/アクターごとにスコープ：4-12 遭-②）
  actors?: LivingActor[];       // 永続化された生者NPC（lazy：参照された者だけ：4-12(G)/(C)）
  quests?: Quest[];             // 受注中/達成済の依頼（回収業 4-10G）
  stash?: InventorySlot[];      // 自宅の保管庫：消耗品（世代を越えて残る＝持ち物システム Phase3）。任意＝旧セーブ非破壊。
  stashGear?: Item[];           // 自宅の保管庫：装備（武器/防具/遺物/鞄の収集。世代越え）。任意＝旧セーブ非破壊。
  seals?: string[];             // 奉献の試練：集めた印（SealKey。World に蓄積＝世代越え。5種で深淵帯解錠：4-13A）。任意＝旧セーブ非破壊。
  ascended?: number;            // 奉献の試練：聖遺物を地上へ生還させてクリアした回数（4-13D）。任意＝旧セーブ非破壊。
  companion?: Companion;        // 同行（相棒）の永続状態（4-14C）。生かし続ければセーブ全体を貫く反復キャラ。任意＝旧セーブ非破壊。
  arcs?: ArcState[];            // 長尺アークの進行状態（4-12(I)：多段の弧。世代越え）。任意＝旧セーブ非破壊。
  bestiary?: string[];          // 敵図鑑：遭遇した敵種の名（kind.name。世代越え。web限定）。任意＝旧セーブ非破壊。
  raidCooldown?: number;        // 街の防衛（襲撃）の冷却＝帰還ごとに減り、0で再抽選（定期的だが間隔は長い）。任意＝旧セーブ非破壊。
  memorialCooldown?: number;    // 追悼の日（祭礼）の冷却＝アンビエント街イベント（4-12 J）。任意＝旧セーブ非破壊。
  plagueCooldown?: number;      // 深蝕の瘴気（疫病）の冷却＝街の災厄（4-12 J）。任意＝旧セーブ非破壊。
  diveCount?: number;           // 潜行回数（startDive ごと+1）。genFloor のseedに混ぜて潜行ごとに別ダンジョン＝再潜行farm防止。任意＝旧セーブ非破壊。
}

/** 同行（相棒）の永続状態（4-14C）。潜行開始時にグリッドの相棒エンティティへ展開される。 */
export interface Companion {
  actorRef: string;             // World.actors の id にアンカー（系譜記憶・永続）
  actor: Actor;                 // 表示・テキスト用のスナップショット（アクター記述子 4-12G）
  bond: number;                 // 絆（生還で深まる）
  exposure: number;             // 連帯深蝕（潜行で上がる。閾値で奇癖→C：Phase B）
  alive: boolean;               // false＝化石化済み（後世で再会）
  maxHp: number;
  recruitedGeneration: number;  // 勧誘した世代（系譜記憶の起点）
  grade: number;                // 金属等級（4-4E）0=アイアン..4=プラチナ。初期は設定ファイル由来・生還で⤴昇格（プラチナ頭打ち／ミスリルは死後）。
  feats: number;                // 共に遂げた偉業の数（ボス撃破/山場決着）。昇格は生還(bond)＋偉業(feats)の両ゲート＝滅多に上がらない。
  traits?: string[];            // 連帯深蝕で刻まれる「奇癖:…」（Phase B）。任意＝旧セーブ非破壊。
}

/** 奉献の試練の印（4-13A）。多様な源から1種ずつ。5種揃うと深淵帯が解錠。 */
export type SealKey =
  | "abyss_boss"    // エリアボス（成れの果て）を撃破
  | "requiem"       // 因縁（grudge 化石）を鎮魂
  | "setpiece"      // 山場（grudge_hunt/legend_return）を決着
  | "legend"        // 旧キャラを伝説化（player_legend）
  | "depth";        // 深淵帯手前の高深度に到達
export const SEAL_KEYS: SealKey[] = ["abyss_boss", "requiem", "setpiece", "legend", "depth"];
export const SEAL_LABEL: Record<SealKey, string> = {
  abyss_boss: "成れの果ての討伐",
  requiem: "因縁の鎮魂",
  setpiece: "山場の決着",
  legend: "伝説の承認",
  depth: "深淵への到達",
};

/** ステ4種（4-11F②）。体=最大HP / 力=近接ダメージ / 理=深蝕魔法の素養(③) / 心=深蝕耐性 */
export interface Stats { body: number; power: number; reason: number; heart: number; }

/** 装備（4-11F④・4-11E）。武器=攻撃+ / 防具=被ダメ- / 遺物=パッシブ。異物=未鑑定。 */
export type ItemSlot = "weapon" | "armor" | "relic" | "bag";
export type RelicKind = "calm" | "reason" | "greed" | "might" | "vigor" | "ward" | "fortune" | "mending";
// calm=深蝕レート減 / reason=理+1 / greed=撃破XP×1.5 / might=近接+1 / vigor=最大HP+6 / ward=被ダメ-1 / fortune=拾う金貨×1.5 / mending=潜行中ゆっくり回復
export interface Item {
  id: string; slot: ItemSlot; name: string;
  dmg?: number;             // 武器：近接ダメージ+（銘・+N 込みの最終値）
  reduce?: number;          // 防具：被ダメージ-（銘・+N 込みの最終値）
  relic?: RelicKind;        // 遺物：パッシブ種
  capacity?: number;        // 鞄：持ち物の枠+（持ち物システム Phase2）
  exposurePerTurn?: number; // 装備中の毎ターン深蝕（蝕=正／浄=負／異物の副作用）
  unidentified?: boolean;   // 未鑑定（装備すると判明）
  // ルートシステム（銘×基×+N）。旧セーブは未設定＝name と焼かれた値で従来どおり動く（非破壊）。
  baseName?: string;        // 基(base)の名（例 "長剣"）＝itemByName 分解・打ち直しの基点
  affix?: string;           // 銘(affix)の key（AFFIXES）。無銘なら未設定
  enchant?: number;         // 強化度 +N（武器/防具）。+0 なら未設定
}
// bag は任意＝旧セーブ非破壊（migrate 不要・version 据え置き）。
export interface Equipment { weapon: Item | null; armor: Item | null; relic: Item | null; bag?: Item | null; }

/** 持ち物の1枠（消耗品をキー参照でスタック。容量＝枠数で数える＝Phase1）。 */
export interface InventorySlot { key: string; qty: number; }

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
  spells: string[];             // 習得した深蝕魔法のキー（取得無制限＝図鑑。4-11F③・SpellKey）
  loadout?: string[];           // 構えている術（戦闘で撃てるのはここだけ・上限LOADOUT_CAP=10）。安全地帯でのみ入替。任意＝旧セーブ非破壊。
  equipment: Equipment;         // 装備スロット（4-11F④）
  gold: number;                 // 金貨（4-10G 経済。拾得物の売却・依頼報酬で増え、店で減る）
  inventory?: InventorySlot[];  // 持ち物（消耗品。容量はレベルで増える＝progression.carryCapacity）。任意＝旧セーブ非破壊。
  gearBag?: Item[];             // 拾った未装備装備の袋（潜行中に携行＝世代内。街/行商人で売る。容量＝gearCapacity）。任意＝旧セーブ非破壊。
  prayedAtShrineGen?: number;   // 慰霊堂「深蝕を清める祈り」を捧げた世代（1世代1回ガード）。任意＝旧セーブ非破壊。
  cultBoonsThisGen?: number;    // 教団「深蝕を捧げる」を今世代に受けた回数（対価の逓増に使う）。任意＝旧セーブ非破壊。
  carryingRelic?: string;       // 奉献の試練：携行中の聖遺物の名（4-13C）。設定中は深蝕急騰＋追手。生還でクリア。任意＝旧セーブ非破壊。
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

/** アクター記述子（4-12(G)）。化石 origin を一般化し、生者NPCも同じ機構で表す。 */
export interface Actor {
  name: string;
  archetype: string;
  gearTags: string[];
  catchphrase?: string;
  epithet?: string;
  alive?: boolean;          // 生者NPC=true（痕跡保証ASSERT 4-2 は化石のみ対象）
  grade?: number;           // 金属等級（4-4E）の素材index 0=アイアン..4=プラチナ。設定ファイル(actor_grade)由来・相棒の初期等級と強さを決める。
}

/** 化石の出自。Actor の別名（後方互換）。 */
export interface FossilOrigin extends Actor {}

/** ★中核の名簿員（4-14・冒険者B/C）。content/adventurers.json で定義し、街で本人として出会える。
 *  Actor＋安定id（adv_*）＋運命メタ（化石化したときの極の傾き／弧の型）。セーブ非対象＝コンテンツ。 */
export interface RosterActor extends Actor {
  id: string;                                  // 安定id（例 "adv_mira"）。LivingActor.id にそのまま使う。
  fate: {
    tone: TonePole;                            // 化石化時に寄せたい極（legend=myth／因縁=grudge 等）
    hook: "legend" | "grudge" | "requiem" | "lineage"; // 似合う型（C-2 の弧・setpiece 傾向）
    arc?: string;                              // 街の出会い弧のキー（C-2 で arc+arcActor アンカー）
  };
}

/** 生者NPC（lazy：遭遇時に mint し、effects が参照した時だけ World.actors に永続：4-6/4-12C）。 */
export interface LivingActor {
  id: string;
  actor: Actor;
  metGeneration: number;
  // 同行の契約モデル（4-14C・2026-06-16）：雇用の蓄積を生者NPCに保存し、再雇用で再開する。
  grade?: number;   // 蓄積した金属等級（昇格はここに残る＝何度も雇うと精鋭に）
  bond?: number;    // 蓄積した絆
  feats?: number;   // 蓄積した偉業
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
  spells?: string[];            // 死亡時に覚えていた術（系譜継承 4-11F②：先代の術の一部が次代に滲む）。任意＝旧セーブ非破壊。
  wasCompanion?: boolean;       // 同行（相棒）由来の化石（戦死/慈悲/見捨て）。後世の再会で「相棒だと分かる」一言に使う（4-14C）。任意＝旧セーブ非破壊。
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

// 依頼（回収業 4-10G／4-12F quest）。ギルドで受注→ダンジョンで達成→街で金貨報酬。
export interface Quest {
  id: string;
  kind: "descend" | "reclaim";   // 到達／回収
  patron?: "noble";              // 発注元＝貴族街の統治者（奉献後の大命・4-13D Phase4）。任意＝旧セーブ非破壊。
  title: string;
  desc: string;
  targetDepth?: number;          // descend: 到達すべき深度 / reclaim: 対象化石の眠る深度
  targetFossilId?: string;       // reclaim: 再発見すべき化石
  rewardGold: number;
  status: "active" | "done" | "claimed";
  issuedGeneration: number;
}

export interface TownState {
  witnessNpcId: string;
  safety: number;
  memorials: string[];
  // 歩ける街（4-4B）：現在のサブシーンとプレイヤー位置（リロード復元用）。全て任意＝旧セーブ非破壊。
  scene?: "town" | "interior";
  pos?: { x: number; y: number };
  interiorKind?: string | null;
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
  minLevel?: number;       // プレイヤーのレベルがこれ以上（高名さのゲート＝貴族の関心など）
  hasCatchphrase?: boolean;// 化石が口癖を持つ/持たない（#origin_catchphrase# を使う本文の安全ガード）
  depthBand?: "shallow" | "mid" | "deep"; // 深度帯（ダンジョン文脈の発火条件）
  minDepth?: number;       // この深度以上で発火（depthBand より細かい下限・dungeon/chest）
  maxDepth?: number;       // この深度以下で発火（語りと深度の整合・上限）
  flag?: string;           // この化石に立った伏線フラグが有る（遭-②：伏線→後続）
  notFlag?: string;        // この化石に立った伏線フラグが無い（重複発火を防ぐ）
  // 長尺アーク（4-12(I)：進行度クオリティで多段の弧を組む。世界スコープ＝化石/アクター非依存）
  arc?: string;            // この弧が進行中（未完）であること
  arcStep?: number;        // かつ現在ステップがこの値（段の発火位置）
  arcPick?: string;        // かつ分岐の選択がこの値（早い選択が後段を変える）
  arcActor?: boolean;      // かつ「今会っている生者＝この弧のアンカーNPC」（特定NPCに戻る弧／街）
  notArc?: string;         // この弧が未開始であること（開幕の重複発火を防ぐ）
  actorId?: string;        // 特定の生者（名簿員＝adv_*）に出会った時だけ発火（街専用・4-14 イントロ用）
}

/** 選択の結果として世界状態へ還流する変化。文字列は origin スロットを充填できる。 */
export interface Effect {
  bond?: number;           // この化石との絆 value への増減
  closeUnfinished?: boolean;
  exposure?: number;       // プレイヤー深蝕への増減
  trait?: string;          // 形質を付与（#origin_name# 等のスロット可）
  chronicle?: string;      // 年代記に一行残す（スロット可）
  plant?: string;          // 伏線フラグを立てる（この化石にスコープ。後続の prereq.flag が拾う）
  arc?: ArcEffect;         // 長尺アークを開始/前進/分岐記録/完了（4-12(I)）
  gold?: number;           // 報酬：金貨の増減（4-10G 経済）
  item?: string;           // 報酬：消耗品キーを1つ持ち物へ（容量超過なら持ちきれず破棄）
}

/** 長尺アークの進行操作（Effect.arc）。step を設定し、pick で分岐を記録、done で弧を閉じる。anchor で今の生者をアンカー。 */
export interface ArcEffect { key: string; step: number; pick?: string; done?: boolean; anchor?: boolean; actorRef?: string }

/** 長尺アークの状態（World.arcs：進行度クオリティ＝多段の弧を数える。4-12(I)）。actorRef＝特定NPCに戻る弧の相手。 */
export interface ArcState { key: string; step: number; pick?: string; done?: boolean; actorRef?: string }

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

/** イベントの発生場所＝コンテキスト（4-12(F)・4-14：場所で別の顔を出す。混合せず、コンテキスト内で大量×重み）。 */
export type StoryletContext =
  | "encounter"  // 化石/アクターとの出会い（迷宮）
  | "dungeon"    // 迷宮の環境イベント（アクター無し）
  | "street"     // 街路の生者（旧 "town"）
  | "tavern"     // 酒場の生者
  | "guild"      // ギルドの生者
  | "shop"       // 店内の生者
  | "quest"      // 依頼
  | "chest"      // 宝箱の中身
  | "delver";    // 迷宮で同時に潜る生者の冒険者（すれ違いの軽イベント・4-14）

/** 街で生者と会いうる場所（4-14：street を基盤に、tavern/guild/shop が固有の顔を上乗せ）。 */
export type TownContext = "street" | "tavern" | "guild" | "shop";

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

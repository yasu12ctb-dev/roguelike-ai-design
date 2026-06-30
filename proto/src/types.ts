// 永続層スキーマ（prototype-spec.md §2 に準拠）

import type { Difficulty } from "./difficulty.ts";

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
  questsDone?: number;          // 達成（報酬受取）した依頼の通算数（4-4E プレイヤー等級の実績スコア）。任意＝旧セーブ非破壊。
  recognizedGrade?: number;     // ギルドが正式認定済みの最高等級（昇格イベントの既読管理：4-4E）。任意＝旧セーブ非破壊。
  stash?: InventorySlot[];      // 自宅の保管庫：消耗品（世代を越えて残る＝持ち物システム Phase3）。任意＝旧セーブ非破壊。
  stashGear?: Item[];           // 自宅の保管庫：装備（武器/防具/遺物/鞄の収集。世代越え）。任意＝旧セーブ非破壊。
  homeUnlocked?: boolean;        // 自宅（武具庫）を入手済みか（銀昇格で「倒れた冒険者の家を継ぐ」＝4-10C）。新規=false／旧セーブは migrate で true。
  seals?: string[];             // 奉献の試練：集めた印（SealKey。World に蓄積＝世代越え。5種で深淵帯解錠：4-13A）。任意＝旧セーブ非破壊。
  ascended?: number;            // 奉献の試練：聖遺物を地上へ生還させてクリアした回数（4-13D）。任意＝旧セーブ非破壊。
  companion?: Companion;        // 同行（相棒）の永続状態（4-14C）。生かし続ければセーブ全体を貫く反復キャラ。任意＝旧セーブ非破壊。
  arcs?: ArcState[];            // 長尺アークの進行状態（4-12(I)：多段の弧。世代越え）。任意＝旧セーブ非破壊。
  bestiary?: string[];          // 敵図鑑：遭遇した敵種の名（kind.name。世代越え。web限定）。任意＝旧セーブ非破壊。
  raidCooldown?: number;        // 街の防衛（襲撃）の冷却＝帰還ごとに減り、0で再抽選（定期的だが間隔は長い）。任意＝旧セーブ非破壊。
  memorialCooldown?: number;    // 追悼の日（祭礼）の冷却＝アンビエント街イベント（4-12 J）。任意＝旧セーブ非破壊。
  plagueCooldown?: number;      // 深蝕の瘴気（疫病）の冷却＝街の災厄（4-12 J）。任意＝旧セーブ非破壊。
  omenCooldown?: number;        // 深みの兆し（後期帯 Lv20+ を埋める・監査B4）の冷却。任意＝旧セーブ非破壊。
  diveCount?: number;           // 潜行回数（startDive ごと+1）。genFloor のseedに混ぜて潜行ごとに別ダンジョン＝再潜行farm防止。任意＝旧セーブ非破壊。
  eraBeats?: number;            // 世界時間の加算分（4-14G・層1）。worldTime = generation + eraBeats＝死だけでなく深部での営み（生還）でも世界が老ける。任意＝旧セーブ非破壊。
  eraClock?: number;            // 世界クロックの深度積分アキュムレータ（生還ごと加算・1で1ビート発火＝eraBeats++）。浅層(≤8)の周回では進まない。任意＝旧セーブ非破壊。
  diveMaxDepth?: number;        // 今回の潜行で到達した最深（web が enterFloor で更新）。生還時の世界クロック加算に使う。任意＝旧セーブ非破壊。
  manorUnlocked?: boolean;      // 貴族街の館（4-14G 層4・終盤メタ）：奉献 or 高家格で自宅が館へ格上げ（保管庫拡張＋系譜の間荘厳化＋相続枠増）。任意＝旧セーブ非破壊。
  echoes?: EchoAsh[];           // 残響召喚の遺灰（4-10I）：神話極の化石を鎮魂して得る。潜行で1回展開＝強めの一時味方。世代越え。任意＝旧セーブ非破壊。
  keepsakes?: Keepsake[];       // 拾得品の蒐集（読み物コレクション・書記の館で再読）。世代を越えて堆積する好古の棚。任意＝旧セーブ非破壊。
  difficulty?: Difficulty;      // 難易度モード（4-11H）。新規ワールド開始時に固定（途中変更なし）。未設定/旧セーブ＝easy＝現行数値。
}

/** 拾得品の収集記録（セーブ側）：id 参照のみ＝本文は content/keepsakes.json から引く（複製しない＝後の文章修正も既収集に反映）。
 *  title は旧セーブ移行用のフォールバック（新規収集は id だけで解決）。 */
export interface Keepsake { id: string; gen: number; depth: number; title?: string; }

/** 拾得品の定義（プール・content/keepsakes.json）：書記の館で再読できる詩情系の収集品。純フレーバー・効果なし。 */
export interface KeepsakeDef { id: string; title: string; story: string; band: "shallow" | "mid" | "deep" | "abyss"; }

/** 残響召喚の遺灰（4-10I・Elden Ring の遺灰型）。神話極の化石の鎮魂で得て、潜行中に1回だけ展開して消費する。 */
export interface EchoAsh {
  fossilId: string;             // 由来の化石（神話極）。逆参照＝誰の残響かを表示するため。
  name: string;                 // 由来の英雄名（origin.name のスナップショット＝化石が失われても表示できる）。
  dmg: number;                  // 残響のダメージ（鎮魂時の深度に応じてスナップショット）。
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
export type RelicKind = "calm" | "reason" | "greed" | "might" | "vigor" | "ward" | "fortune" | "mending"
  // 拡充（物量レビュー PR3・2026-06-28）：8→13 効果。重複基テンプレ頼みを解消し収集/エンドゲームの幅を広げる。
  | "thorns"    // 被弾した近接の一部を反射（茨）
  | "siphon"    // 近接命中ぶんを吸命（渇き）
  | "clarity"   // 毒・侵蝕(curse)の蓄積を半減（澄心）
  | "potency"   // 術ダメージ増（術理）
  | "revenant"; // 潜行中一度だけ致死を1で耐える（不死鳥の灰）
// calm=深蝕レート減 / reason=理+1 / greed=撃破XP×1.5 / might=近接+1 / vigor=最大HP+6 / ward=被ダメ-1 / fortune=拾う金貨×1.5 / mending=潜行中ゆっくり回復
// 武器の発動効果（物量レビュー PR4・2026-06-28）：武器に初の「挙動差」を与える（従来は近接+ダメージのみ）。命中時に発動・web 適用。
//   cleave=隣接の他の敵にも余波／stun=一定確率で目標を当て止め／rend=裂傷（継続ダメ）／sap=目標の攻撃を弱める。
export type WeaponProc = "cleave" | "stun" | "rend" | "sap";
export interface Item {
  id: string; slot: ItemSlot; name: string;
  dmg?: number;             // 武器：近接ダメージ+（銘・+N 込みの最終値）
  reduce?: number;          // 防具：被ダメージ-（銘・+N 込みの最終値）
  relic?: RelicKind;        // 遺物：パッシブ種
  proc?: WeaponProc;        // 武器：命中時の発動効果（基テンプレ由来＝名前でなく base から導出）
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
  inventory?: InventorySlot[];  // 荷物の消耗品（薬・巻物）。任意＝旧セーブ非破壊。
  gearBag?: Item[];             // 荷物の拾った未装備武具（街/行商人で売る・荷物として装備可）。任意＝旧セーブ非破壊。
  // ↑ inventory と gearBag は同じ「荷物」＝合計が progression.packCapacity（2026-06-29 統合：消耗品と武具で枠を共有）。
  prayedAtShrineGen?: number;   // 慰霊堂「深蝕を清める祈り」を捧げた世代（1世代1回ガード）。任意＝旧セーブ非破壊。
  restedTavernGen?: number;     // 酒場「休む（一杯やる）」で英気を養った世代（1世代1回ガード）。任意＝旧セーブ非破壊。
  cultBoonsThisGen?: number;    // 教団「深蝕を捧げる」を今世代に受けた回数（対価の逓増に使う）。任意＝旧セーブ非破壊。
  exposureBrand?: number;       // 教団の烙印（一時分）＝薬師/安息所/解呪でこの値より下に祓えない深蝕の下限。潜行1階ごとに薄れる（exposureTaint までで止まる）。web限定・任意＝旧セーブ非破壊。
  exposureTaint?: number;       // 教団の永続汚染＝二度と祓えない深蝕の下限（1取引ごとに CULT_PERMA 増・潜行でも薄れない）。集めるほど死亡時の怨念化が不可避。web限定・任意＝旧セーブ非破壊。
  carryingRelic?: string;       // 奉献の試練：携行中の聖遺物の名（4-13C）。設定中は深蝕急騰＋追手。生還でクリア。任意＝旧セーブ非破壊。
}

export interface Lineage {
  relation: "blood" | "pupil" | "none" | "heir";   // heir＝退隠した先代を襲名（4-14G・全継承＋装備相続＝功績比例）
  ancestorFossilId?: string;
  chosenSpells?: string[];      // 血縁：継ぐ術を自分で選んだ結果（最大2）。UI で選んで createCharacter に渡す。任意（CLI/旧経路は先頭から自動）。
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
  level?: number;               // 死亡時のレベル（系譜の継承量＝血縁のベース加算／弟子の開始レベルの基準）。任意＝旧化石は laidDepth を代用。
  stats?: Stats;                // 死亡時のステ分布（系譜の配分を「先代の得意ステ」に寄せるため）。任意＝旧化石は体寄せで代用。
  wasCompanion?: boolean;       // 同行（相棒）由来の化石（戦死/慈悲/見捨て）。後世の再会で「相棒だと分かる」一言に使う（4-14C）。任意＝旧セーブ非破壊。
  wasAlly?: boolean;            // 生者→化石ループ（4-14・b）：街/迷宮で縁を結んだ生者NPCが深みで還らず化石化した者。後世の再会で「会った相手だと分かる」一言に使う。任意＝旧セーブ非破壊。
  retired?: boolean;           // 退隠（4-14G・層2）：死でなく自ら退いた先代の系譜記録。亡骸ではない＝迷宮遭遇から除外。襲名(heir)の継承元。任意＝非破壊。
  achievementAtEnd?: number;   // 退隠/死亡時の功績スコア（4-14G）。襲名ボーナス（継ぐ術数・装備相続の可否）を功績比例にするための基準。任意＝非破壊。
  reachedAt?: number;          // フロンティア相対（4-14G・層1①）：プレイヤーがこの化石の深度帯に初到達した worldTime。変質クロックの起点＝「まず出会わせて、放置すれば歪む」。任意＝非破壊。
  frontierHeld?: boolean;      // 到達まで変質を凍結する化石（シード/doom終端/縁ループ＝深部に置かれ未到達でありうる）。reachedAt が立つまで weathered のまま。任意＝非破壊。
}

export interface TrackedEntity {
  id: string;
  name: string;
  source: "seeded" | "player_legend" | "nemesis";
  arcType: "retire" | "doom" | "fall" | "lore_drift";
  beat: number;
  lastObservedGeneration: number;
  originRef?: string;
  // 運命の弧の進行（4-6B・M3 第一スライス）。すべて任意＝旧セーブ非破壊バックフィル（migrateWorld）。
  drift?: number;      // 法則順守（4-2）：高深度で原型化石に関与した累積。閾値で終端を破滅側へ歪める。
  terminal?: boolean;  // 弧が終端（beat==ARC_MAX_BEAT）に到達し、帰結を1度だけ刻んだ。
  pick?: string;       // 終端の分岐（"warped"＝drift で歪んだ末路）。後続スライスの実体化フックが読む。
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
  kind: "descend" | "reclaim" | "slay"; // 到達／回収／討伐（slay＝深層のエリアボス撃破・4-14G 高難度大命）
  patron?: "noble";              // 発注元＝貴族街の統治者（奉献後の大命・4-13D Phase4）。任意＝旧セーブ非破壊。
  title: string;
  desc: string;
  targetDepth?: number;          // descend/slay: 到達/撃破すべき深度 / reclaim: 対象化石の眠る深度
  targetFossilId?: string;       // reclaim: 再発見すべき化石
  rewardGold: number;
  rewardRelic?: boolean;         // 高難度大命の固有報酬（claim 時にボス級遺物＋称号を授与・4-14G）。任意＝非破壊。
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
  depthBand?: "shallow" | "mid" | "deep" | "abyss";
  archetype?: string;
  finalAct?: FinalActChoice;
  arc?: "retire" | "doom" | "fall" | "lore_drift"; // 運命の弧の原型（arc_beat 断片・4-6B）
  beat?: number;                                   // 弧の段（arc_beat 断片）
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
  depthBand?: "shallow" | "mid" | "deep" | "abyss"; // 深度帯（ダンジョン文脈の発火条件）
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
  item?: string;           // 報酬：消耗品キーを1つ持ち物へ（容量超過時：web は「交換／諦める」UI／CLI は持ちきれず破棄）
  keepsake?: string;       // 拾得品（蒐集）：keepsakes.json の id を1つ収集記録へ（書記の館で再読）。純フレーバー・効果なし。
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
  | "delver"     // 迷宮で同時に潜る生者の冒険者（すれ違いの軽イベント・4-14）
  | "noble";     // 貴族街（クリア後解禁）の宮廷の生者＝家令/廷臣/招かれた客人（4-14G 層4b・後続バッチ）

/** 街で生者と会いうる場所（4-14：street を基盤に、tavern/guild/shop/noble が固有の顔を上乗せ）。 */
export type TownContext = "street" | "tavern" | "guild" | "shop" | "noble";

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
  speaker?: "keeper";            // 話者＝固定NPC本人（店主/受付等）。既定=雑踏(talkCrowd)／"keeper"=店主に話しかけた時 talkKeeper が本人として語る（#origin_name#=店主名）。街 context 限定・#origin_name# 以外のスロット不可（4-4B 辻褄整合）
  courtRole?: "steward" | "courtier" | "guest"; // noble context 限定：役職固有の本文（家令の蔵管理／客人の回想 等）を、courtNpcScene がその役職のNPCにだけ配信する（未指定=どの宮廷NPCにも可）。役職ミスラベル防止（4-14G）
}

// ---- 変質計算の結果 ----

export interface VariationResult {
  decay: number;
  distort: number;
  stage: VariationStage;
  intensity: number;
}

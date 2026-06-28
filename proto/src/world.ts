// 世界の生成・化石化・干渉・年代記・永続化（prototype-spec.md §2 / §5）

import type {
  Actor, ArcEffect, ArcState, Character, ChronicleEntry, Companion, DeathManner, EchoAsh, FinalAct, FinalActChoice, Fossil, Lineage, LivingActor, SealKey, Stats, TonePole, TrackedEntity, World,
} from "./types.ts";
import { SEAL_KEYS, SEAL_LABEL } from "./types.ts";
import { resolveTonePole } from "./variation.ts";
import { BASE_STATS, STASH_INHERIT, STASH_INHERIT_MANOR, LOADOUT_CAP } from "./progression.ts";
import { worldPlayerGrade, worldAchievement } from "./companion.ts";
import { diffMods } from "./difficulty.ts";

let idCounter = 0;
const newId = (prefix: string) => `${prefix}_${(++idCounter).toString(36)}`;

/** セーブ版数（v2=②ステ／v3=③ spells／v4=④ equipment／v6=歩ける街シーン／v7=金貨／v8=依頼／v9=同行。横断D）。 */
export const SAVE_VERSION = 9;

/** 世界時間（4-14G・層1）＝ generation（死/退隠でのみ増える＝家系の深さ）＋ eraBeats（深部での営み＝
 *  生還で増える＝世界の熱）。時間系（変質・弧・遭遇重み）はこれを参照＝死を回避する熟練者でも世界が老ける。
 *  CLI/demo/golden は eraBeats=0 ゆえ worldTime==generation＝指紋不変。 */
export function worldTime(world: World): number {
  return (world.generation ?? 1) + (world.eraBeats ?? 0);
}

/** 旧セーブ（v0.53.0）の拾得品＝題で保存されていた11件を、現プール（keepsakes.json）の安定idへ移行する対応表。 */
const LEGACY_KEEPSAKE_ID: Record<string, string> = {
  "宛名のない手紙": "ks_letter", "錆びた鍵束": "ks_keys", "開かぬ小箱": "ks_locked",
  "木彫りの玩具": "ks_toy", "名もなき欠片": "ks_fragment", "片身の首飾り": "ks_locket",
  "誓いの指輪": "ks_ring", "壊れたオルゴール": "ks_musicbox", "ふやけた日誌の頁": "ks_diary",
  "笑みの形の面": "ks_mask", "削られた名札": "ks_nameplate",
};

/** 旧セーブを現行スキーマへ補完（破壊しない）。
 *  欠落フィールドは版数に関わらず常に補う（版数判定だけに頼ると、追加フィールドの
 *  取りこぼしが起きる＝v2セーブに spells が無くフリーズした不具合の再発防止）。 */
export function migrateWorld(w: World): World {
  // 防御：parse できる任意オブジェクトを「エンジンが動く有効 World」に補完する（migrate の契約を全域化）。
  // 真の旧セーブ／新規は必ずコアを持つため通常は no-op だが、iOS standalone PWA の粘着的キャッシュで
  // セーブが部分破損しても、コア欠落で後段（chronicle.push / fossils.length / drawTown）が throw しない保険。
  if (typeof w.seed !== "number") w.seed = 0;
  if (typeof w.generation !== "number") w.generation = 1;
  if (!Array.isArray(w.fossils)) w.fossils = [];
  if (!Array.isArray(w.chronicle)) w.chronicle = [];
  if (!w.town) w.town = { witnessNpcId: "witness_yen", safety: 3, memorials: [], scene: "town", interiorKind: null };
  if (w.current) {
    const ch = w.current as Partial<Character> & Character;
    if (!ch.stats) ch.stats = { ...BASE_STATS };
    if (typeof ch.level !== "number") ch.level = 1;
    if (typeof ch.xp !== "number") ch.xp = 0;
    if (!Array.isArray(ch.spells)) ch.spells = [];
    if (!Array.isArray(ch.loadout)) ch.loadout = ch.spells.slice(0, LOADOUT_CAP); // 構え（4-11F③）：旧セーブは習得順の先頭から補完
    else ch.loadout = ch.loadout.filter((k) => ch.spells.includes(k)).slice(0, LOADOUT_CAP); // 整合（未習得/超過を除去）
    if (!ch.equipment) ch.equipment = { weapon: null, armor: null, relic: null };
    if (typeof ch.gold !== "number") ch.gold = 0; // v7：金貨
    if (!Array.isArray(ch.gearBag)) ch.gearBag = []; // 持ち物 Phase4：拾った装備の袋（非破壊バックフィル）
  }
  if (!Array.isArray(w.actors)) w.actors = []; // 生者NPC（4-12(G)）：欠落は常に補完
  if (w.companion && typeof (w.companion as Partial<Companion>).grade !== "number") {
    (w.companion as Companion).grade = w.companion.actor?.grade ?? 0; // 4-4E：旧セーブの相棒に等級を補完（設定→なければアイアン）
  }
  if (w.companion && typeof (w.companion as Partial<Companion>).feats !== "number") {
    (w.companion as Companion).feats = 0; // 4-4E：偉業カウンタを補完（昇格の偉業ゲート）
  }
  if (!Array.isArray(w.flags)) w.flags = [];
  if (!Array.isArray(w.quests)) w.quests = []; // v8：依頼（回収業 4-10G）
  if (!Array.isArray(w.stash)) w.stash = [];       // 自宅の保管庫・消耗品（持ち物 Phase3）：欠落は空で補完
  if (!Array.isArray(w.stashGear)) w.stashGear = []; // 自宅の保管庫・装備：欠落は空で補完
  if (w.homeUnlocked === undefined) w.homeUnlocked = true; // 旧セーブは自宅所持済み＝grandfather（新規 world は newWorld で false 明示ゆえ undefined にならず未解禁を保つ）
  if (!Array.isArray(w.arcs)) w.arcs = [];         // 長尺アーク（4-12(I)）：欠落は空で補完
  if (!Array.isArray(w.tracked)) w.tracked = [];   // 追跡対象（4-6）：欠落は空で補完
  for (const t of w.tracked) {                     // 運命の弧の進行フィールド（M3 第一スライス）：欠落は0/未到達で補完
    if (typeof t.beat !== "number") t.beat = 0;
    if (typeof t.lastObservedGeneration !== "number") t.lastObservedGeneration = w.generation ?? 1;
    if (typeof t.drift !== "number") t.drift = 0;
  }
  if (typeof w.raidCooldown !== "number") w.raidCooldown = 0; // 街襲撃の冷却：欠落は0で補完
  if (typeof w.memorialCooldown !== "number") w.memorialCooldown = 0; // 追悼の日の冷却：欠落は0で補完
  if (typeof w.plagueCooldown !== "number") w.plagueCooldown = 0; // 疫病の冷却：欠落は0で補完
  if (typeof w.diveCount !== "number") w.diveCount = 0; // 潜行回数（再潜行farm防止のseed nonce）：欠落は0で補完
  if (typeof w.eraBeats !== "number") w.eraBeats = 0;   // 世界時間の加算分（4-14G 層1）：欠落は0＝旧セーブは worldTime==generation で従来挙動
  if (typeof w.eraClock !== "number") w.eraClock = 0;   // 世界クロックのアキュムレータ：欠落は0
  if (!Array.isArray(w.echoes)) w.echoes = []; // 残響召喚の遺灰（4-10I）：欠落は空で補完
  if (!Array.isArray(w.keepsakes)) w.keepsakes = []; // 拾得品の蒐集（読み物コレクション）：欠落は空で補完
  else for (const k of w.keepsakes as any[]) { // 旧形式 {title,story,gen,depth} → {id,gen,depth,title}（本文複製を廃し id 参照へ・v0.54.0）
    if (k && typeof k.id !== "string") {
      const t = typeof k.title === "string" ? k.title : "";
      k.id = LEGACY_KEEPSAKE_ID[t] ?? `legacy:${t}`; // 旧11題は安定idへ・未知題はフォールバックid（題を保持）
      delete k.story; // 本文はプール（keepsakes.json）から引く＝セーブから本文を落とす
    }
  }
  if (typeof w.difficulty !== "string") w.difficulty = "easy"; // 難易度（4-11H）：旧セーブは現行＝easy で grandfather（途中変更させない）
  if (!Array.isArray(w.seals)) w.seals = [];       // 奉献の試練・集めた印（4-13A）：欠落は空で補完
  if (typeof w.ascended !== "number") w.ascended = 0; // 奉献の試練・クリア回数（4-13D）
  if (typeof w.questsDone !== "number") w.questsDone = 0; // 4-4E 実績スコア（達成依頼数）：欠落は0
  if (typeof w.recognizedGrade !== "number") w.recognizedGrade = worldPlayerGrade(w, w.current?.level ?? 1); // 既存セーブは現等級で初期化＝昇格イベントの再演を防ぐ
  if (!Array.isArray(w.bestiary)) w.bestiary = []; // 敵図鑑（遭遇種）：欠落は空で補完
  if (w.town) { // 歩ける街（4-4B）：旧セーブに欠落するサブシーン状態を補完
    if (!Array.isArray(w.town.memorials)) w.town.memorials = []; // 慰霊碑（4-6C）：供養した先人の名。欠落は空で補完
    if (w.town.scene !== "town" && w.town.scene !== "interior") w.town.scene = "town";
    if (w.town.interiorKind === undefined) w.town.interiorKind = null;
    // w.town.pos は未設定のまま＝描画側で town.json の start を既定にする
  }
  w.version = SAVE_VERSION;
  return w;
}

/** 初期12体の先人（4-14）。adventurers.md の故人系を元に、深度帯×極×干渉動詞が散るよう編成。
 *  全員 epithet 付き（名簿 ASSERT 4-2／event-check 5e）。catchphrase は怨念・神話の一部のみ（無い者は静かな喪失）。
 *  finalAct=guard_relic/leave_will の5体は「遺されたものを継ぐ」（継承）が選べる。level/stats は系譜継承の配分基準。 */
interface SeedFossilSpec {
  name: string; epithet: string; archetype: string; gear: string; catchphrase?: string;
  tone: TonePole; manner: DeathManner; finalAct: FinalActChoice;
  depth: number; exposure: number; bond: number; level: number; stats: Stats;
}
const SEED_FOSSILS: SeedFossilSpec[] = [
  // ── 浅層（3–8）：序盤の手触り ──
  { name: "オック", epithet: "出戻り", archetype: "元探索者", gear: "古びた手斧", catchphrase: "まだ…やれる",
    tone: "loss", manner: "peaceful", finalAct: "accept", depth: 8, exposure: 0.4, bond: 0, level: 8, stats: { body: 6, power: 4, reason: 2, heart: 3 } },
  { name: "カルト", epithet: "遺された家族", archetype: "衛士", gear: "家紋入りの胸当て", catchphrase: "すまない…帰れない",
    tone: "loss", manner: "grievous", finalAct: "leave_will", depth: 7, exposure: 0.9, bond: 1, level: 7, stats: { body: 6, power: 4, reason: 2, heart: 4 } },
  { name: "ケス", epithet: "逃亡者", archetype: "旅芸人", gear: "質草の竪琴", catchphrase: "もう、追ってくるな",
    tone: "grudge", manner: "betrayed", finalAct: "curse_dungeon", depth: 5, exposure: 1.1, bond: 0, level: 5, stats: { body: 3, power: 3, reason: 3, heart: 6 } },
  // ── 中層（9–24）：主戦場・密度高め ──
  { name: "ガロ", epithet: "粗暴", archetype: "喧嘩屋", gear: "刃こぼれの斧", catchphrase: "どけ…どけ！",
    tone: "grudge", manner: "grievous", finalAct: "curse_dungeon", depth: 12, exposure: 1.8, bond: 0, level: 12, stats: { body: 5, power: 7, reason: 2, heart: 2 } },
  { name: "ブレン", epithet: "鍛冶", archetype: "鍛冶師", gear: "ブレン銘の長剣", catchphrase: "鋼は、嘘をつかん",
    tone: "loss", manner: "grievous", finalAct: "guard_relic", depth: 14, exposure: 0.8, bond: 0, level: 14, stats: { body: 7, power: 5, reason: 3, heart: 3 } },
  { name: "クラン", epithet: "師父", archetype: "師範", gear: "古い木刀", catchphrase: "受け継いでくれ",
    tone: "loss", manner: "peaceful", finalAct: "leave_will", depth: 16, exposure: 0.2, bond: 1, level: 16, stats: { body: 6, power: 6, reason: 3, heart: 5 } },
  { name: "ダン", epithet: "豪傑", archetype: "重戦士", gear: "大ぶりの戦鎚", catchphrase: "ガ…ハ…ハ…",
    tone: "loss", manner: "grievous", finalAct: "accept", depth: 20, exposure: 1.6, bond: 0, level: 20, stats: { body: 7, power: 7, reason: 2, heart: 3 } },
  { name: "ジャス", epithet: "信仰", archetype: "祈祷師", gear: "聖印の祭具", catchphrase: "御手のままに",
    tone: "myth", manner: "noble", finalAct: "guard_relic", depth: 22, exposure: 0.6, bond: 0, level: 22, stats: { body: 4, power: 3, reason: 5, heart: 7 } },
  // ── 深層（25–37）：歪んだ強者 ──
  { name: "オルド", epithet: "一匹狼", archetype: "傭兵", gear: "無頼の双刀", catchphrase: "群れぬ、馴れ合わぬ",
    tone: "grudge", manner: "betrayed", finalAct: "curse_dungeon", depth: 28, exposure: 1.4, bond: 0, level: 28, stats: { body: 6, power: 8, reason: 3, heart: 3 } },
  { name: "シオン", epithet: "実験者", archetype: "深淵術士", gear: "蝕みの触媒", catchphrase: "深蝕は、ちからだ",
    tone: "grudge", manner: "grievous", finalAct: "curse_dungeon", depth: 30, exposure: 1.7, bond: 0, level: 30, stats: { body: 3, power: 3, reason: 8, heart: 4 } },
  { name: "沈黙のヴァイス", epithet: "鎮める者", archetype: "遊行者", gear: "無銘の数珠", catchphrase: "討つな。鎮めよ",
    tone: "myth", manner: "peaceful", finalAct: "accept", depth: 33, exposure: 0.3, bond: 0, level: 33, stats: { body: 5, power: 3, reason: 6, heart: 9 } },
  // ── 深淵（38–50）：世界の起点 ──
  { name: "アウレル", epithet: "黄金の烙印", archetype: "開拓者", gear: "烙印の聖印",
    tone: "myth", manner: "noble", finalAct: "guard_relic", depth: 44, exposure: 1.0, bond: 0, level: 44, stats: { body: 8, power: 8, reason: 8, heart: 8 } },
];

/** 初期史のシード（snapshot 4-1D：薄く仕込む） */
export function newWorld(seed: number): World {
  const world: World = {
    seed,
    version: SAVE_VERSION,
    generation: 1,
    current: null,
    fossils: [],
    tracked: [],
    chronicle: [],
    town: { witnessNpcId: "witness_yen", safety: 3, memorials: [], scene: "town", interiorKind: null },
    flags: [],
    actors: [],
    quests: [],
    stash: [],
    stashGear: [],
    homeUnlocked: false, // 自宅は初期未所持＝銀昇格で「倒れた冒険者の家を継ぐ」（4-10C）。明示 false＝再読込でも未解禁を保つ。
    seals: [],
    ascended: 0,
    keepsakes: [],
    eraBeats: 0,        // 世界時間の加算分（4-14G 層1）：新規は0＝worldTime==generation から開始
    eraClock: 0,        // 世界クロックのアキュムレータ
    diveMaxDepth: 0,    // 今回の潜行の最深
  };
  // シード化石（4-14・初期12体）：街に「生きている名簿」とは別に、迷宮には既に眠る先人がいる。
  //  深度帯（浅3／中5／深3／深淵1）・極（loss5/grudge4/myth3）・継承可5体を散らし、どの深度・どの干渉動詞でも
  //  常に複数候補が立つようにする（rollEncounter は深度近傍しか拾わない＝「いつも同じ化石」の解消）。
  //  名簿(adventurers.json)の生者とは別人＝「街に生きる者／迷宮に骨となった者」の層を作る。
  for (const s of SEED_FOSSILS) {
    world.fossils.push({
      id: newId("fossil"),
      kind: "explorer",
      origin: { name: s.name, archetype: s.archetype, gearTags: [s.gear], epithet: s.epithet, ...(s.catchphrase ? { catchphrase: s.catchphrase } : {}) },
      death: { manner: s.manner, finalAct: { choice: s.finalAct }, depth: s.depth, generationCreated: 0 },
      exposureAtDeath: s.exposure, bondAtDeath: s.bond, tonePole: s.tone,
      interventions: [], lastTouchedGeneration: 0, laidDepth: s.depth,
      level: s.level, stats: s.stats,
      frontierHeld: true, // フロンティア相対（4-14G 層1①）：到達するまで変質を凍結＝出会う前に歪ませない
    });
  }
  // シード追跡対象：有名パーティー（運命の弧の最小形）
  world.tracked.push({
    id: newId("tracked"), name: "銀の三人", source: "seeded",
    arcType: "doom", beat: 0, lastObservedGeneration: 1,
  });
  chronicle(world, "legend", "迷宮が現れて久しい。街は今日も、潜る者たちの上前で栄えている。", []);
  return world;
}

// 系譜の継承パラメータ（4-10D／テストプレイ調整可）。血縁＝質＋恒久ベース／弟子＝量＋開始Lv（前借り）。
export const BLOOD_SPELLS = 2;       // 血縁：継ぐ術（自分で選ぶ）
export const PUPIL_SPELLS = 4;       // 弟子：継ぐ術（自動・多芸だが選べない）
export const BLOOD_STAT_CAP = 5;     // 血縁：恒久ベース加算の上限（先代Lv50で +5）
export const PUPIL_LEVEL_CAP = 8;    // 弟子：開始レベル加算の上限（先代Lv48+で +8）
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
/** 系譜のステ加算を「先代の得意ステ」に寄せて配分する（同点/不明は 体→力→理→心 の順）。決定論。 */
function addLineageStats(into: Stats, points: number, ancStats?: Stats): void {
  if (points <= 0) return;
  const order: (keyof Stats)[] = ["body", "power", "reason", "heart"];
  // 先代ステを降順（同点は order 順）に並べ、強いステから巡回して振る＝その血/教えの傾きを継ぐ。
  const ranked = ancStats
    ? [...order].sort((a, b) => (ancStats[b] - ancStats[a]) || (order.indexOf(a) - order.indexOf(b)))
    : order;
  for (let i = 0; i < points; i++) into[ranked[i % ranked.length]] += 1;
}

export function createCharacter(world: World, name: string, archetype: string, lineage: Lineage): Character {
  const ch: Character = {
    id: newId("ch"), name, archetype, lineage,
    traits: [], exposure: 0, depth: 0, bonds: [], alive: true,
    stats: { ...BASE_STATS }, level: 1, xp: 0, spells: [], loadout: [],
    equipment: { weapon: null, armor: null, relic: null, bag: null },
    gold: 0,
    inventory: [],
    gearBag: [],
  };
  // 系譜（4-10D／4-11F②）：先代から因縁・術・地力を継ぐ。血縁＝大器晩成（恒久ベース＋選んだ術2）／弟子＝スタートダッシュ（開始Lv＋術4自動）。
  if (lineage.relation !== "none" && lineage.ancestorFossilId) {
    const anc = world.fossils.find((f) => f.id === lineage.ancestorFossilId);
    if (anc) {
      ch.bonds.push({ entityRef: anc.id, value: 2, unfinished: true }); // 先代の未完を継ぐ（因縁は難易度に依らず継ぐ＝物語の連続性）
      ch.traits.push(`${anc.origin.name}の${lineage.relation === "blood" ? "血" : "教え"}`);
      const learn = (key: string) => { if (!ch.spells.includes(key)) { ch.spells.push(key); if (ch.loadout!.length < LOADOUT_CAP) ch.loadout!.push(key); } };
      const mLv = anc.level ?? anc.laidDepth ?? 1;        // 先代Lv（旧化石は深度を代用＝Lv≈深度）
      if (!diffMods(world.difficulty).lineage) { /* 難易度（death 等）が系譜ボーナス無効＝術/地力は継がない（因縁のみ） */ }
      else if (lineage.relation === "blood") {
        // 術：自分で選んだ2つ（UI 未指定＝CLI/旧経路は先頭2つ）。回復/帰還を最初から持てる質の継承。
        const picks = (lineage.chosenSpells && lineage.chosenSpells.length ? lineage.chosenSpells : (anc.spells ?? [])).slice(0, BLOOD_SPELLS);
        for (const key of picks) learn(key);
        // 地力：恒久ベース加算（大器晩成）＝先代の得意ステへ寄せる。
        addLineageStats(ch.stats, clamp(Math.floor(mLv / 10), 1, BLOOD_STAT_CAP), anc.stats);
      } else if (lineage.relation === "heir") {
        // 襲名（4-14G・層2）：退隠した先代の家督を継ぐ。死亡継承を上回る待遇＝「平穏な伝授は綺麗に渡せる」。
        // ★ボーナスは功績比例（雪だるま防止）＝駆け出しを退かせても殆ど継げない／伝説を退かせれば全継承。
        const ach = anc.achievementAtEnd ?? 0;
        const known = anc.spells ?? [];
        const count = clamp(2 + Math.floor(ach / 2), BLOOD_SPELLS, known.length); // 継ぐ術数（功績で増える・最大は全術）
        for (const key of known.slice(0, count)) learn(key);
        // 地力＝恒久ベース（血縁＋α）＋ささやかな開始Lv（弟子の弱め）＝両者の良いとこ取り。
        addLineageStats(ch.stats, clamp(Math.floor(mLv / 8) + 1, 1, BLOOD_STAT_CAP + 1), anc.stats);
        const p = clamp(Math.floor(mLv / 8), 0, 5);
        if (p > 0) { addLineageStats(ch.stats, p, anc.stats); ch.level = 1 + p; }
        // 装備の直接相続（散逸せず heir が継ぐ）は web の characterCreation で実装（itemByName 再構成）。
      } else { // pupil
        for (const key of (anc.spells ?? []).slice(0, PUPIL_SPELLS)) learn(key);  // 術4つ自動（多芸・選べない）
        // スタートダッシュ：開始レベル＝1+P＋Pぶんのステを即付与（先代の得意ステ寄せ）。前借り型＝Lv上限では無系譜と同地力。
        const p = clamp(Math.floor(mLv / 6), 0, PUPIL_LEVEL_CAP);
        if (p > 0) { addLineageStats(ch.stats, p, anc.stats); ch.level = 1 + p; }
      }
    }
  }
  world.current = ch;
  chronicle(world, "birth", `${ch.name}（第${world.generation}世代）、迷宮へ降りた。`, [ch.id]);
  return ch;
}

/** 死→化石化→世代交代（§5 ステップ5-7） */
export function fossilizeCurrent(world: World, manner: DeathManner, finalAct: FinalAct): Fossil {
  const ch = world.current;
  if (!ch || !ch.alive) throw new Error("no living character");
  ch.alive = false;
  const bondTotal = ch.bonds.reduce((a, b) => a + b.value, 0);
  const fossil: Fossil = {
    id: newId("fossil"),
    kind: "character",
    origin: {
      name: ch.name, archetype: ch.archetype,
      // 死亡時に握っていた武器を刻む（4-11E：「○○を握った亡霊」。継承で奪還できる痕跡素材）。
      gearTags: [ch.equipment?.weapon?.name ?? defaultGearFor(ch.archetype)],
      catchphrase: finalAct.note,
    },
    death: { manner, finalAct, depth: ch.depth, generationCreated: world.generation },
    exposureAtDeath: ch.exposure,
    bondAtDeath: Math.min(5, 1 + bondTotal), // 自キャラはプレイヤー関与が最大
    tonePole: resolveTonePole(finalAct.choice, manner, bondTotal),
    interventions: [],
    lastTouchedGeneration: worldTime(world),
    reachedAt: worldTime(world), // 自分が斃れた地点＝到達済み＝即・変質クロック開始（4-14G 層1）
    laidDepth: ch.depth,
    spells: [...ch.spells], // 系譜継承（4-11F②）：覚えていた術を化石に遺す＝次代の血/弟子に滲む
    level: ch.level,        // 系譜の継承量の基準（血縁のベース加算／弟子の開始レベル）
    stats: { ...ch.stats }, // 配分を先代の得意ステに寄せるため死亡時のステ分布を遺す
  };
  world.fossils.push(fossil);
  chronicle(world, "death",
    `${ch.name}、深度${ch.depth}で斃れる。（${finalActLabel(finalAct.choice)} → ${poleLabel(fossil.tonePole)}へ）`,
    [fossil.id]);
  // 生者→化石ループ（4-14・b）：自分が斃れた代に、縁を結んだ仲間も一人、深みで還らぬことがある。
  maybeFossilizeBondedActor(world, ch);
  world.generation += 1;
  world.current = null;
  // 自宅の保管庫は世代を越えて残るが、遺せるのは各 STASH_INHERIT 枠まで（残りは歳月とともに失われる）。
  // 貴族街の館（4-14G 層4）に格上げ済みなら相続枠が広がる（家が栄えるほど多くを次代へ遺せる）。
  const inheritCap = world.manorUnlocked ? STASH_INHERIT_MANOR : STASH_INHERIT;
  if (Array.isArray(world.stash) && world.stash.length > inheritCap) world.stash = world.stash.slice(0, inheritCap);
  if (Array.isArray(world.stashGear) && world.stashGear.length > inheritCap) world.stashGear = world.stashGear.slice(0, inheritCap);
  // 運命の弧（4-6）：世代がひとつビートを刻む＝目を離した隙に tracked の弧が進む。
  advanceArcs(world);
  return fossil;
}

/** 退隠＝襲名（4-14G・層2）：死でなく、街で自ら家督を次代に譲る。世代を1つ進めるが、
 *  亡骸は残さず（`retired`＝迷宮遭遇から除外）、先代は「引退した英雄」（retire 弧の守護者NPC）として街に残る。
 *  系譜記録（level/stats/spells/装備＋功績）を遺し、heir が襲名すると功績比例の手厚い継承を受ける。
 *  装備名は origin.gearTags に積む（web が itemByName で復元し heir に直接相続）。 */
export function retireCurrent(world: World): Fossil {
  const ch = world.current;
  if (!ch || !ch.alive) throw new Error("no living character");
  ch.alive = false;
  const depth = Math.max(ch.depth, ch.level); // 街では ch.depth=0＝Lv を深度プロキシに（Lv≈深度・到達の目安）
  const eq = ch.equipment ?? ({} as Character["equipment"]);
  const gearNames = [eq?.weapon?.name, eq?.armor?.name, eq?.relic?.name].filter((n): n is string => !!n);
  const fossil: Fossil = {
    id: newId("fossil"),
    kind: "character",
    origin: {
      name: ch.name, archetype: ch.archetype,
      gearTags: gearNames.length ? gearNames : [defaultGearFor(ch.archetype)], // 退隠＝装備をそのまま heir へ渡す相続目録
      catchphrase: undefined,
    },
    death: { manner: "noble", finalAct: { choice: "guard_relic" }, depth, generationCreated: world.generation },
    exposureAtDeath: ch.exposure,
    bondAtDeath: Math.min(5, 1 + ch.bonds.reduce((a, b) => a + b.value, 0)),
    tonePole: "myth",                 // 退隠＝伝説として退く（legend）
    interventions: [],
    lastTouchedGeneration: worldTime(world),
    reachedAt: worldTime(world),      // 退隠＝到達済み（遭遇除外なので実質未使用だが整合のため）
    laidDepth: depth,
    spells: [...ch.spells],
    level: ch.level,
    stats: { ...ch.stats },
    retired: true,
    achievementAtEnd: worldAchievement(world), // 襲名ボーナスを功績比例にする基準（雪だるま防止）
  };
  world.fossils.push(fossil);
  // 引退した英雄＝retire 弧の終端として記録（refreshRetireGuardians が街角に守護者NPCを置く・再雇用可）。
  (world.tracked ??= []).push({
    id: `retire_${fossil.id}`, name: ch.name, source: "player_legend",
    arcType: "retire", beat: ARC_MAX_BEAT, terminal: true, lastObservedGeneration: world.generation, originRef: fossil.id,
  });
  chronicle(world, "legend",
    `${ch.name}は剣を置き、次代に家督を譲った。その名は伝説として街に残る（Lv${ch.level}まで至った）。`,
    [fossil.id]);
  world.generation += 1;
  world.current = null;
  advanceArcs(world);
  return fossil;
}

/** 相棒の化石化（4-14C）：戦死した相棒を、その絆を刻んだ化石として世界に遺す。
 *  プレイヤー死とは別経路＝世代は進めず world.current も触らない。後世で亡霊/宿敵/伝説として再会する。 */
export function fossilizeCompanion(
  world: World, actor: Actor, opts: { depth: number; exposure: number; bond: number },
): Fossil {
  const manner: DeathManner = "grievous";
  const finalAct: FinalAct = { choice: "accept" };
  const fossil: Fossil = {
    id: newId("fossil"),
    kind: "character",
    origin: {
      name: actor.name, archetype: actor.archetype,
      gearTags: actor.gearTags.length ? actor.gearTags : [defaultGearFor(actor.archetype)],
      catchphrase: actor.catchphrase,
    },
    death: { manner, finalAct, depth: opts.depth, generationCreated: world.generation },
    exposureAtDeath: opts.exposure,
    bondAtDeath: Math.min(5, 1 + opts.bond), // 連れ歩いた相棒＝高関与
    tonePole: resolveTonePole(finalAct.choice, manner, opts.bond),
    interventions: [],
    lastTouchedGeneration: worldTime(world),
    reachedAt: worldTime(world), // 相棒は共に潜行＝到達済み（4-14G 層1）
    laidDepth: opts.depth,
    wasCompanion: true,
  };
  world.fossils.push(fossil);
  chronicle(world, "death",
    `相棒 ${actor.name}、深度${opts.depth}で斃れる。その亡骸に、共に歩いた日々が刻まれた。`,
    [fossil.id]);
  return fossil;
}

/** 見捨て＝怨念を執筆（4-14C・B 救助の裏）：手負いを見殺しにすると、その冒険者は
 *  怨念極（grudge）の化石として遺り、後世で grudge_hunt の宿敵として確実に還る（「宿敵を自分で書く」）。
 *  manner=betrayed / curse_dungeon で tonePole は grudge 固定。bondAtDeath=3 で山場条件（minBond3）を満たす。 */
export function fossilizeAbandoned(
  world: World, actor: Actor, opts: { depth: number },
): Fossil {
  const manner: DeathManner = "betrayed";
  const finalAct: FinalAct = { choice: "curse_dungeon" };
  const fossil: Fossil = {
    id: newId("fossil"),
    kind: "character",
    origin: {
      name: actor.name, archetype: actor.archetype,
      gearTags: actor.gearTags.length ? actor.gearTags : [defaultGearFor(actor.archetype)],
      catchphrase: actor.catchphrase,
    },
    death: { manner, finalAct, depth: opts.depth, generationCreated: world.generation },
    exposureAtDeath: 1.4,                                  // 見捨てられた末の深蝕＝怨念へ
    bondAtDeath: 3,                                        // 裏切りの因縁＝山場（宿敵狩り）を確実に呼ぶ
    tonePole: resolveTonePole(finalAct.choice, manner, 0), // → grudge
    interventions: [],
    lastTouchedGeneration: worldTime(world),
    reachedAt: worldTime(world), // 見捨てた地点＝到達済み（4-14G 層1）
    laidDepth: opts.depth,
    wasCompanion: true,
  };
  world.fossils.push(fossil);
  // 堕ちゆく弧（4-6D・fall の源）：見捨てられた相棒は、世代を越えて「堕ちていく」弧を辿る
  // ＝栄光の影→孤立→成れの果て、を又聞き（年代記/酒場の噂）で拾わせ、終端で宿敵として深みに巣食う。
  // 既存の grudge 化石を originRef に結ぶ＝終端で別途 mint しない（fossilizeTracked は originRef 有りで skip・
  // grudge_hunt にそのまま合流）。advanceArcs が世代交代ごとに fall ビートを1段刻む（1世代1ビート）。
  (world.tracked ??= []).push({
    id: `nemesis_${fossil.id}`, name: actor.name, source: "nemesis",
    arcType: "fall", beat: 0, lastObservedGeneration: world.generation, originRef: fossil.id,
  });
  chronicle(world, "death",
    `${actor.name}を深度${opts.depth}に見捨てた。その怨みは、いつか宿敵となって還るだろう。`,
    [fossil.id]);
  return fossil;
}

// ---------- 生者→化石ループ（4-14・b：縁を結んだ相手だけが、後で化石になって還る） ----------
/** 縁ある生者がいる世代に、誰か一人が深みで還らぬ確率（0〜1体/世代）。 */
const BONDED_FALL_CHANCE = 0.5;
/** 等級(0-4)→倒れた深度の基準（高位ほど深部で果てる）。±3 のばらつきを足す。 */
const BONDED_FALL_DEPTH = [5, 10, 16, 24, 33];

/** 文字列→[0,1) の決定論ハッシュ（FNV-1a・Date/Math.random 不使用＝再現性／stress-save・determinism 安全）。 */
function hashUnit(s: string): number {
  let h = 0x811c9dc5 >>> 0;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return (h >>> 0) / 0x100000000;
}

/** 縁を結んだ生者NPC（world.actors）を、深みで還らなかった化石として遺す（4-14・b）。
 *  相棒(fossilizeCompanion)・見捨て(fossilizeAbandoned)とは別経路＝「街/迷宮で会い、絆を結んだ末に
 *  自分の知らぬ所で力尽きた仲間」。後世で「会った相手だと分かる」一言つきで再発見される（wasAlly）。 */
export function fossilizeBondedActor(
  world: World, actor: Actor,
  opts: { depth: number; tone: TonePole; manner: DeathManner; finalAct: FinalActChoice; exposure: number; bond: number },
): Fossil {
  const fossil: Fossil = {
    id: newId("fossil"),
    kind: "character",
    origin: {
      name: actor.name, archetype: actor.archetype,
      gearTags: actor.gearTags.length ? actor.gearTags : [defaultGearFor(actor.archetype)],
      catchphrase: actor.catchphrase, epithet: actor.epithet,
    },
    death: { manner: opts.manner, finalAct: { choice: opts.finalAct }, depth: opts.depth, generationCreated: world.generation },
    exposureAtDeath: opts.exposure,
    bondAtDeath: Math.min(5, 1 + opts.bond),
    tonePole: opts.tone,
    interventions: [],
    lastTouchedGeneration: worldTime(world),
    laidDepth: opts.depth,
    wasAlly: true,
    frontierHeld: true, // 縁ある者が果てた深度＝プレイヤー未到達でありうる＝到達まで変質を凍結（4-14G 層1①）
  };
  world.fossils.push(fossil);
  chronicle(world, "death",
    `${actor.name}が深度${opts.depth}で還らなかったと、戻った者が告げた。縁を結んだ顔が、またひとつ深みに。`,
    [fossil.id]);
  return fossil;
}

/** 縁を結んだ生者を最大1体だけ化石化する（4-14・b／4-14G 層1）。
 *  対象＝現在の代が bond(value≥1) を持ち、まだ生者として残り（world.actors）、未だ化石でない者。
 *  決定論＝seed×worldTime×tag のハッシュ（rng 非依存）。worldTime 基準ゆえ世代交代でも世界ビートでも別判定。
 *  呼び元＝①fossilizeCurrent（死の世代交代の直前）②worldBeat（深部での営みで世界が老ける節目・4-14G 層1）。
 *  tag で①②を区別＝同 worldTime で二重に同じ抽選をしない。極は多くが喪失、高位は神話、稀に怨念（4-2）。 */
function maybeFossilizeBondedActor(world: World, ch: Character, tag = "death"): string | null {
  const actors = world.actors ?? [];
  if (actors.length === 0) return null;
  const byId = new Map(actors.map((a) => [a.id, a]));
  const deadNames = new Set(world.fossils.map((f) => f.origin.name));
  const candidates = ch.bonds
    .filter((b) => b.value >= 1)
    .map((b) => byId.get(b.entityRef))
    .filter((a): a is LivingActor => !!a && !deadNames.has(a.actor.name));
  if (candidates.length === 0) return null;
  const base = `${world.seed}|${worldTime(world)}|${tag}|bondfall`;
  if (hashUnit(base) >= BONDED_FALL_CHANCE) return null;         // この節目は全員生還
  const fallen = candidates[Math.floor(hashUnit(base + "|who") * candidates.length) % candidates.length];
  const grade = Math.max(0, Math.min(4, fallen.grade ?? fallen.actor.grade ?? 0));
  const depth = Math.max(2, Math.min(38, BONDED_FALL_DEPTH[grade] + Math.floor(hashUnit(base + "|d") * 7) - 3));
  const tr = hashUnit(base + "|tone");
  // 高位は神話として果て、稀に怨念、多くは静かな喪失（4-2）。継承可（guard_relic/leave_will）を喪失/神話に寄せる。
  const m = grade >= 3 && tr < 0.5
    ? { tone: "myth" as TonePole, manner: "noble" as DeathManner, finalAct: "guard_relic" as FinalActChoice, exposure: 0.6 }
    : tr < 0.18
      ? { tone: "grudge" as TonePole, manner: "grievous" as DeathManner, finalAct: "curse_dungeon" as FinalActChoice, exposure: 1.5 }
      : { tone: "loss" as TonePole, manner: "grievous" as DeathManner, finalAct: "leave_will" as FinalActChoice, exposure: 0.7 };
  const bondVal = ch.bonds.find((b) => b.entityRef === fallen.id)?.value ?? 1;
  fossilizeBondedActor(world, fallen.actor, { depth, ...m, bond: bondVal });
  world.actors = actors.filter((a) => a.id !== fallen.id);       // 生者から除く（街での生存と矛盾させない）
  return fallen.actor.name;
}

// ---------- 世界クロック（4-14G・層1：死を回避する熟練者でも、深部での営みで世界が老ける） ----------
const WORLD_SHALLOW = 8;     // これ以浅の周回ではクロックは進まない（序盤の低層往復を除外＝ユーザー要件）
const WORLD_TICK_DIV = 90;   // 深度→1生還あたりの加算の除数（大きいほど世界はゆっくり＝Bでは層1は脇役）
const WORLD_TICK_CAP = 0.6;  // 1生還あたりの加算上限（超深度の一撃でビートを一気に飛ばさない）

/** 生還1回ぶんの世界クロック加算＝最深到達の深度積分（浅層は0）。snapshot 4-1「歪み＝深度×時間」と同形。 */
export function worldTickGain(maxDepth: number): number {
  return Math.min(WORLD_TICK_CAP, Math.max(0, (maxDepth - WORLD_SHALLOW) / WORLD_TICK_DIV));
}

/** フロンティア相対（4-14G 層1①）：到達した深度までの frontierHeld 化石に reachedAt を刻む
 *  ＝「まず出会わせてから、放置すれば歪む」。enterFloor（潜行中の各階）から呼ぶ。冪等。 */
export function stampReached(world: World, depth: number): void {
  const now = worldTime(world);
  for (const f of world.fossils) {
    if (f.frontierHeld && f.reachedAt === undefined && f.laidDepth <= depth + 3) f.reachedAt = now;
  }
}

/** 世界ビート（4-14G 層1）：eraBeats を1進め、弧を前進させ、縁ある生者の脱落を抽選する。
 *  返り値＝この節目で深みに還った縁者の名（web が「お前が生き延びる間に…」と喪失を可視化する）。 */
function worldBeat(world: World): string | null {
  world.eraBeats = (world.eraBeats ?? 0) + 1;
  advanceArcs(world);                                   // worldTime が進む＝弧が1ビート前進（doom 終端の化石化等も）
  const ch = world.current;
  return ch && ch.alive ? maybeFossilizeBondedActor(world, ch, `era${world.eraBeats}`) : null;
}

/** 生還時に世界クロックを進める（4-14G 層1）。最深到達 maxDepth を深度積分でアキュムレータに足し、
 *  1を超えるごとに世界ビートを発火（最大2/生還＝暴発防止）。返り値＝発火ビート数と、還った縁者の名の配列。
 *  浅層(≤8)の周回では gain=0＝1ミリも進まない（低層farmは世界を老けさせない）。 */
export function accrueWorldClock(world: World, maxDepth: number): { beats: number; fell: string[] } {
  const gain = worldTickGain(maxDepth);
  world.eraClock = (world.eraClock ?? 0) + gain;
  const fell: string[] = [];
  let beats = 0;
  while (world.eraClock >= 1 && beats < 2) {            // 1生還で最大2ビート（超深度の積み上がりを緩やかに放出）
    world.eraClock -= 1;
    const name = worldBeat(world);
    if (name) fell.push(name);
    beats++;
  }
  return { beats, fell };
}

// ---------- 長尺アーク（4-12(I)：進行度クオリティで多段の弧を組む。世界スコープ） ----------
/** 進行中（未完）の弧を引く。done 済みや未開始は undefined 扱い。 */
export function getArc(world: World, key: string): ArcState | undefined {
  const a = (world.arcs ?? []).find((x) => x.key === key);
  return a && !a.done ? a : undefined;
}
/** 弧を開始/前進/分岐記録/完了する（Effect.arc から呼ぶ）。pick は上書きせず引き継ぐ。 */
export function setArc(world: World, e: ArcEffect): void {
  (world.arcs ??= []);
  const a = world.arcs.find((x) => x.key === e.key);
  if (a) {
    a.step = e.step;
    if (e.pick !== undefined) a.pick = e.pick;
    if (e.actorRef !== undefined) a.actorRef = e.actorRef; // 特定NPCに戻る弧のアンカー
    if (e.done) a.done = true;
  } else world.arcs.push({ key: e.key, step: e.step, pick: e.pick, actorRef: e.actorRef, done: e.done });
}

// ---------- 運命の弧（4-6B：tracked が世代をビートに辿る原型的軌道。M3 第一スライス） ----------
/** 弧の段数（一律3段＝終端）。後で arcType ごとに変えられる。 */
export const ARC_MAX_BEAT = 3;
/** 法則順守（4-2）：warp がこの値に達した tracked は、終端で破滅側へ歪んだ末路をたどる。
 *  2.5＝「両極は稀に保つ」（4-2）に寄せた閾値＝平穏が既定・深く放置/掻き乱した少数のみ warped。 */
const ARC_DRIFT_WARP = 2.5;

/** 弧の段ごとの年代記行（伝聞＝又聞きで「目を離した隙に世界が動いた」を必ず拾わせる）。
 *  beat 1..3。warped は終端(beat3)の歪み分岐のみ差し替える。#name# に tracked.name を差す。 */
const ARC_BEAT_LINE: Record<TrackedEntity["arcType"], { normal: string[]; warped: string }> = {
  doom: {
    normal: [
      "#name#が、また深みへ降りていったらしい。何かに憑かれたように。",
      "#name#の様子がおかしいと、戻った者が囁く。あの目は、もう人のものじゃない。",
      "#name#は、ついに還らなかった。深みが、英雄をひとつ呑んだのだ。",
    ],
    warped: "#name#は、ついに還らなかった。深みが、英雄をひとつ呑んだのだ。",
  },
  retire: {
    normal: [
      "#name#が一線を退くそうだ。潮時を心得た、いい引き際だと皆が言う。",
      "#name#が街の後進を導いていると聞く。剣を置いた手が、今は若い者の肩にある。",
      "#name#の名は、もう伝説として語られる。生きてその声を聞ける者は、幸運だ。",
    ],
    warped: "#name#は引退できなかった。深みの誘いに抗えず、その姿は二度と街に戻らなかった。",
  },
  fall: {
    normal: [
      "#name#の名声は今が絶頂だ。だが、その慢心を危ぶむ声もある。",
      "#name#が仲間を失い、独りで深層に挑んでいるという。もう誰も止められない。",
      "#name#は変わり果てた。かつての英雄は今や、出会う者を災いと見なすらしい。",
    ],
    warped: "#name#は墜ちるのも早かった。怨嗟だけを残し、宿敵として深みに巣食っている。",
  },
  lore_drift: {
    normal: [
      "#name#の武勇伝、語る者によって少しずつ食い違ってきたな。",
      "#name#の逸話に、別の誰かの手柄が混じり始めている。もう誰も正せない。",
      "#name#という名は、もはや誰のものとも知れぬ。伝説だけが、独り歩きしている。",
    ],
    warped: "#name#の物語は完全に変質した。原型は失われ、別人の伝説とすり替わってしまった。",
  },
};

/** 弧を経過した世界時間ぶん前進させる（世代交代＝fossilizeCurrent／世界ビート＝worldBeat の両方から呼ぶ）。
 *  「進んだことになる」を実際に beat へ反映し、節目で年代記に伝聞を1行刻む（lazy の解決＝観測点）。
 *  ★4-14G 層1：基準を generation→worldTime に（死だけでなく深部での営みでも弧が進む）。
 *  CLI/demo/golden は eraBeats=0 ゆえ worldTime==generation＝従来と完全一致。
 *  純ロジック（content/render 非依存）：豊かな酒場フレーバは render.ts renderArcBeat 側が担う。 */
export function advanceArcs(world: World): void {
  const now = worldTime(world);
  for (const t of world.tracked) {
    if (t.terminal) continue;                              // 終端済みは動かない
    if (now <= t.lastObservedGeneration) continue;         // この時点は反映済み（防御的）
    const gens = now - t.lastObservedGeneration;           // 経過した世界時間（通常1）
    t.lastObservedGeneration = now;
    // 4-1 主クロック：放置（時間×深度）の連続積分で warp を進める（深いほど速い＝理が緩い）。
    if (t.originRef) {
      const f = world.fossils.find((x) => x.id === t.originRef);
      if (f) t.drift = Math.max(0, (t.drift ?? 0) + warpRate(f.laidDepth) * gens);
    }
    t.beat = Math.min(ARC_MAX_BEAT, (t.beat ?? 0) + 1);    // 1世代1ビート
    const table = ARC_BEAT_LINE[t.arcType];
    const warped = (t.drift ?? 0) >= ARC_DRIFT_WARP;
    let line: string;
    if (t.beat >= ARC_MAX_BEAT) {                          // 終端＝帰結を1度だけ刻む
      t.terminal = true;
      if (warped) t.pick = "warped";
      line = warped ? table.warped : table.normal[ARC_MAX_BEAT - 1];
      if (t.arcType === "doom") fossilizeTracked(world, t); // 成れの果ての化石を遺す（深層で再会＝噂で聞いた英雄との落差・4-6D）
    } else {
      line = table.normal[t.beat - 1] ?? table.normal[table.normal.length - 1];
    }
    const refs = t.originRef ? [t.id, t.originRef] : [t.id];
    chronicle(world, t.terminal ? "legend" : "rumor", line.replace(/#name#/g, t.name), refs);
  }
}

/** doom 終端の実体化（4-6D：破滅の弧の終端で「成れの果て」の化石が遺る＝既存パイプライン合流）。
 *  originRef を持たない tracked（seeded＝化石なし）に、深層で再会できる怨念極の化石を mint し逆参照を結ぶ。
 *  噂で「英雄」と聞いた相手を、迷宮で歪んだ化石として再発見する落差を生む（既存 rollEncounter / fossilScene に合流）。 */
function fossilizeTracked(world: World, t: TrackedEntity): void {
  if (t.originRef) return; // 既に化石を持つ（player_legend 等）＝二重生成しない
  const depth = ARC_DRIFT_DEPTH; // 深層（28）に眠る＝深く潜った者だけが「成れの果て」に出会う
  const fossil: Fossil = {
    id: newId("fossil"),
    kind: "explorer",
    origin: {
      name: t.name, archetype: "wanderer",
      gearTags: ["錆びついた誓いの徽章"],
      catchphrase: "……まだ、戻れない",
    },
    death: { manner: "grievous", finalAct: { choice: "curse_dungeon" }, depth, generationCreated: world.generation },
    exposureAtDeath: 1.6, bondAtDeath: 0, tonePole: "grudge",
    interventions: [], lastTouchedGeneration: worldTime(world), laidDepth: depth,
    frontierHeld: true, // 成れの果て＝深層28＝到達まで変質を凍結（4-14G 層1①）
  };
  world.fossils.push(fossil);
  t.originRef = fossil.id;
}

/** 4-1 変質の時間軸＝「歪み = 深度 × 時間」の連続積分。
 *  ・主クロック（放置）＝世代交代ごとに warpRate(laidDepth)×経過世代 を累積（深いほど速い＝理が緩い）。
 *  ・関与の微加（ハイブリッド）＝深層の原型との再会で warp を僅かに進める。
 *  ・干渉（鎮魂/継承/供養）＝時計を巻き戻す＝warp を減算（4-1C「放置こそ変質を進め、干渉で止まる」）。
 *  warp（＝`drift` フィールド・連続値）が閾値に達すると終端が破滅側（warped）へ寄る。 */
const ARC_DRIFT_DEPTH = 28;        // 成れの果ての化石を眠らせる深度（fossilizeTracked 用・新 deep 帯25-37 に整合。旧18は新スケールで浅すぎ）
const WARP_DEPTH_MIN = 12;         // これより浅い laidDepth は理が固く、放置でも歪まない
const WARP_RATE_DIV = 30;          // 深度→「世代あたり warp 速度」の除数（深いほど速い・大きいほど緩い）
const WARP_RATE_CAP = 1.25;        // 世代あたり warp 速度の上限
const WARP_ENGAGE = 0.5;           // 非-干渉の再会で warp を微加（ハイブリッド：関与も深みを掻き乱す）
const WARP_INTERVENE_HEAL = 1.0;   // 干渉（鎮魂/継承/供養）で巻き戻す warp 量（4-1C）
/** 放置の連続積分レート（世代あたり）＝深いほど速い。WARP_DEPTH_MIN 以浅は 0。 */
function warpRate(depth: number): number {
  return Math.max(0, Math.min(WARP_RATE_CAP, (depth - WARP_DEPTH_MIN) / WARP_RATE_DIV));
}
/** 深層(laidDepth>=WARP_DEPTH_MIN)の原型化石を originRef に持つ未終端 tracked の warp を amount だけ動かす（0で床）。
 *  関与＝正（再会で微加）／干渉＝負（巻き戻し）。seeded は originRef を持たず影響を受けない。 */
export function accrueArcWarp(world: World, fossilId: string, amount: number): void {
  const fossil = world.fossils.find((f) => f.id === fossilId);
  if (!fossil || fossil.laidDepth < WARP_DEPTH_MIN) return;
  for (const t of world.tracked) {
    if (t.originRef === fossilId && !t.terminal) t.drift = Math.max(0, (t.drift ?? 0) + amount);
  }
}

/** 干渉（鎮魂/継承/供養）：変質クロックをリセットし、因縁を閉じる（4-1C / 4-2） */
export function intervene(world: World, fossilId: string, type: "requiem" | "inherit" | "memorial"): void {
  const fossil = world.fossils.find((f) => f.id === fossilId);
  if (!fossil) throw new Error("fossil not found");
  fossil.interventions.push({ type, generation: world.generation });
  fossil.lastTouchedGeneration = worldTime(world); // 時計のリセット（worldTime 基準・4-14G 層1）
  // 継承＝未完の目的を負う／鎮魂・供養＝因縁を閉じる（4-12B）
  const opensObligation = type === "inherit";
  const ch = world.current;
  if (ch) {
    const bond = ch.bonds.find((b) => b.entityRef === fossilId);
    if (bond) bond.unfinished = opensObligation;
    else ch.bonds.push({ entityRef: fossilId, value: 1, unfinished: opensObligation });
  }
  const label = type === "requiem" ? "鎮魂した" : type === "inherit" ? "遺志を継いだ" : "供養した";
  const bondNote = opensObligation ? "（未完の目的を負った）" : "（因縁を閉じた）";
  chronicle(world, "intervention",
    `${world.current?.name ?? "誰か"}が${fossilOriginName(world, fossilId)}を${label}。${bondNote}`,
    [fossilId]);
  // 奉献の試練・印②：因縁（怨念極の化石）を鎮魂（4-13A）。鎮魂の全経路（慰霊堂/戦闘/遭遇）を捕捉。
  if (type === "requiem" && fossil.tonePole === "grudge") awardSeal(world, "requiem", [fossilId]);
  accrueArcWarp(world, fossilId, -WARP_INTERVENE_HEAL); // 4-1C：干渉＝時計を巻き戻す＝warp を減算（弧を守る）
}

// ---------- 残響召喚の遺灰（4-10I・snapshot 524：鎮魂＝種／Elden Ring 遺灰型） ----------

/** 残響の遺灰を展開するときの代償＝深蝕＋（乱用を抑える＝snapshot「稀・代償つき」）。 */
export const ECHO_DEPLOY_COST = 0.3;

/** 鎮魂による残響召喚の種付与（4-10I）。**必ず intervene(world, fossil.id, "requiem") の後に呼ぶ**
 *  （requiem が interventions に push 済み＝初回なら requiem は1件）。
 *  神話極の化石の初回鎮魂のみ「残響の遺灰」を1つ得る（farm 防止＝1化石1遺灰・世代越え再鎮魂で増えない）。
 *  威力は鎮魂時の深度をスナップショット。条件を満たさなければ何もせず null。 */
export function grantEchoOnRequiem(world: World, fossil: Fossil, depth: number): EchoAsh | null {
  const firstRequiem = fossil.interventions.filter((iv) => iv.type === "requiem").length === 1;
  if (fossil.tonePole !== "myth" || !firstRequiem) return null;
  const echoDmg = Math.max(5, Math.round(4 + depth * 0.7));
  const ash: EchoAsh = { fossilId: fossil.id, name: fossil.origin.name, dmg: echoDmg };
  (world.echoes ??= []).push(ash);
  return ash;
}

/** 残響の遺灰を1つ消費（4-10I）。index の遺灰を取り出し、展開の代償（深蝕＋ECHO_DEPLOY_COST）を ch に適用して返す。
 *  範囲外/空なら null（副作用なし）。盤面への召喚展開・音・手番消費は呼び出し側（web/main.ts deployEcho）が担う。 */
export function consumeEcho(world: World, ch: Character, index: number): EchoAsh | null {
  const echoes = world.echoes ?? [];
  if (index < 0 || index >= echoes.length) return null;
  const [ash] = echoes.splice(index, 1);
  ch.exposure += ECHO_DEPLOY_COST;
  return ash;
}

export function recordRediscovery(world: World, fossilId: string): void {
  chronicle(world, "rediscovery",
    `${world.current?.name ?? "誰か"}が、${fossilOriginName(world, fossilId)}の成れの果てと出会った。`,
    [fossilId]);
  const ch = world.current;
  if (ch) {
    const bond = ch.bonds.find((b) => b.entityRef === fossilId);
    if (bond) bond.value += 1;
    else ch.bonds.push({ entityRef: fossilId, value: 1, unfinished: false });
  }
  // フロンティア相対（4-14G 層1①）：出会った＝到達した＝以後は変質クロックが動き出す。
  const f = world.fossils.find((x) => x.id === fossilId);
  if (f && f.frontierHeld && f.reachedAt === undefined) f.reachedAt = worldTime(world);
  accrueArcWarp(world, fossilId, WARP_ENGAGE); // ハイブリッド：深層の原型との再会も warp を微かに進める（4-6 法則順守）
}

export function chronicle(world: World, kind: ChronicleEntry["kind"], text: string, refs: string[]): void {
  world.chronicle.push({ generation: world.generation, kind, text, refs });
}

// ---- 奉献の試練：印（4-13A） ----
/** 印を1つ授与（冪等：既に持つ印は何もしない）。新規に得た時だけ true＋年代記に刻む。 */
export function awardSeal(world: World, key: SealKey, refs: string[] = []): boolean {
  if (!Array.isArray(world.seals)) world.seals = [];
  if (world.seals.includes(key)) return false;
  world.seals.push(key);
  const got = world.seals.length;
  chronicle(world, "legend",
    `${world.current?.name ?? "誰か"}が「${SEAL_LABEL[key]}」の印を得た。（奉献の試練 ${got}/${SEAL_KEYS.length}）`,
    refs);
  if (got === SEAL_KEYS.length) {
    chronicle(world, "legend",
      "五つの印が揃った。封じられた深淵帯への道が、街の門の奥に口を開ける。", []);
  }
  return true;
}
/** 印が5種揃い、深淵帯が解錠されているか。 */
export function abyssUnlocked(world: World): boolean {
  return (world.seals?.length ?? 0) >= SEAL_KEYS.length;
}

// ---- 表示用ヘルパ ----
export function poleLabel(p: Fossil["tonePole"]): string {
  return p === "loss" ? "喪失" : p === "myth" ? "神話" : "怨念";
}
export function finalActLabel(c: FinalAct["choice"]): string {
  switch (c) {
    case "guard_relic": return "遺品を抱いて守った";
    case "curse_dungeon": return "迷宮を呪った";
    case "leave_will": return "遺言を遺した";
    case "accept": return "静かに受け入れた";
  }
}
function fossilOriginName(world: World, id: string): string {
  return world.fossils.find((f) => f.id === id)?.origin.name ?? "名も無き者";
}
function defaultGearFor(archetype: string): string {
  switch (archetype) {
    case "swordman": return "片刃の剣";
    case "scout": return "革張りの短弓";
    case "sage": return "綴じ紐の手帳";
    default: return "使い込まれた背嚢";
  }
}

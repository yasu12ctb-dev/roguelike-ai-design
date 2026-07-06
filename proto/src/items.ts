// 装備アイテム（4-11F④・4-11E）。武器=攻撃+ / 防具=被ダメ- / 遺物=パッシブ。異物=未鑑定。
// ★ルートシステム（H&S 収集）＝3要素モデル「銘(affix) × 基(base) × 強化(+N)」。
//   値は fromTemplate で最終値に焼き込む＝progression.ts / itemValue は無改修で自動波及（二重計算しない）。
// 効果の適用は progression.ts（派生値）と web/main.ts（盤面）。ここは定義と抽選・表示のみ。

import type { Rng } from "./rng.ts";
import type { Character, Item, ItemSlot } from "./types.ts";

/** 消耗品を1つ持ち物へ（純粋）。同種はスタック／空き枠（capacity）が無ければ false。
 *  web の addConsumable と同じ規則＝イベント報酬（Effect.item）から呼べるよう切り出した。 */
export function grantConsumable(ch: Character, key: string, capacity: number): boolean {
  ch.inventory ??= [];
  const slot = ch.inventory.find((s) => s.key === key);
  if (slot) { slot.qty += 1; return true; }
  if (ch.inventory.length >= capacity) return false;
  ch.inventory.push({ key, qty: 1 });
  return true;
}

// ---------- 基(base)＝テンプレ ----------
interface Template {
  slot: ItemSlot; name: string; minDepth: number;
  dmg?: number; reduce?: number; relic?: Item["relic"]; proc?: Item["proc"]; capacity?: number; reach?: number; exposurePerTurn?: number;
  oddity?: boolean; // 異物（必ず未鑑定）
  exclusive?: boolean; // 秘宝＝通常の宝箱/討伐/店頭抽選には出さない。深層レアドロップ／統治者の大命の褒賞でのみ入手（2026-07-03）。
}

// 実装の正。新装備はここに足すだけで宝箱/ボスドロップに乗る（銘・+N は自動で付与される）。
const TEMPLATES: Template[] = [
  // 武器（攻撃+）
  { slot: "weapon", name: "短刀",     minDepth: 1,  dmg: 1 },
  { slot: "weapon", name: "手斧",     minDepth: 2,  dmg: 1 },
  { slot: "weapon", name: "長剣",     minDepth: 4,  dmg: 2 },
  { slot: "weapon", name: "曲刀",     minDepth: 6,  dmg: 2 },
  { slot: "weapon", name: "刺突槍",   minDepth: 8,  dmg: 2, reach: 2 }, // 槍＝十字直線・貫通・斜め不可・踏み込み不可（reach:2）
  { slot: "weapon", name: "戦鎚",     minDepth: 11, dmg: 3 },
  { slot: "weapon", name: "大剣",     minDepth: 13, dmg: 3 },
  { slot: "weapon", name: "双刃",     minDepth: 18, dmg: 4 },
  { slot: "weapon", name: "深淵の刃", minDepth: 16, dmg: 4, exposurePerTurn: 0.02, oddity: true },
  // 発動効果つき武器（物量レビュー PR4・2026-06-28）：武器に初の「挙動差」。命中時に proc が発動（web 適用）。
  { slot: "weapon", name: "鋸刃刀",   minDepth: 7,  dmg: 2, proc: "rend" },   // 裂傷＝継続ダメ
  { slot: "weapon", name: "戦斧",     minDepth: 9,  dmg: 3, proc: "cleave" }, // 薙ぎ＝隣接にも余波
  { slot: "weapon", name: "鎖星",     minDepth: 12, dmg: 3, proc: "stun" },   // 当て止め（一定確率）
  { slot: "weapon", name: "萎えの槍", minDepth: 15, dmg: 2, reach: 2, proc: "sap" }, // 槍（reach:2）＋弱体。dmg 3→2＝槍の−1ペナルティに整合（proc が補償）
  { slot: "weapon", name: "断界刃",   minDepth: 22, dmg: 4, proc: "cleave" }, // 深層の薙ぎ（大）
  // ── 武器クラス〈槍〉（reach:2・v0.124.0・2026-07-06 ユーザー承認）＝十字4方向・射程2・直線貫通・斜め不可・踏み込み不可。
  //    攻撃力は同深度の剣より −1 目安（間合いと地形のチョークで真価／開所では弱い＝剣との二択）。
  { slot: "weapon", name: "木槍",     minDepth: 2,  dmg: 1, reach: 2 }, // 序盤から槍を試せる入口
  { slot: "weapon", name: "長槍",     minDepth: 12, dmg: 2, reach: 2 }, // 同深度の剣 鎖星/大剣=3 の −1
  { slot: "weapon", name: "十文字槍", minDepth: 19, dmg: 3, reach: 2 }, // 同深度の剣 双刃=4 の −1
  { slot: "weapon", name: "大身槍",   minDepth: 25, dmg: 3, reach: 2, proc: "rend" }, // 深層＝幅広の穂先が裂傷を刻む（断界刃=4 の −1・proc が補償）
  { slot: "weapon", name: "淵穿ち",   minDepth: 30, dmg: 4, reach: 2, exposurePerTurn: 0.02, oddity: true }, // 深淵の刃の槍版＝蝕む業物（−1 免除の代償に深蝕+）
  // 防具（被ダメ-）＝武器と同数9種
  { slot: "armor",  name: "革鎧",     minDepth: 1,  reduce: 1 },
  { slot: "armor",  name: "外套",     minDepth: 2,  reduce: 1 },
  { slot: "armor",  name: "胸当て",   minDepth: 3,  reduce: 1 },
  { slot: "armor",  name: "鋲革鎧",   minDepth: 4,  reduce: 1 },
  { slot: "armor",  name: "鎖帷子",   minDepth: 6,  reduce: 2 },
  { slot: "armor",  name: "鱗鎧",     minDepth: 9,  reduce: 2 },
  { slot: "armor",  name: "重鎧",     minDepth: 14, reduce: 3 },
  { slot: "armor",  name: "板金鎧",   minDepth: 17, reduce: 3 },
  { slot: "armor",  name: "全身鎧",   minDepth: 20, reduce: 4 },
  // 発動効果つき防具（2026-07-01）：防具に初の「挙動差」。被弾時に proc が発動（web 適用）。武器14種と対称に 9→14。
  { slot: "armor",  name: "受けの鎧", minDepth: 5,  reduce: 1, proc: "block" },   // 受け＝一定確率で一撃を軽減
  { slot: "armor",  name: "棘鎧",     minDepth: 8,  reduce: 2, proc: "barbs" },   // 棘＝近接被弾の一部を反射
  { slot: "armor",  name: "清めの鎧", minDepth: 10, reduce: 2, proc: "cleanse" }, // 清め＝被弾ごとに深蝕を薄める
  { slot: "armor",  name: "威圧の鎧", minDepth: 11, reduce: 2, proc: "daunt" },   // 威圧＝殴った敵を恐慌させる
  { slot: "armor",  name: "怯ませの鎧", minDepth: 13, reduce: 3, proc: "stagger" }, // 怯み＝殴った敵を鈍化させる
  // 遺物（パッシブ：8効果＝calm/reason/greed/might/vigor/ward/fortune/mending）
  { slot: "relic",  name: "静心の護符",   minDepth: 2,  relic: "calm" },     // 深蝕レート減
  { slot: "relic",  name: "理脈の指輪",   minDepth: 4,  relic: "reason" },   // 理+1
  { slot: "relic",  name: "貪欲の徽章",   minDepth: 7,  relic: "greed" },    // 撃破XP×1.5
  { slot: "relic",  name: "不屈の護符",   minDepth: 3,  relic: "vigor" },    // 最大HP+6
  { slot: "relic",  name: "闘魂の小手",   minDepth: 5,  relic: "might" },    // 近接+1
  { slot: "relic",  name: "守護の円環",   minDepth: 6,  relic: "ward" },     // 被ダメ-1
  { slot: "relic",  name: "黄金の指輪",   minDepth: 8,  relic: "fortune" },  // 拾う金貨×1.5
  { slot: "relic",  name: "再生の雫",     minDepth: 10, relic: "mending" },  // 潜行中ゆっくり回復
  { slot: "relic",  name: "巨人の心臓",   minDepth: 13, relic: "vigor" },    // 最大HP+6（深層版）
  { slot: "relic",  name: "棘の護符",     minDepth: 16, relic: "thorns" },   // 反射（旧・鉄壁の徽章 ward 重複を解消＝PR3）
  { slot: "relic",  name: "昏き護符",     minDepth: 12, relic: "reason",  exposurePerTurn: 0.03, oddity: true }, // 理+1（異物）
  { slot: "relic",  name: "餓狼の爪",     minDepth: 15, relic: "siphon",  exposurePerTurn: 0.02, oddity: true }, // 吸命（旧・might 重複を解消＝PR3。強いが蝕む）
  { slot: "relic",  name: "強欲の眼",     minDepth: 16, relic: "greed",   exposurePerTurn: 0.025, oddity: true }, // 撃破XP×1.5（強いが蝕む）
  // 拡充（物量レビュー PR3・2026-06-28）：新5効果の基テンプレ。重複頼みを解消し収集/エンドゲームの幅を広げる。
  { slot: "relic",  name: "茨の指輪",     minDepth: 8,  relic: "thorns" },   // 反射（清い版）
  { slot: "relic",  name: "渇きの杯",     minDepth: 11, relic: "siphon" },   // 吸命（清い版）
  { slot: "relic",  name: "澄心の数珠",   minDepth: 6,  relic: "clarity" },  // 毒・侵蝕の蓄積を半減
  { slot: "relic",  name: "術理の宝珠",   minDepth: 10, relic: "potency" },  // 術ダメージ増
  { slot: "relic",  name: "不死鳥の灰",   minDepth: 18, relic: "revenant" },// 潜行中一度だけ致死を耐える
  // 鞄（持ち物の枠+。持ち物システム Phase2）
  { slot: "bag",    name: "革袋",         minDepth: 1,  capacity: 3 },
  { slot: "bag",    name: "探索者の背嚢", minDepth: 6,  capacity: 5 },
  { slot: "bag",    name: "深淵の嚢",     minDepth: 14, capacity: 8 },
  // ── 秘宝（artifact・2026-07-03・酒場の裏取引を廃止し「深層レアドロップ＋大命褒賞」で入手）──
  // exclusive:true＝通常の宝箱/討伐/店頭抽選には出さない（rollItem/rollItemOfSlot で除外＝golden 不変）。
  // ★攻撃/防御は控えめ・価値は「店に無い特殊効果」に置く＝数値インフレでバランスを崩さない。多くは蝕む。
  // 効果の適用は web（applyWeaponProc/applyArmorProc/relic フック）。深層で真価を発揮する。
  { slot: "weapon", name: "雷鳴の魔剣",   minDepth: 20, dmg: 3, proc: "arc",    exposurePerTurn: 0.02, exclusive: true }, // 連鎖/遠距離
  { slot: "weapon", name: "業炎の魔刀",   minDepth: 20, dmg: 3, proc: "blast",  exposurePerTurn: 0.02, exclusive: true }, // 範囲（半径2）
  { slot: "weapon", name: "貫きの長刀",   minDepth: 20, dmg: 4, proc: "pierce", exclusive: true }, // 直線の遠距離リーチ
  { slot: "weapon", name: "氷結の魔杖",   minDepth: 20, dmg: 2, proc: "freeze", exclusive: true }, // 範囲凍結＋鈍化（無力化）
  { slot: "weapon", name: "吸命の魔剣",   minDepth: 20, dmg: 3, proc: "drain",  exposurePerTurn: 0.02, exclusive: true }, // 魔法吸収（回復）
  { slot: "armor",  name: "反射結界の鎧", minDepth: 20, reduce: 3, proc: "reflectall", exposurePerTurn: 0.02, exclusive: true }, // 近接も遠距離も反射
  { slot: "armor",  name: "虚無の法衣",   minDepth: 20, reduce: 3, proc: "negate", exclusive: true }, // 一定確率で完全無効
  { slot: "armor",  name: "疾風の外套",   minDepth: 20, reduce: 3, proc: "hasten", exclusive: true }, // 進入時ヘイスト
  { slot: "armor",  name: "深淵順応の鎧", minDepth: 20, reduce: 3, proc: "adapt",  exclusive: true }, // 深蝕蓄積を大幅軽減
  { slot: "armor",  name: "贖罪の白鎧",   minDepth: 20, reduce: 3, proc: "purge",  exposurePerTurn: -0.015, exclusive: true }, // 被弾で深蝕を強く祓う
  { slot: "relic",  name: "秘術の宝冠",   minDepth: 20, relic: "spellcrown", exposurePerTurn: 0.02, exclusive: true }, // 術ダメ大幅増＋術コスト減
  { slot: "relic",  name: "転移の護符",   minDepth: 20, relic: "blink",   exclusive: true }, // 致死で安全地帯へ転移（潜行1回）
  { slot: "relic",  name: "時詠みの懐中時計", minDepth: 20, relic: "timeslip", exclusive: true }, // 被弾を低確率で完全回避
  { slot: "relic",  name: "探査の水晶",   minDepth: 20, relic: "farsight", exclusive: true }, // 進入時に地図/宝/化石を開示
  { slot: "relic",  name: "金蔓の指輪",   minDepth: 20, relic: "goldvein", exposurePerTurn: 0.02, exclusive: true }, // 拾う金貨大幅増
];

/** 秘宝（exclusive）の基名一覧（スロット別）。web の深層レアドロップ／大命褒賞が forgeItem で直接出す。 */
export function artifactBaseNames(slot?: ItemSlot): string[] {
  return TEMPLATES.filter((t) => t.exclusive && (!slot || t.slot === slot)).map((t) => t.name);
}

// ---------- 銘(affix)＝品質接辞 ----------
// 深蝕の正負はスロット非依存（蝕=深蝕+・浄=深蝕−・恵=深蝕なし）。命名トーンと exposureAdd の符号が一致。
// 値は fromTemplate で基へ加算（dmgAdd/reduceAdd/capacityAdd）。slots で適用スロットを限定。
type AffixClass = "boon" | "corrupt" | "warding";
export interface Affix {
  key: string; name: string; klass: AffixClass; slots: ItemSlot[]; minDepth: number; weight: number;
  dmgAdd?: number; reduceAdd?: number; capacityAdd?: number; exposureAdd?: number;
}
export const AFFIXES: Affix[] = [
  // ── 恵(boon)：純正の正効果・深蝕なし。フレーバー豊富（リサーチ反映：Diablo の Sharp/Vicious/Glorious 等） ──
  { key: "sharp",    name: "切れ味の良い", klass: "boon", slots: ["weapon"], minDepth: 1,  weight: 8, dmgAdd: 1 },
  { key: "keen",     name: "鋭利な",       klass: "boon", slots: ["weapon"], minDepth: 3,  weight: 7, dmgAdd: 1 },
  { key: "warrior",  name: "戦士の",       klass: "boon", slots: ["weapon"], minDepth: 2,  weight: 6, dmgAdd: 1 },
  { key: "fine",     name: "業物の",       klass: "boon", slots: ["weapon"], minDepth: 8,  weight: 5, dmgAdd: 2 },
  { key: "veteran",  name: "古強者の",     klass: "boon", slots: ["weapon"], minDepth: 10, weight: 4, dmgAdd: 2 },
  { key: "flash",    name: "閃光の",       klass: "boon", slots: ["weapon"], minDepth: 12, weight: 4, dmgAdd: 2 },
  { key: "master",   name: "達人の",       klass: "boon", slots: ["weapon"], minDepth: 14, weight: 3, dmgAdd: 2 },
  { key: "kingly",   name: "王の",         klass: "boon", slots: ["weapon", "armor"], minDepth: 20, weight: 2, dmgAdd: 3, reduceAdd: 1 },
  { key: "divine",   name: "神々の",       klass: "boon", slots: ["weapon", "armor"], minDepth: 24, weight: 2, dmgAdd: 3, reduceAdd: 2 },
  { key: "sturdy",   name: "堅牢な",       klass: "boon", slots: ["armor"],  minDepth: 1,  weight: 8, reduceAdd: 1 },
  { key: "knight",   name: "騎士の",       klass: "boon", slots: ["armor"],  minDepth: 6,  weight: 6, reduceAdd: 1 },
  { key: "warden",   name: "守人の",       klass: "boon", slots: ["armor"],  minDepth: 4,  weight: 6, reduceAdd: 1 },
  { key: "steel",    name: "鋼の",         klass: "boon", slots: ["armor"],  minDepth: 8,  weight: 5, reduceAdd: 1 },
  { key: "heavy",    name: "重厚な",       klass: "boon", slots: ["armor"],  minDepth: 10, weight: 4, reduceAdd: 2 },
  { key: "bulwark",  name: "鉄壁の",       klass: "boon", slots: ["armor"],  minDepth: 16, weight: 3, reduceAdd: 2 },
  { key: "light",    name: "軽量の",       klass: "boon", slots: ["bag"], minDepth: 4, weight: 4, capacityAdd: 2 },
  // ── 蝕(corrupt)：禍々しい銘＝威力大だが深蝕+（別枠の危険クラス・低頻度・未鑑定の賭け） ──
  { key: "hungry",   name: "飢えた",   klass: "corrupt", slots: ["weapon"], minDepth: 6,  weight: 3, dmgAdd: 2, exposureAdd: 0.02 },
  { key: "cursing",  name: "呪詛の",   klass: "corrupt", slots: ["weapon"], minDepth: 9,  weight: 3, dmgAdd: 2, exposureAdd: 0.025 },
  { key: "hellfire", name: "業火の",   klass: "corrupt", slots: ["weapon", "armor"], minDepth: 12, weight: 2, dmgAdd: 3, reduceAdd: 2, exposureAdd: 0.03 },
  { key: "abyssal",  name: "深淵の",   klass: "corrupt", slots: ["weapon"], minDepth: 18, weight: 2, dmgAdd: 3, exposureAdd: 0.03 },
  { key: "devour",   name: "喰らう",   klass: "corrupt", slots: ["armor"],  minDepth: 10, weight: 2, reduceAdd: 2, exposureAdd: 0.03 },  // 効果高いが深蝕を帯びる防具
  { key: "anguish",  name: "痛苦の",   klass: "corrupt", slots: ["armor", "weapon"], minDepth: 8, weight: 3, dmgAdd: 1, reduceAdd: 1, exposureAdd: 0.02 },
  // ── 浄(warding)：聖的な銘＝深蝕−（武器・防具・遺物に跨る・正の対極） ──
  { key: "absolve",  name: "浄罪の",   klass: "warding", slots: ["weapon"], minDepth: 5,  weight: 3, dmgAdd: 1, exposureAdd: -0.015 },  // 深蝕を軽減する武器
  { key: "exorcise", name: "祓いの",   klass: "warding", slots: ["weapon"], minDepth: 9,  weight: 3, dmgAdd: 1, exposureAdd: -0.02 },
  { key: "consecr",  name: "聖別の",   klass: "warding", slots: ["armor"],  minDepth: 5,  weight: 3, reduceAdd: 1, exposureAdd: -0.015 },
  { key: "serene",   name: "静謐な",   klass: "warding", slots: ["armor", "relic"], minDepth: 4, weight: 4, exposureAdd: -0.02 },
  { key: "guarding", name: "守りの",   klass: "warding", slots: ["relic", "armor"], minDepth: 7, weight: 3, reduceAdd: 1, exposureAdd: -0.01 },
];
const AFFIX_BY_KEY = new Map(AFFIXES.map((a) => [a.key, a]));
// 分解復元（itemByName）用＝名前の前方一致は「長い銘から」試す（銘が別の銘の前方部分でも誤爆しない）。
const AFFIXES_BY_LEN = [...AFFIXES].sort((a, b) => b.name.length - a.name.length);

let n = 0;
const iid = () => `it_${(++n).toString(36)}`;
const round3 = (x: number) => Math.round(x * 1000) / 1000; // 深蝕の浮動小数ドリフト回避

/** 強化(+N)の基ステ加算（武器=dmg+N、防具=reduce+ceil(N/2)）。 */
const enchantDmg = (slot: ItemSlot, n: number) => (slot === "weapon" ? n : 0);
const enchantReduce = (slot: ItemSlot, n: number) => (slot === "armor" ? Math.ceil(n / 2) : 0);

/** 基×銘×+N から Item を作る（値はここで最終値に焼く＝二重計算しない）。
 *  銘の加算はスロットに効くものだけ焼く（派生値＝武器dmg/防具reduce/鞄capacity しか読まない＝死に値を作らない）。
 *  exposure はどのスロットでも効く（equipExposure が全スロット合算）。 */
function fromTemplate(t: Template, affix: Affix | null = null, enchant = 0): Item {
  const dmg = (t.dmg ?? 0) + (t.slot === "weapon" ? (affix?.dmgAdd ?? 0) : 0) + enchantDmg(t.slot, enchant);
  const reduce = (t.reduce ?? 0) + (t.slot === "armor" ? (affix?.reduceAdd ?? 0) : 0) + enchantReduce(t.slot, enchant);
  const cap = (t.capacity ?? 0) + (t.slot === "bag" ? (affix?.capacityAdd ?? 0) : 0);
  const exp = round3((t.exposurePerTurn ?? 0) + (affix?.exposureAdd ?? 0));
  const name = `${affix?.name ?? ""}${t.name}${enchant > 0 ? `+${enchant}` : ""}`;
  const item: Item = { id: iid(), slot: t.slot, name, baseName: t.name };
  if (dmg) item.dmg = dmg;
  if (reduce) item.reduce = reduce;
  if (t.relic) item.relic = t.relic;
  if (t.proc) item.proc = t.proc; // 発動効果は基テンプレ由来＝銘/+N と独立（往復で baseName から復元）
  if (t.reach) item.reach = t.reach; // 射程（槍=2）も基テンプレ由来＝銘/+N と独立（proc と同じ流儀）
  if (cap) item.capacity = cap;
  if (exp) item.exposurePerTurn = exp;
  if (affix) item.affix = affix.key;
  if (enchant) item.enchant = enchant;
  return item;
}

/** 基(base)の一覧（名・スロット）。受理テスト（往復一致）や鋳造所量産の足場に使う。 */
export function baseList(): { name: string; slot: ItemSlot }[] {
  return TEMPLATES.map((t) => ({ name: t.name, slot: t.slot }));
}

/** 基名＋銘key＋強化度から Item を再構成（打ち直し・テスト・継承で使う）。基が無ければ null。 */
export function forgeItem(baseName: string, affixKey: string | null, enchant = 0): Item | null {
  const t = TEMPLATES.find((tt) => tt.name === baseName);
  if (!t) return null;
  const a = affixKey ? AFFIX_BY_KEY.get(affixKey) ?? null : null;
  return fromTemplate(t, a, enchant);
}

/** 名前から装備を復元（鑑定済み）。継承で先代の武器を奪還する／化石 gearTags の往復に使う（4-11E）。
 *  合成名「銘＋基＋"+N"」を分解：末尾+Nを剥がし→基単独一致→だめなら既知の銘を長い順に前方一致で剥がす。
 *  テンプレに無い名（聖遺物・既定装備名）なら null（呼び出し側で形質化）。 */
export function itemByName(name: string): Item | null {
  let core = name, enchant = 0;
  const m = name.match(/\+(\d+)$/);
  if (m) { enchant = parseInt(m[1], 10); core = name.slice(0, name.length - m[0].length); }
  // (1) 銘なしで基に一致するか（旧セーブの無銘名もここで復元）
  let t = TEMPLATES.find((tt) => tt.name === core);
  if (t) return fromTemplate(t, null, enchant);
  // (2) 銘を長い順に前方一致で剥がし、残りを基に照合
  for (const a of AFFIXES_BY_LEN) {
    if (!core.startsWith(a.name)) continue;
    const baseName = core.slice(a.name.length);
    const tt = TEMPLATES.find((x) => x.name === baseName && a.slots.includes(x.slot));
    if (tt) return fromTemplate(tt, a, enchant);
  }
  return null;
}

/** 強化(+N)を1段上げた新 Item を返す（武具屋の打ち直し）。武器/防具のみ意味を持つ。失敗で null。 */
export function enchantUp(it: Item): Item | null {
  const baseName = it.baseName ?? null;
  const affixKey = it.affix ?? null;
  const m = it.name.match(/\+(\d+)$/);
  const cur = it.enchant ?? (m ? parseInt(m[1], 10) : 0);
  if (baseName) return forgeItem(baseName, affixKey, cur + 1);
  // 旧 Item（構造フィールド無し）＝名前から復元してから+1
  const re = itemByName(it.name);
  if (!re || !re.baseName) return null;
  return forgeItem(re.baseName, re.affix ?? null, (re.enchant ?? 0) + 1);
}

/** 深度に応じた銘・+N を抽選して付与（rollItem/rollItemOfSlot 共用）。大半は無銘・+0。蝕は低頻度。 */
function rollAffix(slot: ItemSlot, depth: number, rng: Rng, opts: { boss?: boolean } = {}): Affix | null {
  const aChance = Math.min(0.5, 0.15 + depth * 0.02) + (opts.boss ? 0.2 : 0);
  if (rng.next() >= aChance) return null;
  const pool = AFFIXES.filter((a) => a.slots.includes(slot) && a.minDepth <= depth);
  if (!pool.length) return null;
  const total = pool.reduce((s, a) => s + a.weight, 0);
  let r = rng.next() * total;
  for (const a of pool) { r -= a.weight; if (r <= 0) return a; }
  return pool[pool.length - 1];
}
function rollEnchant(slot: ItemSlot, depth: number, rng: Rng, opts: { boss?: boolean } = {}): number {
  if (slot !== "weapon" && slot !== "armor") return 0; // +N は武器/防具のみ
  const eChance = Math.min(0.4, depth * 0.02) + (opts.boss ? 0.15 : 0);
  if (rng.next() >= eChance) return 0;
  return 1 + rng.int(1 + Math.floor(depth / 12) + (opts.boss ? 1 : 0)); // 深いほど高+N
}

// 基抽選の深度加重（H&S＝深いほど上位基が出やすい／浅い基もゼロにはせず変異は残す）。
// minDepth が現在深度に近い基ほど重い。0=従来の均等、大きいほど深度相応へ尖る。深淵帯では
// 基の寄与より銘/+N が支配的ゆえ中庸で足りる（テストプレイ調整候補）。
const BASE_DEPTH_FALLOFF = 0.2;
/** 解禁済み候補 src から、minDepth が現在深度に近い基ほど重く1つ引く（乱数は next() 1回＝均等版と同数）。 */
function pickBaseByDepth(src: Template[], depth: number, rng: Rng): Template {
  let total = 0;
  const w: number[] = new Array(src.length);
  for (let i = 0; i < src.length; i++) {
    const x = 1 / (1 + Math.max(0, depth - src[i].minDepth) * BASE_DEPTH_FALLOFF);
    w[i] = x; total += x;
  }
  let r = rng.next() * total;
  for (let i = 0; i < src.length; i++) { r -= w[i]; if (r <= 0) return src[i]; }
  return src[src.length - 1];
}

/** 深度に応じた装備を1つ抽選（銘・+N 込み）。ボスは上位寄り。蝕や一定確率で異物（未鑑定）。 */
export function rollItem(depth: number, rng: Rng, opts: { boss?: boolean } = {}): Item {
  const avail = TEMPLATES.filter((t) => !t.exclusive && t.minDepth <= depth + (opts.boss ? 5 : 0)); // 秘宝は通常ドロップに出さない
  const src = avail.length ? avail : [TEMPLATES[0]];
  let t: Template;
  if (opts.boss) {
    const sorted = [...src].sort((a, b) => b.minDepth - a.minDepth);
    t = sorted[rng.int(Math.min(3, sorted.length))]; // 上位3種から
  } else {
    t = pickBaseByDepth(src, depth, rng); // 深度加重（深いほど上位基が出やすい）
  }
  const affix = rollAffix(t.slot, depth, rng, opts);
  const enchant = rollEnchant(t.slot, depth, rng, opts);
  const item = fromTemplate(t, affix, enchant);
  // 異物テンプレ・蝕の銘・一定確率で未鑑定（賭け）。
  if (t.oddity || affix?.klass === "corrupt" || rng.next() < 0.18) item.unidentified = true;
  return item;
}

/** 指定スロットの装備を1つ抽選（武具屋＝武器担当/防具担当の品揃え用。必ずそのスロットが並ぶ）。
 *  深度に合う候補が無ければ、そのスロットの最も浅いテンプレにフォールバック。鑑定済み相当（店頭は素性が見える）。 */
export function rollItemOfSlot(depth: number, rng: Rng, slot: ItemSlot): Item {
  const ofSlot = TEMPLATES.filter((t) => t.slot === slot && !t.exclusive); // 秘宝は店頭に並べない
  const avail = ofSlot.filter((t) => t.minDepth <= depth);
  const src = avail.length ? avail : [[...ofSlot].sort((a, b) => a.minDepth - b.minDepth)[0]];
  const t = pickBaseByDepth(src, depth, rng); // 深度加重（深い街ほど上位基が並ぶ）
  // 店頭は恵/浄の銘まで（蝕は異物堂の領分）。低確率で銘・+N が付く。
  let affix = rollAffix(slot, depth, rng);
  if (affix?.klass === "corrupt") affix = null;
  return fromTemplate(t, affix, rollEnchant(slot, depth, rng));
}

export const SLOT_LABEL: Record<ItemSlot, string> = { weapon: "武器", armor: "防具", relic: "遺物", bag: "鞄" };

// 消耗品（4-10G／持ち物システム Phase1）。装備とは別系統＝持ち物に入り、使うと消える。
// 効果：exposure＝深蝕を退ける（持続するので街でも有効）／healFrac＝最大HPの割合を回復（潜行中専用）。
export interface ConsumableDef {
  key: string; name: string; desc: string; price: number;
  minLevel?: number; // この等級未満では店頭に並ばない（深部向け上位品を序盤の棚に出さない）
  // 効果（web の applyConsumable が解釈）。exposure/healFrac＝街でも使える基本品。
  // curePoison/atkBuff/armBuff/haste/burst＝戦術系（潜行中限定）。identify＝持ち物の未鑑定を見極める。
  use: {
    exposure?: number; healFrac?: number;
    curePoison?: boolean;  // 巡る毒（敵 venom）を中和（poisonTurns→0）
    atkBuff?: number;      // 近接強化を n 手（深蝕ゼロ＝術の clean 版・量は ATTACK_BUFF）
    armBuff?: number;      // 被ダメ軽減を n 手（量は ARMOR_BUFF）
    haste?: number;        // 疾走を n 手（離脱に）
    burst?: number;        // 投擲＝周囲（半径1）の敵に一括ダメージ
    identify?: boolean;    // 手持ちの未鑑定の装備をすべて鑑定
  };
}
export const CONSUMABLES: ConsumableDef[] = [
  { key: "soothe", name: "鎮静の薬",   desc: "深蝕を 0.6 退ける（携行できる薬師）", price: 16, use: { exposure: -0.6 } },
  { key: "salve",  name: "治癒の膏薬", desc: "最大HPの半分を癒す（潜行中に）",     price: 12, use: { healFrac: 0.5 } },
  // 上位品（深部向け・監査B5）：深層は深蝕が 2〜3+ まで嵩み最大HPも大きい。固定 0.6/半分では薄い。
  { key: "salve2",  name: "治癒の秘薬", desc: "最大HPの9割を癒す（潜行中に）",   price: 30, minLevel: 14, use: { healFrac: 0.9 } },
  { key: "soothe2", name: "鎮静の劑",   desc: "深蝕を 1.4 退ける（濃い薬）",     price: 44, minLevel: 16, use: { exposure: -1.4 } },
  { key: "soothe3", name: "浄化の聖水", desc: "深蝕を 2.6 退ける（祓いの聖水）", price: 96, minLevel: 30, use: { exposure: -2.6 } },
  // 戦術系（拡充・PR1）：NetHack 系譜の「アイテム使用の層」を厚く＝回復/除去の2系統だけだった穴を埋める。
  // すべて深蝕ゼロ＝術（深蝕コスト）に対する「清いが有限」の対。潜行中限定（街では空振り＝使用ガード）。
  { key: "antidote", name: "解毒の丸薬", desc: "巡る毒を中和する（潜行中）",                price: 14, minLevel: 6,  use: { curePoison: true } },
  { key: "idscroll", name: "鑑定の巻物", desc: "手持ちの未鑑定の装備をすべて見極める",      price: 24, use: { identify: true } },
  { key: "firebomb", name: "火炎瓶",     desc: "周囲の敵を炎で焼く（投擲・潜行中）",        price: 28, minLevel: 8,  use: { burst: 8 } },
  { key: "fury",     name: "戦狂いの薬", desc: "数手のあいだ近接が冴える（潜行中）",        price: 36, minLevel: 12, use: { atkBuff: 5 } },
  { key: "aegis",    name: "守魂の薬",   desc: "数手のあいだ受ける傷が和らぐ（潜行中）",    price: 36, minLevel: 12, use: { armBuff: 5 } },
  { key: "swift",    name: "疾風の薬",   desc: "数手のあいだ駆け抜ける（離脱に・潜行中）",  price: 44, minLevel: 16, use: { haste: 3 } },
  { key: "firebomb2",name: "業火の壺",   desc: "周囲の敵を業火で焼き尽くす（投擲・潜行中）",price: 72, minLevel: 28, use: { burst: 16 } },
];
export const consumableByKey = (key: string): ConsumableDef | undefined => CONSUMABLES.find((c) => c.key === key);

/** 遺物の効果説明（全 RelicKind を網羅＝新 kind 追加時はここも更新）。 */
const RELIC_DESC: Record<NonNullable<Item["relic"]>, string> = {
  calm: "深蝕レート減", reason: "理＋1", greed: "撃破XP増", might: "近接＋1",
  vigor: "最大HP＋6", ward: "被ダメ−1", fortune: "拾う金貨増", mending: "潜行中ゆっくり回復",
  thorns: "被弾を反射", siphon: "近接で吸命", clarity: "毒・侵蝕を半減", potency: "術ダメージ増", revenant: "一度だけ致死を耐える",
  // 秘宝（2026-07-03）
  spellcrown: "術ダメージ大幅増＋術の深蝕コスト減", blink: "致死で安全地帯へ転移（潜行1回）",
  timeslip: "被弾を低確率で完全回避", farsight: "進入時に地図と宝箱/化石を開示", goldvein: "拾う金貨を大幅増",
};

/** 発動効果の説明（武器 PR4／防具 2026-07-01）。 */
const PROC_DESC: Record<NonNullable<Item["proc"]>, string> = {
  cleave: "薙ぎ（隣接の敵にも余波）", stun: "当て止め", rend: "裂傷（継続ダメ）", sap: "敵の攻撃を弱める",
  block: "受け（被害を軽減）", barbs: "棘（被弾を反射）", cleanse: "清め（被弾で深蝕減）", daunt: "威圧（敵を恐慌）", stagger: "怯み（敵を鈍化）",
  // 秘宝（2026-07-03）
  arc: "雷撃（別の敵へ連鎖・遠距離）", blast: "炎の範囲（半径2）", pierce: "貫通（直線の奥も打つ）", freeze: "凍結（範囲を無力化）", drain: "吸命（与ダメを回復）",
  reflectall: "反射結界（近接も遠距離も返す）", negate: "無効化（確率で一撃を0に）", hasten: "疾風（進入時ヘイスト）", adapt: "深淵順応（深蝕を大幅軽減）", purge: "浄化（被弾で深蝕を強く祓う）",
};
/** 効果の説明（鑑定済み前提）。 */
export function itemPower(it: Item): string {
  let s: string;
  if (it.slot === "weapon") s = `攻＋${it.dmg}${it.reach && it.reach >= 2 ? "・十字2マス貫通（斜め・踏み込み不可）" : ""}${it.proc ? `・${PROC_DESC[it.proc]}` : ""}`;
  else if (it.slot === "armor") s = `被ダメ−${it.reduce}${it.proc ? `・${PROC_DESC[it.proc]}` : ""}`;
  else if (it.slot === "bag") s = `持てる量＋${it.capacity}`;
  else s = it.relic ? RELIC_DESC[it.relic] : "遺物";
  if (it.exposurePerTurn) s += it.exposurePerTurn > 0 ? "・装備中わずかに深蝕＋" : "・装備中わずかに深蝕−";
  return s;
}

/** 一覧表示用ラベル（未鑑定は正体＝銘・+N・性能を伏せる＝情報リーク防止）。 */
export function itemLabel(it: Item): string {
  return it.unidentified ? `見知らぬ${SLOT_LABEL[it.slot]}（未鑑定）` : `${it.name}（${itemPower(it)}）`;
}

/** 金貨での価値（4-10G 経済）。売却額＝この値。購入は店側で割増する。
 *  dmg/reduce は銘・+N 込みの最終値なので、ここで再計算してはならない（二重計算防止）。 */
export function itemValue(it: Item): number {
  let v: number;
  if (it.slot === "weapon") v = 6 + (it.dmg ?? 0) * 8;
  else if (it.slot === "armor") v = 6 + (it.reduce ?? 0) * 8;
  else if (it.slot === "bag") v = 8 + (it.capacity ?? 0) * 4; // 鞄
  else v = 14; // 遺物
  if (it.exposurePerTurn) v += it.exposurePerTurn > 0 ? 10 : 8; // 蝕=世界唯一の輸出品／浄=希少な守り＝ともに高値
  if (it.affix) v += 6;                          // 銘入り（業物）はプレミアム
  if (it.unidentified) v = Math.round(v * 0.7);  // 未鑑定は買い叩かれる
  return v;
}

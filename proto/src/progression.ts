// 成長と派生値（4-11F②）。ステ4種 → 最大HP・近接ダメージ・深蝕耐性、撃破XP→レベル選択成長。
// UIに依存しない純ロジック。web/CLI/demo で共有する。

import type { Character, Stats } from "./types.ts";

export const BASE_STATS: Stats = { body: 2, power: 2, reason: 2, heart: 2 };

export const HP_BASE = 6, HP_PER = 3;
/** 最大HP＝体（逓減・終始シビア 4-11F②）。体2で12＝従来値。体16までは+3/点、超過分は+1/点で
 *  facetank を抑止（均整ビルドは不変、体全振りのみ伸びが鈍る：体51→89）。 */
export const RELIC_VIGOR_HP = 6; // 遺物 vigor の最大HP上乗せ
export const maxHp = (ch: Character) => {
  const b = ch.stats.body;
  return HP_BASE + 3 * Math.min(b, 16) + Math.max(0, b - 16)
    + (ch.equipment?.relic?.relic === "vigor" ? RELIC_VIGOR_HP : 0);
};
/** 荷物（統一バッグ）の容量＝枠数。消耗品の枠＋拾った武具の点数を**同じ容量**で数える
 *  （2026-06-29 統合：消耗品と武具を別袋にしていたのを1つに。武具と薬が同じ枠を奪い合う）。
 *  H&S 側面を尊重し、戦利品を抱える余地は十分残す（旧「消耗品14＋武具11＝計25」より絞りつつ広め）。
 *  レベル＋鞄（装備）で増える。Lv1=10／Lv10+革袋=16／Lv30+背嚢=25。数値はテスト調整候補。 */
export const PACK_BASE = 10;
export const packCapacity = (ch: Character) =>
  PACK_BASE + Math.floor(ch.level / 3) + (ch.equipment?.bag?.capacity ?? 0);
/** 自宅の保管庫（持ち物 Phase3）。総容量＝消耗品スタック＋装備の合計枠（H&Sの収集＝現代H&Sの1タブ相当60）。
 *  世代交代で次代へ残るのは消耗品・装備それぞれ STASH_INHERIT 枠まで（残りは失われる）。 */
export const STASH_CAP = 60;
export const STASH_INHERIT = 4;
export const STASH_CAP_MANOR = 100;     // 貴族街の館（4-14G 層4）：保管庫拡張
export const STASH_INHERIT_MANOR = 8;   // 貴族街の館：相続枠も拡張（家が栄えるほど多くを次代へ遺せる）
/** 構えられる術の数（4-11F③ ロードアウト制）。習得は無制限だが、戦闘で撃てるのはこの数まで。 */
export const LOADOUT_CAP = 10;
/** 近接ダメージ＝力＋武器（power2・素手 で 3＝従来値。4-11F④）＋遺物 might */
export const meleeDmg = (ch: Character) =>
  ch.stats.power + 1 + (ch.equipment?.weapon?.dmg ?? 0) + (ch.equipment?.relic?.relic === "might" ? 1 : 0);
/** 被ダメージ軽減＝防具（B案・下限は呼び出し側で min1）＋遺物 ward */
export const armorReduce = (ch: Character) =>
  (ch.equipment?.armor?.reduce ?? 0) + (ch.equipment?.relic?.relic === "ward" ? 1 : 0);
/** 術の威力に使う実効・理（遺物「理脈」で+1） */
export const effectiveReason = (ch: Character) => ch.stats.reason + (ch.equipment?.relic?.relic === "reason" ? 1 : 0);
/** 撃破XP倍率（遺物「貪欲」で1.5倍） */
export const xpMul = (ch: Character) => (ch.equipment?.relic?.relic === "greed" ? 1.5 : 1);
/** 装備中アイテムの毎ターン深蝕（異物の副作用の合計） */
export const equipExposure = (ch: Character) =>
  [ch.equipment?.weapon, ch.equipment?.armor, ch.equipment?.relic].reduce((s, it) => s + (it?.exposurePerTurn ?? 0), 0);
/** 深蝕の染み込み係数＝心×遺物（heart2・遺物無 で 1.0。高いほど深蝕が遅くなる・下限0.3） */
export const heartFactor = (ch: Character) =>
  Math.max(0.3, 1 - (ch.stats.heart - 2) * 0.12) * (ch.equipment?.relic?.relic === "calm" ? 0.7 : 1);

/** 次レベルに必要なXP（撃破XPで貯まる）。案B＝終始シビア（Lv50到達総XP≈37.6k／
 *  レベルが深度を追い越しにくく常に背伸び。旧 6+6L は浅すぎたため steepen 4-11F②）。 */
export const xpToNext = (level: number) => Math.round(8 + level * 4 + level * level * 0.8);
/** 敵1体の撃破XP（堅いほど多い） */
/** 敵1体の撃破XP（堅いほど多い）。迷宮拡張で敵数が増えたぶん係数0.55で抑え、Lv≈深度を保つ（4-11F②）。 */
export const XP_KILL_MUL = 0.55;
export const xpForKill = (monsterHp: number) => Math.max(1, Math.round(monsterHp * XP_KILL_MUL));

// ---- 奉献の試練（4-13） ----
/** 第5の印「深淵への到達」を得る深度（深い帯・到達は実力の証。終始シビアで深く＝~40）。 */
export const DEPTH_SEAL_AT = 40;
/** 深淵帯（封印フロア）の深度。通常到達域より深い＝儀でのみ降りられる神話極の層（~50）。 */
export const ABYSS_DEPTH = 50;
/** 帰還の試練・聖遺物携行中の毎手 追加深蝕（深みが覚醒し、留まるほど蝕む）。
 *  v2（フル寸法の深淵帯）でも帰還経路が生存可能になるよう抑えめ（旧0.12→0.03→0.015）。
 *  詠唱(homeward)脱出はほぼ無傷／高心や装備を整えた歩き戻りも生還可能、無策の歩き戻りは依然苦しい。 */
export const RELIC_EXPOSURE_PER_TURN = 0.015;
/** 帰還の試練・追手（怨霊）が湧く手間隔／1フロアの上限。 */
export const RELIC_PURSUER_EVERY = 3;
export const RELIC_PURSUER_CAP = 6;

export const STAT_KEYS = ["body", "power", "reason", "heart"] as const;
export type StatKey = typeof STAT_KEYS[number];
export const STAT_LABEL: Record<StatKey, string> = { body: "体", power: "力", reason: "理", heart: "心" };

/** 「体X 力X 理X 心X」表記 */
export const statsLine = (ch: Character) =>
  STAT_KEYS.map((k) => `${STAT_LABEL[k]}${ch.stats[k]}`).join(" ");

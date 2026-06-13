// 成長と派生値（4-11F②）。ステ4種 → 最大HP・近接ダメージ・深蝕耐性、撃破XP→レベル選択成長。
// UIに依存しない純ロジック。web/CLI/demo で共有する。

import type { Character, Stats } from "./types.ts";

export const BASE_STATS: Stats = { body: 2, power: 2, reason: 2, heart: 2 };

export const HP_BASE = 6, HP_PER = 3;
/** 最大HP＝体（body2 で 12＝従来値） */
export const maxHp = (ch: Character) => HP_BASE + ch.stats.body * HP_PER;
/** 近接ダメージ＝力＋武器（power2・素手 で 3＝従来値。4-11F④） */
export const meleeDmg = (ch: Character) => ch.stats.power + 1 + (ch.equipment?.weapon?.dmg ?? 0);
/** 被ダメージ軽減＝防具（B案・下限は呼び出し側で min1） */
export const armorReduce = (ch: Character) => ch.equipment?.armor?.reduce ?? 0;
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

/** 次レベルに必要なXP（撃破XPで貯まる） */
export const xpToNext = (level: number) => 6 + level * 6;
/** 敵1体の撃破XP（堅いほど多い） */
export const xpForKill = (monsterHp: number) => Math.max(1, monsterHp);

export const STAT_KEYS = ["body", "power", "reason", "heart"] as const;
export type StatKey = typeof STAT_KEYS[number];
export const STAT_LABEL: Record<StatKey, string> = { body: "体", power: "力", reason: "理", heart: "心" };

/** 「体X 力X 理X 心X」表記 */
export const statsLine = (ch: Character) =>
  STAT_KEYS.map((k) => `${STAT_LABEL[k]}${ch.stats[k]}`).join(" ");

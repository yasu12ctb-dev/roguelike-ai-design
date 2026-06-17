// 深蝕魔法・スキル（4-11F-B）。燃料は MP ではなく深蝕（exposure）。理が威力に効く。
// 「強く戦うほど深蝕が進む＝どんな化石になるかが戦い方で決まる」。
// 取得は無制限（図鑑）／戦闘で撃てるのは「構え」LOADOUT_CAP 個まで（ロードアウト制 2026-06-17）。
// 効果の適用（盤面操作）は web/main.ts castSpell が担う（floor/player に依存するため）。ここは定義のみ。
// 効果の出典：DCSS / NetHack / ToME / Diablo を翻案（名称は深蝕テイスト＝漢字熟語）。

export type SpellKey =
  | "warp_strike" | "rift_lance" | "collapse" | "thunder"   // 攻
  | "still_eye" | "slow" | "dread"                          // 制
  | "shadow_step" | "charge"                                // 移
  | "heal" | "enfeeble" | "leech"                           // 援
  | "survey";                                               // 識

export type SpellSchool = "攻" | "制" | "移" | "援" | "識";

export interface SpellDef {
  key: SpellKey;
  name: string;
  school: SpellSchool;
  cost: number;   // 詠唱で増える深蝕
  desc: string;
}

// 深蝕コスト階梯（終始シビアの肝＝強い術ほど化石化が進む）：
//   識 0.05–0.1／制・移 0.15–0.2／攻 0.15–0.3／回復 0.3–0.4。
export const SPELLS: SpellDef[] = [
  // ── 攻 ──
  { key: "warp_strike", name: "歪撃",   school: "攻", cost: 0.15, desc: "最寄りの敵を確定で討つ（威力は理で伸びる）" },
  { key: "rift_lance",  name: "裂界",   school: "攻", cost: 0.20, desc: "最寄りの敵へ向け一直線を貫く（線上の敵すべてに）" },
  { key: "collapse",    name: "崩落",   school: "攻", cost: 0.25, desc: "最寄りの敵を中心に崩し落とす（周囲を巻き込む範囲）" },
  { key: "thunder",     name: "雷霆",   school: "攻", cost: 0.22, desc: "可視の敵すべてに放射状の雷（やや弱め・数で削る）" },
  // ── 制 ──
  { key: "still_eye",   name: "静止の眼", school: "制", cost: 0.20, desc: "見えている敵を2手のあいだ止める" },
  { key: "slow",        name: "鈍り",   school: "制", cost: 0.15, desc: "見えている敵を数手のあいだ1手おきに鈍らせる" },
  { key: "dread",       name: "畏れ",   school: "制", cost: 0.18, desc: "見えている敵を数手のあいだ怯えさせ、退かせる" },
  // ── 移 ──
  { key: "shadow_step", name: "影渡り", school: "移", cost: 0.12, desc: "敵から最も遠い視界へ瞬間移動して逃げる" },
  { key: "charge",      name: "迫り",   school: "移", cost: 0.15, desc: "最寄りの敵へ一息に踏み込み、近接の一撃を浴びせる" },
  // ── 援 ──
  { key: "heal",        name: "癒し",   school: "援", cost: 0.30, desc: "HPを癒す（理＋体ぶん。深蝕は重い）" },
  { key: "enfeeble",    name: "蝕み",   school: "援", cost: 0.18, desc: "最寄りの敵の攻撃を数手のあいだ削ぐ" },
  { key: "leech",       name: "吸命",   school: "援", cost: 0.20, desc: "最寄りの敵を蝕み、奪ったぶんHPに変える" },
  // ── 識 ──
  { key: "survey",      name: "地相",   school: "識", cost: 0.08, desc: "このフロアの地形を感知する（地図が開ける）" },
];

export const spellByKey = (key: string): SpellDef | undefined => SPELLS.find((s) => s.key === key);

/** 歪撃の確定ダメージ＝理に比例（理2で6）。裂界/雷霆/吸命/蝕み治癒もこれを基準に倍率で派生。 */
export const warpDamage = (reason: number) => reason * 2 + 2;

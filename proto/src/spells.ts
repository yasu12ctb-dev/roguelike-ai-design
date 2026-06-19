// 深蝕魔法・スキル（4-11F-B）。燃料は MP ではなく深蝕（exposure）。理が威力に効く。
// 「強く戦うほど深蝕が進む＝どんな化石になるかが戦い方で決まる」。
// 取得は無制限（図鑑）／戦闘で撃てるのは「構え」LOADOUT_CAP 個まで（ロードアウト制 2026-06-17）。
// 効果の適用（盤面操作）は web/main.ts castSpell が担う（floor/player に依存するため）。ここは定義のみ。
// 効果の出典：DCSS / NetHack / ToME / Diablo を翻案（名称は深蝕テイスト＝漢字熟語）。

export type SpellKey =
  | "warp_strike" | "rift_lance" | "collapse" | "thunder" | "ice_tomb" | "wither" | "condemn"  // 攻
  | "still_eye" | "slow" | "dread" | "confuse" | "slumber" | "bind"                            // 制
  | "corrode"                                                                                    // 攻（継続）
  | "shadow_step" | "charge" | "omni_strike" | "gravity_pull" | "miststep" | "wayfare"            // 移
  | "heal" | "enfeeble" | "leech" | "ironscale" | "haste" | "frenzy" | "deathdoor" | "cleanse"  // 援
  | "survey" | "insight" | "scent"                          // 識
  | "minions" | "orbblade" | "echo" | "shadowclone";        // 召

export type SpellSchool = "攻" | "制" | "移" | "援" | "識" | "召";

export interface SpellDef {
  key: SpellKey;
  name: string;
  school: SpellSchool;
  cost: number;   // 詠唱で増える深蝕
  desc: string;
  minLevel?: number; // 「レベルアップで識る」選択に出る最低レベル（高効果ほど高い）。既定1。他の入手法（深淵/教団）は不問。
}

// 深蝕コスト階梯（終始シビアの肝＝強い術ほど化石化が進む）：
//   識 0.05–0.1／制・移 0.15–0.2／攻 0.15–0.3／回復 0.3–0.4。
// minLevel：基本(1)→序(3-6)→中(9-13)→高(16-22)→極(26)。効果が高いものは高レベルでのみレベルアップ選択に出る。
export const SPELLS: SpellDef[] = [
  // ── 攻 ──
  { key: "warp_strike", name: "歪撃",   school: "攻", cost: 0.15, desc: "最寄りの敵を確定で討つ（威力は理で伸びる）" },
  { key: "rift_lance",  name: "裂界",   school: "攻", cost: 0.20, desc: "最寄りの敵へ向け一直線を貫く（線上の敵すべてに）", minLevel: 8 },
  { key: "collapse",    name: "崩落",   school: "攻", cost: 0.25, desc: "最寄りの敵を中心に崩し落とす（周囲を巻き込む範囲）", minLevel: 13 },
  { key: "thunder",     name: "雷霆",   school: "攻", cost: 0.22, desc: "可視の敵すべてに放射状の雷（やや弱め・数で削る）", minLevel: 16 },
  { key: "ice_tomb",    name: "氷棺",   school: "攻", cost: 0.22, desc: "最寄りの敵を高威力で討ち、2手のあいだ凍てつかせる", minLevel: 9 },
  { key: "wither",      name: "痩身",   school: "攻", cost: 0.20, desc: "最寄りの敵の現在HPを大きく削り取る（硬い敵に効く）", minLevel: 16 },
  { key: "condemn",     name: "断罪",   school: "攻", cost: 0.50, desc: "最寄りの敵へ一撃必殺級の断罪（深蝕は極めて重い）", minLevel: 26 },
  { key: "corrode",     name: "腐喰",   school: "攻", cost: 0.18, desc: "最寄りの敵を腐らせ、数手のあいだ蝕み続ける（継続ダメ）", minLevel: 12 },
  // ── 制 ──
  { key: "still_eye",   name: "静止の眼", school: "制", cost: 0.20, desc: "見えている敵を2手のあいだ止める" },
  { key: "slow",        name: "鈍り",   school: "制", cost: 0.15, desc: "見えている敵を数手のあいだ1手おきに鈍らせる", minLevel: 3 },
  { key: "dread",       name: "畏れ",   school: "制", cost: 0.18, desc: "見えている敵を数手のあいだ怯えさせ、退かせる", minLevel: 6 },
  { key: "confuse",     name: "惑乱",   school: "制", cost: 0.18, desc: "見えている敵を数手のあいだ惑わせ、よろめかせる", minLevel: 9 },
  { key: "slumber",     name: "微睡",   school: "制", cost: 0.20, desc: "最寄りの敵を深く眠らせる（長く止まる）", minLevel: 13 },
  { key: "bind",        name: "縛鎖",   school: "制", cost: 0.18, desc: "最寄りの敵をその場に縫い止める（動けない）", minLevel: 6 },
  // ── 移 ──
  { key: "shadow_step", name: "影渡り", school: "移", cost: 0.12, desc: "敵から最も遠い視界へ瞬間移動して逃げる" },
  { key: "charge",      name: "迫り",   school: "移", cost: 0.15, desc: "最寄りの敵へ一息に踏み込み、近接の一撃を浴びせる", minLevel: 6 },
  { key: "omni_strike", name: "万象斬", school: "移", cost: 0.25, desc: "視界の敵すべてへ転移の斬撃を浴びせる（近接威力）", minLevel: 16 },
  { key: "gravity_pull", name: "引閘",  school: "移", cost: 0.18, desc: "見えている敵を自分のほうへ一斉に引き寄せる", minLevel: 12 },
  { key: "miststep",    name: "霞足",   school: "移", cost: 0.10, desc: "近場へ霞のように短く跳ぶ（敵から距離を取る）", minLevel: 3 },
  { key: "wayfare",     name: "退き戸", school: "移", cost: 0.16, desc: "上り階段の傍へ退く門を開く（退避）", minLevel: 9 },
  // ── 援 ──
  { key: "heal",        name: "癒し",   school: "援", cost: 0.30, desc: "HPを癒す（理＋体ぶん。深蝕は重い）" },
  { key: "enfeeble",    name: "蝕み",   school: "援", cost: 0.18, desc: "最寄りの敵の攻撃を数手のあいだ削ぐ", minLevel: 6 },
  { key: "leech",       name: "吸命",   school: "援", cost: 0.20, desc: "最寄りの敵を蝕み、奪ったぶんHPに変える", minLevel: 9 },
  { key: "ironscale",   name: "硬鱗",   school: "援", cost: 0.18, desc: "数手のあいだ、被ダメージを和らげる（守りを固める）", minLevel: 9 },
  { key: "haste",       name: "疾走",   school: "援", cost: 0.25, desc: "数手のあいだ、敵を置き去りに余分な一手を得る", minLevel: 20 },
  { key: "frenzy",      name: "焦躁",   school: "援", cost: 0.20, desc: "数手のあいだ近接が冴える（深蝕も募る）", minLevel: 13 },
  { key: "deathdoor",   name: "死戸",   school: "援", cost: 0.40, desc: "数手のあいだ無敵だが癒えず、明けに深みの揺り戻し", minLevel: 26 },
  { key: "cleanse",     name: "解呪",   school: "援", cost: 0.12, desc: "今この場で深蝕をいくらか祓う（-0.6）", minLevel: 3 },
  // ── 識 ──
  { key: "survey",      name: "地相",   school: "識", cost: 0.08, desc: "このフロアの地形を感知する（地図が開ける）" },
  { key: "insight",     name: "看破",   school: "識", cost: 0.06, desc: "可視の敵の正体とHPを見抜く（強さを測る）" },
  { key: "scent",       name: "嗅ぎ",   school: "識", cost: 0.06, desc: "宝箱・化石の在処を嗅ぎ当てる（地図に灯す）" },
  // ── 召（一時味方・数手で霧散） ──
  { key: "minions",     name: "蝕兵",   school: "召", cost: 0.30, desc: "最寄りの敵の傍に短命の眷属を2体起こす（隣接を討つ）", minLevel: 9 },
  { key: "orbblade",    name: "廻刃",   school: "召", cost: 0.28, desc: "自分の傍を回る刃を侍らせる（隣接敵を毎手討つ）", minLevel: 16 },
  { key: "echo",        name: "残響召喚", school: "召", cost: 0.35, desc: "在りし日の残響を1体呼ぶ（強めの一時味方）", minLevel: 22 },
  { key: "shadowclone", name: "影分け", school: "召", cost: 0.25, desc: "影武者が数手のあいだ、敵の一撃を肩代わりする", minLevel: 20 },
];

export const spellByKey = (key: string): SpellDef | undefined => SPELLS.find((s) => s.key === key);

/** 歪撃の確定ダメージ＝理に比例（理2で6）。裂界/雷霆/吸命/蝕み治癒もこれを基準に倍率で派生。 */
export const warpDamage = (reason: number) => reason * 2 + 2;

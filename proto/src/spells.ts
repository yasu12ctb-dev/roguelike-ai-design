// 深蝕魔法・スキル（4-11F-B）。燃料は MP ではなく深蝕（exposure）。理が威力に効く。
// 「強く戦うほど深蝕が進む＝どんな化石になるかが戦い方で決まる」。
// 取得は無制限（図鑑）／戦闘で撃てるのは「構え」LOADOUT_CAP 個まで（ロードアウト制 2026-06-17）。
// 効果の適用（盤面操作）は web/main.ts castSpell が担う（floor/player に依存するため）。ここは定義のみ。
// 効果の出典：DCSS / NetHack / ToME / Diablo を翻案（名称は深蝕テイスト＝漢字熟語）。

export type SpellKey =
  | "warp_strike" | "rift_lance" | "collapse" | "thunder" | "ice_tomb" | "wither" | "condemn" | "firefloor"  // 攻
  | "still_eye" | "slow" | "dread" | "confuse" | "bind" | "enfeeble" | "frostmist"              // 制
  | "corrode"                                                                                    // 攻（継続）
  | "shadow_step" | "charge" | "gravity_pull" | "wayfare" | "homeward" | "parry"                  // 移
  | "heal" | "leech" | "ironscale" | "haste" | "frenzy" | "deathdoor" | "cleanse"               // 援
  | "survey" | "insight" | "scent" | "foresight"           // 識
  | "minions" | "echo" | "shadowclone";                     // 召

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
// minLevel：基本(1)→序(3-6)→中(9-16)→高(22-32)→極(36-44)。Lv50 スケールに分散し、後半も新術が滲む（2026-06-23 再配分）。効果が高いものは高レベルでのみレベルアップ選択に出る。
export const SPELLS: SpellDef[] = [
  // ── 攻 ──
  { key: "warp_strike", name: "歪撃",   school: "攻", cost: 0.15, desc: "最寄りの敵を確定で討つ（威力は理で伸びる）" },
  { key: "rift_lance",  name: "裂界",   school: "攻", cost: 0.20, desc: "最寄りの敵へ向け一直線を貫く（線上の敵すべてに）", minLevel: 8 },
  { key: "collapse",    name: "崩落",   school: "攻", cost: 0.25, desc: "最寄りの敵を中心に崩し落とし、瓦礫で通路を塞ぐ（範囲ダメ＋周囲の床が壁に）", minLevel: 13 },
  { key: "thunder",     name: "雷霆",   school: "攻", cost: 0.22, desc: "可視の敵すべてに放射状の雷（やや弱め・数で削る）", minLevel: 16 },
  { key: "firefloor",   name: "業火床", school: "攻", cost: 0.22, desc: "深みの火を呼び、しばし床を業火に変える（敵を灼き、自らも焼く地形）", minLevel: 14 },
  { key: "ice_tomb",    name: "氷棺",   school: "攻", cost: 0.22, desc: "最寄りの敵を高威力で討ち、2手のあいだ凍てつかせる", minLevel: 9 },
  { key: "wither",      name: "痩身",   school: "攻", cost: 0.20, desc: "最寄りの敵の現在HPを大きく削り取る（硬い敵に効くが、巨大なものには効きが鈍い）", minLevel: 24 },
  { key: "condemn",     name: "断罪",   school: "攻", cost: 0.40, desc: "最寄りの敵へ一撃必殺級の断罪（深蝕は極めて重い）", minLevel: 44 },
  { key: "corrode",     name: "腐喰",   school: "攻", cost: 0.18, desc: "最寄りの敵を腐らせ、数手のあいだ蝕み続ける（継続ダメ）", minLevel: 12 },
  // ── 制 ──
  { key: "still_eye",   name: "静止の眼", school: "制", cost: 0.20, desc: "見えている敵を2手のあいだ止める" },
  { key: "slow",        name: "鈍り",   school: "制", cost: 0.15, desc: "見えている敵を数手のあいだ1手おきに鈍らせる", minLevel: 3 },
  { key: "dread",       name: "畏れ",   school: "制", cost: 0.18, desc: "見えている敵を数手のあいだ怯えさせ、退かせる", minLevel: 6 },
  { key: "confuse",     name: "惑乱",   school: "制", cost: 0.18, desc: "見えている敵を数手のあいだ惑わせ、よろめかせる", minLevel: 9 },
  { key: "bind",        name: "縛鎖",   school: "制", cost: 0.18, desc: "最寄りの敵をその場に縫い止める（動けない）", minLevel: 6 },
  { key: "enfeeble",    name: "蝕み",   school: "制", cost: 0.18, desc: "最寄りの敵の攻撃を数手のあいだ削ぐ", minLevel: 6 },
  { key: "frostmist",   name: "凍霧",   school: "制", cost: 0.22, desc: "凍てつく霧が漂い、踏み入る者を鈍らせる（しばし残る地形・あなたには効かない）", minLevel: 18 },
  // ── 移 ──
  { key: "shadow_step", name: "影渡り", school: "移", cost: 0.12, desc: "敵から最も遠い視界へ瞬間移動して逃げる" },
  { key: "charge",      name: "迫り",   school: "移", cost: 0.15, desc: "最寄りの敵へ一息に踏み込み、近接の一撃を浴びせる", minLevel: 6 },
  { key: "gravity_pull", name: "引閘",  school: "移", cost: 0.18, desc: "見えている敵を自分のほうへ一斉に引き寄せる", minLevel: 12 },
  { key: "wayfare",     name: "退き戸", school: "移", cost: 0.16, desc: "上り階段の傍へ退く門を開く（退避）", minLevel: 9 },
  { key: "homeward",    name: "帰還の詠唱", school: "移", cost: 0.20, desc: "数手の詠唱で地上へ還る（詠唱中は無防備・動くと中断）。聖遺物を抱いていれば奉献が成る", minLevel: 9 },
  { key: "parry",       name: "弾き",   school: "移", cost: 0.18, desc: "張り詰めた気で飛来を弾き返す（しばらくの間・近接には効かない）", minLevel: 24 },
  // ── 援 ──
  { key: "heal",        name: "癒し",   school: "援", cost: 0.30, desc: "HPを癒す（理＋体ぶん。深蝕は重い）" },
  { key: "leech",       name: "吸命",   school: "援", cost: 0.20, desc: "最寄りの敵を蝕み、奪ったぶんHPに変える", minLevel: 9 },
  { key: "ironscale",   name: "硬鱗",   school: "援", cost: 0.18, desc: "数手のあいだ、被ダメージを和らげる（守りを固める）", minLevel: 9 },
  { key: "haste",       name: "疾走",   school: "援", cost: 0.40, desc: "数手のあいだ、敵を置き去りに余分な一手を得る", minLevel: 28 },
  { key: "frenzy",      name: "焦躁",   school: "援", cost: 0.20, desc: "数手のあいだ近接が冴える（深蝕も募る）", minLevel: 13 },
  { key: "deathdoor",   name: "死戸",   school: "援", cost: 0.40, desc: "数手のあいだ無敵だが癒えず、明けに深みの揺り戻し", minLevel: 36 },
  { key: "cleanse",     name: "解呪",   school: "援", cost: 0.12, desc: "今この場で深蝕をいくらか祓う（-0.6）", minLevel: 3 },
  // ── 識 ──
  { key: "survey",      name: "地相",   school: "識", cost: 0.08, desc: "このフロアの地形を感知する（地図が開ける）" },
  { key: "insight",     name: "看破",   school: "識", cost: 0.06, desc: "可視の敵の正体とHPを見抜き、全ての敵の位置を地図に灯す" },
  { key: "scent",       name: "嗅ぎ",   school: "識", cost: 0.06, desc: "宝箱・化石・下り階段の在処を嗅ぎ当てる（地図に灯す）" },
  { key: "foresight",   name: "先見",   school: "識", cost: 0.12, desc: "階段の下の気配を読む（次の階の敵の多さ・ボスの有無を知る）", minLevel: 12 },
  // ── 召（一時味方・数手で霧散） ──
  { key: "minions",     name: "蝕兵",   school: "召", cost: 0.30, desc: "最寄りの敵の傍に短命の眷属を2体起こす（隣接を討つ）", minLevel: 9 },
  { key: "echo",        name: "幻刃",   school: "召", cost: 0.35, desc: "深みの理を刃のかたちに束ね、しばし従える（強めの一時味方）", minLevel: 32 },
  { key: "shadowclone", name: "影分け", school: "召", cost: 0.25, desc: "影武者が敵の一撃を3度まで肩代わりする（回数で消える）", minLevel: 30 },
];

export const spellByKey = (key: string): SpellDef | undefined => SPELLS.find((s) => s.key === key);

/** 歪撃の確定ダメージ＝理に比例（理2で6）。裂界/雷霆/吸命/蝕み治癒もこれを基準に倍率で派生。 */
export const warpDamage = (reason: number) => reason * 2 + 2;

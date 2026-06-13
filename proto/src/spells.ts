// 深蝕魔法・スキル（4-11F-B）。燃料は MP ではなく深蝕（exposure）。理が威力に効く。
// 「強く戦うほど深蝕が進む＝どんな化石になるかが戦い方で決まる」。第1弾は攻/防/移動を1つずつ。
// 効果の適用（盤面操作）は web/main.ts が担う（floor/player に依存するため）。ここは定義のみ。

export type SpellKey = "warp_strike" | "still_eye" | "shadow_step";

export interface SpellDef {
  key: SpellKey;
  name: string;
  cost: number;   // 詠唱で増える深蝕
  desc: string;
}

export const SPELLS: SpellDef[] = [
  { key: "warp_strike", name: "歪撃",     cost: 0.15, desc: "最寄りの敵を確定で討つ（威力は理で伸びる）" },
  { key: "still_eye",   name: "静止の眼", cost: 0.20, desc: "見えている敵を2手のあいだ止める" },
  { key: "shadow_step", name: "影渡り",   cost: 0.12, desc: "敵から最も遠い視界へ瞬間移動して逃げる" },
];

export const spellByKey = (key: string): SpellDef | undefined => SPELLS.find((s) => s.key === key);

/** 歪撃の確定ダメージ＝理に比例（理2で6） */
export const warpDamage = (reason: number) => reason * 2 + 2;

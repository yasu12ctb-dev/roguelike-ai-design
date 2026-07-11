// 難易度モード（4-11H・v0.56.0）。終始シビアの単一曲線に「薄い乗数レイヤー」を被せる。
// 別コード経路を作らず係数だけで振る＝決定論・golden・Swift 移植に優しい。
// 既定（未設定／旧セーブ）＝easy＝現行数値そのまま＝振る舞い不変。新規ワールド開始時に固定（途中変更なし）。

export type Difficulty = "easy" | "normal" | "hard" | "death";

export interface DifficultyMods {
  enemyHp: number;    // 敵HP倍率（スポーン時に焼き込む）
  enemyDmg: number;   // 敵火力倍率（スポーン時に焼き込む）
  dmgFloor: number;   // 序盤の火力床（深度係数が小さくても痛くする＝深度1から噛む）
  exposure: number;   // 深蝕の累積倍率（深く潜るほどの圧）
  xp: number;         // XP倍率（低いほど育ちにくい＝相対的に敵が硬い）
  townHeal: number;   // 街帰還/潜行開始の回復割合（1=全回復・<1=割合・0=回復なし）
  lineage: boolean;   // 系譜ボーナス（血縁/弟子の地力）を有効にするか
  // ── オーバーレベル対策（v0.121.0・2026-07-05 バランス監査＝「成長が深度を追い越し全深度が平坦化」FB対応）──
  xpTether: number;   // XPの深度係留＝格下狩り逓減の強さ。倍率 = 1/(1 + xpTether×max(0, Lv−深度−2))。0=無効。
  greedMul: number;   // 遺物 greed（XP増加）の実効倍率。easy=1.5（従来）／normal+=1.2（単一遺物で恒常+3Lvは過大）。
  chipFrac: number;   // 被ダメの比例下限＝max(1, ceil(素の攻×chipFrac), 攻−軽減−バフ)。防具飽和（軽減が攻を打ち消し被ダメ1固定）対策。0=従来の固定下限1。
  // ── 敵密度の難易度スケール（PR2・v0.146.0・2026-07-10・ユーザー承認＝「囲まれる状況」の実体化）──
  fodderMul: number;  // fodder（低tier雑魚）の追加割合。dungeon.ts genFloor の FODDER_MUL を難易度別に置換。
                       // easy=0.2＝現行 FODDER_MUL と同値＝据え置き（golden 完全不変）。normal/hard/death のみ増量。
}

// death は「枠だけ」用意（中身は後日調整・UI 未選択）。easy=1.0 基準＝golden 不変。
// easy＝「丁寧に進めると気持ちよく無双できる」快適モード（2026-07-05 ユーザー確定＝オーバーレベルを容認する公式仕様＝新3係数は全て無効）。
// normal/hard＝終始シビア＝XP係留＋比例チップで「成長の追い越し」を封じ、全深度で手応えを保つ。
// ── 攻撃力の外科的強化（①・PR4・v0.148.0・2026-07-11 ユーザー承認＝「敵の被ダメが軽い」FB対応）──
//   burst 導入（PR3）で確定ダメージの脅威は増したが、chipFrac（軽減の比例下限）はまだ防具飽和を許す帯が残る。
//   normal/hard/death の chipFrac を底上げ＋生 enemyDmg をごく小幅に（easy は完全据え置き＝golden 不変）。
//   数値は sim（tools/dodgefloor 系）で「HP損/フロアは増えるが CLEAR≥45% を維持（死の博打化なし）」を確認して採用。
export const DIFFICULTY: Record<Difficulty, DifficultyMods> = {
  easy:   { enemyHp: 1.0,  enemyDmg: 1.0, dmgFloor: 0, exposure: 1.0, xp: 1.0,  townHeal: 1.0, lineage: true,  xpTether: 0,    greedMul: 1.5, chipFrac: 0,    fodderMul: 0.2 },
  normal: { enemyHp: 1.25, enemyDmg: 1.30, dmgFloor: 1, exposure: 1.2, xp: 0.9,  townHeal: 1.0, lineage: true,  xpTether: 0.35, greedMul: 1.2, chipFrac: 0.20, fodderMul: 0.35 },
  hard:   { enemyHp: 1.5,  enemyDmg: 1.45, dmgFloor: 2, exposure: 1.4, xp: 0.85, townHeal: 0.8, lineage: true,  xpTether: 0.4,  greedMul: 1.2, chipFrac: 0.24, fodderMul: 0.45 },
  death:  { enemyHp: 1.8,  enemyDmg: 1.6, dmgFloor: 2, exposure: 1.7, xp: 0.8,  townHeal: 0.0, lineage: false, xpTether: 0.45, greedMul: 1.2, chipFrac: 0.26, fodderMul: 0.5 },
};

export const EASY_MODS = DIFFICULTY.easy;

/** 難易度→係数。未設定（旧セーブ/新規ワールド未選択）は easy＝現行数値。 */
export const diffMods = (d: Difficulty | undefined): DifficultyMods => DIFFICULTY[d ?? "easy"];

/** 選択肢に出す段（death は枠のみ＝当面非表示）。 */
export const SELECTABLE_DIFFICULTIES: Difficulty[] = ["easy", "normal", "hard"];

export const DIFFICULTY_LABEL: Record<Difficulty, string> = {
  easy: "安寧（やさしい）", normal: "常闇（ふつう）", hard: "深淵（むずかしい）", death: "終焉（極限）",
};
export const DIFFICULTY_BLURB: Record<Difficulty, string> = {
  easy: "快適の途。丁寧に狩れば力が深みを追い越し、気持ちよく無双できる。",
  normal: "終始シビア。深みは常に半歩強い——浅場ではもう育たない。深く潜れ。",
  hard: "深部志向。敵は硬く痛く、街の癒えも一部に留まり、育ちも遅い。",
  death: "（準備中）",
};

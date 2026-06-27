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
}

// death は「枠だけ」用意（中身は後日調整・UI 未選択）。easy=1.0 基準＝golden 不変。
export const DIFFICULTY: Record<Difficulty, DifficultyMods> = {
  easy:   { enemyHp: 1.0,  enemyDmg: 1.0, dmgFloor: 0, exposure: 1.0, xp: 1.0,  townHeal: 1.0, lineage: true },
  normal: { enemyHp: 1.25, enemyDmg: 1.25, dmgFloor: 1, exposure: 1.2, xp: 0.9,  townHeal: 1.0, lineage: true },
  hard:   { enemyHp: 1.5,  enemyDmg: 1.4, dmgFloor: 2, exposure: 1.4, xp: 0.85, townHeal: 0.8, lineage: true },
  death:  { enemyHp: 1.8,  enemyDmg: 1.6, dmgFloor: 2, exposure: 1.7, xp: 0.8,  townHeal: 0.0, lineage: false },
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
  easy: "現行の手応え。序盤はじっくり慣らせる。",
  normal: "終始シビア。序盤から敵が噛み、深蝕も速い。歯ごたえ重視の標準。",
  hard: "深部志向。敵は硬く痛く、街の癒えも一部に留まり、育ちも遅い。",
  death: "（準備中）",
};

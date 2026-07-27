// 意味論的スクリーンモデルの「型＋純粋 runtime 定数」（U1c・prototype-spec.md §10.1b / §10.2e）。
//
// ★位置づけ（重要）：
//   - 本ファイルは **型と runtime 定数のみ**。**production の描画（main.ts）からは未参照**。
//     ＝web の正式な (1b) Screen conformance は **0 画面・未実装**（Screen adapter は別承認）。
//   - TypeScript の union は実行時に消えるため、**有限 ID 集合を `as const` の runtime 定数で正典化**し、
//     **型はそこから導出**する（validator は定数を実行時に直接読む）。
//   - ID 集合の生成元は **§10.2e の表**。`tools/ui-fixture-check.ts` が doc とこの定数の一致を検査する
//     （doc↔実装の二重管理を機械検出）。**色の hex はここに持たない**（10.2/10.3 が正）。

/** 前景意味トークン（§10.2e＝画面モデルが参照する前景の意味トークンの単一集合。背景・面は含まない）。 */
export const SEM_TONES = [
  // 状態（10.2 ステータス色）
  "hp", "exp", "gold", "buff", "warn",
  // 文字強調（10.2 文字／アクセント）
  "strong", "dim", "meta", "faint", "acc",
  // グリフ役割（10.3）
  "player", "player-danger", "player-heavy",
  "companion", "companion-danger", "companion-erratic",
  "delver", "downed", "summon", "stairs-down", "stairs-up", "wall", "floor",
  // 敵ティア（10.2）
  "mon-t1", "mon-t2", "mon-t3", "mon-t4", "mon-t5", "elite", "boss",
  // 物・ノード（10.3）
  "fossil", "fossil-quiet", "chest", "chest-open", "spring", "rest", "door",
  // 術学派（10.2）
  "atk", "ctl", "mov", "sup", "lore", "sum",
  // 残響の極（4-11A）
  "loss", "myth", "grudge",
] as const;

/** アイコン ID（§10.2e＝10.10③ の SF Symbols 対応表と対）。 */
export const ICON_IDS = [
  "spell", "bag", "stat", "map", "hub", "cog",
  "help", "save-export", "save-import", "reset",
] as const;

/** 行の種類（10.1b）。 */
export const ROW_KINDS = ["info", "text", "action", "toggle", "picker", "input", "card"] as const;
/** ボタン役割（10.1「ボタン役割」と一致）。 */
export const ROLES = ["primary", "cancel", "danger", "normal"] as const;
/** 入力型（10.1b の判別 union）。 */
export const INPUT_TYPES = ["text", "number"] as const;

export type SemTone = typeof SEM_TONES[number];
export type IconId = typeof ICON_IDS[number];
export type RowKind = typeof ROW_KINDS[number];
export type Role = typeof ROLES[number];
export type InputType = typeof INPUT_TYPES[number];

export interface Badge { text: string; tone: SemTone }
export interface Glyph { char: string; tone: SemTone }

export type Row =
  | { kind: "info"; id: string; label: string; value?: string; note?: string; tone?: SemTone }
  | { kind: "text"; id: string; text: string; dim?: boolean; tone?: SemTone }
  | { kind: "action"; id: string; label: string; role?: Role; icon?: IconId; badge?: Badge }
  | { kind: "toggle"; id: string; label: string; on: boolean }
  | { kind: "picker"; id: string; label: string; options: { id: string; label: string }[]; selected: string }
  | ({ kind: "input"; id: string; label: string; required?: boolean; placeholder?: string; value?: string } & (
      | { inputType: "text"; multiline?: boolean }
      | { inputType: "number"; min?: number; max?: number; step?: number }
    ))
  | { kind: "card"; id: string; title: string; sub?: string; glyph?: Glyph; badge?: Badge; role?: Role };

export interface Section { id: string; header?: string; rows: Row[] }
export interface Screen { id: string; title: string; subtitle?: string; sections: Section[] }

// ---- 検査で使う許可 field 表（closed schema 用・validator が実行時に読む） -------------
/** 各 Row 種別で許可される field（未知 field は拒否）。 */
export const ROW_FIELDS: Record<RowKind, readonly string[]> = {
  info: ["kind", "id", "label", "value", "note", "tone"],
  text: ["kind", "id", "text", "dim", "tone"],
  action: ["kind", "id", "label", "role", "icon", "badge"],
  toggle: ["kind", "id", "label", "on"],
  picker: ["kind", "id", "label", "options", "selected"],
  input: ["kind", "id", "label", "required", "placeholder", "value", "inputType", "multiline", "min", "max", "step"],
  card: ["kind", "id", "title", "sub", "glyph", "badge", "role"],
} as const;

export const SCREEN_FIELDS = ["id", "title", "subtitle", "sections"] as const;
export const SECTION_FIELDS = ["id", "header", "rows"] as const;
export const BADGE_FIELDS = ["text", "tone"] as const;
export const GLYPH_FIELDS = ["char", "tone"] as const;
export const OPTION_FIELDS = ["id", "label"] as const;

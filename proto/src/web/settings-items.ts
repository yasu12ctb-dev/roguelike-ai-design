// 設定シートの「純データ層」（U1a）。DOM 非依存・副作用ゼロ・Node から import 可。
// 目的＝表示（ラベル文字列）と分岐（安定 ID）を分離し、押された項目の特定を
// 表示文字列の includes 一致から **安定 ID** へ移す（prototype-spec §10.1b の先行足場）。
//
// ★ラベルの文字列・並び順・グループ見出しは v0.166.0 の legacy settingsSheet と 1文字も変えない
//   （挙動不変を tools/settings-parity.ts が 15,552 状態で機械照合する）。
// ★ここには副作用を置かない（実行は settings-handlers.ts の factory 側）。

export type Sz = "lg" | "md" | "sm";
export type DpadPos = "right" | "left" | "center";

/** 設定項目の安定 ID（表示文言から独立・ルーティングはこれだけを見る）。IconId とは別語彙。 */
export type SettingId =
  | "help"
  | "audio-mute" | "bgm-toggle" | "bgm-volume" | "sfx-volume"
  | "dpad-toggle" | "dpad-position" | "dpad-size" | "dpad-autorun"
  | "lunge-button" | "guard-button" | "log-size"
  | "save-export" | "save-import" | "dev-tools" | "world-reset"
  | "close";

/** ラベル生成に必要な状態のスナップショット（グローバルを読まず引数で受ける＝純）。 */
export interface SettingsState {
  muted: boolean;
  bgmOn: boolean;
  bgmVol: number;
  sfxVol: number;
  dpadOn: boolean;
  dpadPos: DpadPos;
  dpadSize: Sz;
  autorun: boolean;
  lunge: boolean;
  guard: boolean;
  logSize: Sz;
}

export interface SettingDef {
  id: SettingId;
  /** グループ見出し（legacy と同じ項目・同じ位置に付く）。 */
  header?: string;
  /** 表示文字列（legacy の式をそのまま移送）。 */
  label: (s: SettingsState) => string;
}

const SZJP = { lg: "大", md: "中", sm: "小" } as const;
/** 音量→小中大（legacy の閾値をそのまま）。 */
export const volJp = (v: number): string => (v < 0.45 ? "小" : v < 0.72 ? "中" : "大");

/** 表示順は legacy の opts 配列と同順（先頭から 1..17 が sheet の pick 1..17 に対応）。 */
export const SETTING_DEFS: readonly SettingDef[] = [
  { id: "help", header: "あそびかた", label: () => "❓ あそびかた・記号の凡例" },
  { id: "audio-mute", header: "音", label: (s) => (s.muted ? "♪ 音を出す" : "🔇 すべての音を消す") },
  { id: "bgm-toggle", label: (s) => (s.bgmOn ? "🎵 BGM：オン → オフ" : "🎵 BGM：オフ → オン") },
  { id: "bgm-volume", label: (s) => `🎵 BGM音量：${volJp(s.bgmVol)}（小→中→大）` },
  { id: "sfx-volume", label: (s) => `🔊 効果音音量：${volJp(s.sfxVol)}（小→中→大）` },
  { id: "dpad-toggle", header: "操作・表示", label: (s) => (s.dpadOn ? "🕹 方向パッド：オン → オフ" : "🕹 方向パッド：オフ → オン") },
  { id: "dpad-position", label: (s) => `🕹 方向パッドの位置：${s.dpadPos === "right" ? "右下" : s.dpadPos === "left" ? "左下" : "中央"}（右下→左下→中央）` },
  { id: "dpad-size", label: (s) => `🕹 方向パッドの大きさ：${SZJP[s.dpadSize]}（大→中→小）` },
  { id: "dpad-autorun", label: (s) => (s.autorun ? "🕹 長押しで連続移動：オン → オフ" : "🕹 長押しで連続移動：オフ → オン") },
  { id: "lunge-button", label: (s) => (s.lunge ? "🥾 踏み込みボタン表示：オン → オフ" : "🥾 踏み込みボタン表示：オフ → オン") },
  { id: "guard-button", label: (s) => (s.guard ? "🛡 受け流しボタン表示（剣）：オン → オフ" : "🛡 受け流しボタン表示（剣）：オフ → オン") },
  { id: "log-size", label: (s) => `🔤 文字サイズ：${SZJP[s.logSize]}（小→中→大）` },
  { id: "save-export", header: "データ", label: () => "💾 セーブを書き出す（バックアップ）" },
  { id: "save-import", label: () => "📂 セーブを読み込む（復元）" },
  { id: "dev-tools", label: () => "🔧 テスト" },
  // ↓ legacy と同じく、役割は sheet() 側が自動判定する（"やり直す"＝danger／"閉じる"＝cancel）
  { id: "world-reset", label: () => "⟲ 世界を最初からやり直す" },
  { id: "close", label: () => "閉じる" },
] as const;

/** 1行ぶんの表示結果（sheet の options と 1:1・index も 1:1）。 */
export interface SettingRow { id: SettingId; label: string; header?: string }

/** 現在の状態から表示行を組む（legacy の opts と同じ内容・同じ順序）。 */
export function buildSettingLabels(s: SettingsState): SettingRow[] {
  return SETTING_DEFS.map((d) => (d.header ? { id: d.id, label: d.label(s), header: d.header } : { id: d.id, label: d.label(s) }));
}

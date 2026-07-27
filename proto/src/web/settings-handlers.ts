// 設定シートの「実行層」factory（U1a）。DOM 非依存・Node から import 可・tsc 対象。
//
// ★依存注入（DI）＝ main.ts は実依存を、テストは spy 依存を渡す。
//   これにより「production の handler そのもの」を Node から検査できる（テスト用の再実装をしない）。
// ★`Record<SettingId, Handler>` を返すので、SettingId を足して実装を忘れると **tsc がコンパイルエラー**
//   （`npm run typecheck` ＝ `npm run check` 同梱で機械検出）。
// ★中身の式・遷移順・reopen の有無は v0.166.0 の legacy settingsSheet と同一。

import type { DpadPos, SettingId, Sz } from "./settings-items.ts";

export interface Handler {
  /** 実行（legacy の各分岐の中身をそのまま）。 */
  run: () => void | Promise<void>;
  /** 実行後に設定シートを開き直すか（legacy の再帰有無と同一）。 */
  reopen: boolean;
}

/** handler が触る外界。実依存（main.ts）／spy（テスト）を差し替えられる。 */
export interface SettingDeps {
  ensureAudio(): void;
  isMuted(): boolean; setMuted(b: boolean): void;
  isBgmOn(): boolean; setBgmEnabled(b: boolean): void;
  bgmVolume(): number; setBgmVolume(v: number): void;
  sfxVolume(): number; setSfxVolume(v: number): void;
  sfx(kind: string): void;
  dpadOn(): boolean; setDpad(b: boolean): void;
  dpadPos(): DpadPos; setDpadPos(p: DpadPos): void;
  dpadSize(): Sz; setDpadSize(s: Sz): void;
  dpadAutorun(): boolean; setDpadAutorun(b: boolean): void;
  lungeShow(): boolean; setLungeShow(b: boolean): void;
  guardShow(): boolean; setGuardShow(b: boolean): void;
  logSize(): Sz; setLogSize(s: Sz): void;
  helpSheet(): Promise<void>;
  exportSave(): Promise<void>;
  importSave(): Promise<void>;
  testSheet(): Promise<void>;
  resetWorld(): Promise<void>;
}

/**
 * 全 SettingId の handler を組む。Record 型ゆえ **欠落は型エラー**。
 * 中身は legacy の各 `else if (c.includes(...))` ブロックと 1:1（式・順序・reopen を保存）。
 */
export function createSettingHandlers(d: SettingDeps): Record<SettingId, Handler> {
  return {
    "help": { run: () => d.helpSheet(), reopen: true },
    "audio-mute": { run: () => { d.ensureAudio(); d.setMuted(!d.isMuted()); }, reopen: true },
    "bgm-toggle": { run: () => { d.ensureAudio(); d.setBgmEnabled(!d.isBgmOn()); }, reopen: true },
    // 音量は 0.35 → 0.6 → 0.85 → 0.35 の循環（legacy の閾値・遷移順そのまま）
    "bgm-volume": { run: () => { d.ensureAudio(); d.setBgmVolume(d.bgmVolume() < 0.45 ? 0.6 : d.bgmVolume() < 0.72 ? 0.85 : 0.35); }, reopen: true },
    "sfx-volume": { run: () => { d.ensureAudio(); d.setSfxVolume(d.sfxVolume() < 0.45 ? 0.6 : d.sfxVolume() < 0.72 ? 0.85 : 0.35); d.sfx("equip"); }, reopen: true },
    "dpad-toggle": { run: () => d.setDpad(!d.dpadOn()), reopen: true },
    "dpad-position": { run: () => d.setDpadPos(d.dpadPos() === "right" ? "left" : d.dpadPos() === "left" ? "center" : "right"), reopen: true },
    "dpad-size": { run: () => d.setDpadSize(d.dpadSize() === "lg" ? "md" : d.dpadSize() === "md" ? "sm" : "lg"), reopen: true },
    "dpad-autorun": { run: () => d.setDpadAutorun(!d.dpadAutorun()), reopen: true },
    "lunge-button": { run: () => d.setLungeShow(!d.lungeShow()), reopen: true },
    "guard-button": { run: () => d.setGuardShow(!d.guardShow()), reopen: true },
    "log-size": { run: () => d.setLogSize(d.logSize() === "sm" ? "md" : d.logSize() === "md" ? "lg" : "sm"), reopen: true },
    "save-export": { run: () => d.exportSave(), reopen: true },
    "save-import": { run: () => d.importSave(), reopen: true },
    // legacy はこの2つの後に settingsSheet を再帰しない（testSheet/resetWorld が次の画面を持つ）
    "dev-tools": { run: () => d.testSheet(), reopen: false },
    "world-reset": { run: () => d.resetWorld(), reopen: false },
    // 「閉じる」＝何もせず終了（legacy はどの includes にも当たらず素通り）
    "close": { run: () => { /* no-op */ }, reopen: false },
  };
}

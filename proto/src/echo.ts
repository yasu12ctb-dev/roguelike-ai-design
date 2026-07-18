// 最期の残響（Last Echo・RFC rfc-last-echo.md／2026-07-18 方向性承認・P1）。
//  死の瞬間の選択（FinalAct）を後世の局所的な戦闘条件に降ろす。
//  ★新しい状態を保存しない＝既存 Fossil から決定論的に導出する純関数。SAVE_VERSION 据置・migrate 不要。
//  ブラウザセーフ（fs 非依存・variation.ts と types.ts のみ）＝web が enterFloor 初訪で盤面へ写す（engine 非改変）。

import type { Fossil, VariationStage } from "./types.ts";
import { computeVariation } from "./variation.ts";

/** 残響の4形＝finalAct.choice に一対一（既存 enum・全化石が保持）。 */
export type EchoKind = "calm" | "will" | "guard" | "curse";

export interface Echo {
  kind: EchoKind;             // 形＝finalAct.choice 由来
  tone: Fossil["tonePole"];   // 色と文言＝loss/myth/grudge
  mud: boolean;               // 濁り＝exposureAtDeath が牙の閾値以上＝恩恵に代償が付く
  stage: VariationStage;      // 風化＝既存の変質クロック（weathered/twisting/alien）がそのまま残響に流れる
  note?: string;              // 遺言の実文（leave_will のみ・プレイヤーが死亡時に書いた一行）
}

/** 濁り閾値＝深蝕の牙（CORRUPTION_DRAIN_FROM）と同値。ここ以上で死んだ先代の残響は濁る（テスト調整候補）。 */
export const ECHO_MUD_AT = 1.5;

const KIND_OF: Record<string, EchoKind> = {
  accept: "calm",
  leave_will: "will",
  guard_relic: "guard",
  curse_dungeon: "curse",
};

/** 化石から現在の残響を導出（保存しない）。finalAct.choice が既知の4種でなければ null。
 *  対象の限定（自血統のみ・配置済みか）は呼び出し側（web enterFloor）の責務＝この関数は純粋に形を返す。 */
export function computeEcho(fossil: Fossil, worldTime: number): Echo | null {
  const kind = KIND_OF[fossil.death.finalAct.choice];
  if (!kind) return null;
  const v = computeVariation(fossil, worldTime); // 風化＝既存クロック（放置で進む・干渉で巻き戻る＝4-1C が残響にも通る）
  return {
    kind,
    tone: fossil.tonePole,
    mud: fossil.exposureAtDeath >= ECHO_MUD_AT,
    stage: v.stage,
    note: fossil.death.finalAct.note,
  };
}

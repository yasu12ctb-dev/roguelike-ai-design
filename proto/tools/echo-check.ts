// 最期の残響（RFC・P1）computeEcho 純度テスト（手動・CI 非同梱）：形＝finalAct、濁り＝exposureAtDeath 閾値、
//  風化＝computeVariation の stage が流れること、決定論（同入力→同出力）を裏取り。
//  実行：node --experimental-strip-types tools/echo-check.ts

import { computeEcho, ECHO_MUD_AT } from "../src/echo.ts";
import { computeVariation } from "../src/variation.ts";
import type { Fossil, FinalActChoice, TonePole } from "../src/types.ts";

let fail = 0, checks = 0;
const ok = (name: string, cond: boolean, extra = "") => { checks++; if (!cond) { fail++; console.log(`❌ ${name} ${extra}`); } else console.log(`✅ ${name}`); };

function mkFossil(choice: FinalActChoice, opts: { exp?: number; depth?: number; tone?: TonePole; note?: string; lastTouched?: number } = {}): Fossil {
  return {
    id: "f", kind: "character",
    origin: { name: "先代", archetype: "wanderer", gearTags: [], epithet: "" },
    death: { manner: "grievous", finalAct: { choice, note: opts.note }, depth: opts.depth ?? 20, generationCreated: 0 },
    exposureAtDeath: opts.exp ?? 0, bondAtDeath: 0, tonePole: opts.tone ?? "loss",
    interventions: [], lastTouchedGeneration: opts.lastTouched ?? 0, laidDepth: opts.depth ?? 20,
  } as Fossil;
}

// ① 形＝finalAct.choice に一対一。
ok("①accept→calm", computeEcho(mkFossil("accept"), 0)?.kind === "calm");
ok("①leave_will→will", computeEcho(mkFossil("leave_will"), 0)?.kind === "will");
ok("①guard_relic→guard", computeEcho(mkFossil("guard_relic"), 0)?.kind === "guard");
ok("①curse_dungeon→curse", computeEcho(mkFossil("curse_dungeon"), 0)?.kind === "curse");

// ② 濁り＝exposureAtDeath >= ECHO_MUD_AT（牙の閾値 1.5）。
ok("②exp<閾値は濁らない", computeEcho(mkFossil("accept", { exp: ECHO_MUD_AT - 0.01 }), 0)?.mud === false);
ok("②exp>=閾値は濁る", computeEcho(mkFossil("accept", { exp: ECHO_MUD_AT }), 0)?.mud === true);

// ③ 色＝tonePole がそのまま流れる。
ok("③tone=grudge が流れる", computeEcho(mkFossil("curse_dungeon", { tone: "grudge" }), 0)?.tone === "grudge");

// ④ 風化＝computeVariation の stage がそのまま残響に流れる（深部×放置で twisting/alien へ）。
{
  const f = mkFossil("accept", { depth: 50, exp: 0, lastTouched: 0 });
  const wt = 40; // 十分に経った世界時間
  const e = computeEcho(f, wt);
  const v = computeVariation(f, wt);
  ok("④stage は computeVariation と一致", e?.stage === v.stage, `echo=${e?.stage} var=${v.stage}`);
  // 放置で進む（worldTime 大→ stage が進みやすい）。
  const eEarly = computeEcho(f, 0), eLate = computeEcho(f, 60);
  const rank = { weathered: 0, twisting: 1, alien: 2 } as const;
  ok("④放置（worldTime 大）で風化が進む（後退しない）", rank[eLate!.stage] >= rank[eEarly!.stage], `early=${eEarly?.stage} late=${eLate?.stage}`);
}

// ⑤ 遺言の実文（note）が流れる。
ok("⑤note が流れる", computeEcho(mkFossil("leave_will", { note: "後を頼む" }), 0)?.note === "後を頼む");
ok("⑤note 無しは undefined", computeEcho(mkFossil("leave_will"), 0)?.note === undefined);

// ⑥ 決定論＝同入力→同出力（保存しない純関数）。
{
  const f = mkFossil("guard_relic", { exp: 1.6, tone: "myth", depth: 33 });
  ok("⑥同入力→同出力", JSON.stringify(computeEcho(f, 12)) === JSON.stringify(computeEcho(f, 12)));
}

console.log(`\n=== echo-check：${checks - fail}/${checks} pass（fail=${fail}）===`);
if (fail) process.exit(1);

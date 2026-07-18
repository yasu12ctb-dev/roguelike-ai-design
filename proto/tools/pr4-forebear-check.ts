// PR-4（先代の噂・予兆）検証（手動・CI 非同梱）：①renderRumor が斃れた自キャラ化石で throw しない
//  （rumorScene と同じ呼び経路＝多数サンプルで裏取り）②fallenForebear 相当のロジック（最新の斃れた自血統）
//  ③死亡深度帯 cue の世代別 flag 一度きりゲート、を実データで確認する。
//  実行：node --experimental-strip-types tools/pr4-forebear-check.ts

import { loadContent } from "../src/content-node.ts";
import { newWorld, createCharacter, fossilizeCurrent } from "../src/world.ts";
import { renderRumor } from "../src/render.ts";
import { makeRng } from "../src/rng.ts";
import type { Fossil, World } from "../src/types.ts";

const db = loadContent();
let fail = 0, checks = 0;
const ok = (name: string, cond: boolean, extra = "") => { checks++; if (!cond) { fail++; console.log(`❌ ${name} ${extra}`); } else console.log(`✅ ${name}`); };

// fallenForebear の複製（main.ts と同一ロジック＝斃れた自血統の最新）。
const isOwnLine = (f: Fossil) => f.kind === "character" && !f.wasCompanion && !f.wasAlly;
function fallenForebear(w: World): Fossil | null { let last: Fossil | null = null; for (const f of w.fossils) if (isOwnLine(f) && !f.retired) last = f; return last; }

// ① 世代を重ね、斃れた先代を多数生成 → renderRumor が一度も throw しないこと（rumorScene と同経路）。
const world = newWorld(777);
let renderCount = 0;
for (let g = 0; g < 30; g++) {
  const depth = 3 + (g % 40);
  const ch = createCharacter(world, `探索者${g}`, "wanderer", { relation: "none" });
  ch.depth = depth; ch.level = depth;
  fossilizeCurrent(world, g % 2 ? "grievous" : "betrayed", { choice: g % 3 ? "accept" : "curse_dungeon" });
  world.generation++;
  const fb = fallenForebear(world);
  if (fb) {
    // 局所 rng で 50 回描画（frame 抽選のばらつきを網羅）＝throw ゼロを裏取り。
    for (let i = 0; i < 50; i++) {
      const rf = makeRng((world.seed ^ (world.generation * 2654435761) ^ (i * 40503)) >>> 0);
      const s = renderRumor(db, rf, fb);
      renderCount++;
      if (typeof s !== "string" || s.length === 0) { fail++; console.log(`❌ renderRumor 空文字 g=${g}`); }
    }
  }
}
ok(`①renderRumor が斃れた自キャラ化石で throw/空なし（${renderCount} 描画）`, fail === 0);

// ② fallenForebear＝最新の斃れた自血統（退隠は除外・相棒/縁NPC化石は除外）。
{
  const w = newWorld(42);
  const c1 = createCharacter(w, "先々代", "wanderer", { relation: "none" }); c1.depth = 10;
  fossilizeCurrent(w, "grievous", { choice: "accept" }); w.generation++;
  const c2 = createCharacter(w, "先代", "wanderer", { relation: "none" }); c2.depth = 20;
  const f2 = fossilizeCurrent(w, "betrayed", { choice: "curse_dungeon" }); w.generation++;
  const fb = fallenForebear(w);
  ok("②forebear は最新の斃れた自血統（先代）", fb?.id === f2.id, `got=${fb?.origin.name}`);
  // 相棒/縁NPC化石を混ぜても拾わない（wasCompanion/wasAlly を除外）。
  w.fossils.push({ ...f2, id: "ally_x", wasAlly: true });
  w.fossils.push({ ...f2, id: "comp_x", wasCompanion: true });
  const fb2 = fallenForebear(w);
  ok("②相棒/縁NPC化石は forebear に混ざらない", fb2?.id === f2.id, `got=${fb2?.id}`);
  // 退隠のみなら null。
  const w2 = newWorld(9); const cr = createCharacter(w2, "退隠者", "wanderer", { relation: "none" }); cr.depth = 12;
  const fr = fossilizeCurrent(w2, "peaceful", { choice: "accept" }); fr.retired = true;
  ok("②退隠（生者）のみなら forebear=null", fallenForebear(w2) === null);
  ok("②gen1（自キャラ化石なし）は forebear=null", fallenForebear(newWorld(1)) === null);
}

// ③ 死亡深度帯 cue の世代別 flag 一度きりゲート（main.ts enterFloor と同じ条件）。
{
  const w = newWorld(5);
  const ch = createCharacter(w, "亡", "wanderer", { relation: "none" }); ch.depth = 8;
  const fb0 = fossilizeCurrent(w, "grievous", { choice: "accept" }); w.generation++;
  createCharacter(w, "次代", "wanderer", { relation: "none" });
  const foreb = fallenForebear(w)!;
  const flags: string[] = [];
  const fire = (depth: number): boolean => {
    const cueFlag = `cue_forebear_g${w.generation}`;
    if (foreb && depth >= foreb.laidDepth && !flags.includes(cueFlag)) { flags.push(cueFlag); return true; }
    return false;
  };
  ok("③死亡深度未満では cue が出ない", !fire(4) && !fire(7));
  ok("③死亡深度到達で一度だけ出る", fire(8) === true);
  ok("③以後の潜行では再表示しない（同世代）", !fire(9) && !fire(20) && !fire(8));
  ok("③死亡深度＝先代 laidDepth", foreb.laidDepth === fb0.laidDepth && fb0.laidDepth === 8);
}

console.log(`\n=== PR-4 forebear-check：${checks - (fail ? 1 : 0)}/${checks} 系列 pass（fail=${fail}）===`);
if (fail) process.exit(1);

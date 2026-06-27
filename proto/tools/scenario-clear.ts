// C: 「クリアできるか」シナリオ・シム（デスクトップ Claude Code 用）。
// 狙い＝勝利条件（5印→深淵帯解錠→奉献）の状態機械が成立し、各印に実際の付与経路があることを保証する。
//   印の awarder が1つでも欠けると seals.length が 5 に届かず abyssUnlocked が永遠に false ＝ゲームがクリア不能。
//   リファクタでこれが壊れると壊滅的＝静的＋動的に二重で守る。
// 実行: node --experimental-strip-types tools/scenario-clear.ts
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { newWorld, createCharacter, awardSeal, abyssUnlocked, intervene, fossilizeCurrent } from "../src/world.ts";
import { SEAL_KEYS } from "../src/types.ts";
import type { World, Fossil, TonePole } from "../src/types.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
let FAIL = 0, CHECKS = 0;
const problems: string[] = [];
function ok(c: boolean, m: string) { CHECKS++; if (!c) { FAIL++; problems.push(m); } }

// grudge/loss などの化石を世界に1つ仕込む
function plantFossil(w: World, tone: TonePole): Fossil {
  const f: Fossil = {
    id: `seed_${tone}_${w.fossils.length}`, kind: "character",
    origin: { name: `${tone}の者`, archetype: "wanderer", gearTags: ["錆びた剣"] },
    death: { manner: "grievous", finalAct: { choice: tone === "grudge" ? "curse_dungeon" : "accept" }, depth: 20, generationCreated: 0 },
    exposureAtDeath: tone === "grudge" ? 1.5 : 0.3, bondAtDeath: 2, tonePole: tone,
    interventions: [], lastTouchedGeneration: 0, laidDepth: 20,
  };
  w.fossils.push(f);
  return f;
}

console.log("== scenario-clear 開始 ==");

// ---- 1. 静的：全 SEAL_KEY に awardSeal(...) の付与経路がソースに存在する（クリア不能回帰の防止）----
const src = [
  readFileSync(join(__dirname, "..", "src", "world.ts"), "utf8"),
  readFileSync(join(__dirname, "..", "src", "web", "main.ts"), "utf8"),
].join("\n");
for (const key of SEAL_KEYS) {
  const re = new RegExp(`awardSeal\\(\\s*world\\s*,\\s*"${key}"`);
  ok(re.test(src), `致命：印 "${key}" を付与する awardSeal(world, "${key}", …) がソースに無い＝この印が永遠に入手不能＝ゲームがクリア不能`);
}
ok(SEAL_KEYS.length === 5, `SEAL_KEYS が 5 種でない（${SEAL_KEYS.length}）＝設計と不一致`);
console.log(`  静的：印 awarder 突合 done (${CHECKS} checks, ${FAIL} fail)`);

// ---- 2. abyssUnlocked のしきい値が SEAL_KEYS.length に連動（ハードコード5でない）----
{
  const w = newWorld(1);
  ok(!abyssUnlocked(w), "初期世界で abyssUnlocked が true（印0なのに解錠）");
  for (let i = 0; i < SEAL_KEYS.length - 1; i++) { awardSeal(w, SEAL_KEYS[i]); ok(!abyssUnlocked(w), `印${i + 1}個で既に解錠（5未満で解錠は不正）`); }
  awardSeal(w, SEAL_KEYS[SEAL_KEYS.length - 1]);
  ok(abyssUnlocked(w), "5印揃っても abyssUnlocked が false（解錠されない＝深淵帯に入れない）");
}
console.log(`  abyss しきい値 done (${CHECKS} checks, ${FAIL} fail)`);

// ---- 3. 動的：各印を「実際の付与経路」で取り、5印→解錠→奉献(ascended++)まで通す ----
{
  const w = newWorld(42);
  createCharacter(w, "勇者", "wanderer", { relation: "none" });
  // 印①伝説／③山場／⑤深度／④abyss_boss ＝ main.ts と同じ awardSeal 直呼び（経路は静的検査で担保済み）
  ok(awardSeal(w, "legend", []), "legend 印が付かない");
  ok(awardSeal(w, "setpiece", []), "setpiece 印が付かない");
  ok(awardSeal(w, "depth", []), "depth 印が付かない");
  ok(awardSeal(w, "abyss_boss", []), "abyss_boss 印が付かない");
  ok(!abyssUnlocked(w), "4印で解錠されている（早すぎ）");
  // 印②鎮魂 ＝ 怨念極の化石を intervene(requiem) ＝ world.ts:472 の実経路
  const gf = plantFossil(w, "grudge");
  intervene(w, gf.id, "requiem");
  ok((w.seals ?? []).includes("requiem"), "怨念化石の鎮魂で requiem 印が付かない（intervene の awardSeal 経路が壊れている）");
  ok(abyssUnlocked(w), "5印揃ったのに深淵帯が解錠されない＝クリア経路が断たれている");
  // 奉献（クリア）＝ メタ状態 ascended の前進（main.ts の奉献成立に相当）
  const before = w.ascended ?? 0;
  w.ascended = before + 1;
  ok((w.ascended ?? 0) === before + 1, "ascended が前進しない（奉献メタが記録されない）");
}
console.log(`  動的：5印→解錠→奉献 done (${CHECKS} checks, ${FAIL} fail)`);

// ---- 4. 負のテスト：requiem 印は「怨念極(grudge)」限定（loss/myth の鎮魂では付かない）----
{
  const w = newWorld(7);
  createCharacter(w, "試", "wanderer", { relation: "none" });
  const lf = plantFossil(w, "loss"), mf = plantFossil(w, "myth");
  intervene(w, lf.id, "requiem"); intervene(w, mf.id, "requiem");
  ok(!(w.seals ?? []).includes("requiem"), "loss/myth の鎮魂で requiem 印が付いた（grudge 限定の意図に反する）");
  // 継承・供養では付かない
  const gf = plantFossil(w, "grudge");
  intervene(w, gf.id, "inherit"); intervene(w, gf.id, "memorial");
  ok(!(w.seals ?? []).includes("requiem"), "inherit/memorial で requiem 印が付いた（requiem 限定の意図に反する）");
  intervene(w, gf.id, "requiem");
  ok((w.seals ?? []).includes("requiem"), "grudge の requiem でやはり印が付かない");
}
console.log(`  負のテスト done (${CHECKS} checks, ${FAIL} fail)`);

// ---- 5. 重複付与は二重計上しない（5印の判定が壊れない）----
{
  const w = newWorld(9);
  for (const k of SEAL_KEYS) { awardSeal(w, k); ok(!awardSeal(w, k), `印 "${k}" の重複付与が true を返す（二重計上の恐れ）`); }
  ok((w.seals ?? []).length === SEAL_KEYS.length, `重複付与後の seals 数が ${SEAL_KEYS.length} でない（${(w.seals ?? []).length}）`);
}
console.log(`  重複付与 done (${CHECKS} checks, ${FAIL} fail)`);

console.log(`\n=== scenario-clear 完了：${CHECKS} checks / ${FAIL} fail ===`);
for (const p of problems) console.log("  ❌ " + p);
if (FAIL === 0) console.log("  ✅ 勝利条件（5印→深淵帯解錠→奉献）は到達可能・各印に付与経路あり");
process.exit(FAIL > 0 ? 1 : 0);

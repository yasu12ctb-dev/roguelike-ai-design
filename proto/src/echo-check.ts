// 残響召喚の遺灰（4-10I・snapshot 524）の純粋ロジックの決定論テスト。
// grant（鎮魂＝種・farm防止・神話極限定・威力スナップショット）と consume（消費＋代償）を検証。
// DOM 依存の展開演出（spawnSummon/chooseGrid/endTurn）は対象外＝web/main.ts に据え置き（リポジトリ方針）。
// 実行：node --experimental-strip-types src/echo-check.ts
import { newWorld, createCharacter, intervene, migrateWorld, grantEchoOnRequiem, consumeEcho, ECHO_DEPLOY_COST } from "./world.ts";
import type { Fossil, TonePole, World } from "./types.ts";

let pass = 0, fail = 0;
function eq(label: string, got: unknown, want: unknown) {
  if (JSON.stringify(got) === JSON.stringify(want)) { pass++; }
  else { fail++; console.log(`  ❌ ${label}: got=${JSON.stringify(got)} want=${JSON.stringify(want)}`); }
}

let fid = 0;
/** テスト用の化石を作って world.fossils に積む（極と深度を指定）。 */
function mkFossil(world: World, tonePole: TonePole, depth: number, name = "英雄テスト"): Fossil {
  const f: Fossil = {
    id: `fossil_test_${++fid}`,
    kind: "explorer",
    origin: { name, archetype: "delver", gearTags: ["試剣"] },
    death: { manner: "peaceful", finalAct: { choice: "accept" }, depth, generationCreated: 0 },
    exposureAtDeath: 1.0, bondAtDeath: 0, tonePole,
    interventions: [], lastTouchedGeneration: 0, laidDepth: depth,
  };
  world.fossils.push(f);
  return f;
}

console.log("== migrate 後方互換（echoes 欠落の補完） ==");
{
  const w = newWorld(1) as World & { echoes?: unknown };
  eq("newWorld 直後は echoes 未設定", w.echoes, undefined);
  migrateWorld(w);
  eq("migrate で echoes=[] に補完", w.echoes, []);
  // 既存の echoes は保持（破壊しない）
  const w2 = newWorld(2);
  w2.echoes = [{ fossilId: "x", name: "誰か", dmg: 9 }];
  migrateWorld(w2);
  eq("既存 echoes は保持", w2.echoes, [{ fossilId: "x", name: "誰か", dmg: 9 }]);
}

console.log("== 神話極ゲート（鎮魂＝種） ==");
{
  const w = newWorld(10); migrateWorld(w);
  createCharacter(w, "弔人", "delver", { relation: "none" });
  const f = mkFossil(w, "myth", 10, "伝説のミナ");
  intervene(w, f.id, "requiem"); // 必ず grant の前に requiem を記録
  const ash = grantEchoOnRequiem(w, f, 10);
  eq("神話極の初回鎮魂で遺灰1つ", w.echoes!.length, 1);
  eq("戻り値は付与した遺灰", ash, { fossilId: f.id, name: "伝説のミナ", dmg: 11 });
  eq("遺灰の由来名＝origin.name", w.echoes![0].name, "伝説のミナ");
}

console.log("== 非神話極では付与しない（loss / grudge） ==");
{
  const w = newWorld(11); migrateWorld(w);
  const loss = mkFossil(w, "loss", 10);
  intervene(w, loss.id, "requiem");
  eq("loss 極は null", grantEchoOnRequiem(w, loss, 10), null);
  const grudge = mkFossil(w, "grudge", 10);
  intervene(w, grudge.id, "requiem");
  eq("grudge 極は null", grantEchoOnRequiem(w, grudge, 10), null);
  eq("付与は0のまま", w.echoes!.length, 0);
}

console.log("== farm 防止（1化石1遺灰・世代越え再鎮魂で増えない） ==");
{
  const w = newWorld(12); migrateWorld(w);
  const f = mkFossil(w, "myth", 20);
  intervene(w, f.id, "requiem");
  const first = grantEchoOnRequiem(w, f, 20);
  eq("初回は付与", first !== null, true);
  // 後世で同じ化石を再び鎮魂（世代を進めて再 intervene）
  w.generation += 1;
  intervene(w, f.id, "requiem"); // interventions に requiem が2件になる
  const second = grantEchoOnRequiem(w, f, 20);
  eq("2回目は null（farm 防止）", second, null);
  eq("遺灰は1つのまま", w.echoes!.length, 1);
}

console.log("== 威力スナップショット dmg=max(5, round(4+depth*0.7)) ==");
{
  const w = newWorld(13); migrateWorld(w);
  const at = (depth: number) => {
    const f = mkFossil(w, "myth", depth);
    intervene(w, f.id, "requiem");
    return grantEchoOnRequiem(w, f, depth)!.dmg;
  };
  eq("depth 0 → 下限5", at(0), 5);
  eq("depth 1 → 5", at(1), 5);     // round(4.7)=5
  eq("depth 10 → 11", at(10), 11);
  eq("depth 30 → 25", at(30), 25);
  eq("depth 50 → 39", at(50), 39); // round(4+35)=39
}

console.log("== 消費＝展開の対価（consumeEcho） ==");
{
  const w = newWorld(14); migrateWorld(w);
  const ch = createCharacter(w, "使い手", "delver", { relation: "none" });
  ch.exposure = 0;
  w.echoes = [
    { fossilId: "a", name: "甲", dmg: 10 },
    { fossilId: "b", name: "乙", dmg: 12 },
  ];
  const got = consumeEcho(w, ch, 0);
  eq("取り出した遺灰を返す", got, { fossilId: "a", name: "甲", dmg: 10 });
  eq("遺灰が1つ減る", w.echoes.length, 1);
  eq("残るのは乙", w.echoes[0].name, "乙");
  eq("代償＝深蝕＋0.3", ch.exposure, ECHO_DEPLOY_COST);
  // 範囲外・空は null（副作用なし）
  eq("範囲外は null", consumeEcho(w, ch, 5), null);
  eq("範囲外で長さ不変", w.echoes.length, 1);
  eq("範囲外で深蝕不変", ch.exposure, ECHO_DEPLOY_COST);
  consumeEcho(w, ch, 0);
  eq("空にできる", w.echoes.length, 0);
  eq("空配列は null", consumeEcho(w, ch, 0), null);
}

console.log(`\n=== echo-check: ${pass} pass / ${fail} fail ===`);
if (fail > 0) process.exit(1);

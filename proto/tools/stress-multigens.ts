// 多世代ストレス検査（デスクトップ Claude Code 用）。
// 狙い＝実機テストプレイで連続発覚した2つの「world 由来の id／状態が世代に正しくスコープされない」バグクラスを、
//   多世代を実遷移させて機械的に捕捉し、回帰を防ぐ。既存 stress-save（単発移行）では届かない領域。
//   ① クエスト持ち越し：先代の受注が次代のギルドに「受注中」で残らないこと。
//   ② 化石ID衝突：再読込で idCounter が 0 に戻り新規化石がシード化石と衝突しても、
//      migrateWorld の自己修復（selfHealDuplicateIds）が dedup＋参照追従＋継承再導出すること。
// 実行: node --experimental-strip-types tools/stress-multigens.ts
import {
  newWorld, createCharacter, fossilizeCurrent, migrateWorld,
} from "../src/world.ts";
import { generateOffers } from "../src/quests.ts";
import { makeRng } from "../src/rng.ts";
import type { World, Character, Fossil, Lineage, Quest } from "../src/types.ts";

let FAIL = 0, CHECKS = 0;
const problems: string[] = [];
function bad(m: string) { FAIL++; if (problems.length < 100) problems.push(m); }
function ok(c: boolean, m: string) { CHECKS++; if (!c) bad(m); }
const clone = (w: World): World => JSON.parse(JSON.stringify(w));

const SPELL_POOL = ["ember", "mend", "homeward", "ward", "blink", "rend", "hush", "lure"];
function lastCharFossil(w: World): Fossil | undefined {
  return [...w.fossils].reverse().find((f) => f.kind === "character");
}
function dupIds(w: World): boolean {
  const ids = w.fossils.map((f) => f.id);
  return new Set(ids).size !== ids.length;
}
// 化石を指す参照が必ず実在化石へ解決すること（宙ぶらりん参照＝find→undefined の静かな失敗を検出）。
// ★bonds.entityRef は生者アクター/tracked も指しうる（main.ts）ので対象外。化石必須の3種だけ検査。
function assertRefsResolve(w: World, tag: string): void {
  const ids = new Set(w.fossils.map((f) => f.id));
  const ch = w.current;
  if (ch?.lineage && ch.lineage.relation !== "none" && ch.lineage.ancestorFossilId) {
    ok(ids.has(ch.lineage.ancestorFossilId), `${tag}: lineage.ancestorFossilId が宙ぶらりん (${ch.lineage.ancestorFossilId})`);
  }
  for (const t of w.tracked ?? []) {
    if (t.originRef) ok(ids.has(t.originRef), `${tag}: tracked.originRef が宙ぶらりん (${t.id}→${t.originRef})`);
  }
  for (const q of w.quests ?? []) {
    if (q.kind === "reclaim" && q.targetFossilId) ok(ids.has(q.targetFossilId), `${tag}: quest.targetFossilId が宙ぶらりん (${q.id}→${q.targetFossilId})`);
  }
}
// 1世代ぶんの実遷移：継承キャラを作り、術/依頼/絆を持たせ、化石化（世代交代）。
function liveOneGen(w: World, gen: number): void {
  const anc = lastCharFossil(w);
  const lin: Lineage = anc
    ? (gen % 2 === 0
        ? { relation: "pupil", ancestorFossilId: anc.id }
        : { relation: "blood", ancestorFossilId: anc.id, chosenSpells: (anc.spells ?? []).slice(0, 2) })
    : { relation: "none" };
  const ch = createCharacter(w, `世代${gen}`, "wanderer", lin);
  // 継承の正しさ（先代に術がある場合）：blood=min(picks,2)・pupil=min(anc.spells,4)。
  if (anc && (anc.spells?.length ?? 0) > 0) {
    if (lin.relation === "pupil") ok(ch.spells.length === Math.min(anc.spells!.length, 4), `gen${gen}: pupil 継承術数 ${ch.spells.length} != ${Math.min(anc.spells!.length, 4)}`);
    if (lin.relation === "blood") ok(ch.spells.length === Math.min((lin.chosenSpells ?? []).length, 2), `gen${gen}: blood 継承術数 ${ch.spells.length} != ${Math.min((lin.chosenSpells ?? []).length, 2)}`);
    // 先代解決：ancestorFossilId が正しく直近 character 化石に解決すること（シードにすり替わっていない）。
    const resolved = w.fossils.find((f) => f.id === lin.ancestorFossilId);
    ok(resolved?.kind === "character", `gen${gen}: ancestorFossilId が character 化石に解決しない`);
  }
  // 術を持たせる（化石に遺り次代へ滲む）。世代で種類を変えて固定パターンを避ける。
  for (let i = 0; i < 5; i++) { const k = SPELL_POOL[(gen + i) % SPELL_POOL.length]; if (!ch.spells.includes(k)) ch.spells.push(k); }
  ch.level = 8 + (gen % 30);
  // 依頼を当世代で受注（issuedGeneration＝現世代）。
  const q1: Quest = { id: `qtest_${gen}_a`, kind: "descend", title: "到達", desc: "", targetDepth: 12, rewardGold: 50, status: "active", issuedGeneration: w.generation };
  const q2: Quest = { id: `qtest_${gen}_b`, kind: "reclaim", title: "回収", desc: "", targetFossilId: anc?.id, targetDepth: 10, rewardGold: 40, status: "active", issuedGeneration: w.generation };
  (w.quests ??= []).push(q1, q2);
  fossilizeCurrent(w, "combat", { choice: "accept" });
  // 各世代後の不変条件。
  ok(w.quests.every((q) => q.issuedGeneration >= w.generation), `gen${gen}: 旧世代クエストが持ち越されている`); // ①
  ok(!dupIds(w), `gen${gen}: 化石 id に重複`); // ②
  assertRefsResolve(w, `gen${gen}`); // ③ 化石参照の宙ぶらりん検出
}

// ───────── ① N世代の実遷移＋各世代後の不変条件（多 seed） ─────────
for (let seed = 1; seed <= 30; seed++) {
  const w = newWorld(seed);
  for (let gen = 1; gen <= 5; gen++) liveOneGen(w, gen);
  // 移行往復後も不変（途中保存→再開を模す）。
  const w2 = migrateWorld(clone(w));
  ok(!dupIds(w2), `seed${seed}: 移行後に化石 id 重複`);
  ok((w2.quests ?? []).every((q) => q.issuedGeneration >= w2.generation), `seed${seed}: 移行後にクエスト持ち越し`);
  assertRefsResolve(w2, `seed${seed} 移行後`);
}

// ───────── ② 意図的二重id化 → migrateWorld 自己修復の検証（多 seed） ─────────
// 再読込で新規化石がシード化石(fossil_1)と衝突した状態を再現し、migrateWorld が dedup＋継承再導出することを確認。
for (let seed = 1; seed <= 30; seed++) {
  const base = newWorld(seed);
  for (let gen = 1; gen <= 3; gen++) liveOneGen(base, gen);
  // 衝突させるプレイヤー化石（術あり）と、温存されるべきシード化石(fossil_1)。
  const victim = lastCharFossil(base);
  const seedFossil = base.fossils.find((f) => f.kind === "explorer");
  if (!victim || !seedFossil) { bad(`seed${seed}: テスト前提（victim/seed 化石）が無い`); continue; }
  const collideId = seedFossil.id; // 例：fossil_1
  const victimSpells = [...(victim.spells ?? [])];
  ok(victimSpells.length > 0, `seed${seed}: victim に術が無い（テスト前提）`);

  // (b)+(c) fresh 継承キャラのケース：衝突で先代がシードにすり替わり継承が壊れた状態を作る。
  {
    const w = clone(base);
    const v = w.fossils.find((f) => f.id === victim.id)!;
    v.id = collideId; // ★衝突：プレイヤー化石 id をシード化石 id に上書き
    // この victim を指していた参照を collideId に揃える（find が先頭=シードを返す＝バグ再現）。
    const fresh: Character = {
      id: "ch_fresh", name: "継ぐ者", archetype: "wanderer",
      lineage: { relation: "pupil", ancestorFossilId: collideId },
      traits: [], exposure: 0, depth: 0, bonds: [{ entityRef: collideId, value: 2, unfinished: true }], alive: true,
      stats: { body: 2, power: 2, reason: 2, heart: 2 }, level: 1, xp: 0, spells: [], loadout: [],
      equipment: { weapon: null, armor: null, relic: null, bag: null }, gold: 0, inventory: [], gearBag: [],
    };
    w.current = fresh;
    ok(w.fossils.find((f) => f.id === collideId)?.kind === "explorer", `seed${seed}: 修復前は find が先頭=シードを返す（前提）`);

    const healed = migrateWorld(clone(w));
    ok(!dupIds(healed), `seed${seed}: (a) 修復後も id 重複`);
    assertRefsResolve(healed, `seed${seed} 修復後`); // dedup が全 fossil-ref を張替＝宙ぶらりんを残さない
    ok(healed.fossils.filter((f) => f.id === collideId).length === 1 && healed.fossils.find((f) => f.id === collideId)?.kind === "explorer", `seed${seed}: (a) シード fossil_1 が温存されていない`);
    const hc = healed.current!;
    const ancNow = healed.fossils.find((f) => f.id === hc.lineage.ancestorFossilId);
    ok(ancNow?.kind === "character", `seed${seed}: (b) ancestorFossilId が character 化石に張替されていない`);
    ok((ancNow?.spells?.length ?? 0) > 0, `seed${seed}: (b) 張替先の先代に術が無い`);
    ok(hc.spells.length === Math.min(victimSpells.length, 4), `seed${seed}: (c) 継承再導出の術数 ${hc.spells.length} != ${Math.min(victimSpells.length, 4)}`);
    ok(hc.bonds.some((b) => b.entityRef === hc.lineage.ancestorFossilId), `seed${seed}: (c) 系譜 bond が張替先を指していない`);
    ok(hc.traits.some((t) => /の教え$/.test(t)), `seed${seed}: (c) 系譜 trait が再付与されていない`);

    // (e) 冪等：もう一度 migrate しても変化なし。
    const twice = migrateWorld(clone(healed));
    ok(JSON.stringify(twice) === JSON.stringify(healed), `seed${seed}: (e) 自己修復が冪等でない`);
  }

  // (d) 進行済みキャラは触らない：同じ衝突でも xp>0 なら継承再導出しない（spells 不変）。
  {
    const w = clone(base);
    const v = w.fossils.find((f) => f.id === victim.id)!;
    v.id = collideId;
    const progressed: Character = {
      id: "ch_prog", name: "歩いた者", archetype: "wanderer",
      lineage: { relation: "pupil", ancestorFossilId: collideId },
      traits: ["誰かの教え"], exposure: 0.5, depth: 9, bonds: [{ entityRef: collideId, value: 2, unfinished: true }], alive: true,
      stats: { body: 5, power: 4, reason: 3, heart: 3 }, level: 9, xp: 5, spells: ["ember"], loadout: ["ember"],
      equipment: { weapon: null, armor: null, relic: null, bag: null }, gold: 0, inventory: [], gearBag: [],
    };
    w.current = progressed;
    const healed = migrateWorld(clone(w));
    ok(!dupIds(healed), `seed${seed}: (d) 進行済みでも id 重複は解消する`);
    assertRefsResolve(healed, `seed${seed} (d) 進行済み修復後`);
    ok(JSON.stringify(healed.current!.spells) === JSON.stringify(["ember"]), `seed${seed}: (d) 進行済みキャラの術が再導出で書き換わった`);
    // 参照追従は進行済みでも行われる（ancestorFossilId はシードでなく character を指す）。
    const ancNow = healed.fossils.find((f) => f.id === healed.current!.lineage.ancestorFossilId);
    ok(ancNow?.kind === "character", `seed${seed}: (d) 進行済みでも ancestorFossilId は character へ張替される`);
  }
}

// ───────── ③ クエストID衝突の根治（再読込で qn が 0 に戻る相当） ─────────
// 現世代の受注中クエストを低採番 id（q_1..）で仕込み、migrateWorld 後に新規発行する id が
// 既存と衝突しないことを確認＝claimQuest の `filter(id !== questId)` 巻き添え削除（報酬なしで消える）を根治。
for (let seed = 1; seed <= 30; seed++) {
  const w = newWorld(seed);
  const ch = createCharacter(w, "受注者", "wanderer", { relation: "none" });
  ch.level = 12;
  const target = w.fossils.find((f) => f.kind === "explorer");
  // 再読込で qn=0 から採番し直された相当の低 id を持つ受注中クエスト（セーブに残る現世代分）。
  w.quests = [
    { id: "q_1", kind: "descend", title: "到達", desc: "", targetDepth: 14, rewardGold: 90, status: "active", issuedGeneration: w.generation },
    { id: "q_2", kind: "reclaim", title: "回収", desc: "", targetFossilId: target?.id, targetDepth: 8, rewardGold: 60, status: "done", issuedGeneration: w.generation },
    { id: "q_3", kind: "descend", title: "到達2", desc: "", targetDepth: 20, rewardGold: 120, status: "active", issuedGeneration: w.generation },
  ];
  const healed = migrateWorld(clone(w));
  const held = new Set((healed.quests ?? []).map((q) => q.id));
  ok(held.size === (healed.quests ?? []).length, `seed${seed}: ③ 既存 quest id に重複`);
  // 新規受注を複数回発行し、既存 id と衝突しないこと（syncQuestCounter のバンプ効果）。
  const rng = makeRng(seed + 777);
  const newIds: string[] = [];
  for (let r = 0; r < 4; r++) {
    const offers = generateOffers(healed, healed.current!, rng, 2);
    for (const o of offers) { newIds.push(o.id); (healed.quests ??= []).push(o); }
  }
  for (const id of newIds) ok(!held.has(id), `seed${seed}: ③ 新規 quest id ${id} が既存（再読込前の受注）と衝突`);
  ok(new Set(newIds).size === newIds.length || newIds.length === 0, `seed${seed}: ③ 新規発行どうしで id 重複`);
}

// ───────── (f) 未破損 world で dedup は完全 no-op（健全セーブを壊さない・冪等） ─────────
// migrateWorld は欠落フィールドのバックフィルを伴うため「未移行 world」との比較は不適切。
// 正しい不変条件＝一度移行した健全 world を再移行しても完全一致（dedup が何も触らない）＋化石 id 不変。
for (let seed = 1; seed <= 30; seed++) {
  const w = newWorld(seed);
  for (let gen = 1; gen <= 3; gen++) liveOneGen(w, gen);
  const baseline = migrateWorld(clone(w)); // 一度移行＝バックフィル済みの健全 world
  const idsBefore = baseline.fossils.map((f) => f.id).join(",");
  const again = migrateWorld(clone(baseline));
  ok(JSON.stringify(again) === JSON.stringify(baseline), `seed${seed}: (f) 健全 world の再移行が冪等でない（dedup が誤動作）`);
  ok(again.fossils.map((f) => f.id).join(",") === idsBefore, `seed${seed}: (f) 健全 world で化石 id が変化`);
  ok(!dupIds(baseline), `seed${seed}: (f) 健全 world に重複 id`);
}

console.log(`== stress-multigens : ${CHECKS} checks ==`);
if (FAIL > 0) {
  console.error(`❌ ${FAIL} 件の不変条件違反`);
  for (const p of problems) console.error("  - " + p);
  process.exit(1);
}
console.log("✅ 多世代の不変条件（クエスト非持ち越し・ID衝突 dedup・継承再導出・化石参照の整合）すべて満たす");

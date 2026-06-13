// 最小ループのデモ（prototype-spec.md §5 を seed 固定で一周×2世代）
// 実行: node --experimental-strip-types src/demo.ts

import { loadContent } from "./content-node.ts";
import { makeRng } from "./rng.ts";
import {
  createCharacter, fossilizeCurrent, intervene, newWorld,
  poleLabel, recordRediscovery, chronicle,
} from "./world.ts";
import { saveWorld, loadWorld } from "./persist-node.ts";
import { computeVariation, exposureGain, QUIRK_THRESHOLDS } from "./variation.ts";
import { renderDeathLine, renderRediscovery, renderRumor, renderSetPieceIfAny, fillStoryletText, fillDungeonText } from "./render.ts";
import { selectStorylet, applyEffects, candidateStorylets, selectDungeonStorylet, applyDungeonEffects } from "./storylets.ts";
import { rollEncounter } from "./weights.ts";
import { filterByTags } from "./content.ts";
import type { Character, World } from "./types.ts";

const db = loadContent();
const SEED = 20260612;
const rng = makeRng(SEED);
const world = newWorld(SEED);

const hr = (title: string) => console.log(`\n========== ${title} ==========`);
const say = (s: string) => console.log(s);

/** 潜行：深度を進めつつ深蝕を蓄積（§4.3）。閾値超えで奇癖（4-10C）。 */
function dive(world: World, ch: Character, toDepth: number, turnsPerLevel = 3) {
  while (ch.depth < toDepth) {
    ch.depth += 1;
    for (let t = 0; t < turnsPerLevel; t++) ch.exposure += exposureGain(ch.depth);
    const quirkCount = QUIRK_THRESHOLDS.filter((th) => ch.exposure >= th).length;
    while (ch.traits.filter((t) => t.startsWith("奇癖:")).length < quirkCount) {
      const pool = filterByTags(db, "exposure_quirk", {});
      const used = new Set(ch.traits);
      const candidates = pool.filter((f) => !used.has(`奇癖:${f.text}`));
      if (candidates.length === 0) break;
      const q = rng.pick(candidates);
      ch.traits.push(`奇癖:${q.text}`);
      say(`  …深蝕 ${ch.exposure.toFixed(2)}。奇癖を得た──「${q.text}」`);
    }
  }
  say(`  ${ch.name} は深度${ch.depth}に達した（深蝕 ${ch.exposure.toFixed(2)}）`);
}

// ---------- 第1世代 ----------
hr("第1世代：カイ（系譜なし）");
const kai = createCharacter(world, "カイ", "swordman", { relation: "none" });
say(`誕生: ${kai.name}（剣士）`);

say("\n[潜行]");
dive(world, kai, 12);

say("\n[遭遇判定（重み付き抽選）]");
const enc1 = rollEncounter(world, kai, rng);
if (enc1) {
  const v1 = computeVariation(enc1, world.generation);
  say(`遭遇: ${enc1.origin.name}の化石（極=${poleLabel(enc1.tonePole)} / 段階=${v1.stage} / 歪み=${v1.distort.toFixed(2)}）`);
  say("─".repeat(40));
  say(renderRediscovery(db, rng, enc1, v1));
  say("─".repeat(40));
  recordRediscovery(world, enc1.id);
}

say("\n[死：最後の一手（4-10B）]");
say(`${kai.name} は深度${kai.depth}で力尽きた。最後に、何を為す？`);
say("  選択 → 2) 迷宮を呪う");
const kaiFossil = fossilizeCurrent(world, "grievous", { choice: "curse_dungeon", note: "……必ず、戻る" });
say(renderDeathLine(db, rng, kaiFossil.death.finalAct));
say(`化石化: ${kaiFossil.origin.name} → ${poleLabel(kaiFossil.tonePole)}の極（深蝕持ち越し ${kaiFossil.exposureAtDeath.toFixed(2)}）`);

// ---------- 第2世代 ----------
hr("第2世代：アリア（カイの弟子）");
const aria = createCharacter(world, "アリア", "scout", { relation: "pupil", ancestorFossilId: kaiFossil.id });
say(`誕生: ${aria.name}（斥候） 形質=[${aria.traits.join(", ")}] 因縁=未完`);

say("\n[街の酒場：噂（lazy な世界の動態 4-6C）]");
say(`  ${renderRumor(db, rng, kaiFossil)}`);
chronicle(world, "rumor", `酒場で${kaiFossil.origin.name}の噂が流れる。`, [kaiFossil.id]);

say("\n[潜行：先代の死亡地点へ]");
dive(world, aria, 12);

say("\n[遭遇判定（未完の因縁 = 最重視重み）]");
const enc2 = rollEncounter(world, aria, rng);
if (enc2) {
  const v2 = computeVariation(enc2, world.generation);
  say(`遭遇: ${enc2.origin.name}の化石（極=${poleLabel(enc2.tonePole)} / 段階=${v2.stage} / 歪み=${v2.distort.toFixed(2)}）`);
  say("─".repeat(40));
  const setPiece = renderSetPieceIfAny(db, enc2, v2);
  say(setPiece ?? renderRediscovery(db, rng, enc2, v2));
  if (setPiece) say("  【山場：予約セットピース発火】");
  say("─".repeat(40));
  recordRediscovery(world, enc2.id);

  say("\n[干渉：鎮魂（4-1C 時計リセット／因縁を閉じる）]");
  intervene(world, enc2.id, "requiem");
  say(`  ${aria.name} は ${enc2.origin.name} を鎮魂した。`);
}

// ---------- 幕間：世代が流れる ----------
hr("幕間：四つの世代が、静かに過ぎた");
for (const name of ["トト", "ミラ", "ジグ", "ナム"]) {
  const ch = createCharacter(world, name, "delver", { relation: "none" });
  dive(world, ch, 3);
  fossilizeCurrent(world, "anonymous", { choice: "accept" });
}
say(`現在: 第${world.generation}世代`);

// ---------- 第6世代：干渉の意味の実証 ----------
hr("第6世代：ハル ── 放置と鎮魂の対比（4-1C）");
const haru = createCharacter(world, "ハル", "sage", { relation: "none" });
dive(world, haru, 18);

const ren = world.fossils.find((f) => f.origin.name === "踏破者レン")!;
const kaiF = world.fossils.find((f) => f.origin.name === "カイ")!;

say("\n[放置された化石：踏破者レン（世代0から誰も触れていない）]");
const vRen = computeVariation(ren, world.generation);
say(`  段階=${vRen.stage} / 歪み=${vRen.distort.toFixed(2)}`);
say("─".repeat(40));
say(renderRediscovery(db, rng, ren, vRen));
say("─".repeat(40));
recordRediscovery(world, ren.id);

// 遭-①：遭遇＝イベントノード（4-12）。コンテキスト内の多数候補から重みで状況が立ち上がる
say("\n[遭-①：候補プールから状況が抽選され、〈調べる〉が effects を還流する]");
say(`  怨念極の候補＝[${candidateStorylets(db, world, haru, ren, vRen).map((s) => s.id).join(", ")}]`);
const sl = selectStorylet(db, world, haru, ren, vRen, rng);
if (sl?.investigate) {
  say(`  立ち上がった状況＝[${sl.id}]`);
  say(`  〈調べる〉 ${fillStoryletText(ren, sl.investigate.text)}`);
  for (const line of applyEffects(world, haru, ren, sl.investigate.effects)) say(`    ${line}`);
  const bond = haru.bonds.find((b) => b.entityRef === ren.id);
  say(`  → 絆=${bond?.value ?? 0} / 形質=[${haru.traits.join(", ")}] ／ 年代記に追記（選択が世界に残る）`);
}

// 遭-②：〈捜索〉が伏線を立て、後続のストーリーレットの前提になる（伏線→後続：4-12）
say("\n[遭-②：〈捜索〉→ 伏線を残す → 後続イベントが解錠される]");
const chain = db.storylets.find((s) => s.id === "sl_grudge_marks");
if (chain?.search) {
  say(`  〈捜索〉 ${fillStoryletText(ren, chain.search.text)}`);
  for (const line of applyEffects(world, haru, ren, chain.search.effects)) say(`    ${line}`);
}
say(`  → 伏線フラグ：${(world.flags ?? []).join(", ") || "なし"}`);
say(`  → 解錠後の候補＝[${candidateStorylets(db, world, haru, ren, vRen).map((s) => s.id).join(", ")}]`);
say("    （sl_grudge_thread が加わり、sl_grudge_marks は外れる＝手記を拾ったことで後続へ移行）");

// イベント拡充：ダンジョン環境イベント（context=dungeon・アクター無し・深度帯で発火）
say("\n[ダンジョン環境イベント（context=dungeon・深度18=中層で発火）]");
const dg = selectDungeonStorylet(db, 18, rng);
if (dg && dg.choices) {
  say(`  状況＝[${dg.id}] ${fillDungeonText(18, dg.text ?? "")}`);
  const dgc = dg.choices[0];
  say(`  → 選択「${dgc.label}」：${fillDungeonText(18, dgc.text ?? "")}`);
  for (const line of applyDungeonEffects(world, haru, 18, dgc.effects)) say(`    ${line}`);
}

say("\n[鎮魂された化石：カイ（第2世代でアリアが時計を巻き戻した）]");
const vKai = computeVariation(kaiF, world.generation);
say(`  段階=${vKai.stage} / 歪み=${vKai.distort.toFixed(2)} ← 鎮魂のおかげで、まだ原型を保っている`);
say("─".repeat(40));
say(renderRediscovery(db, rng, kaiF, vKai));
say("─".repeat(40));
recordRediscovery(world, kaiF.id);

// ---------- 年代記 ----------
hr("年代記（4-10A）── 語り部：老書記イェン（4-10F）");
for (const e of world.chronicle) {
  const mark = { birth: "生", death: "死", rediscovery: "再", intervention: "干", legend: "伝", rumor: "噂" }[e.kind];
  say(`  世代${e.generation} [${mark}] ${e.text}`);
}

// ---------- 永続化の往復確認 ----------
hr("永続化（セーブ→ロード往復）");
const savePath = new URL("../save/world.json", import.meta.url).pathname;
saveWorld(world, savePath);
const loaded = loadWorld(savePath);
say(`saved fossils=${world.fossils.length} → loaded fossils=${loaded.fossils.length} / 年代記 ${loaded.chronicle.length}件 / 一致=${JSON.stringify(loaded) === JSON.stringify(world)}`);

hr("一周完了");
say("潜行→深蝕→遭遇→死(最後の一手)→化石化→世代交代(系譜)→噂→再発見→干渉→年代記 ── すべて実行時LLMなしで成立。");

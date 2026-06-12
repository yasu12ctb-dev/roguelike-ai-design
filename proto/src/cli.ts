// 対話型CLI：最小ループを「自分で操作して」一周遊ぶ（情緒検証の本番）
// 実行: node --experimental-strip-types src/cli.ts [--seed N] [--new]
//
// 街（噂/年代記/潜行）⇄ 迷宮（潜る/探索/帰還）⇄ 死（最後の一手）→ 世代交代（系譜）
// オートセーブ: save/world.json

import { existsSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { loadContent, filterByTags } from "./content.ts";
import { makeRng, type Rng } from "./rng.ts";
import {
  createCharacter, fossilizeCurrent, intervene, loadWorld, newWorld,
  poleLabel, recordRediscovery, saveWorld, chronicle, finalActLabel,
} from "./world.ts";
import { computeVariation, exposureGain, QUIRK_THRESHOLDS } from "./variation.ts";
import { renderDeathLine, renderRediscovery, renderRumor, renderSetPieceIfAny } from "./render.ts";
import { rollEncounter } from "./weights.ts";
import type { Character, FinalActChoice, Fossil, World } from "./types.ts";

// ---------- 起動 ----------
const args = process.argv.slice(2);
const seedArg = args.includes("--seed") ? Number(args[args.indexOf("--seed") + 1]) : undefined;
const forceNew = args.includes("--new");
const SAVE_PATH = new URL("../save/world.json", import.meta.url).pathname;

const db = loadContent();
const say = (s = "") => console.log(s);

// 入力レイヤ：行をキューに溜める（パイプ入力でも取りこぼさない。TTYでも動く）
const lineQueue: string[] = [];
let lineWaiter: ((s: string | null) => void) | null = null;
let inputEnded = false;
const rl = createInterface({ input: stdin });
rl.on("line", (l) => {
  if (lineWaiter) { const w = lineWaiter; lineWaiter = null; w(l); }
  else lineQueue.push(l);
});
rl.on("close", () => {
  inputEnded = true;
  if (lineWaiter) { const w = lineWaiter; lineWaiter = null; w(null); }
});

async function readLine(prompt: string): Promise<string> {
  stdout.write(prompt);
  let line: string | null;
  if (lineQueue.length > 0) line = lineQueue.shift()!;
  else if (inputEnded) line = null;
  else line = await new Promise<string | null>((res) => { lineWaiter = res; });
  if (line === null) {
    // EOF：世界を保存して静かに終える
    autosave();
    say("\n（入力が途切れた。世界は保存された）");
    process.exit(0);
  }
  if (!stdin.isTTY) say(line); // パイプ実行時も画面に入力を残す（ログ可読性）
  return line;
}

let world: World;
if (!forceNew && existsSync(SAVE_PATH)) {
  world = loadWorld(SAVE_PATH);
  say(`（前回の世界を読み込んだ：第${world.generation}世代 / 化石${world.fossils.length}件）`);
} else {
  world = newWorld(seedArg ?? Date.now() % 2147483647);
  say("（新しい世界が生まれた）");
}
// 対話モードの乱数：世界seed＋進行量から導出（完全決定論はdemo.tsが担保）
const rng: Rng = makeRng(world.seed ^ (world.chronicle.length * 2654435761));

const MAX_HP = 10;
let hp = MAX_HP;

async function ask(prompt: string, choices: string[]): Promise<number> {
  say("");
  choices.forEach((c, i) => say(`  ${i + 1}) ${c}`));
  for (;;) {
    const a = (await readLine(`${prompt} > `)).trim();
    const n = Number(a);
    if (Number.isInteger(n) && n >= 1 && n <= choices.length) return n;
    say(`1〜${choices.length} で答えてください。`);
  }
}

function autosave() { saveWorld(world, SAVE_PATH); }

function status(ch: Character) {
  const quirks = ch.traits.filter((t) => t.startsWith("奇癖:")).length;
  say(`〔深度${ch.depth}  HP ${hp}/${MAX_HP}  被曝 ${ch.exposure.toFixed(2)}${quirks ? `  奇癖${quirks}` : ""}〕`);
}

// ---------- キャラ作成（系譜選択 4-10D） ----------
async function characterCreation(): Promise<Character> {
  say("\n━━━ 新たな探索者 ━━━");
  const name = (await readLine("名を何という？ > ")).trim() || `名無し${world.generation}`;
  const ancestors = world.fossils.filter((f) => f.kind === "character").slice(-3).reverse();
  let lineage: Character["lineage"] = { relation: "none" };
  if (ancestors.length > 0) {
    const opts = [
      ...ancestors.map((f) => `${f.origin.name}の血縁として（${poleLabel(f.tonePole)}の化石・深度${f.laidDepth}に眠る）`),
      ...ancestors.map((f) => `${f.origin.name}の弟子として`),
      "誰とも関わりなく",
    ];
    const pick = await ask("お前は、誰の物語を継ぐ？", opts);
    if (pick <= ancestors.length) lineage = { relation: "blood", ancestorFossilId: ancestors[pick - 1].id };
    else if (pick <= ancestors.length * 2) lineage = { relation: "pupil", ancestorFossilId: ancestors[pick - ancestors.length - 1].id };
  }
  const arch = await ask("流儀は？", ["剣士（swordman）", "斥候（scout）", "学徒（sage）"]);
  const ch = createCharacter(world, name, ["swordman", "scout", "sage"][arch - 1], lineage);
  hp = MAX_HP;
  if (ch.traits.length) say(`形質: [${ch.traits.join(", ")}]`);
  if (ch.bonds.some((b) => b.unfinished)) say("……先代の未完の因縁が、お前に引き継がれた。");
  autosave();
  return ch;
}

// ---------- 街 ----------
async function townLoop(ch: Character): Promise<"dive" | "quit"> {
  for (;;) {
    say(`\n━━━ 街 ── 迷宮の口（第${world.generation}世代） ━━━`);
    const pick = await ask(`${ch.name}、どうする？`, [
      "迷宮へ潜る", "酒場で噂を聞く", "年代記を読む（老書記イェン）", "セーブして終える",
    ]);
    if (pick === 1) return "dive";
    if (pick === 2) {
      const pool = world.fossils.filter((f) => f.kind === "character" || f.bondAtDeath > 0);
      const target = pool.length > 0 ? rng.pick(pool) : (world.fossils.length > 0 ? rng.pick(world.fossils) : null);
      if (target) {
        say(`\n酒場の喧噪のなか、誰かが言う──`);
        say(`  ${renderRumor(db, rng, target)}`);
        chronicle(world, "rumor", `酒場で${target.origin.name}の噂が流れる。`, [target.id]);
        autosave();
      } else say("今日は、これといった噂もない。");
    }
    if (pick === 3) {
      say("\n━━━ 年代記 ── 老書記イェンが頁を繰る ━━━");
      const tail = world.chronicle.slice(-15);
      const mark = { birth: "生", death: "死", rediscovery: "再", intervention: "干", legend: "伝", rumor: "噂" } as const;
      for (const e of tail) say(`  世代${e.generation} [${mark[e.kind]}] ${e.text}`);
      if (world.chronicle.length > tail.length) say(`  （ほか${world.chronicle.length - tail.length}件の記述）`);
    }
    if (pick === 4) { autosave(); return "quit"; }
  }
}

// ---------- 迷宮 ----------
async function dungeonLoop(ch: Character): Promise<"died" | "returned"> {
  say("\n━━━ 迷宮 ━━━");
  const seenThisDive = new Set<string>();
  ch.depth = Math.max(1, ch.depth === 0 ? 1 : ch.depth);
  for (;;) {
    status(ch);
    const pick = await ask("どうする？", ["さらに潜る", "このあたりを探索する", "地上へ戻る"]);

    if (pick === 3) {
      say(`${ch.name}は地上へ帰り着いた。傷は癒えるが、浴びた深みは消えない。`);
      ch.depth = 0; hp = MAX_HP; autosave();
      return "returned";
    }

    if (pick === 1) {
      ch.depth += 1;
      for (let t = 0; t < 3; t++) ch.exposure += exposureGain(ch.depth);
      gainQuirks(ch);
      // 危険判定（深いほど苛烈）
      if (rng.next() < Math.min(0.15 + ch.depth * 0.015, 0.6)) {
        const dmg = 1 + rng.int(2) + (ch.depth >= 25 ? 1 : 0);
        hp -= dmg;
        say(`  暗がりから牙が走った──${dmg}の傷。`);
      } else {
        say("  道は深く、静かに続いている。");
      }
    }

    if (pick === 2) {
      const enc = rollEncounter(world, ch, rng, seenThisDive);
      if (!enc) {
        say("  ……何も見つからない。風の音だけがする。");
      } else {
        seenThisDive.add(enc.id);
        await encounterScene(ch, enc);
      }
      // 探索にも小さな危険
      if (rng.next() < 0.12) { hp -= 1; say("  足元が崩れ、したたかに打った──1の傷。"); }
    }

    if (hp <= 0) { await deathScene(ch); return "died"; }
  }
}

async function encounterScene(ch: Character, fossil: Fossil) {
  const v = computeVariation(fossil, world.generation);
  say("");
  say("─".repeat(44));
  const setPiece = renderSetPieceIfAny(db, fossil, v);
  say(setPiece ?? renderRediscovery(db, rng, fossil, v));
  say("─".repeat(44));
  say(`（${fossil.origin.name}の化石 ── 極=${poleLabel(fossil.tonePole)} / 変質=${v.stage} / 強度${v.intensity.toFixed(2)}${setPiece ? " / 山場" : ""}）`);
  recordRediscovery(world, fossil.id);

  const canInherit = fossil.death.finalAct.choice === "leave_will" || fossil.death.finalAct.choice === "guard_relic";
  const opts = ["鎮魂する（末路を閉じ、変質の時計を巻き戻す）", "そっと立ち去る"];
  if (canInherit) opts.splice(1, 0, "遺されたものを継ぐ");
  const pick = await ask("どうする？", opts);
  if (pick === 1) {
    intervene(world, fossil.id, "requiem");
    say(`  ${ch.name}は祈りを捧げた。何かが、静かに鎮まった。`);
  } else if (canInherit && pick === 2) {
    intervene(world, fossil.id, "inherit");
    ch.traits.push(`継承:${fossil.origin.gearTags[0] ?? fossil.origin.name}`);
    say(`  ${ch.name}は${fossil.origin.name}の遺したものを受け取った。`);
  } else {
    say("  お前は何もせず、その場を後にした。……それもまた、ひとつの答えだ。");
  }
  autosave();
}

async function deathScene(ch: Character) {
  say(`\n${ch.name}は深度${ch.depth}で力尽きた。視界が昏く閉じていく──`);
  const pick = await ask("最後に、何を為す？", [
    "遺品を抱いて守る", "迷宮を呪う", "後継へ遺言を遺す", "静かに受け入れる",
  ]);
  const choice: FinalActChoice = (["guard_relic", "curse_dungeon", "leave_will", "accept"] as const)[pick - 1];
  let note: string | undefined;
  if (choice === "leave_will" || choice === "curse_dungeon") {
    const n = (await readLine("最期の言葉（空欄可） > ")).trim();
    if (n) note = n;
  }
  const manner = ch.depth >= 20 ? "grievous" : "anonymous";
  const fossil = fossilizeCurrent(world, manner, { choice, note });
  say("");
  say(renderDeathLine(db, rng, fossil.death.finalAct));
  say(`\n${fossil.origin.name}は化石となった ── ${poleLabel(fossil.tonePole)}の極（${finalActLabel(choice)}）`);
  say(`その亡骸は深度${fossil.laidDepth}に眠り、世代とともに変わっていくだろう。`);
  autosave();
}

// ---------- メイン ----------
async function main() {
  say("\n＝＝＝ 迷宮の口 ── 堆積する世界 v0 ＝＝＝");
  for (;;) {
    if (!world.current || !world.current.alive) await characterCreation();
    const ch = world.current!;
    const t = await townLoop(ch);
    if (t === "quit") break;
    const d = await dungeonLoop(ch);
    if (d === "died") continue; // 世代交代へ
  }
  say("\n（世界は保存された。化石たちは、次に潜る者を待っている）");
  rl.close();
}

main().catch((e) => {
  // パイプ入力のEOF等でも世界は保存して終える
  autosave();
  if (e?.code === "ABORT_ERR" || /closed/i.test(String(e?.message))) {
    say("\n（入力が途切れた。世界は保存された）");
    process.exit(0);
  }
  throw e;
});

function gainQuirks(ch: Character) {
  const quirkCount = QUIRK_THRESHOLDS.filter((th) => ch.exposure >= th).length;
  while (ch.traits.filter((t) => t.startsWith("奇癖:")).length < quirkCount) {
    const pool = filterByTags(db, "exposure_quirk", {});
    const used = new Set(ch.traits);
    const candidates = pool.filter((f) => !used.has(`奇癖:${f.text}`));
    if (candidates.length === 0) break;
    const q = rng.pick(candidates);
    ch.traits.push(`奇癖:${q.text}`);
    say(`  深みが染みてくる……奇癖を得た──「${q.text}」`);
  }
}

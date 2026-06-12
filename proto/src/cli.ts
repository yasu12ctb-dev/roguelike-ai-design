// 対話型CLI：ゲームフロー（game.ts）を端末IOで動かす薄いシェル
// 実行: node --experimental-strip-types src/cli.ts [--seed N] [--new]
// オートセーブ: save/world.json

import { existsSync } from "node:fs";
import { createInterface } from "node:readline";
import { stdin, stdout } from "node:process";
import { loadContent } from "./content-node.ts";
import { saveWorld, loadWorld } from "./persist-node.ts";
import { makeRng, type Rng } from "./rng.ts";
import { newWorld } from "./world.ts";
import { runGame, type GameIO } from "./game.ts";
import type { World } from "./types.ts";

const args = process.argv.slice(2);
const seedArg = args.includes("--seed") ? Number(args[args.indexOf("--seed") + 1]) : undefined;
const forceNew = args.includes("--new");
const SAVE_PATH = new URL("../save/world.json", import.meta.url).pathname;

const db = loadContent();
const say = (s = "") => console.log(s);

let world: World;
if (!forceNew && existsSync(SAVE_PATH)) {
  world = loadWorld(SAVE_PATH);
  say(`（前回の世界を読み込んだ：第${world.generation}世代 / 化石${world.fossils.length}件）`);
} else {
  world = newWorld(seedArg ?? Date.now() % 2147483647);
  say("（新しい世界が生まれた）");
}
// 対話モードの乱数：世界seed＋進行量から導出（完全決定論は demo.ts が担保）
const rng: Rng = makeRng(world.seed ^ (world.chronicle.length * 2654435761));

// ---- 入力レイヤ：行をキューに溜める（パイプ入力でも取りこぼさない。TTYでも動く） ----
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
    saveWorld(world, SAVE_PATH);
    say("\n（入力が途切れた。世界は保存された）");
    process.exit(0);
  }
  if (!stdin.isTTY) say(line); // パイプ実行時も入力をログに残す
  return line;
}

const io: GameIO = {
  print: say,
  async choose(prompt, options) {
    say("");
    options.forEach((c, i) => say(`  ${i + 1}) ${c}`));
    for (;;) {
      const a = (await readLine(`${prompt} > `)).trim();
      const n = Number(a);
      if (Number.isInteger(n) && n >= 1 && n <= options.length) return n;
      say(`1〜${options.length} で答えてください。`);
    }
  },
  async input(prompt) {
    return readLine(`${prompt} > `);
  },
};

await runGame(world, db, rng, io, { save: (w) => saveWorld(w, SAVE_PATH) });
rl.close();

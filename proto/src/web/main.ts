// Web（PWA）シェル：game.ts のフローを DOM IO で動かす
// 永続化 = localStorage（完全オフライン・買い切り方針と整合）

import fragmentsJson from "../../content/fragments.json";
import setpiecesJson from "../../content/setpieces.json";
import { makeContentDb } from "../content.ts";
import { makeRng } from "../rng.ts";
import { newWorld } from "../world.ts";
import { runGame, type GameIO } from "../game.ts";
import type { Fragment, SetPiece, World } from "../types.ts";

const SAVE_KEY = "sekitsui.world.v0";

const db = makeContentDb(
  fragmentsJson as { fragments: Fragment[] },
  setpiecesJson as { setpieces: SetPiece[] },
);

// ---- DOM ----
const logEl = document.getElementById("log")!;
const promptEl = document.getElementById("prompt")!;
const choicesEl = document.getElementById("choices")!;
const inputRow = document.getElementById("inputRow")!;
const textInput = document.getElementById("textInput") as HTMLInputElement;
const textOk = document.getElementById("textOk") as HTMLButtonElement;
const newWorldBtn = document.getElementById("newWorldBtn") as HTMLButtonElement;

function append(text: string, cls = "scene") {
  const div = document.createElement("div");
  div.className = cls;
  div.textContent = text;
  logEl.appendChild(div);
  logEl.scrollTop = logEl.scrollHeight;
}

function clearControls() {
  promptEl.textContent = "";
  choicesEl.innerHTML = "";
  inputRow.classList.add("hidden");
}

const io: GameIO = {
  print(text = "") {
    append(text, text.startsWith("（") ? "sys" : "scene");
  },
  choose(prompt, options) {
    return new Promise<number>((resolve) => {
      promptEl.textContent = prompt;
      choicesEl.innerHTML = "";
      options.forEach((opt, i) => {
        const b = document.createElement("button");
        b.type = "button";
        b.className = "choice";
        b.textContent = opt;
        b.onclick = () => {
          append(`▸ ${opt}`, "echo");
          clearControls();
          resolve(i + 1);
        };
        choicesEl.appendChild(b);
      });
    });
  },
  input(prompt) {
    return new Promise<string>((resolve) => {
      promptEl.textContent = prompt;
      choicesEl.innerHTML = "";
      inputRow.classList.remove("hidden");
      textInput.value = "";
      textInput.focus();
      const done = () => {
        const v = textInput.value;
        append(`▸ ${v || "（無言）"}`, "echo");
        textOk.onclick = null;
        textInput.onkeydown = null;
        clearControls();
        resolve(v);
      };
      textOk.onclick = done;
      textInput.onkeydown = (e) => { if (e.key === "Enter") done(); };
    });
  },
};

// ---- 永続化（localStorage） ----
function loadOrCreateWorld(forceNew = false): World {
  if (!forceNew) {
    const raw = localStorage.getItem(SAVE_KEY);
    if (raw) {
      try {
        const w = JSON.parse(raw) as World;
        append(`（前回の世界を読み込んだ：第${w.generation}世代 / 化石${w.fossils.length}件）`, "sys");
        return w;
      } catch { /* 壊れたセーブは作り直す */ }
    }
  }
  const w = newWorld(Date.now() % 2147483647);
  append("（新しい世界が生まれた）", "sys");
  return w;
}

function save(world: World) {
  localStorage.setItem(SAVE_KEY, JSON.stringify(world));
}

// ---- 起動 ----
async function boot(forceNew = false) {
  logEl.innerHTML = "";
  clearControls();
  const world = loadOrCreateWorld(forceNew);
  const rng = makeRng(world.seed ^ (world.chronicle.length * 2654435761) ^ (Date.now() & 0xffff));
  for (;;) {
    await runGame(world, db, rng, io, { save });
    const again = await io.choose("世界は保存された。", ["続きから再開する"]);
    if (again === 1) continue;
  }
}

newWorldBtn.onclick = async () => {
  if (confirm("いまの世界（化石・年代記のすべて）を捨てて、新しい世界を始めますか？")) {
    localStorage.removeItem(SAVE_KEY);
    location.reload();
  }
};

boot();

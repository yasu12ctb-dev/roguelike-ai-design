// Web（PWA）本体：方向A（発光グリフ）・縦持ち・D-pad左 のローグライク
// 街（シート）⇄ 迷宮（グリッド・ターン制）。化石はマップ上の実体として現れる。

import fragmentsJson from "../../content/fragments.json";
import setpiecesJson from "../../content/setpieces.json";
import { makeContentDb } from "../content.ts";
import { makeRng, type Rng } from "../rng.ts";
import {
  newWorld, createCharacter, fossilizeCurrent, intervene, recordRediscovery,
  chronicle, poleLabel, finalActLabel,
} from "../world.ts";
import { computeVariation, exposureGain, QUIRK_THRESHOLDS } from "../variation.ts";
import { renderDeathLine, renderRediscovery, renderRumor, renderSetPieceIfAny } from "../render.ts";
import { rollEncounter } from "../weights.ts";
import { filterByTags } from "../content.ts";
import {
  genFloor, placeFossil, computeFov, stepMonsters, tileAt, cellIndex,
  FLOOR_W, FLOOR_H, type Floor, type Pos,
} from "../dungeon.ts";
import type { Character, FinalActChoice, Fossil, Fragment, SetPiece, World } from "../types.ts";

const SAVE_KEY = "sekitsui.world.v0";
const MAX_HP = 12;

const db = makeContentDb(
  fragmentsJson as { fragments: Fragment[] },
  setpiecesJson as { setpieces: SetPiece[] },
);

// ---------- DOM ----------
const $ = (id: string) => document.getElementById(id)!;
const gridEl = $("grid"), lightEl = $("light"), logEl = $("log");
const overlayEl = $("overlay"), sheetText = $("sheetText"), sheetMeta = $("sheetMeta");
const sheetButtons = $("sheetButtons"), sheetInputRow = $("sheetInputRow");
const sheetInput = $("sheetInput") as HTMLInputElement;

function log(text: string, cls = "") {
  const div = document.createElement("div");
  if (cls) div.className = cls;
  div.textContent = text;
  logEl.appendChild(div);
  while (logEl.childElementCount > 40) logEl.removeChild(logEl.firstChild!);
  logEl.scrollTop = logEl.scrollHeight;
}

// ---------- シート（場面＋選択肢。promise を返す） ----------
interface SheetOpts { text: string; meta?: string; options: string[]; input?: string; }
function sheet(o: SheetOpts): Promise<{ pick: number; text: string }> {
  return new Promise((resolve) => {
    sheetText.textContent = o.text;
    sheetMeta.textContent = o.meta ?? "";
    sheetInputRow.classList.toggle("show", o.input !== undefined);
    sheetInput.value = ""; sheetInput.placeholder = o.input ?? "";
    sheetButtons.innerHTML = "";
    o.options.forEach((label, i) => {
      const b = document.createElement("button");
      b.type = "button"; b.textContent = label;
      b.onclick = () => { overlayEl.classList.remove("show"); resolve({ pick: i + 1, text: sheetInput.value }); };
      sheetButtons.appendChild(b);
    });
    overlayEl.classList.add("show");
  });
}

// ---------- 世界の永続化 ----------
function loadOrCreateWorld(): World {
  const raw = localStorage.getItem(SAVE_KEY);
  if (raw) {
    try {
      const w = JSON.parse(raw) as World;
      log(`（前回の世界を読み込んだ：第${w.generation}世代 / 化石${w.fossils.length}件）`, "dim");
      return w;
    } catch { /* 壊れたセーブは作り直す */ }
  }
  log("（新しい世界が生まれた）", "dim");
  return newWorld(Date.now() % 2147483647);
}
const save = () => localStorage.setItem(SAVE_KEY, JSON.stringify(world));

// ---------- 状態 ----------
let world = loadOrCreateWorld();
let rng: Rng = makeRng((world.seed ^ (world.chronicle.length * 2654435761) ^ (Date.now() & 0xffff)) >>> 0);
let hp = MAX_HP;
let mode: "town" | "dive" = "town";
let floor: Floor | null = null;
let player: Pos = { x: 0, y: 0 };
let busy = false; // シート表示中の入力ロック

// ---------- ステータスバー ----------
function updateStatus() {
  const ch = world.current;
  $("stName").textContent = ch ? `${ch.name}（第${world.generation}世代）` : "—";
  $("stDepth").textContent = String(mode === "dive" && floor ? floor.depth : 0);
  $("stHp").textContent = `HP ${hp}/${MAX_HP}`;
  const e = ch?.exposure ?? 0;
  const n = Math.min(5, Math.floor(e / 0.6));
  $("stExp").textContent = `被曝 ${"▮".repeat(n)}${"░".repeat(5 - n)}`;
}

// ---------- マップ描画（方向A） ----------
let cells: HTMLElement[] = [];
function buildGridDom() {
  gridEl.innerHTML = "";
  cells = [];
  const csW = Math.min(window.innerWidth, 560) / FLOOR_W;
  const csH = ($("mapWrap").clientHeight - 4) / FLOOR_H;
  const cs = Math.min(csW, csH);
  (gridEl as HTMLElement).style.gridTemplateColumns = `repeat(${FLOOR_W}, ${cs}px)`;
  (gridEl as HTMLElement).style.justifyContent = "center";
  for (let i = 0; i < FLOOR_W * FLOOR_H; i++) {
    const c = document.createElement("div");
    c.className = "cell";
    c.style.height = cs + "px";
    c.style.fontSize = (cs * 0.62) + "px";
    c.innerHTML = "<span></span>";
    gridEl.appendChild(c);
    cells.push(c);
  }
}

function draw() {
  if (!floor) return;
  const vis = computeFov(floor, player);
  for (let y = 0; y < FLOOR_H; y++) for (let x = 0; x < FLOOR_W; x++) {
    const i = cellIndex(x, y);
    const c = cells[i], span = c.firstChild as HTMLElement;
    const t = tileAt(floor, x, y);
    const visible = vis.has(i), explored = floor.explored[i];
    c.classList.toggle("wall", t === 0 && explored);
    if (!explored) { span.textContent = ""; c.style.filter = "brightness(0)"; continue; }

    let glyph = t === 0 ? "▒" : "·";
    let cls = t === 0 ? "g-wall" : "g-floor";
    if (x === floor.stairsDown.x && y === floor.stairsDown.y) { glyph = "›"; cls = "g-down"; }
    if (x === floor.stairsUp.x && y === floor.stairsUp.y) { glyph = "‹"; cls = "g-up"; }
    if (visible) {
      const fe = floor.fossils.find((e) => e.x === x && e.y === y);
      if (fe) { glyph = "†"; cls = fe.resolved ? "g-fossil-quiet" : "g-fossil"; }
      const m = floor.monsters.find((m) => m.hp > 0 && m.x === x && m.y === y);
      if (m) { glyph = m.kind.glyph; cls = "g-mon"; }
    }
    if (x === player.x && y === player.y) { glyph = "@"; cls = "g-player"; }
    span.textContent = glyph;
    span.className = cls;
    const d = Math.hypot(x - player.x, y - player.y);
    const b = visible ? Math.max(0.35, 1 - d / 11) : 0.16; // 記憶は薄暗く
    c.style.filter = `brightness(${b.toFixed(2)})`;
  }
  lightEl.style.setProperty("--px", ((player.x + 0.5) / FLOOR_W * 100) + "%");
  lightEl.style.setProperty("--py", ((player.y + 0.5) / FLOOR_H * 100) + "%");
  updateStatus();
}

// ---------- キャラ作成（系譜 4-10D） ----------
async function characterCreation() {
  const name = (await sheet({
    text: "新たな探索者が、迷宮の口に立つ。", meta: "名を入力（空欄なら仮名）",
    options: ["この名で始める"], input: "名前",
  })).text.trim() || `名無し${world.generation}`;

  const ancestors = world.fossils.filter((f) => f.kind === "character").slice(-3).reverse();
  let lineage: Character["lineage"] = { relation: "none" };
  if (ancestors.length > 0) {
    const opts = [
      ...ancestors.map((f) => `${f.origin.name}の血縁として（${poleLabel(f.tonePole)}の化石・深度${f.laidDepth}に眠る）`),
      ...ancestors.map((f) => `${f.origin.name}の弟子として`),
      "誰とも関わりなく",
    ];
    const r = await sheet({ text: "お前は、誰の物語を継ぐ？", options: opts });
    if (r.pick <= ancestors.length) lineage = { relation: "blood", ancestorFossilId: ancestors[r.pick - 1].id };
    else if (r.pick <= ancestors.length * 2) lineage = { relation: "pupil", ancestorFossilId: ancestors[r.pick - ancestors.length - 1].id };
  }
  const arch = await sheet({ text: "流儀は？", options: ["剣士", "斥候", "学徒"] });
  const ch = createCharacter(world, name, ["swordman", "scout", "sage"][arch.pick - 1], lineage);
  hp = MAX_HP;
  if (ch.bonds.some((b) => b.unfinished)) log("……先代の未完の因縁が、お前に引き継がれた。", "warn");
  save();
}

// ---------- 街 ----------
async function townLoop() {
  mode = "town"; floor = null; updateStatus();
  for (;;) {
    const ch = world.current!;
    const r = await sheet({
      text: `街 ── 迷宮の口（第${world.generation}世代）\n${ch.name}、どうする？`,
      options: ["迷宮へ潜る", "酒場で噂を聞く", "年代記を読む（老書記イェン）"],
    });
    if (r.pick === 1) return;
    if (r.pick === 2) {
      const pool = world.fossils.filter((f) => f.kind === "character" || f.bondAtDeath > 0);
      const target = pool.length ? rng.pick(pool) : (world.fossils.length ? rng.pick(world.fossils) : null);
      if (target) {
        await sheet({ text: `酒場の喧噪のなか、誰かが言う──\n\n${renderRumor(db, rng, target)}`, options: ["席を立つ"] });
        chronicle(world, "rumor", `酒場で${target.origin.name}の噂が流れる。`, [target.id]);
        save();
      }
    }
    if (r.pick === 3) {
      const mark = { birth: "生", death: "死", rediscovery: "再", intervention: "干", legend: "伝", rumor: "噂" } as const;
      const tail = world.chronicle.slice(-14).map((e) => `世代${e.generation} [${mark[e.kind]}] ${e.text}`).join("\n");
      await sheet({ text: tail || "まだ何も記されていない。", meta: `年代記 ── 全${world.chronicle.length}件`, options: ["頁を閉じる"] });
    }
  }
}

// ---------- 潜行 ----------
function enterFloor(depth: number, fromAbove: boolean) {
  floor = genFloor(world, depth);
  const ch = world.current!;
  ch.depth = depth;
  player = { ...(fromAbove ? floor.stairsUp : floor.stairsDown) };
  // 化石の配置（再会重み 4-7。同一潜行で会った相手は除外）
  const exclude = new Set<string>(seenThisDive);
  for (let i = 0; i < 2; i++) {
    const fossil = rollEncounter(world, ch, rng, exclude);
    if (!fossil) break;
    if (Math.abs(fossil.laidDepth - depth) <= 4 && placeFossil(floor, rng, player, fossil)) exclude.add(fossil.id);
  }
  draw();
  log(`── 深度${depth} ──`, "dim");
}

let seenThisDive: string[] = [];

async function startDive() {
  mode = "dive";
  seenThisDive = [];
  enterFloor(1, true);
  log("迷宮に降りた。冷えた空気が頬を撫でる。");
}

// ---------- 1ターンの処理 ----------
async function playerAct(dx: number, dy: number) {
  if (busy || mode !== "dive" || !floor || !world.current) return;
  const ch = world.current;

  if (!(dx === 0 && dy === 0)) {
    const nx = player.x + dx, ny = player.y + dy;
    if (!moveOrInteract(nx, ny)) return; // 壁
  }
  // 化石・階段の場面が開いた場合は、このターンの進行（被曝・敵の手番）を保留する
  if (busy) { draw(); return; }

  // 被曝（4-10C）
  ch.exposure += exposureGain(floor.depth);
  const quirkCount = QUIRK_THRESHOLDS.filter((th) => ch.exposure >= th).length;
  while (ch.traits.filter((t) => t.startsWith("奇癖:")).length < quirkCount) {
    const pool = filterByTags(db, "exposure_quirk", {});
    const used = new Set(ch.traits);
    const cand = pool.filter((f) => !used.has(`奇癖:${f.text}`));
    if (!cand.length) break;
    const q = rng.pick(cand);
    ch.traits.push(`奇癖:${q.text}`);
    log(`深みが染みてくる……奇癖を得た──「${q.text}」`, "warn");
  }

  // モンスターのターン
  const hits = stepMonsters(floor, player, rng);
  for (const h of hits) {
    hp -= h.dmg;
    log(`${h.monster.kind.name}の攻撃！ ${h.dmg}の傷。`, "warn");
  }

  draw();
  if (hp <= 0) await deathFlow();
}

/** 移動 or 体当たり。falseなら手番を消費しない（壁） */
function moveOrInteract(nx: number, ny: number): boolean {
  const f = floor!;
  if (tileAt(f, nx, ny) !== 1) return false;

  const mon = f.monsters.find((m) => m.hp > 0 && m.x === nx && m.y === ny);
  if (mon) { // 攻撃
    const dmg = 2 + rng.int(2);
    mon.hp -= dmg;
    log(mon.hp <= 0 ? `${mon.kind.name}を倒した。` : `${mon.kind.name}に${dmg}の一撃。`);
    return true;
  }

  const fe = f.fossils.find((e) => e.x === nx && e.y === ny);
  if (fe && !fe.resolved) { void fossilScene(fe); return true; }

  player = { x: nx, y: ny };

  // 階段
  if (nx === f.stairsDown.x && ny === f.stairsDown.y) void stairsPrompt("down");
  else if (nx === f.stairsUp.x && ny === f.stairsUp.y) void stairsPrompt("up");
  return true;
}

async function stairsPrompt(dir: "down" | "up") {
  if (busy) return;
  busy = true;
  const f = floor!;
  if (dir === "down") {
    const r = await sheet({ text: `下り階段がある。深度${f.depth + 1}へ降りるか？`, options: ["降りる", "とどまる"] });
    if (r.pick === 1) enterFloor(f.depth + 1, true);
  } else if (f.depth === 1) {
    const r = await sheet({ text: "地上への階段だ。街へ戻るか？\n（傷は癒えるが、浴びた深みは消えない）", options: ["街へ戻る", "とどまる"] });
    if (r.pick === 1) {
      hp = MAX_HP; world.current!.depth = 0; save();
      log("地上の光がまぶしい。生きて、帰った。");
      busy = false;
      await townLoop(); await startDive(); return;
    }
  } else {
    const r = await sheet({ text: `上り階段がある。深度${f.depth - 1}へ戻るか？`, options: ["戻る", "とどまる"] });
    if (r.pick === 1) enterFloor(f.depth - 1, false);
  }
  busy = false;
  draw();
}

// ---------- 化石との対面（再発見 → 干渉） ----------
async function fossilScene(fe: { fossilId: string; resolved: boolean }) {
  if (busy) return;
  busy = true;
  const fossil = world.fossils.find((f) => f.id === fe.fossilId)!;
  const v = computeVariation(fossil, world.generation);
  const setPiece = renderSetPieceIfAny(db, fossil, v);
  const text = setPiece ?? renderRediscovery(db, rng, fossil, v);
  recordRediscovery(world, fossil.id);
  seenThisDive.push(fossil.id);

  const canInherit = fossil.death.finalAct.choice === "leave_will" || fossil.death.finalAct.choice === "guard_relic";
  const opts = ["鎮魂する（末路を閉じ、変質の時計を巻き戻す）"];
  if (canInherit) opts.push("遺されたものを継ぐ");
  opts.push("そっと立ち去る");

  const r = await sheet({
    text,
    meta: `${fossil.origin.name}の化石 ── 極=${poleLabel(fossil.tonePole)} / 変質=${v.stage}${setPiece ? " / 山場" : ""}`,
    options: opts,
  });
  const ch = world.current!;
  if (r.pick === 1) {
    intervene(world, fossil.id, "requiem");
    log(`${ch.name}は祈りを捧げた。何かが、静かに鎮まった。`);
  } else if (canInherit && r.pick === 2) {
    intervene(world, fossil.id, "inherit");
    ch.traits.push(`継承:${fossil.origin.gearTags[0] ?? fossil.origin.name}`);
    log(`${ch.name}は${fossil.origin.name}の遺したものを受け取った。`);
  } else {
    log("お前は何もせず、その場を後にした。……それもまた、ひとつの答えだ。");
  }
  fe.resolved = true;
  save();
  busy = false;
  draw();
}

// ---------- 死 → 最後の一手（4-10B）→ 世代交代 ----------
async function deathFlow() {
  busy = true;
  const ch = world.current!;
  const depth = floor!.depth;
  const r = await sheet({
    text: `${ch.name}は深度${depth}で力尽きた。\n視界が昏く閉じていく──\n\n最後に、何を為す？`,
    options: ["遺品を抱いて守る", "迷宮を呪う", "後継へ遺言を遺す", "静かに受け入れる"],
    input: "最期の言葉（任意）",
  });
  const choice: FinalActChoice = (["guard_relic", "curse_dungeon", "leave_will", "accept"] as const)[r.pick - 1];
  const note = r.text.trim() || undefined;
  const manner = depth >= 20 ? "grievous" : "anonymous";
  const fossil = fossilizeCurrent(world, manner, { choice, note });
  save();

  await sheet({
    text: `${renderDeathLine(db, rng, fossil.death.finalAct)}\n\n${fossil.origin.name}は化石となった ── ${poleLabel(fossil.tonePole)}の極（${finalActLabel(choice)}）。\nその亡骸は深度${fossil.laidDepth}に眠り、世代とともに変わっていくだろう。`,
    meta: "死は終わりではない。世界に堆積する。",
    options: ["次の世代へ"],
  });

  busy = false;
  hp = MAX_HP;
  await characterCreation();
  await townLoop();
  await startDive();
}

// ---------- メニュー（≡：今後拡張のフック） ----------
$("menuBtn").onclick = async () => {
  if (busy) return;
  busy = true;
  const mark = { birth: "生", death: "死", rediscovery: "再", intervention: "干", legend: "伝", rumor: "噂" } as const;
  const tail = world.chronicle.slice(-14).map((e) => `世代${e.generation} [${mark[e.kind]}] ${e.text}`).join("\n");
  await sheet({ text: tail || "まだ何も記されていない。", meta: `年代記 ── 全${world.chronicle.length}件`, options: ["閉じる"] });
  busy = false;
};

// ---------- 入力（D-pad左・スワイプ・矢印キー） ----------
for (const b of document.querySelectorAll<HTMLButtonElement>("#dpad button[data-d]")) {
  b.onclick = () => {
    const [dx, dy] = b.dataset.d!.split(",").map(Number);
    void playerAct(dx, dy);
  };
}
addEventListener("keydown", (e) => {
  const map: Record<string, [number, number]> = {
    ArrowUp: [0, -1], ArrowDown: [0, 1], ArrowLeft: [-1, 0], ArrowRight: [1, 0], ".": [0, 0],
  };
  if (map[e.key]) { e.preventDefault(); void playerAct(...map[e.key]); }
});
let touchStart: { x: number; y: number } | null = null;
$("mapWrap").addEventListener("touchstart", (e) => {
  touchStart = { x: e.touches[0].clientX, y: e.touches[0].clientY };
}, { passive: true });
$("mapWrap").addEventListener("touchend", (e) => {
  if (!touchStart) return;
  const dx = e.changedTouches[0].clientX - touchStart.x;
  const dy = e.changedTouches[0].clientY - touchStart.y;
  touchStart = null;
  if (Math.hypot(dx, dy) < 24) return; // タップは無視（誤爆防止）
  if (Math.abs(dx) > Math.abs(dy)) void playerAct(Math.sign(dx), 0);
  else void playerAct(0, Math.sign(dy));
}, { passive: true });

addEventListener("resize", () => { if (mode === "dive") { buildGridDom(); draw(); } });

// ---------- 起動 ----------
async function boot() {
  buildGridDom();
  updateStatus();
  if (!world.current || !world.current.alive) await characterCreation();
  else { world.current.depth = 0; log(`（${world.current.name}は街にいる）`, "dim"); }
  await townLoop();
  await startDive();
}
void boot();

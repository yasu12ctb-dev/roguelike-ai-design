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
import { renderDeathLine, renderRediscovery, renderRumor, renderSetPieceIfAny, fillStoryletText, fillDungeonText } from "../render.ts";
import { rollEncounter } from "../weights.ts";
import { filterByTags } from "../content.ts";
import { selectStorylet, applyEffects, selectDungeonStorylet, applyDungeonEffects } from "../storylets.ts";
import storyletsJson from "../../content/storylets.json";
import {
  genFloor, placeFossil, computeFov, planMonsters, resolveMonsters, tileAt, cellIndex,
  FLOOR_W, FLOOR_H, type Floor, type Pos,
} from "../dungeon.ts";
import type { Character, FinalActChoice, Fossil, Fragment, SetPiece, Storylet, World } from "../types.ts";

const SAVE_KEY = "sekitsui.world.v0";
const MAX_HP = 12;
const PLAYER_DMG = 3; // 通常攻撃は確定ダメージ（miss無し・乱数なし：4-11A）

const db = makeContentDb(
  fragmentsJson as { fragments: Fragment[] },
  setpiecesJson as { setpieces: SetPiece[] },
  storyletsJson as { storylets: Storylet[] },
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
let mapMode = false; // 地図表示（踏破範囲の俯瞰）
let cellSize = 0;

// ---------- ステータスバー ----------
function updateStatus() {
  const ch = world.current;
  $("stName").textContent = ch ? `${ch.name}（第${world.generation}世代）` : "—";
  $("stDepth").textContent = String(mode === "dive" && floor ? floor.depth : 0);
  $("stHp").textContent = `HP ${hp}/${MAX_HP}`;
  const e = ch?.exposure ?? 0;
  const n = Math.min(5, Math.floor(e / 0.6));
  $("stExp").textContent = `深蝕 ${"▮".repeat(n)}${"░".repeat(5 - n)}`;
}

// ---------- マップ描画（方向A） ----------
let cells: HTMLElement[] = [];
function buildGridDom() {
  gridEl.innerHTML = "";
  cells = [];
  const csW = Math.min(window.innerWidth, 560) / FLOOR_W;
  const csH = ($("mapWrap").clientHeight - 4) / FLOOR_H;
  const cs = Math.min(csW, csH);
  cellSize = cs;
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
  if (mapMode) { drawMapMode(); return; }
  lightEl.style.display = "";
  const vis = computeFov(floor, player);
  // テレグラフ：見えている敵の予告マスを集める（攻撃＝討たれるマス／移動＝踏み込むマス）
  const teleAtk = new Set<number>(), teleMove = new Set<number>();
  for (const m of floor.monsters) {
    if (m.hp <= 0 || !m.intent || !vis.has(cellIndex(m.x, m.y))) continue;
    if (m.intent.type === "attack") teleAtk.add(cellIndex(m.intent.x, m.intent.y));
    else if (m.intent.type === "move") teleMove.add(cellIndex(m.intent.x, m.intent.y));
  }
  for (let y = 0; y < FLOOR_H; y++) for (let x = 0; x < FLOOR_W; x++) {
    const i = cellIndex(x, y);
    const c = cells[i], span = c.firstChild as HTMLElement;
    const t = tileAt(floor, x, y);
    const visible = vis.has(i), explored = floor.explored[i];
    c.classList.toggle("wall", t === 0 && explored);
    c.classList.toggle("tele-atk", visible && teleAtk.has(i));
    c.classList.toggle("tele-move", visible && !teleAtk.has(i) && teleMove.has(i));
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

/** 地図モード：踏破済み範囲を明るく俯瞰（敵は出さない。階段・化石・自分のみ） */
function drawMapMode() {
  if (!floor) return;
  lightEl.style.display = "none"; // 松明の減光を外す
  for (let y = 0; y < FLOOR_H; y++) for (let x = 0; x < FLOOR_W; x++) {
    const i = cellIndex(x, y);
    const c = cells[i], span = c.firstChild as HTMLElement;
    const t = tileAt(floor, x, y);
    const explored = floor.explored[i];
    c.classList.toggle("wall", t === 0 && explored);
    c.classList.remove("tele-atk", "tele-move"); // 地図モードでは予告を出さない
    if (!explored) { span.textContent = ""; c.style.filter = "brightness(0)"; continue; }
    let glyph = t === 0 ? "▒" : "·";
    let cls = t === 0 ? "g-wall" : "g-floor";
    if (x === floor.stairsDown.x && y === floor.stairsDown.y) { glyph = "›"; cls = "g-down"; }
    if (x === floor.stairsUp.x && y === floor.stairsUp.y) { glyph = "‹"; cls = "g-up"; }
    const fe = floor.fossils.find((e) => e.x === x && e.y === y);
    if (fe) { glyph = "†"; cls = fe.resolved ? "g-fossil-quiet" : "g-fossil"; }
    if (x === player.x && y === player.y) { glyph = "@"; cls = "g-player"; }
    span.textContent = glyph;
    span.className = cls;
    c.style.filter = "brightness(0.85)";
  }
  updateStatus();
}

function setMapMode(v: boolean) {
  mapMode = v;
  ($("mapBtn") as HTMLButtonElement).style.color = v ? "#e8e2d4" : "";
  draw();
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
  planMonsters(floor, player, rng); // 入った瞬間に見えている敵は予告を出す
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
  // 化石・階段の場面が開いた場合は、このターンの進行（深蝕・敵の手番）を保留する
  if (busy) { draw(); return; }

  // 深蝕（4-10C）
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

  // 敵の手番：予告した一手を実行（退いた予告は空振り＝見切り）
  const res = resolveMonsters(floor, player);
  for (const h of res.hits) {
    hp -= h.dmg;
    log(`${h.monster.kind.name}の一撃！ ${h.dmg}の傷。`, "warn");
  }
  for (const m of res.dodges) log(`${m.kind.name}の一撃を見切った。`, "dim");
  // 次の一手を予告する（プレイヤーが見て動けるように）
  planMonsters(floor, player, rng);

  draw();
  if (hp <= 0) await deathFlow();
}

/** 移動 or 体当たり。falseなら手番を消費しない（壁） */
function moveOrInteract(nx: number, ny: number): boolean {
  const f = floor!;
  if (tileAt(f, nx, ny) !== 1) return false;

  const mon = f.monsters.find((m) => m.hp > 0 && m.x === nx && m.y === ny);
  if (mon) { // 攻撃（確定命中・確定ダメージ）
    mon.hp -= PLAYER_DMG;
    log(mon.hp <= 0 ? `${mon.kind.name}を倒した。` : `${mon.kind.name}に${PLAYER_DMG}の一撃。`);
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
    if (r.pick === 1) { enterFloor(f.depth + 1, true); await maybeDungeonEvent(floor!.depth); }
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
    if (r.pick === 1) { enterFloor(f.depth - 1, false); await maybeDungeonEvent(floor!.depth); }
  }
  busy = false;
  draw();
}

/** 階移動時のダンジョン環境イベント（context=dungeon・4-12 F）。深度2以上で時々発火。 */
async function maybeDungeonEvent(depth: number) {
  if (depth < 2 || rng.next() >= 0.55) return;
  const ev = selectDungeonStorylet(db, depth, rng);
  if (!ev || !ev.choices || ev.choices.length === 0) return;
  const wasBusy = busy; busy = true;
  const r = await sheet({
    text: fillDungeonText(depth, ev.text ?? ""),
    meta: `深度${depth} ── 迷宮の気配`,
    options: ev.choices.map((c) => c.label),
  });
  const choice = ev.choices[r.pick - 1];
  if (choice.text) log(fillDungeonText(depth, choice.text));
  for (const line of applyDungeonEffects(world, world.current!, depth, choice.effects)) log(line, "dim");
  save();
  busy = wasBusy;
  if (!wasBusy) draw();
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
  const ch = world.current!;

  const canInherit = fossil.death.finalAct.choice === "leave_will" || fossil.death.finalAct.choice === "guard_relic";
  const storylet = selectStorylet(db, world, ch, fossil, v, rng);
  const done = new Set<string>();

  // 遭遇＝イベントノード（4-12）：〈調べる〉〈捜索〉で掘り下げ／伏線を残してから干渉動詞を選ぶ
  for (;;) {
    const opts: string[] = [];
    if (storylet?.investigate && !done.has("investigate")) opts.push("調べる");
    if (storylet?.search && !done.has("search")) opts.push("周辺を捜索する");
    opts.push("鎮魂する（末路を閉じ、変質の時計を巻き戻す）");
    if (canInherit) opts.push("遺されたものを継ぐ");
    opts.push("そっと立ち去る");

    const r = await sheet({
      text,
      meta: `${fossil.origin.name}の化石 ── 極=${poleLabel(fossil.tonePole)} / 変質=${v.stage}${setPiece ? " / 山場" : ""}`,
      options: opts,
    });
    const label = opts[r.pick - 1];

    if (label === "調べる" && storylet?.investigate) {
      done.add("investigate");
      log(fillStoryletText(fossil, storylet.investigate.text));
      for (const line of applyEffects(world, ch, fossil, storylet.investigate.effects)) log(line, "dim");
      save();
      continue;
    }
    if (label === "周辺を捜索する" && storylet?.search) {
      done.add("search");
      log(fillStoryletText(fossil, storylet.search.text));
      for (const line of applyEffects(world, ch, fossil, storylet.search.effects)) log(line, "dim");
      save();
      continue;
    }
    if (label.startsWith("鎮魂")) {
      intervene(world, fossil.id, "requiem");
      log(`${ch.name}は祈りを捧げた。何かが、静かに鎮まった。`);
    } else if (label.startsWith("遺されたもの")) {
      intervene(world, fossil.id, "inherit");
      ch.traits.push(`継承:${fossil.origin.gearTags[0] ?? fossil.origin.name}`);
      log(`${ch.name}は${fossil.origin.name}の遺したものを受け取った。`);
    } else {
      log("お前は何もせず、その場を後にした。……それもまた、ひとつの答えだ。");
    }
    break;
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

// ---------- 入力（スワイプ＝移動／タップ＝その方向へ一歩・自分タップ＝待機） ----------
$("mapBtn").onclick = () => { if (mode === "dive" && !busy) setMapMode(!mapMode); };
addEventListener("keydown", (e) => {
  const map: Record<string, [number, number]> = {
    ArrowUp: [0, -1], ArrowDown: [0, 1], ArrowLeft: [-1, 0], ArrowRight: [1, 0], ".": [0, 0],
  };
  if (map[e.key]) {
    e.preventDefault();
    if (mapMode) { setMapMode(false); return; }
    void playerAct(...map[e.key]);
  }
});
let touchStart: { x: number; y: number } | null = null;
$("mapWrap").addEventListener("touchstart", (e) => {
  touchStart = { x: e.touches[0].clientX, y: e.touches[0].clientY };
}, { passive: true });
$("mapWrap").addEventListener("touchend", (e) => {
  if (!touchStart) return;
  const tx = e.changedTouches[0].clientX, ty = e.changedTouches[0].clientY;
  const dx = tx - touchStart.x, dy = ty - touchStart.y;
  touchStart = null;
  if (mapMode) { setMapMode(false); return; } // 地図中はどの操作でも閉じる
  if (Math.hypot(dx, dy) >= 24) { // スワイプ＝移動
    if (Math.abs(dx) > Math.abs(dy)) void playerAct(Math.sign(dx), 0);
    else void playerAct(0, Math.sign(dy));
    return;
  }
  // タップ＝その方向へ一歩（自分のマスをタップ＝待機）
  if (!floor || cellSize <= 0) return;
  const r = gridEl.getBoundingClientRect();
  const cx = Math.floor((tx - r.left) / cellSize);
  const cy = Math.floor((ty - r.top) / cellSize);
  if (cx < 0 || cy < 0 || cx >= FLOOR_W || cy >= FLOOR_H) return;
  const ddx = cx - player.x, ddy = cy - player.y;
  if (ddx === 0 && ddy === 0) { void playerAct(0, 0); return; } // 待機
  if (Math.abs(ddx) >= Math.abs(ddy)) void playerAct(Math.sign(ddx), 0);
  else void playerAct(0, Math.sign(ddy));
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

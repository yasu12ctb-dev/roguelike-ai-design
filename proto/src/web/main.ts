// Web（PWA）本体：方向A（発光グリフ）・縦持ち・D-pad左 のローグライク
// 街（シート）⇄ 迷宮（グリッド・ターン制）。化石はマップ上の実体として現れる。

import fragmentsJson from "../../content/fragments.json";
import setpiecesJson from "../../content/setpieces.json";
import { makeContentDb } from "../content.ts";
import { makeRng, type Rng } from "../rng.ts";
import {
  newWorld, createCharacter, fossilizeCurrent, intervene, recordRediscovery,
  chronicle, poleLabel, finalActLabel, migrateWorld,
} from "../world.ts";
import { computeVariation, exposureGain, QUIRK_THRESHOLDS } from "../variation.ts";
import {
  maxHp, meleeDmg, heartFactor, xpToNext, xpForKill, statsLine,
  STAT_KEYS, STAT_LABEL, HP_PER,
  armorReduce, effectiveReason, xpMul, equipExposure,
} from "../progression.ts";
import { SPELLS, spellByKey, warpDamage } from "../spells.ts";
import { rollItem, itemByName, itemPower, itemLabel, SLOT_LABEL } from "../items.ts";
import {
  renderDeathLine, renderRediscovery, renderRumor, renderSetPieceIfAny, fillStoryletText, fillDungeonText,
  requiemLine, leaveLine, inheritLine, REQUIEM_RELIEF,
} from "../render.ts";
import { rollEncounter } from "../weights.ts";
import { filterByTags } from "../content.ts";
import { selectStorylet, applyEffects, selectDungeonStorylet, applyDungeonEffects } from "../storylets.ts";
import storyletsJson from "../../content/storylets.json";
import { ensureAudio, sfx, setAmbient, setMuted, isMuted, loadMutePref } from "./audio.ts";
import {
  genFloor, placeFossil, computeFov, planMonsters, resolveMonsters, tileAt, mapIdx,
  VIEW_W, VIEW_H, type Floor, type Pos, type Chest, type Monster,
} from "../dungeon.ts";
import type { Character, FinalActChoice, Fossil, Fragment, Item, SetPiece, Storylet, World } from "../types.ts";

const SAVE_KEY = "sekitsui.world.v0";
// HP・攻撃力はステ由来（progression.ts）。体2/力2 で 最大HP12・攻撃3＝従来値。

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

// セーフティ網：どこかで未捕捉の例外が出ても入力ロック(busy)が永続化＝フリーズしないよう、
// 必ず解除しオーバーレイを閉じ、原因を画面に出す（バグ報告の手がかりにもなる）。
function recoverFromError(msg: string) {
  busy = false;
  try { overlayEl.classList.remove("show"); } catch { /* noop */ }
  try { log(`⚠ 不具合を検知（操作は復帰します）：${msg}`, "warn"); } catch { /* noop */ }
}
addEventListener("error", (e) => {
  const ev = e as ErrorEvent;
  recoverFromError(`${ev.message || "内部エラー"} @${ev.lineno}:${ev.colno}`);
});
addEventListener("unhandledrejection", (e) => {
  const r = (e as PromiseRejectionEvent).reason as Error | undefined;
  const frame = r?.stack?.split("\n")[1]?.trim();
  recoverFromError(`${r?.message ?? String(r)}${frame ? ` / ${frame}` : ""}`);
});

// ---------- シート（場面＋選択肢。promise を返す） ----------
interface SheetOpts { text: string; meta?: string; options: string[]; input?: string; }
function sheet(o: SheetOpts): Promise<{ pick: number; text: string }> {
  return new Promise((resolve) => {
    sheetText.textContent = o.text;
    sheetMeta.textContent = o.meta ?? "";
    sheetInputRow.classList.toggle("show", o.input !== undefined);
    sheetInput.value = ""; sheetInput.placeholder = o.input ?? "";
    sheetButtons.innerHTML = "";
    const shownAt = performance.now();
    o.options.forEach((label, i) => {
      const b = document.createElement("button");
      b.type = "button"; b.textContent = label;
      // 直前の操作（敵を倒したタップ等）が出たてのシートを貫通して誤選択するのを防ぐデバウンス。
      b.onclick = () => {
        if (performance.now() - shownAt < 300) return;
        overlayEl.classList.remove("show");
        resolve({ pick: i + 1, text: sheetInput.value });
      };
      sheetButtons.appendChild(b);
    });
    overlayEl.classList.add("show");
  });
}

// 術のエリア点滅（4-11F③）。at を渡すと対象/自分の画面位置を中心に光らせる。
let fxClearTimer: ReturnType<typeof setTimeout> | null = null;
function flashFx(kind: "warp" | "still" | "blink", at?: Pos) {
  const fxEl = $("fx") as HTMLElement;
  if (at) {
    fxEl.style.setProperty("--fxx", ((at.x - cam.x + 0.5) / VIEW_W * 100) + "%");
    fxEl.style.setProperty("--fxy", ((at.y - cam.y + 0.5) / VIEW_H * 100) + "%");
  } else {
    fxEl.style.setProperty("--fxx", "50%"); fxEl.style.setProperty("--fxy", "48%");
  }
  fxEl.classList.remove("warp", "still", "blink");
  void fxEl.offsetWidth; // リフロー＝連続詠唱でもアニメを頭から再生
  fxEl.classList.add(kind);
  if (fxClearTimer) clearTimeout(fxClearTimer);
  fxClearTimer = setTimeout(() => fxEl.classList.remove(kind), 650);
}

// ---------- 世界の永続化 ----------
function loadOrCreateWorld(): World {
  const raw = localStorage.getItem(SAVE_KEY);
  if (raw) {
    try {
      const w = migrateWorld(JSON.parse(raw) as World);
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
let hp = world.current ? maxHp(world.current) : 12;
let mode: "town" | "dive" = "town";
let floor: Floor | null = null;
let player: Pos = { x: 0, y: 0 };
let busy = false; // シート表示中の入力ロック
let mapMode = false; // 地図表示（踏破範囲の俯瞰）
let cellSize = 0;
let cam: Pos = { x: 0, y: 0 }; // ビューポートの左上（@ を追うカメラ）
const clampCam = (v: number, mapSize: number, viewSize: number) => Math.max(0, Math.min(v, mapSize - viewSize));

// ---------- ステータスバー ----------
function updateStatus() {
  const ch = world.current;
  $("stName").textContent = ch ? `${ch.name}（第${world.generation}世代）` : "—";
  $("stDepth").textContent = String(mode === "dive" && floor ? floor.depth : 0);
  $("stHp").textContent = ch ? `Lv${ch.level}  HP ${hp}/${maxHp(ch)}` : `HP ${hp}`;
  const e = ch?.exposure ?? 0;
  const n = Math.min(5, Math.floor(e / 0.6));
  $("stExp").textContent = `深蝕 ${"▮".repeat(n)}${"░".repeat(5 - n)}`;
}

// ---------- マップ描画（方向A） ----------
let cells: HTMLElement[] = [];
// 既定はプレイ用ビュー(VIEW)。地図モードでは実マップ寸法(floor.w×floor.h)で組み直し、1セル=1タイルで忠実描画する。
function buildGridDom(cols = VIEW_W, rows = VIEW_H) {
  gridEl.innerHTML = "";
  cells = [];
  const csW = Math.min(window.innerWidth, 560) / cols;
  const csH = ($("mapWrap").clientHeight - 4) / rows;
  const cs = Math.min(csW, csH);
  cellSize = cs;
  (gridEl as HTMLElement).style.gridTemplateColumns = `repeat(${cols}, ${cs}px)`;
  (gridEl as HTMLElement).style.justifyContent = "center";
  for (let i = 0; i < cols * rows; i++) {
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
  // カメラ：@ を中心に、マップ端ではクランプ（マップは常にビューより大きい）
  const camX = clampCam(player.x - (VIEW_W >> 1), floor.w, VIEW_W);
  const camY = clampCam(player.y - (VIEW_H >> 1), floor.h, VIEW_H);
  cam = { x: camX, y: camY };
  // テレグラフ（別表現）：移動予告＝行き先に敵の「残像グリフ」を薄く出す／攻撃予告＝自分のマスが
  // 討たれる→ @ が赤く明滅。抽象的な枠・点はやめ「敵がどこへ来るか」「自分が危ない」を直接見せる。
  const teleMove = new Set<number>();        // 敵が踏み込む先の床マス（背景ハイライト）
  let playerThreatened = false;              // 自分のマスが攻撃予告されている
  for (const m of floor.monsters) {
    if (m.hp <= 0 || !m.intent || !vis.has(mapIdx(floor, m.x, m.y))) continue;
    if (m.intent.type === "attack") {
      if (m.intent.x === player.x && m.intent.y === player.y) playerThreatened = true;
    } else if (m.intent.type === "move") {
      teleMove.add(mapIdx(floor, m.intent.x, m.intent.y));
    }
  }
  for (let vy = 0; vy < VIEW_H; vy++) for (let vx = 0; vx < VIEW_W; vx++) {
    const c = cells[vy * VIEW_W + vx], span = c.firstChild as HTMLElement;
    const x = camX + vx, y = camY + vy;
    const inside = x >= 0 && y >= 0 && x < floor.w && y < floor.h;
    const mi = inside ? mapIdx(floor, x, y) : -1;
    const t = tileAt(floor, x, y);
    const visible = inside && vis.has(mi), explored = inside && floor.explored[mi];
    c.classList.toggle("wall", t === 0 && explored);
    if (!explored) { span.textContent = ""; c.style.filter = "brightness(0)"; c.classList.remove("tele-atk", "tele-move"); continue; }

    let glyph = t === 0 ? "▒" : "·";
    let cls = t === 0 ? "g-wall" : "g-floor";
    if (x === floor.stairsDown.x && y === floor.stairsDown.y) { glyph = "›"; cls = "g-down"; }
    if (x === floor.stairsUp.x && y === floor.stairsUp.y) { glyph = "‹"; cls = "g-up"; }
    if (visible) {
      const fe = floor.fossils.find((e) => e.x === x && e.y === y);
      if (fe) { glyph = "†"; cls = fe.resolved ? "g-fossil-quiet" : "g-fossil"; }
      const ce = floor.chests.find((c) => c.x === x && c.y === y);
      if (ce) { glyph = "▭"; cls = ce.opened ? "g-chest-open" : "g-chest"; }
      const m = floor.monsters.find((m) => m.hp > 0 && m.x === x && m.y === y);
      if (m) {
        glyph = m.kind.glyph;
        cls = m.boss === "area" ? "g-boss" : m.boss === "elite" ? "g-elite"
          : `g-mon-t${m.kind.tier}${m.intent?.type === "attack" ? " g-mon-atk" : ""}`;
      }
    }
    // 移動予告：敵が踏み込む先の「何も無い床マス」を背景色でハイライト（グリフは出さない）
    c.classList.toggle("tele-move", visible && cls === "g-floor" && teleMove.has(mi));
    const isPlayer = x === player.x && y === player.y;
    if (isPlayer) { glyph = "@"; cls = playerThreatened ? "g-player-danger" : "g-player"; }
    c.classList.toggle("tele-atk", isPlayer && playerThreatened); // 攻撃予告の赤枠は自分のマスだけ
    span.textContent = glyph;
    span.className = cls;
    const d = Math.hypot(x - player.x, y - player.y);
    const b = visible ? Math.max(0.35, 1 - d / 11) : 0.16; // 記憶は薄暗く
    c.style.filter = `brightness(${b.toFixed(2)})`;
  }
  // 光源は @ のビュー内位置
  lightEl.style.setProperty("--px", ((player.x - camX + 0.5) / VIEW_W * 100) + "%");
  lightEl.style.setProperty("--py", ((player.y - camY + 0.5) / VIEW_H * 100) + "%");
  updateStatus();
}

/** 地図モード：実マップを 1セル=1タイルでそのまま忠実描画（プレイ画面と完全一致）。
 *  グリッドは buildGridDom(floor.w, floor.h) で組み直し済み。小さいので主に背景色で読ませる。 */
function drawMapMode() {
  if (!floor) return;
  lightEl.style.display = "none"; // 松明の減光を外す
  const W = floor.w, H = floor.h;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = y * W + x; // = mapIdx(floor, x, y)
    const c = cells[i], span = c.firstChild as HTMLElement;
    c.classList.remove("tele-atk", "tele-move", "wall");
    c.style.filter = "brightness(1)";
    if (!floor.explored[i]) { span.textContent = ""; c.style.background = "#05070a"; continue; }
    const isFloor = floor.tiles[i] === 1;
    let bg = isFloor ? "#2b3442" : "#141a23"; // 床=明るい / 壁=暗い
    let glyph = "", cls = "";
    if (x === floor.stairsDown.x && y === floor.stairsDown.y) { bg = "#173b44"; glyph = "›"; cls = "g-down"; }
    else if (x === floor.stairsUp.x && y === floor.stairsUp.y) { bg = "#173b44"; glyph = "‹"; cls = "g-up"; }
    const fe = floor.fossils.find((e) => e.x === x && e.y === y);
    if (fe) { bg = "#1f433d"; glyph = "†"; cls = fe.resolved ? "g-fossil-quiet" : "g-fossil"; }
    if (floor.chests.some((cc) => cc.x === x && cc.y === y && !cc.opened)) { bg = "#473916"; glyph = "▭"; cls = "g-chest"; }
    if (x === player.x && y === player.y) { bg = "#5a4a1a"; glyph = "@"; cls = "g-player"; }
    c.style.background = bg;
    span.textContent = glyph;
    span.className = cls;
  }
  updateStatus();
}

function setMapMode(v: boolean) {
  mapMode = v;
  ($("mapBtn") as HTMLButtonElement).style.color = v ? "#e8e2d4" : "";
  // 地図↔プレイでグリッド寸法が変わるので組み直す（実マップ忠実 vs カメラ窓）
  if (v && floor) { buildGridDom(floor.w, floor.h); drawMapMode(); }
  else { buildGridDom(VIEW_W, VIEW_H); draw(); }
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
  const ch = createCharacter(world, name, "wanderer", lineage);
  hp = maxHp(ch);
  log(`${ch.name}は、まっさらな素質で迷宮へ向かう（${statsLine(ch)}）。`, "dim");
  if (ch.bonds.some((b) => b.unfinished)) log("……先代の未完の因縁が、お前に引き継がれた。", "warn");
  save();
}

// ---------- 街 ----------
async function townLoop() {
  mode = "town"; floor = null; setAmbient(false); updateStatus();
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
  setAmbient(true, depth); // 環境ドローン（深いほど低い）
  draw();
  log(`── 深度${depth} ──`, "dim");
}

let seenThisDive: string[] = [];

async function startDive() {
  mode = "dive";
  seenThisDive = [];
  if (world.current) hp = maxHp(world.current); // 街で癒えた状態から潜る
  enterFloor(1, true);
  log("迷宮に降りた。冷えた空気が頬を撫でる。");
}

// ---------- 1ターンの処理 ----------
async function playerAct(dx: number, dy: number) {
  if (busy || mode !== "dive" || !floor || !world.current) return;

  if (!(dx === 0 && dy === 0)) {
    const nx = player.x + dx, ny = player.y + dy;
    if (!moveOrInteract(nx, ny)) return; // 壁
  }
  // 化石・階段の場面が開いた場合は、このターンの進行（深蝕・敵の手番）を保留する
  if (busy) { draw(); return; }
  await endTurn();
}

/** 1手ぶんの後処理：深蝕→奇癖→敵の手番→予告更新→描画→昇級→死。移動も詠唱もここに合流する。 */
async function endTurn() {
  if (!floor || !world.current) return;
  const ch = world.current;

  // 深蝕（4-10C）。心・遺物で染み込みが遅く、異物装備でじわり増える（progression）。
  ch.exposure += exposureGain(floor.depth) * heartFactor(ch) + equipExposure(ch);
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

  // 敵の手番：予告した一手を実行（退いた予告は空振り＝見切り。静止中はwait）
  const res = resolveMonsters(floor, player);
  if (res.hits.length) sfx("hurt");
  for (const h of res.hits) {
    const dmg = Math.max(1, h.dmg - armorReduce(ch)); // 防具で軽減（下限1）
    hp -= dmg;
    log(`${h.monster.kind.name}の一撃！ ${dmg}の傷。`, "warn");
  }
  for (const m of res.dodges) log(`${m.kind.name}の一撃を見切った。`, "dim");
  // 次の一手を予告する（プレイヤーが見て動けるように）
  planMonsters(floor, player, rng);

  draw();
  await handleBossResolve();
  await handleLevelUps();
  await handleDrops();
  if (hp <= 0) await deathFlow();
}

// ---------- 装備（4-11F④）。拾得＝装備プロンプト。ボス/宝箱から入手。 ----------
let pendingDrops: Item[] = [];
let pendingBossResolve: Monster[] = [];

/** 撃破処理の入口。敵性化探索者ボス（出自=化石）は「討つ/鎮める」へ。それ以外は通常撃破。 */
function downOrKill(mon: Monster, killLine?: string) {
  if (mon.boss === "area" && mon.fossilId) {
    pendingBossResolve.push(mon);
    log(`${mon.kind.name}は膝をついた……。`, "warn");
  } else {
    rewardKill(mon, killLine);
  }
}

/** ⑤鎮め筋（4-11D）：弱らせた敵性化探索者を「討つ／鎮める（非殺）」。選択が年代記に残る。 */
async function handleBossResolve() {
  if (!pendingBossResolve.length) return;
  busy = true;
  while (pendingBossResolve.length) {
    const boss = pendingBossResolve.shift()!;
    const ch = world.current!;
    const r = await sheet({
      text: `${boss.kind.name}は膝をついた。かつて人だったものの眼が、こちらを見ている。\nとどめを刺すか――それとも、鎮めるか。`,
      meta: `${boss.kind.name} ── 決着（戦闘版の干渉）`,
      options: ["討つ（とどめ：XP満額＋遺物）", "鎮める（祈り：非殺・年代記に残る）"],
    });
    if (r.pick === 2 && boss.fossilId) {
      sfx("intervene"); flashFx("still");
      intervene(world, boss.fossilId, "requiem"); // 出自の化石を鎮魂（4-2 干渉動詞）
      ch.xp += Math.round(xpForKill(boss.kind.hp) * 0.5 * xpMul(ch)); // 鎮めは報酬控えめ＝慈悲の代償
      log(`★ ${ch.name}は${boss.kind.name}を鎮めた。深みの底で、何かが静かになった。`, "warn");
      chronicle(world, "intervention", `${ch.name}が深度${floor!.depth}で${boss.kind.name}を鎮めた。`, [ch.id, boss.fossilId]);
    } else {
      rewardKill(boss); // 討つ＝通常撃破（XP満額＋ドロップ＋legend）
    }
  }
  busy = false;
  save(); updateStatus(); draw();
}

/** 手番末に溜まったドロップ（主にボス）を順に提示。 */
async function handleDrops() {
  if (!pendingDrops.length) return;
  busy = true;
  while (pendingDrops.length) await equipPrompt(pendingDrops.shift()!);
  busy = false;
  save(); updateStatus(); draw();
}

/** 装備プロンプト（busy は呼び出し側が保持）。装備すると未鑑定は判明する。 */
async function equipPrompt(item: Item) {
  const ch = world.current;
  if (!ch) return;
  const cur = ch.equipment[item.slot];
  const head = item.unidentified
    ? `見知らぬ${SLOT_LABEL[item.slot]}を手にした。（未鑑定：装備すれば正体が分かる）`
    : `${item.name} を手にした。（${itemPower(item)}）`;
  const r = await sheet({
    text: head + (cur ? `\n今の${SLOT_LABEL[item.slot]}：${itemLabel(cur)}` : ""),
    meta: `${SLOT_LABEL[item.slot]} ── 装備`,
    options: ["装備する", "見送る"],
  });
  if (r.pick === 1) {
    item.unidentified = false; // 装備で鑑定
    ch.equipment[item.slot] = item;
    sfx("open");
    log(`${item.name} を装備した（${itemPower(item)}）。`);
    if (item.exposurePerTurn) log("……身につけた途端、深みがじわりと滲む。", "warn");
  }
}

// ---------- 深蝕魔法（4-11F③）。燃料＝深蝕。詠唱＝そのターンの行動。自動対象で最小UX ----------
$("spellBtn").onclick = async () => {
  if (busy || mode !== "dive" || !floor || !world.current) return;
  const ch = world.current;
  if (ch.spells.length === 0) { log("まだ術を識らない。レベルアップで識れる。", "dim"); return; }
  busy = true;
  const known = ch.spells.map((k) => spellByKey(k)).filter((s): s is NonNullable<typeof s> => !!s);
  const r = await sheet({
    text: `深みの力を引く。代償は深蝕（今 ${ch.exposure.toFixed(2)}）。`,
    meta: "術 ── 深蝕を支払って盤面を曲げる",
    options: [...known.map((s) => `${s.name}（深蝕＋${s.cost}）── ${s.desc}`), "やめる"],
  });
  busy = false;
  const spell = known[r.pick - 1];
  if (spell) await castSpell(spell.key);
};

async function castSpell(key: string) {
  if (busy || mode !== "dive" || !floor || !world.current) return;
  const ch = world.current;
  const def = spellByKey(key);
  if (!def) return;
  const vis = computeFov(floor, player);
  const visMon = floor.monsters.filter((m) => m.hp > 0 && vis.has(mapIdx(floor, m.x, m.y)));

  if (key === "warp_strike") {
    if (!visMon.length) { log("討つべき敵が見えない。", "dim"); draw(); return; }
    const target = visMon.reduce((a, b) =>
      Math.hypot(a.x - player.x, a.y - player.y) <= Math.hypot(b.x - player.x, b.y - player.y) ? a : b);
    const dmg = warpDamage(effectiveReason(ch)); // 遺物「理脈」で威力+
    target.hp -= dmg;
    sfx("spell_warp"); flashFx("warp", { x: target.x, y: target.y });
    if (target.hp <= 0) downOrKill(target, `歪んだ一撃。${target.kind.name}を討ち砕いた。`);
    else log(`歪撃が${target.kind.name}を抉る（${dmg}）。`);
  } else if (key === "still_eye") {
    if (!visMon.length) { log("止めるべき敵が見えない。", "dim"); draw(); return; }
    for (const m of visMon) { m.intent = { type: "wait" }; m.stunned = 1; }
    sfx("spell_still"); flashFx("still");
    log(`静止の眼。${visMon.length}体の動きが、凍りついた。`);
  } else if (key === "shadow_step") {
    if (!visMon.length) { log("逃げる相手がいない。", "dim"); draw(); return; }
    let best: Pos | null = null, bestScore = -1;
    for (const mi of vis) {
      const x = mi % floor.w, y = Math.floor(mi / floor.w);
      if (tileAt(floor, x, y) !== 1) continue;
      if (x === player.x && y === player.y) continue;
      if (floor.monsters.some((m) => m.hp > 0 && m.x === x && m.y === y)) continue;
      const nearest = Math.min(...visMon.map((m) => Math.hypot(m.x - x, m.y - y)));
      if (nearest > bestScore) { bestScore = nearest; best = { x, y }; }
    }
    if (!best) { log("渡れる先がない。", "dim"); draw(); return; }
    flashFx("blink", { x: player.x, y: player.y }); // 抜ける瞬間（元の位置）を光らせる
    player = best;
    sfx("spell_blink");
    log("影を踏んで、ひと息に渡った。");
  }

  ch.exposure += def.cost;
  log(`（${def.name}の代償：深蝕＋${def.cost}）`, "dim");
  await endTurn();
}

/** 撃破で貯まったXPがレベル閾値を超えていれば、超えたぶんだけ昇級＝ステ選択（4-11F②）。 */
async function handleLevelUps() {
  const ch = world.current;
  if (!ch) return;
  try {
    while (ch.xp >= xpToNext(ch.level)) {
      ch.xp -= xpToNext(ch.level);
      ch.level += 1;
      busy = true;
      // ステ+1 に加え、未習得の術を「識る」選択肢（snapshot：ステ上昇 or 術習得）
      const learnable = SPELLS.filter((s) => !ch.spells.includes(s.key));
      const r = await sheet({
        text: `レベル${ch.level}に達した。何を伸ばす？`,
        meta: `${statsLine(ch)} ── 最大HP${maxHp(ch)} / 攻撃${meleeDmg(ch)}`,
        options: [
          `体 ＋1（最大HPが上がる）`,
          `力 ＋1（攻撃が上がる）`,
          `理 ＋1（深蝕魔法の威力：のちの力）`,
          `心 ＋1（深蝕に染まりにくくなる）`,
          ...learnable.map((s) => `術を識る：${s.name}（深蝕＋${s.cost}／${s.desc}）`),
        ],
      });
      if (r.pick <= 4) {
        const key = STAT_KEYS[r.pick - 1];
        ch.stats[key] += 1;
        if (key === "body") hp = Math.min(hp + HP_PER, maxHp(ch)); // 体UPぶんを回復
        log(`レベル${ch.level} ── ${STAT_LABEL[key]}が伸びた（${statsLine(ch)}）。`, "warn");
      } else {
        const s = learnable[r.pick - 5];
        ch.spells.push(s.key);
        log(`レベル${ch.level} ── 深みから《${s.name}》を識った。`, "warn");
      }
      busy = false;
    }
  } finally {
    busy = false; // 例外が出ても入力ロックを残さない
  }
  save();
  updateStatus();
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** 既踏破の床のみを通って from→to の最短経路を返す（4方向BFS）。到達不能なら null。 */
function bfsPath(f: Floor, from: Pos, to: Pos): Pos[] | null {
  const W = f.w, H = f.h;
  if (to.x < 0 || to.y < 0 || to.x >= W || to.y >= H) return null;
  if (!f.explored[mapIdx(f, to.x, to.y)] || f.tiles[mapIdx(f, to.x, to.y)] !== 1) return null;
  const prev = new Int32Array(W * H).fill(-1);
  const start = mapIdx(f, from.x, from.y);
  prev[start] = start;
  const q: Pos[] = [from];
  for (let head = 0; head < q.length; head++) {
    const c = q[head];
    if (c.x === to.x && c.y === to.y) break;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
      const nx = c.x + dx, ny = c.y + dy;
      if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
      const i = mapIdx(f, nx, ny);
      if (prev[i] !== -1 || !f.explored[i] || f.tiles[i] !== 1) continue;
      prev[i] = mapIdx(f, c.x, c.y);
      q.push({ x: nx, y: ny });
    }
  }
  const ti = mapIdx(f, to.x, to.y);
  if (prev[ti] === -1) return null;
  const path: Pos[] = [];
  for (let cur = ti; cur !== start; cur = prev[cur]) path.push({ x: cur % W, y: Math.floor(cur / W) });
  path.reverse();
  return path;
}

/** 図でタップした既踏破地点まで自動移動。敵が見えたら/場面が開いたら止まる（4-11 便利機能）。 */
async function autoTravel(dest: Pos) {
  if (busy || mode !== "dive" || !floor) return;
  const path = bfsPath(floor, player, dest);
  if (!path || !path.length) { log("そこへの道が見つからない。", "dim"); return; }
  for (const step of path) {
    if (busy || mode !== "dive" || !floor) break;
    // 敵が見えていたら自動移動は危険なので止める
    const vis = computeFov(floor, player);
    if (floor.monsters.some((m) => m.hp > 0 && vis.has(mapIdx(floor, m.x, m.y)))) { log("敵の気配。自動移動を止めた。", "warn"); break; }
    const dx = Math.sign(step.x - player.x), dy = Math.sign(step.y - player.y);
    const px = player.x, py = player.y;
    if (!moveOrInteract(player.x + dx, player.y + dy)) break; // 壁
    if (busy) { draw(); break; } // 宝箱/化石/階段の場面が開いた＝そこで止める
    await endTurn();
    if (hp <= 0 || (player.x === px && player.y === py)) break; // 死亡 or 進めず
    await sleep(70);
  }
}

/** 撃破時の報酬：XP（敵の堅さ比例）。ボスは特別演出＋年代記に刻む（4-11F）。 */
function rewardKill(mon: Monster, killLine?: string) {
  const ch = world.current!;
  ch.xp += Math.round(xpForKill(mon.kind.hp) * xpMul(ch)); // 遺物「貪欲」でXP増
  if (mon.boss) {
    sfx("intervene");
    flashFx("warp");
    log(`★ ${mon.kind.name}を打ち倒した！`, "warn");
    chronicle(world, "legend", `${ch.name}が深度${floor!.depth}で${mon.kind.name}を打ち倒した。`, [ch.id]);
    // ボスドロップ：エリアは確定、エリートは高確率（手番末の装備プロンプトへ）
    if (mon.boss === "area" || rng.next() < 0.7) pendingDrops.push(rollItem(floor!.depth, rng, { boss: true }));
  } else {
    log(killLine ?? `${mon.kind.name}を倒した。`);
  }
}

/** 移動 or 体当たり。falseなら手番を消費しない（壁） */
function moveOrInteract(nx: number, ny: number): boolean {
  const f = floor!;
  if (tileAt(f, nx, ny) !== 1) return false;

  const mon = f.monsters.find((m) => m.hp > 0 && m.x === nx && m.y === ny);
  if (mon) { // 攻撃（確定命中・確定ダメージ＝力依存）
    const ch = world.current!;
    const dmg = meleeDmg(ch);
    mon.hp -= dmg;
    sfx("hit");
    if (mon.hp <= 0) downOrKill(mon); // 撃破→ボスは討つ/鎮める、他は通常（手番末で処理）
    else log(`${mon.kind.name}に${dmg}の一撃。`);
    return true;
  }

  const fe = f.fossils.find((e) => e.x === nx && e.y === ny);
  if (fe && !fe.resolved) { void fossilScene(fe); return true; }

  const ce = f.chests.find((c) => c.x === nx && c.y === ny);
  if (ce && !ce.opened) { void chestScene(ce); return true; }

  player = { x: nx, y: ny };
  sfx("move");

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
    if (r.pick === 1) { sfx("stairs"); enterFloor(f.depth + 1, true); await maybeDungeonEvent(floor!.depth); }
  } else if (f.depth === 1) {
    const r = await sheet({ text: "地上への階段だ。街へ戻るか？\n（傷は癒えるが、浴びた深みは消えない）", options: ["街へ戻る", "とどまる"] });
    if (r.pick === 1) {
      hp = maxHp(world.current!); world.current!.depth = 0; save();
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
  sfx("open");
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
  sfx("open");
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
      sfx("intervene");
      intervene(world, fossil.id, "requiem");
      const before = ch.exposure;
      ch.exposure = Math.max(0, ch.exposure - REQUIEM_RELIEF); // 人間性の回復弁（4-12B）
      log(requiemLine(fossil, rng));
      if (ch.exposure < before) log(`深みに削られた芯が、少し人へ還る（深蝕 -${(before - ch.exposure).toFixed(2)}）。`, "dim");
    } else if (label.startsWith("遺されたもの")) {
      sfx("intervene");
      intervene(world, fossil.id, "inherit"); // 未完の目的を負う（4-12B）
      log(inheritLine(fossil, rng));
      // 先代が握っていた武器を奪還＝実際に装備できる（4-11E）。武器でなければ形質として継ぐ。
      const gear = fossil.origin.gearTags[0];
      const reclaimed = gear ? itemByName(gear) : null;
      if (reclaimed) {
        log(`${ch.name}は${fossil.origin.name}の${gear}を取り戻した。`);
        await equipPrompt(reclaimed);
      } else {
        ch.traits.push(`継承:${gear ?? fossil.origin.name}`);
      }
    } else {
      // 立ち去る＝放置（4-12B）：因縁を未完のまま残す＝再来の種。intervene しない（変質の時計は進み続ける）
      const bond = ch.bonds.find((b) => b.entityRef === fossil.id);
      if (bond) bond.unfinished = true;
      else ch.bonds.push({ entityRef: fossil.id, value: 0, unfinished: true });
      chronicle(world, "rediscovery", `${ch.name}は${fossil.origin.name}を、深みに置き去りにした。（未完のまま）`, [fossil.id]);
      log(leaveLine(fossil, rng));
    }
    break;
  }
  fe.resolved = true;
  save();
  busy = false;
  draw();
}

// ---------- 宝箱（NetHack風：装備ドロップ／稀に罠。4-11F④） ----------
async function chestScene(ce: Chest) {
  if (busy) return;
  busy = true;
  const depth = floor!.depth;
  const ch = world.current!;
  const r = await sheet({ text: "古びた宝箱がある。開けてみるか？", meta: `深度${depth} ── 宝箱`, options: ["開ける", "見送る"] });
  if (r.pick === 1) {
    sfx("chest");
    // 開けた宝箱はマップから取り除く（空き箱を残さない）
    const i = floor!.chests.indexOf(ce);
    if (i >= 0) floor!.chests.splice(i, 1);
    if (rng.next() < 0.15) { // 罠
      const dmg = 0.12 + rng.next() * 0.12;
      ch.exposure += dmg;
      log("蓋を開けた瞬間、淀んだ気が噴き上がった——罠だ。", "warn");
      log(`深みが、まともに染みた（深蝕 +${dmg.toFixed(2)}）。`, "dim");
    } else { // 装備ドロップ
      const item = rollItem(depth, rng);
      log("宝箱から、何かを手にした。");
      await equipPrompt(item);
    }
  }
  save();
  busy = false;
  draw();
}

// ---------- 死 → 最後の一手（4-10B）→ 世代交代 ----------
async function deathFlow() {
  busy = true;
  sfx("death"); setAmbient(false);
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
  await characterCreation(); // 新キャラ作成時に hp は最大HPへ
  await townLoop();
  await startDive();
}

// ---------- メニュー（≡：今後拡張のフック） ----------
$("menuBtn").onclick = async () => {
  if (busy) return;
  busy = true;
  const ch = world.current;
  const spellNames = ch ? ch.spells.map((k) => spellByKey(k)?.name).filter(Boolean).join("、") : "";
  const eq = ch?.equipment;
  const eqLine = eq
    ? `\n装備: 武器=${eq.weapon ? itemLabel(eq.weapon) : "なし"} / 防具=${eq.armor ? itemLabel(eq.armor) : "なし"} / 遺物=${eq.relic ? itemLabel(eq.relic) : "なし"}`
    : "";
  const sheetHead = ch
    ? `《${ch.name}》Lv${ch.level} ── ${statsLine(ch)}\n最大HP${maxHp(ch)} / 攻撃${meleeDmg(ch)} / 次のレベルまで残り${Math.max(0, xpToNext(ch.level) - ch.xp)}${eqLine}\n深蝕 ${ch.exposure.toFixed(2)}${spellNames ? `\n術: ${spellNames}` : ""}${ch.traits.length ? `\n形質: ${ch.traits.join("、")}` : ""}\n\n`
    : "";
  const mark = { birth: "生", death: "死", rediscovery: "再", intervention: "干", legend: "伝", rumor: "噂" } as const;
  const tail = world.chronicle.slice(-10).map((e) => `世代${e.generation} [${mark[e.kind]}] ${e.text}`).join("\n");
  const r = await sheet({
    text: sheetHead + (tail || "まだ何も記されていない。"),
    meta: `人物と年代記 ── 全${world.chronicle.length}件`,
    options: [isMuted() ? "♪ 音を出す" : "🔇 音を消す", "閉じる"],
  });
  busy = false;
  if (r.pick === 1) { ensureAudio(); setMuted(!isMuted()); }
};

// ---------- 入力（スワイプ＝移動／タップ＝待機／図でタップ＝そこまで自動移動・矢印キー＝移動・.＝待機） ----------
$("mapBtn").onclick = () => { if (mode === "dive" && !busy) setMapMode(!mapMode); };
// 最初のユーザー操作で音を起動（iOS は AudioContext を gesture 内で resume する必要がある）
addEventListener("pointerdown", () => ensureAudio());
addEventListener("keydown", (e) => {
  ensureAudio();
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
  const tap = Math.hypot(dx, dy) < 24;

  if (mapMode) {
    // 図：踏破済みの床をタップ→そこまで自動移動。スワイプ等は閉じるだけ。
    if (tap && floor && cellSize > 0) {
      const r = gridEl.getBoundingClientRect();
      const cx = Math.floor((tx - r.left) / cellSize), cy = Math.floor((ty - r.top) / cellSize);
      if (cx >= 0 && cy >= 0 && cx < floor.w && cy < floor.h &&
          floor.explored[mapIdx(floor, cx, cy)] && tileAt(floor, cx, cy) === 1 &&
          !(cx === player.x && cy === player.y)) {
        setMapMode(false);
        void autoTravel({ x: cx, y: cy });
        return;
      }
    }
    setMapMode(false);
    return;
  }

  if (!tap) { // スワイプ＝移動
    if (Math.abs(dx) > Math.abs(dy)) void playerAct(Math.sign(dx), 0);
    else void playerAct(0, Math.sign(dy));
    return;
  }
  // タップ（ボタン以外の任意位置）＝待機。移動はスワイプで行う。
  void playerAct(0, 0);
}, { passive: true });

addEventListener("resize", () => {
  if (mode !== "dive") return;
  if (mapMode && floor) { buildGridDom(floor.w, floor.h); drawMapMode(); }
  else { buildGridDom(); draw(); }
});

// ---------- 起動 ----------
async function boot() {
  loadMutePref();
  buildGridDom();
  updateStatus();
  if (!world.current || !world.current.alive) await characterCreation();
  else { world.current.depth = 0; log(`（${world.current.name}は街にいる）`, "dim"); }
  await townLoop();
  await startDive();
}
void boot();

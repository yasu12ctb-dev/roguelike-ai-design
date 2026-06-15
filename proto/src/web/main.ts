// Web（PWA）本体：方向A（発光グリフ）・縦持ち・D-pad左 のローグライク
// 街（シート）⇄ 迷宮（グリッド・ターン制）。化石はマップ上の実体として現れる。

import fragmentsJson from "../../content/fragments.json";
import setpiecesJson from "../../content/setpieces.json";
import { makeContentDb } from "../content.ts";
import { makeRng, type Rng } from "../rng.ts";
import {
  newWorld, createCharacter, fossilizeCurrent, intervene, recordRediscovery,
  chronicle, poleLabel, finalActLabel, migrateWorld, awardSeal, abyssUnlocked,
} from "../world.ts";
import { computeVariation, exposureGain, QUIRK_THRESHOLDS } from "../variation.ts";
import {
  maxHp, meleeDmg, heartFactor, xpToNext, xpForKill, statsLine,
  STAT_KEYS, STAT_LABEL, HP_PER, carryCapacity, STASH_CAP, STASH_INHERIT,
  armorReduce, effectiveReason, xpMul, equipExposure, gearCapacity,
  DEPTH_SEAL_AT, ABYSS_DEPTH, RELIC_EXPOSURE_PER_TURN, RELIC_PURSUER_EVERY, RELIC_PURSUER_CAP,
} from "../progression.ts";
import { SPELLS, spellByKey, warpDamage } from "../spells.ts";
import { rollItem, rollItemOfSlot, itemByName, itemPower, itemLabel, itemValue, SLOT_LABEL, CONSUMABLES, consumableByKey } from "../items.ts";
import {
  renderDeathLine, renderRediscovery, renderRumor, renderSetPieceIfAny, matchSetPiece, fillStoryletText, fillDungeonText, fillActorText,
  requiemLine, leaveLine, inheritLine, REQUIEM_RELIEF,
} from "../render.ts";
import { rollEncounter } from "../weights.ts";
import { filterByTags } from "../content.ts";
import { selectStorylet, applyEffects, selectDungeonStorylet, applyDungeonEffects, selectTownStorylet, applyActorEffects } from "../storylets.ts";
import { meetActor } from "../actors.ts";
import {
  generateOffers, acceptQuest, activeQuests, doneQuests, claimQuest,
  onReachDepth, onRediscoverFossil,
} from "../quests.ts";
import storyletsJson from "../../content/storylets.json";
import townJson from "../../content/town.json";
import {
  buildTownGrid, buildInterior, spawnCrowd, wanderCrowd, crowdAt, townTileAt, interiorActorAt,
  type TownData, type TownGrid, type Interior, type CrowdActor, type InteriorActor, type GuardDef,
} from "../townscene.ts";
import { ensureAudio, sfx, setAmbient, setMuted, isMuted, loadMutePref } from "./audio.ts";
import {
  genFloor, placeFossil, computeFov, planMonsters, resolveMonsters, tileAt, mapIdx, spawnPursuer,
  VIEW_W, VIEW_H, type Floor, type Pos, type Chest, type Monster,
} from "../dungeon.ts";
import type { Character, FinalActChoice, Fossil, Fragment, Item, ItemSlot, SetPiece, Storylet, World } from "../types.ts";
import { SEAL_KEYS, SEAL_LABEL } from "../types.ts";

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
let mode: "town" | "dive" | "interior" = "town";
let floor: Floor | null = null;
let player: Pos = { x: 0, y: 0 };
let busy = false; // シート表示中の入力ロック
let mapMode = false; // 地図表示（踏破範囲の俯瞰）
let cellSize = 0;
let cam: Pos = { x: 0, y: 0 }; // ビューポートの左上（@ を追うカメラ）
const clampCam = (v: number, mapSize: number, viewSize: number) => Math.max(0, Math.min(v, mapSize - viewSize));

// ---------- 街シーン（4-4B：歩ける固定マップ） ----------
const townGrid: TownGrid = buildTownGrid(townJson as unknown as TownData);
let townPlayer: Pos = { ...townGrid.data.start };
let crowd: CrowdActor[] = [];        // 街路の群衆（使い捨て・非永続）
let interior: Interior | null = null; // 屋内シーン（null=街路）
let townReturn: Pos | null = null;    // 屋内に入る直前の街路位置（出たら戻る）
let wanderTimer: ReturnType<typeof setInterval> | null = null;
let townDescendResolve: (() => void) | null = null; // 門で潜行＝townLoop を解決

// ---------- ステータスバー ----------
function updateStatus() {
  const ch = world.current;
  $("stName").textContent = ch ? `${ch.name}（第${world.generation}世代）` : "—";
  $("stDepth").textContent = String(mode === "dive" && floor ? floor.depth : 0);
  $("stHp").textContent = ch ? `Lv${ch.level}  HP ${hp}/${maxHp(ch)}` : `HP ${hp}`;
  const e = ch?.exposure ?? 0;
  const n = Math.min(5, Math.floor(e / 0.6));
  $("stExp").textContent = `深蝕 ${"▮".repeat(n)}${"░".repeat(5 - n)}`;
  $("stGold").textContent = ch ? `金 ${ch.gold}` : "";
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

// ---------- 街・屋内の描画（全面可視・データ駆動のインライン色） ----------
const TOWN_BG: Record<string, string> = {
  void: "#0b0d10", floor: "#0c0e0c", wall: "#100e09", bldg: "#1b1813", noble: "#20191f",
  door: "#1a2028", gate: "#0b1418", ngate: "#1c1822", exit: "#1a2028", rug: "#161013",
};
function paintCell(c: HTMLElement, t: string, glyph: string, color: string, shadow: string) {
  const span = c.firstChild as HTMLElement;
  c.classList.remove("wall", "tele-atk", "tele-move");
  c.style.filter = "brightness(1)";
  c.style.background = TOWN_BG[t] ?? "#0b0d10";
  span.textContent = glyph; span.className = "";
  span.style.color = color; span.style.textShadow = shadow;
}
/** 街路：カメラ追従・全面可視。優先度 player>crowd>guard>door(看板)>gate/ngate>prop>地形。 */
function drawTown() {
  const data = townGrid.data;
  const VW = data.view.w, VH = data.view.h;
  const camX = clampCam(townPlayer.x - (VW >> 1), data.width, VW);
  const camY = clampCam(townPlayer.y - (VH >> 1), data.height, VH);
  cam = { x: camX, y: camY };
  lightEl.style.display = "none"; // 街は安全・既知＝松明なし（全面可視）
  for (let vy = 0; vy < VH; vy++) for (let vx = 0; vx < VW; vx++) {
    const c = cells[vy * VW + vx]; if (!c) continue;
    const x = camX + vx, y = camY + vy;
    const t = townTileAt(townGrid, x, y);
    let glyph = "", color = "", shadow = "";
    if (t === "floor") { glyph = "·"; color = "#28321f"; }
    else if (t === "wall") { glyph = "▒"; color = "#3a3322"; }
    const pk = `${x},${y}`;
    const prop = townGrid.propMap.get(pk);
    if (prop) { glyph = prop.glyph; color = prop.color; shadow = prop.glow ? `0 0 9px ${prop.color}aa` : `0 0 5px ${prop.color}44`; }
    if (t === "gate") { glyph = ">"; color = "#7fd0e6"; shadow = "0 0 11px rgba(127,208,230,.8),0 0 24px rgba(60,150,180,.45)"; }
    else if (t === "ngate") { glyph = "門"; color = "#9a8fb0"; shadow = "0 0 8px rgba(154,143,176,.5)"; }
    const dk = townGrid.doorMap.get(pk);
    if (dk) { const d = data.keepers[dk]; glyph = d.sign; color = d.color; shadow = `0 0 9px ${d.color}88`; }
    const gu = townGrid.guardMap.get(pk);
    if (gu) { glyph = gu.glyph; color = gu.color; shadow = `0 0 8px ${gu.color}77`; }
    const a = crowdAt(crowd, x, y);
    if (a) { const ck = data.crowd.kinds[a.kind]; glyph = ck.glyph; color = ck.color; shadow = `0 0 7px ${ck.color}66`; }
    if (x === townPlayer.x && y === townPlayer.y) { glyph = "@"; color = "#ffd87a"; shadow = "0 0 12px rgba(255,216,122,.9),0 0 26px rgba(255,160,60,.45)"; }
    paintCell(c, t, glyph, color, shadow);
  }
  updateStatus();
}
function drawInterior() {
  if (!interior) return;
  const IW = interior.w, IH = interior.h;
  const furn = new Map(interior.furniture.map((f) => [`${f.x},${f.y}`, f]));
  const kinds = townGrid.data.crowd.kinds;
  lightEl.style.display = "none";
  for (let y = 0; y < IH; y++) for (let x = 0; x < IW; x++) {
    const c = cells[y * IW + x]; if (!c) continue;
    const t = interior.tiles[y][x];
    let glyph = "", color = "", shadow = "";
    if (t === "floor") { glyph = "·"; color = "#2a3328"; }
    else if (t === "rug") { glyph = "·"; color = "#5a3f46"; }
    else if (t === "wall") { glyph = "▒"; color = "#3a3322"; }
    else if (t === "exit") { glyph = "<"; color = "#7fd0e6"; shadow = "0 0 9px rgba(127,208,230,.7)"; }
    else if (t === "bldg") {
      const f = furn.get(`${x},${y}`);
      if (f) { glyph = f.glyph; color = f.color; shadow = f.glow ? `0 0 9px ${f.color}aa` : `0 0 5px ${f.color}44`; }
      else { glyph = "▓"; color = "#3a3322"; } // 棚・調度
    }
    const kp = interior.keeperPos;
    if (x === kp.x && y === kp.y) {
      const d = townGrid.data.keepers[interior.kind];
      glyph = interior.kind === "house" ? "民" : d.sign; color = d.color; shadow = `0 0 10px ${d.color}99`;
    }
    const a = interiorActorAt(interior.actors, x, y);
    if (a) {
      if (a.role === "keeper") { const d = townGrid.data.keepers[a.kind]; glyph = d.sign; color = d.color; shadow = `0 0 10px ${d.color}99`; }
      else { const ck = kinds[a.kind]; glyph = ck.glyph; color = ck.color; shadow = `0 0 7px ${ck.color}66`; }
    }
    if (x === townPlayer.x && y === townPlayer.y) { glyph = "@"; color = "#ffd87a"; shadow = "0 0 12px rgba(255,216,122,.9)"; }
    paintCell(c, t, glyph, color, shadow);
  }
  cam = { x: 0, y: 0 };
  updateStatus();
}

// ---------- 街シーンのロジック ----------
function persistTown() {
  world.town.scene = mode === "interior" ? "interior" : "town";
  world.town.pos = mode === "interior" ? (townReturn ?? townPlayer) : townPlayer;
  world.town.interiorKind = mode === "interior" ? (interior?.kind ?? null) : null;
  save();
}
function startWander() {
  if (wanderTimer) return;
  wanderTimer = setInterval(() => {
    if (mode !== "town" || busy || overlayEl.classList.contains("show")) return;
    wanderCrowd(townGrid, rng, crowd, townPlayer);
    drawTown();
  }, 1100);
}
function stopWander() { if (wanderTimer) { clearInterval(wanderTimer); wanderTimer = null; } }

function enterBuilding(kind: string, restore = false) {
  if (!restore) townReturn = { ...townPlayer };
  interior = buildInterior(kind, townGrid.data);
  mode = "interior";
  townPlayer = { x: interior.exitPos.x, y: interior.exitPos.y - 1 };
  stopWander();
  buildGridDom(interior.w, interior.h);
  if (!restore) log(`〈${townGrid.data.keepers[kind].place}〉に入った。`, "dim");
  drawInterior();
  persistTown();
}
function leaveBuilding() {
  mode = "town"; interior = null;
  townPlayer = townReturn ? { ...townReturn } : { ...townGrid.data.start };
  townReturn = null;
  buildGridDom(townGrid.data.view.w, townGrid.data.view.h);
  startWander();
  log("街路に戻った。", "dim");
  drawTown();
  persistTown();
}

async function rumorScene() {
  busy = true;
  const pool = world.fossils.filter((f) => f.kind === "character" || f.bondAtDeath > 0);
  const target = pool.length ? rng.pick(pool) : (world.fossils.length ? rng.pick(world.fossils) : null);
  if (target) {
    await sheet({ text: `酒場の喧噪のなか、誰かが言う──\n\n${renderRumor(db, rng, target)}`, options: ["席を立つ"] });
    chronicle(world, "rumor", `酒場で${target.origin.name}の噂が流れる。`, [target.id]);
    save();
  } else {
    await sheet({ text: "今宵は、語るほどの噂もない。", options: ["席を立つ"] });
  }
  busy = false;
}
async function chronicleScene() {
  busy = true;
  const mark = { birth: "生", death: "死", rediscovery: "再", intervention: "干", legend: "伝", rumor: "噂" } as const;
  const tail = world.chronicle.slice(-14).map((e) => `世代${e.generation} [${mark[e.kind]}] ${e.text}`).join("\n");
  await sheet({ text: tail || "まだ何も記されていない。", meta: `年代記 ── 全${world.chronicle.length}件`, options: ["頁を閉じる"] });
  busy = false;
}
// 回収業ギルド：依頼の受注・達成報酬の受領（4-10G）。1操作＝受注 or 受領（再入場で続けられる）。
async function questBoard() {
  busy = true;
  const ch = world.current!;
  const done = doneQuests(world);
  const act = activeQuests(world);
  const offers = generateOffers(world, ch, rng, Math.max(0, 2 - (done.length + act.length)));
  const lines: string[] = [];
  if (done.length) lines.push("【達成済】" + done.map((q) => q.title).join("／"));
  if (act.length) lines.push("【受注中】" + act.map((q) => `${q.title}`).join("／"));
  type Action = { label: string; run: () => void };
  const actions: Action[] = [];
  for (const q of done) actions.push({
    label: `報酬を受け取る：${q.title}（＋${q.rewardGold}金貨）`,
    run: () => {
      const g = claimQuest(world, ch, q.id);
      log(`ギルド長から報酬を受け取った（＋${g}金貨／所持 ${ch.gold}）。`);
      chronicle(world, "legend", `${ch.name}が依頼「${q.title}」を果たした。`, [ch.id]);
    },
  });
  for (const q of offers) actions.push({
    label: `受ける：${q.title}（報酬 ${q.rewardGold}金貨）`,
    run: () => { acceptQuest(world, q); log(`依頼を受けた：「${q.title}」。`, "dim"); },
  });
  const r = await sheet({
    text: `回収業ギルド。所持 金${ch.gold}。\n${lines.join("\n") || "（受注中の依頼はない）"}`,
    meta: "ギルド ── 依頼（回収業）",
    options: [...actions.map((a) => a.label), "やめる"],
  });
  busy = false;
  const i = r.pick - 1;
  if (i >= 0 && i < actions.length) { actions[i].run(); save(); }
}
// 武具屋 売る：袋の未装備装備を確実・高値（itemValue×0.6）で買い取る。
async function smithSell() {
  const ch = world.current!;
  for (;;) {
    const bag = ch.gearBag ?? [];
    if (!bag.length) { busy = true; await sheet({ text: "袋に売れる拾い物がない。迷宮で集めておいで。", options: ["わかった"] }); busy = false; break; }
    busy = true;
    const r = await sheet({
      text: `鍛冶ヴァロは目利きする。所持 金${ch.gold}。\n袋 ${bag.length} 点。何を売る？`,
      meta: "武具屋 ── 売る（高値）",
      options: [...bag.map((it) => `${itemLabel(it)}／${SLOT_LABEL[it.slot]}（＋${sellGear(it, SMITH_SELL_MUL)}金貨）`), "やめる"],
    });
    busy = false;
    const i = r.pick - 1;
    if (i < 0 || i >= bag.length) break;
    const it = bag.splice(i, 1)[0], val = sellGear(it, SMITH_SELL_MUL);
    ch.gold += val; sfx("open");
    log(`${it.name} を武具屋に売った（＋${val}金貨／所持 ${ch.gold}）。`, "dim");
    save();
  }
}
// 武具屋 買う：指定スロット（武器担当＝weapon／防具担当＝armor）の品が必ず並ぶ。
async function smithBuyKind(slot: "weapon" | "armor") {
  busy = true;
  const ch = world.current!;
  const tier = Math.max(3, ch.level + 1);
  const stock = [rollItemOfSlot(tier, rng, slot), rollItemOfSlot(tier, rng, slot), rollItemOfSlot(tier, rng, slot)];
  const prices = stock.map((it) => Math.round(itemValue(it) * 1.6));
  const who = slot === "weapon" ? "鍛冶ヴァロ" : "甲冑師ベルガ";
  const what = SLOT_LABEL[slot];
  const r = await sheet({
    text: `${who}の${what}棚。所持 金${ch.gold}。\n買えば、その場で装備する（今の${what}は置き換え）。`,
    meta: `武具屋 ── ${what}を買う`,
    options: [...stock.map((it, i) => `${itemLabel(it)} ${prices[i]}金貨`), "やめる"],
  });
  busy = false;
  const i = r.pick - 1;
  if (i < 0 || i >= stock.length) return;
  const it = stock[i], price = prices[i];
  if (ch.gold < price) { busy = true; await sheet({ text: "金貨が足りない。", options: ["出直す"] }); busy = false; return; }
  ch.gold -= price; ch.equipment[it.slot] = it;
  sfx("open");
  log(`${it.name} を買って装備した（−${price}金貨／所持 ${ch.gold}）。`);
  if (it.exposurePerTurn) log("……身につけた途端、深みがじわりと滲む。", "warn");
  save();
}
// 薬師：金貨で深蝕の進行を和らげる（exposure を一段戻す）。
async function healerTreat() {
  busy = true;
  const ch = world.current!;
  if (ch.exposure <= 0.05) { await sheet({ text: "深蝕は、今は薄い。施療の要はない。", options: ["わかった"] }); busy = false; return; }
  const cost = 12 + Math.round(ch.exposure * 10);
  const r = await sheet({
    text: `老薬師トウ。お前の深蝕は ${ch.exposure.toFixed(2)}。\n薬と祈りで少し退かせる（−0.6・${cost}金貨）。所持 金${ch.gold}。`,
    meta: "薬師 ── 深蝕治療",
    options: [`施療を受ける（${cost}金貨）`, "やめる"],
  });
  busy = false;
  if (r.pick !== 1) return;
  if (ch.gold < cost) { busy = true; await sheet({ text: "金貨が足りない。", options: ["出直す"] }); busy = false; return; }
  ch.gold -= cost; ch.exposure = Math.max(0, ch.exposure - 0.6);
  sfx("open");
  log(`薬と祈りで、深蝕がわずかに退いた（−0.6／所持 ${ch.gold}）。`, "dim");
  save();
}
// 慰霊堂〈鎮魂の堂〉：縁ある化石を鎮魂＝変質クロックを巻き戻し因縁を閉じる（4-2）。
// バランス（ユーザー承認）：対象は「絆を持つ化石」のみ＋金貨コスト（深度/死亡時深蝕に比例）。
// 街から全化石を無料リセットできないようにし「放置→怨念」の堆積テンソンを守る。
// 鎮魂は自分の深蝕も少し浄める（人間性の回復弁＝戦闘版鎮め筋と対）。
function requiemCost(f: Fossil): number {
  return 8 + f.laidDepth * 2 + Math.round(f.exposureAtDeath * 8);
}
async function shrineRequiem() {
  busy = true;
  const ch = world.current!;
  // 絆のある（=迷宮で出会った）化石だけが対象。今世代で既に手をかけた相手は除く（時計は今リセット済み）。
  const bonded = new Set(ch.bonds.map((b) => b.entityRef));
  const targets = world.fossils.filter(
    (f) => bonded.has(f.id) && f.lastTouchedGeneration !== world.generation,
  );
  if (!targets.length) {
    await sheet({
      text: "鎮めるべき相手と、まだ縁が結ばれていない。\n迷宮で出会った者だけが、ここで弔える。",
      meta: "慰霊堂 ── 鎮魂", options: ["わかった"],
    });
    busy = false; return;
  }
  const r = await sheet({
    text: `弔いの巫女。所持 金${ch.gold}。\n縁ある者を鎮める──末路を閉じ、変質の時計を巻き戻す。`,
    meta: "慰霊堂 ── 鎮魂（絆のある化石）",
    options: [
      ...targets.map((f) => `${f.origin.name}を鎮める（${poleLabel(f.tonePole)}・深度${f.laidDepth}／${requiemCost(f)}金貨）`),
      "やめる",
    ],
  });
  busy = false;
  const i = r.pick - 1;
  if (i < 0 || i >= targets.length) return;
  const f = targets[i], price = requiemCost(f);
  if (ch.gold < price) {
    busy = true;
    await sheet({ text: "金貨が足りない。", options: ["出直す"] });
    busy = false; return;
  }
  ch.gold -= price;
  intervene(world, f.id, "requiem"); // 変質クロック巻き戻し＋因縁を閉じる（4-2）
  const before = ch.exposure;
  ch.exposure = Math.max(0, ch.exposure - REQUIEM_RELIEF); // 鎮魂は自分の深蝕も少し浄める
  sfx("intervene");
  log(`弔いの巫女とともに、${f.origin.name}を鎮めた（−${price}金貨／所持 ${ch.gold}）。`);
  if (ch.exposure < before) log(`祈りのあいだ、胸の澱がわずかに晴れた（深蝕 -${(before - ch.exposure).toFixed(2)}）。`, "dim");
  save();
}
// 慰霊堂 動詞②「先人を悼む」（供養）：歴代キャラ化石を悼む＝記憶の堆積（4-4 パリンプセスト）。
// 鎮魂(動詞①)が「絆ある相手の因縁を閉じる」のに対し、供養は戦力でなく記憶。機械的強化は持たせない。
// 街に名を残し（town.memorials）年代記に刻む。系譜の先祖を悼むと後継への反応（4-4「旧キャラが後継に反応」）。
const MOURN_OFFERING = 5; // 供物（少額）
async function shrineMourn() {
  busy = true;
  const ch = world.current!;
  const ancId = ch.lineage.ancestorFossilId;
  // 歴代の「キャラ化石」が対象。自分の系譜（血/教え）に連なる先祖を先頭に。
  const targets = world.fossils
    .filter((f) => f.kind === "character")
    .sort((a, b) => (a.id === ancId ? -1 : b.id === ancId ? 1 : 0))
    .slice(0, 8);
  if (!targets.length) {
    await sheet({ text: "まだ悼むべき先人はいない。\nいずれ、お前自身もここに名を連ねる。", meta: "慰霊堂 ── 供養", options: ["黙礼する"] });
    busy = false; return;
  }
  const r = await sheet({
    text: `弔いの巫女。所持 金${ch.gold}。\n先人に香を手向ける（供物 ${MOURN_OFFERING}金貨）。その名は街の記憶に残る。`,
    meta: "慰霊堂 ── 供養（先人を悼む）",
    options: [
      ...targets.map((f) => `${f.origin.name}を悼む${f.id === ancId ? "（系譜の先祖）" : ""}`),
      "やめる",
    ],
  });
  busy = false;
  const i = r.pick - 1;
  if (i < 0 || i >= targets.length) return;
  const f = targets[i];
  if (ch.gold < MOURN_OFFERING) {
    busy = true; await sheet({ text: "供物の金貨が足りない。", options: ["引き下がる"] }); busy = false; return;
  }
  ch.gold -= MOURN_OFFERING;
  if (!world.town.memorials.includes(f.origin.name)) world.town.memorials.push(f.origin.name);
  chronicle(world, "legend", `${ch.name}が先人${f.origin.name}を悼み、その名を街の記憶に手向けた。`, [f.id, ch.id]);
  sfx("intervene");
  log(`${f.origin.name}に香を手向けた（−${MOURN_OFFERING}金貨／所持 ${ch.gold}）。その名は慰霊堂に刻まれた。`, "dim");
  busy = true;
  if (f.id === ancId) {
    // 系譜の先祖を悼む＝最も輝かしい情緒ペイオフ（4-4）。
    await sheet({
      text: `香煙のむこう、${f.origin.name}の面影がこちらを見た気がした。\n──血は、絶えていない。`,
      meta: "慰霊堂 ── 供養", options: ["頭を垂れる"],
    });
  } else {
    await sheet({ text: `${f.origin.name}よ、安らかに。\n街は、お前を覚えている。`, meta: "慰霊堂 ── 供養", options: ["頭を垂れる"] });
  }
  busy = false;
  save();
}
// 慰霊堂 動詞③「深蝕を清める祈り」：自分の深蝕を浄める。薬師（金貨・−0.6）と差別化＝無料だが小幅・1世代1回。
// バランス（ユーザー承認）：無料の深蝕回復弁を増やしすぎないためのガード。深蝕プレッシャー（堆積）を守る。
const PRAY_RELIEF = 0.2;
async function shrinePray() {
  busy = true;
  const ch = world.current!;
  if (ch.prayedAtShrineGen === world.generation) {
    await sheet({ text: "今日はもう祈りを捧げた。\n澱は、また歩むうちに溜まる。", meta: "慰霊堂 ── 祈り", options: ["手を合わせる"] });
    busy = false; return;
  }
  if (ch.exposure <= 0) {
    await sheet({ text: "深蝕は、今は無い。祈るまでもない。", meta: "慰霊堂 ── 祈り", options: ["手を合わせる"] });
    busy = false; return;
  }
  const r = await sheet({
    text: `弔いの巫女とともに、静かに祈る。\n胸の澱がわずかに退く（深蝕 -${PRAY_RELIEF.toFixed(2)}・無料・この世代に一度）。\n今の深蝕 ${ch.exposure.toFixed(2)}。`,
    meta: "慰霊堂 ── 深蝕を清める祈り",
    options: ["祈りを捧げる", "やめる"],
  });
  busy = false;
  if (r.pick !== 1) return;
  const before = ch.exposure;
  ch.exposure = Math.max(0, ch.exposure - PRAY_RELIEF);
  ch.prayedAtShrineGen = world.generation;
  sfx("intervene");
  log(`祈りのあいだ、胸の澱がわずかに晴れた（深蝕 -${(before - ch.exposure).toFixed(2)}）。`, "dim");
  save();
}
// 教団〈深淵を讃える者たち〉：金貨でなく深蝕で支払う店＝慰霊堂/薬師（深蝕を減らす）の暗い鏡。
// 恩恵（禁術を識る／理・力+1）と引き換えに深蝕が上がる。深蝕は死亡時に化石へ焼き付き、
// 高いほど自分の化石が「怨念極」へ寄り・速く変質＝後世で敵性化する（堆積/変質テンソンの核）。
// バランス（ユーザー承認：「深蝕リスクを上げて回数無制限＝より深く」）：金貨不要・対価は深蝕で、
// 捧げるほど重くなる（base + step×今世代の回数）・回数無制限。雪だるま式の代償が自然な歯止めになる。
const CULT_COST_BASE = 0.6, CULT_COST_STEP = 0.2;
function cultCost(ch: Character): number {
  return CULT_COST_BASE + CULT_COST_STEP * (ch.cultBoonsThisGen ?? 0);
}
async function cultOffering() {
  busy = true;
  const ch = world.current!;
  const cost = cultCost(ch);
  type Boon = { label: string; run: () => void };
  const boons: Boon[] = [];
  for (const s of SPELLS.filter((s) => !ch.spells.includes(s.key))) boons.push({
    label: `禁術を識る：${s.name}（${s.desc}）`,
    run: () => { ch.spells.push(s.key); log(`深淵が囁く──《${s.name}》を識った。`, "warn"); },
  });
  boons.push({ label: "深淵の力：理 ＋1（深蝕魔法が伸びる）", run: () => { ch.stats.reason += 1; log("深みが理を押し上げた（理 ＋1）。", "warn"); } });
  boons.push({ label: "深淵の力：力 ＋1（攻撃が伸びる）", run: () => { ch.stats.power += 1; log("深みが膂力を押し上げた（力 ＋1）。", "warn"); } });
  const r = await sheet({
    text: `仮面の教主。深蝕は呪いではなく祝福だ。\n捧げれば与えよう──対価は深蝕＋${cost.toFixed(2)}（捧げるほど深くなる）。\n今の深蝕 ${ch.exposure.toFixed(2)}（変質閾値 0.5／1.2／2.5）。`,
    meta: "教団 ── 深蝕を捧げる（危険な恩恵）",
    options: [...boons.map((b) => b.label), "立ち去る"],
  });
  busy = false;
  const i = r.pick - 1;
  if (i < 0 || i >= boons.length) return;
  boons[i].run();
  ch.exposure += cost;
  ch.cultBoonsThisGen = (ch.cultBoonsThisGen ?? 0) + 1;
  sfx("intervene");
  log(`深淵に深蝕を捧げた（深蝕 ＋${cost.toFixed(2)} → ${ch.exposure.toFixed(2)}）。`, "warn");
  if (ch.exposure >= 1.2) log("……お前の末路は、もう怨念の側へ傾いている。", "warn");
  save();
}
// 教団のフレーバー（act0 福音／act2 儀式）：深蝕肯定の世界観と、変質/怨念の示唆。純テキスト。
async function cultLore(which: "gospel" | "rite") {
  busy = true;
  const text = which === "gospel"
    ? "仮面の教主は両腕を広げる。\n「深みに沈むのは堕落ではない。変わることだ。お前が深く染まるほど、世界はお前を覚えている。」\n──祝福のように、それは聞こえた。"
    : "「儀式とは、深蝕を捧げ、深淵に己を書き加えること。\n清めの堂が時計を巻き戻すなら、我らは時計を進める。\nどちらを選ぶかは、お前の末路が決める。」";
  await sheet({ text, meta: which === "gospel" ? "教団 ── 深淵の福音" : "教団 ── 儀式", options: ["耳を傾ける"] });
  busy = false;
}
// ---------- 持ち物（4-10G／Phase1：消耗品＋容量＝レベル。道具屋で購入・潜行中に使用） ----------
/** 使用中の枠数（容量＝carryCapacity と比較）。同種はスタックするので枠は増えない。 */
function invSlotsUsed(ch: Character): number { return ch.inventory?.length ?? 0; }
/** 消耗品を1つ持ち物へ。同種はスタック、空き枠が無ければ false。 */
function addConsumable(ch: Character, key: string): boolean {
  ch.inventory ??= [];
  const slot = ch.inventory.find((s) => s.key === key);
  if (slot) { slot.qty += 1; return true; }
  if (ch.inventory.length >= carryCapacity(ch)) return false; // 枠が一杯
  ch.inventory.push({ key, qty: 1 });
  return true;
}
/** 1枠から1つ消費（0になった枠は外す）。 */
function consumeOne(ch: Character, key: string) {
  const slot = ch.inventory?.find((s) => s.key === key);
  if (!slot) return;
  slot.qty -= 1;
  if (slot.qty <= 0) ch.inventory = (ch.inventory ?? []).filter((s) => s !== slot);
}
/** 消耗品の効果を適用（深蝕−／HP回復。hp はモジュール変数＝潜行中の現在HP）。戻り＝表示用。 */
function applyConsumable(ch: Character, key: string): string {
  const def = consumableByKey(key);
  if (!def) return "";
  const parts: string[] = [];
  if (def.use.exposure) {
    const before = ch.exposure;
    ch.exposure = Math.max(0, ch.exposure + def.use.exposure);
    parts.push(`深蝕 -${(before - ch.exposure).toFixed(2)}`);
  }
  if (def.use.healFrac) {
    const before = hp;
    hp = Math.min(maxHp(ch), hp + Math.round(maxHp(ch) * def.use.healFrac));
    parts.push(`HP +${hp - before}`);
  }
  return parts.join("・");
}
const sellValue = (key: string) => Math.max(1, Math.round((consumableByKey(key)?.price ?? 2) / 2));

// 道具屋ハル act0「消耗品を買う」：金貨で消耗品を購入し持ち物へ（容量に注意）。
async function storeBuy() {
  busy = true;
  const ch = world.current!;
  for (;;) {
    const r = await sheet({
      text: `道具屋ハル。所持 金${ch.gold}。\n持ち物 ${invSlotsUsed(ch)}/${carryCapacity(ch)} 枠（同じ品は重ねて持てる）。`,
      meta: "道具屋 ── 消耗品を買う",
      options: [...CONSUMABLES.map((c) => `${c.name}（${c.desc}）${c.price}金貨`), "やめる"],
    });
    const i = r.pick - 1;
    if (i < 0 || i >= CONSUMABLES.length) break;
    const c = CONSUMABLES[i];
    if (ch.gold < c.price) { await sheet({ text: "金貨が足りない。", options: ["出直す"] }); continue; }
    if (!addConsumable(ch, c.key)) { await sheet({ text: "持ち物が一杯だ。レベルが上がれば、持てる量も増える。", options: ["わかった"] }); continue; }
    ch.gold -= c.price; sfx("open");
    log(`${c.name} を買った（−${c.price}金貨／所持 ${ch.gold}）。`);
    save();
  }
  busy = false;
}
// 道具屋ハル act1「異物・拾い物を売る」：持ち物の消耗品を半値で手放す。
async function storeSell() {
  busy = true;
  const ch = world.current!;
  for (;;) {
    const inv = ch.inventory ?? [];
    if (!inv.length) { await sheet({ text: "売れる持ち物がない。", options: ["戻る"] }); break; }
    const r = await sheet({
      text: `道具屋ハル。所持 金${ch.gold}。\n手放す品を選ぶ（半値）。`,
      meta: "道具屋 ── 売る",
      options: [...inv.map((s) => `${consumableByKey(s.key)?.name ?? s.key} ×${s.qty}（＋${sellValue(s.key)}金貨）`), "やめる"],
    });
    const i = r.pick - 1;
    if (i < 0 || i >= inv.length) break;
    const s = inv[i], val = sellValue(s.key);
    ch.gold += val; consumeOne(ch, s.key); sfx("open");
    log(`${consumableByKey(s.key)?.name ?? s.key} を手放した（＋${val}金貨／所持 ${ch.gold}）。`, "dim");
    save();
  }
  busy = false;
}
// 道具屋ハル act2「携行品を整える」：持ち物を確認し、使う／捨てる（街では HP は満ちている＝治癒は無意味）。
async function storeManage() {
  busy = true;
  const ch = world.current!;
  for (;;) {
    const inv = ch.inventory ?? [];
    if (!inv.length) { await sheet({ text: "持ち物は空だ。", options: ["閉じる"] }); break; }
    const r = await sheet({
      text: `持ち物 ${invSlotsUsed(ch)}/${carryCapacity(ch)} 枠。\n品を選ぶ。`,
      meta: "道具屋 ── 携行品を整える",
      options: [...inv.map((s) => `${consumableByKey(s.key)?.name ?? s.key} ×${s.qty}`), "戻る"],
    });
    const i = r.pick - 1;
    if (i < 0 || i >= inv.length) break;
    const s = inv[i], def = consumableByKey(s.key);
    const a = await sheet({ text: `${def?.name}（${def?.desc}）`, options: ["使う", "捨てる", "戻る"] });
    if (a.pick === 1) {
      if (def?.use.healFrac && !def.use.exposure) { await sheet({ text: "ここでは傷はない。潜ってから使うものだ。", options: ["わかった"] }); continue; }
      const msg = applyConsumable(ch, s.key); consumeOne(ch, s.key);
      log(`${def?.name} を使った（${msg}）。`, "dim"); updateStatus(); save();
    } else if (a.pick === 2) {
      consumeOne(ch, s.key); log(`${def?.name} を捨てた。`, "dim"); save();
    }
  }
  busy = false;
}
// ---------- 自宅の保管庫＝武具庫（持ち物 Phase3）。World.stash(消耗品)/stashGear(装備) に置く＝世代を越えて残る ----------
// 総容量は消耗品スタック＋装備の合計で STASH_CAP（収集の楽しみ）。世代交代で次代へ残るのは各 STASH_INHERIT 枠（world.ts で切詰め）。
const homeUsed = () => (world.stash?.length ?? 0) + (world.stashGear?.length ?? 0);
const homeFull = () => homeUsed() >= STASH_CAP;
function stashAdd(key: string): boolean {
  world.stash ??= [];
  const s = world.stash.find((x) => x.key === key);
  if (s) { s.qty += 1; return true; } // 既存スタックは枠を増やさない
  if (homeFull()) return false;        // 保管庫が一杯
  world.stash.push({ key, qty: 1 });
  return true;
}
function stashTake(key: string) {
  const s = world.stash?.find((x) => x.key === key);
  if (!s) return;
  s.qty -= 1;
  if (s.qty <= 0) world.stash = (world.stash ?? []).filter((x) => x !== s);
}
// 自宅 act0「保管庫に預ける」：持ち物の消耗品 or 今の装備を保管庫へ（世代を越えて残る）。
async function homeDeposit() {
  busy = true;
  const ch = world.current!;
  for (;;) {
    const inv = ch.inventory ?? [];
    const eqSlots: ItemSlot[] = ["weapon", "armor", "relic", "bag"];
    const equipped = eqSlots.filter((sl) => ch.equipment[sl]);
    const opts = [
      ...inv.map((s) => `消耗品：${consumableByKey(s.key)?.name ?? s.key} ×${s.qty}`),
      ...equipped.map((sl) => `装備：${SLOT_LABEL[sl]} ${itemLabel(ch.equipment[sl]!)}`),
    ];
    if (!opts.length) { await sheet({ text: "預けられる持ち物も装備もない。", options: ["閉じる"] }); break; }
    const r = await sheet({
      text: `わが家の物入れ＝代々の武具庫。保管 ${homeUsed()}/${STASH_CAP} 枠（世代を越えて遺せるのは消耗品${STASH_INHERIT}・装備${STASH_INHERIT}枠まで）。\n何を預ける？`,
      meta: "自宅 ── 預ける",
      options: [...opts, "やめる"],
    });
    const i = r.pick - 1;
    if (i < 0 || i >= opts.length) break;
    if (i < inv.length) { // 消耗品
      const s = inv[i];
      if (!stashAdd(s.key)) { await sheet({ text: "保管庫がもう一杯だ。", options: ["戻る"] }); continue; }
      consumeOne(ch, s.key); sfx("open");
      log(`${consumableByKey(s.key)?.name ?? s.key} を保管庫に預けた。`, "dim"); save();
    } else { // 装備（外して武具庫へ）
      if (homeFull()) { await sheet({ text: "武具庫がもう一杯だ。", options: ["戻る"] }); continue; }
      const sl = equipped[i - inv.length];
      const it = ch.equipment[sl]!;
      world.stashGear ??= []; world.stashGear.push(it); ch.equipment[sl] = null;
      sfx("open"); log(`${it.name} を外して武具庫に納めた。`, "dim"); updateStatus(); save();
    }
  }
  busy = false;
}
// 自宅 act1「保管庫から引き出す」：消耗品→持ち物（容量を尊重）／装備→その場で装備（今の同種は武具庫へスワップ）。
async function homeWithdraw() {
  busy = true;
  const ch = world.current!;
  for (;;) {
    const st = world.stash ?? [], gear = world.stashGear ?? [];
    const opts = [
      ...st.map((s) => `消耗品：${consumableByKey(s.key)?.name ?? s.key} ×${s.qty}`),
      ...gear.map((it) => `装備：${SLOT_LABEL[it.slot]} ${itemLabel(it)}`),
    ];
    if (!opts.length) { await sheet({ text: "保管庫は空だ。", options: ["閉じる"] }); break; }
    const r = await sheet({
      text: `保管 ${homeUsed()}/${STASH_CAP} 枠。持ち物 ${invSlotsUsed(ch)}/${carryCapacity(ch)} 枠。\n何を引き出す？`,
      meta: "自宅 ── 引き出す",
      options: [...opts, "やめる"],
    });
    const i = r.pick - 1;
    if (i < 0 || i >= opts.length) break;
    if (i < st.length) { // 消耗品→持ち物
      const s = st[i];
      if (!addConsumable(ch, s.key)) { await sheet({ text: "持ち物が一杯だ。", options: ["戻る"] }); continue; }
      stashTake(s.key); sfx("open");
      log(`${consumableByKey(s.key)?.name ?? s.key} を持ち物に移した。`, "dim"); save();
    } else { // 装備→その場で装備（今の装備は武具庫に戻す＝スワップ）
      const it = gear[i - st.length];
      const cur = ch.equipment[it.slot] ?? null;
      it.unidentified = false; // 武具庫から出して装備＝鑑定
      ch.equipment[it.slot] = it;
      world.stashGear = gear.filter((g) => g !== it);
      if (cur) world.stashGear.push(cur); // スワップ（総枠は変わらない）
      sfx("open"); log(`武具庫から ${it.name} を取り出して装備した（${itemPower(it)}）。`); updateStatus(); save();
    }
  }
  busy = false;
}
// 自宅 act2「物入れを検める」：保管庫（消耗品＋武具庫）を眺める（世代越えの確認＋フレーバー）。
async function homeView() {
  busy = true;
  const st = world.stash ?? [], gear = world.stashGear ?? [];
  const cons = st.length ? st.map((s) => `・${consumableByKey(s.key)?.name ?? s.key} ×${s.qty}`).join("\n") : "・（なし）";
  const armory = gear.length ? gear.map((it) => `・${SLOT_LABEL[it.slot]} ${itemLabel(it)}`).join("\n") : "・（なし）";
  await sheet({
    text: `代々の物入れ。世代を越えて遺せるのは消耗品${STASH_INHERIT}・装備${STASH_INHERIT}枠まで。\n\n〔消耗品〕\n${cons}\n\n〔武具庫〕\n${armory}`,
    meta: `自宅 ── 保管 ${homeUsed()}/${STASH_CAP}`, options: ["閉じる"],
  });
  busy = false;
}

// ---------- 書記＝伝説化承認／系譜（4-4）・ギルド＝等級・英雄譜（4-4） ----------
const TRACK_SOURCE_LABEL: Record<string, string> = { seeded: "街の古い伝説", player_legend: "あなたが遺した伝説", nemesis: "因縁の相手" };
const ARC_LABEL: Record<string, string> = { retire: "静かなる昇華", doom: "破滅の弧", fall: "堕ちゆく弧", lore_drift: "伝承の漂い" };
/** 現キャラの等級＝レベル帯（4-4 ギルド）。 */
function rankLabel(level: number): string {
  if (level >= 12) return "英雄";
  if (level >= 8) return "練達";
  if (level >= 5) return "熟練";
  if (level >= 3) return "一人前";
  return "見習い";
}
// 書記 act1「旧キャラを伝説として承認する」：神話極の旧キャラを player_legend へ昇格（4-4）。
// 昇格すると後世で legend_return（祝福の山場）として戻れ、英雄譜に名が刻まれる。無料・各化石1回。
async function legendApprove() {
  busy = true;
  const elig = world.fossils.filter(
    (f) => f.tonePole === "myth" && f.death.generationCreated >= 1 &&
      !world.tracked.some((t) => t.originRef === f.id),
  );
  if (!elig.length) {
    await sheet({ text: "老書記イェンは目を伏せた。\n「まだ、伝説に値する旧き者はいない。神話の極で逝った者だけが、ここに名を刻める」。", meta: "書記 ── 伝説化の承認", options: ["引き下がる"] });
    busy = false; return;
  }
  const r = await sheet({
    text: "「誰の名を、街の伝説として刻もうか」。\n神話の極で逝った旧き者だけが、英雄譜に昇る。",
    meta: "書記 ── 伝説化の承認（4-4）",
    options: [...elig.map((f) => `${f.origin.name}（深度${f.death.depth}・${poleLabel(f.tonePole)}の極）`), "やめる"],
  });
  busy = false;
  const i = r.pick - 1;
  if (i < 0 || i >= elig.length) return;
  const f = elig[i];
  world.tracked.push({
    id: `legend_${f.id}`, name: f.origin.name, source: "player_legend",
    arcType: "retire", beat: 0, lastObservedGeneration: world.generation, originRef: f.id,
  });
  chronicle(world, "legend", `${f.origin.name}が街の伝説として承認された。その名は英雄譜に刻まれ、深みで巡り会う者を導くだろう。`, [f.id]);
  sfx("intervene");
  log(`${f.origin.name} を伝説として承認した。英雄譜に名が刻まれる。`, "warn");
  // 奉献の試練・印④：旧キャラを伝説化（4-13A）
  if (awardSeal(world, "legend", [f.id])) log("◆ 「伝説の承認」の印を得た。", "warn");
  save();
}
// 書記 act2「系譜をたどる」：現キャラの系譜（先代→現キャラ）と継いだものを表示。
async function lineageScene() {
  busy = true;
  const ch = world.current!;
  const lin = ch.lineage;
  const anc = lin.ancestorFossilId ? world.fossils.find((f) => f.id === lin.ancestorFossilId) : undefined;
  const rel = lin.relation === "blood" ? "血を継ぐ者" : lin.relation === "pupil" ? "教えを継ぐ者" : "誰の系譜にも連ならぬ者";
  const body = anc
    ? `先代＝${anc.origin.name}（深度${anc.death.depth}・${poleLabel(anc.tonePole)}の極）。\nあなたは その${rel}。\n継いだもの：${ch.traits.filter((t) => t.includes(anc.origin.name)).join("、") || "（薄き面影のみ）"}`
    : `あなたは ${rel}。先代の記録は、まだ街にない。`;
  await sheet({ text: `老書記イェンは系譜の綴りを開いた。\n\n${body}`, meta: "書記 ── 系譜をたどる", options: ["閉じる"] });
  busy = false;
}
// ギルド act1「等級・英雄譜を見る」：現キャラの等級＋world.tracked の英雄譜を一覧（4-4）。
async function heroRoll() {
  busy = true;
  const ch = world.current!;
  const legends = world.tracked.filter((t) => t.source === "player_legend").length;
  const roll = world.tracked.length
    ? world.tracked.map((t) => `・${t.name}（${TRACK_SOURCE_LABEL[t.source] ?? t.source}／${ARC_LABEL[t.arcType] ?? t.arcType}）`).join("\n")
    : "・（まだ誰の名もない）";
  await sheet({
    text: `ギルド長は台帳を繰る。\n「あなたの等級は ── 《${rankLabel(ch.level)}》。あなたが遺した伝説は ${legends} 柱」。\n\n〔英雄譜〕\n${roll}`,
    meta: "ギルド ── 等級・英雄譜（4-4）", options: ["閉じる"],
  });
  busy = false;
}
// ギルド act2「系譜の恩寵を確かめる」：先代から継いだ恩寵（絆・形質）を確認。
async function lineageBoon() {
  busy = true;
  const ch = world.current!;
  const anc = ch.lineage.ancestorFossilId ? world.fossils.find((f) => f.id === ch.lineage.ancestorFossilId) : undefined;
  const inherited = ch.traits.filter((t) => anc && t.includes(anc.origin.name));
  const body = anc
    ? `「その血筋、覚えがある」。\n先代＝${anc.origin.name} の恩寵：\n・${inherited.length ? inherited.join("\n・") : "薄き面影"}\n・先代の未完を継ぐ縁（絆）`
    : "「君は、誰の後ろ盾もなく潜る者だな」。系譜の恩寵は、まだない。";
  await sheet({ text: body, meta: "ギルド ── 系譜の恩寵", options: ["わかった"] });
  busy = false;
}
async function talkKeeper(asKind?: string) {
  if (busy || !interior) return;
  const kind = asKind ?? interior.kind;
  const d = townGrid.data.keepers[kind];
  busy = true;
  const r = await sheet({
    text: `${d.name} ── ${d.title}\n\n「${d.line}」`,
    meta: "固定NPC（第2層）",
    options: [...d.acts, "立ち去る"],
  });
  busy = false;
  const actIdx = r.pick - 1;
  if (actIdx < 0 || actIdx >= d.acts.length) return; // 立ち去る
  // 既存機能の結線（機能後退させない）。他の動詞は後続 content 拡充で実装。
  if (kind === "tavern" && actIdx === 0) return void rumorScene();      // 噂を聞く
  if (kind === "archive" && actIdx === 0) return void chronicleScene(); // 年代記を読む
  if (kind === "archive" && actIdx === 1) return void legendApprove();  // 旧キャラを伝説として承認する（4-4）
  if (kind === "archive" && actIdx === 2) return void lineageScene();   // 系譜をたどる
  if (kind === "smith" && actIdx === 0) return void smithBuyKind("weapon"); // 武器を買う
  if (kind === "smith" && actIdx === 1) return void smithSell();         // 拾い物を売る（袋を買い取る）
  if (kind === "smith_armor" && actIdx === 0) return void smithBuyKind("armor"); // 防具を買う
  if (kind === "healer" && actIdx === 1) return void healerTreat();     // 深蝕の進行を診てもらう
  if (kind === "guild" && actIdx === 0) return void questBoard();       // 依頼を受ける（回収業）
  if (kind === "guild" && actIdx === 1) return void heroRoll();         // 等級・英雄譜を見る（4-4）
  if (kind === "guild" && actIdx === 2) return void lineageBoon();      // 系譜の恩寵を確かめる
  if (kind === "shrine" && actIdx === 0) return void shrineRequiem();   // 化石を鎮魂する（末路を閉じる）
  if (kind === "shrine" && actIdx === 1) return void shrineMourn();     // 先人を悼む（供養）
  if (kind === "shrine" && actIdx === 2) return void shrinePray();      // 深蝕を清める祈り
  if (kind === "cult" && actIdx === 0) return void cultLore("gospel");  // 深淵の福音を聞く
  if (kind === "cult" && actIdx === 1) return void cultOffering();      // 深蝕を捧げる（危険な恩恵）
  if (kind === "cult" && actIdx === 2) return void cultLore("rite");    // 儀式について尋ねる
  if (kind === "store" && actIdx === 0) return void storeBuy();         // 消耗品を買う
  if (kind === "store" && actIdx === 1) return void storeSell();        // 異物・拾い物を売る
  if (kind === "store" && actIdx === 2) return void storeManage();      // 携行品を整える（使う/捨てる）
  if (kind === "home" && actIdx === 0) return void homeDeposit();       // 保管庫に預ける
  if (kind === "home" && actIdx === 1) return void homeWithdraw();      // 保管庫から引き出す
  if (kind === "home" && actIdx === 2) return void homeView();          // 物入れを検める
  busy = true;
  await sheet({
    text: `${d.name}：「${d.acts[actIdx]}」\n\n……その商いは、まだ整っていない。`,
    meta: "（後日の content 拡充で結線）", options: ["戻る"],
  });
  busy = false;
}
async function talkCrowd(a: CrowdActor) {
  if (busy) return;
  busy = true;
  const ch = world.current;
  // 同じ通行人には同じ素性で応じる：初回に「生者NPC／純背景」を確定してキャッシュ。
  // （2回目で別人になるバグの修正。CrowdActor は街滞在中だけ生きる ephemeral）
  if (a.npc === undefined) a.npc = (ch && rng.next() < 0.5) ? meetActor(world, db, rng) : null;
  // 生者NPC（アクター記述子）との出会い＝旧「旅の者と語らう」（4-12G）
  if (ch && a.npc) {
    const la = a.npc;
    const head = `${la.actor.epithet ?? ""}${la.actor.name}（${la.actor.archetype}）`;
    const sl = selectTownStorylet(db, world, ch, la, rng);
    if (sl && sl.choices) {
      const c = await sheet({ text: `${head}\n\n${fillActorText(la.actor, sl.text ?? "")}`, options: sl.choices.map((o) => o.label) });
      const choice = sl.choices[c.pick - 1];
      const lines = applyActorEffects(world, ch, la, choice.effects);
      await sheet({
        text: [choice.text ? fillActorText(la.actor, choice.text) : "", ...lines].filter(Boolean).join("\n"),
        options: ["席を立つ"],
      });
      save();
    } else {
      await sheet({ text: `${head}\n\n「……」と、ことば少なに会釈を返された。`, meta: "街路の出会い", options: ["うなずいて別れる"] });
    }
    busy = false;
    return;
  }
  // 純背景の通行人：初回に引いたセリフを固定（同じ人は同じことを言う）
  const k = townGrid.data.crowd.kinds[a.kind];
  if (a.bgLine === undefined) a.bgLine = rng.pick(k.lines);
  await sheet({ text: `${k.label}\n\n「${a.bgLine}」`, meta: "街路の群衆（背景）", options: ["うなずいて別れる"] });
  busy = false;
}
async function talkGuard(g: GuardDef) {
  if (busy) return;
  busy = true;
  await sheet({ text: `${g.name} ── 貴族街の門番\n\n「${g.line}」`, meta: "封鎖ゾーン（将来解禁フック）", options: ["引き返す"] });
  busy = false;
}
async function promptDescend() {
  if (busy) return;
  busy = true;
  const unlocked = abyssUnlocked(world);
  const opts = unlocked
    ? ["潜行する（迷宮へ降りる）", "奉献の試練へ潜る（深淵帯・聖遺物を持ち帰る）", "とどまる"]
    : ["潜行する（迷宮へ降りる）", "とどまる"];
  const r = await sheet({
    text: unlocked
      ? "迷宮の口に立った。\n五つの印が揃い、門の奥に封じられた道――深淵帯への階が、ほの暗く口を開けている。"
      : "迷宮の口に立った。潜行するか？",
    meta: "街 ── 迷宮の口", options: opts,
  });
  busy = false;
  if (unlocked && r.pick === 2) {
    busy = true;
    const c = await sheet({
      text: `深淵帯へは、深度${ABYSS_DEPTH}の封印層へ直に降りる。\n最奥の主が聖遺物を守り、奪えば深みが覚醒する――蝕みが急速に進み、怨霊が地上まで追う。\n聖遺物を抱いて上り階段（‹）から生還できれば、奉献は成る。`,
      meta: "奉献の試練 ── 覚悟", options: ["深淵帯へ降りる", "やめる"],
    });
    busy = false;
    if (c.pick === 1) { abyssDivePending = true; leaveTownToDive(); }
    else drawTown();
    return;
  }
  if (r.pick === 1) leaveTownToDive();
  else drawTown();
}
function leaveTownToDive() {
  stopWander();
  world.town.scene = "town"; world.town.interiorKind = null; world.town.pos = undefined; save();
  const r = townDescendResolve; townDescendResolve = null;
  if (r) r();
}

function townAct(dx: number, dy: number) {
  if (busy) return;
  if (mode === "interior") return interiorAct(dx, dy);
  if (mode !== "town") return;
  const nx = townPlayer.x + dx, ny = townPlayer.y + dy;
  const gu = townGrid.guardMap.get(`${nx},${ny}`); if (gu) { void talkGuard(gu); return; }
  const dk = townGrid.doorMap.get(`${nx},${ny}`); if (dk) { enterBuilding(dk); return; }
  const a = crowdAt(crowd, nx, ny); if (a) { void talkCrowd(a); return; }
  const t = townTileAt(townGrid, nx, ny);
  if (t === "ngate") { log("固く閉ざされた門。門番が見張っている。", "dim"); return; }
  const p = townGrid.propMap.get(`${nx},${ny}`);
  if (t !== "floor" && t !== "gate") { if (p?.line) log(p.line, "dim"); return; }
  if (p && t !== "gate") { if (p.line) log(p.line, "dim"); return; } // 景物（木・井戸・碑）は塞ぐ
  townPlayer = { x: nx, y: ny };
  drawTown();
  if (t === "gate") { void promptDescend(); return; }
  persistTown();
}
function interiorAct(dx: number, dy: number) {
  if (busy || !interior) return;
  const nx = townPlayer.x + dx, ny = townPlayer.y + dy;
  const kp = interior.keeperPos;
  if (nx === kp.x && ny === kp.y) { void talkKeeper(); return; }
  const a = interiorActorAt(interior.actors, nx, ny);
  if (a) { if (a.role === "keeper") void talkKeeper(a.kind); else void talkCrowd(a); return; }
  const t = interior.tiles[ny]?.[nx];
  if (t === "exit") { leaveBuilding(); return; }
  if (t === "bldg") { const f = interior.furniture.find((f) => f.x === nx && f.y === ny); if (f?.line) log(f.line, "dim"); return; }
  if (t !== "floor" && t !== "rug") return;
  townPlayer = { x: nx, y: ny };
  drawInterior();
  persistTown();
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

// ---------- 街（歩ける固定マップ。門 ">" で潜行＝この Promise を解決） ----------
function townLoop(): Promise<void> {
  return new Promise((resolve) => {
    townDescendResolve = resolve;
    mode = "town"; floor = null; setAmbient(false);
    const t = world.town;
    crowd = spawnCrowd(townGrid, rng, t.pos ?? townGrid.data.start);
    if (t.scene === "interior" && t.interiorKind && townGrid.data.keepers[t.interiorKind]) {
      townReturn = t.pos ? { x: t.pos.x, y: t.pos.y } : null;
      enterBuilding(t.interiorKind, true); // 屋内で再開（リロード復元）
    } else {
      mode = "town"; interior = null;
      townPlayer = t.pos ? { x: t.pos.x, y: t.pos.y } : { ...townGrid.data.start };
      buildGridDom(townGrid.data.view.w, townGrid.data.view.h);
      startWander();
      drawTown();
    }
    log("賑わう街。大通りの先、迷宮の口から冷たい風が吹き上げてくる。", "dim");
  });
}

// ---------- 潜行 ----------
function enterFloor(depth: number, fromAbove: boolean, abyss = false) {
  floor = genFloor(world, depth, abyss ? { abyss: true } : undefined);
  pursuerCount = 0; turnsSinceFloor = 0;
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
  for (const l of onReachDepth(world, depth)) { log(l, "cue"); save(); } // 到達系の依頼達成
  // 奉献の試練・印⑤：深淵手前の高深度に到達（4-13A）
  if (depth >= DEPTH_SEAL_AT && !abyss && awardSeal(world, "depth", [ch.id])) {
    log("◆ 「深淵への到達」の印を得た。", "warn"); save();
  }
  if (abyss) log("封じられていた層――空気が、軋むほど濃い。最奥で何かが、聖遺物を抱いている。", "warn");
}

let seenThisDive: string[] = [];
// 帰還の試練（4-13C）：聖遺物携行中の追手カウンタ（フロアごとにリセット）
let pursuerCount = 0;
let turnsSinceFloor = 0;

let abyssDivePending = false; // 次の潜行が「奉献の試練」（深淵帯への直下降）か

async function startDive() {
  stopWander(); // 街の群衆ループを止める
  mode = "dive";
  seenThisDive = [];
  if (world.current) hp = maxHp(world.current); // 街で癒えた状態から潜る
  // 街/屋内の paintCell が残したインライン背景・文字色・グローを引き継がないよう、
  // ダンジョン用ビュー(VIEW)でグリッドを組み直してから描く（他遷移と同じ規約）。
  buildGridDom(VIEW_W, VIEW_H);
  if (abyssDivePending) {
    abyssDivePending = false;
    enterFloor(ABYSS_DEPTH, true, true); // 深淵帯へ直下降（4-13B）
    log("奉献の試練――深淵帯へ降りた。", "warn");
  } else {
    enterFloor(1, true);
    log("迷宮に降りた。冷えた空気が頬を撫でる。");
  }
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

/** 深蝕の即時の牙（4-10C）：この深蝕を超えると歩くだけで蝕まれる（＝2番目の変質閾値・怨念寄りライン）。 */
const CORRUPTION_DRAIN_FROM = 1.2;
/** 1手ぶんの後処理：深蝕→奇癖→蝕み→敵の手番→予告更新→描画→昇級→死。移動も詠唱もここに合流する。 */
async function endTurn() {
  if (!floor || !world.current) return;
  const ch = world.current;

  // 深蝕（4-10C）。心・遺物で染み込みが遅く、異物装備でじわり増える（progression）。
  ch.exposure += exposureGain(floor.depth) * heartFactor(ch) + equipExposure(ch);

  // 帰還の試練（4-13C）：聖遺物携行中は深みが覚醒＝毎手 深蝕が急騰し、追手の怨霊が湧く。
  if (ch.carryingRelic) {
    ch.exposure += RELIC_EXPOSURE_PER_TURN;
    turnsSinceFloor++;
    if (turnsSinceFloor % RELIC_PURSUER_EVERY === 0 && pursuerCount < RELIC_PURSUER_CAP) {
      const m = spawnPursuer(floor, rng, player, floor.depth, pursuerCount);
      if (m) { pursuerCount++; sfx("hurt"); log("背後の闇から、追い縋る怨霊が湧き出した。", "warn"); }
    }
  }
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

  // 深蝕の即時の牙：深く染まると歩くだけで深みに蝕まれる。閾値1.2以上で逐増（深蝕+1.0ごとに+1）。
  // これで深蝕は「後世（死亡時の怨念化）」だけでなく在りし日の生存圧にもなる。HP0は手番末の通常死＝
  // 高い exposureAtDeath で強い怨念化。街は endTurn を通らない＝安全地帯。
  if (ch.exposure >= CORRUPTION_DRAIN_FROM) {
    const bite = 1 + Math.floor(ch.exposure - CORRUPTION_DRAIN_FROM);
    hp -= bite;
    sfx("hurt");
    log(`深みに蝕まれる……（HP -${bite}）`, "warn");
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
  updateStatus(); // HP/深蝕の即時反映（蝕み・被弾・持ち物使用が毎手バーに出る）
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
  const bagUsed = (ch.gearBag ?? []).length, bagCap = gearCapacity(ch);
  const r = await sheet({
    text: head + (cur ? `\n今の${SLOT_LABEL[item.slot]}：${itemLabel(cur)}` : ""),
    meta: `${SLOT_LABEL[item.slot]} ── 拾い物（袋 ${bagUsed}/${bagCap}）`,
    options: ["装備する", "袋にしまう（街/行商人で売る）", "見送る（置いていく）"],
  });
  if (r.pick === 1) {
    item.unidentified = false; // 装備で鑑定
    ch.equipment[item.slot] = item;
    sfx("open");
    log(`${item.name} を装備した（${itemPower(item)}）。`);
    if (item.exposurePerTurn) log("……身につけた途端、深みがじわりと滲む。", "warn");
  } else if (r.pick === 2) {
    await gearBagPush(item);
  }
  save();
}

/** 拾った装備を袋へ。満杯なら入れ替え（古いものを置いていく）か見送りを選ばせる。 */
async function gearBagPush(item: Item): Promise<void> {
  const ch = world.current!;
  ch.gearBag ??= [];
  const cap = gearCapacity(ch);
  if (ch.gearBag.length >= cap) {
    const r = await sheet({
      text: `袋がいっぱいだ（${ch.gearBag.length}/${cap}）。\n何かを置いて、これを入れるか？`,
      meta: "拾い物の袋 ── 満杯",
      options: [...ch.gearBag.map((g) => `「${itemLabel(g)}」を置いて入れ替える`), "これを見送る"],
    });
    const i = r.pick - 1;
    if (i < 0 || i >= ch.gearBag.length) { log(`${item.name} は置いていった。`, "dim"); return; }
    const dropped = ch.gearBag.splice(i, 1)[0];
    ch.gearBag.push(item);
    log(`「${itemLabel(dropped)}」を置き、${item.name} を袋に入れた。`, "dim");
    return;
  }
  ch.gearBag.push(item);
  sfx("open");
  log(`${item.name} を袋にしまった（${ch.gearBag.length}/${cap}）。街の武具屋か、迷宮の行商人に売れる。`, "dim");
}

/** 装備の売値（武具屋＝確実・高値／行商人＝便利・安値）。 */
const SMITH_SELL_MUL = 0.6, MERCHANT_SELL_MUL = 0.45;
const sellGear = (it: Item, mul: number) => Math.max(1, Math.round(itemValue(it) * mul));

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
// 持ち物ボタン（潜行中）：消耗品を使う。使うと一手かかる＝敵が動く（戦術的判断）。
$("bagBtn").onclick = async () => {
  if (busy || mode !== "dive" || !floor || !world.current) return;
  const ch = world.current;
  const inv = ch.inventory ?? [];
  if (!inv.length) { log("持ち物は空だ。街の道具屋ハルで消耗品を仕入れられる。", "dim"); return; }
  busy = true;
  const r = await sheet({
    text: `持ち物 ${invSlotsUsed(ch)}/${carryCapacity(ch)} 枠。使うと一手かかる（敵が動く）。\nHP ${hp}/${maxHp(ch)}・深蝕 ${ch.exposure.toFixed(2)}`,
    meta: "持ち物 ── 使う",
    options: [...inv.map((s) => `${consumableByKey(s.key)?.name ?? s.key} ×${s.qty} ── ${consumableByKey(s.key)?.desc ?? ""}`), "やめる"],
  });
  busy = false;
  const i = r.pick - 1;
  if (i < 0 || i >= inv.length) return;
  const s = inv[i], def = consumableByKey(s.key);
  const msg = applyConsumable(ch, s.key); consumeOne(ch, s.key);
  sfx("open");
  log(`${def?.name} を使った（${msg}）。`, "warn");
  await endTurn(); // 一手経過＝敵の手番
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
    // 奉献の試練・印①：エリアボス（成れの果て）を撃破（4-13A）
    if (mon.boss === "area" && awardSeal(world, "abyss_boss", [ch.id])) {
      log("◆ 「成れの果ての討伐」の印を得た。", "warn");
    }
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
  // 帰還の試練（4-13C）：聖遺物を抱いて上り階段に立てば、生還＝奉献成立（深度を問わず脱出）。
  if (dir === "up" && world.current?.carryingRelic) {
    const r = await sheet({
      text: "上り階段だ。聖遺物を抱いたまま、ここを駆け上がれば――地上へ、生きて還れる。",
      meta: "奉献の試練 ── 生還", options: ["聖遺物を抱いて生還する", "とどまる"],
    });
    if (r.pick === 1) { busy = false; await ascendWithRelic(); return; }
    busy = false; draw(); return;
  }
  if (dir === "down") {
    const r = await sheet({ text: `下り階段がある。深度${f.depth + 1}へ降りるか？`, options: ["降りる", "とどまる"] });
    if (r.pick === 1) { sfx("stairs"); enterFloor(f.depth + 1, true); await maybeDungeonEvent(floor!.depth); await maybeMerchantEncounter(); }
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
    if (r.pick === 1) { enterFloor(f.depth - 1, false); await maybeDungeonEvent(floor!.depth); await maybeMerchantEncounter(); }
  }
  busy = false;
  draw();
}

/** 帰還の試練の生還＝奉献成立（4-13D）。達成→英雄譜入り→聖遺物の処遇（奉納/佩用）→街へ。
 *  印はリセットしない＝深淵帯は開いたまま、試練を反復できる（H&S 継続）。 */
async function ascendWithRelic() {
  busy = true;
  const ch = world.current!;
  ch.carryingRelic = undefined;
  world.ascended = (world.ascended ?? 0) + 1;
  sfx("intervene"); flashFx("warp");
  log("★★ 地上の光――聖遺物を抱いて、生きて還った。奉献は成った。", "warn");
  chronicle(world, "legend",
    `${ch.name}が深淵帯より聖遺物を持ち帰った。奉献の試練を成し遂げた者として、英雄譜に名が刻まれる。（${world.ascended}度目の奉献）`,
    [ch.id]);
  // 生還した英雄を英雄譜へ（存命のまま伝説に列なる：4-4）
  if (!world.tracked.some((t) => t.id === `ascended_${ch.id}`)) {
    world.tracked.push({
      id: `ascended_${ch.id}`, name: ch.name, source: "player_legend",
      arcType: "retire", beat: 0, lastObservedGeneration: world.generation,
    });
  }
  // 聖遺物の処遇（4-13D）
  const r = await sheet({
    text: "聖遺物を、どうする。\n奉納すれば街に恒久の加護が宿り、佩用すれば伝説級の遺物として己の力になる。",
    meta: "奉献の試練 ── 聖遺物の処遇", options: ["街へ奉納する（街の加護）", "佩用する（伝説級の遺物）"],
  });
  if (r.pick === 2) {
    const relic: Item = { id: `relic_ascend_${world.ascended}`, slot: "relic", name: "奉献の聖遺物", relic: "calm" };
    if (ch.equipment.relic) (world.stashGear ??= []).push(ch.equipment.relic); // 旧遺物は武具庫へ退避
    ch.equipment.relic = relic;
    log("聖遺物を佩用した。深みの蝕みが、目に見えて和らぐ（遺物：静寂）。", "warn");
  } else {
    if (!world.flags?.includes("relic_offered")) (world.flags ??= []).push("relic_offered");
    world.town.safety = Math.min(5, (world.town.safety ?? 3) + 1);
    log("聖遺物を街に奉納した。慰霊堂の奥に祀られ、街にひそやかな加護が満ちる。", "warn");
    chronicle(world, "legend", `${ch.name}が聖遺物を街へ奉納した。その加護は、後の世代までも見守るだろう。`, [ch.id]);
  }
  // 生還処理（通常の街帰還と同じ：傷は癒え、深みは残る）
  hp = maxHp(ch); ch.depth = 0; save();
  busy = false;
  await townLoop(); await startDive();
}

/** 階移動時のダンジョン環境イベント（context=dungeon・4-12 F）。深度2以上で時々発火。 */
async function maybeDungeonEvent(depth: number) {
  if (depth < 2 || rng.next() >= 0.55) return;
  const ev = selectDungeonStorylet(db, depth, rng, world.current?.exposure ?? 0);
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

/** 迷宮の行商人との出会い（4-10G）：袋の拾い物を安値（itemValue×0.45）でその場買い取り。
 *  売る物があるときだけ稀に出る。帰還の試練中は出ない（追われている最中なので）。 */
async function maybeMerchantEncounter() {
  const ch = world.current;
  if (!ch || !floor || ch.carryingRelic) return;
  const bag = ch.gearBag ?? [];
  if (!bag.length || rng.next() >= 0.3) return;
  busy = true;
  sfx("open");
  let first = true;
  for (;;) {
    const b = ch.gearBag ?? [];
    if (!b.length) { await sheet({ text: "「もう袋は空かい。また会おう、旅の人」。\n行商人は燭を揺らして去っていった。", options: ["見送る"] }); break; }
    const r = await sheet({
      text: (first
        ? "通路の角で、燭を提げた行商人とすれ違った。\n「やあ旅の人、迷宮で拾った得物はないかね。…言っておくが、街の鍛冶ほどの値は出せんよ」\n"
        : "「ほかには？」\n") + `所持 金${ch.gold}／袋 ${b.length} 点。`,
      meta: "迷宮 ── 行商人との出会い",
      options: [...b.map((it) => `${itemLabel(it)}／${SLOT_LABEL[it.slot]}（＋${sellGear(it, MERCHANT_SELL_MUL)}金貨）`), "売らずに別れる"],
    });
    first = false;
    const i = r.pick - 1;
    if (i < 0 || i >= b.length) { log("行商人とすれ違い、また闇に分かれた。", "dim"); break; }
    const it = b.splice(i, 1)[0], val = sellGear(it, MERCHANT_SELL_MUL);
    ch.gold += val; sfx("open");
    log(`${it.name} を行商人に売った（＋${val}金貨／所持 ${ch.gold}）。`, "dim");
    save();
  }
  busy = false;
  draw();
}

// ---------- 化石との対面（再発見 → 干渉） ----------
async function fossilScene(fe: { fossilId: string; resolved: boolean }) {
  if (busy) return;
  busy = true;
  const fossil = world.fossils.find((f) => f.id === fe.fossilId)!;
  sfx("open");
  const v = computeVariation(fossil, world.generation);
  const setPiece = renderSetPieceIfAny(db, fossil, v);
  const spType = setPiece ? matchSetPiece(db, fossil, v)?.type : undefined; // 山場の型（遭-④）
  const text = setPiece ?? renderRediscovery(db, rng, fossil, v);
  recordRediscovery(world, fossil.id);
  seenThisDive.push(fossil.id);
  for (const l of onRediscoverFossil(world, fossil.id)) { log(l, "cue"); save(); } // 回収系の依頼達成
  const ch = world.current!;

  const canInherit = fossil.death.finalAct.choice === "leave_will" || fossil.death.finalAct.choice === "guard_relic";
  const storylet = selectStorylet(db, world, ch, fossil, v, rng);
  const done = new Set<string>();

  // 遭遇＝イベントノード（4-12）：〈調べる〉〈捜索〉で掘り下げ／伏線を残してから干渉動詞を選ぶ
  for (;;) {
    const opts: string[] = [];
    // 山場の固有決着（遭-④）：通常動詞より先に提示
    if (spType === "legend_return") opts.push("導きを受ける（祝福）");
    if (spType === "grudge_hunt") { opts.push("向き合って詫びる"); opts.push("怨みを撥ねつける"); }
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
    if (label === "導きを受ける（祝福）") { // legend_return（遭-④）：昇華した英雄の祝福
      sfx("intervene");
      intervene(world, fossil.id, "memorial");
      ch.traits.push("導きの印");
      const before = ch.exposure;
      ch.exposure = Math.max(0, ch.exposure - 0.4);
      chronicle(world, "legend", `${ch.name}は${fossil.origin.name}の導きを受けた。`, [fossil.id, ch.id]);
      log(`${fossil.origin.name}の光が、行く道を照らした。形質『導きの印』を得た。`);
      if (ch.exposure < before) log(`深みに削られた芯が、人へ還る（深蝕 -${(before - ch.exposure).toFixed(2)}）。`, "dim");
      // 奉献の試練・印③：山場（legend_return）を決着（4-13A）
      if (awardSeal(world, "setpiece", [fossil.id])) log("◆ 「山場の決着」の印を得た。", "warn");
      save();
      break;
    }
    if (label === "向き合って詫びる") { // grudge_hunt（遭-④）：怨みを認め、鎮める
      sfx("intervene");
      intervene(world, fossil.id, "requiem");
      const before = ch.exposure;
      ch.exposure = Math.max(0, ch.exposure - REQUIEM_RELIEF);
      chronicle(world, "intervention", `${ch.name}は${fossil.origin.name}の怨みに向き合い、詫びた。`, [fossil.id]);
      log(`果たさなかった責めを認めた。${fossil.origin.name}の震えが、ゆっくりと収まっていく。`);
      if (ch.exposure < before) log(`深みに削られた芯が、少し人へ還る（深蝕 -${(before - ch.exposure).toFixed(2)}）。`, "dim");
      // 奉献の試練・印③：山場（grudge_hunt）を決着（4-13A）
      if (awardSeal(world, "setpiece", [fossil.id])) log("◆ 「山場の決着」の印を得た。", "warn");
      save();
      break;
    }
    if (label === "怨みを撥ねつける") { // grudge_hunt（遭-④）：拒絶＝再来の種＋深蝕
      ch.exposure += 0.2;
      const gb = ch.bonds.find((b) => b.entityRef === fossil.id);
      if (gb) gb.unfinished = true; else ch.bonds.push({ entityRef: fossil.id, value: 0, unfinished: true });
      chronicle(world, "rediscovery", `${ch.name}は${fossil.origin.name}の怨みを撥ねつけた。（未完のまま・再来の種）`, [fossil.id]);
      log(`怨みを否定した。だがそれは、より深い闇となって絡みつく（深蝕 +0.20）。いつか、また。`, "warn");
      save();
      break;
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
  // 聖遺物（奉献の試練・4-13C）：拾うと深みが覚醒し、帰還の試練が始まる
  if (ce.relic) {
    const r = await sheet({
      text: "祭壇の上に、脈打つ聖遺物がある。\n手にした刹那、深淵がざわめくだろう――これを抱いて、上り階段から生還せよ。",
      meta: `深度${depth} ── 聖遺物`, options: ["聖遺物を奪う", "まだやめておく"],
    });
    if (r.pick === 1) {
      sfx("intervene"); flashFx("warp");
      const i = floor!.chests.indexOf(ce); if (i >= 0) floor!.chests.splice(i, 1);
      ch.carryingRelic = "深淵の聖遺物";
      log("★ 聖遺物を奪った。深みが、いっせいに覚醒する――急げ、上り階段へ！", "warn");
      chronicle(world, "legend", `${ch.name}が深淵帯で聖遺物を手にした。帰還の試練が始まる。`, [ch.id]);
    }
    save(); busy = false; draw(); return;
  }
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
  const hadRelic = !!ch.carryingRelic;
  // 帰還の試練の途上で斃れる＝聖遺物は深みへ還る＝壮絶な末路（強い怨念化）。
  const manner = hadRelic || depth >= 20 ? "grievous" : "anonymous";
  if (hadRelic) ch.carryingRelic = undefined;
  const fossil = fossilizeCurrent(world, manner, { choice, note });
  if (hadRelic) {
    // 聖遺物を化石へ刻む（後世が奪還しうる痕跡：4-13C・モデルC 還流）
    fossil.origin.gearTags.unshift("深淵の聖遺物");
    chronicle(world, "legend",
      `${fossil.origin.name}は聖遺物を抱いたまま深淵に呑まれた。聖遺物は再び深みへ還り、いつか後世の手が奪い返すのを待つ。`,
      [fossil.id]);
    log("聖遺物は、深みへと還っていった……。", "warn");
  }
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

/** 奉献の試練・印の進捗（4-13A）。獲得済みは印名、未取得は「？」。 */
function sealProgressLine(): string {
  const got = world.seals ?? [];
  const marks = SEAL_KEYS.map((k) => (got.includes(k) ? `◆${SEAL_LABEL[k]}` : "◇？")).join(" ");
  const head = `奉献の印 ${got.length}/${SEAL_KEYS.length}`;
  const tail = abyssUnlocked(world) ? "（深淵帯・解錠！門の奥へ）" : "";
  const asc = (world.ascended ?? 0) > 0 ? ` ／ 奉献${world.ascended}回` : "";
  return `${head}${asc}${tail}\n  ${marks}`;
}

// ---------- メニュー（≡：今後拡張のフック） ----------
$("menuBtn").onclick = async () => {
  if (busy) return;
  busy = true;
  const ch = world.current;
  const spellNames = ch ? ch.spells.map((k) => spellByKey(k)?.name).filter(Boolean).join("、") : "";
  const eq = ch?.equipment;
  const eqLine = eq
    ? `\n装備: 武器=${eq.weapon ? itemLabel(eq.weapon) : "なし"} / 防具=${eq.armor ? itemLabel(eq.armor) : "なし"} / 遺物=${eq.relic ? itemLabel(eq.relic) : "なし"} / 鞄=${eq.bag ? itemLabel(eq.bag) : "なし"}`
    : "";
  const invLine = ch
    ? `\n持ち物 ${invSlotsUsed(ch)}/${carryCapacity(ch)}: ${(ch.inventory ?? []).length ? (ch.inventory ?? []).map((s) => `${consumableByKey(s.key)?.name ?? s.key}×${s.qty}`).join("、") : "なし"}`
    : "";
  const gearLine = ch && (ch.gearBag ?? []).length
    ? `\n拾い物の袋 ${(ch.gearBag ?? []).length}/${gearCapacity(ch)}: ${(ch.gearBag ?? []).map((it) => itemLabel(it)).join("、")}（武具屋/行商人で売る）`
    : "";
  const sealLine = sealProgressLine();
  const sheetHead = ch
    ? `《${ch.name}》Lv${ch.level} ── ${statsLine(ch)}\n最大HP${maxHp(ch)} / 攻撃${meleeDmg(ch)} / 次のレベルまで残り${Math.max(0, xpToNext(ch.level) - ch.xp)}${eqLine}${invLine}${gearLine}\n深蝕 ${ch.exposure.toFixed(2)}${ch.carryingRelic ? `\n★聖遺物を携行中（生還せよ）` : ""}${spellNames ? `\n術: ${spellNames}` : ""}${ch.traits.length ? `\n形質: ${ch.traits.join("、")}` : ""}\n${sealLine}\n\n`
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
  if (mode === "town" || mode === "interior") {
    const tm: Record<string, [number, number]> = {
      ArrowUp: [0, -1], ArrowDown: [0, 1], ArrowLeft: [-1, 0], ArrowRight: [1, 0],
      w: [0, -1], s: [0, 1], a: [-1, 0], d: [1, 0],
    };
    const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    if (tm[k]) { e.preventDefault(); townAct(...tm[k]); }
    return;
  }
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

  if (mode === "town" || mode === "interior") {
    if (!tap) { // スワイプ＝移動
      if (Math.abs(dx) > Math.abs(dy)) townAct(Math.sign(dx), 0);
      else townAct(0, Math.sign(dy));
    } else if (cellSize > 0) { // タップ＝隣接マスへ一歩
      const r = gridEl.getBoundingClientRect();
      const gx = cam.x + Math.floor((tx - r.left) / cellSize);
      const gy = cam.y + Math.floor((ty - r.top) / cellSize);
      const ddx = gx - townPlayer.x, ddy = gy - townPlayer.y;
      if (Math.abs(ddx) + Math.abs(ddy) === 1) townAct(Math.sign(ddx), Math.sign(ddy));
    }
    return;
  }

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
  if (mode === "town") { buildGridDom(townGrid.data.view.w, townGrid.data.view.h); drawTown(); return; }
  if (mode === "interior" && interior) { buildGridDom(interior.w, interior.h); drawInterior(); return; }
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

// Web（PWA）本体：方向A（発光グリフ）・縦持ち・D-pad左 のローグライク
// 街（シート）⇄ 迷宮（グリッド・ターン制）。化石はマップ上の実体として現れる。

import fragmentsJson from "../../content/fragments.json";
import setpiecesJson from "../../content/setpieces.json";
import { makeContentDb } from "../content.ts";
import { makeRng, type Rng } from "../rng.ts";
import {
  newWorld, createCharacter, fossilizeCurrent, fossilizeCompanion, fossilizeAbandoned, intervene, recordRediscovery,
  chronicle, poleLabel, finalActLabel, migrateWorld, awardSeal, abyssUnlocked, setArc, getArc,
} from "../world.ts";
import { computeVariation, exposureGain, QUIRK_THRESHOLDS } from "../variation.ts";
import {
  maxHp, meleeDmg, heartFactor, xpToNext, xpForKill, statsLine,
  STAT_KEYS, STAT_LABEL, HP_PER, carryCapacity, STASH_CAP, STASH_INHERIT, LOADOUT_CAP,
  armorReduce, effectiveReason, xpMul, equipExposure, gearCapacity,
  DEPTH_SEAL_AT, ABYSS_DEPTH, RELIC_EXPOSURE_PER_TURN, RELIC_PURSUER_EVERY, RELIC_PURSUER_CAP,
} from "../progression.ts";
import { SPELLS, spellByKey, warpDamage } from "../spells.ts";
import { rollItem, rollItemOfSlot, itemByName, itemPower, itemLabel, itemValue, SLOT_LABEL, CONSUMABLES, consumableByKey, grantConsumable } from "../items.ts";
import {
  renderDeathLine, renderRediscovery, renderRumor, renderSetPieceIfAny, matchSetPiece, fillStoryletText, fillDungeonText, fillActorText,
  requiemLine, leaveLine, inheritLine, REQUIEM_RELIEF,
} from "../render.ts";
import { rollEncounter } from "../weights.ts";
import { filterByTags } from "../content.ts";
import { selectStorylet, applyEffects, selectDungeonStorylet, applyDungeonEffects, selectTownStorylet, applyActorEffects } from "../storylets.ts";
import { meetActor, mintActor, rememberActor } from "../actors.ts";
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
  planCompanion, resolveCompanion, randomFloorAway, inBounds, companionMaxHp, companionDmg,
  VIEW_W, VIEW_H, type Floor, type Pos, type Chest, type Monster, type CompanionEntity, type DownedActor,
} from "../dungeon.ts";
import type { Character, FinalActChoice, Fossil, Fragment, Item, ItemSlot, LivingActor, SetPiece, Storylet, TownContext, World } from "../types.ts";
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
let companion: CompanionEntity | null = null; // 同行の盤上エンティティ（潜行中のみ。世代越えは world.companion：4-14C）
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
  // 術バフ/召喚の残量を一目に（潜行中のみ。4-11F③ ロードアウト魔法の体感補助）
  const buffs: string[] = [];
  if (armorBuffTurns > 0) buffs.push(`硬鱗${armorBuffTurns}`);
  if (attackBuffTurns > 0) buffs.push(`焦躁${attackBuffTurns}`);
  if (hasteTurns > 0) buffs.push(`疾走${hasteTurns}`);
  if (deathDoorTurns > 0) buffs.push(`死戸${deathDoorTurns}`);
  if (shadowGuard > 0) buffs.push(`影${shadowGuard}`);
  if (cleanseTurns > 0) buffs.push(`解呪${cleanseTurns}`);
  if (summons.length) buffs.push(`召${summons.length}`);
  $("stBuff").textContent = (mode === "dive" && buffs.length) ? `《${buffs.join(" ")}》` : "";
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
  let companionThreatened = false;           // 相棒のマスが攻撃予告されている（4-14C）
  for (const m of floor.monsters) {
    if (m.hp <= 0 || !m.intent || !vis.has(mapIdx(floor, m.x, m.y))) continue;
    if (m.intent.type === "attack") {
      if (m.intent.x === player.x && m.intent.y === player.y) playerThreatened = true;
      else if (companion && m.intent.x === companion.x && m.intent.y === companion.y) companionThreatened = true;
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
      if (floor.downed && floor.downed.x === x && floor.downed.y === y) { glyph = "&"; cls = "g-downed"; } // 手負いの冒険者（4-14C）
      const m = floor.monsters.find((m) => m.hp > 0 && m.x === x && m.y === y);
      if (m) {
        glyph = m.kind.glyph;
        cls = m.boss === "area" ? "g-boss" : m.boss === "elite" ? "g-elite"
          : `g-mon-t${m.kind.tier}${m.intent?.type === "attack" ? " g-mon-atk" : ""}`;
      }
      const su = summons.find((s) => s.x === x && s.y === y); // 召喚＝一時味方（菫色）
      if (su) { glyph = su.glyph; cls = "g-summon"; }
    }
    // 移動予告：敵が踏み込む先の「何も無い床マス」を背景色でハイライト（グリフは出さない）
    c.classList.toggle("tele-move", visible && cls === "g-floor" && teleMove.has(mi));
    // 相棒（4-14C）：青系の @。攻撃予告中は明滅、被攻撃予告中は危険色。
    const isCompanion = !!companion && x === companion.x && y === companion.y;
    if (isCompanion && visible) {
      glyph = "@";
      cls = companionThreatened ? "g-companion-danger" : `g-companion${companion!.intent?.type === "attack" ? " g-mon-atk" : ""}`;
    }
    const isPlayer = x === player.x && y === player.y;
    if (isPlayer) { glyph = "@"; cls = playerThreatened ? "g-player-danger" : "g-player"; }
    c.classList.toggle("tele-atk", (isPlayer && playerThreatened) || (isCompanion && companionThreatened)); // 攻撃予告の赤枠
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
      const gross = claimQuest(world, ch, q.id); // claimQuest が満額を加算済み
      const cut = world.companion?.alive ? companionCut(gross) : 0; // 同行中は依頼報酬も折半（4-14C）
      if (cut > 0) { ch.gold -= cut; log(`${companionName()}が取り分として ${cut}金貨を受け取った（折半）。`, "dim"); }
      log(`ギルド長から報酬を受け取った（＋${gross - cut}金貨／所持 ${ch.gold}）。`);
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
const APPRAISE_MUL = 0.4; // 鑑定料＝鑑定後価値の4割（拾い得を残しつつ、装備で賭けるより安全な対価）
/** 奇物堂（古物商クオ）：拾った未鑑定品（gearBag）を料金を払って鑑定する＝装備せずに正体を明かす。 */
async function appraiseShop() {
  const ch = world.current!;
  for (;;) {
    const bag = ch.gearBag ?? [];
    const unid = bag.map((it, i) => ({ it, i })).filter((o) => o.it.unidentified);
    if (!unid.length) {
      busy = true;
      await sheet({ text: "鑑定するものはないようだ。迷宮で『見知らぬ』品を拾ったら、袋に入れて持っておいで。", meta: "奇物堂 ── 鑑定", options: ["わかった"] });
      busy = false; break;
    }
    const fee = (it: Item) => Math.max(6, Math.round(itemValue({ ...it, unidentified: false }) * APPRAISE_MUL));
    busy = true;
    const r = await sheet({
      text: `クオは品を矯めつ眇めつする。所持 金${ch.gold}。\n袋の未鑑定 ${unid.length} 点。どれを観てもらう？`,
      meta: "奇物堂 ── 鑑定（料を払えば、装備せずとも正体が分かる）",
      options: [...unid.map((o) => `見知らぬ${SLOT_LABEL[o.it.slot]} → 鑑定料 ${fee(o.it)}金`), "やめる"],
    });
    busy = false;
    const k = r.pick - 1;
    if (k < 0 || k >= unid.length) break;
    const it = unid[k].it, cost = fee(it);
    if (ch.gold < cost) {
      busy = true;
      await sheet({ text: `金が足りない（鑑定料 ${cost}・所持 ${ch.gold}）。`, options: ["仕方ない"] });
      busy = false; continue;
    }
    ch.gold -= cost; it.unidentified = false; sfx("open");
    log(`鑑定した――《${it.name}》。${itemPower(it)}${it.exposurePerTurn ? "・装備中わずかに深蝕＋" : ""}（鑑定料 ${cost}／所持 ${ch.gold}）。`, "warn");
    save();
  }
}

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
    const it = bag.splice(i, 1)[0], val = splitGold(sellGear(it, SMITH_SELL_MUL)); // 同行中は売却益も折半（4-14C）
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
    run: () => { learnSpell(ch, s.key); log(`深淵が囁く──《${s.name}》を識った。`, "warn"); },
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
/** 消耗品を1つ持ち物へ（容量はレベル依存）。同種はスタック、空き枠が無ければ false。 */
function addConsumable(ch: Character, key: string): boolean {
  return grantConsumable(ch, key, carryCapacity(ch));
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
/** 金属6等級のラベルと契約ロジックは companion.ts（ブラウザセーフ・純粋）に集約（式のドリフト防止）。 */
import {
  GRADE_LABELS, LIVING_GRADE_CAP, levelGrade, rankLabel, companionGradeFor,
  hireFee, effectiveHireGrade, companionCut,
} from "../companion.ts";
/** 相棒の昇格判定（⤴ 4-4E）。生還(bond)・偉業(feats)を更新した後に呼ぶ。段が上がればログと盤上へ反映。 */
function tryPromoteCompanion(): void {
  const c = world.companion;
  if (!c?.alive) return;
  const next = companionGradeFor(c.bond, c.feats ?? 0, c.grade);
  if (next > c.grade) {
    c.grade = next;
    c.maxHp = companionMaxHp(next); // 等級が上がれば頼もしさ（HP/攻撃）も上がる
    if (companion) { companion.maxHp = c.maxHp; companion.dmg = companionDmg(next); } // 潜行中なら盤上にも即反映（HPは据置）
    log(`⤴ ${companionName()}が${GRADE_LABELS[next]}に昇格した。`, "cue");
  }
}
/** 偉業を記録（ボス撃破・山場決着）。相棒が今ここで共に在る時だけ＝共有した偉業のみ数える。 */
function recordCompanionFeat(): void {
  const c = world.companion;
  if (!c?.alive || !companion || companion.hp <= 0) return;
  c.feats = (c.feats ?? 0) + 1;
  tryPromoteCompanion();
}
/** 永続同行のランクゲート（4-14C）：恒久相棒にできるのは「実効等級 ≤ プレイヤーの等級」まで。 */
function playerGrade(): number { return levelGrade(world.current?.level ?? 1); }
// ---- 同行＝契約パーティ（4-14C・2026-06-16 改訂）：雇用/折半/解散/再雇用 ----
/** 生者NPC（world.actors）に蓄積した雇用記録（昇格はここに残り再雇用で再開）。 */
function storedRecord(actorRef: string): { grade: number; bond: number; feats: number } | undefined {
  const a = world.actors?.find((x) => x.id === actorRef);
  if (!a || typeof a.grade !== "number") return undefined;
  return { grade: a.grade, bond: a.bond ?? 0, feats: a.feats ?? 0 };
}
/** 雇用時の実効等級＝設定等級と蓄積等級の高い方（再雇用ほど精鋭）。 */
function hireGradeOf(la: LivingActor): number {
  return effectiveHireGrade(la.actor.grade, storedRecord(la.id)?.grade);
}
/** 実効等級がプレイヤーの等級を超える＝まだ雇えない（ランクゲート）。 */
function outranksPlayer(la: LivingActor): boolean { return hireGradeOf(la) > playerGrade(); }
/** 契約終了（解散/プレイヤー死）時、相棒の等級/絆/偉業を生者NPCへ書き戻す＝再雇用で再開。 */
function persistCompanionRecord(): void {
  const c = world.companion;
  if (!c) return;
  const a = world.actors?.find((x) => x.id === c.actorRef);
  if (a) { a.grade = c.grade; a.bond = c.bond; a.feats = c.feats ?? 0; }
}
/** 同行中の金貨獲得は相棒と折半（契約：金貨のみ）。プレイヤーの実入りを返す。 */
function splitGold(amount: number): number {
  if (!world.companion?.alive || amount <= 0) return amount;
  const cut = companionCut(amount);
  if (cut > 0) log(`${companionName()}が取り分として ${cut}金貨を受け取った（折半）。`, "dim");
  return amount - cut;
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
    text: "「誰の名を、街の伝説として刻もうか」。\n神話の極で逝った旧き者だけが、秘銀（ミスリル）の名と共に英雄譜に昇る。",
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
  // 相棒の等級（4-4E ⤴）：雇用中の相棒がいれば等級を併記し、ここから解散もできる（4-14C 契約）。
  const hired = world.companion?.alive ? world.companion : null;
  const comp = hired
    ? `\n雇用中の相棒《${hired.actor.name}》── ${GRADE_LABELS[hired.grade]}（生還${hired.bond}・偉業${hired.feats ?? 0}）。道中の金貨は折半。`
    : "";
  const opts = hired ? ["相棒と別れる（解散）", "閉じる"] : ["閉じる"];
  const r = await sheet({
    text: `ギルド長は台帳を繰る。\n「あなたの等級は ── 《${rankLabel(ch.level)}》。あなたが遺した伝説は ${legends} 柱」。${comp}\n\n〔英雄譜〕\n${roll}`,
    meta: "ギルド ── 等級・英雄譜（4-4）", options: opts,
  });
  busy = false;
  if (hired && r.pick === 1) { // 解散＝無料。等級/絆/偉業を生者NPCへ残し、相棒は街へ（再雇用可）。
    const name = companionName();
    persistCompanionRecord();
    world.companion = undefined;
    log(`${name}と別れた。「また入用があれば、声をかけな」。`, "cue");
    save();
  }
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
  if (kind === "oddments" && actIdx === 0) return void appraiseShop();  // 未鑑定品を鑑定する（拾った異物の正体を明かす）
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
// 同一来訪中に同じ人物が何人も現れる現象を防ぐ：出会った生者の「見た目の素性」を記録し、
// meetActor が既出の人物（再会含む）を返したら引き直す。街に入り直すとリセット（再会は世代越しに許す）。
let sceneActorKeys = new Set<string>();
const actorKey = (la: { actor: { epithet?: string; name: string; archetype: string } }) =>
  `${la.actor.epithet ?? ""}|${la.actor.name}|${la.actor.archetype}`;
function resolveMeetActor() {
  // 進行中アークのアンカーNPC（特定NPCに戻る弧：4-12(I)）を優先的に再会させる。
  const anchored = (world.arcs ?? [])
    .filter((a) => !a.done && a.actorRef)
    .map((a) => world.actors?.find((x) => x.id === a.actorRef))
    .find((x): x is LivingActor => !!x);
  if (anchored && !sceneActorKeys.has(actorKey(anchored)) && rng.next() < 0.5) {
    sceneActorKeys.add(actorKey(anchored));
    return anchored;
  }
  let la = meetActor(world, db, rng);
  for (let i = 0; i < 8 && sceneActorKeys.has(actorKey(la)); i++) la = meetActor(world, db, rng);
  sceneActorKeys.add(actorKey(la));
  return la;
}
// 現在地が許す街イベントのコンテキスト（4-14：場所で別の顔。street を基盤に酒場/ギルド/店が上乗せ）。
const SHOP_INTERIORS = new Set(["smith", "smith_armor", "store", "oddments", "healer"]);
function townContextsHere(): TownContext[] {
  if (mode === "interior" && interior) {
    if (interior.kind === "tavern") return ["tavern", "street"];
    if (interior.kind === "guild") return ["guild", "street"];
    if (SHOP_INTERIORS.has(interior.kind)) return ["shop", "street"];
    return ["street"]; // 書記/教団/慰霊堂/民家など：街路の一般プールのみ
  }
  return ["street"];
}
async function talkCrowd(a: CrowdActor) {
  if (busy) return;
  busy = true;
  const ch = world.current;
  // 同じ通行人には同じ素性で応じる：初回に「生者NPC／純背景」を確定してキャッシュ。
  // （2回目で別人になるバグの修正。CrowdActor は街滞在中だけ生きる ephemeral）
  if (a.npc === undefined) a.npc = (ch && rng.next() < 0.5) ? resolveMeetActor() : null;
  // 生者NPC（アクター記述子）との出会い＝旧「旅の者と語らう」（4-12G）
  if (ch && a.npc) {
    const la = a.npc;
    const head = `${la.actor.epithet ?? ""}${la.actor.name}（${la.actor.archetype}）`;
    const sl = selectTownStorylet(db, world, ch, la, rng, townContextsHere());
    // 同行の勧誘（4-14C 入口）：相棒が居らず、迷宮の話が通じる相手なら「同行を頼む」を添える。
    const canRecruit = !world.companion?.alive;
    const recruitOpt = "同行を頼む";
    if (sl && sl.choices) {
      const c = await sheet({ text: `${head}\n\n${fillActorText(la.actor, sl.text ?? "")}`, options: sl.choices.map((o) => o.label) });
      const choice = sl.choices[c.pick - 1];
      const lines = applyActorEffects(world, ch, la, choice.effects);
      // 閉じる語は場面に合わせる（酒場の屋内なら「席を立つ」、それ以外＝立ち話なら「話を切り上げる」）。
      const leave = mode === "interior" && interior?.kind === "tavern" ? "席を立つ" : "話を切り上げる";
      const r = await sheet({
        text: [choice.text ? fillActorText(la.actor, choice.text) : "", ...lines].filter(Boolean).join("\n"),
        options: canRecruit ? [leave, recruitOpt] : [leave],
      });
      if (canRecruit && r.pick === 2) await offerCompanion(la);
      save();
    } else {
      const r = await sheet({
        text: `${head}\n\n「……」と、ことば少なに会釈を返された。`,
        meta: "街路の出会い", options: canRecruit ? ["うなずいて別れる", recruitOpt] : ["うなずいて別れる"],
      });
      if (canRecruit && r.pick === 2) await offerCompanion(la);
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
// ---------- アンビエント街イベント（4-12 J）：潜行帰還時に稀に起きる"街規模の出来事" ----------
// 1帰還につき最大1件。各型は固有のクールダウン（型ごとに頻度を変える）＋全体の発生確率で間引く。
// 4-12 J：イベントのレベル帯ゲート（~Lv50 スケール・2026-06-17 ユーザー承認）。
// 早期1-10／中期11-25／後期26-40／超期45+。低レベルでまとめて着火させない。
const BAND = { raid: 11, plague: 14, memorial: 4, noble: 45 };
async function maybeTownEvent(): Promise<void> {
  const ch = world.current;
  if (!ch) return;
  // 貴族の超長尺（⑦ の発展・4-12 J/I）：超期（Lv45+）になって初めて、封鎖貴族街から正式な召喚が来る。
  if (ch.level >= BAND.noble && !(world.flags ?? []).includes("noble_summoned") && !getArc(world, "noble") && rng.next() < 0.5) {
    await nobleSummonsScene();
    return;
  }
  // 各型の冷却を1帰還ぶん減らす（型を増やすときはここに1行）
  if ((world.raidCooldown ?? 0) > 0) world.raidCooldown = (world.raidCooldown ?? 0) - 1;
  if ((world.memorialCooldown ?? 0) > 0) world.memorialCooldown = (world.memorialCooldown ?? 0) - 1;
  if ((world.plagueCooldown ?? 0) > 0) world.plagueCooldown = (world.plagueCooldown ?? 0) - 1;
  // 発火可能（冷却0＋レベル帯＋固有条件）な型を集める
  const pool: { w: number; run: () => Promise<void> }[] = [];
  if (ch.level >= BAND.raid && (world.raidCooldown ?? 0) === 0) pool.push({ w: 2, run: townRaidScene });           // 脅威（中期〜）
  if (ch.level >= BAND.memorial && (world.memorialCooldown ?? 0) === 0 && world.fossils.some((f) => f.kind === "character")) pool.push({ w: 3, run: townMemorialScene }); // 好機（定期）
  if (ch.level >= BAND.plague && (world.plagueCooldown ?? 0) === 0) pool.push({ w: 2, run: townPlagueScene }); // 災厄（中期〜）
  if (pool.length === 0 || rng.next() >= 0.4) return; // 毎帰還は起きない（多くは静穏）
  const total = pool.reduce((a, b) => a + b.w, 0);
  let r = rng.next() * total;
  for (const a of pool) { r -= a.w; if (r <= 0) { await a.run(); return; } }
}

async function townRaidScene(): Promise<void> {
  busy = true;
  const ch = world.current!;
  world.raidCooldown = 14 + Math.floor(rng.next() * 7); // 次の襲撃まで最短14〜20帰還（一度起きたら長く空く）
  const tier = Math.min(3, 1 + Math.floor(ch.level / 5)); // 規模＝報酬/危険の係数（深く潜る者ほど深層が荒ぶる）
  let gold = 0, exposure = 0, item: string | null = null;
  sfx("hurt"); flashFx("warp");
  log("警鐘——街が、襲われている。", "warn");
  const r1 = await sheet({
    text: "街へ戻ると、警鐘が鳴り渡っていた。迷宮の口から、深層の獣が雪崩を打って溢れ出している。逃げ惑う人々。お前は、どこで戦う？",
    meta: "街の防衛 ── 大量襲撃", options: ["門で食い止める（力・体）", "避難を助ける（心）", "商店街を守る"],
  });
  let line = "";
  if (r1.pick === 1) {
    if (ch.stats.power + ch.stats.body >= 6) { line = "お前は門に立ち塞がり、溢れる獣を一手に引き受けた。屍の壁が、街への奔流をせき止める。"; gold = 16 * tier; exposure = 0.06 * tier; ch.traits.push(`守護者:第${world.generation}世代の門`); }
    else { line = "獣の奔流は凄まじく、押し込まれながらも時間を稼いだ。何匹かは、お前の背を抜けて街へ散った。"; gold = 9 * tier; exposure = 0.10 * tier; }
  } else if (r1.pick === 2) {
    if (ch.stats.heart >= 4) { line = "お前は逃げ遅れた者たちを次々と物陰へ導いた。誰一人、欠けさせはしなかった。"; gold = 8 * tier; item = "salve"; ch.traits.push(`恩人:第${world.generation}世代の避難`); }
    else { line = "幾人かは救えた。だが、腕の中からすり抜けていった手の感触が、いつまでも残る。"; gold = 6 * tier; exposure = 0.06 * tier; }
  } else {
    line = "立ち並ぶ店を背に、お前は獣を捌き続けた。商人たちが、震える手で礼を握らせてくる。"; gold = 13 * tier; exposure = 0.06 * tier; item = "soothe";
  }
  const r2 = await sheet({
    text: `${line}\n\nやがて奔流が細り——最後に、一際大きな獣が、瓦礫を割って現れた。`,
    meta: "街の防衛 ── 最後の一匹", options: ["討ち取る（力で）", "民を逃がし、退く（心で）"],
  });
  if (r2.pick === 1) {
    if (ch.stats.power >= 3) { log("一刀のもと、最後の獣を打ち倒した。歓声が、瓦礫の街に湧く。", "cue"); gold += 10 * tier; ch.traits.push(`武勲:第${world.generation}世代の防衛`); }
    else { log("辛うじて討ち取ったが、深い手傷を負った。", "warn"); gold += 5 * tier; exposure += 0.10; }
  } else {
    log("民を逃がすことを選び、獣に背を向けた。誇りより、命を。", "dim"); exposure = Math.max(0, exposure - 0.04);
  }
  ch.gold += gold;
  if (exposure > 0) ch.exposure += exposure;
  const got = item && addConsumable(ch, item) ? consumableByKey(item)?.name : null;
  chronicle(world, "legend", `第${world.generation}世代、${ch.name}は街を襲った深層の獣を退けた。`, [ch.id]);
  sfx("intervene");
  await sheet({
    text: `静けさが戻った。街の者たちが、口々に礼を述べる。\n\n〔報酬〕金貨 ＋${gold}${got ? `／${got}` : ""}${exposure > 0 ? `\n浴びた深み ＋${exposure.toFixed(2)}` : ""}`,
    meta: "街の防衛 ── 鎮静", options: ["街へ"],
  });
  updateStatus(); save(); busy = false;
}

// ④ 追悼の日（祭礼）＝襲撃の"対"になる好機の定期イベント（4-12 J）。死者を悼み、深蝕（深みの蝕み）を人の温もりで和らげる。
async function townMemorialScene(): Promise<void> {
  busy = true;
  const ch = world.current!;
  world.memorialCooldown = 9 + Math.floor(rng.next() * 5); // 次の追悼まで最短9〜13帰還
  const chars = world.fossils.filter((f) => f.kind === "character");
  const bonded = new Set(ch.bonds.map((b) => b.entityRef));
  const dear = chars.find((f) => bonded.has(f.id))
    ?? (ch.lineage.ancestorFossilId ? chars.find((f) => f.id === ch.lineage.ancestorFossilId) : undefined)
    ?? chars[0];
  sfx("intervene");
  const r = await sheet({
    text: "街に戻ると、通りに白い花が手向けられていた。今日は追悼の日――迷宮に呑まれた者たちを悼む、静かな一日だ。",
    meta: "追悼の日 ── 祭礼", options: ["縁ある死者を悼む", "無名の死者に祈る", "そっと通り過ぎる"],
  });
  let line = "", exposure = 0, item: string | null = null;
  if (r.pick === 1 && dear) {
    exposure = -0.10; item = "soothe"; ch.traits.push(`悼んだ者:${dear.origin.name}`);
    line = `${dear.origin.name}の名を、花とともに静かに呼んだ。深みに削られた芯が、人の側へ少し還る。街の者が、悼みの護符を一つ握らせてくれた。`;
    chronicle(world, "intervention", `追悼の日、${ch.name}は${dear.origin.name}を悼んだ。`, [ch.id, dear.id]);
  } else if (r.pick === 1 || r.pick === 2) {
    exposure = -0.05; ch.traits.push(`祈り:第${world.generation}世代の追悼`);
    line = "名も知らぬ死者たちへ、花を手向けた。誰かを悼むという行為が、強張った何かをほどいていく。";
    chronicle(world, "intervention", `追悼の日、${ch.name}は無名の死者たちに祈った。`, [ch.id]);
  } else {
    line = "悼む気には、まだなれなかった。花の通りを、足早に抜けていく。";
  }
  if (exposure < 0) ch.exposure = Math.max(0, ch.exposure + exposure);
  const got = item && addConsumable(ch, item) ? consumableByKey(item)?.name : null;
  await sheet({
    text: `${line}${exposure < 0 ? `\n\n浴びた深みが、わずかに退いた（深蝕 ${exposure.toFixed(2)}）。` : ""}${got ? `\n${got} を受け取った。` : ""}`,
    meta: "追悼の日 ── 手向け", options: ["街へ"],
  });
  updateStatus(); save(); busy = false;
}

// ② 深蝕の瘴気（疫病）＝街の災厄（4-12 J）。深みが地表へ滲み、街の者が病む。助ければ深蝕を浴びる＝核テーマの対価。
async function townPlagueScene(): Promise<void> {
  busy = true;
  const ch = world.current!;
  world.plagueCooldown = 16 + Math.floor(rng.next() * 8); // 次の疫病まで最短16〜23帰還（災厄は稀）
  sfx("hurt");
  const r = await sheet({
    text: "街に戻ると、いつもの喧騒がない。幾人もが戸を閉ざし、隙間から譫言のような呟きが漏れている。深みの瘴気が、地の底から街へ滲み出したのだ。眼を濁らせ、深部の名を呟きながら、人々が病んでいく。",
    meta: "深蝕の瘴気 ── 街の災厄", options: ["病者を看病する（深蝕を浴びる）", "隔離を進言する（街を守る）", "関わらず宿へ退く"],
  });
  let line = "", exposure = 0, gold = 0, item: string | null = null;
  if (r.pick === 1) { // 看病：心が高いほど己を蝕まれずに看られる
    if (ch.stats.heart >= 4) { line = "お前は瘴気の中、病者の額を冷やし、譫言に耳を傾けた。深みに半ば呑まれた者を、幾人も此岸へ繋ぎ留める。"; gold = 10; item = "soothe"; ch.traits.push(`癒し手:第${world.generation}世代の瘴気`); exposure = 0.06; }
    else { line = "看病のかいあって持ち直す者もいた。だが、瘴気はお前の芯にも染み込み、譫言が他人事に聞こえなくなる。"; gold = 6; exposure = 0.14; }
  } else if (r.pick === 2) { // 隔離：街は救うが、見捨てる者が出る
    line = "お前は病者の隔離を進言し、強引に押し通した。広がりは止まった。街は救われた——だが、戸の外へ締め出された者の、すがる目が、瞼に残る。"; gold = 14; ch.traits.push(`断行:第${world.generation}世代の隔離`); exposure = 0.04;
  } else {
    line = "深みの病は、深みに関わる者の業だ。そう言い聞かせ、宿の戸を固く閉ざした。";
  }
  if (exposure > 0) ch.exposure += exposure;
  if (gold) ch.gold += gold;
  const got = item && addConsumable(ch, item) ? consumableByKey(item)?.name : null;
  chronicle(world, "rediscovery", `第${world.generation}世代、街を深蝕の瘴気が襲い、${ch.name}は${r.pick === 1 ? "病者を看病した" : r.pick === 2 ? "隔離を断行した" : "関わらなかった"}。`, [ch.id]);
  sfx("intervene");
  await sheet({
    text: `${line}${gold ? `\n\n〔報酬〕金貨 ＋${gold}${got ? `／${got}` : ""}` : ""}${exposure > 0 ? `\n浴びた瘴気（深蝕 ＋${exposure.toFixed(2)}）` : ""}`,
    meta: "深蝕の瘴気 ── 鎮静", options: ["街へ"],
  });
  updateStatus(); save(); busy = false;
}

// ⑦の発展＝貴族・統治者エリアの超長尺（4-12 J/I）。封鎖貴族街から正式な召喚→『原初の証』を巡る多段の大命。
const NOBLE_NAMES = ["セルウィン卿", "ヴェスパー卿", "アルディス侯", "レーン伯", "コルヴィナ女伯"];
async function nobleSummonsScene(): Promise<void> {
  busy = true;
  const ch = world.current!;
  (world.flags ??= []).push("noble_summoned"); // 召喚は一度だけ
  const name = NOBLE_NAMES[world.generation % NOBLE_NAMES.length];
  const noble: LivingActor = {
    id: `noble_${world.generation}_${Math.floor(rng.next() * 1e6).toString(36)}`,
    actor: { name, archetype: "封鎖区の貴族", gearTags: ["仕立ての外套"], epithet: "封鎖区の", alive: true, grade: 4 },
    metGeneration: world.generation,
  };
  rememberActor(world, noble);
  sfx("intervene");
  await sheet({
    text: `街路に、場違いなほど上等な装束の使いが現れ、深々と一礼した。「${name}がお呼びです。あなたほどの名であれば、封鎖された貴族街の門も——今日だけは、開きましょう」。`,
    meta: "貴族の召喚 ── 封鎖区へ", options: ["門をくぐる"],
  });
  await sheet({
    text: `重い門の奥、薄暗い広間で、${name}は窓の外の迷宮を見つめていた。「我が家は古い。古すぎて……血の底に、深みが巣食っている。代々、当主は最後に正気を失い、深部の名を呟いて逝く。私も、もう長くはない」。\n「深層の最奥に、我が祖が封じた『原初の証』がある。あれを持ち帰れ。呪いの源か、断ち切る鍵か——確かめねば、私は安らかに逝けぬ。礼は、お前の想像を超えよう」。`,
    meta: `${name} ── 大命`, options: ["引き受ける", "断れぬ空気だ……応じる"],
  });
  setArc(world, { key: "noble", step: 1, actorRef: noble.id }); // 弧を開始＝貴族をアンカー
  if (!ch.traits.includes("負った大命:封鎖区の原初の証")) ch.traits.push("負った大命:封鎖区の原初の証");
  chronicle(world, "legend", `${ch.name}は封鎖貴族街に招かれ、${name}から『原初の証』を持ち帰る大命を受けた。`, [ch.id, noble.id]);
  log("封鎖区の門が、お前の前で初めて開いた。長い大命が始まる。", "cue");
  save(); busy = false;
}

function townLoop(): Promise<void> {
  return new Promise((resolve) => {
    townDescendResolve = resolve;
    mode = "town"; floor = null; setAmbient(false);
    const t = world.town;
    crowd = spawnCrowd(townGrid, rng, t.pos ?? townGrid.data.start);
    sceneActorKeys = new Set(); // 来訪ごとに出会い記録をリセット（同一来訪内での重複だけ防ぐ）
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
  const cached = abyss ? undefined : floorCache.get(depth); // 深淵帯は毎回新規（試練）。通常階は再訪で同じ盤面を復元。
  floor = cached ?? genFloor(world, depth, abyss ? { abyss: true } : undefined);
  if (!cached && !abyss) floorCache.set(depth, floor); // 初訪のみキャッシュ
  pursuerCount = 0; turnsSinceFloor = 0;
  armorBuffTurns = 0; attackBuffTurns = 0; hasteTurns = 0; deathDoorTurns = 0; // 術バフはフロアを跨がない（戦闘内のみ）
  summons = []; shadowGuard = 0; cleanseTurns = 0; // 召喚・影分け・解呪もフロアを跨がない
  const ch = world.current!;
  ch.depth = depth;
  player = { ...(fromAbove ? floor.stairsUp : floor.stairsDown) };
  if (!cached) {
    // 化石の配置（再会重み 4-7。同一潜行で会った相手は除外）。初訪のみ＝再訪で増殖しない。
    // 出現数は面積に追従（迷宮拡張に合わせて増やす＝イベント遭遇も拡張に比例）：d1≈2 / d50≈4。
    const exclude = new Set<string>(seenThisDive);
    const fossilTries = 2 + Math.min(2, Math.floor((floor.w * floor.h) / 3200));
    for (let i = 0; i < fossilTries; i++) {
      const fossil = rollEncounter(world, ch, rng, exclude);
      if (!fossil) break;
      if (Math.abs(fossil.laidDepth - depth) <= 4 && placeFossil(floor, rng, player, fossil)) exclude.add(fossil.id);
    }
    // 入口B：手負いの冒険者を稀に配置（相棒不在時のみ＝1体限定。深度2以降）。初訪のみ。
    floor.downed = null;
    if (!world.companion?.alive && depth >= 2 && rng.next() < 0.14) {
      const at = randomFloorAway(floor, rng, player, 5);
      if (at) floor.downed = { id: `downed_${depth}_${world.generation}`, actor: mintActor(db, rng), x: at.x, y: at.y };
    }
  }
  // 同行（4-14C）：相棒がいれば @ の隣に展開（階段は隣接で同行降下）。ephemeral＝再訪でも再展開。
  companion = null;
  if (world.companion?.alive) spawnCompanionNear(player);
  planMonsters(floor, player, rng, companion); // 入った瞬間に見えている敵は予告を出す
  if (companion) planCompanion(floor, player, companion, rng);
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

// ---------- 同行（相棒）：4-14C。盤上は ephemeral、世代越えは world.companion。 ----------
const companionName = () => world.companion?.actor.name ?? "相棒";
// 連帯深蝕（Phase B）：閾値で奇癖（erratic 逸脱）が始まり、危険閾値で C（討つ/鎮める）を迫る。
const COMPANION_ERRATIC_AT = 0.6;  // この連帯深蝕から挙動がぶれ始める
const COMPANION_DANGER_AT = 1.2;   // この連帯深蝕で危険化＝生者のうちに決断（プレイヤーの蝕み閾値と対称）
const companionErraticRate = (exposure: number) =>
  exposure < COMPANION_ERRATIC_AT ? 0 : Math.min(0.5, (exposure - COMPANION_ERRATIC_AT) * 0.4);
/** 相棒エンティティを @ の隣の空きマスへ展開（無ければ近傍を順に探す）。連帯深蝕の現状を erratic に反映。 */
function spawnCompanionNear(at: Pos): void {
  if (!floor || !world.companion?.alive) return;
  const occupied = (x: number, y: number) =>
    (x === at.x && y === at.y) || floor!.monsters.some((m) => m.hp > 0 && m.x === x && m.y === y) ||
    floor!.fossils.some((e) => e.x === x && e.y === y) || floor!.chests.some((c) => c.x === x && c.y === y) ||
    (!!floor!.downed && floor!.downed.x === x && floor!.downed.y === y);
  for (let r = 1; r <= 4; r++) {
    for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
      const x = at.x + dx, y = at.y + dy;
      if (inBounds(floor, x, y) && tileAt(floor, x, y) === 1 && !occupied(x, y)) {
        companion = {
          x, y, hp: world.companion.maxHp, maxHp: world.companion.maxHp, intent: null,
          erratic: companionErraticRate(world.companion.exposure),
          dmg: companionDmg(world.companion.grade), // 等級で攻撃力が変動（4-4E）
          // crisisShown は各フロアで再武装（危険域のまま降りれば、その都度 C を再び迫る）
        };
        return;
      }
    }
  }
}
/** 相棒の死＝その床に絆つき化石をドロップ（後世で再会）。world.companion を死亡に。
 *  reason="combat"＝戦死／"mercy"＝連帯深蝕で危険化した相棒への慈悲のとどめ（Phase B・C）。 */
function companionDies(reason: "combat" | "mercy" = "combat"): void {
  if (!floor || !companion || !world.companion) return;
  const name = companionName();
  const fossil = fossilizeCompanion(world, world.companion.actor, {
    depth: floor.depth, exposure: world.companion.exposure, bond: world.companion.bond,
  });
  floor.fossils.push({ id: `fe_${fossil.id}`, fossilId: fossil.id, x: companion.x, y: companion.y, resolved: false });
  world.companion.alive = false;
  companion = null;
  sfx(reason === "mercy" ? "intervene" : "hurt");
  if (reason === "mercy") {
    log(`${name}に、慈悲のとどめを刺した。深みに呑まれる前に――その亡骸に、共に歩いた日々が刻まれていく……（†）`, "warn");
    chronicle(world, "intervention", `${name}が深みに呑まれかけ、${world.current?.name ?? "誰か"}が慈悲のとどめを刺した。`, [fossil.id]);
  } else {
    log(`${name}が斃れた。その亡骸に、共に歩いた日々が刻まれていく……（†）`, "warn");
  }
  save();
}
/** 「鎮める（心）」の成功率（心ステ依存。心2で 0.45・心が高いほど確実に正気へ戻せる）。 */
function calmChance(ch: Character): number {
  return Math.max(0.35, Math.min(0.9, 0.45 + (ch.stats.heart - 2) * 0.08));
}
/** 連帯深蝕が危険化した相棒への決断（Phase B・C）：討つ（慈悲）／鎮める（心）／まだ連れ歩く。 */
async function companionCrisis(): Promise<void> {
  if (!floor || !companion || !world.companion || !world.current) return;
  busy = true;
  const name = companionName();
  const ch = world.current;
  const chance = calmChance(ch);
  const r = await sheet({
    text: `${name}の様子がおかしい。眼の奥に、見覚えのある昏さ――深みが、もう半ば呑み込んでいる。\nまだ生者のうちに、決めねばならない。`,
    meta: `${name} ── 連帯深蝕（討つ／鎮める）`,
    options: [
      "討つ（慈悲＝即座に化石へ）",
      `鎮める（心で正気に戻す・成算 ${Math.round(chance * 100)}%）`,
      "まだ連れ歩く（危険を承知で）",
    ],
  });
  if (r.pick === 1) {
    companionDies("mercy");
  } else if (r.pick === 2) {
    if (rng.next() < chance) {
      world.companion.exposure = 0.2; // 正気へ＝連帯深蝕をリセット
      world.companion.bond += 1;
      if (companion) { companion.erratic = 0; companion.crisisShown = false; }
      sfx("intervene");
      log(`${name}を鎮めた。深みが退き、昏さが薄れていく。絆が深まった。`, "cue");
      tryPromoteCompanion();
      chronicle(world, "intervention", `${world.current.name}が${name}の深みを鎮め、正気に引き戻した。`, []);
    } else {
      // 失敗罰：相棒が我を失い、自他のどちらかを傷つける（再挑戦は次手で再提示）。
      const hurtSelf = rng.next() < 0.5;
      if (hurtSelf && companion) {
        companion.hp -= 3; sfx("hurt");
        log(`鎮めきれない。${name}が我を失い、自らを掻き毟った（相棒HP -3）。`, "warn");
        if (companion.hp <= 0) companionDies("combat");
      } else {
        hp -= 3; sfx("hurt");
        log(`鎮めきれない。${name}が我を失い、こちらに牙を剥いた！ 3の傷。`, "warn");
      }
      if (companion) companion.crisisShown = false; // 危険は続く＝次手で再び決断を迫る
    }
  } else {
    if (companion) companion.crisisShown = true; // 連れ歩く＝このフロアでは再提示しない（暴走の risk は erratic で継続）
    log(`${name}を、まだ手放せない。危険を承知で、共に往く。`, "warn");
  }
  save();
  busy = false;
  draw();
}
/** 生者を相棒として雇う（契約＝world.companion）。等級/絆/偉業は生者NPCの蓄積記録があれば再開（再雇用で精鋭に）。
 *  初期等級は設定ファイル由来（actor.grade・4-4E）。強さ（最大HP/攻撃）もその等級で決まる。 */
function recruitCompanion(la: LivingActor): void {
  rememberActor(world, la);
  const rec = storedRecord(la.id); // 過去に雇ったことがあれば蓄積を再開
  const grade = hireGradeOf(la);
  const bond = rec?.bond ?? (world.current?.bonds.find((b) => b.entityRef === la.id)?.value ?? 0);
  const feats = rec?.feats ?? 0;
  world.companion = {
    actorRef: la.id, actor: la.actor, bond, exposure: 0,
    alive: true, maxHp: companionMaxHp(grade), recruitedGeneration: world.generation, grade, feats,
  };
  chronicle(world, "rediscovery", `${GRADE_LABELS[grade]}の${la.actor.name}を雇い、同行することになった。`, [la.id]);
  save();
}
/** 街での勧誘＝誘う（プレイヤー発）：前金（同行費用）を払って雇う。道中の金貨は折半（4-14C 契約）。 */
async function offerCompanion(la: LivingActor): Promise<void> {
  if (outranksPlayer(la)) { // 格上は雇えない＝プレイヤーが名を上げて初めて誘える（4-14C ランクゲート）
    await sheet({
      text: `${la.actor.name}に、共に潜らないかと持ちかける。\nだが相手は静かに首を振った。\n「お前の名は、まだ俺と肩を並べるには軽い。──《${GRADE_LABELS[playerGrade()]}》のお前ではな。\nもっと高みへ来い。その時は、背中を預けよう」。`,
      meta: "同行 ── まだ格が足りない", options: ["引き下がる"],
    });
    return;
  }
  const ch = world.current!;
  const grade = hireGradeOf(la);
  const fee = hireFee(grade);
  if (ch.gold < fee) {
    await sheet({
      text: `${la.actor.name}に同行を持ちかける。\n「いいだろう。だが先立つものは前金で ── ${fee}金貨だ」。\n……今の持ち金（${ch.gold}）では足りない。`,
      meta: "同行 ── 前金が足りない", options: ["引き下がる"],
    });
    return;
  }
  const r = await sheet({
    text: `${GRADE_LABELS[grade]}の${la.actor.name}に、共に潜らないかと持ちかける。\n「いいだろう。前金は ${fee}金貨。道中で得た金貨は、山分けだ」。\n（雇えば次の潜行から隣を歩く。街でいつでも解散できる）`,
    meta: "同行 ── 雇う（前金＋折半）", options: [`頼む（前金${fee}金貨を払う）`, "やめておく"],
  });
  if (r.pick === 1) {
    ch.gold -= fee;
    recruitCompanion(la);
    log(`前金${fee}金貨を払い、${la.actor.name}を雇った（道中の金貨は折半／所持 ${ch.gold}）。`, "cue");
  }
}
/** フロアの手負いを救助（→相棒化）／見捨てる（4-14C 入口B）。 */
async function rescueScene(d: DownedActor): Promise<void> {
  if (busy) return;
  busy = true;
  const head = `${d.actor.epithet ?? ""}${d.actor.name}（${d.actor.archetype}）`;
  const r = await sheet({
    text: `${head}が、壁にもたれて荒い息をしている。深手だ。\n手を貸せば、共に往ける――見捨てれば、ここで終わる。`,
    meta: "手負いの冒険者 ── 救助か、見殺しか", options: ["救助する（同行する）", "見捨てて先へ"],
  });
  const downed = floor?.downed;
  if (floor) floor.downed = null;
  if (r.pick === 1 && downed) {
    sfx("intervene");
    const la: LivingActor = { id: `npc_${world.generation}_${downed.id}`, actor: downed.actor, metGeneration: world.generation };
    if (outranksPlayer(la)) { // 格上を救えても雇えず去る（救った＝怨念化はしない・4-14C ランクゲート）
      log(`${d.actor.name}を救い出した。だが「お前とはまだ格が違う」と、礼だけを残して去っていった。`, "cue");
      chronicle(world, "rediscovery", `${d.actor.name}を深度${floor?.depth ?? 1}で救った。格上ゆえ同道はせず、相応の高みでの再会を約した。`, []);
    } else {
      // 誘われる（救助の申し出）＝前金なし・道中の金貨は折半（4-14C 契約）。
      recruitCompanion(la);
      spawnCompanionNear(player);
      log(`${d.actor.name}を救い出した。「この恩は、戦って返す。── 稼ぎは山分けでな」。これより共に往く。`, "cue");
    }
  } else {
    // 見捨てる：その場で怨念極の化石を執筆＝後世で grudge_hunt の宿敵として確実に還る（4-14C・B／「宿敵を自分で書く」）。
    if (downed) fossilizeAbandoned(world, downed.actor, { depth: floor?.depth ?? 1 });
    log(`${d.actor.name}を残して先へ進んだ。背に張りつく沈黙が、いつまでも追ってくる。`, "warn");
  }
  save();
  busy = false;
  draw();
}

let seenThisDive: string[] = [];
// 同一潜行中に訪れた階を保持（再訪で再生成しない＝宝箱/化石/倒した敵の状態が残る。FB：上り下りで宝箱が復活していた）。
// 潜行ごとにクリア（startDive）。セーブ対象外＝途中セーブ→再開時は再生成（稀・許容）。
let floorCache = new Map<number, Floor>();
// 帰還の試練（4-13C）：聖遺物携行中の追手カウンタ（フロアごとにリセット）
let pursuerCount = 0;
let turnsSinceFloor = 0;
// 術のプレイヤーバフ計時（4-11F③・援系）。各 *Turns は残り手数（毎手 endTurn で減算）。フロア内のみ・セーブ非対象。
let armorBuffTurns = 0;  // 硬鱗：>0 の間 被ダメ −ARMOR_BUFF
let attackBuffTurns = 0; // 焦躁：>0 の間 近接 +ATTACK_BUFF（詠唱で深蝕も増す）
let hasteTurns = 0;      // 疾走：>0 の間、敵手番をスキップ（自分だけ余分に動く）
let deathDoorTurns = 0;  // 死戸：>0 の間は無敵だが回復不可、明けに深みの揺り戻し（深蝕）
const ARMOR_BUFF = 4, ATTACK_BUFF = 5; // バフ量（理で伸ばさず固定＝読みやすさ優先）
// 召喚＝一時味方（4-11F③・召系）。盤上 ephemeral：数手で霧散。隣接敵を毎手討ち、いなければ最寄りへ寄る。
// monsters のターゲットには乗らない（簡潔さ優先）＝味方AIは攻撃のみ。echo_summon(4-10I) とは別物（術側は割り切り）。
interface SummonEntity extends Pos { glyph: string; name: string; dmg: number; turns: number; follow: boolean; }
let summons: SummonEntity[] = [];
let shadowGuard = 0; // 影分け：>0 の間、敵の一撃を影が肩代わり（被ダメを無効化し1減）
let cleanseTurns = 0; // 解呪：>0 の間、装備（異物/刻印）由来の毎手深蝕を抑える

let abyssDivePending = false; // 次の潜行が「奉献の試練」（深淵帯への直下降）か

async function startDive() {
  stopWander(); // 街の群衆ループを止める
  mode = "dive";
  seenThisDive = [];
  floorCache = new Map(); // 新しい潜行＝階の記憶をリセット（深度1から）
  world.diveCount = (world.diveCount ?? 0) + 1; // 潜行ごとに別ダンジョン＝再潜行farm防止（genFloor のseed nonce）
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

  // 術バフの計時（毎手減算。疾走中はこの手番の敵を飛ばす。死戸は明けに揺り戻し）。
  if (armorBuffTurns > 0) armorBuffTurns--;
  if (attackBuffTurns > 0) attackBuffTurns--;
  const hasted = hasteTurns > 0; if (hasteTurns > 0) hasteTurns--;
  if (deathDoorTurns > 0) { deathDoorTurns--; if (deathDoorTurns === 0) { ch.exposure += 0.4; log("死戸が閉じる……深みの揺り戻し（深蝕＋0.4）。", "warn"); } }
  // 腐喰（継続ダメ・4-11F③）：毒を受けた敵は毎手 poisonDmg を失う。死亡は通常の撃破処理へ。
  for (const m of floor.monsters) {
    if (m.hp > 0 && m.poison && m.poison > 0) {
      m.hp -= (m.poisonDmg ?? 1); m.poison--;
      if (m.hp <= 0) downOrKill(m, `腐喰が${m.kind.name}を朽ち果てさせた。`);
    }
  }

  // 深蝕（4-10C）。心・遺物で染み込みが遅く、異物装備でじわり増える（progression）。解呪中は装備由来を抑える。
  ch.exposure += exposureGain(floor.depth) * heartFactor(ch) + (cleanseTurns > 0 ? 0 : equipExposure(ch));
  if (cleanseTurns > 0) cleanseTurns--;

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

  resolveSummons(); // 召喚（一時味方）の手番＝隣接敵を討つ／最寄りへ寄る・寿命を消費（味方なので疾走中も動く＝E）
  if (hasted) log("疾走――敵が止まって見える。もう一手。", "dim");
  if (!hasted) {
  // 相棒の手番（4-14C）：予告した一手を実行（@に追従し隣接敵を討つ）。連帯深蝕も上がる。
  if (companion && companion.hp > 0 && world.companion) {
    const cr = resolveCompanion(floor, player, companion);
    if (cr.hit) {
      sfx("hit");
      if (cr.hit.hp <= 0) { log(`${companionName()}が${cr.hit.kind.name}を討ち取った。`); downOrKill(cr.hit); }
      else log(`${companionName()}が${cr.hit.kind.name}に${cr.dmg}の一撃。`, "dim");
    }
    // 連帯深蝕（Phase B）：潜行で相棒も深みに蝕まれる。閾値で奇癖（erratic）が始まる。
    const before = world.companion.exposure;
    world.companion.exposure += exposureGain(floor.depth) * 0.5;
    if (companion) companion.erratic = companionErraticRate(world.companion.exposure);
    if (before < COMPANION_ERRATIC_AT && world.companion.exposure >= COMPANION_ERRATIC_AT) {
      log(`${companionName()}の足取りが、時折おかしくなる。深みが、相棒にも滲み始めた。`, "warn");
    }
  }

  // 敵の手番：予告した一手を実行（退いた予告は空振り＝見切り。静止中はwait）。標的は @ or 相棒。
  const res = resolveMonsters(floor, player, companion);
  if (res.hits.length) sfx("hurt");
  for (const h of res.hits) {
    if (h.target === "companion" && companion) {
      companion.hp -= h.dmg; // 相棒は防具軽減なし（v1）
      log(`${h.monster.kind.name}の一撃が${companionName()}を襲う！ ${h.dmg}の傷。`, "warn");
    } else {
      let dmg = Math.max(1, h.dmg - armorReduce(ch) - (armorBuffTurns > 0 ? ARMOR_BUFF : 0)); // 防具＋硬鱗で軽減（下限1）
      if (deathDoorTurns > 0) dmg = 0; // 死戸＝無敵
      if (dmg > 0 && shadowGuard > 0) { shadowGuard--; dmg = 0; log(`${h.monster.kind.name}の一撃を、影が引き受けた。`, "dim"); } // 影分け
      else if (deathDoorTurns > 0) log(`${h.monster.kind.name}の一撃を、死戸が弾く。`, "warn");
      else { hp -= dmg; log(`${h.monster.kind.name}の一撃！ ${dmg}の傷。`, "warn"); }
    }
  }
  for (const m of res.dodges) log(`${m.kind.name}の一撃を見切った。`, "dim");
  if (companion && companion.hp <= 0) companionDies(); // 相棒の戦死＝化石化
  } // end if(!hasted)
  // 次の一手を予告する（プレイヤーが見て動けるように。相棒は連帯深蝕で erratic にぶれる）
  planMonsters(floor, player, rng, companion);
  if (companion) planCompanion(floor, player, companion, rng);

  draw();
  updateStatus(); // HP/深蝕の即時反映（蝕み・被弾・持ち物使用が毎手バーに出る）
  await handleBossResolve();
  await handleLevelUps();
  await handleDrops();
  // 連帯深蝕の危機（Phase B・C）：危険化した相棒を生者のうちに討つ/鎮める
  if (hp > 0 && companion && world.companion && world.companion.exposure >= COMPANION_DANGER_AT && !companion.crisisShown) {
    companion.crisisShown = true;
    await companionCrisis();
  }
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
      recordCompanionFeat(); // 相棒と共にボスを鎮めた＝偉業（4-4E 昇格ゲート）
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
const LEARN_EVERY = 4; // 術をレベルアップで識る間隔（4レベルに1度＝毎レベル習得を避ける。他の入手法は別途）
/** 構えている術（戦闘で撃てるのはここだけ）。未初期化/旧セーブは習得順の先頭から補完。 */
function activeLoadout(ch: Character): string[] {
  if (!ch.loadout) ch.loadout = ch.spells.slice(0, LOADOUT_CAP);
  return ch.loadout.filter((k) => ch.spells.includes(k));
}
/** 術を識る＝図鑑に追加（取得無制限）。構えに空きがあれば自動で構える（ロードアウト制 4-11F③）。 */
function learnSpell(ch: Character, key: string): boolean {
  if (ch.spells.includes(key)) return false;
  ch.spells.push(key);
  if (!ch.loadout) ch.loadout = ch.spells.slice(0, LOADOUT_CAP);
  if (ch.loadout.length < LOADOUT_CAP && !ch.loadout.includes(key)) ch.loadout.push(key);
  return true;
}
$("spellBtn").onclick = async () => {
  if (busy || mode !== "dive" || !floor || !world.current) return;
  const ch = world.current;
  if (ch.spells.length === 0) { log("まだ術を識らない。レベルアップ/深淵/教団で識れる。", "dim"); return; }
  const loadout = activeLoadout(ch);
  if (loadout.length === 0) { log("術を構えていない。街の ≡ から構えを整えよ。", "dim"); return; }
  busy = true;
  const known = loadout.map((k) => spellByKey(k)).filter((s): s is NonNullable<typeof s> => !!s);
  const r = await sheet({
    text: `深みの力を引く。代償は深蝕（今 ${ch.exposure.toFixed(2)}）。`,
    meta: `術 ── 構え ${loadout.length}/${LOADOUT_CAP}（深蝕を支払って盤面を曲げる）`,
    options: [...known.map((s) => `[${s.school}] ${s.name}（深蝕＋${s.cost}）── ${s.desc}`), "やめる"],
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

/** 視界内の最寄りの敵。 */
function nearestMon(list: Monster[]): Monster {
  return list.reduce((a, b) =>
    Math.hypot(a.x - player.x, a.y - player.y) <= Math.hypot(b.x - player.x, b.y - player.y) ? a : b);
}
/** p の近傍（半径2）で、床・無人（敵/プレイヤー/相棒/召喚なし）の空きマスを探す。なければ null。 */
function freeFloorSpotNear(p: Pos): Pos | null {
  if (!floor) return null;
  for (let r = 1; r <= 2; r++) for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
    if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
    const x = p.x + dx, y = p.y + dy;
    if (tileAt(floor, x, y) !== 1) continue;
    if (x === player.x && y === player.y) continue;
    if (companion && companion.x === x && companion.y === y) continue;
    if (floor.monsters.some((m) => m.hp > 0 && m.x === x && m.y === y)) continue;
    if (summons.some((s) => s.x === x && s.y === y)) continue;
    return { x, y };
  }
  return null;
}
/** 一時味方を near の近傍に湧かせる（4-11F③ 召系）。 */
function spawnSummon(near: Pos, glyph: string, name: string, dmg: number, turns: number, follow: boolean): boolean {
  const spot = freeFloorSpotNear(near);
  if (!spot) return false;
  summons.push({ x: spot.x, y: spot.y, glyph, name, dmg, turns, follow });
  return true;
}
/** 召喚の手番：隣接敵を討つ／いなければ最寄り敵（follow なら @）へ1歩。寿命を消費し、尽きたら霧散。 */
function resolveSummons() {
  if (!floor || !summons.length) return;
  for (const s of summons) {
    const adj = floor.monsters.find((m) => m.hp > 0 && Math.max(Math.abs(m.x - s.x), Math.abs(m.y - s.y)) <= 1);
    if (adj) {
      adj.hp -= s.dmg; flashFx("warp", { x: adj.x, y: adj.y });
      if (adj.hp <= 0) downOrKill(adj, `${s.name}が${adj.kind.name}を断った。`);
    } else {
      const live = floor.monsters.filter((m) => m.hp > 0);
      const goal: Pos | null = live.length
        ? live.reduce((a, b) => Math.hypot(a.x - s.x, a.y - s.y) <= Math.hypot(b.x - s.x, b.y - s.y) ? a : b)
        : (s.follow ? player : null);
      if (goal) {
        const nx = s.x + Math.sign(goal.x - s.x), ny = s.y + Math.sign(goal.y - s.y);
        if (tileAt(floor, nx, ny) === 1 && !(nx === player.x && ny === player.y) &&
          !floor.monsters.some((m) => m.hp > 0 && m.x === nx && m.y === ny) && !summons.some((o) => o !== s && o.x === nx && o.y === ny)) { s.x = nx; s.y = ny; }
      }
    }
    s.turns--;
  }
  summons = summons.filter((s) => s.turns > 0);
}

/** t に隣接する空き床のうち、プレイヤーから最も近いマス（迫りの着地点）。なければ null。 */
function adjacentSpotToward(t: Monster): Pos | null {
  if (!floor) return null;
  let best: Pos | null = null, bestD = Infinity;
  for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
    if (!dx && !dy) continue;
    const x = t.x + dx, y = t.y + dy;
    if (tileAt(floor, x, y) !== 1) continue;
    if (floor.monsters.some((m) => m.hp > 0 && m.x === x && m.y === y)) continue;
    const d = Math.hypot(x - player.x, y - player.y);
    if (d < bestD) { bestD = d; best = { x, y }; }
  }
  return best;
}

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
  } else if (key === "corrode") { // 腐喰＝最寄りに継続ダメ（毒）を付与
    if (!visMon.length) { log("腐らせる敵が見えない。", "dim"); draw(); return; }
    const t = nearestMon(visMon);
    t.poison = 6; t.poisonDmg = Math.max(1, Math.round(effectiveReason(ch) * 0.6));
    sfx("spell_warp"); flashFx("warp", { x: t.x, y: t.y });
    log(`腐喰。${t.kind.name}が、内から朽ちはじめる（毎手${t.poisonDmg}・6手）。`);
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
  } else if (key === "rift_lance") { // 裂界＝最寄りへ向け一直線を貫く（線上の敵すべて）
    if (!visMon.length) { log("貫く敵が見えない。", "dim"); draw(); return; }
    const t = nearestMon(visMon);
    const sx = Math.sign(t.x - player.x), sy = Math.sign(t.y - player.y);
    const dmg = Math.round(warpDamage(effectiveReason(ch)) * 0.8);
    let hitN = 0;
    for (let i = 1; i <= 9; i++) {
      const x = player.x + sx * i, y = player.y + sy * i;
      if (tileAt(floor, x, y) !== 1) break; // 壁で止まる
      const m = floor.monsters.find((mm) => mm.hp > 0 && mm.x === x && mm.y === y);
      if (m) { m.hp -= dmg; hitN++; flashFx("warp", { x, y }); if (m.hp <= 0) downOrKill(m, `裂界が${m.kind.name}を裂いた。`); }
    }
    sfx("spell_warp");
    log(hitN ? `裂界が一直線を貫く（${hitN}体・各${dmg}）。` : "裂界は空を裂いた。");
  } else if (key === "collapse") { // 崩落＝最寄りを中心に範囲ダメージ
    if (!visMon.length) { log("崩す相手が見えない。", "dim"); draw(); return; }
    const t = nearestMon(visMon);
    const dmg = Math.round(warpDamage(effectiveReason(ch)) * 0.7);
    let hitN = 0;
    for (const m of floor.monsters) {
      if (m.hp > 0 && Math.max(Math.abs(m.x - t.x), Math.abs(m.y - t.y)) <= 1) {
        m.hp -= dmg; hitN++; flashFx("warp", { x: m.x, y: m.y });
        if (m.hp <= 0) downOrKill(m, `崩落が${m.kind.name}を呑んだ。`);
      }
    }
    sfx("spell_warp");
    log(`崩落（${hitN}体・各${dmg}）。`);
  } else if (key === "thunder") { // 雷霆＝可視の敵すべてに放射状の雷（弱め）
    if (!visMon.length) { log("雷を落とす敵が見えない。", "dim"); draw(); return; }
    const dmg = Math.max(1, Math.round(warpDamage(effectiveReason(ch)) * 0.5));
    for (const m of visMon) { m.hp -= dmg; if (m.hp <= 0) downOrKill(m, `雷霆が${m.kind.name}を撃ち抜いた。`); }
    sfx("spell_warp"); flashFx("still");
    log(`雷霆が${visMon.length}体を撃つ（各${dmg}）。`);
  } else if (key === "slow") { // 鈍り＝可視の敵を数手1手おきに
    if (!visMon.length) { log("鈍らせる敵が見えない。", "dim"); draw(); return; }
    for (const m of visMon) m.slowed = 6;
    sfx("spell_still"); flashFx("still");
    log(`鈍り。${visMon.length}体の足が、重くなった。`);
  } else if (key === "dread") { // 畏れ＝可視の敵を数手怯えさせ退かせる
    if (!visMon.length) { log("怯ませる敵が見えない。", "dim"); draw(); return; }
    for (const m of visMon) m.fear = 5;
    sfx("spell_still"); flashFx("still");
    log(`畏れ。${visMon.length}体が、後ずさる。`);
  } else if (key === "charge") { // 迫り＝最寄りへ踏み込み近接一撃
    if (!visMon.length) { log("迫る敵が見えない。", "dim"); draw(); return; }
    const t = nearestMon(visMon);
    const spot = adjacentSpotToward(t); // tの隣で、プレイヤーから最も近い空きマス
    if (spot) { flashFx("blink", { x: player.x, y: player.y }); player = spot; }
    const dmg = meleeDmg(ch) + (attackBuffTurns > 0 ? ATTACK_BUFF : 0);
    t.hp -= dmg;
    sfx("spell_blink");
    if (t.hp <= 0) downOrKill(t, `迫り、${t.kind.name}を討ち砕いた。`);
    else log(`迫って斬りつける（${dmg}）。`);
  } else if (key === "heal") { // 癒し＝HP回復（理＋体）。死戸中は回復不可
    if (deathDoorTurns > 0) { log("死戸が開いている間は、癒えない。", "dim"); draw(); return; }
    const amt = effectiveReason(ch) + ch.stats.body;
    const before = hp; hp = Math.min(maxHp(ch), hp + amt);
    sfx("open"); flashFx("still");
    log(`癒しが巡る（HP＋${hp - before}）。`);
  } else if (key === "enfeeble") { // 蝕み＝最寄りの攻撃を数手削ぐ
    if (!visMon.length) { log("蝕む敵が見えない。", "dim"); draw(); return; }
    const t = nearestMon(visMon);
    t.weak = 6;
    sfx("spell_still"); flashFx("still");
    log(`蝕み。${t.kind.name}の力が、萎えた。`);
  } else if (key === "leech") { // 吸命＝最寄りを蝕み、奪ったぶんHPへ
    if (!visMon.length) { log("吸う相手が見えない。", "dim"); draw(); return; }
    const t = nearestMon(visMon);
    const dmg = Math.round(warpDamage(effectiveReason(ch)) * 0.6);
    const dealt = Math.min(dmg, t.hp);
    t.hp -= dmg;
    const before = hp; if (deathDoorTurns === 0) hp = Math.min(maxHp(ch), hp + Math.ceil(dealt / 2)); // 死戸中は吸命しても癒えない
    sfx("spell_warp"); flashFx("warp", { x: t.x, y: t.y });
    if (t.hp <= 0) downOrKill(t, `吸命が${t.kind.name}を干涸びさせた。`);
    else log(`吸命（与${dmg}／HP＋${hp - before}）。`);
  } else if (key === "ironscale") { // 硬鱗＝数手 被ダメ軽減
    armorBuffTurns = 5;
    sfx("open"); flashFx("still");
    log(`硬鱗。鱗が立ち、守りが固まった（被ダメ−${ARMOR_BUFF}・5手）。`);
  } else if (key === "haste") { // 疾走＝数手 敵手番スキップ
    hasteTurns = 3;
    sfx("spell_blink"); flashFx("blink", { x: player.x, y: player.y });
    log("疾走。世界が、ゆっくりと流れ出す（3手）。");
  } else if (key === "frenzy") { // 焦躁＝数手 近接ダメ上乗せ
    attackBuffTurns = 5;
    sfx("open"); flashFx("warp", { x: player.x, y: player.y });
    log(`焦躁。手が冴え、苛立ちが募る（攻撃＋${ATTACK_BUFF}・5手）。`);
  } else if (key === "deathdoor") { // 死戸＝数手 無敵だが癒えず、明けに反動
    deathDoorTurns = 4;
    sfx("open"); flashFx("still");
    log("死戸を開く。痛みが、遠い（無敵4手・癒えず・明けに揺り戻し）。");
  } else if (key === "miststep") { // 霞足＝近場（半径3）へ短くブリンク（敵から距離を取る）
    let best: Pos | null = null, bestScore = -1;
    for (const mi of vis) {
      const x = mi % floor.w, y = Math.floor(mi / floor.w);
      if (tileAt(floor, x, y) !== 1 || (x === player.x && y === player.y)) continue;
      if (Math.max(Math.abs(x - player.x), Math.abs(y - player.y)) > 3) continue;
      if (floor.monsters.some((m) => m.hp > 0 && m.x === x && m.y === y)) continue;
      const nearest = visMon.length ? Math.min(...visMon.map((m) => Math.hypot(m.x - x, m.y - y))) : Math.hypot(x - player.x, y - player.y);
      if (nearest > bestScore) { bestScore = nearest; best = { x, y }; }
    }
    if (!best) { log("霞む先がない。", "dim"); draw(); return; }
    flashFx("blink", { x: player.x, y: player.y }); player = best; sfx("spell_blink");
    log("霞足。すっと、間合いが空いた。");
  } else if (key === "wayfare") { // 退き戸＝上り階段の傍へ退避
    const up = floor.stairsUp;
    const spot = (tileAt(floor, up.x, up.y) === 1 && !floor.monsters.some((m) => m.hp > 0 && m.x === up.x && m.y === up.y)) ? up : freeFloorSpotNear(up);
    if (!spot) { log("退き戸が開かない。", "dim"); draw(); return; }
    flashFx("blink", { x: player.x, y: player.y }); player = { x: spot.x, y: spot.y }; sfx("spell_blink");
    log("退き戸を開く。上り階段の傍へ、退いた。");
  } else if (key === "cleanse") { // 解呪＝装備（異物/刻印）の蝕みを数手抑える
    cleanseTurns = 8;
    sfx("open"); flashFx("still");
    log("解呪。装備の蝕みが、しばし鎮まる（8手）。");
  } else if (key === "survey") { // 地相＝フロアの地形を感知（地図が開く）
    for (let i = 0; i < floor.explored.length; i++) floor.explored[i] = true;
    sfx("open");
    log("地相を読む。この階の輪郭が、頭に灯った。");
  } else if (key === "ice_tomb") { // 氷棺＝高威力＋凍結
    if (!visMon.length) { log("討つべき敵が見えない。", "dim"); draw(); return; }
    const t = nearestMon(visMon);
    const dmg = Math.round(warpDamage(effectiveReason(ch)) * 1.3);
    t.hp -= dmg; t.stunned = Math.max(t.stunned ?? 0, 2);
    sfx("spell_warp"); flashFx("still", { x: t.x, y: t.y });
    if (t.hp <= 0) downOrKill(t, `氷棺が${t.kind.name}を砕いた。`); else log(`氷棺（${dmg}・凍結）。`);
  } else if (key === "wither") { // 痩身＝現在HPの割合を削る（硬い敵に効く）
    if (!visMon.length) { log("削る相手が見えない。", "dim"); draw(); return; }
    const t = nearestMon(visMon);
    const cut = Math.max(1, Math.ceil(t.hp * 0.4));
    t.hp -= cut;
    sfx("spell_warp"); flashFx("warp", { x: t.x, y: t.y });
    if (t.hp <= 0) downOrKill(t, `痩身が${t.kind.name}を朽ちさせた。`); else log(`痩身（HP−${cut}）。`);
  } else if (key === "condemn") { // 断罪＝一撃必殺級（深蝕は極めて重い）
    if (!visMon.length) { log("断ずべき敵が見えない。", "dim"); draw(); return; }
    const t = nearestMon(visMon);
    const dmg = Math.round(warpDamage(effectiveReason(ch)) * 3);
    t.hp -= dmg;
    sfx("spell_warp"); flashFx("warp", { x: t.x, y: t.y });
    if (t.hp <= 0) downOrKill(t, `断罪。${t.kind.name}は赦されなかった。`); else log(`断罪（${dmg}）。`);
  } else if (key === "confuse") { // 惑乱＝可視の敵をよろめかせる
    if (!visMon.length) { log("惑わせる敵が見えない。", "dim"); draw(); return; }
    for (const m of visMon) m.confused = 5;
    sfx("spell_still"); flashFx("still");
    log(`惑乱。${visMon.length}体が、よろめく。`);
  } else if (key === "slumber") { // 微睡＝最寄りを深く眠らせる（長い停止）
    if (!visMon.length) { log("眠らせる敵が見えない。", "dim"); draw(); return; }
    const t = nearestMon(visMon); t.stunned = Math.max(t.stunned ?? 0, 5);
    sfx("spell_still"); flashFx("still", { x: t.x, y: t.y });
    log(`微睡。${t.kind.name}は深く眠った。`);
  } else if (key === "bind") { // 縛鎖＝最寄りをその場に縫い止める
    if (!visMon.length) { log("縫い止める敵が見えない。", "dim"); draw(); return; }
    const t = nearestMon(visMon); t.rooted = 6;
    sfx("spell_still"); flashFx("still", { x: t.x, y: t.y });
    log(`縛鎖。${t.kind.name}を縫い止めた。`);
  } else if (key === "omni_strike") { // 万象斬＝視界の敵すべてへ斬撃（近接威力）
    if (!visMon.length) { log("斬る敵が見えない。", "dim"); draw(); return; }
    const dmg = meleeDmg(ch) + (attackBuffTurns > 0 ? ATTACK_BUFF : 0);
    for (const m of visMon) { m.hp -= dmg; flashFx("warp", { x: m.x, y: m.y }); if (m.hp <= 0) downOrKill(m, `万象斬が${m.kind.name}を断った。`); }
    sfx("spell_warp");
    log(`万象斬（${visMon.length}体・各${dmg}）。`);
  } else if (key === "gravity_pull") { // 引閘＝可視の敵を自分のほうへ一斉に引き寄せる
    if (!visMon.length) { log("引き寄せる敵が見えない。", "dim"); draw(); return; }
    let moved = 0;
    for (const m of visMon) {
      const sx = Math.sign(player.x - m.x), sy = Math.sign(player.y - m.y);
      const nx = m.x + sx, ny = m.y + sy;
      if ((sx || sy) && tileAt(floor, nx, ny) === 1 && !(nx === player.x && ny === player.y) &&
        !floor.monsters.some((o) => o !== m && o.hp > 0 && o.x === nx && o.y === ny)) { m.x = nx; m.y = ny; moved++; }
    }
    sfx("spell_warp"); flashFx("still");
    log(`引閘。${moved}体が、ずるりと引き寄せられた。`);
  } else if (key === "insight") { // 看破＝可視の敵のHPを読み、全敵の位置を地図に灯す
    for (const m of floor.monsters) if (m.hp > 0) floor.explored[mapIdx(floor, m.x, m.y)] = true;
    const census = visMon.map((m) => `${m.kind.name} ${m.hp}/${m.kind.hp}`).join("、");
    sfx("open");
    log(census ? `看破：${census}` : "看破：視界に敵影なし。", "warn");
  } else if (key === "scent") { // 嗅ぎ＝宝箱・化石・下り階段の在処を地図に灯す
    let n = 0;
    for (const c of floor.chests) if (!c.opened) { floor.explored[mapIdx(floor, c.x, c.y)] = true; n++; }
    for (const fo of floor.fossils) floor.explored[mapIdx(floor, fo.x, fo.y)] = true;
    floor.explored[mapIdx(floor, floor.stairsDown.x, floor.stairsDown.y)] = true;
    sfx("open");
    log(`嗅ぎ：宝箱${n}・化石${floor.fossils.length}の気配を地図に灯した。`, "warn");
  } else if (key === "minions") { // 蝕兵＝最寄りの敵の傍に短命の眷属2体
    if (!visMon.length) { log("眷属を差し向ける敵が見えない。", "dim"); draw(); return; }
    const t = nearestMon(visMon);
    const dmg = Math.max(2, Math.round(effectiveReason(ch)));
    let n = 0; for (let i = 0; i < 2; i++) if (spawnSummon(t, "ψ", "蝕兵", dmg, 5, false)) n++;
    sfx("spell_warp"); flashFx("warp", { x: t.x, y: t.y });
    log(n ? `蝕兵を${n}体起こした（各${dmg}・5手）。` : "湧かせる隙間がない。");
  } else if (key === "orbblade") { // 廻刃＝自分の傍を回る刃（@に追従）
    const dmg = Math.max(2, Math.round(effectiveReason(ch) * 1.2));
    const ok = spawnSummon(player, "‡", "廻刃", dmg, 6, true);
    sfx("spell_warp"); flashFx("warp", { x: player.x, y: player.y });
    log(ok ? `廻刃を侍らせた（${dmg}・6手・追従）。` : "刃を置く隙間がない。");
  } else if (key === "echo") { // 残響召喚＝在りし日の残響（強めの一時味方・@に追従）
    const dmg = Math.max(3, Math.round(effectiveReason(ch) * 1.6));
    const ok = spawnSummon(player, "Ψ", "残響", dmg, 6, true);
    sfx("spell_warp"); flashFx("still", { x: player.x, y: player.y });
    log(ok ? `在りし日の残響が、傍らに立った（${dmg}・6手）。` : "残響の立つ隙間がない。");
  } else if (key === "shadowclone") { // 影分け＝数手 敵の一撃を肩代わり
    shadowGuard = 3;
    sfx("spell_blink"); flashFx("blink", { x: player.x, y: player.y });
    log("影分け。三つの影が、身代わりに立つ（3度まで）。");
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
      // ① ステ+1（常に。術習得とは排他にしない＝ロードアウト制 4-11F③）
      const r = await sheet({
        text: `レベル${ch.level}に達した。何を伸ばす？`,
        meta: `${statsLine(ch)} ── 最大HP${maxHp(ch)} / 攻撃${meleeDmg(ch)}`,
        options: [
          `体 ＋1（最大HPが上がる）`,
          `力 ＋1（攻撃が上がる）`,
          `理 ＋1（深蝕魔法の威力・癒し量）`,
          `心 ＋1（深蝕に染まりにくくなる）`,
        ],
      });
      const key = STAT_KEYS[(r.pick - 1 + 4) % 4]; // やめる等の範囲外は体に丸める（必ず1つ伸びる）
      ch.stats[key] += 1;
      if (key === "body") hp = Math.min(hp + HP_PER, maxHp(ch)); // 体UPぶんを回復
      log(`レベル${ch.level} ── ${STAT_LABEL[key]}が伸びた（${statsLine(ch)}）。`, "warn");
      // ② 深みから術を1つ識る（任意・無制限・ステとは別枠）。
      //    間隔＝4レベルに1度（毎レベルは難易度を下げ、深淵/教団の意味も薄れるため）。
      //    高効果の術は minLevel に達するまでレベルアップ選択には出ない（他の入手法は不問）。
      const learnable = ch.level % LEARN_EVERY === 0
        ? SPELLS.filter((s) => !ch.spells.includes(s.key) && ch.level >= (s.minLevel ?? 1))
        : [];
      if (learnable.length) {
        const lr = await sheet({
          text: `深みから術が滲む。1つ識るか？（${LEARN_EVERY}レベルに1度。構えは街の ≡ で整える）`,
          meta: `術 ${ch.spells.length}種 識得済み ── 構え ${activeLoadout(ch).length}/${LOADOUT_CAP}`,
          options: [...learnable.map((s) => `[${s.school}] ${s.name}（深蝕＋${s.cost}／${s.desc}）`), "今は識らない"],
        });
        const s = learnable[lr.pick - 1];
        if (s) { learnSpell(ch, s.key); log(`深みから《${s.name}》を識った。`, "warn"); }
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
    recordCompanionFeat(); // 相棒と共にボスを討った＝偉業（4-4E 昇格ゲート）
  } else {
    log(killLine ?? `${mon.kind.name}を倒した。`);
  }
}

/** 移動 or 体当たり。falseなら手番を消費しない（壁） */
function moveOrInteract(nx: number, ny: number): boolean {
  const f = floor!;
  if (tileAt(f, nx, ny) !== 1) return false;

  const mon = f.monsters.find((m) => m.hp > 0 && m.x === nx && m.y === ny);
  if (mon) { // 攻撃（確定命中・確定ダメージ＝力依存＋焦躁バフ）
    const ch = world.current!;
    const dmg = meleeDmg(ch) + (attackBuffTurns > 0 ? ATTACK_BUFF : 0);
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

  // 手負いの冒険者（4-14C 入口B）：救助＝相棒化／見捨てる
  if (f.downed && f.downed.x === nx && f.downed.y === ny) { void rescueScene(f.downed); return true; }

  // 相棒のマスへ踏み込む＝位置を入れ替える（相棒が @ の元いたマスへ）。手番は消費。
  if (companion && companion.x === nx && companion.y === ny) {
    companion.x = player.x; companion.y = player.y;
    player = { x: nx, y: ny };
    sfx("move");
    return true;
  }

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
      hp = maxHp(world.current!); world.current!.depth = 0;
      // 同行（4-14C）：二人で生還＝絆が深まり、相棒は街に残存（次の潜行も隣を歩く）。
      if (companion && world.companion?.alive) {
        world.companion.bond += 1;
        log(`${companionName()}と共に生還した。絆が深まる。`, "cue");
        tryPromoteCompanion();
      }
      companion = null;
      save();
      log("地上の光がまぶしい。生きて、帰った。");
      busy = false;
      await maybeTownEvent(); // アンビエント街イベント（4-12 J）：襲撃/追悼など、稀に街で出来事が起きる
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
  // 同行（4-14C）：相棒と共に奉献を成した＝絆が深まり街へ残存。
  if (companion && world.companion?.alive) { world.companion.bond += 1; log(`${companionName()}と共に、奉献を成し遂げた。`, "cue"); tryPromoteCompanion(); }
  companion = null;
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
  const ev = selectDungeonStorylet(db, depth, rng, world.current?.exposure ?? 0, world);
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
    const it = b.splice(i, 1)[0], val = splitGold(sellGear(it, MERCHANT_SELL_MUL)); // 同行中は売却益も折半（4-14C）
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
      recordCompanionFeat(); // 相棒と共に山場を決着＝偉業（4-4E 昇格ゲート）
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
      recordCompanionFeat(); // 相棒と共に山場を決着＝偉業（4-4E 昇格ゲート）
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
  companion = null; // 盤上の相棒は ephemeral。
  if (world.companion?.alive) { // 契約モデル（4-14C）：プレイヤー死＝契約終了。相棒は生き延びて街へ（再雇用可）。
    persistCompanionRecord();   // 等級/絆/偉業を生者NPCへ書き戻し＝次代が雇い直せる
    log(`${companionName()}との契約は、ここで切れた。相棒は地上へ生き延び、また街で会えるだろう。`, "dim");
    world.companion = undefined;
  }
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
  const loadoutLine = ch && activeLoadout(ch).length
    ? `\n構え ${activeLoadout(ch).length}/${LOADOUT_CAP}: ${activeLoadout(ch).map((k) => spellByKey(k)?.name).filter(Boolean).join("、")}`
    : "";
  const sheetHead = ch
    ? `《${ch.name}》Lv${ch.level} ── ${statsLine(ch)}\n最大HP${maxHp(ch)} / 攻撃${meleeDmg(ch)} / 次のレベルまで残り${Math.max(0, xpToNext(ch.level) - ch.xp)}${eqLine}${invLine}${gearLine}\n深蝕 ${ch.exposure.toFixed(2)}${ch.carryingRelic ? `\n★聖遺物を携行中（生還せよ）` : ""}${spellNames ? `\n術(識得${ch.spells.length}): ${spellNames}` : ""}${loadoutLine}${ch.traits.length ? `\n形質: ${ch.traits.join("、")}` : ""}\n${sealLine}\n\n`
    : "";
  const mark = { birth: "生", death: "死", rediscovery: "再", intervention: "干", legend: "伝", rumor: "噂" } as const;
  const tail = world.chronicle.slice(-10).map((e) => `世代${e.generation} [${mark[e.kind]}] ${e.text}`).join("\n");
  const canLoadout = !!ch && mode !== "dive" && ch.spells.length > 0; // 構えの入替は安全地帯（街）のみ
  const opts: string[] = [
    isMuted() ? "♪ 音を出す" : "🔇 音を消す",
    dpadOn ? "方向パッド：オン → オフにする" : "方向パッド：オフ → オンにする",
    dpadPos === "right" ? "方向パッドの位置：右下 → 左下にする" : "方向パッドの位置：左下 → 右下にする",
  ];
  if (canLoadout) opts.push("術を構える（ロードアウト）");
  else if (ch && ch.spells.length > 0) opts.push("（術の構えは街・安全地帯でのみ）");
  const resetPick = opts.length + 1; // 「閉じる」の手前に挿す（条件で位置が動くため動的に算出）
  opts.push("⟲ 世界を最初からやり直す");
  opts.push("閉じる");
  const r = await sheet({
    text: sheetHead + (tail || "まだ何も記されていない。"),
    meta: `人物と年代記 ── 全${world.chronicle.length}件`,
    options: opts,
  });
  if (r.pick === 1) { ensureAudio(); setMuted(!isMuted()); }
  else if (r.pick === 2) { setDpad(!dpadOn); }
  else if (r.pick === 3) { setDpadPos(dpadPos === "right" ? "left" : "right"); }
  else if (canLoadout && r.pick === 4) { await manageLoadout(ch!); }
  else if (r.pick === resetPick) { await resetWorld(); }
  busy = false;
};

/** 世界を最初からやり直す（テスト/再挑戦用）。二段確認のうえセーブを消して再起動。
 *  消えるのは進行（World＝全世代・化石・年代記・系譜・依頼・自宅保管）。音・D-pad の端末設定は別キーゆえ残る。 */
async function resetWorld() {
  const r1 = await sheet({
    text: `世界を最初からやり直す──第${world.generation}世代までの全記録（化石・年代記・系譜・依頼・自宅の保管）が消え、元には戻せない。\n（音・方向パッドの設定は残ります）`,
    meta: "リセット ── 取り返しがつきません",
    options: ["いいえ、やめておく", "最初からやり直す"],
  });
  if (r1.pick !== 2) return;
  const r2 = await sheet({
    text: "本当に、この世界のすべてを消してよいですか？",
    meta: "最終確認",
    options: ["いいえ", "はい、消す"],
  });
  if (r2.pick !== 2) return;
  try { localStorage.removeItem(SAVE_KEY); } catch { /* ignore */ }
  log("世界をまっさらに戻す……", "warn");
  location.reload(); // 再起動＝boot() が新規 World＋キャラ作成から走る（一時状態の取りこぼし無し）
}

/** 術の構え（ロードアウト）を整える。識得済みの中から LOADOUT_CAP 個を選んで構える（安全地帯のみ）。 */
async function manageLoadout(ch: Character) {
  if (!ch.loadout) ch.loadout = ch.spells.slice(0, LOADOUT_CAP);
  while (true) {
    const known = ch.spells.map((k) => spellByKey(k)).filter((s): s is NonNullable<typeof s> => !!s);
    const opts = known.map((s) => `${ch.loadout!.includes(s.key) ? "◆構え" : "・控え"} [${s.school}] ${s.name} ── ${s.desc}`);
    const r = await sheet({
      text: `戦闘で撃てるのは「構え」だけ。タップで 構え⇄控え を入れ替える。\n構え ${ch.loadout!.length}/${LOADOUT_CAP}`,
      meta: `術の構え ── ${ch.spells.length}種 識得`,
      options: [...opts, "閉じる"],
    });
    if (r.pick < 1 || r.pick > known.length) break;
    const s = known[r.pick - 1];
    const i = ch.loadout!.indexOf(s.key);
    if (i >= 0) { ch.loadout!.splice(i, 1); log(`${s.name} を控えに戻した。`, "dim"); }
    else if (ch.loadout!.length < LOADOUT_CAP) { ch.loadout!.push(s.key); log(`${s.name} を構えた。`, "dim"); }
    else log(`構えは${LOADOUT_CAP}つまで。何か外してから。`, "dim");
  }
  save();
}

// ---------- 入力（8方向：スワイプ／方向キー／numpad／viキー(yubn)／D-pad。タップ＝待機／図でタップ＝自動移動／.＝待機） ----------
$("mapBtn").onclick = () => { if (mode === "dive" && !busy) setMapMode(!mapMode); };

// 方向パッド（D-pad）の表示設定。スワイプと併用、設定（≡メニュー）でオンオフ・位置を端末に記憶。
const DPAD_KEY = "sekitsui.dpad";
const DPAD_POS_KEY = "sekitsui.dpad.pos";
let dpadOn = true; // 既定オン
let dpadPos: "right" | "left" = "right"; // 既定は右下（利き手側）
function loadDpadPref() {
  try {
    dpadOn = localStorage.getItem(DPAD_KEY) !== "0"; // 未設定＝オン
    dpadPos = localStorage.getItem(DPAD_POS_KEY) === "left" ? "left" : "right";
  } catch { /* ignore */ }
}
function applyDpad() {
  const el = $("dpad");
  el.classList.toggle("show", dpadOn);
  el.classList.toggle("pos-left", dpadPos === "left");
  el.classList.toggle("pos-right", dpadPos === "right");
}
function setDpad(on: boolean) {
  dpadOn = on;
  try { localStorage.setItem(DPAD_KEY, on ? "1" : "0"); } catch { /* ignore */ }
  applyDpad();
}
function setDpadPos(p: "right" | "left") {
  dpadPos = p;
  try { localStorage.setItem(DPAD_POS_KEY, p); } catch { /* ignore */ }
  applyDpad();
}

/** 移動入力の合流点（キー／スワイプ／D-pad）。8方向＋待機。mode と図モードの面倒を見る。 */
function dirMove(dx: number, dy: number) {
  if (busy) return;
  ensureAudio();
  if (mode === "town" || mode === "interior") { if (dx === 0 && dy === 0) return; townAct(dx, dy); return; }
  if (mode !== "dive") return;
  if (mapMode) { setMapMode(false); return; }
  void playerAct(dx, dy);
}

/** スワイプのベクトルを8方向へ量子化（45°セクタ。tan22.5°≈0.414 で斜めと直交を分ける）。 */
function octant(dx: number, dy: number): [number, number] {
  const adx = Math.abs(dx), ady = Math.abs(dy);
  const sx = adx > ady * 0.414 ? Math.sign(dx) : 0;
  const sy = ady > adx * 0.414 ? Math.sign(dy) : 0;
  return [sx, sy];
}

// D-pad のボタン（body 直下＝mapWrap のタッチ判定と干渉しない）。click でタップ／マウス両対応。
for (const btn of Array.from($("dpad").querySelectorAll("button"))) {
  (btn as HTMLElement).addEventListener("click", () => {
    const el = btn as HTMLElement;
    dirMove(Number(el.dataset.dx), Number(el.dataset.dy));
  });
}

// 最初のユーザー操作で音を起動（iOS は AudioContext を gesture 内で resume する必要がある）
addEventListener("pointerdown", () => ensureAudio());

// キー入力：方向キー＋WASD（直交）／viキー yubn（斜め）／numpad 1-9（8方向＋5=待機）。
const DIR_KEYS: Record<string, [number, number]> = {
  ArrowUp: [0, -1], ArrowDown: [0, 1], ArrowLeft: [-1, 0], ArrowRight: [1, 0],
  w: [0, -1], s: [0, 1], a: [-1, 0], d: [1, 0],
  y: [-1, -1], u: [1, -1], b: [-1, 1], n: [1, 1],
  ".": [0, 0],
};
const DIR_CODES: Record<string, [number, number]> = {
  Numpad8: [0, -1], Numpad2: [0, 1], Numpad4: [-1, 0], Numpad6: [1, 0],
  Numpad7: [-1, -1], Numpad9: [1, -1], Numpad1: [-1, 1], Numpad3: [1, 1], Numpad5: [0, 0],
};
addEventListener("keydown", (e) => {
  ensureAudio();
  const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
  const dir = DIR_KEYS[k] ?? DIR_CODES[e.code];
  if (!dir) return;
  e.preventDefault();
  dirMove(dir[0], dir[1]);
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
    if (!tap) { // スワイプ＝8方向移動
      const [sx, sy] = octant(dx, dy); townAct(sx, sy);
    } else if (cellSize > 0) { // タップ＝隣接マスへ一歩（斜め含む）
      const r = gridEl.getBoundingClientRect();
      const gx = cam.x + Math.floor((tx - r.left) / cellSize);
      const gy = cam.y + Math.floor((ty - r.top) / cellSize);
      const ddx = gx - townPlayer.x, ddy = gy - townPlayer.y;
      if (Math.max(Math.abs(ddx), Math.abs(ddy)) === 1) townAct(Math.sign(ddx), Math.sign(ddy));
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

  if (!tap) { // スワイプ＝8方向移動
    const [sx, sy] = octant(dx, dy); void playerAct(sx, sy);
    return;
  }
  // タップ（ボタン以外の任意位置）＝待機。移動はスワイプ／D-pad で行う。
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
  loadDpadPref();
  applyDpad();
  buildGridDom();
  updateStatus();
  if (!world.current || !world.current.alive) await characterCreation();
  else { world.current.depth = 0; log(`（${world.current.name}は街にいる）`, "dim"); }
  await townLoop();
  await startDive();
}
void boot();

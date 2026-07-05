// Web（PWA）本体：方向A（発光グリフ）・縦持ち・D-pad左 のローグライク
// 街（シート）⇄ 迷宮（グリッド・ターン制）。化石はマップ上の実体として現れる。

import fragmentsJson from "../../content/fragments.json";
import setpiecesJson from "../../content/setpieces.json";
import { makeContentDb } from "../content.ts";
import { makeRng, type Rng } from "../rng.ts";
import {
  newWorld, createCharacter, fossilizeCurrent, retireCurrent, fossilizeCompanion, fossilizeAbandoned, intervene, recordRediscovery,
  worldTime, accrueWorldClock, stampReached,
  chronicle, poleLabel, finalActLabel, migrateWorld, awardSeal, abyssUnlocked, setArc, getArc,
  grantEchoOnRequiem, consumeEcho, ECHO_DEPLOY_COST,
  BLOOD_SPELLS, PUPIL_SPELLS,
} from "../world.ts";
import { computeVariation, exposureGain, QUIRK_THRESHOLDS } from "../variation.ts";
import {
  maxHp, meleeDmg, heartFactor, xpToNext, xpForKill, statsLine,
  STAT_KEYS, STAT_LABEL, HP_PER, packCapacity, STASH_CAP, STASH_CAP_MANOR, STASH_INHERIT, STASH_INHERIT_MANOR, LOADOUT_CAP, BASE_STATS,
  armorReduce, effectiveReason, equipExposure,
  DEPTH_SEAL_AT, ABYSS_DEPTH, RELIC_EXPOSURE_PER_TURN, RELIC_PURSUER_EVERY, RELIC_PURSUER_CAP,
} from "../progression.ts";
import { SPELLS, spellByKey, warpDamage } from "../spells.ts";
import { rollItem, rollItemOfSlot, itemByName, enchantUp, forgeItem, artifactBaseNames, itemPower, itemLabel, itemValue, SLOT_LABEL, CONSUMABLES, consumableByKey, grantConsumable, type ConsumableDef } from "../items.ts";
import {
  renderDeathLine, renderRediscovery, renderRumor, renderArcBeat, matchSetPiece, fillStoryletText, fillDungeonText, fillActorText,
  requiemLine, leaveLine, inheritLine, REQUIEM_RELIEF,
} from "../render.ts";
import { rollEncounter } from "../weights.ts";
import { filterByTags } from "../content.ts";
import { selectStorylet, applyEffects, selectDungeonStorylet, applyDungeonEffects, selectTownStorylet, selectKeeperStorylet, selectDelverStorylet, applyActorEffects, rollChestOutcome } from "../storylets.ts";
import { meetActor, mintActor, rememberActor, pickRosterActor, fossilNames } from "../actors.ts";
import {
  generateOffers, generateNobleOffers, acceptQuest, activeQuests, doneQuests, claimQuest,
  onReachDepth, onRediscoverFossil, onPlunderFossil, onSlayBoss, onKillMonster, onRescueDelver, onEscortArrive, failEscortQuest,
  type QuestTemplates, type MonsterLite, type OfferOpts,
} from "../quests.ts";
import storyletsJson from "../../content/storylets.json";
import adventurersJson from "../../content/adventurers.json";
import townJson from "../../content/town.json";
import keepsakesJson from "../../content/keepsakes.json";
import questsJson from "../../content/quests.json";
import type { KeepsakeDef } from "../types.ts";
import {
  buildTownGrid, buildInterior, spawnCrowd, wanderCrowd, crowdAt, townTileAt, interiorActorAt,
  type TownData, type TownGrid, type Interior, type CrowdActor, type InteriorActor, type GuardDef,
} from "../townscene.ts";
import {
  ensureAudio, audioStarted, sfx, setAmbient, setMuted, isMuted, loadMutePref,
  setBgm, setBgmDepth, setBgmEnabled, isBgmOn, setBgmVolume, bgmVolume, loadBgmPref, setSfxVolume, sfxVolume,
} from "./audio.ts";
import {
  genFloor, genRaidField, placeFossil, computeFov, planMonsters, resolveMonsters, tileAt, mapIdx, spawnPursuer,
  planCompanion, resolveCompanion, randomFloorAway, inBounds, companionMaxHp, companionDmg, scaleKind,
  bfsPath, reachableSet, nearestReachable,
  VIEW_W, VIEW_H, MONSTER_KINDS, type Floor, type Pos, type Chest, type Monster, type CompanionEntity, type DownedActor, type DelverActor, type Shrine,
} from "../dungeon.ts";
import type { Actor, Character, FinalActChoice, Fossil, Fragment, Item, ItemSlot, LivingActor, Quest, RosterActor, SetPiece, Storylet, TownContext, World } from "../types.ts";
import { diffMods, SELECTABLE_DIFFICULTIES, DIFFICULTY_LABEL, DIFFICULTY_BLURB, type Difficulty } from "../difficulty.ts";
import { SEAL_KEYS, SEAL_LABEL } from "../types.ts";

const SAVE_KEY = "sekitsui.world.v0";
// アプリ版数（最新かの判定用）。デプロイのたびに必ず上げる。sw.js の CACHE も同値に揃える。
export const APP_VERSION = "0.121.0";
export const APP_BUILD = "2026-07-04";
// HP・攻撃力はステ由来（progression.ts）。体2/力2 で 最大HP12・攻撃3＝従来値。

const db = makeContentDb(
  fragmentsJson as { fragments: Fragment[] },
  setpiecesJson as { setpieces: SetPiece[] },
  storyletsJson as { storylets: Storylet[] },
  adventurersJson as { adventurers: RosterActor[] },
);

// 依頼テキストのテンプレ（データ駆動・2026-07-02）。generateOffers に opts で渡す。
const QUEST_TEMPLATES = (questsJson as { templates: QuestTemplates }).templates;
// 依頼盤面（供給増・多様化）：常に size まで多様な依頼を掲示し、同時受注は cap まで。
const GUILD_BOARD_SIZE = 5;   // ギルドの掲示枠（受注中を差し引いて補充）
const GUILD_ACTIVE_CAP = 4;   // 同時受注できるギルド依頼（noble 除く）
/** bounty 用：現レベルで狩れる（＝出現する）モンスター種を quests.ts へ渡す軽量記述子に詰める。 */
function bountyMonstersFor(level: number): MonsterLite[] {
  // 上限＝少し上まで（歯応え）／下限＝現深度帯で退場済みの雑魚は除外（issue10・高Lvで「大鼠を3体」等の間延びを防ぐ）。
  // maxDepth 未設定（深部まで出る種）は常に対象。maxDepth 有りは現レベル−6 以上で出るものだけ＝毎回深度1から潜っても達成可のまま帯を締める。
  const cand = MONSTER_KINDS
    .filter((k) => k.minDepth <= level + 4 && k.tier >= 1 && (k.maxDepth === undefined || k.maxDepth >= level - 6));
  const pool = cand.length ? cand : MONSTER_KINDS.filter((k) => k.minDepth <= level + 4 && k.tier >= 1); // 全滅回避（保険）
  return pool.map((k) => ({ key: k.key, name: k.name, tier: k.tier, minDepth: k.minDepth, maxDepth: k.maxDepth }));
}
/** 護衛依頼の依頼人候補（開板ごとに mint・受注時に同行者へ昇格）。escort offer と受注 run() を橋渡しする。 */
let escortCandidate: Actor | null = null;
/** ギルド board 用の生成 opts（テンプレ＋討伐対象モンスター＋護衛依頼人）。 */
function guildOfferOpts(source: "guild" | "tavern" = "guild"): OfferOpts {
  // 護衛は相棒枠が空いている時だけ掲示（依頼人が companion スロットを使うため）。死者名は避ける。
  escortCandidate = world.companion?.alive ? null : mintActor(db, rng, {}, fossilNames(world));
  return { source, templates: QUEST_TEMPLATES, monsters: bountyMonstersFor(curLevel()),
    escortClient: escortCandidate ? { name: escortCandidate.name } : undefined };
}

// 拾得品プール（読み物コレクション）：id→定義の索引。本文はここから引く＝セーブに複製しない。
const KEEPSAKES = (keepsakesJson as { keepsakes: KeepsakeDef[] }).keepsakes;
const KEEPSAKE_BY_ID = new Map(KEEPSAKES.map((k) => [k.id, k]));
const BAND_OF = (depth: number) => depth <= 8 ? "shallow" : depth <= 24 ? "mid" : depth <= 37 ? "deep" : "abyss";
const KEEPSAKE_CHANCE = 0.12; // 宝箱を開けた時に拾得品が出る確率（定義数と独立＝何個足しても頻度一定）
/** 深度 band に合う未収集の拾得品を1点付与（無ければ null）。出現頻度は KEEPSAKE_CHANCE が司る。 */
function grantKeepsake(depth: number): KeepsakeDef | null {
  const got = new Set((world.keepsakes ?? []).map((k) => k.id));
  const band = BAND_OF(depth);
  // band 適合の未収集を優先。尽きたら band 不問の未収集へ広げる（収集の取りこぼし防止）。
  let pool = KEEPSAKES.filter((k) => !got.has(k.id) && k.band === band);
  if (!pool.length) pool = KEEPSAKES.filter((k) => !got.has(k.id));
  if (!pool.length) return null; // 全収集済み
  const k = rng.pick(pool);
  (world.keepsakes ??= []).push({ id: k.id, gen: world.generation, depth });
  return k;
}

// ---------- DOM ----------
const $ = (id: string) => document.getElementById(id)!;
$("stVer").textContent = "v" + APP_VERSION; // 画面上部に版数を常時表示（最新かの判定用）
const gridEl = $("grid"), lightEl = $("light"), logEl = $("log");
const overlayEl = $("overlay"), sheetText = $("sheetText"), sheetEl = $("sheet");
const sheetHead = $("sheetHead"), sheetHeadTitle = $("sheetHeadTitle"), sheetHeadSub = $("sheetHeadSub"), sheetList = $("sheetList");
const sheetButtons = $("sheetButtons"), sheetInputRow = $("sheetInputRow"), sheetClose = $("sheetClose");

// 上部固定「閉じる」ショートカット＝シートが画面からはみ出してスクロールが要るときの保険（最下部の閉じるボタンまで探さず上部から閉じられる）。
// 出す条件は2つの AND：①末尾の選択肢（or chooseGrid のキャンセル）が厳密に「閉じる」「戻る」（＝メニュー/閲覧系）。
// ②シート内容が実際にはみ出ている（scrollHeight > clientHeight）＝末尾ボタンが折り返しの下に隠れている。
// 短いシーン（拾得品の一言＋「戻る」等）は末尾ボタンがそのまま見えるので冗長＝出さない（テストプレイFB＝余計な所に出さない）。
// 物語の内容語（「懐に納める」「立ち去る」）・強制選択（討つ/鎮める）・action 中断（「やめる」）も対象外（①で除外）。
const isCloseLabel = (s: string) => s === "閉じる" || s === "戻る";
// シートがビューポート上限（max-height 86dvh）を超えてスクロール領域を持つか。要 overlay 表示後に測定。
const sheetOverflows = () => sheetEl.scrollHeight > sheetEl.clientHeight + 4;
// 上部ヘッダ帯（横断F ①）：題（朱の左罫）＋副題。meta を最初の " ── " で題／副題に分割。
// Swift ＝ navigation title ＋ trailing の副題ラベル。帯は「題がある」or「✕が出ている」ときだけ表示。
function setSheetHead(meta?: string) {
  const i = meta ? meta.indexOf(" ── ") : -1;
  sheetHeadTitle.textContent = meta ? (i >= 0 ? meta.slice(0, i) : meta) : "";
  sheetHeadSub.textContent = meta && i >= 0 ? meta.slice(i + 4) : "";
  refreshSheetHead();
}
function refreshSheetHead() {
  sheetHead.classList.toggle("show", !!sheetHeadTitle.textContent || sheetClose.classList.contains("show"));
}
function armSheetClose(handler: (() => void) | null) {
  sheetClose.classList.toggle("show", !!handler);
  sheetClose.onclick = handler ? () => handler() : null;
  refreshSheetHead(); // ✕は帯内に置くため、arm したら帯も表示する
}
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
// 構造化行（横断F ①＝Wizardry 流の整列）。kv 行＝ラベル/値、text 行＝自由文。Swift ＝ LabeledContent / Text。
type SheetRow = { label: string; value: string; note?: string; cls?: string } | { text: string; dim?: boolean; cls?: string };
interface SheetSection { header?: string; rows: SheetRow[] } // Swift ＝ Section(header:)
// 選択肢＝文字列（従来どおり）／役割つきオブジェクト（opt-in）。既存 string[] 呼び出しはそのまま有効。
type SheetOption = string | { label: string; role?: "primary" | "cancel" | "danger"; header?: string; gap?: boolean };
interface SheetOpts { text?: string; sections?: SheetSection[]; meta?: string; options: SheetOption[]; input?: string; }
const optLabel = (o: SheetOption) => typeof o === "string" ? o : o.label;

/** 構造化セクションを #sheetList に描画（createElement + textContent のみ＝注入面ゼロ）。sections 無しなら空にする（残留リーク防止）。 */
function renderSheetSections(sections?: SheetSection[]) {
  sheetList.textContent = "";
  if (!sections) return;
  for (const sec of sections) {
    if (sec.header) {
      const h = document.createElement("div");
      h.className = "sec-h"; h.textContent = sec.header;
      sheetList.appendChild(h);
    }
    sec.rows.forEach((row, i) => {
      if ("label" in row) {
        const r = document.createElement("div");
        r.className = "kvrow" + (i === 0 ? " first" : "");
        const lab = document.createElement("span"); lab.className = "kvlab"; lab.textContent = row.label;
        const val = document.createElement("span"); val.className = "kvval" + (row.cls ? " " + row.cls : ""); val.textContent = row.value;
        if (row.note) { const n = document.createElement("span"); n.className = "note"; n.textContent = row.note; val.appendChild(n); }
        r.appendChild(lab); r.appendChild(val); sheetList.appendChild(r);
      } else {
        const t = document.createElement("div");
        t.className = "kvtext" + (row.dim ? " dim" : "") + (row.cls ? " " + row.cls : "");
        t.textContent = row.text; sheetList.appendChild(t);
      }
    });
  }
}

function sheet(o: SheetOpts): Promise<{ pick: number; text: string }> {
  return new Promise((resolve) => {
    hidePeek(); // 場面が開いたら「調べる」ポップは畳む（v0.99.0）
    sheetText.textContent = o.text ?? "";
    setSheetHead(o.meta);
    renderSheetSections(o.sections);
    sheetInputRow.classList.toggle("show", o.input !== undefined);
    sheetInput.value = ""; sheetInput.placeholder = o.input ?? "";
    sheetButtons.innerHTML = "";
    const shownAt = performance.now();
    // 直前の操作（敵を倒したタップ等）が出たてのシートを貫通して誤選択するのを防ぐデバウンス。
    const choose = (pick: number) => {
      if (performance.now() - shownAt < 300) return;
      overlayEl.classList.remove("show");
      resolve({ pick, text: sheetInput.value });
    };
    const last = o.options.length - 1;
    o.options.forEach((opt, i) => {
      const cfg: { label?: string; role?: "primary" | "cancel" | "danger"; header?: string; gap?: boolean } =
        typeof opt === "object" ? opt : {};
      if (cfg.header) { // グループ見出し（設定など）
        const h = document.createElement("div"); h.className = "sg"; h.textContent = cfg.header;
        sheetButtons.appendChild(h);
      }
      const label = optLabel(opt);
      const b = document.createElement("button");
      b.type = "button"; b.textContent = label;
      // 役割：明示 role が優先。無ければ自動＝末尾の「閉じる/戻る」＝cancel／「やり直す」を含む＝danger。
      const role = cfg.role
        ?? ((i === last && isCloseLabel(label)) ? "cancel"
          : label.includes("やり直す") ? "danger" : undefined);
      if (role === "primary") b.classList.add("b-primary");
      else if (role === "cancel") b.classList.add("b-cancel");
      else if (role === "danger") b.classList.add("b-danger");
      if (cfg.gap) b.classList.add("grp");
      b.onclick = () => choose(i + 1);
      sheetButtons.appendChild(b);
    });
    sheetEl.scrollTop = 0;
    overlayEl.classList.add("show");
    // 上部の閉じるショートカット：末尾の選択肢が「閉じる」「戻る」（＝メニュー系）かつ内容がはみ出ている（＝末尾ボタンが隠れる）ときだけ。
    // 表示後に測定（scrollHeight は overlay 表示後でないと取れない）。短いシーンは末尾ボタンが見えるので出さない。
    const closeIdx = last >= 0 && isCloseLabel(optLabel(o.options[last])) ? last : -1;
    armSheetClose(closeIdx >= 0 && sheetOverflows() ? () => choose(closeIdx + 1) : null);
  });
}

/** 術の学派→色クラス（選択グリッドのチップ）。 */
function schoolCls(school: string): string {
  return ({ "攻": "c-atk", "制": "c-ctl", "移": "c-mov", "援": "c-sup", "識": "c-lore", "召": "c-sum" } as Record<string, string>)[school] ?? "c-lore";
}

/** 選びやすい2列グリッドの選択シート。選んだ index（キャンセル＝-1）を返す。術/品/装備換装などで使う。 */
function chooseGrid(o: { title: string; lead?: string; cells: { html: string }[]; cancel?: string; cols?: number }): Promise<number> {
  return new Promise((resolve) => {
    sheetText.textContent = o.lead ?? "";
    setSheetHead(o.title);
    renderSheetSections(undefined); // 構造化リストを空に（前回シートの残留を防ぐ）
    sheetInputRow.classList.remove("show");
    sheetButtons.innerHTML = "";
    const grid = document.createElement("div");
    grid.className = "selgrid" + (o.cols === 1 ? " one" : "");
    const shownAt = performance.now();
    o.cells.forEach((c, i) => {
      const b = document.createElement("button");
      b.type = "button"; b.innerHTML = c.html;
      b.onclick = () => { if (performance.now() - shownAt < 300) return; overlayEl.classList.remove("show"); resolve(i); };
      grid.appendChild(b);
    });
    sheetButtons.appendChild(grid);
    const cancel = () => { overlayEl.classList.remove("show"); resolve(-1); };
    if (o.cancel) {
      const cb = document.createElement("button");
      cb.type = "button"; cb.textContent = o.cancel; cb.className = "b-cancel"; // キャンセル役割（中央・罫なし）
      cb.onclick = cancel;
      sheetButtons.appendChild(cb);
    }
    sheetEl.scrollTop = 0;
    overlayEl.classList.add("show");
    // 上部の閉じるショートカット：キャンセルが「閉じる」「戻る」（＝閲覧メニュー系）かつ内容がはみ出ているときだけ。「やめる」(action中断)には出さない。
    armSheetClose(o.cancel && isCloseLabel(o.cancel) && sheetOverflows() ? cancel : null);
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

// ---------- 盤上フロート（FloatFx・v0.99.0・§10.3）＝ダメージ/回復/撃破を盤上にポップ（シレン6流） ----------
// 純表示（rng 非使用・engine 非依存）。#floats は #grid の兄弟＝グリッド再構築で消えない。
// 与ダメ=fl-dmg(金泥)／被ダメ=fl-hurt(赤)／回復=fl-heal(緑)／見切り=fl-miss／撃破=fl-kill「＊」。
const FLOAT_MAX = 8; // DOM 増殖の上限（超過は最古を除去）
let floatSeq = 0;    // 同一マス多重時の横ずらし用（表示のみ）
function floatFx(x: number, y: number, text: string, cls: string): void {
  if ((mode !== "dive" && mode !== "raid") || mapMode || !floor) return;
  // カメラは @ 中心（draw() と同式）で都度算出＝手番解決中（draw 前）に呼ばれても位置がずれない（issue7）。
  // 旧実装は module 変数 cam（直前 draw のカメラ）を読むため、移動直後の被弾ポップが移動ぶんズレていた。
  const cx = clampCam(player.x - (VIEW_W >> 1), floor.w, VIEW_W);
  const cy = clampCam(player.y - (VIEW_H >> 1), floor.h, VIEW_H);
  const vx = x - cx, vy = y - cy;
  if (vx < 0 || vy < 0 || vx >= VIEW_W || vy >= VIEW_H) return; // ビュー外は出さない
  const box = $("floats");
  while (box.childElementCount >= FLOAT_MAX) box.removeChild(box.firstChild!);
  const el = document.createElement("span");
  el.className = `fl ${cls}`;
  el.textContent = text;
  el.style.left = ((vx + 0.5) / VIEW_W * 100) + "%";
  el.style.top = ((vy + 0.5) / VIEW_H * 100) + "%";
  el.style.marginLeft = `${((floatSeq++ % 3) - 1) * 10}px`; // 同時多発の重なりをずらす
  box.appendChild(el);
  el.addEventListener("animationend", () => el.remove());
  setTimeout(() => { if (el.isConnected) el.remove(); }, 900); // 保険（バックグラウンド時など）
}

/** タイル1マスぶんの演出レイヤ（挟撃の楔／会心の斬光／見切りの波紋・v0.115.0）。
 *  floatFx と同じカメラ算出＝手番解決中でもズレない。純CSS 200-400ms・入力非ブロック（pointer-events:none）。
 *  グリフは覆わない（半透明の線・枠のみ）＝命中フラッシュ廃止（FB 2026-07-03）の教訓を守る。 */
function tileFx(x: number, y: number, cls: string): void {
  if ((mode !== "dive" && mode !== "raid") || mapMode || !floor) return;
  const cx = clampCam(player.x - (VIEW_W >> 1), floor.w, VIEW_W);
  const cy = clampCam(player.y - (VIEW_H >> 1), floor.h, VIEW_H);
  const vx = x - cx, vy = y - cy;
  if (vx < 0 || vy < 0 || vx >= VIEW_W || vy >= VIEW_H) return;
  const box = $("floats");
  const el = document.createElement("span");
  el.className = `tfx ${cls}`;
  el.style.left = ((vx + 0.5) / VIEW_W * 100) + "%";
  el.style.top = ((vy + 0.5) / VIEW_H * 100) + "%";
  el.style.width = (100 / VIEW_W) + "%";
  el.style.height = (100 / VIEW_H) + "%";
  box.appendChild(el);
  el.addEventListener("animationend", () => el.remove());
  setTimeout(() => { if (el.isConnected) el.remove(); }, 900);
}

/** 会心のマイクロシェイク（盤面を140msだけ僅かに揺らす＝重い一撃の手応え）。 */
function shakeGrid(): void {
  const mw = $("mapWrap");
  mw.classList.remove("shake-crit");
  void mw.offsetWidth; // 連発時もアニメを再始動させる
  mw.classList.add("shake-crit");
  setTimeout(() => mw.classList.remove("shake-crit"), 200);
}

// ---------- 調べる（タップ＝NetHack「;」の現代化・v0.99.0・§10.3/§10.6） ----------
// 盤面タップでそのマスの情報を上帯にポップ。手番非消費・busy 非使用・入力非ブロック（pointer-events:none）。
// 敵の傷は数値を伏せた「傷語」で語る（NetHack 流の距離感）：無傷/浅手/手負い/深手/瀕死。
let peekTimer: ReturnType<typeof setTimeout> | null = null;
const WOUND_WORDS: [number, string][] = [[1, "無傷"], [0.75, "浅手"], [0.5, "手負い"], [0.25, "深手"], [0, "瀕死"]];
function woundWord(m: Monster): string {
  const r = m.hp / Math.max(1, m.kind.hp);
  for (const [t, w] of WOUND_WORDS) if (r >= t) return w;
  return "瀕死";
}
function monsterStatusWords(m: Monster): string[] {
  const s: string[] = [];
  if (m.stunned) s.push("静止");
  if (m.slowed) s.push("鈍り");
  if (m.fear) s.push("畏れ");
  if (m.confused) s.push("惑乱");
  if (m.rooted) s.push("縛鎖");
  if (m.weak) s.push("衰弱");
  if (m.poison) s.push("腐喰");
  return s;
}
function hidePeek(): void {
  if (peekTimer) { clearTimeout(peekTimer); peekTimer = null; }
  ($("peek") as HTMLElement).hidden = true;
}
function setPeek(name: string, sub: string): void {
  const el = $("peek") as HTMLElement;
  el.hidden = true; // 一度隠す＝再タップでもフェードインを頭から
  (el.querySelector(".pk-name") as HTMLElement).textContent = name;
  const subEl = el.querySelector(".pk-sub") as HTMLElement;
  subEl.textContent = sub;
  subEl.style.display = sub ? "" : "none";
  void el.offsetWidth;
  el.hidden = false;
  if (peekTimer) clearTimeout(peekTimer);
  peekTimer = setTimeout(hidePeek, 4000);
}
/** マップ座標 (x,y) のマスを調べる。優先順は draw() の描画優先と同じ（上にあるもの＝知りたいもの）。 */
function showPeek(x: number, y: number): void {
  const f = floor;
  if (!f || x < 0 || y < 0 || x >= f.w || y >= f.h) return;
  const i = mapIdx(f, x, y);
  if (!f.explored[i]) { setPeek("未踏の闇", "まだ足を踏み入れていない。"); return; }
  const vis = computeFov(f, player).has(i);
  // 自分・味方
  if (player.x === x && player.y === y) { setPeek(`@　${world.current?.name ?? "自分"}`, "自分。ここに立っている。"); return; }
  if (companion && companion.hp > 0 && companion.x === x && companion.y === y) {
    setPeek(`@　${companionName()}（相棒）`, "共に潜る相棒。隣の敵を討ち、背を守る。"); return;
  }
  if (mode === "raid") {
    const a = allies.find((al) => al.hp > 0 && al.x === x && al.y === y);
    if (a) { setPeek(`@　${a.name}（共闘）`, "共に街を守る冒険者。"); return; }
    const cv = civics.find((c) => c.hp > 0 && c.x === x && c.y === y);
    if (cv) { setPeek("民　逃げ遅れた者", "踏み込めば安全な路地へ逃がせる。獣が隣接すると呑まれる。"); return; }
  }
  // 敵（見えている時のみ＝視界外の敵情報は漏らさない）
  const mon = vis ? f.monsters.find((m) => m.hp > 0 && m.x === x && m.y === y) : undefined;
  if (mon) {
    const k = mon.kind;
    const name = `${k.glyph}　${k.name}${mon.boss === "area" ? "（主）" : mon.boss === "elite" ? "（強）" : ""}`;
    const bits: string[] = [tierStars(k.tier), woundWord(mon)];
    if (mon.enraged) bits.push("覚醒");
    bits.push(...monsterStatusWords(mon));
    let sub = bits.join("　");
    if (k.ability) sub += `\n〔${ABILITY_LABEL[k.ability] ?? k.ability}〕${ABILITY_INFO[k.ability] ?? ""}`;
    setPeek(name, sub); return;
  }
  const sm = summons.find((s) => s.x === x && s.y === y);
  if (sm) { setPeek(`${sm.glyph}　${sm.name}（召喚）`, "術で編んだ一時の味方。数手で霧散する。"); return; }
  // 手負い/すれ違い/化石/宝箱は draw() が「視界内のみ」描く＝peek も vis 限定に揃える（霧の中の盤面は「·」なのに調べると宝箱と答える不整合を防ぐ）。
  if (vis && f.downed && f.downed.x === x && f.downed.y === y) { setPeek("&　手負いの冒険者", "倒れている。踏み込めば助け起こせる――見捨てることもできる。"); return; }
  if (vis && f.delver && f.delver.x === x && f.delver.y === y) { setPeek("@　見知らぬ冒険者", "同じ深みを行く生者。すれ違いに言葉を交わせる。"); return; }
  const fe = vis ? f.fossils.find((e) => e.x === x && e.y === y) : undefined;
  if (fe) { setPeek("†　化石", fe.resolved ? "鎮まった亡骸。もう語らない。" : "何者かの亡骸が層に眠る。踏み込めば対面する。"); return; }
  const ce = vis ? f.chests.find((c) => c.x === x && c.y === y) : undefined;
  if (ce) { setPeek("▭　宝箱", ce.opened ? "開け放たれている。中は空だ。" : "閉じたままの箱。罠のこともある。"); return; }
  // ノード・地形（泉/安/扉/階段は draw() が記憶描画する＝視界外でも答えてよい）。
  const shr = f.shrines.find((s) => !s.used && s.x === x && s.y === y);
  if (shr) { setPeek(shr.kind === "spring" ? "泉　回復の泉" : "安　安息所", shr.kind === "spring" ? "澄んだ水が傷を癒す（一度きり）。" : "腰を下ろせば深蝕が薄らぐ（一度きり）。"); return; }
  if (f.returnDoor && f.returnDoor.x === x && f.returnDoor.y === y) { setPeek("扉　帰還の扉", "くぐれば街へ戻る。あの階への帰り道は、街の慰霊碑の傍に一度だけ開く。"); return; }
  if (f.aurelSite && f.aurelSite.x === x && f.aurelSite.y === y) { setPeek(f.aurelSite.kind === "mark" ? "痕　灼き付いた徴" : "境　岩壁の呼吸", f.aurelSite.kind === "mark" ? "始祖の遺構らしい。踏み込めば読める。" : "岩と人の境目が、生きて呼吸している。踏み込めば言葉を交わせる。"); return; }
  // 階段は迷宮でのみ機能する（街防衛戦の戦場 genRaidField は装飾の階段を置くだけ＝raid では説明しない）。
  if (mode === "dive" && f.stairsDown.x === x && f.stairsDown.y === y) { setPeek("›　降り階段", "さらに深くへ。"); return; }
  if (mode === "dive" && f.stairsUp.x === x && f.stairsUp.y === y) { setPeek("‹　上り階段", f.depth === 1 ? "地上へ。ここから生還できる。" : "ひとつ浅い層へ。"); return; }
  if (tileAt(f, x, y) === 1) setPeek("·　石畳", "何もない床。");
  else setPeek("▒　石壁", "崩れる気配はない。");
}

// ---------- 雰囲気（松明の色調・フロア進入バナー・v0.99.0・§10.3b） ----------
// 深度帯で松明の色が変わる（浅=暖 → 深=冷 → 深淵=菫）。#light の --torch-rgb を band クラスで切替。
function applyDepthBand(depth: number, abyss = false): void {
  const mw = $("mapWrap");
  mw.classList.remove("band-mid", "band-deep", "band-abyss");
  if (abyss) mw.classList.add("band-abyss");
  else if (depth >= 25) mw.classList.add("band-deep");
  else if (depth >= 9) mw.classList.add("band-mid");
  // <9 は無印（既定の暖色）
}
let bannerTimer: ReturnType<typeof setTimeout> | null = null;
/** フロア進入の一瞬のバナー（例「深度 12 ─ 中層」）。純表示・pointer-events なし。 */
function showFloorBanner(text: string, abyss = false): void {
  const el = $("floorBanner") as HTMLElement;
  el.textContent = text;
  el.classList.toggle("abyss", abyss);
  el.classList.remove("show"); void el.offsetWidth; el.classList.add("show");
  if (bannerTimer) clearTimeout(bannerTimer);
  bannerTimer = setTimeout(() => el.classList.remove("show"), 1600);
}

// ---------- 世界の永続化 ----------
const SAVE_BAK_KEY = SAVE_KEY + ".bak"; // 壊れて読めなかったセーブの退避先（黙って消さない＝復元の余地を残す）
function loadOrCreateWorld(): World {
  const raw = localStorage.getItem(SAVE_KEY);
  if (raw) {
    try {
      const w = migrateWorld(JSON.parse(raw) as World);
      log(`（前回の世界を読み込んだ：第${w.generation}世代 / 化石${w.fossils.length}件）`, "dim");
      return w;
    } catch {
      // 壊れたセーブは黙って捨てず退避（次の save で上書きされる前に）。設定→読み込みで救える余地を残す。
      try { localStorage.setItem(SAVE_BAK_KEY, raw); } catch { /* ignore */ }
      log("⚠ 前回のセーブを読み込めませんでした。新しい世界で始めます（壊れたデータは退避しました）。", "warn");
    }
  }
  log("（新しい世界が生まれた）", "dim");
  return newWorld(Date.now() % 2147483647);
}
let storageWarned = false; // ストレージ不可の警告は一度だけ（毎手のログ氾濫を避ける）
const save = () => {
  try {
    localStorage.setItem(SAVE_KEY, JSON.stringify(world));
  } catch {
    // 容量超過/プライベートモード等。途中保存を捨てて再試行し、なお不可ならゲームは続行しつつ一度だけ警告。
    try { localStorage.removeItem(DIVE_KEY); localStorage.setItem(SAVE_KEY, JSON.stringify(world)); }
    catch { if (!storageWarned) { storageWarned = true; log("⚠ セーブできません（ブラウザのストレージが使えない可能性）。設定→「セーブを書き出す」で保管を。", "warn"); } }
  }
  saveDive();
};

// 潜行の途中状態（フロア/位置/HP/階キャッシュ）を保存＝アプリを完全に閉じても深度0からやり直しにならない
// （途中で閉じる＝危機回避の抜け道を塞ぐ＝難易度維持）。Floor は JSON 化可能。街/死で自動クリア。
const DIVE_KEY = "sekitsui.dive.v0";
interface DiveSnapshot { depth: number; hp: number; inAbyss: boolean; player: Pos; floor: Floor; cache: [number, Floor][]; pursuerCount: number; turnsSinceFloor: number; setPieceCooldown?: number; quietDescents?: number; }
function saveDive(): void {
  try {
    if (mode === "dive" && floor && world.current?.alive) {
      const snap: DiveSnapshot = { depth: floor.depth, hp, inAbyss, player, floor, cache: [...floorCache.entries()], pursuerCount, turnsSinceFloor, setPieceCooldown, quietDescents };
      localStorage.setItem(DIVE_KEY, JSON.stringify(snap));
    } else localStorage.removeItem(DIVE_KEY);
  } catch { /* ignore */ }
}
function clearDive(): void { try { localStorage.removeItem(DIVE_KEY); } catch { /* ignore */ } }

// 帰還の扉（街側・一回だけ）：ボス撃破後に街へ戻ると、あの階の盤面（ボス討伐済み）を丸ごと
// 「駐機」しておく。live な DiveSnapshot は街入場で破棄されるので、これは専用キーに退避＝
// リロード/アプリ再起動でも生き残り、慰霊碑の扉から一度だけ同じ盤面へ戻れる。
const PORTAL_KEY = "sekitsui.portal.v0";
function parkPortal(): void {
  try {
    if (mode === "dive" && floor && world.current?.alive) {
      const snap: DiveSnapshot = { depth: floor.depth, hp, inAbyss, player: floor.returnDoor ? { ...floor.returnDoor } : player, floor, cache: [...floorCache.entries()], pursuerCount, turnsSinceFloor, setPieceCooldown, quietDescents };
      localStorage.setItem(PORTAL_KEY, JSON.stringify(snap));
      world.town.returnPortal = { depth: floor.depth };
    }
  } catch { /* ignore＝盤面は失っても world フラグで深度だけは戻せる（保険） */ }
}
function loadPortal(): DiveSnapshot | null {
  try {
    const raw = localStorage.getItem(PORTAL_KEY); if (!raw) return null;
    const s = JSON.parse(raw) as DiveSnapshot;
    if (s && s.floor && s.player && typeof s.hp === "number" && Array.isArray(s.cache)) return s;
  } catch { /* ignore */ }
  return null;
}
function clearPortal(): void { try { localStorage.removeItem(PORTAL_KEY); } catch { /* ignore */ } world.town.returnPortal = null; }

function loadDive(): DiveSnapshot | null {
  try {
    const raw = localStorage.getItem(DIVE_KEY); if (!raw) return null;
    const s = JSON.parse(raw) as DiveSnapshot;
    if (s && s.floor && s.player && typeof s.hp === "number" && Array.isArray(s.cache)) return s;
  } catch { /* ignore */ }
  return null;
}

// ---------- 状態 ----------
let world = loadOrCreateWorld();
let rng: Rng = makeRng((world.seed ^ (world.chronicle.length * 2654435761) ^ (Date.now() & 0xffff)) >>> 0);
let hp = world.current ? maxHp(world.current) : 12;
let mode: "town" | "dive" | "interior" | "raid" = "town"; // raid＝街防衛戦（街襲撃の盤上化・4-12J）
let floor: Floor | null = null;
let player: Pos = { x: 0, y: 0 };
let companion: CompanionEntity | null = null; // 同行の盤上エンティティ（潜行中のみ。世代越えは world.companion：4-14C）
// 街防衛戦（raid）の盤上 ephemeral。共闘する冒険者（allies）と守る市民（civics）。戦闘終了でクリア。
let allies: RaidAlly[] = [];
let civics: RaidCivic[] = [];
let raid: RaidState | null = null;
let raidResolve: (() => void) | null = null; // 戦闘終了で resolve＝maybeTownEvent の await を解く
let busy = false; // シート表示中の入力ロック
let mapMode = false; // 地図表示（踏破範囲の俯瞰）
// 地図モードのカメラ窓（v0.109.0）：読めるサイズ（≥MAP_CELL_MIN px）で収まればフロア全体、
// 収まらなければ @ 中心で切り出し＝ドラッグでパン。深層で1タイルが潰れて読めない問題への対応。
let mapCam: Pos = { x: 0, y: 0 };
let mapCols = 0, mapRows = 0; // 地図ビューポートのマス数（＝グリッド寸法）
let mapOverview = false;      // 「全体図」モード：フロア全体を1画面に収める（パン無し。既定=off＝読めるサイズ+パン）
const MAP_CELL_MIN = 13;      // これ未満に縮むならパン表示へ切替（px）
let aim: Pos | null = null;   // 照準モード（地図でタップ→マーカー→D-padで微調整→確定で自動移動）
let aimReachable = false;     // 現在のマーカーへ到達経路があるか（確定可否・色分け）
let aimPath: Pos[] | null = null; // 照準までの経路（地図に点で描く・v0.99.0）
let cellSize = 0;
let cam: Pos = { x: 0, y: 0 }; // ビューポートの左上（@ を追うカメラ）
const clampCam = (v: number, mapSize: number, viewSize: number) => Math.max(0, Math.min(v, mapSize - viewSize));

// ---------- 街シーン（4-4B：歩ける固定マップ） ----------
const townGrid: TownGrid = buildTownGrid(townJson as unknown as TownData);
let townPlayer: Pos = { ...townGrid.data.start };
// QAデバッグフック（read-only・本番無害）：localStorage "sekitsui.dbg"="1" のときだけ window.__dbg を定義し、
// 街の現在地/タイル格子/貴族街解禁状態を露出する。tools/playtest-noble.ts（クリア後貴族街の BFS ナビ・ファジング）専用。
// 通常プレイヤーはフラグを立てないので未定義のまま＝副作用ゼロ。
try { if (typeof localStorage !== "undefined" && localStorage.getItem("sekitsui.dbg") === "1") (window as any).__dbg = () => ({ mode, townPlayer: { ...townPlayer }, ascended: world.ascended, nobleOpen: nobleQuarterOpen(), tile: townGrid.tiles[townPlayer.y]?.[townPlayer.x], ngate: townGrid.data.nobleGate, grid: townGrid.tiles, W: townGrid.data.width ?? townGrid.tiles[0].length, H: townGrid.tiles.length }); } catch {}
let crowd: CrowdActor[] = [];        // 街路の群衆（使い捨て・非永続）
let interior: Interior | null = null; // 屋内シーン（null=街路）
let townReturn: Pos | null = null;    // 屋内に入る直前の街路位置（出たら戻る）
let wanderTimer: ReturnType<typeof setInterval> | null = null;
let townDescendResolve: (() => void) | null = null; // 門で潜行＝townLoop を解決

// ---------- ステータスバー ----------
function updateStatus() {
  const ch = world.current;
  $("stName").textContent = ch ? ch.name : "—"; // 第N世代/フルネームはステータス画面（上は省略表示）
  $("stLv").textContent = ch ? String(ch.level) : "1";
  $("stDepth").textContent = String(mode === "dive" && floor ? floor.depth : 0);
  // HP/深蝕＝細ゲージ（横断F 段階1）。HP=現/最大、深蝕=満タン 3.0(=旧5段×0.6) 基準で%化。
  const hpMax = ch ? maxHp(ch) : Math.max(1, hp);
  $("stHpVal").textContent = `${hp}/${hpMax}`;
  $("stHpFill").style.width = `${Math.max(0, Math.min(100, Math.round(100 * hp / hpMax)))}%`;
  const e = ch?.exposure ?? 0;
  const exPct = Math.max(0, Math.min(100, Math.round((e / 3.0) * 100)));
  $("stExVal").textContent = `${exPct}%`;
  $("stExFill").style.width = `${exPct}%`;
  $("stGold").textContent = ch ? `◇ ${ch.gold}` : "◇ 0";
  // 術バフ/召喚の残量を一目に（潜行中のみ・ピルチップ。タップで説明＝buffSheet。4-11F③ ロードアウト魔法の体感補助）
  const stBuff = $("stBuff");
  stBuff.textContent = "";
  if (mode === "dive" || mode === "raid") {
    for (const b of currentBuffs()) {
      const span = document.createElement("span");
      span.className = "bf"; span.textContent = `⟡${b.label}${b.turns}`;
      stBuff.appendChild(span);
    }
  }
  applyChrome(); // 下部の操作系（タブバー・D-pad）を mode に応じて表示更新
}

// 今かかっている加護・状態（HUD ピル＋buffSheet で共用）。label＝表示名／turns＝残数／unit＝手・体・個／desc＝1行説明。
interface BuffInfo { label: string; turns: number; unit: string; desc: string; count?: boolean }
function currentBuffs(): BuffInfo[] {
  const b: BuffInfo[] = [];
  if (armorBuffTurns > 0) b.push({ label: "硬鱗", turns: armorBuffTurns, unit: "手", desc: `被ダメージ −${ARMOR_BUFF}` });
  if (attackBuffTurns > 0) b.push({ label: "焦躁", turns: attackBuffTurns, unit: "手", desc: `近接攻撃 +${ATTACK_BUFF}` });
  if (hasteTurns > 0) b.push({ label: "疾走", turns: hasteTurns, unit: "手", desc: "続けて動ける（離脱・追撃）" });
  if (deathDoorTurns > 0) b.push({ label: "死戸", turns: deathDoorTurns, unit: "手", desc: "この間は致死の一撃を耐える" });
  if (shadowGuard > 0) b.push({ label: "影", turns: shadowGuard, unit: "手", desc: "影の守り手が身を守る" });
  if (counterTurns > 0) b.push({ label: "反撃", turns: counterTurns, unit: "手", desc: `見切りの好機＝次の近接が会心（×${COUNTER_MULT}）` });
  if (chantTurns > 0) b.push({ label: "帰還詠唱", turns: chantTurns, unit: "手", desc: "詠唱中。動くか撃たれると中断" });
  if (poisonTurns > 0) b.push({ label: "毒", turns: poisonTurns, unit: "手", desc: "毎手ダメージを受ける（被毒）" });
  if (summons.length) b.push({ label: "召", turns: summons.length, unit: "体", desc: "一時の眷属が味方する", count: true });
  if (world.echoes?.length) b.push({ label: "遺灰", turns: world.echoes.length, unit: "個", desc: "「術」から残響を展開できる", count: true });
  return b;
}

/** HUD のバフ帯タップ＝今かかっている加護・状態の説明（SPD 流・詳細は1タップ先）。 */
async function buffSheet() {
  const list = currentBuffs();
  if (!list.length) return;
  busy = true;
  const rows: SheetRow[] = list.map((b) => ({
    label: `⟡ ${b.label}`,
    value: b.count ? `${b.turns}${b.unit}` : `残り ${b.turns}${b.unit}`,
    note: b.desc,
  }));
  await sheet({ meta: "いまの加護・状態", sections: [{ rows }], options: ["閉じる"] });
  busy = false;
}

// ---------- マップ描画（方向A） ----------
let cells: HTMLElement[] = [];
let gridCols = VIEW_W, gridRows = VIEW_H; // 現在のグリッド寸法（hitCell の座標補正用）
// 既定はプレイ用ビュー(VIEW)。地図モードでは実マップ寸法(floor.w×floor.h)で組み直し、1セル=1タイルで忠実描画する。
function buildGridDom(cols = VIEW_W, rows = VIEW_H) {
  gridEl.innerHTML = "";
  cells = [];
  const csW = Math.min(window.innerWidth, 560) / cols;
  const csH = ($("mapWrap").clientHeight - 4) / rows;
  const cs = Math.min(csW, csH);
  cellSize = cs;
  gridCols = cols; gridRows = rows;
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

/** クライアント座標→グリッドのマス（v0.99.0）。justify-content:center の左オフセット＋非整数 cellSize を補正。
 *  返り値はグリッド内座標（プレイビューなら cam を足してマップ座標へ）。範囲外は null。 */
function hitCell(clientX: number, clientY: number): Pos | null {
  if (cellSize <= 0) return null;
  const r = gridEl.getBoundingClientRect();
  const offX = (r.width - gridCols * cellSize) / 2; // 中央寄せぶんの左マージン
  const cx = Math.floor((clientX - r.left - offX) / cellSize);
  const cy = Math.floor((clientY - r.top) / cellSize);
  if (cx < 0 || cy < 0 || cx >= gridCols || cy >= gridRows) return null;
  return { x: cx, y: cy };
}

function draw() {
  if (!floor) return;
  if (mapMode) { drawMapMode(); return; }
  if (cells.length !== VIEW_W * VIEW_H) buildGridDom(VIEW_W, VIEW_H); // 防御：グリッドが VIEW 寸法と食い違うなら組み直す（範囲外セル参照を封じる）
  lightEl.style.display = "";
  lightEl.classList.remove("town"); // 迷宮＝松明の減光（街ヴィネットを外す）
  const vis = computeFov(floor, player);
  // カメラ：@ を中心に、マップ端ではクランプ（マップは常にビューより大きい）
  const camX = clampCam(player.x - (VIEW_W >> 1), floor.w, VIEW_W);
  const camY = clampCam(player.y - (VIEW_H >> 1), floor.h, VIEW_H);
  cam = { x: camX, y: camY };
  // テレグラフ（別表現）：移動予告＝行き先に敵の「残像グリフ」を薄く出す／攻撃予告＝自分のマスが
  // 討たれる→ @ が赤く明滅。抽象的な枠・点はやめ「敵がどこへ来るか」「自分が危ない」を直接見せる。
  const teleMove = new Set<number>();        // 敵が踏み込む先の床マス（背景ハイライト）
  let playerThreatened = false;              // 自分のマスが攻撃予告されている
  let playerHeavy = false;                   // 自分のマスがボスの渾身の一撃で予告されている（B・橙の危険枠）
  let companionThreatened = false;           // 相棒のマスが攻撃予告されている（4-14C）
  const friendThreat = new Set<number>();    // 街防衛戦：味方（冒険者）のマスが攻撃予告されている
  for (const m of floor.monsters) {
    if (m.hp <= 0 || !m.intent || !vis.has(mapIdx(floor, m.x, m.y))) continue;
    if (m.intent.type === "attack") {
      const ix = m.intent.x, iy = m.intent.y; // 局所化（クロージャ内で intent の絞り込みが失われるため）
      if (ix === player.x && iy === player.y) { playerThreatened = true; if (m.intent.heavy) playerHeavy = true; }
      else if (companion && ix === companion.x && iy === companion.y) companionThreatened = true;
      else if (allies.some((a) => a.hp > 0 && ix === a.x && iy === a.y)) friendThreat.add(mapIdx(floor, ix, iy));
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
    const shrM = floor.shrines.find((s) => s.x === x && s.y === y); // 回復ノード（v2・記憶に残る目印）
    if (shrM) { glyph = shrM.kind === "spring" ? "泉" : "安"; cls = shrM.kind === "spring" ? "g-spring" : "g-rest"; }
    if (floor.returnDoor && floor.returnDoor.x === x && floor.returnDoor.y === y) { glyph = "扉"; cls = "g-door"; } // 帰還の扉
    if (floor.aurelSite && floor.aurelSite.x === x && floor.aurelSite.y === y) { glyph = floor.aurelSite.kind === "mark" ? "痕" : "境"; cls = floor.aurelSite.kind === "mark" ? "g-aurel" : "g-laila"; } // メインの縦糸（4-15）
    if (visible) {
      const fe = floor.fossils.find((e) => e.x === x && e.y === y);
      if (fe) { glyph = "†"; cls = fe.resolved ? "g-fossil-quiet" : "g-fossil"; }
      const ce = floor.chests.find((c) => c.x === x && c.y === y);
      if (ce) { glyph = "▭"; cls = ce.opened ? "g-chest-open" : "g-chest"; }
      if (floor.downed && floor.downed.x === x && floor.downed.y === y) { glyph = "&"; cls = "g-downed"; } // 手負いの冒険者（4-14C）
      if (floor.delver && floor.delver.x === x && floor.delver.y === y) { glyph = "@"; cls = "g-delver"; } // 同時に潜る生者の冒険者（すれ違い）
      const m = floor.monsters.find((m) => m.hp > 0 && m.x === x && m.y === y);
      if (m) {
        glyph = m.kind.glyph;
        const bossHeavy = m.intent?.type === "attack" && m.intent.heavy; // 溜め大技の予告（B）
        cls = m.boss === "area" ? `g-boss${bossHeavy ? " g-boss-heavy" : ""}` : m.boss === "elite" ? "g-elite"
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
      cls = companionThreatened ? "g-companion-danger" : `g-companion${(companion!.erratic ?? 0) > 0 ? " g-companion-erratic" : ""}${companion!.intent?.type === "attack" ? " g-mon-atk" : ""}`;
    }
    // 街防衛戦：共闘する冒険者（青系@）と、逃げ遅れた市民（琥珀の「民」）。
    const ae = visible ? allies.find((a) => a.hp > 0 && a.x === x && a.y === y) : undefined;
    const allyThreatened = !!ae && friendThreat.has(mi);
    if (ae) { glyph = "@"; cls = allyThreatened ? "g-companion-danger" : `g-companion${ae.intent?.type === "attack" ? " g-mon-atk" : ""}`; }
    else if (visible && civics.some((cv) => cv.hp > 0 && cv.x === x && cv.y === y)) { glyph = "民"; cls = "g-downed"; }
    const isPlayer = x === player.x && y === player.y;
    if (isPlayer) { glyph = "@"; cls = playerThreatened ? (playerHeavy ? "g-player-heavy" : "g-player-danger") : "g-player"; }
    c.classList.toggle("tele-atk", (isPlayer && playerThreatened) || (isCompanion && companionThreatened) || allyThreatened); // 攻撃予告の赤枠
    span.textContent = glyph;
    // 床むら（v0.99.0）：素の床「·」だけ座標決定論で濃淡3段（rng 非使用・石畳の風合い）。
    if (cls === "g-floor") { const v = (x * 7 + y * 13) % 3; span.className = v === 2 ? "g-floor" : `g-floor v${v}`; }
    else span.className = cls;
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
// 地図モードのタイル配色（v0.99.0・①「静謐な写本」の暖墨へ調整）。
// 機能色相は据え置き＝階段:teal／泉:青緑／安:緑／扉・宝:金／照準:緑・赤（読み方は変えない）。
const MAP_BG = {
  unexplored: "#080604", floor: "#332b1e", wall: "#161310",
  stairs: "#173b40", spring: "#134044", rest: "#173f2e", door: "#4a4118",
  fossil: "#26534c", fossilQuiet: "#1f433d", chest: "#54431a",
  player: "#5a4a1a", path: "#3d3423", aimOk: "#1f7a4a", aimNg: "#7a2f2f",
} as const;
/** 地図ビューポートを算出（v0.109.0）：フロアが読めるサイズ（≥MAP_CELL_MIN px）で収まれば全体表示、
 *  収まらなければ最小サイズで @ 中心のカメラ窓（ドラッグでパン）。グリッドを組み直す。 */
function layoutMapView(): void {
  if (!floor) return;
  const availW = Math.min(window.innerWidth, 560);
  const availH = Math.max(1, $("mapWrap").clientHeight - 4);
  const fitCell = Math.min(availW / floor.w, availH / floor.h);
  // 全体図モード＝フロア全体を1画面に収める（fitCell）。既定＝読めるサイズ（≥MAP_CELL_MIN）でパン。
  const cell = mapOverview ? fitCell : Math.max(fitCell, MAP_CELL_MIN);
  mapCols = Math.min(floor.w, Math.max(1, Math.floor(availW / cell)));
  mapRows = Math.min(floor.h, Math.max(1, Math.floor(availH / cell)));
  buildGridDom(mapCols, mapRows); // cellSize は buildGridDom が min(availW/cols, availH/rows)≈cell で算出
  centerMapOn(player);
  updatePanHint();
}
function centerMapOn(p: Pos): void {
  if (!floor) return;
  mapCam = { x: clampCam(p.x - (mapCols >> 1), floor.w, mapCols), y: clampCam(p.y - (mapRows >> 1), floor.h, mapRows) };
}
/** 指定マスがビューポートに入るようカメラを寄せる（照準を D-pad で画面外へ動かしたとき追従）。 */
function ensureMapVisible(p: Pos): void {
  if (!floor) return;
  let cx = mapCam.x, cy = mapCam.y;
  if (p.x < cx) cx = p.x; else if (p.x > cx + mapCols - 1) cx = p.x - mapCols + 1;
  if (p.y < cy) cy = p.y; else if (p.y > cy + mapRows - 1) cy = p.y - mapRows + 1;
  mapCam = { x: clampCam(cx, floor.w, mapCols), y: clampCam(cy, floor.h, mapRows) };
}
/** 地図がパン可能か（フロアがビューポートに収まりきらない）。 */
function mapPannable(): boolean { return !!floor && (mapCols < floor.w || mapRows < floor.h); }
function updatePanHint(): void {
  const el = document.getElementById("mapPanHint"); if (!el) return;
  el.textContent = mapPannable() ? "◧ ドラッグでスクロール" : "";
}
function updateOverviewBtn(): void {
  const b = document.getElementById("mapOverviewBtn"); if (!b) return;
  b.textContent = mapOverview ? "拡大" : "全体図"; // 全体図表示中は「拡大」（＝読めるサイズ+パンへ戻す）
}
/** 全体図 ⇄ 拡大（読めるサイズ+パン）を切り替える。地図モード中のみ。 */
function toggleMapOverview(): void {
  if (!mapMode || !floor) return;
  mapOverview = !mapOverview;
  layoutMapView(); // cell/cols/rows を計算し直し、@ 中心へ再センタリング
  drawMapMode();
  updateOverviewBtn();
}
function drawMapMode() {
  if (!floor) return;
  lightEl.style.display = "none"; // 松明の減光を外す
  hidePeek();
  const W = floor.w, H = floor.h;
  if (cells.length !== mapCols * mapRows || mapCols === 0) layoutMapView(); // 防御：ビューポートとグリッドが食い違うなら組み直す
  // 経路プレビュー（v0.99.0）：照準までの bfsPath を金泥の点で描く（照準・自分のマスは除く）
  const pathIdx = new Set<number>();
  if (aim && aimPath) for (const p of aimPath) pathIdx.add(p.y * W + p.x);
  for (let vy = 0; vy < mapRows; vy++) for (let vx = 0; vx < mapCols; vx++) {
    const x = mapCam.x + vx, y = mapCam.y + vy;
    const c = cells[vy * mapCols + vx], span = c.firstChild as HTMLElement;
    c.classList.remove("tele-atk", "tele-move", "wall");
    c.style.filter = "brightness(1)";
    if (x >= W || y >= H) { span.textContent = ""; c.style.background = MAP_BG.unexplored; continue; } // カメラ窓がフロア端を超えた余白
    const i = y * W + x; // = mapIdx(floor, x, y)
    if (!floor.explored[i]) { span.textContent = ""; c.style.background = MAP_BG.unexplored; continue; }
    const isFloor = floor.tiles[i] === 1;
    let bg: string = isFloor ? MAP_BG.floor : MAP_BG.wall; // 床=明るい / 壁=暗い
    let glyph = "", cls = "";
    if (pathIdx.has(i)) { bg = MAP_BG.path; glyph = "·"; cls = "g-aimpath"; } // 経路の点（地物があれば下で上書き）
    if (x === floor.stairsDown.x && y === floor.stairsDown.y) { bg = MAP_BG.stairs; glyph = "›"; cls = "g-down"; }
    else if (x === floor.stairsUp.x && y === floor.stairsUp.y) { bg = MAP_BG.stairs; glyph = "‹"; cls = "g-up"; }
    const shrM = floor.shrines.find((s) => s.x === x && s.y === y);
    if (shrM) { bg = shrM.kind === "spring" ? MAP_BG.spring : MAP_BG.rest; glyph = shrM.kind === "spring" ? "泉" : "安"; cls = shrM.kind === "spring" ? "g-spring" : "g-rest"; }
    if (floor.returnDoor && floor.returnDoor.x === x && floor.returnDoor.y === y) { bg = MAP_BG.door; glyph = "扉"; cls = "g-door"; }
    if (floor.aurelSite && floor.aurelSite.x === x && floor.aurelSite.y === y) { bg = MAP_BG.door; glyph = floor.aurelSite.kind === "mark" ? "痕" : "境"; cls = floor.aurelSite.kind === "mark" ? "g-aurel" : "g-laila"; } // メインの縦糸（4-15）
    const fe = floor.fossils.find((e) => e.x === x && e.y === y);
    if (fe) { bg = fe.resolved ? MAP_BG.fossilQuiet : MAP_BG.fossil; glyph = "†"; cls = fe.resolved ? "g-fossil-quiet" : "g-fossil"; } // 未対面は一段明るく
    if (floor.chests.some((cc) => cc.x === x && cc.y === y && !cc.opened)) { bg = MAP_BG.chest; glyph = "▭"; cls = "g-chest"; }
    if (x === player.x && y === player.y) { bg = MAP_BG.player; glyph = "@"; cls = "g-player"; }
    if (aim && x === aim.x && y === aim.y) { // 照準マーカー（到達可=緑／不可=赤）。タイルより前面に上書き
      bg = aimReachable ? MAP_BG.aimOk : MAP_BG.aimNg; glyph = "⊕"; cls = "g-aim";
    }
    c.style.background = bg;
    span.textContent = glyph;
    span.className = cls;
  }
  updateStatus();
}

/** 地図/照準の持ち越しを断つ（描画はしない＝呼び出し側が buildGridDom＋draw を担う）。
 *  地図モードのグリッドは floor.w×floor.h で組まれるため、フロア遷移や街復帰で mapMode を残したまま
 *  VIEW サイズのグリッドに描くと drawMapMode が範囲外セルの firstChild を読んでクラッシュする（enterRaid と同じ規約）。 */
function resetMapView(): void {
  mapMode = false;
  mapCols = 0; mapRows = 0;
  mapOverview = false;
  aim = null; aimPath = null;
  $("aimBar").hidden = true;
  $("mapLegend").hidden = true;
  $("mapOverviewBtn").hidden = true;
}
function setMapMode(v: boolean) {
  mapMode = v;
  if (!v && aim) { aim = null; aimPath = null; $("aimBar").hidden = true; } // 地図を閉じたら照準も解除
  if (v) mapOverview = false; // 開くたびに既定＝読めるサイズ+パン（「全体図」ボタンで全体表示に切替）
  $("mapLegend").hidden = !v; // 凡例は地図モード中のみ（地図の外＝下の行・v0.109.0）
  $("mapOverviewBtn").hidden = !v; // 全体図トグルは地図モード中のみ
  updateOverviewBtn();
  hidePeek();
  // 地図↔プレイでグリッド寸法が変わるので組み直す（プレイ=VIEW／地図=読めるサイズのカメラ窓）
  if (v && floor) { layoutMapView(); drawMapMode(); }
  else { mapCols = 0; mapRows = 0; buildGridDom(VIEW_W, VIEW_H); draw(); }
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
  // 街ヴィネット（v0.99.0・§10.4）：全面可視は保ちつつ、柔らかい暖光で「灯る街」の空気を出す（何も隠さない）。
  // 深度帯の松明色クラス（band-*）は迷宮専用＝街では必ず外す（深淵帯から生還/死亡で菫ヴィネットが街に残らないように）。
  $("mapWrap").classList.remove("band-mid", "band-deep", "band-abyss");
  lightEl.style.display = ""; lightEl.classList.add("town");
  lightEl.style.setProperty("--px", ((townPlayer.x - camX + 0.5) / VW * 100) + "%");
  lightEl.style.setProperty("--py", ((townPlayer.y - camY + 0.5) / VH * 100) + "%");
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
      else if (a.regular) { const ck = kinds[a.kind]; glyph = ck.glyph; color = "#9fe6b0"; shadow = "0 0 11px #9fe6b0cc"; } // 馴染みの常連＝生者の緑系で明るく（街差分）
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

// ---------- 常連の入れ替わり（街差分・4-4/4-6C・Web限定・engine無改修・2026-06-22 ユーザー承認）----------
// 縁を結んだ生者NPC（world.actors＝bond/plant/arc で referenced→rememberActor された者）が、
// 酒場/ギルドの常連として現れる。直近に出会った顔が新常連になり、古い顔は世代で「卒業」して消える。
// → delver/遭遇で出会う → 街で常連として再会 → やがて去る、の堆積が街に滲む。
const REGULAR_SLOTS = 2;   // 1屋内あたり常連で埋める席（残りは随時の顔に残す）
const REGULAR_TENURE = 4;  // 何世代いれば「卒業」して街から去るか
/** 生者NPCを酒場/ギルドのどちらの常連にするか（id で安定割り当て＝同じ顔は同じ店に通う）。 */
function regularVenue(id: string): "tavern" | "guild" {
  let h = 0; for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) | 0;
  return (h & 1) ? "guild" : "tavern";
}
/** その屋内に現れる常連（直近に出会った顔・最大 REGULAR_SLOTS・世代で卒業）。 */
function townRegularsFor(kind: string): LivingActor[] {
  if (kind !== "tavern" && kind !== "guild") return [];
  const gen = world.generation;
  return (world.actors ?? [])
    .filter((a) => gen - (a.metGeneration ?? gen) < REGULAR_TENURE) // 在籍中（卒業前）のみ
    .filter((a) => regularVenue(a.id) === kind)
    .sort((a, b) => (b.metGeneration ?? 0) - (a.metGeneration ?? 0) || (a.id < b.id ? -1 : 1)) // 直近の顔を優先
    .slice(0, REGULAR_SLOTS);
}

function enterBuilding(kind: string, restore = false) {
  if (kind === "home" && !world.homeUnlocked && !restore) { // 自宅は銀昇格で「倒れた冒険者の家を継ぐ」まで施錠（4-10C）
    log("鍵のかかった空き家だ。今はまだ、お前の住まいではない。", "dim");
    return;
  }
  if (!restore) townReturn = { ...townPlayer };
  interior = buildInterior(kind, townGrid.data);
  // 馴染みの常連を patron 席へ注入（refresh* と同じ web 注入パターン・engine 無改修）。
  const regs = townRegularsFor(kind);
  const patronSlots = interior.actors.filter((a) => a.role === "patron");
  for (let i = 0; i < regs.length && i < patronSlots.length; i++) {
    patronSlots[i].npc = regs[i]; patronSlots[i].regular = true; patronSlots[i].bgLine = undefined;
  }
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
  // 運命の弧（4-6C）：又聞きで「目を離した隙に世界が動いた」を拾わせる。進行した tracked を優先。
  const arcPool = world.tracked.filter((t) => (t.beat ?? 0) >= 1);
  if (arcPool.length && rng.next() < 0.5) {
    const t = rng.pick(arcPool);
    await sheet({ text: `酒場の喧噪のなか、誰かが言う──\n\n${renderArcBeat(db, rng, t)}`, options: ["席を立つ"] });
    chronicle(world, "rumor", `酒場で${t.name}の行く末が囁かれる。`, [t.id]);
    save();
    busy = false;
    return;
  }
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
  const entries = world.chronicle.slice(-14).reverse(); // 新しい順（読みやすさ・#300 と揃える）
  const rows: SheetRow[] = entries.length
    ? entries.map((e) => ({ text: `〔${mark[e.kind]}〕第${e.generation}世代　${e.text}` }))
    : [{ text: "まだ何も記されていない。", dim: true }];
  await sheet({ sections: [{ rows }], meta: `年代記 ── 全${world.chronicle.length}件`, options: ["頁を閉じる"] });
  busy = false;
}
// 書記の館「拾得品を読み返す」：迷宮で拾った詩情系の品＝読み物コレクション（世代を越えて堆積）。
async function keepsakeShelf() {
  busy = true;
  const total = KEEPSAKES.length;
  for (;;) {
    const list = world.keepsakes ?? [];
    if (!list.length) {
      await sheet({ text: `「わたしは年代記だけでなく、深みが遺したものも蒐めている――送られなかった手紙、失われた者の玩具、誰も読まぬ書物。みな、弔う者のない記憶だ」。\n老書記イェンは空の棚を撫でた。「君が深みで拾った品も、街へ持ち帰れば、ここへ加えよう。今はまだ、棚は空だが」。\n――迷宮の宝箱で見つけた詩情ある品が、ここに並ぶ（全${total}種を集められる）。`, meta: "書記の館 ── 好古の棚", options: ["わかった"] });
      break;
    }
    // 本文・題はプール（keepsakes.json）から id で解決。旧セーブの未知idは保持した title でフォールバック。
    const resolve = (k: { id: string; title?: string }) => KEEPSAKE_BY_ID.get(k.id) ?? null;
    const r = await sheet({
      text: `老書記イェンが蒐集の棚を示す。「君が深みから持ち帰り、わたしに託していった品々だ。弔う者なき記憶は、ここで預かる。どれでも、語って聞かせよう」。`,
      meta: `書記の館 ── 好古の棚（${list.length}／${total}種）`,
      options: [...list.map((k) => `${resolve(k)?.title ?? k.title ?? "失われた品"}（第${k.gen}世代・深度${k.depth}）`), "棚を離れる"],
    });
    const i = r.pick - 1;
    if (i < 0 || i >= list.length) break;
    const k = list[i];
    const def = resolve(k);
    const story = def?.story ?? "この品の詳しい記録は、もう失われてしまった。";
    const title = def?.title ?? k.title ?? "失われた品";
    await sheet({ text: story, meta: `好古の棚 ── ${title}（第${k.gen}世代・深度${k.depth}で発見）`, options: ["棚に戻す"] });
  }
  busy = false;
}
// 酒場 act1「旧き名・化石のことを尋ねる」：縁ある名（伝説/宿敵=tracked／絆ある化石）を選んで素性・末路・弧を聞く。
// act0 rumorScene（ランダムな噂）と差別化＝「特定の名を尋ねる」。新規 content 不要（既存 render を再利用）。
async function tavernLore() {
  busy = true;
  type Cand = { label: string; tracked?: World["tracked"][number]; fossil?: Fossil };
  const cands: Cand[] = [];
  const seen = new Set<string>();
  for (const t of world.tracked) { // 伝説・宿敵・弧（プレイヤーが残した名）を優先
    if (seen.has(t.name)) continue; seen.add(t.name);
    cands.push({ label: t.name, tracked: t });
  }
  for (const f of world.fossils) { // 縁ある化石（絆 or 旧キャラ）
    if (!(f.bondAtDeath > 0 || f.kind === "character")) continue;
    if (seen.has(f.origin.name)) continue; seen.add(f.origin.name);
    cands.push({ label: f.origin.name, fossil: f });
  }
  if (!cands.length) {
    await sheet({ text: "「旧い名か。……お前にはまだ、尋ねるほど深い縁の名がないようだ」と女将は笑った。", meta: "酒場 ── 旧き名を尋ねる", options: ["わかった"] });
    busy = false; return;
  }
  const pool = cands.slice(0, 6);
  const r = await sheet({
    text: "「誰のことが知りたい？　名のある者なら、酔客の誰かが何か覚えている」。",
    meta: "酒場 ── 旧き名を尋ねる",
    options: [...pool.map((c) => c.label), "やめる"],
  });
  const i = r.pick - 1;
  busy = false;
  if (i < 0 || i >= pool.length) return;
  const c = pool[i];
  const tale = c.tracked ? renderArcBeat(db, rng, c.tracked) : renderRumor(db, rng, c.fossil!);
  busy = true;
  await sheet({ text: `女将が古い客に水を向ける──\n\n${tale}`, meta: `酒場 ── ${c.label}`, options: ["席を立つ"] });
  chronicle(world, "rumor", `酒場で${c.label}の来し方が語られた。`, c.tracked ? [c.tracked.id] : [c.fossil!.id]);
  save();
  busy = false;
}
// 酒場 act2「休む（一杯やる）」：英気を養う小休息。1世代1回だけ深蝕がわずかに退く（shrinePray と同方式・gated）。
async function tavernRest() {
  busy = true;
  const ch = world.current!;
  if (ch.restedTavernGen === world.generation) {
    await sheet({ text: "「もう十分やっただろう。残りは、還ってからの楽しみに取っておきな」。女将は次の客へ向き直った。", meta: "酒場 ── 休む", options: ["わかった"] });
    busy = false; return;
  }
  ch.restedTavernGen = world.generation;
  const before = ch.exposure;
  ch.exposure = Math.max(0, ch.exposure - 0.05);
  sfx("heal");
  const note = ch.exposure < before ? `\n張りつめた芯が、ほんの少しほどけた（深蝕 -${(before - ch.exposure).toFixed(2)}）。` : "";
  await sheet({ text: `安酒を一杯。喧噪と温もりが、深みの冷たさを束の間だけ忘れさせる。${note}`, meta: "酒場 ── 休む（一杯やる）", options: ["席を立つ"] });
  save();
  busy = false;
}
// ── 酒場の4役割（2026-07-02 酒場リワーク・PR2）：仕事の貼り紙＝questBoard("tavern")／門出の一杯／勧誘／裏取引 ──
const SENDOFF_TURNS = 10; // 門出の一杯：次の潜行の最初のフロアに乗る手数（enterFloor のバフリセット後に startDive が適用）
/** 酒場 act4「門出の一杯」：金貨で次の潜行1回の小バフ（武勇＝攻/加護＝防）。1潜行1回（pending 保持中は再購入不可）。 */
async function tavernSendoff() {
  busy = true;
  const ch = world.current!;
  if (ch.pendingDiveBuff) {
    await sheet({ text: "「もう注いだろう。効き目は、次に潜るまで取っておきな」。杯はまだ、卓で香りを立てている。", meta: "酒場 ── 門出の一杯", options: ["わかった"] });
    busy = false; return;
  }
  const price = 12 + curLevel(); // 安めの gold sink（レベル比例＝終盤も無意味にならない）
  const r = await sheet({
    text: `女将マレンが二つの瓶を掲げる。「出立の景気づけだ。どっちにする？」\n・武勇の一杯＝潜行の出だし、腕が冴える（近接+${ATTACK_BUFF}・${SENDOFF_TURNS}手）\n・加護の一杯＝潜行の出だし、体が守られる（被ダメ−${ARMOR_BUFF}・${SENDOFF_TURNS}手）\n（${price}金貨・次の潜行の最初のフロアで効く・1潜行1回）　所持 金${ch.gold}`,
    meta: "酒場 ── 門出の一杯（出立の景気づけ）",
    options: [`武勇の一杯（${price}金貨）`, `加護の一杯（${price}金貨）`, "やめておく"],
  });
  busy = false;
  if (r.pick !== 1 && r.pick !== 2) return;
  if (ch.gold < price) { log("金貨が足りない。", "warn"); return; }
  ch.gold -= price;
  ch.pendingDiveBuff = r.pick === 1 ? { atk: true, turns: SENDOFF_TURNS } : { arm: true, turns: SENDOFF_TURNS };
  sfx("consume");
  log(`${r.pick === 1 ? "武勇" : "加護"}の一杯を干した。喉が熱い──次の潜行の出だしに効いてくる（−${price}金貨／所持 ${ch.gold}）。`, "cue");
  save();
}
/** 酒場 act5「相棒を探す（一杯おごる）」：勧誘・再雇用の明示的な場。常連（縁ある生者）を優先し、いなければ新顔。 */
async function tavernRecruit() {
  busy = true;
  const ch = world.current!;
  if (world.companion?.alive) {
    await sheet({ text: `${companionName()}が隣で杯を傾けている。「おいおい、俺がいるだろう」。\n（相棒の詳細・解散は、ステータスの「相棒を見る」から）`, meta: "酒場 ── 相棒を探す", options: ["そうだった"] });
    busy = false; return;
  }
  // 候補＝酒場の常連（縁ある生者・再雇用の蓄積つき）を優先＋一見の顔（meetActor＝既知/名簿/新規）。
  const seen = new Set<string>();
  const candidates: LivingActor[] = [];
  for (const la of townRegularsFor("tavern")) { if (!seen.has(la.id)) { seen.add(la.id); candidates.push(la); } }
  const extra = meetActor(world, db, rng);
  if (!seen.has(extra.id)) candidates.push(extra);
  if (!candidates.length) {
    await sheet({ text: "今夜は、これという顔ぶれがいない。", meta: "酒場 ── 相棒を探す", options: ["席を立つ"] });
    busy = false; return;
  }
  const r = await sheet({
    text: `一杯おごって、同行を持ちかけるなら──\n（前金＝等級と自分のレベルに応じて。道中の金貨は折半）`,
    meta: "酒場 ── 相棒を探す（一杯おごる）",
    options: [...candidates.map((la) => `${GRADE_LABELS[hireGradeOf(la)]}の${la.actor.epithet ?? ""}${la.actor.name}（${la.actor.archetype}）に持ちかける`), "やめる"],
  });
  busy = false;
  const i = r.pick - 1;
  if (i < 0 || i >= candidates.length) return;
  await offerCompanion(candidates[i]); // 既存の勧誘フロー（格ゲート・前金・折半）をそのまま流用
}
// 【裏取引は廃止（2026-07-03）】酒場の武具取引を機能削除。秘宝は「深層レアドロップ＋統治者の大命の褒賞」で入手。
// 酒場は 噂／旧き名／休む／仕事の貼り紙／門出の一杯／相棒を探す の6機能で成立（武具取引なしで店として十分）。
// 薬師 act0「傷を癒す」：街に戻れば傷は既に塞がっている（4-10C）。基本は flavor、念のため HP を満たす。
async function healerHeal() {
  busy = true;
  const ch = world.current!;
  const max = maxHp(ch);
  if (hp < max) { hp = max; sfx("heal"); updateStatus(); }
  await sheet({
    text: "老薬師トウはお前の脈をとり、傷痕を一瞥して頷いた。「その傷は、街に戻った時にはもう塞がっている。お前を蝕むのは、肉ではなく深みのほうだ」。",
    meta: "薬師 ── 傷を癒す", options: ["わかった"],
  });
  busy = false;
}
// 薬師 act2「薬を買う」：医薬（鎮静/治癒の消耗品）は薬師の本領。道具屋と品目は重なるが lore 的な本元。
async function healerBuy() {
  busy = true;
  const ch = world.current!;
  for (;;) {
    const stock = CONSUMABLES.filter((c) => (c.minLevel ?? 0) <= ch.level); // 上位品は等級で解禁
    const r = await sheet({
      text: `老薬師トウの調剤棚。所持 金${ch.gold}。\n持ち物 ${packUsed(ch)}/${packCapacity(ch)} 枠。`,
      meta: "薬師 ── 薬を買う",
      options: [...stock.map((c) => `${c.name}（${c.desc}）${c.price}金貨`), "やめる"],
    });
    const i = r.pick - 1;
    if (i < 0 || i >= stock.length) break;
    const c = stock[i];
    if (ch.gold < c.price) { await sheet({ text: "金貨が足りない。", options: ["出直す"] }); continue; }
    if (!addConsumable(ch, c.key)) { await sheet({ text: "持ち物が一杯だ。レベルが上がれば、持てる量も増える。", options: ["わかった"] }); continue; }
    ch.gold -= c.price; sfx("buy");
    log(`${c.name} を薬師から求めた（−${c.price}金貨／所持 ${ch.gold}）。`);
    save();
  }
  busy = false;
}
// 回収業ギルド：依頼の受注・達成報酬の受領（4-10G）。1操作＝受注 or 受領（再入場で続けられる）。
const TAVERN_BOARD_SIZE = 3; // 酒場の貼り紙の掲示枠（ギルドより小さめ＝裏仕事の口）
const PLUNDER_EXPOSURE = 0.4;      // 盗掘の冒涜の代償＝死者を暴いた深蝕（シビア寄り＝毎回課す）。テスト調整候補。
const CONTRABAND_EXPOSURE = 0.08;  // 密売＝呪物1点ごとに移る深蝕（受取＝納品時に need 点ぶん）。テスト調整候補。
// 依頼板（ギルド/酒場/謁見）＝カード一覧→タップで受取/受注／受注中は詳細（#300 と同型の二層UI・文字羅列FB対応）。
// 状態を色分けglyphで区別：受取可＝✓（緑・報酬は金）／受注可＝標準／受注中＝◦（淡・情報カード）。engine 非改変・golden 不変。
async function questBoard(board: "guild" | "noble" | "tavern" = "guild") {
  busy = true;
  const ch = world.current!;
  // fetch（納品）／contraband（密売）：袋に必要点数が揃った active を done に昇格（受取時に消費）。開板時に一度判定。
  //   fetch＝指定スロットの武具/遺物／contraband＝未鑑定の異物（呪物）。predicate だけ違う同型。
  for (const q of activeQuests(world)) {
    if ((q.kind === "fetch" || q.kind === "contraband") &&
      (ch.gearBag ?? []).filter((it) => questItemMatch(q, it)).length >= (q.need ?? 1)) q.status = "done";
  }
  // 掲示は開板時に一度だけ生成（rng を消費するため・タップごとに引き直さない）。受注済みは taken で表示から除く。
  // 謁見の間（noble）＝統治者の大命のみ。ギルド（guild）＝多様な依頼を盤面 size まで掲示＋（noble_ack 後は）大命も相乗り。
  // 酒場（tavern）＝人に接地した裏仕事（bounty/rescue/escort/fetch）を小さめの貼り紙で（第2の依頼源・2026-07-02）。
  const offers = board === "noble"
    ? generateNobleOffers(world, ch, rng, 1)
    : board === "tavern"
      ? generateOffers(world, ch, rng, TAVERN_BOARD_SIZE, guildOfferOpts("tavern"))
      : (() => { const o = generateOffers(world, ch, rng, GUILD_BOARD_SIZE, guildOfferOpts());
          if (getArc(world, "noble_ack")) o.push(...generateNobleOffers(world, ch, rng, 1)); return o; })();
  const taken = new Set<string>(); // 受注済みの掲示 id（表示から除く）
  // 受取は発注元で（分業に忠実・issue8・ユーザー承認）：達成済の受領は掲示元 board でのみ。eventsScreen の claimAt と整合。
  const boardDone = () => doneQuests(world).filter((q) =>
    board === "noble" ? q.patron === "noble"
      : board === "tavern" ? q.source === "tavern"
      : q.patron !== "noble" && q.source !== "tavern");
  // 受取（達成済）：報酬・秘宝・折半・年代記の処理は従来どおり（見た目だけ改善）。
  const claimRun = (q: Quest) => {
    if (q.kind === "fetch" || q.kind === "contraband") { // 納品/密売：受取時に袋から need 点（安い順）を渡す。売却済み等で足りなければ差し戻す。
      const bag = ch.gearBag ?? [];
      const matches = bag.filter((it) => questItemMatch(q, it)).sort((a, b) => itemValue(a) - itemValue(b));
      if (matches.length < (q.need ?? 1)) { q.status = "active"; log("納める品が足りない。もう一度深みで見つけてこよう。", "warn"); return; }
      for (let n = 0; n < (q.need ?? 1); n++) { const it = matches.shift()!; const idx = bag.indexOf(it); if (idx >= 0) bag.splice(idx, 1); }
      dedupeGearBag(ch);
      if (q.kind === "contraband") { // 密売＝呪物を運んだ代償の深蝕（need 点ぶん・鑑定せず引き取らせた報い）
        addExp(CONTRABAND_EXPOSURE * (q.need ?? 1));
        log(`故買屋は品を検めもせず銅貨を寄越した。運んだ呪物の澱が、少し移った（深蝕＋${(CONTRABAND_EXPOSURE * (q.need ?? 1)).toFixed(2)}）。`, "warn");
      }
    }
    const gross = claimQuest(world, ch, q.id); // claimQuest が満額を加算済み
    const cut = world.companion?.alive ? companionCut(gross) : 0; // 同行中は依頼報酬も折半（4-14C）
    if (cut > 0) { ch.gold -= cut; log(`${companionName()}が取り分として ${cut}金貨を受け取った（折半）。`, "dim"); }
    const from = q.source === "tavern" ? "酒場の店主" : q.patron === "noble" ? "貴族の使い" : "ギルド長";
    sfx("coin"); log(`${from}から報酬を受け取った（＋${gross - cut}金貨／所持 ${ch.gold}）。`);
    chronicle(world, "legend", `${ch.name}が${q.patron === "noble" ? "貴族街の大命" : "依頼"}「${q.title}」を果たした。`, [ch.id]);
    // 高難度大命の固有報酬（4-14G→2026-07-03）：秘宝を1点授与＝終盤の入手経路＋一度きりの称号。
    if (q.rewardRelic) {
      const art = rollArtifact(Math.max(ARTIFACT_MIN_DEPTH, q.targetDepth ?? ABYSS_DEPTH));
      if (art) {
        ch.gearBag ??= []; ch.gearBag.push(art); dedupeGearBag(ch);
        sfx("seal"); log(`統治者より秘宝「${itemLabel(art)}」を賜った（袋へ）。`, "cue");
        if (!ch.traits.includes("統治者の覇者")) ch.traits.push("統治者の覇者");
      }
    }
  };
  // 受注（掲示）：受注上限・護衛特例は従来どおり。受注できたら true。
  const acceptRun = (q: Quest): boolean => {
    const activeGuild = activeQuests(world).filter((qq) => qq.patron !== "noble").length; // noble 除く同時受注数
    if (q.patron !== "noble" && activeGuild >= GUILD_ACTIVE_CAP) { // 大命は別枠。通常依頼は同時受注上限まで
      log(`受注が一杯だ（${activeGuild}/${GUILD_ACTIVE_CAP}）。ひとつ果たしてから受けよう。`, "warn"); return false;
    }
    if (q.kind === "escort") { // 護衛＝依頼人が相棒スロットに入って同行（到達で離脱／死・解散で失敗）
      if (world.companion?.alive) { log("相棒と同行中は、護衛の依頼は受けられない。", "warn"); return false; }
      const client = escortCandidate ?? mintActor(db, rng, {}, fossilNames(world));
      const la: LivingActor = { id: `escort_${q.id}`, actor: client, metGeneration: world.generation };
      recruitCompanion(la);
      if (world.companion) world.companion.escortQuestId = q.id;
      log(`依頼人${client.name}が支度を整えた。「深度${q.targetDepth}まで、頼む。路銀は道中折半で」。`, "cue");
    }
    acceptQuest(world, q); log(`依頼を受けた：「${q.title}」。`, "dim");
    return true;
  };
  // 受注中カードのタップ＝条件・報酬・受取場所を構造化行で見せる情報詳細（手番非消費）。
  const activeDetail = async (q: Quest) => {
    const claimAt = q.patron === "noble" ? "謁見の間" : q.source === "tavern" ? "酒場" : "ギルド";
    await sheet({
      text: q.desc ?? "",
      meta: `受注中 ── ${q.title}`,
      sections: [{ rows: [
        { text: questConditionLine(q) },
        { label: "報酬", value: `${q.rewardGold}金貨${q.rewardRelic ? "＋秘宝" : ""}` },
        { label: "受取", value: `${claimAt}で` },
      ] }],
      options: ["戻る"],
    });
  };
  const meta = board === "noble" ? "謁見の間 ── 統治者の大命" : board === "tavern" ? "酒場 ── 仕事の貼り紙" : "ギルド ── 依頼（回収業）";
  const introOf = () => board === "noble"
    ? `玉座の間。統治者が、奉献を成した者にのみ託す大命。所持 金${ch.gold}。`
    : board === "tavern"
      ? `酒場の柱に貼られた、雑多な頼み事。女将マレンが顎で示す。「困ってる連中の口さ。堅いのはギルドで聞きな」。所持 金${ch.gold}。`
      : `ギルドの詰所。依頼の貼り札が壁一面にひしめく。所持 金${ch.gold}。`;
  type Entry = { kind: "claim" | "offer" | "active"; q: Quest };
  for (;;) {
    const done = boardDone();
    const act = activeQuests(world).filter((q) =>
      board === "noble" ? q.patron === "noble"
        : board === "tavern" ? q.source === "tavern"
        : q.patron !== "noble" && q.source !== "tavern");
    const entries: Entry[] = [
      ...done.map((q): Entry => ({ kind: "claim", q })),
      ...offers.filter((q) => !taken.has(q.id)).map((q): Entry => ({ kind: "offer", q })),
      ...act.map((q): Entry => ({ kind: "active", q })),
    ];
    const cells = entries.map((e) => {
      if (e.kind === "claim") return { html:
        `<div class="nm"><span style="color:#8fce9b">✓</span>　${e.q.title}</div>`
        + `<div class="sub" style="color:#ffd87a">報酬を受け取る　＋${e.q.rewardGold}金貨${e.q.rewardRelic ? "＋秘宝" : ""}</div>` };
      if (e.kind === "offer") return { html:
        `<div class="nm">${e.q.title}</div>`
        + `<div class="sub">${questConditionLine(e.q)}　／　報酬 ${e.q.rewardGold}金貨${e.q.rewardRelic ? "＋秘宝" : ""}</div>` };
      return { html: // 受注中（情報・受注可/受取可と一目で区別＝題を淡く＋◦と「受注中」を移色のティール accent に）
        `<div class="nm" style="color:var(--tx-dim)"><span style="color:var(--c-mov)">◦</span>　${e.q.title}<span style="color:var(--c-mov);font-weight:400;font-size:12px"> ── 受注中</span></div>`
        + `<div class="sub">${questConditionLine(e.q)}</div>` };
    });
    const lead = introOf() + (entries.length ? "" : board === "noble" ? "\n（受注中の大命はない）" : "\n（今は頼み事がない）");
    const idx = await chooseGrid({ title: meta, lead, cells, cancel: "やめる", cols: 1 });
    if (idx < 0 || idx >= entries.length) break;
    const e = entries[idx];
    if (e.kind === "claim") { claimRun(e.q); save(); }
    else if (e.kind === "offer") { if (acceptRun(e.q)) { taken.add(e.q.id); save(); } }
    else await activeDetail(e.q);
  }
  busy = false;
}
// 武具屋 売る：袋の未装備装備を確実・高値（itemValue×0.6）で買い取る。
const APPRAISE_MUL = 0.4; // 鑑定料＝鑑定後価値の4割（拾い得を残しつつ、装備で賭けるより安全な対価）
/** 奇物堂（古物商クオ）：拾った未鑑定品（gearBag）を料金を払って鑑定する＝装備せずに正体を明かす。 */
async function appraiseShop() {
  const ch = world.current!;
  dedupeGearBag(ch); // 防御：袋の参照重複を除いてから
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
    ch.gold -= cost; it.unidentified = false; sfx("buy");
    log(`鑑定した――《${it.name}》。${itemPower(it)}（鑑定料 ${cost}／所持 ${ch.gold}）。`, "warn");
    save();
  }
}

// 奇物堂 act1「奇妙な異物を買う」：未鑑定の品を一律料金で買う賭け（当たり＝強い異物／外れ＝凡品）。
// 中身を値で悟らせないため価格は一律。買った品は袋へ＝鑑定(act0)するか装備すれば正体が分かる。
async function oddmentsBuy() {
  busy = true;
  const ch = world.current!;
  const tier = Math.max(4, ch.level + 1);
  const stock = [rollItem(tier, rng, { boss: true }), rollItem(tier, rng, { boss: true }), rollItem(tier, rng, { boss: true })];
  for (const it of stock) it.unidentified = true; // 奇物堂の品は必ず未鑑定（賭け）
  const price = 14 + tier * 3; // 一律＝中身（異物か凡品か）を値段から読ませない
  if (packUsed(ch) >= packCapacity(ch)) {
    await sheet({ text: "クオは布を畳む。「荷物がいっぱいだろう。先に整理しておいで」。", meta: "奇物堂 ── 異物を買う", options: ["わかった"] });
    busy = false; return;
  }
  const r = await sheet({
    text: `クオは埃をかぶった布をめくる。「曰くつきの品ばかりさ……当たりも、外れもある。鑑定はせん。買ってから、己で確かめな」。\n所持 金${ch.gold}。どれも一律 ${price}金。`,
    meta: "奇物堂 ── 異物を買う（未鑑定の賭け）",
    options: [...stock.map((it) => `見知らぬ${SLOT_LABEL[it.slot]}（未鑑定）／${price}金`), "やめる"],
  });
  busy = false;
  const i = r.pick - 1;
  if (i < 0 || i >= stock.length) return;
  if (ch.gold < price) { busy = true; await sheet({ text: "金貨が足りない。", options: ["出直す"] }); busy = false; return; }
  ch.gold -= price; sfx("buy");
  busy = true;
  await gearBagPush(stock[i]); // 袋へ（容量は事前確認済み＝必ず入る）
  busy = false;
  log(`見知らぬ${SLOT_LABEL[stock[i].slot]}を買った（−${price}金／所持 ${ch.gold}）。正体は鑑定するか、装備すれば分かる。`, "warn");
  save();
}
// 奇物堂 act2「品の曰くを聞く」：異物＝この世界唯一の輸出品（4-3③）の由来を語る flavor。
async function oddmentsLore() {
  busy = true;
  await sheet({
    text: "クオは昏い護符を指先で回す。\n「異物ってのはね、深みが人の業を写し取って固めたものさ。地上じゃ二つとない――だから物好きが高く買う。\nだが身につければ、向こうもこちらを少しずつ写し取る。深蝕ってのは、その代価だよ」。",
    meta: "奇物堂 ── 品の曰く", options: ["耳を傾ける"],
  });
  busy = false;
}

/** 装備の誤売防止：手放す前に必ず確認を挟む（テストプレイFB「間違って売らないように」）。売る＝true。
 *  busy は呼び出し側のロックを保ったまま確認する（false に落とすと開いたシートの裏で盤面が動き再入＝誤売バグの原因）。 */
async function confirmSellGear(it: Item, gross: number): Promise<boolean> {
  const prevBusy = busy; busy = true;
  const detail = it.unidentified ? "未鑑定（正体不明のまま手放す）" : itemPower(it);
  const r = await sheet({
    text: `《${it.name}》／${SLOT_LABEL[it.slot]}\n${detail}\n\nこれを ＋${gross}金貨 で手放す。よろしいか？`,
    meta: "確認 ── 装備を売る",
    options: ["売る", "やめる"],
  });
  busy = prevBusy;
  return r.pick === 1;
}

async function smithSell() {
  const ch = world.current!;
  dedupeGearBag(ch); // 防御：袋の参照重複を除いてから売り出す
  for (;;) {
    const bag = ch.gearBag ?? [];
    if (!bag.length) { busy = true; await sheet({ text: "袋に売れる拾い物がない。迷宮で集めておいで。", options: ["わかった"] }); busy = false; break; }
    busy = true;
    const r = await sheet({
      text: `武具屋の主が目利きする。所持 金${ch.gold}。\n袋 ${bag.length} 点。何を売る？（武器・防具どちらも引き取る）`,
      meta: "武具屋 ── 売る（高値）",
      options: [...bag.map((it) => `${itemLabel(it)}／${SLOT_LABEL[it.slot]}（＋${sellGear(it, SMITH_SELL_MUL)}金貨）`), "やめる"],
    });
    busy = false;
    const i = r.pick - 1;
    if (i < 0 || i >= bag.length) break;
    const it = bag[i], gross = sellGear(it, SMITH_SELL_MUL);
    if (!(await confirmSellGear(it, gross))) continue; // 誤売防止＝確認で「売る」を選んだ時だけ手放す
    const idx = bag.indexOf(it); // 実体で除去（持っていない物を売れない）
    if (idx < 0) { log("その品は、もう袋にない。", "dim"); continue; }
    bag.splice(idx, 1);
    const val = splitGold(gross); // 同行中は売却益も折半（4-14C）
    ch.gold += val; sfx("sell");
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
    text: `${who}の${what}棚。所持 金${ch.gold}。\n買うと荷物に入る（装備は「装備・荷物を見る」から）。`,
    meta: `武具屋 ── ${what}を買う`,
    options: [...stock.map((it, i) => `${itemLabel(it)} ${prices[i]}金貨`), "やめる"],
  });
  busy = false;
  const i = r.pick - 1;
  if (i < 0 || i >= stock.length) return;
  const it = stock[i], price = prices[i];
  if (ch.gold < price) { busy = true; await sheet({ text: "金貨が足りない。", options: ["出直す"] }); busy = false; return; }
  if (packUsed(ch) >= packCapacity(ch)) { busy = true; await sheet({ text: `荷物がいっぱいだ（${packUsed(ch)}/${packCapacity(ch)}）。整理してから出直そう。`, options: ["わかった"] }); busy = false; return; }
  ch.gold -= price; it.unidentified = false; // 購入＝装備せず荷物へ（旧装備の消失バグ修正・2026-06-29）。鑑定済み。
  (ch.gearBag ??= []).push(it); dedupeGearBag(ch);
  sfx("buy");
  log(`${it.name} を買って荷物に入れた（−${price}金貨／所持 ${ch.gold}）。装備は「装備・荷物を見る」から。`);
  save();
}
// 武具屋 打ち直し（ルートシステム）：今装備中の武器/防具の強化度 +N を金貨で1段上げる（銘・基は不変）。
// 後半の金貨の使い道（gold sink）＋確実な伸びしろ＝終始シビアと相性。数値はテストプレイ調整候補。
const REFORGE_MAX = 9;
async function smithReforge() {
  busy = true;
  const ch = world.current!;
  const cost = (it: Item) => Math.round((15 + itemValue({ ...it, unidentified: false })) * (1 + (it.enchant ?? 0)));
  for (;;) {
    const eq = [ch.equipment.weapon, ch.equipment.armor].filter((it): it is Item => !!it);
    if (!eq.length) { await sheet({ text: "打ち直せる武器・防具を身につけていない。", options: ["わかった"] }); break; }
    const optLabel = (it: Item) => (it.enchant ?? 0) >= REFORGE_MAX
      ? `${it.name}（+${REFORGE_MAX} これ以上は鍛えられない）`
      : `${it.name} → +${(it.enchant ?? 0) + 1}（${cost(it)}金貨）`;
    const r = await sheet({
      text: `鍛冶ヴァロが鎚を構える。「打ち直しゃ、刃も鎧も冴えるぜ。…銘はそのまま、地金を鍛え直すだけだ」。\n所持 金${ch.gold}。`,
      meta: "武具屋 ── 打ち直し（+N を上げる）",
      options: [...eq.map(optLabel), "やめる"],
    });
    const i = r.pick - 1;
    if (i < 0 || i >= eq.length) break;
    const it = eq[i];
    if ((it.enchant ?? 0) >= REFORGE_MAX) { await sheet({ text: "これ以上は鍛えられない。", options: ["なるほど"] }); continue; }
    const price = cost(it);
    if (ch.gold < price) { await sheet({ text: "金貨が足りない。", options: ["出直す"] }); continue; }
    const up = enchantUp(it);
    if (!up) { await sheet({ text: "この品は打ち直せない（素性が分からない）。", options: ["わかった"] }); continue; }
    ch.gold -= price; up.unidentified = false; ch.equipment[up.slot] = up;
    sfx("equip");
    log(`${it.name} を打ち直した――《${up.name}》（${itemPower(up)}・−${price}金貨／所持 ${ch.gold}）。`);
    save();
  }
  busy = false;
}
// 武具屋 act2「先代の刻印武器について訊く」：刻印武器（4-11E）の由来を語る flavor＋系譜への手がかり。
// 死亡時、握っていた武器は亡骸（化石）に刻まれる。その化石に出会い〈継ぐ〉と奪還できる。
async function smithLore() {
  busy = true;
  const ch = world.current!;
  const anc = ch.lineage?.ancestorFossilId ? world.fossils.find((f) => f.id === ch.lineage.ancestorFossilId) : undefined;
  const ancWeapon = anc?.origin.gearTags?.[0];
  const reclaimable = ancWeapon ? itemByName(ancWeapon) : null;
  const hint = !anc
    ? "「お前さんは、誰の得物も継いじゃいない。まあ、いずれ誰かの刻印を背負う日も来るさ」。"
    : reclaimable
      ? `「お前の血筋――${anc.origin.name} が握っていたのは《${ancWeapon}》だ。その亡骸に出会い、遺志を継げば、得物ごと取り戻せる」。`
      : `「${anc.origin.name} の得物は《${ancWeapon}》。ありゃ既製の品じゃない……奪い返せるかは、お前次第だ」。`;
  await sheet({
    text: `鍛冶ヴァロは炉の火を見つめる。\n「斃れた探索者の得物には、持ち主の念が刻まれる。地に還っても、刃はあるじを忘れんのさ。\nその亡骸に出会い、遺志を〈継げ〉ば――得物は、また血の中へ戻ってくる」。\n\n${hint}`,
    meta: "武具屋 ── 先代の刻印武器（4-11E）", options: ["うなずく"],
  });
  busy = false;
}
// 薬師：金貨で深蝕の進行を和らげる（exposure を一段戻す）。
const TREAT_RATE = 18; // 薬師の深蝕治療＝1単位あたりの金貨（携行薬 ≈27金/単位 より割安＝据え置きサービスの値打ち）
async function healerTreat() {
  busy = true;
  const ch = world.current!;
  if (ch.exposure <= 0.05) { await sheet({ text: "深蝕は、今は薄い。施療の要はない。", options: ["わかった"] }); busy = false; return; }
  // 街の据え置き施療＝深蝕浄めの「割安な基準値」。携行薬（鎮静の薬＝0.6/16金≈27金/単位）より単価を低く保つ
  // ＝薬は“持ち運べるプレミアム”、薬師の通院は“安いが街でしか受けられない”という住み分け。
  // 旧式（12+level*3+exp*10）は携行薬より高くつき逆転していた（Lv10で 52金 vs 薬16金）＝是正。
  const relief = Math.min(ch.exposure, 0.6 + ch.level * 0.05); // 深部ほど一度に多く浄める＝通院回数を増やさない
  const cost = Math.max(5, Math.round(relief * TREAT_RATE)); // ≈18金/単位＝携行薬より割安
  const r = await sheet({
    text: `老薬師トウ。お前の深蝕は ${ch.exposure.toFixed(2)}。\n薬と祈りで退かせる（−${relief.toFixed(2)}・${cost}金貨）。所持 金${ch.gold}。`,
    meta: "薬師 ── 深蝕治療",
    options: [`施療を受ける（${cost}金貨）`, "やめる"],
  });
  busy = false;
  if (r.pick !== 1) return;
  if (ch.gold < cost) { busy = true; await sheet({ text: "金貨が足りない。", options: ["出直す"] }); busy = false; return; }
  ch.gold -= cost; const b4 = ch.exposure; cleanseExposure(ch, relief); const got = b4 - ch.exposure;
  sfx("heal");
  log(got < relief - 0.001
    ? `薬と祈りで深蝕が退いた（−${got.toFixed(2)}／所持 ${ch.gold}）。だが芯に烙印が残り、これ以上は退かぬ。`
    : `薬と祈りで、深蝕が退いた（−${got.toFixed(2)}／所持 ${ch.gold}）。`, "dim");
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
  cleanseExposure(ch, REQUIEM_RELIEF); // 鎮魂は自分の深蝕も少し浄める（教団の烙印より下へは祓えない）
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
  cleanseExposure(ch, PRAY_RELIEF);
  ch.prayedAtShrineGen = world.generation;
  sfx("intervene");
  log(`祈りのあいだ、胸の澱がわずかに晴れた（深蝕 -${(before - ch.exposure).toFixed(2)}）。`, "dim");
  save();
}
// 教団〈深淵を讃える者たち〉：金貨でなく深蝕で支払う店＝慰霊堂/薬師（深蝕を減らす）の暗い鏡。
// 恩恵（禁術を識る／理・力+1）と引き換えに深蝕が上がる。深蝕は死亡時に化石へ焼き付き、
// 高いほど自分の化石が「怨念極」へ寄り・速く変質＝後世で敵性化する（堆積/変質テンソンの核）。
// ★リスク再設計 v2（2026-06-30 ユーザーFB「Lv12 でもかなりの数を簡単に取れる」）：
// v1（①レベルゲート＋②治りにくい烙印＋③金貨）でも、対価が"訪問ごとにリセット"される（深蝕は癒え・烙印は潜行で薄れる）
// ため総取得数を縛れていなかった。総数を縛るには対価を【累積し永続】させる必要がある。4つのレバーで再設計：
//  A. 生涯の取引回数に上限（CULT_BOON_CAP）＝深淵がひとつの魂と交わす取引は限りがある（死で次代はリセット）。
//  B. 永続汚染（exposureTaint）＝1取引ごとに"二度と祓えぬ深蝕の下限"が上がる。集めるほど死亡時の怨念化が不可避＝真の代償。
//  C. 急峻な逆増（乗算）＝深蝕コスト CULT_COST_BASE×GROWTH^回数（上限内でも3つ目は破滅的賭け）。
//  D. レベルゲート厳格化（CULT_REACH 6→3）＝Lv12 が near-終盤術を選べない。
//  E. 金貨も逆増（取引回数で増える）。
const CULT_COST_BASE = 0.6, CULT_COST_GROWTH = 1.8; // C：深蝕コストは 0.6→1.08→1.94…と急峻に
const CULT_BOON_CAP = 3;         // A：1キャラ（世代）が教団から得られる恩恵の生涯上限
const CULT_PERMA = 0.2;          // B：1取引ごとに永続的に上がる「祓えぬ深蝕の下限」
const CULT_REACH = 8;            // D：教団が授ける術の minLevel 上限＝Lv+この余裕。上限3回＝1枠の価値を高めるため上位も「ある程度」届く（FB 2026-06-30）。帰還(minLv9)が Lv1 から狙え、Lv12 で minLv≤20 まで。真の終盤術(omni22/wither24/orbblade26/echo32/死戸36/断罪44)は引き続きレベル相応にゲート＝cap3+急峻深蝕+永続汚染が歯止め。
const CULT_GOLD_BASE = 10, CULT_GOLD_PER_LV = 4; // E：喜捨＝(base + 術 minLevel×係数)×回数逆増
const CULT_STAT_GOLD = 60;       // E：理/力+1 の喜捨（術と独立の基準）
const BRAND_DECAY = 0.1;         // 烙印（一時分）は潜行で新フロアに入るごとにこれだけ薄れる（永続下限 exposureTaint までで止まる）
function cultCost(ch: Character): number {
  return CULT_COST_BASE * Math.pow(CULT_COST_GROWTH, ch.cultBoonsThisGen ?? 0); // C：乗算で急峻に
}
function cultGoldMul(ch: Character): number {
  return 1 + (ch.cultBoonsThisGen ?? 0) * 0.5; // E：回数で金貨も逆増
}
async function cultOffering() {
  busy = true;
  const ch = world.current!;
  const used = ch.cultBoonsThisGen ?? 0;
  // A：生涯上限に達したら、もう取引しない（フレーバーのみ）。
  if (used >= CULT_BOON_CAP) {
    await sheet({
      text: `仮面の教主は、もうお前を見ない。\n「深淵がひとつの魂と交わす取引は、${CULT_BOON_CAP}度まで。お前はもう、与えられるだけ与えられた。\n……あとは、その身に刻んだものと往け。」`,
      meta: "教団 ── これ以上の取引はない", options: ["立ち去る"],
    });
    busy = false; return;
  }
  const expCost = cultCost(ch);
  const goldMul = cultGoldMul(ch);
  type Boon = { label: string; gold: number; run: () => void };
  const boons: Boon[] = [];
  // D：レベル連動（厳格）。器（Lv+CULT_REACH）に届く未習得術だけを授ける。
  for (const s of SPELLS.filter((s) => !ch.spells.includes(s.key) && (s.minLevel ?? 1) <= ch.level + CULT_REACH)) {
    const g = Math.round((CULT_GOLD_BASE + (s.minLevel ?? 1) * CULT_GOLD_PER_LV) * goldMul); // E：強い術ほど・回数ほど高い喜捨
    boons.push({
      label: `禁術を識る：${s.name}（${s.desc}）／喜捨${g}金`,
      gold: g,
      run: () => { learnSpell(ch, s.key); log(`深淵が囁く──《${s.name}》を識った。`, "warn"); },
    });
  }
  const statGold = Math.round(CULT_STAT_GOLD * goldMul);
  boons.push({ label: `深淵の力：理 ＋1（深蝕魔法が伸びる）／喜捨${statGold}金`, gold: statGold, run: () => { ch.stats.reason += 1; log("深みが理を押し上げた（理 ＋1）。", "warn"); } });
  boons.push({ label: `深淵の力：力 ＋1（攻撃が伸びる）／喜捨${statGold}金`, gold: statGold, run: () => { ch.stats.power += 1; log("深みが膂力を押し上げた（力 ＋1）。", "warn"); } });
  const r = await sheet({
    text: `仮面の教主。深蝕は呪いではなく祝福だ。\n対価は深蝕＋${expCost.toFixed(2)}（捧げるほど急に深くなる）と喜捨の金貨。\n──そのうち ＋${CULT_PERMA.toFixed(2)} は"二度と祓えぬ烙印"として永久に残る。\nこの身が深淵と交わせる取引は、あと ${CULT_BOON_CAP - used} 度（生涯 ${CULT_BOON_CAP} 度まで）。\nお前の器（Lv${ch.level}）に届く術しか授けられぬ。\n今の深蝕 ${ch.exposure.toFixed(2)}（祓えぬ下限 ${(ch.exposureTaint ?? 0).toFixed(2)}／変質閾値 0.5・1.2・2.5）／所持 金${ch.gold}。`,
    meta: `教団 ── 深淵と取引する（あと${CULT_BOON_CAP - used}度）`,
    options: [...boons.map((b) => b.label), "立ち去る"],
  });
  busy = false;
  const i = r.pick - 1;
  if (i < 0 || i >= boons.length) return;
  const b = boons[i];
  if (ch.gold < b.gold) { busy = true; await sheet({ text: `喜捨が足りない（${b.gold}金が要る）。`, meta: "教団", options: ["出直す"] }); busy = false; return; }
  ch.gold -= b.gold; // E：金貨を捧げる
  b.run();
  const before = ch.exposure;
  addExp(expCost); // C：急峻な深蝕
  ch.exposureTaint = (ch.exposureTaint ?? 0) + CULT_PERMA; // B：永続的に上がる「祓えぬ下限」
  ch.exposureBrand = Math.max((ch.exposureBrand ?? 0) + (ch.exposure - before), ch.exposureTaint); // 一時の烙印＝今上がったぶん（永続下限を下回らない）
  ch.cultBoonsThisGen = used + 1;
  sfx("intervene");
  log(`深淵に深蝕(＋${(ch.exposure - before).toFixed(2)})と喜捨(−${b.gold}金)を捧げた → 深蝕 ${ch.exposure.toFixed(2)}・祓えぬ下限 ${(ch.exposureTaint ?? 0).toFixed(2)}。`, "warn");
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
/** 消耗品の使用枠数（同種はスタックなので枠は増えない）。 */
function invSlotsUsed(ch: Character): number { return ch.inventory?.length ?? 0; }
/** 統一バッグ（荷物）の使用量＝消耗品の枠数＋拾った武具の点数。容量は packCapacity と比較。 */
function packUsed(ch: Character): number { return (ch.inventory?.length ?? 0) + (ch.gearBag?.length ?? 0); }
/** 消耗品を1つ荷物へ。同種はスタック、荷物に空きが無ければ false（武具と枠を共有）。 */
function addConsumable(ch: Character, key: string): boolean {
  // 新規枠の上限＝荷物の空き（packCapacity − 武具袋の点数）。既存枠へのスタックは grantConsumable が無条件で許す。
  return grantConsumable(ch, key, packCapacity(ch) - (ch.gearBag?.length ?? 0));
}
/** 報酬の消耗品が荷物満杯で入らなかったとき、「何かを捨てて入れ替える／諦める」を出す（テストプレイFB＝諦めるだけにしない）。
 *  荷物枠は消耗品スタック（同種は1枠）＋拾った武具（1点1枠）の共有。新規消耗品の枠を空けるには、いずれか1つを手放す。 */
async function swapForReward(ch: Character, key: string): Promise<void> {
  const def = consumableByKey(key);
  if (!def) return;
  if (addConsumable(ch, key)) { sfx("pickup", 0.1); log(`${def.name} を持ち物に入れた。`, "dim"); return; } // 既存スタックがあれば素直に入る（保険）
  const drops: { name: string; drop: () => void }[] = [];
  for (const s of ch.inventory ?? []) drops.push({
    name: `${consumableByKey(s.key)?.name ?? s.key}（×${s.qty}）`,
    drop: () => { ch.inventory = (ch.inventory ?? []).filter((x) => x !== s); },
  });
  for (const it of ch.gearBag ?? []) drops.push({
    name: itemLabel(it),
    drop: () => { ch.gearBag = (ch.gearBag ?? []).filter((x) => x !== it); },
  });
  const r = await sheet({
    text: `${def.name}（${def.desc}）を手にした。だが荷物が一杯だ（${packUsed(ch)}/${packCapacity(ch)}）。\n何かを手放して入れ替えるか、諦めるか。`,
    meta: "荷物が一杯 ── 入れ替え",
    options: [...drops.map((d) => `「${d.name}」を手放す`), "諦める（受け取らない）"],
  });
  const i = r.pick - 1;
  if (i < 0 || i >= drops.length) { log(`${def.name} を手放した。`, "dim"); return; } // 諦める
  drops[i].drop();
  addConsumable(ch, key); // 1枠空いたので必ず入る
  sfx("pickup", 0.1);
  log(`「${drops[i].name}」を手放し、${def.name} を持ち物に入れた。`, "dim");
  save();
}
/** 報酬適用で溢れた消耗品（applyEffects 等の overflow）を順に交換 UI へ。 */
async function resolveOverflow(ch: Character, overflow: string[]): Promise<void> {
  for (const key of overflow) await swapForReward(ch, key);
}
/** 1枠から1つ消費（0になった枠は外す）。 */
function consumeOne(ch: Character, key: string) {
  const slot = ch.inventory?.find((s) => s.key === key);
  if (!slot) return;
  slot.qty -= 1;
  if (slot.qty <= 0) ch.inventory = (ch.inventory ?? []).filter((s) => s !== slot);
}
/** 戦術系の消耗品か（潜行中限定＝街で使うと空振り）。回復/深蝕除去/鑑定は街でも可。 */
function isCombatConsumable(def: ConsumableDef | undefined): boolean {
  if (!def) return false;
  const u = def.use;
  return !!(u.healFrac || u.curePoison || u.atkBuff || u.armBuff || u.haste || u.burst);
}
/** 消耗品の効果を適用（深蝕−／HP回復／戦術系。hp はモジュール変数＝潜行中の現在HP）。戻り＝表示用。 */
function applyConsumable(ch: Character, key: string): string {
  const def = consumableByKey(key);
  if (!def) return "";
  const u = def.use;
  const parts: string[] = [];
  if (u.exposure) {
    const before = ch.exposure;
    cleanseExposure(ch, -u.exposure); // 鎮静/浄化の薬も教団の烙印より下へは祓えない（②）
    parts.push(`深蝕 -${(before - ch.exposure).toFixed(2)}`);
  }
  if (u.healFrac) {
    const before = hp;
    hp = Math.min(maxHp(ch), hp + Math.round(maxHp(ch) * u.healFrac));
    if (hp > before) floatFx(player.x, player.y, `+${hp - before}`, "fl-heal");
    parts.push(`HP +${hp - before}`);
  }
  if (u.curePoison) {
    if (poisonTurns > 0) { poisonTurns = 0; poisonDmg = 0; parts.push("毒を中和"); }
    else parts.push("毒は巡っていない");
  }
  if (u.atkBuff) { attackBuffTurns = Math.max(attackBuffTurns, u.atkBuff); parts.push(`近接強化 ${u.atkBuff}手`); }
  if (u.armBuff) { armorBuffTurns = Math.max(armorBuffTurns, u.armBuff); parts.push(`防御強化 ${u.armBuff}手`); }
  if (u.haste)   { hasteTurns = Math.max(hasteTurns, u.haste); parts.push(`疾走 ${u.haste}手`); }
  if (u.burst && floor) { // 投擲＝周囲（半径1・Chebyshev）の敵に一括ダメージ。撃破は downOrKill（ボスは決着へ）。
    const dmg = u.burst;
    let hitN = 0;
    for (const m of floor.monsters) {
      if (m.hp <= 0) continue;
      if (Math.max(Math.abs(m.x - player.x), Math.abs(m.y - player.y)) > 1) continue;
      m.hp -= dmg; hitN++; flashFx("warp", { x: m.x, y: m.y });
      if (m.hp <= 0) downOrKill(m, `${def.name}が${m.kind.name}を焼いた。`);
    }
    sfx("spell_warp");
    parts.push(hitN ? `${hitN}体を焼く（各${dmg}）` : "周囲に敵がいない");
  }
  if (u.identify) { // 手持ち（装備＋袋）の未鑑定をすべて見極める
    const gear: Item[] = [...Object.values(ch.equipment).filter((g): g is Item => !!g), ...(ch.gearBag ?? [])];
    let n = 0;
    for (const it of gear) if (it.unidentified) { it.unidentified = false; n++; }
    parts.push(n ? `${n}点を鑑定` : "未鑑定の品はない");
  }
  return parts.join("・");
}
const sellValue = (key: string) => Math.max(1, Math.round((consumableByKey(key)?.price ?? 2) / 2));

// 道具屋ハル act0「消耗品を買う」：金貨で消耗品を購入し持ち物へ（容量に注意）。
async function storeBuy() {
  busy = true;
  const ch = world.current!;
  for (;;) {
    const stock = CONSUMABLES.filter((c) => (c.minLevel ?? 0) <= ch.level); // 上位品は等級で解禁（深部向けを序盤の棚に出さない）
    const r = await sheet({
      text: `道具屋ハル。所持 金${ch.gold}。\n持ち物 ${packUsed(ch)}/${packCapacity(ch)} 枠（同じ品は重ねて持てる）。`,
      meta: "道具屋 ── 消耗品を買う",
      options: [...stock.map((c) => `${c.name}（${c.desc}）${c.price}金貨`), "やめる"],
    });
    const i = r.pick - 1;
    if (i < 0 || i >= stock.length) break;
    const c = stock[i];
    if (ch.gold < c.price) { await sheet({ text: "金貨が足りない。", options: ["出直す"] }); continue; }
    if (!addConsumable(ch, c.key)) { await sheet({ text: "持ち物が一杯だ。レベルが上がれば、持てる量も増える。", options: ["わかった"] }); continue; }
    ch.gold -= c.price; sfx("buy");
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
    ch.gold += val; consumeOne(ch, s.key); sfx("sell");
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
      text: `持ち物 ${packUsed(ch)}/${packCapacity(ch)} 枠。\n品を選ぶ。`,
      meta: "道具屋 ── 携行品を整える",
      options: [...inv.map((s) => `${consumableByKey(s.key)?.name ?? s.key} ×${s.qty}`), "戻る"],
    });
    const i = r.pick - 1;
    if (i < 0 || i >= inv.length) break;
    const s = inv[i], def = consumableByKey(s.key);
    const a = await sheet({ text: `${def?.name}（${def?.desc}）`, options: ["使う", "捨てる", "戻る"] });
    if (a.pick === 1) {
      if (isCombatConsumable(def)) { await sheet({ text: "ここで使うものではない。潜ってから役に立つ。", options: ["わかった"] }); continue; }
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
const stashCap = () => (world.manorUnlocked ? STASH_CAP_MANOR : STASH_CAP);           // 貴族街の館で保管庫拡張（4-14G 層4）
const stashInherit = () => (world.manorUnlocked ? STASH_INHERIT_MANOR : STASH_INHERIT); // 相続枠も拡張
const homeFull = () => homeUsed() >= stashCap();
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
    dedupeGearBag(ch); // 袋の参照重複を除いてから（二重表示/二重移動を防ぐ）
    const inv = ch.inventory ?? [];
    const bag = ch.gearBag ?? []; // 荷物の中の未装備の武具（拾った予備）＝これも預けられるように（FB 2026-07-03）
    const eqSlots: ItemSlot[] = ["weapon", "armor", "relic", "bag"];
    const equipped = eqSlots.filter((sl) => ch.equipment[sl]);
    const opts = [
      ...inv.map((s) => `消耗品：${consumableByKey(s.key)?.name ?? s.key} ×${s.qty}`),
      ...bag.map((it) => `荷物の武具：${SLOT_LABEL[it.slot]} ${itemLabel(it)}`),
      ...equipped.map((sl) => `装備中：${SLOT_LABEL[sl]} ${itemLabel(ch.equipment[sl]!)}`),
    ];
    if (!opts.length) { await sheet({ text: "預けられる持ち物も装備もない。", options: ["閉じる"] }); break; }
    const r = await sheet({
      text: `わが家の物入れ＝代々の武具庫。保管 ${homeUsed()}/${stashCap()} 枠（世代を越えて遺せるのは消耗品${stashInherit()}・装備${stashInherit()}枠まで）。\n何を預ける？`,
      meta: "自宅 ── 預ける",
      options: [...opts, "やめる"],
    });
    const i = r.pick - 1;
    if (i < 0 || i >= opts.length) break;
    if (i < inv.length) { // 消耗品
      const s = inv[i];
      if (!stashAdd(s.key)) { await sheet({ text: "保管庫がもう一杯だ。", options: ["戻る"] }); continue; }
      consumeOne(ch, s.key); sfx("consume");
      log(`${consumableByKey(s.key)?.name ?? s.key} を保管庫に預けた。`, "dim"); save();
    } else if (i < inv.length + bag.length) { // 荷物の予備武具（装備は外さずそのまま武具庫へ）
      if (homeFull()) { await sheet({ text: "武具庫がもう一杯だ。", options: ["戻る"] }); continue; }
      const it = bag[i - inv.length];
      world.stashGear ??= []; world.stashGear.push(it);
      ch.gearBag = bag.filter((g) => g !== it);
      sfx("equip"); log(`${it.name} を武具庫に納めた。`, "dim"); updateStatus(); save();
    } else { // 装備中（外して武具庫へ）
      if (homeFull()) { await sheet({ text: "武具庫がもう一杯だ。", options: ["戻る"] }); continue; }
      const sl = equipped[i - inv.length - bag.length];
      const it = ch.equipment[sl]!;
      world.stashGear ??= []; world.stashGear.push(it); ch.equipment[sl] = null;
      sfx("equip"); log(`${it.name} を外して武具庫に納めた。`, "dim"); updateStatus(); save();
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
      text: `保管 ${homeUsed()}/${stashCap()} 枠。持ち物 ${packUsed(ch)}/${packCapacity(ch)} 枠。\n何を引き出す？`,
      meta: "自宅 ── 引き出す",
      options: [...opts, "やめる"],
    });
    const i = r.pick - 1;
    if (i < 0 || i >= opts.length) break;
    if (i < st.length) { // 消耗品→持ち物
      const s = st[i];
      if (!addConsumable(ch, s.key)) { await sheet({ text: "持ち物が一杯だ。", options: ["戻る"] }); continue; }
      stashTake(s.key); sfx("pickup");
      log(`${consumableByKey(s.key)?.name ?? s.key} を持ち物に移した。`, "dim"); save();
    } else { // 装備→荷物へ移すだけ（強制装備スワップを廃止＝FB 2026-07-05「引き出しで装備と交換になり不便」）。
      // 迷宮の戦利品と同じ流れ＝荷物に入れ、装備は「装備・荷物を見る」から任意に。荷物が満杯なら整理を促す（消失なし）。
      const it = gear[i - st.length];
      if (packUsed(ch) >= packCapacity(ch)) {
        await sheet({ text: `荷物が一杯だ（${packUsed(ch)}/${packCapacity(ch)}）。先に持ち物を整理してから引き出そう。`, options: ["戻る"] });
        continue;
      }
      ch.gearBag ??= []; ch.gearBag.push(it);
      world.stashGear = gear.filter((g) => g !== it);
      sfx("pickup"); log(`武具庫から ${itemLabel(it)} を荷物に移した（装備は「装備・荷物を見る」から）。`, "dim"); updateStatus(); save();
    }
  }
  busy = false;
}
// 自宅 act2「物入れを検める」：保管庫（消耗品＋武具庫）を眺める（世代越えの確認＋フレーバー）。
async function homeView() {
  busy = true;
  const st = world.stash ?? [], gear = world.stashGear ?? [];
  const consRows: SheetRow[] = st.length ? st.map((s) => ({ label: consumableByKey(s.key)?.name ?? s.key, value: `×${s.qty}` })) : [{ text: "（なし）", dim: true }];
  const armoryRows: SheetRow[] = gear.length ? gear.map((it) => ({ label: SLOT_LABEL[it.slot], value: itemLabel(it) })) : [{ text: "（なし）", dim: true }];
  await sheet({
    text: `代々の物入れ。世代を越えて遺せるのは消耗品${stashInherit()}・装備${stashInherit()}枠まで。`,
    sections: [{ header: "消耗品", rows: consRows }, { header: "武具庫", rows: armoryRows }],
    meta: `${world.manorUnlocked ? "貴族街の館" : "自宅"} ── 保管 ${homeUsed()}/${stashCap()}`, options: ["閉じる"],
  });
  busy = false;
}

// ---------- 家系図（系譜の間・4-14G 層3：自宅）：多世代の重みを見える化する ----------
const VARIATION_JP: Record<string, string> = { weathered: "風化", twisting: "歪み", alien: "異形" };
/** 家格（4-14G 層3）＝家系の誉れ。退隠2＋クリア3＋伝説1 で score、5段に丸める。次代開始の微小な恩恵に効く。 */
function houseRank(): { tier: number; label: string; score: number } {
  const retirees = world.fossils.filter((f) => f.retired).length;
  const legends = world.tracked.filter((t) => t.source === "player_legend").length;
  const score = retirees * 2 + (world.ascended ?? 0) * 3 + legends;
  const tier = score >= 12 ? 5 : score >= 8 ? 4 : score >= 5 ? 3 : score >= 3 ? 2 : score >= 1 ? 1 : 0;
  const label = ["名もなき家", "駆け出しの家", "名の知れた家", "誉れ高き家", "英傑の家系", "大いなる家系"][tier];
  return { tier, label, score };
}
// 極（tonePole）の色＝正典色から流用：神話=金泥（player）/喪失=青緑（fossil）/怨念=赤（danger 系を読みやすく）。
const POLE_COLOR: Record<string, string> = { myth: "#ffd87a", loss: "#9fd8cf", grudge: "#ff8a76" };
/** 系譜の間（家系図）：歴代当主のカード一覧（図鑑と同じ二層UI・テストプレイFB「文字の羅列で見づらい」対応）。
 *  一覧＝chooseGrid カード（第N代・名・最期の極を色分け）／タップ→詳細（sheet の sections＝Swift Section ミラー）。 */
async function lineageHallScene() {
  busy = true;
  const wt = worldTime(world);
  const line = world.fossils.filter((f) => f.kind === "character"); // 歴代当主（死者＋退隠した先代）
  const ordered = [...line].sort((a, b) => a.death.generationCreated - b.death.generationCreated);
  const hr = houseRank();
  const hall = (world.manorUnlocked
    ? "貴族街の館・大広間。歴代の名は、貴族の列に連なる肖像として壁を埋めている。"
    : "世代を継ぐたび、この壁に名が刻まれる。退いた者は伝説に、斃れた者は深みで静かに変わってゆく。")
    + (aurelCh() >= 6 ? "\nこの家系は、始祖の遺した問いを継いでいる。欠けた頁の、次の頁を書き続ける家系。" : "");
  const boon = hr.tier >= 1 ? `　家格に応じ、次の当主は家の蓄え（膏薬・餞別）を携えて発つ。` : "";
  for (;;) {
    if (!ordered.length) {
      await sheet({
        text: `〔${hr.label}〕（家格 ${hr.tier}/5・誉れ ${hr.score}）\n${hall}\n\nまだ歴代の当主はいない。最初の一代として、名を刻め。`,
        meta: `${world.manorUnlocked ? "貴族街の館" : "自宅"} ── 系譜の間（家系図）`, options: ["閉じる"],
      });
      break;
    }
    // 一覧＝カード（新しい代が上＝直近の物語から辿れる）。glyph：★=退いた伝説（金）／†=斃れた（極の色）。
    const list = [...ordered].reverse();
    const cells = list.map((f) => {
      const g = f.death.generationCreated;
      const epi = f.origin.epithet ? `〈${f.origin.epithet}〉` : "";
      if (f.retired) {
        return { html: `<div class="nm"><span style="color:#ffd87a;font-size:1.15em">★</span>　第${g}代　${f.origin.name}${epi}</div>`
          + `<div class="sub">伝説として退いた ── 街の守護者</div>` };
      }
      const v = computeVariation(f, wt);
      const col = POLE_COLOR[f.tonePole] ?? "#9fd8cf";
      return { html: `<div class="nm"><span style="color:${col};font-size:1.15em">†</span>　第${g}代　${f.origin.name}${epi}</div>`
        + `<div class="sub"><span style="color:${col}">${poleLabel(f.tonePole)}の極</span>　深度${f.laidDepth}で斃れた・今は ${VARIATION_JP[v.stage] ?? v.stage}</div>` };
    });
    const i = await chooseGrid({
      title: `系譜の間 ── 〔${hr.label}〕 家格 ${hr.tier}/5・誉れ ${hr.score}`,
      lead: `${hall}${boon}　歴代 ${ordered.length} 名。`,
      cells, cancel: "閉じる", cols: 1,
    });
    if (i < 0 || i >= list.length) break;
    // 詳細＝構造化シート（最期／いま／遺品／言葉）。
    const f = list[i];
    const epi = f.origin.epithet ? `〈${f.origin.epithet}〉` : "";
    const endRows: SheetRow[] = f.retired
      ? [{ label: "終わり方", value: "伝説として退いた" }, { label: "その後", value: "街の守護者", note: "街で再会できる" }]
      : [
          { label: "終わり方", value: `深度${f.laidDepth}で斃れた` },
          { label: "極", value: `${poleLabel(f.tonePole)}の極` },
          { label: "最後の一手", value: finalActLabel(f.death.finalAct.choice) },
        ];
    const nowRows: SheetRow[] = f.retired
      ? [{ text: "深みに亡骸はない。人としての余生を、街で静かに送っている。", dim: true }]
      : (() => {
          const v = computeVariation(f, wt);
          return [
            { label: "変質", value: VARIATION_JP[v.stage] ?? v.stage, note: "放置で進み、干渉で緩む" },
            { text: "亡骸は深みに眠り、世代とともに変わってゆく。潜れば、再会することもある。", dim: true },
          ] as SheetRow[];
        })();
    const gearRows: SheetRow[] = (f.origin.gearTags?.length ? f.origin.gearTags : []).slice(0, 4)
      .map((gname) => ({ text: `「${gname}」` } as SheetRow));
    const sections: SheetSection[] = [
      { header: "最期", rows: endRows },
      { header: "いま", rows: nowRows },
    ];
    if (gearRows.length) sections.push({ header: "遺品", rows: gearRows });
    if (f.origin.catchphrase || f.death.finalAct.note) {
      const wordRows: SheetRow[] = [];
      if (f.death.finalAct.note) wordRows.push({ text: `最期の言葉 ──「${f.death.finalAct.note}」`, dim: true });
      if (f.origin.catchphrase) wordRows.push({ text: `口癖 ──『${f.origin.catchphrase}』`, dim: true });
      sections.push({ header: "言葉", rows: wordRows });
    }
    await sheet({
      text: `第${f.death.generationCreated}代《${f.origin.name}》${epi}`,
      meta: `系譜の間 ── ${f.origin.name}`,
      sections, options: ["戻る"],
    });
  }
  busy = false;
}

// ---------- 書記＝伝説化承認／系譜（4-4）・ギルド＝等級・英雄譜（4-4） ----------
const TRACK_SOURCE_LABEL: Record<string, string> = { seeded: "街の古い伝説", player_legend: "あなたが遺した伝説", nemesis: "因縁の相手" };
const ARC_LABEL: Record<string, string> = { retire: "静かなる昇華", doom: "破滅の弧", fall: "堕ちゆく弧", lore_drift: "伝承の漂い" };
// 弧の現在段（4-6・英雄譜に併記＝世代ごとに進むのが一目で分かる）。index=beat(0..3)。
const ARC_BEAT_STAGE_LABEL: Record<string, string[]> = {
  doom:       ["健在", "深みへの執着", "歪み始めた噂", "深淵に呑まれた"],
  retire:     ["現役", "第一線を退く", "街の守護者", "静かな伝説"],
  fall:       ["絶頂", "慢心の兆し", "孤立", "成れの果て"],
  lore_drift: ["史実", "食い違い", "別人と混濁", "原型の喪失"],
};
function arcStageLabel(t: { arcType: string; beat?: number; pick?: string }): string {
  const stages = ARC_BEAT_STAGE_LABEL[t.arcType];
  const stage = stages ? stages[Math.min(t.beat ?? 0, stages.length - 1)] : "";
  return t.pick === "warped" ? `${stage}（歪んだ末路）` : stage;
}
/** 金属6等級のラベルと契約ロジックは companion.ts（ブラウザセーフ・純粋）に集約（式のドリフト防止）。 */
import {
  GRADE_LABELS, LIVING_GRADE_CAP, worldPlayerGrade, companionGradeFor,
  hireFee, effectiveHireGrade, companionCut,
} from "../companion.ts";
/** 相棒の昇格判定（⤴ 4-4E）。生還(bond)・偉業(feats)を更新した後に呼ぶ。段が上がればログと盤上へ反映。 */
function tryPromoteCompanion(): void {
  const c = world.companion;
  if (!c?.alive) return;
  const next = companionGradeFor(c.bond, c.feats ?? 0, c.grade);
  if (next > c.grade) {
    c.grade = next;
    c.maxHp = companionMaxHp(next); // 等級基礎（深度0）を保存値に。盤上は深度込みで再計算
    if (companion && floor) { companion.maxHp = companionMaxHp(next, floor.depth); companion.dmg = companionDmg(next, floor.depth); } // 潜行中なら盤上に深度込みで即反映（HPは据置）
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
function playerGrade(): number { return worldPlayerGrade(world, world.current?.level ?? 1); }
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
// 伝説化の資格（4-4）：かつては「神話の極で逝った旧キャラ」だけ＝死に方（最後の一手）次第で深度8でも
// 伝説になれ、クリア用の印①がタダ同然だった（テストプレイFB 2026-06-30）。このゲームの Lv≈深度・終始シビアに
// 合わせ、【深く潜った証（深度）＋実力（レベル）＋育ち（ステ/術＝到達実績）】の複合ゲートに引き上げる。
// 「神話の極」＝立派な死に方は化石の味付けとして残す（resolveTonePole は不変）が、"街の伝説（秘銀・英雄譜・
// クリア印）"に祀るには深潜＋実力＋実績を要求＝奉献の印①を「深く潜り抜いた英雄的な生涯」の到達点にする。
const LEGEND_MIN_DEPTH = 25;   // 到達の証（ハード下限）＝深く潜って逝った者だけ（ユーザー指定）。
const LEGEND_MERIT_MIN = 30;   // 偉功＝レベル＋育ち（ステ総量/6＋修めた術数）の複合下限。深いが未熟な階段潜り(stair-dive)を除外。
function legendMerit(f: Fossil): number {
  const lvl = f.level ?? f.laidDepth ?? f.death.depth; // 旧化石は level 欠落→深度で代用（Lv≈深度）
  const st = f.stats ? (f.stats.body + f.stats.power + f.stats.reason + f.stats.heart) : lvl; // 育ちの総量（到達実績）
  const spellN = f.spells?.length ?? 0; // 修めた術の広さ（到達実績）
  return lvl + Math.floor(st / 6) + spellN;
}
function legendEligible(f: Fossil): boolean {
  return f.tonePole === "myth"                                     // 神話の極で逝った
    && f.death.generationCreated >= 1                              // 自分の過去世代（シード化石=gen0 は対象外）
    && (f.death.depth ?? f.laidDepth ?? 0) >= LEGEND_MIN_DEPTH     // 深く潜った証（深度25+）
    && legendMerit(f) >= LEGEND_MERIT_MIN                          // 実力＋到達実績（レベル・育ち）
    && !world.tracked.some((t) => t.originRef === f.id);           // 未登録
}
async function legendApprove() {
  busy = true;
  const elig = world.fossils.filter(legendEligible);
  if (!elig.length) {
    await sheet({ text: `老書記イェンは目を伏せた。\n「伝説に名を刻めるのは、深く潜り（深度${LEGEND_MIN_DEPTH}以上）、相応の実力を備え、神話の極で逝った旧き者だけだ。まだ、その名は無い」。`, meta: "書記 ── 伝説化の承認", options: ["引き下がる"] });
    busy = false; return;
  }
  const r = await sheet({
    text: `「誰の名を、街の伝説として刻もうか」。\n深く潜り（深度${LEGEND_MIN_DEPTH}以上）、実力を備え、神話の極で逝った旧き者だけが、秘銀（ミスリル）の名と共に英雄譜に昇る。`,
    meta: "書記 ── 伝説化の承認（4-4）",
    options: [...elig.map((f) => `${f.origin.name}（深度${f.death.depth}・Lv${f.level ?? "?"}・${poleLabel(f.tonePole)}の極）`), "やめる"],
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
  if (awardSeal(world, "legend", [f.id])) { sfx("seal"); log("◆ 「伝説の承認」の印を得た。", "warn"); }
  // 伝承の漂い（4-6・lore_drift の源）：伝説を重ねるほど、最も古い伝説の「物語」が漂い始める
  // （史実→食い違い→混濁→原型の喪失）。retire（その人の生の弧）とは別軸で共存＝人は静かな伝説、
  // だが語りは世代を経て歪む。同一人物の lore_drift は一度きり（重複抱録防止）。advanceArcs が世代で進める。
  const otherLegends = world.tracked.filter(
    (t) => t.source === "player_legend" && t.arcType === "retire" && t.originRef && t.originRef !== f.id,
  );
  if (otherLegends.length >= 1) { // 新たな伝説を加えて計≥2＝古い伝説の語りが漂い始める
    const oldest = otherLegends
      .filter((t) => !world.tracked.some((d) => d.arcType === "lore_drift" && d.originRef === t.originRef))
      .sort((a, b) =>
        (world.fossils.find((x) => x.id === a.originRef)?.death.generationCreated ?? 0) -
        (world.fossils.find((x) => x.id === b.originRef)?.death.generationCreated ?? 0))[0];
    if (oldest?.originRef) {
      world.tracked.push({
        id: `loredrift_${oldest.originRef}`, name: oldest.name, source: "player_legend",
        arcType: "lore_drift", beat: 0, lastObservedGeneration: world.generation, originRef: oldest.originRef,
      });
      chronicle(world, "rumor", `${oldest.name}の武勇伝が、語り手によって少しずつ食い違い始めた。`, [oldest.originRef]);
      log(`${oldest.name} の伝説が、語り継がれるうちに揺らぎ始めている……。`, "dim");
    }
  }
  save();
}
// 書記 act2「系譜をたどる」：現キャラの系譜（先代→現キャラ）と継いだものを表示。
async function lineageScene() {
  busy = true;
  const ch = world.current!;
  const lin = ch.lineage;
  const anc = lin.ancestorFossilId ? world.fossils.find((f) => f.id === lin.ancestorFossilId) : undefined;
  const rel = lin.relation === "blood" ? "血を継ぐ者" : lin.relation === "pupil" ? "教えを継ぐ者" : "誰の系譜にも連ならぬ者";
  const rows: SheetRow[] = anc
    ? [
        { label: "先代", value: anc.origin.name },
        { label: "最期", value: `深度${anc.death.depth}・${poleLabel(anc.tonePole)}の極` },
        { label: "続柄", value: `その${rel}` },
        { text: `継いだもの：${ch.traits.filter((t) => t.includes(anc.origin.name)).join("、") || "（薄き面影のみ）"}` },
      ]
    : [{ label: "続柄", value: rel }, { text: "先代の記録は、まだ街にない。", dim: true }];
  await sheet({ text: "老書記イェンは系譜の綴りを開いた。", sections: [{ rows }], meta: "書記 ── 系譜をたどる", options: ["閉じる"] });
  busy = false;
}
/** 相棒と別れる（解散）＝無料。等級/絆/偉業を生者NPCへ残し、相棒は街へ（再雇用可）。護衛依頼中なら失敗。 */
function dismissCompanion(): void {
  if (!world.companion?.alive) return;
  const name = companionName();
  if (world.companion.escortQuestId) for (const l of failEscortQuest(world, world.companion.escortQuestId)) log(l, "warn");
  persistCompanionRecord();
  world.companion = undefined;
  log(`${name}と別れた。「また入用があれば、声をかけな」。`, "cue");
  save();
}
/** 相棒を見る（4-14C）＝等級・絆・偉業・連帯深蝕・強さの目安・奇癖を一覧し、別れる（解散）こともできる。
 *  ステータス画面／ギルド台帳の両方から到達＝解散導線を見つけやすく（テストプレイFB）。相棒に「レベル」は無く等級で表す。 */
async function companionSheet(): Promise<void> {
  if (!world.companion?.alive) {
    await sheet({ text: "いま、共に潜る相棒はいない。\n酒場の「相棒を探す」や、フロアで手負いの冒険者を救うと、仲間になる。", meta: "相棒", options: ["閉じる"] });
    return;
  }
  busy = true;
  for (;;) {
    const c = world.companion; if (!c?.alive) break;
    const rows: SheetRow[] = [
      { label: "等級", value: GRADE_LABELS[c.grade] },
      { label: "絆（生還）", value: String(c.bond), note: "共に生還で深まる" },
      { label: "偉業", value: String(c.feats ?? 0), note: "ボス撃破・山場" },
      { label: "連帯深蝕", value: c.exposure.toFixed(2), cls: "exp", note: "潜行で上がる" },
      { label: "強さの目安", value: `HP ${companionMaxHp(c.grade)}・攻 ${companionDmg(c.grade)}`, note: "等級と深さで増す" },
    ];
    if (c.escortQuestId) rows.push({ text: "護衛の依頼人として同行中（別れると依頼は失敗）", cls: "warn" });
    const sections: SheetSection[] = [{ rows }];
    if (c.traits?.length) sections.push({ header: "奇癖（連帯深蝕）", rows: c.traits.map((t) => ({ text: t.replace(/^奇癖[:：]/, "") })) });
    const title = `${c.actor.epithet ? c.actor.epithet + "・" : ""}${c.actor.name}`;
    const opts: SheetOption[] = [{ label: "相棒と別れる（解散）", role: "danger" }, "閉じる"];
    const r = await sheet({ text: `《${title}》　${c.actor.archetype}`, meta: `相棒 ── ${GRADE_LABELS[c.grade]}`, sections, options: opts });
    busy = false;
    if (optLabel(opts[r.pick - 1] ?? "") !== "相棒と別れる（解散）") break;
    const cf = await sheet({
      text: `${companionName()}と別れるか。\n相棒は街に残り、また雇える（等級・絆・偉業は引き継がれる）。${c.escortQuestId ? "\n※護衛の依頼は失敗になる。" : ""}`,
      meta: "確認 ── 相棒と別れる", options: [{ label: "別れる", role: "danger" }, "やめておく"],
    });
    if (cf.pick === 1) { dismissCompanion(); break; }
    busy = true;
  }
  busy = false;
}
// ギルド act1「等級・英雄譜を見る」：現キャラの等級＋world.tracked の英雄譜を一覧（4-4）。
async function heroRoll() {
  busy = true;
  const ch = world.current!;
  const legends = world.tracked.filter((t) => t.source === "player_legend").length;
  // 相棒の等級（4-4E ⤴）：雇用中の相棒がいれば等級を併記し、ここから解散もできる（4-14C 契約）。
  const hired = world.companion?.alive ? world.companion : null;
  const topRows: SheetRow[] = [
    { label: "あなたの等級", value: GRADE_LABELS[playerGrade()] },
    { label: "遺した伝説", value: `${legends} 柱` },
  ];
  if (hired) {
    topRows.push({ label: "雇用中の相棒", value: `${hired.actor.name}（${GRADE_LABELS[hired.grade]}）` });
    topRows.push({ text: `生還${hired.bond}・偉業${hired.feats ?? 0}／道中の金貨は折半。「相棒を見る」で詳細・解散。`, dim: true });
  }
  const rollRows: SheetRow[] = world.tracked.length
    ? world.tracked.map((t) => ({ text: `${t.name}（${TRACK_SOURCE_LABEL[t.source] ?? t.source}／${ARC_LABEL[t.arcType] ?? t.arcType}）── 現在：${arcStageLabel(t)}` }))
    : [{ text: "まだ誰の名もない", dim: true }];
  const canRetire = playerGrade() >= 2; // 退隠＝確立した者（銀以上）のみ。ボーナスは更に功績比例（雪だるま防止・4-14G）。
  const opts: string[] = [];
  if (hired) opts.push(`相棒を見る（${hired.actor.name}）`);
  if (canRetire) opts.push("退いて次代に託す（襲名・この物語を終える）");
  opts.push("閉じる");
  const r = await sheet({
    text: "ギルド長は台帳を繰る。",
    sections: [{ rows: topRows }, { header: "英雄譜", rows: rollRows }],
    meta: "ギルド ── 等級・英雄譜（4-4）", options: opts,
  });
  busy = false;
  const label = opts[r.pick - 1];
  if (label?.startsWith("相棒を見る")) {
    await companionSheet(); // 相棒の詳細（等級・絆・偉業…）＋別れる（解散）。
  } else if (label === "退いて次代に託す（襲名・この物語を終える）") {
    await retireFlow();
  }
}

/** 退隠＝襲名（4-14G・層2）：街で自ら家督を次代に譲る。死とは別の「物語の終い方」＝
 *  先代は伝説（守護者NPC）として残り、襲名する後継に術と装備を手厚く遺す（功績比例）。 */
async function retireFlow() {
  const ch = world.current!;
  const r = await sheet({
    text: `${ch.name}（Lv${ch.level}・《${GRADE_LABELS[playerGrade()]}》）。\n\n剣を置き、次代に家督を譲るか。\n──これは、この物語の“終い方”だ。${ch.name}は伝説として街に残り（街角で後進を見守る守護者となる）、家督を襲名する後継に、覚えた術と身につけた装備を手厚く遺す。\nだが、この者で奉献を目指す道は、ここで閉じる。`,
    meta: "退隠 ── 次代に託す（4-14G）",
    options: ["家督を譲る（退隠する）", "まだ退かない"],
  });
  if (r.pick !== 1) return;
  busy = true;
  sfx("seal");
  const f = retireCurrent(world);
  if (world.town?.returnPortal) clearPortal(); // 先代の帰還の扉（駐機）は次代へ引き継がない（あの階は先代のもの）
  log(`${f.origin.name}は探索者の列を退いた。その名は、伝説として英雄譜に刻まれる。`, "warn");
  save();
  await characterCreation();   // 後継を作成（襲名すれば術＋装備を手厚く継ぐ）
  refreshRetireGuardians();    // 退いた英雄を街角の守護者として常駐させる（再雇用可）
  busy = false;
  leaveBuilding();             // 後継として街路へ出る
}
/** ギルドで等級を正式認定する（4-4E）。前回認定(recognizedGrade)を超えた分だけ、段ごとに昇格イベントを演出。 */
async function checkRankUp() {
  const ch = world.current; if (!ch) return;
  const cur = playerGrade();
  const known = world.recognizedGrade ?? 0;
  if (cur <= known) return;
  busy = true;
  for (let g = known + 1; g <= cur; g++) {
    await rankUpScene(g);
    if (g === 2 && !world.homeUnlocked) await grantHomeScene(); // 銀昇格＝倒れた先達の家を継いで自宅を解禁（4-10C）
  }
  world.recognizedGrade = cur;
  save();
  busy = false;
}

/** 銀昇格イベント（強制・一度きり・4-10C）：倒れた先達の家を継いで自宅（武具庫）を解禁。 */
async function grantHomeScene() {
  const fallen = world.fossils.filter((f) => f.kind === "character" || f.kind === "explorer");
  const name = fallen.length ? rng.pick(fallen).origin.name : mintActor(db, rng).name;
  const gm = townGrid.data.keepers["guild"]?.name ?? "ギルド長";
  world.homeUnlocked = true;
  sfx("seal");
  await sheet({
    text: `${gm}が、一本の古い鍵を差し出した。\n「銀に上がった祝いだ。──少し前に、${name}という冒険者が深みから還らなかった。身寄りもなく、住まいが空いたままでな。\nお前が継ぐといい。武具を仕舞う場所くらい、一人前には要るだろう」`,
    meta: "倒れた者の家を継ぐ ── 自宅を得た", options: ["ありがたく受け取る"],
  });
  log("自宅（武具庫）を手に入れた。住宅区の我が家で、武具や薬を世代を越えて保管できる。", "cue");
  chronicle(world, "legend", `${world.current!.name}が、還らなかった${name}の家を継いだ。`, [world.current!.id]);
  save();
}

/** 昇格イベント本体。銅銀＝簡素／金＝賞賛／白金＝英傑（荘重）／秘銀＝ギルドマスター登場の小イベント（4-4E）。 */
async function rankUpScene(g: number) {
  const ch = world.current!;
  const gm = townGrid.data.keepers["guild"]?.name ?? "ギルド長";
  const label = GRADE_LABELS[g];
  if (g <= 2) { // ブロンズ/シルバー＝簡素なメッセージと共に昇格
    sfx("quest");
    await sheet({
      text: `${gm}が台帳に新しい印を押した。\n「${label}。確かに認めた。${g === 1 ? "一人前への入り口だ。気を抜くなよ" : "お前の名も、少しずつ知られてきたな"}」`,
      meta: `昇格 ── ${label}`, options: ["頭を下げる"],
    });
  } else if (g === 3) { // ゴールド＝賞賛のメッセージと共に昇格
    sfx("seal");
    await sheet({
      text: `${gm}は手を止め、しばしあなたの顔を見た。\n「${label}。──精鋭の証だ。深みでお前の名を聞く者が増えてきた。\n胸を張れ。だが、深淵はここからが本番だぞ」\n居合わせた冒険者たちが、静かにあなたへ目をやった。`,
      meta: `昇格 ── ${label}`, options: ["頭を下げる"],
    });
    chronicle(world, "legend", `${ch.name}がゴールド（精鋭）に列せられた。`, [ch.id]);
  } else if (g === 4) { // プラチナ＝英傑（荘重な賞賛）
    sfx("seal");
    await sheet({
      text: `その報せは、酒場にまで届いていた。\n${gm}は背筋を伸ばし、深く頭を下げた。\n「${label}。──英傑の段だ。生きてここまで至る者は、この街にも数えるほどしかいない。\nお前の名は、もう伝説の隣にある」`,
      meta: `昇格 ── ${label}`, options: ["静かに頷く"],
    });
    chronicle(world, "legend", `${ch.name}がプラチナ（英傑）に列せられた。`, [ch.id]);
  } else { // ミスリル＝ギルドマスター登場・ちょっとしたイベントと共に昇格（生きて至る稀有な頂点）
    sfx("boss");
    await sheet({
      text: `その日、ギルドの空気が変わった。\n奥の扉が音もなく開き、滅多に表へ出ぬ《ギルドマスター》が、自らあなたの前に立った。\n古い傷の刻まれた手に、秘銀色の小さな記章を握っている。`,
      meta: "ミスリル ── 秘銀の段", options: ["顔を上げる"],
    });
    sfx("seal");
    await sheet({
      text: `「生きて、ここまで至ったか」。\n《ギルドマスター》は記章をあなたの胸に留めた。\n「${label}。──秘銀の段。死してミスリルを贈られる者は数あれど、生きて至った者を、私は片手で数えられる。\nお前も、その一人だ。……ようこそ、こちら側へ」。\n台帳の最後の頁に、あなたの名が刻まれた。`,
      meta: "ミスリル ── 秘銀の段", options: ["記章を受け取る"],
    });
    chronicle(world, "legend", `${ch.name}が、生きてミスリル（秘銀・神話）に至った。`, [ch.id]);
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
// 固定NPCの「一言」を kind ごとに短く（挨拶の後ろに付く役割フック）。世代/系譜/名声で変わる挨拶と合成する。
const KEEPER_HOOK: Record<string, string> = {
  guild: "腕の立つ者には、いい依頼を回すよ。",
  smith: "その得物、見てやろう。刃こぼれは命取りだ。",
  smith_armor: "防具のことなら任せな。",
  store: "下で死なないための物は、ここで揃う。",
  tavern: "まずは一杯、おいき。",
  archive: "君の物語も、ここに記そう。",
  cult: "深淵は、すべてを赦し変える。",
  oddments: "いわく付きの品を探すなら、ここだ。",
  shrine: "還らなかった魂に、祈りを。",
  healer: "深蝕の進み、診てやろうか。",
  home: "ゆっくりしておいき。",
  house: "足下に気をつけて。",
};
/** 固定NPCの挨拶を世代・系譜・名声で動的に選ぶ（テストPB：1代目なのに「先代の働き」と言う辻褄崩れを是正＋
 *  代を重ね・名を上げるほど反応が多様化）。初代・無名・無系譜は作り込んだ第一印象（d.line）をそのまま使う。
 *  優先度：奉献者 ＞ 高名 ＞ 系譜 ＞ 世代を重ねた街 ＞ 新顔。毎訪問で rng.pick＝同じ状態でも少し変わる。 */
function keeperGreeting(kind: string, d: { name: string; title: string; line: string }): string {
  const ch = world.current;
  const anc = ch && ch.lineage.relation !== "none" && ch.lineage.ancestorFossilId
    ? world.fossils.find((f) => f.id === ch.lineage.ancestorFossilId) : undefined;
  const grade = worldPlayerGrade(world, ch?.level ?? 1);
  const seals = world.seals?.length ?? 0;
  const ascended = world.ascended ?? 0;
  const legends = (world.tracked ?? []).filter((t) => t.source === "player_legend").length;
  let openers: string[] | null = null;
  // 役割が「主人公の状態」に関わるNPC（薬師・酒場）は、深蝕が実際に濃い時だけそれに言及する
  //  （0なのに「深蝕が進んでいる」と言う辻褄崩れを防ぐ＋濃さで段階変化）。低い時は通常の挨拶へ。
  if (ch && ch.exposure >= 1.2 && (kind === "healer" || kind === "tavern")) {
    const heavy = ch.exposure >= 1.8;
    if (kind === "healer") openers = heavy
      ? ["深蝕がかなり進んでいる……早く手を打たねば。", "ひどい蝕みだ。完全には抜けんが、進みは遅らせよう。"]
      : ["深蝕が進んでいるね。完全には抜けんが、少し遅らせることはできる。"];
    else openers = heavy
      ? ["顔色が悪いよ。深蝕が、ずいぶん濃い。無理をしすぎだ。", "ひどい澱みを背負っているね……まず一杯、おいき。"]
      : ["深蝕が滲んでいるね。根を詰めすぎだ。まず一杯おいき。"];
  } else if (ascended > 0) {
    openers = ["奉献を成した御方が、こうして顔を出すとは。", "深淵を越えた者よ、よくぞ此処へ。", "あなたの名は、もう街の伝説だ。"];
  } else if (grade >= 3 || legends >= 1 || seals >= 3) {
    openers = [`${GRADE_LABELS[Math.max(0, Math.min(5, grade))]}の名は、聞き及んでいるよ。`, "その名、灰の街に轟いている。", "歴戦の御仁とお見受けする。"];
  } else if (anc) {
    openers = [`${anc.origin.name}の血筋か。覚えがある。`, `${anc.origin.name}の面影が、君にあるな。`, `${anc.origin.name}の遺志を継ぐ者か。先代の働きに免じよう。`];
  } else if (world.generation > 1) {
    openers = ["また新たな代が、この街に降りたか。", "代替わりか……時の流れは速いね。", "見ない顔だ。先達の多くは、深みへ還ってしまった。"];
  }
  if (!openers) return d.line; // 初代・無名・無系譜＝作り込んだ第一印象
  const hook = KEEPER_HOOK[kind] ?? "";
  const opener = rng.pick(openers);
  return hook ? `${opener}${hook}` : opener;
}

// 店主種別 → storylet context（その店主が語る vignette のプール。該当しない固定NPCは null＝vignette なし）。
const KEEPER_VIGNETTE_CHANCE = 0.35; // 店主に話しかけた時、メニュー前に小イベントを挿む確率（要テストプレイ調整）
function keeperContextFor(kind: string): TownContext | null {
  if (kind === "tavern") return "tavern";
  if (kind === "guild") return "guild";
  if (SHOP_INTERIORS.has(kind)) return "shop";
  return null; // 書記/教団/慰霊堂/自宅/民家＝固定の語りのみ（vignette 対象外）
}
async function talkKeeper(asKind?: string) {
  if (busy || !interior) return;
  const kind = asKind ?? interior.kind;
  const d = townGrid.data.keepers[kind];
  if (kind === "guild") await checkRankUp(); // 等級の正式認定＝昇格イベント（4-4E）
  if (kind === "guild" || kind === "home" || kind === "manor" || kind === "audience") await maybeGrantManor(); // 館/格上げの告知（終盤メタ・4-14G・冪等）
  if (kind === "archive") { await maybeAurelIntro(); await maybeAurelFinale(); } // メインの縦糸（4-15）：序章／終章＝書記の館
  if (kind === "cult") await maybeAurelCult(); // メインの縦糸（4-15）：第三章＝教団の「声」
  if (busy || !interior) return; // 昇格イベント中に状況が変わっていないか再確認
  // 店主目線の小イベント（4-4B 辻褄整合）：時々、固定の挨拶＋メニューの前に「店主本人が語る」一幕を挟む。
  // 話者＝その店主＝#origin_name# は店主名で充填（雑踏のランダム冒険者と取り違えない）。商い導線は後続でそのまま到達。
  const kctx = keeperContextFor(kind);
  if (kctx && world.current && rng.next() < KEEPER_VIGNETTE_CHANCE) {
    const ch = world.current;
    const keeperActor: Actor = { name: d.name, archetype: d.title, gearTags: [] }; // 異名/装備/口癖は持たない＝#origin_name# だけ解決
    const keeperLa: LivingActor = { id: d.actorId ?? ("keeper_" + kind), actor: keeperActor, metGeneration: world.generation };
    const sl = selectKeeperStorylet(db, world, ch, kctx, rng, keeperLa, recentSet());
    if (sl && sl.choices && sl.choices.length) {
      noteEvent(sl.id);
      busy = true;
      const c = await sheet({
        text: `${d.name} ── ${d.title}\n\n${fillActorText(keeperActor, sl.text ?? "")}`,
        meta: "固定NPC（第2層）", options: sl.choices.map((o) => o.label),
      });
      const choice = sl.choices[c.pick - 1];
      const ov: string[] = [];
      const lines = choice ? applyActorEffects(world, ch, keeperLa, choice.effects, ov) : [];
      // 店主は店に常駐する固定NPC＝雑踏/常連/名簿に漏らさない。applyActorEffects は bond/plant 等で
      //  rememberActor(world, la) を呼び world.actors に積むため、店主idは取り除く（meetActor/townRegularsFor/
      //  pickRaidAlly が店主を「通行人」「常連」「共闘者」として拾う事故を防ぐ）。bond/flag は ch.bonds/world.flags 側に残る。
      if (world.actors) world.actors = world.actors.filter((a) => a.id !== keeperLa.id);
      const body = [choice?.text ? fillActorText(keeperActor, choice.text) : "", ...lines].filter(Boolean).join("\n");
      if (body) await sheet({ text: body, meta: `${d.name} ── ${d.title}`, options: ["戻る"] });
      await resolveOverflow(ch, ov);
      busy = false; save();
      if (!interior) return; // vignette 中に状況が変わっていないか
    }
  }
  busy = true;
  const r = await sheet({
    text: `${d.name} ── ${d.title}\n\n「${keeperGreeting(kind, d)}」`,
    meta: "固定NPC（第2層）",
    options: [...d.acts, "立ち去る"],
  });
  busy = false;
  const actIdx = r.pick - 1;
  if (actIdx < 0 || actIdx >= d.acts.length) return; // 立ち去る
  // 既存機能の結線（機能後退させない）。他の動詞は後続 content 拡充で実装。
  if (kind === "tavern" && actIdx === 0) return void rumorScene();      // 噂を聞く
  if (kind === "tavern" && actIdx === 1) return void tavernLore();      // 旧き名・化石のことを尋ねる
  if (kind === "tavern" && actIdx === 2) return void tavernRest();      // 休む（一杯やる）
  if (kind === "tavern" && actIdx === 3) return void questBoard("tavern"); // 仕事の口＝酒場の貼り紙（第2の依頼源・2026-07-02）
  if (kind === "tavern" && actIdx === 4) return void tavernSendoff();   // 門出の一杯（次の潜行の景気づけバフ）
  if (kind === "tavern" && actIdx === 5) return void tavernRecruit();   // 相棒を探す（勧誘・再雇用の明示的な場）
  // 旧 act6「裏取引」は廃止（2026-07-03）。秘宝は深層レアドロップ＋大命褒賞で入手。
  if (kind === "archive" && actIdx === 0) return void chronicleScene(); // 年代記を読む
  if (kind === "archive" && actIdx === 1) return void legendApprove();  // 旧キャラを伝説として承認する（4-4）
  if (kind === "archive" && actIdx === 2) return void lineageScene();   // 系譜をたどる
  if (kind === "archive" && actIdx === 3) return void keepsakeShelf();  // 拾得品を読み返す（読み物コレクション）
  if (kind === "smith" && actIdx === 0) return void smithBuyKind("weapon"); // 武器を買う
  if (kind === "smith" && actIdx === 1) return void smithSell();         // 拾い物を売る（袋を買い取る）
  if (kind === "smith" && actIdx === 2) return void smithLore();         // 先代の刻印武器について訊く（4-11E）
  if (kind === "smith" && actIdx === 3) return void smithReforge();      // 打ち直し（+N を上げる・ルートシステム）
  if (kind === "smith_armor" && actIdx === 0) return void smithBuyKind("armor"); // 防具を買う
  if (kind === "smith_armor" && actIdx === 1) return void smithSell();    // 拾い物を売る（防具担当でも武器/防具とも買い取る＝武具屋は同じ店）
  if (kind === "smith_armor" && actIdx === 2) return void smithReforge(); // 打ち直し（防具担当でも可）
  if (kind === "healer" && actIdx === 0) return void healerHeal();      // 傷を癒す（街は基本全快＝flavor）
  if (kind === "healer" && actIdx === 1) return void healerTreat();     // 深蝕の進行を診てもらう
  if (kind === "healer" && actIdx === 2) return void healerBuy();       // 薬を買う（医薬は薬師の本領）
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
  if (kind === "oddments" && actIdx === 1) return void oddmentsBuy();   // 奇妙な異物を買う（未鑑定の賭け）
  if (kind === "oddments" && actIdx === 2) return void oddmentsLore();  // 品の曰くを聞く（異物の由来 flavor）
  if (kind === "store" && actIdx === 0) return void storeBuy();         // 消耗品を買う
  if (kind === "store" && actIdx === 1) return void storeSell();        // 異物・拾い物を売る
  if (kind === "store" && actIdx === 2) return void storeManage();      // 携行品を整える（使う/捨てる）
  if (kind === "home" && actIdx === 0) return void homeDeposit();       // 保管庫に預ける
  if (kind === "home" && actIdx === 1) return void homeWithdraw();      // 保管庫から引き出す
  if (kind === "home" && actIdx === 2) return void homeView();          // 物入れを検める
  if (kind === "home" && actIdx === 3) return void lineageHallScene();   // 系譜の間（家系図・4-14G 層3）
  if (kind === "manor" && actIdx === 0) return void homeDeposit();       // 館：保管庫に預ける（自宅と同一在庫・4-14G 層4b）
  if (kind === "manor" && actIdx === 1) return void homeWithdraw();      // 館：保管庫から引き出す
  if (kind === "manor" && actIdx === 2) return void lineageHallScene();  // 館：系譜の間（大広間）
  if (kind === "audience" && actIdx === 0) return void audienceScene();  // 謁見の間：統治者に謁見する（4-14G 層4b）
  if (kind === "audience" && actIdx === 1) return void questBoard("noble"); // 謁見の間：統治者の大命を受ける
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
    if (interior.kind === "manor" || interior.kind === "audience") return ["noble", "street"]; // 貴族街の館/謁見の間（4-14G 後続）
    if (SHOP_INTERIORS.has(interior.kind)) return ["shop", "street"];
    return ["street"]; // 書記/教団/慰霊堂/民家など：街路の一般プールのみ
  }
  // 貴族街区画（仕切り壁 y8 より上）を歩いている＝宮廷の顔（noble）＋街路の一般プール（4-14G 後続）。
  if (mode === "town" && nobleQuarterOpen() && townPlayer.y < townGrid.data.partitionWallY) return ["noble", "street"];
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
    const isRegular = (a as { regular?: boolean }).regular === true;
    const head = `${la.actor.epithet ?? ""}${la.actor.name}（${la.actor.archetype}）${isRegular ? " ── 馴染みの顔" : ""}`;
    // 馴染みの常連との再会（街差分・4-4/4-6C）：世代に一度だけ温かい一言＋小さな手向け（farm防止＝flag冪等）。
    const reunion: string[] = [];
    if (isRegular) {
      const fkey = `reg_seen_${la.id}_g${world.generation}`;
      if (!(world.flags ?? []).includes(fkey)) {
        (world.flags ??= []).push(fkey);
        const bond = ch.bonds.find((b) => b.entityRef === la.id);
        if (bond) bond.value += 1; else ch.bonds.push({ entityRef: la.id, value: 1, unfinished: false });
        ch.exposure = Math.max(0, ch.exposure - 0.03);
        reunion.push("「また会えたな。あんたが生きて還るたび、こっちも少し安心するよ」。見知った顔が迷宮の外にもいる――それだけで、強張りがほどけていく。");
      } else {
        reunion.push("「よう、また来たか」。馴染みの顔が、軽く杯を掲げてみせた。");
      }
    }
    const sl = selectTownStorylet(db, world, ch, la, rng, townContextsHere(), recentSet());
    if (sl) noteEvent(sl.id);
    // 同行の勧誘（4-14C 入口）：相棒が居らず、迷宮の話が通じる相手なら「同行を頼む」を添える。
    const canRecruit = !world.companion?.alive;
    const recruitOpt = "同行を頼む";
    if (sl && sl.choices) {
      const intro = [head, ...reunion, fillActorText(la.actor, sl.text ?? "")].filter(Boolean).join("\n\n");
      const c = await sheet({ text: intro, options: sl.choices.map((o) => o.label) });
      const choice = sl.choices[c.pick - 1];
      const ov: string[] = [];
      const lines = applyActorEffects(world, ch, la, choice.effects, ov);
      // 閉じる語は場面に合わせる（酒場の屋内なら「席を立つ」、それ以外＝立ち話なら「話を切り上げる」）。
      const leave = mode === "interior" && interior?.kind === "tavern" ? "席を立つ" : "話を切り上げる";
      const r = await sheet({
        text: [choice.text ? fillActorText(la.actor, choice.text) : "", ...lines].filter(Boolean).join("\n"),
        options: canRecruit ? [leave, recruitOpt] : [leave],
      });
      await resolveOverflow(ch, ov);
      if (canRecruit && r.pick === 2) await offerCompanion(la);
      save();
    } else {
      const r = await sheet({
        text: [head, ...reunion, "「……」と、ことば少なに会釈を返された。"].filter(Boolean).join("\n\n"),
        meta: isRegular ? "馴染みの常連" : "街路の出会い", options: canRecruit ? ["うなずいて別れる", recruitOpt] : ["うなずいて別れる"],
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
  // 奉献者には門番が一目置く（解禁ではなく言及・Phase4）。門は閉じたまま＝Lv45「原初の証」アークと両立。
  const line = getArc(world, "noble_ack")
    ? "……あんたの名は、奥にも届いている。統治者が口にしていたよ。だが、門は門だ。招かれぬ限り、ここは通せん。"
    : g.line;
  await sheet({ text: `${g.name} ── 貴族街の門番\n\n「${line}」`, meta: "封鎖ゾーン（将来解禁フック）", options: ["引き返す"] });
  busy = false;
}
async function promptDescend() {
  if (busy) return;
  const preUnlocked = abyssUnlocked(world);
  if (preUnlocked) await maybeAurelMira(); // メインの縦糸（4-15）：第四章＝5印が揃った迷宮の口で、道を示す者
  if (busy) return;
  busy = true;
  const unlocked = preUnlocked;
  // 帰還の扉を駐機中（ボス撃破後）：ここから新規に潜ると、あの階への帰り道は閉じる（慰霊碑の扉が消える）。
  const parked = world.town?.returnPortal ? `\n（慰霊碑の傍に、あの階〔深度${world.town.returnPortal.depth}〕へ戻る帰還の扉が開いている。ここから新しく潜ると、その帰り道は閉じる）` : "";
  const opts = unlocked
    ? ["潜行する（迷宮へ降りる）", "奉献の試練へ潜る（深淵帯・聖遺物を持ち帰る）", "とどまる"]
    : ["潜行する（迷宮へ降りる）", "とどまる"];
  const r = await sheet({
    text: (unlocked
      ? "迷宮の口に立った。\n五つの印が揃い、門の奥に封じられた道――深淵帯への階が、ほの暗く口を開けている。"
      : "迷宮の口に立った。潜行するか？") + parked,
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
  const nobleOpen = nobleQuarterOpen(); // 貴族街解禁（奉献クリア後）＝門と区画を歩ける（4-14G 層4b）
  if (t === "ngate") {
    if (!nobleOpen) { log("固く閉ざされた門。門番が見張っている。", "dim"); return; }
    // 解禁時は門を通り抜ける（下の移動処理へ）
  }
  const p = townGrid.propMap.get(`${nx},${ny}`);
  if (p && monumentKey === `${nx},${ny}`) { void monumentScene(); return; } // 奉献の像＝専用シート（Phase4）
  if (p && guardianKeys.has(`${nx},${ny}`)) { void guardianScene(guardianKeys.get(`${nx},${ny}`)!); return; } // 引退した英雄＝会話（運命の弧 4-6D）
  if (p && courtKeys.has(`${nx},${ny}`)) { void courtNpcScene(courtKeys.get(`${nx},${ny}`)!); return; } // 宮廷NPC＝家令/廷臣/再会の客人（4-14G 後続）
  if (p && cenotaphKey === `${nx},${ny}`) { void memorialScene(); return; } // 慰霊碑＝歴代の死者を読む（街の差分 4-6C）
  if (p && portalKey === `${nx},${ny}`) { void useReturnPortal(); return; } // 帰還の扉（街側・一回だけ）＝あの階へ戻る
  const walkable = t === "floor" || t === "gate" || (nobleOpen && (t === "noble" || t === "ngate")); // 貴族街解禁で noble/ngate も歩行可
  if (!walkable) { if (p?.line) log(p.line, "dim"); return; }
  // 景物（木・井戸・碑）は塞ぐ。ただし walkable な景物（供花＝地面に手向けた物）は跨いで歩ける＝上に乗ると一言だけ添える。
  if (p && t !== "gate" && !p.walkable) { if (p.line) log(p.line, "dim"); return; }
  if (p?.walkable && p.line) log(p.line, "dim");
  townPlayer = { x: nx, y: ny };
  sfx("move");
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
  sfx("move");
  drawInterior();
  persistTown();
}

// 血縁：先代の遺した術から継ぐ2つを自分で選ぶ（回復/帰還を最初から持てる質の継承）。
// 先代が2つ以下しか遺していなければ全継承（UIなし）。決定論には影響しない（プレイヤー選択）。
async function pickBloodSpells(anc: Fossil): Promise<string[]> {
  const avail = (anc.spells ?? []).filter((k) => spellByKey(k));
  if (avail.length <= BLOOD_SPELLS) return avail.slice();
  const chosen: string[] = [];
  while (chosen.length < BLOOD_SPELLS) {
    const rest = avail.filter((k) => !chosen.includes(k));
    const r = await sheet({
      text: `${anc.origin.name}の遺した術のうち、血に継ぐものを選べ（${chosen.length + 1}/${BLOOD_SPELLS}）。`,
      meta: "系譜 ── 継ぐ術を選ぶ",
      options: rest.map((k) => { const s = spellByKey(k)!; return `[${s.school}] ${s.name}（深蝕＋${s.cost}／${s.desc}）`; }),
    });
    const key = rest[r.pick - 1];
    if (key) chosen.push(key);
  }
  return chosen;
}

// 深蝕の累積（4-11H）：難易度 exposure 係数を掛けて溜める。easy=×1.0（従来）／normal=×1.2／hard=×1.4。
// プレイヤーの深蝕加点はすべてここを通す（減算/清めは別経路＝据え置き）。
const ADAPT_EXP_MUL = 0.4; // 秘宝 adapt（深淵順応の鎧）：深蝕の蓄積(正)をこの割合に（＝60%軽減）
function addExp(amount: number): void {
  if (!world.current) return;
  // 秘宝 adapt（深淵順応の鎧）：深蝕の蓄積（正の量）を大幅軽減＝異物/術を使うビルドの核。
  if (amount > 0 && world.current.equipment.armor?.proc === "adapt") amount *= ADAPT_EXP_MUL;
  world.current.exposure += amount * diffMods(world.difficulty).exposure;
}
// 深蝕を祓う（正の量）。教団の烙印（exposureBrand・一時）／永続汚染（exposureTaint）より下には祓えない＝買い戻し不能の実リスク。
// 反復・購入で祓える各所（薬師/慰霊堂の祈り/安息所/解呪術/鎮静薬）はこれを通す。烙印は enterFloor で taint まで薄れる。
function cleanseExposure(ch: Character, amount: number): void {
  const floor = Math.max(ch.exposureBrand ?? 0, ch.exposureTaint ?? 0);
  ch.exposure = Math.max(floor, ch.exposure - amount);
}

// 潜行開始時の回復量（4-11H）。難易度 townHeal が <1 なら満タンに戻らない＝消耗（attrition）が生まれる。
// easy/normal=1.0＝全回復（従来どおり）。街そのものに戦闘はないので、潜行入口の HP だけが効く。
function townHealHp(): number {
  const ch = world.current!;
  return Math.max(1, Math.round(maxHp(ch) * diffMods(world.difficulty).townHeal));
}

// 新規ワールドの最初の一度だけ、難易度を選ぶ（4-11H）。以後この世界で固定＝途中変更なし。
// 旧セーブは migrate で "easy" に設定済み＝再プロンプトされない（grandfather）。
async function chooseDifficultyIfNew(): Promise<void> {
  if (world.difficulty !== undefined) return; // 既に決まっている＝再プロンプトしない
  const opts = SELECTABLE_DIFFICULTIES.map((d) => `${DIFFICULTY_LABEL[d]}\n${DIFFICULTY_BLURB[d]}`);
  const r = await sheet({
    text: "この世界の手応えを選ぶ。\n――一度決めたら、この世界では変えられない。",
    meta: "難易度 ── 世界のはじまりに一度だけ",
    options: opts,
  });
  world.difficulty = SELECTABLE_DIFFICULTIES[r.pick - 1] ?? "normal";
  log(`難易度：${DIFFICULTY_LABEL[world.difficulty]}。この世界では変えられない。`, "cue");
  save();
}

// ---------- キャラ作成（系譜 4-10D） ----------
async function characterCreation() {
  await chooseDifficultyIfNew(); // 新規ワールドのみ：難易度を一度だけ選ぶ（以後この世界で固定）
  const name = (await sheet({
    text: "新たな探索者が、迷宮の口に立つ。", meta: "名を入力（空欄なら仮名）",
    options: ["この名で始める"], input: "名前",
  })).text.trim() || `名無し${world.generation}`;

  const ancestors = world.fossils.filter((f) => f.kind === "character").slice(-4).reverse();
  const heirs = ancestors.filter((f) => f.retired).slice(0, 2);   // 退隠した先代＝襲名候補（4-14G）
  const dead = ancestors.filter((f) => !f.retired).slice(0, 3);   // 斃れた先代＝血縁/弟子候補
  let lineage: Character["lineage"] = { relation: "none" };
  let heirAnc: Fossil | undefined;
  if (heirs.length || dead.length) {
    const opts = [
      ...heirs.map((f) => `${f.origin.name}の家督を襲名する（術を手厚く継ぎ・遺された装備を相続＝伝説の家系）`),
      ...dead.map((f) => `${f.origin.name}の血縁として（術を2つ選び継ぐ・地力が恒久的に高い＝大器晩成）`),
      ...dead.map((f) => `${f.origin.name}の弟子として（術4つを継ぎ・高いレベルから始まる＝先行逃げ切り）`),
      "誰とも関わりなく（継承なし・しがらみもなし）",
    ];
    const r = await sheet({ text: "お前は、誰の物語を継ぐ？\n（襲名＝退いた英雄の家督を継ぐ最も手厚い継承／血縁＝伸びしろ／弟子＝先行逃げ切り）", options: opts });
    const nH = heirs.length, nD = dead.length;
    if (r.pick <= nH) {
      heirAnc = heirs[r.pick - 1];
      lineage = { relation: "heir", ancestorFossilId: heirAnc.id };
    } else if (r.pick <= nH + nD) {
      const anc = dead[r.pick - nH - 1];
      lineage = { relation: "blood", ancestorFossilId: anc.id, chosenSpells: await pickBloodSpells(anc) };
    } else if (r.pick <= nH + nD * 2) {
      lineage = { relation: "pupil", ancestorFossilId: dead[r.pick - nH - nD - 1].id };
    }
  }
  const ch = createCharacter(world, name, "wanderer", lineage);
  // 襲名の装備相続（4-14G・層2）：退隠した先代が身につけていた装備を、散逸させず heir が直接継ぐ。
  if (heirAnc) {
    for (const gname of heirAnc.origin.gearTags) {
      const it = itemByName(gname);
      if (it && !ch.equipment[it.slot]) { it.unidentified = false; ch.equipment[it.slot] = it; }
    }
    log(`${heirAnc.origin.name}の遺した装備を受け継いだ。家督とともに。`, "cue");
  }
  // 序盤の丸腰を解消（テストプレイFB 2026-07-03・案A・ユーザー承認）：装備の空きスロットに最低限の支給品
  // （短刀＝攻+1／革鎧＝被ダメ-1・鑑定済み）を配る。継承で得た装備があればそちらを優先＝上書きしない。
  // 冒険者が丸腰で潜る不自然さの解消＝支給は最弱基ゆえ「終始シビア」の数値曲線は崩さない（序盤だけを緩める）。
  if (!ch.equipment.weapon) { const w = forgeItem("短刀", null, 0); if (w) { w.unidentified = false; ch.equipment.weapon = w; } }
  if (!ch.equipment.armor)  { const a = forgeItem("革鎧", null, 0); if (a) { a.unidentified = false; ch.equipment.armor = a; } }
  // 家格の恩恵（4-14G 層3）：家が栄えるほど、次の当主は家の蓄え（治癒の膏薬・餞別）を携えて発つ＝微小。
  const hr = houseRank();
  if (hr.tier >= 1) {
    const salves = Math.min(world.manorUnlocked ? 4 : 3, hr.tier); // 館は蓄えが手厚い（微小・4-14G 層4）
    for (let i = 0; i < salves; i++) addConsumable(ch, "salve");
    ch.gold += hr.tier * 5;
    log(`《${hr.label}》の蓄えから、治癒の膏薬×${salves}と餞別${hr.tier * 5}金貨を授かった。`, "dim");
  }
  hp = maxHp(ch);
  const intro = lineage.relation === "none"
    ? `${ch.name}は、何も受け継がず、支給の短刀と革鎧だけを手に迷宮へ向かう（${statsLine(ch)}）。`
    : `${ch.name}は先代の${lineage.relation === "blood" ? "血" : "教え"}を継いで迷宮へ向かう（Lv${ch.level}・${statsLine(ch)}）。`;
  log(intro, "dim");
  if (ch.bonds.some((b) => b.unfinished)) log("……先代の未完の因縁が、お前に引き継がれた。", "warn");
  await maybeIntro(); // 初回のみ：迷宮／HPは街で癒える（死だけが残る）／深蝕は薬師、の導入（4-4B）
  save();
}

/** ゲーム開始の導入（強制・初回ワールドのみ・4-4B）：迷宮／「死だけが覆らない＝HP は街で癒える」／深蝕は薬師、を世界観として語る。
 *  バランス不変・純テキスト。intro_seen で冪等（リセット後の新ワールドでは再び語る＝新規プレイヤーの初回オンボーディング）。 */
async function maybeIntro() {
  if ((world.flags ?? []).includes("intro_seen")) return;
  (world.flags ??= []).push("intro_seen"); // 先に立てる＝中断しても再演しない
  busy = true;
  await sheet({
    text: "灰の街の中央に、ぽっかりと迷宮の口が開いている。冷たい風が、底から吹き上げてくる。\nお前は、そこへ潜る者の一人だ――深く潜るほど、見たことのない景色と、見たくなかったものに出会うだろう。",
    meta: "深蝕 ── はじめに", options: ["……潜る覚悟はある"],
  });
  await sheet({
    text: "ひとつ、知っておくといい。\nこの街へ生きて還れば、傷はすべて癒える。疲れも痛みも、まるで無かったかのように。\n――この地が覆せないのは、ただ一つ「死」だけだ。倒れた者は深みで化石となり、その物語は次の世代へ受け継がれていく。",
    meta: "はじめに ── 死だけが残る", options: ["……心に刻む"],
  });
  await sheet({
    text: "もう一つ。深く潜る者の身には「深蝕」が滲む。深みの理が、少しずつお前を侵していく。\n街の薬師なら、金貨と引き換えにそれを祓ってくれる。画面上部の深蝕のゲージに、気を配れ。",
    meta: "はじめに ── 深蝕と薬師", options: ["わかった"],
  });
  busy = false;
}

// ---------- 街（歩ける固定マップ。門 ">" で潜行＝この Promise を解決） ----------
// ---------- アンビエント街イベント（4-12 J）：潜行帰還時に稀に起きる"街規模の出来事" ----------
// 1帰還につき最大1件。各型は固有のクールダウン（型ごとに頻度を変える）＋全体の発生確率で間引く。
// 4-12 J：イベントのレベル帯ゲート（~Lv50 スケール・2026-06-17 ユーザー承認）。
// 早期1-10／中期11-25／後期26-40／超期45+。低レベルでまとめて着火させない。
const BAND = { raid: 11, plague: 14, memorial: 4, omen: 20, noble: 45 };
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
  if ((world.omenCooldown ?? 0) > 0) world.omenCooldown = (world.omenCooldown ?? 0) - 1;
  // 発火可能（冷却0＋レベル帯＋固有条件）な型を集める
  const pool: { w: number; run: () => Promise<void> }[] = [];
  if (ch.level >= BAND.raid && (world.raidCooldown ?? 0) === 0) pool.push({ w: 2, run: townRaidScene });           // 脅威（中期〜）
  if (ch.level >= BAND.memorial && (world.memorialCooldown ?? 0) === 0 && world.fossils.some((f) => f.kind === "character")) pool.push({ w: 3, run: townMemorialScene }); // 好機（定期）
  if (ch.level >= BAND.plague && (world.plagueCooldown ?? 0) === 0) pool.push({ w: 2, run: townPlagueScene }); // 災厄（中期〜）
  if (ch.level >= BAND.omen && (world.omenCooldown ?? 0) === 0) pool.push({ w: 2, run: townOmenScene }); // 兆し（後期〜）
  if (pool.length === 0 || rng.next() >= 0.4) return; // 毎帰還は起きない（多くは静穏）
  const total = pool.reduce((a, b) => a + b.w, 0);
  let r = rng.next() * total;
  for (const a of pool) { r -= a.w; if (r <= 0) { await a.run(); return; } }
}

// 深みの兆し（後期帯 Lv20+・監査B4）：深く潜った者として知られるほど、街に滲む深蝕の予兆を「読んで」ほしいと請われる。
// 脅威でも災厄でもない第三の顔＝世界が主人公の深度に反応する静かな出来事。tier で報酬/深蝕を深部規模に。
async function townOmenScene(): Promise<void> {
  busy = true;
  const ch = world.current!;
  world.omenCooldown = 12 + Math.floor(rng.next() * 7); // 次の兆しまで最短12〜18帰還
  const tier = Math.min(5, 1 + Math.floor(ch.level / 10)); // 規模＝報酬/深蝕の係数（Lv10ごとに+1・Lv50で頭打ち）
  const sign = rng.pick(["井戸の水が、墨のように黒く濁った", "幼子が、誰にも分からぬ言葉で深みの唄を口ずさむ", "石壁に、化石めいた紋がひとりでに浮かび上がった", "夜ごと、地の底から鐘のような響きが昇ってくる"]);
  sfx("drain"); flashFx("warp");
  log("街の片隅に、深みの兆しが滲んでいる。", "warn");
  const r1 = await sheet({
    text: `潜行から戻ると、街の者がお前を呼び止めた。「${sign}。あんたは、底をよく知るお人だ……これが何か、読めやしないか」\n深く潜った者にしか、この兆しの意味は分かるまい。`,
    meta: "深みの兆し", options: ["源を辿り、兆しを読む（理・識）", "鎮めの所作を施す（心）", "関わらない"],
  });
  if (r1.pick === 1) {
    if (ch.stats.reason + ch.stats.heart >= 6) {
      const gold = 12 * tier;
      ch.gold += gold;
      const t = `地相を読む者:第${world.generation}世代`;
      if (!ch.traits.includes(t)) ch.traits.push(t);
      chronicle(world, "rediscovery", `第${world.generation}世代、${ch.name}は街に滲む深みの兆しを読み解いた。`, [ch.id]);
      sfx("seal");
      await sheet({ text: `お前は兆しの源を辿り、深みの理の一端を街の者に説いた。人々は怖れながらも、お前の言葉に縋った。\n\n謝礼として ${gold} 金貨を得た。`, options: ["街へ戻る"] });
    } else {
      addExp(0.08 * tier);
      await sheet({ text: "お前は兆しを読もうと深みに意識を凝らした。だが、覗き返してくる何かに、わずかに引きずられた。\n\n（深蝕がうずいた）", options: ["街へ戻る"] });
    }
  } else if (r1.pick === 2) {
    if (ch.stats.heart >= 4) {
      ch.exposure = Math.max(0, ch.exposure - 0.12 * tier); // 街のために祈り、己の澱みも少し晴れる
      ch.gold += 5 * tier;
      const t = `鎮める手:第${world.generation}世代`;
      if (!ch.traits.includes(t)) ch.traits.push(t);
      sfx("intervene");
      await sheet({ text: "お前は古い鎮めの所作を施した。墨の水は澄み、唄は止んだ。街の者が、震える手で礼の硬貨を握らせてくる。\n\n（張りつめていた何かが、少し和らいだ）", options: ["街へ戻る"] });
    } else {
      await sheet({ text: "見様見真似で所作を施したが、兆しは薄れも濃くもならなかった。人々は、それでも頭を下げた。", options: ["街へ戻る"] });
    }
  } else {
    await sheet({ text: "お前は兆しに背を向けた。底の事は、底に置いていくのが利口というもの。\n背に、街の者の不安げな視線が残った。", options: ["街へ戻る"] });
  }
  busy = false;
}

// 街襲撃（4-12J）＝3規模。小＝テキスト寸劇（即決）／中・大＝盤上の防衛戦（迎え撃つ／手早く捌くを選択）。
// 規模はレベル帯で決める（早期は小・中盤は中・高レベルは大）。盤上戦は迷宮の戦闘エンジンを街の特設戦場で回す。
async function townRaidScene(): Promise<void> {
  const ch = world.current!;
  world.raidCooldown = 14 + Math.floor(rng.next() * 7); // 次の襲撃まで最短14〜20帰還（一度起きたら長く空く）
  const tier = Math.min(6, 1 + Math.floor(ch.level / 8));
  const scale: "small" | "medium" | "large" = ch.level >= 34 ? "large" : ch.level >= 20 ? "medium" : "small";
  if (scale === "small") { await raidTextScene(tier); return; } // 小規模＝従来のテキスト寸劇
  // 中・大規模：街マップで実際に迎え撃つか、采配だけで手早く捌くか。
  busy = true;
  sfx("hurt"); flashFx("warp");
  log("警鐘——街が、襲われている。", "warn");
  const r = await sheet({
    text: scale === "large"
      ? "街へ戻ると、半鐘がけたたましく鳴り渡っていた。迷宮の口が大きく裂け、深層の獣が街路へ雪崩れ込んでくる。冒険者たちが武器を取り、逃げ遅れた者が悲鳴をあげる。総力戦だ――お前は、どうする？"
      : "街へ戻ると、警鐘が鳴っていた。広場に深層の獣が湧き出している。居合わせた冒険者が身構える。お前は、どうする？",
    meta: scale === "large" ? "街の防衛 ── 総力戦" : "街の防衛 ── 襲撃",
    options: ["街で共に迎え撃つ（盤上で戦う）", "采配で手早く捌く（テキスト）"],
  });
  busy = false;
  if (r.pick === 1) await enterRaid(scale, tier);
  else await raidTextScene(tier);
}

// 小規模／「手早く捌く」＝テキスト寸劇（従来の街襲撃）。報酬/深蝕は tier で規模化。
async function raidTextScene(tier: number): Promise<void> {
  busy = true;
  const ch = world.current!;
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
  if (exposure > 0) addExp(exposure);
  const got = item && addConsumable(ch, item) ? consumableByKey(item)?.name : null;
  chronicle(world, "legend", `第${world.generation}世代、${ch.name}は街を襲った深層の獣を退けた。`, [ch.id]);
  sfx("intervene");
  await sheet({
    text: `静けさが戻った。街の者たちが、口々に礼を述べる。\n\n〔報酬〕金貨 ＋${gold}${got ? `／${got}` : ""}${exposure > 0 ? `\n浴びた深み ＋${exposure.toFixed(2)}` : ""}`,
    meta: "街の防衛 ── 鎮静", options: ["街へ"],
  });
  updateStatus(); save(); busy = false;
}

// ========== 街防衛戦（街襲撃の盤上化・4-12J／4-14 共闘）：迷宮の戦闘エンジンを街の特設戦場で回す ==========
// 味方＝共闘する冒険者（縁あるNPC優先＝再会）。市民＝守る対象（大規模）。敵＝wave で押し寄せ、大規模は最後にボス。
// プレイヤー死＝通常の死（deathFlow）／味方の戦死＝化石化（後世で再会）／市民の喪失＝年代記。
interface RaidAlly extends CompanionEntity { name: string; actor: Actor; actorId?: string; grade: number; }
interface RaidCivic extends Pos { hp: number; }
interface RaidState {
  scale: "small" | "medium" | "large"; tier: number; pseudoDepth: number;
  wave: number; totalWaves: number; bossSpawned: boolean;
  spawnZone: Pos[]; killed: number; civicsSaved: number; civicsLost: number;
  fallen: RaidAlly[];
}

/** 戦場のあるマスが他者で塞がっているか（敵スポーン位置の選別に使う）。 */
function raidOccupied(p: Pos): boolean {
  if (!floor) return true;
  return floor.monsters.some((m) => m.hp > 0 && m.x === p.x && m.y === p.y)
    || (player.x === p.x && player.y === p.y)
    || allies.some((a) => a.hp > 0 && a.x === p.x && a.y === p.y)
    || civics.some((c) => c.hp > 0 && c.x === p.x && c.y === p.y);
}
/** ある味方の移動で避ける相手（他の味方＋市民。プレイヤーは planCompanion 内で別途回避）。 */
const allyBlockers = (self: RaidAlly): Pos[] => [...allies.filter((a) => a !== self && a.hp > 0), ...civics.filter((c) => c.hp > 0)];

/** 共闘する冒険者を1体抽選：縁あるNPC（再会）優先→名簿→新規。 */
function pickRaidAlly(): { name: string; actor: Actor; actorId?: string; grade: number } {
  const remembered = (world.actors ?? []).filter((la) => la.actor && la.actor.alive !== false);
  if (remembered.length && rng.next() < 0.6) {
    const la = rng.pick(remembered);
    return { name: la.actor.name, actor: la.actor, actorId: la.id, grade: Math.min(4, la.actor.grade ?? 1) };
  }
  const roster = pickRosterActor(world, db, rng);
  if (roster) return { name: roster.actor.name, actor: roster.actor, actorId: roster.id, grade: Math.min(4, roster.actor.grade ?? 1) };
  const a = mintActor(db, rng, {}, fossilNames(world));
  return { name: a.name, actor: a, grade: 1 + rng.int(3) };
}

/** 1波ぶんのモンスターを湧き口（上辺）に出す。数＝規模×波×tier。種は擬似深度でスケール。 */
function spawnRaidWave(): void {
  if (!floor || !raid) return;
  const r = raid; // クロージャ内では module let の絞り込みが失われるため局所化
  const base = r.scale === "large" ? 6 : 4;
  const count = base + r.wave + Math.floor(r.tier / 2);
  const pool = MONSTER_KINDS.filter((k) => k.minDepth <= r.pseudoDepth && (k.maxDepth === undefined || r.pseudoDepth <= k.maxDepth));
  for (let i = 0; i < count; i++) {
    const free = r.spawnZone.filter((p) => !raidOccupied(p));
    const p = free.length ? free[rng.int(free.length)] : r.spawnZone[rng.int(r.spawnZone.length)];
    const k = scaleKind(pool[rng.int(pool.length)], r.pseudoDepth, diffMods(world.difficulty)); // 街防衛も難易度に追従（4-11H）
    floor.monsters.push({ id: `raid_${r.wave}_${i}_${floor.monsters.length}`, kind: k, hp: k.hp, x: p.x, y: p.y, awake: true, intent: null });
  }
}
/** 大規模の山場：襲撃の主（エリアボス・厚いHP＋戦術化）。 */
function spawnRaidBoss(): void {
  if (!floor || !raid) return;
  const bk = scaleKind({ key: "raidboss", glyph: "Ω", name: "襲撃の主", hp: 30, dmg: 7, minDepth: 1, erratic: 0.05, tier: 5 }, raid.pseudoDepth, diffMods(world.difficulty));
  bk.hp = bk.hp * 3 + 20; // エリアボス相当の堅さ（makeAreaBoss に倣う）
  const free = raid.spawnZone.filter((p) => !raidOccupied(p));
  const p = free.length ? free[rng.int(free.length)] : raid.spawnZone[0];
  floor.monsters.push({ id: "raid_boss", kind: bk, hp: bk.hp, x: p.x, y: p.y, awake: true, intent: null, boss: "area" });
}

/** 街防衛戦に突入（中・大規模）。戦闘が終わるまで解決しない Promise を返す＝maybeTownEvent の await を保持。 */
function enterRaid(scale: "small" | "medium" | "large", tier: number): Promise<void> {
  const ch = world.current!;
  stopWander();
  const pseudoDepth = Math.min(ABYSS_DEPTH - 1, Math.max(3, tier * 6)); // 擬似深度＝敵スケール（tier1≈6 … tier6=36）
  const seed = (world.seed ^ (world.generation * 131) ^ ((world.diveCount ?? 0) * 7) ^ (ch.level * 1009)) >>> 0;
  const field = genRaidField(seed, scale, pseudoDepth);
  floor = field.floor;
  player = { ...field.playerStart };
  hp = maxHp(ch); ch.depth = 0; // 街＝癒えた状態から
  mode = "raid";
  mapMode = false; aim = null; // 地図/照準の持ち越しを断つ
  // 共闘する冒険者を配置（大=3〜5／中=1〜2）。
  allies = [];
  const allyCount = scale === "large" ? 3 + rng.int(3) : 1 + rng.int(2);
  for (let i = 0; i < allyCount && i < field.allySpots.length; i++) {
    const pick = pickRaidAlly();
    allies.push({
      ...field.allySpots[i], hp: companionMaxHp(pick.grade, pseudoDepth), maxHp: companionMaxHp(pick.grade, pseudoDepth),
      dmg: companionDmg(pick.grade, pseudoDepth), intent: null, name: pick.name, actor: pick.actor, actorId: pick.actorId, grade: pick.grade,
    });
  }
  // 逃げ遅れた市民（大規模のみ＝守る対象）。
  civics = scale === "large" ? field.civicSpots.map((p) => ({ ...p, hp: 1 })) : [];
  raid = { scale, tier, pseudoDepth, wave: 1, totalWaves: scale === "large" ? 3 : 2, bossSpawned: false, spawnZone: field.spawnZone, killed: 0, civicsSaved: 0, civicsLost: 0, fallen: [] };
  buildGridDom(VIEW_W, VIEW_H);
  applyDepthBand(pseudoDepth); // 街防衛戦も擬似深度で松明の色調を合わせる（v0.99.0）
  setAmbient(true, pseudoDepth);
  setBgm(scale === "large" ? "abyss" : "dungeon", pseudoDepth);
  applyChrome();
  spawnRaidWave();
  planMonsters(floor, player, rng, null, allies);
  for (const a of allies) planCompanion(floor, player, a, rng, allyBlockers(a));
  draw(); updateStatus();
  log(scale === "large"
    ? "総力戦――冒険者たちと肩を並べ、街路に雪崩れ込む獣を迎え撃て。逃げ遅れた者（民）を、獣の手から守れ。"
    : "迎え撃て――広場に湧く獣を、居合わせた冒険者と討ち払え。", "warn");
  log("（移動＝攻撃／術・持ち物も使える。下辺は自陣＝味方）", "dim");
  return new Promise<void>((res) => { raidResolve = res; });
}

/** 街防衛戦のプレイヤー入力：移動＝攻撃。市民へ踏み込む＝避難誘導／味方は位置入替。 */
async function raidAct(dx: number, dy: number): Promise<void> {
  if (busy || overlayEl.classList.contains("show") || mode !== "raid" || !floor || !world.current) return;
  ensureAudio();
  hidePeek();
  if (!(dx === 0 && dy === 0)) {
    if (!raidMoveOrAttack(player.x + dx, player.y + dy)) return; // 壁/不可＝手番を消費しない
  }
  if (busy) { draw(); return; } // 途中でシートが開いた
  await raidEndTurn();
}
/** 戦場での一歩：敵＝攻撃／市民＝避難誘導／味方＝入替／空き＝移動。階段・宝箱等は無い。 */
function raidMoveOrAttack(nx: number, ny: number): boolean {
  const f = floor!;
  if (tileAt(f, nx, ny) !== 1) return false;
  const mon = f.monsters.find((m) => m.hp > 0 && m.x === nx && m.y === ny);
  if (mon) {
    const ch = world.current!;
    const hitR = meleeWithPositioning(meleeDmg(ch) + (attackBuffTurns > 0 ? ATTACK_BUFF : 0), mon); // 挟撃/見切り反撃（C/D・raidは共闘者が多く挟撃が輝く）
    const dmg = hitR.dmg;
    mon.hp -= dmg; sfx(mon.boss ? "crit" : "hit");
    floatFx(nx, ny, String(dmg), hitR.crit ? "fl-crit" : "fl-dmg"); // 命中フラッシュ（敵グリフの白重ね）は視認性のため廃止＝数字だけ残す（FB 2026-07-03）
    if (mon.hp <= 0) raidKill(mon); else log(`${mon.kind.name}に${dmg}の一撃。`);
    return true;
  }
  const cv = civics.find((c) => c.hp > 0 && c.x === nx && c.y === ny);
  if (cv) { cv.hp = 0; raid!.civicsSaved++; sfx("buy"); log("逃げ遅れた者を、安全な路地へ逃がした。", "cue"); return true; }
  const ae = allies.find((a) => a.hp > 0 && a.x === nx && a.y === ny);
  if (ae) { ae.x = player.x; ae.y = player.y; player = { x: nx, y: ny }; sfx("move"); return true; }
  player = { x: nx, y: ny }; sfx("move"); return true;
}
/** 街防衛戦の撃破処理（XP・撃破数・ボス処遇）。dive の rewardKill とは別＝迷宮の年代記/扉を出さない。 */
/** 撃破XP（web の全授与経路を一本化・v0.121.0 オーバーレベル対策）＝基礎×greed（難易度別）×難易度xp×深度係留。
 *  深度係留＝格下狩り逓減：Lv が「深度+2」を超えたぶんだけXPが痩せる（倍率 1/(1+xpTether×超過)）。
 *  深度相応で戦う限り不変＝序盤の手応えそのまま。全踏破・再潜行farmでも Lv が深度+3前後に自然収束し、
 *  「成長が深度を追い越して全深度が平坦化する」構造を封じる。easy は xpTether=0・greedMul=1.5＝従来どおり（快適モード）。 */
function killXpFor(monHp: number, depth: number, frac = 1): number {
  const ch = world.current!;
  const mods = diffMods(world.difficulty);
  const greed = ch.equipment?.relic?.relic === "greed" ? mods.greedMul : 1;
  const tether = 1 / (1 + mods.xpTether * Math.max(0, ch.level - depth - 2));
  return Math.round(xpForKill(monHp) * frac * greed * mods.xp * tether);
}
function raidKill(mon: Monster): void {
  floatFx(mon.x, mon.y, "＊", "fl-kill");
  const ch = world.current!;
  ch.xp += killXpFor(mon.kind.hp, raid?.pseudoDepth ?? 10);
  if (raid) raid.killed++;
  if (mon.boss) {
    sfx("boss_down"); flashFx("warp");
    log(`★ ${mon.kind.name}を打ち倒した！`, "warn");
    pendingDrops.push(rollItem(raid?.pseudoDepth ?? 10, rng, { boss: true }));
  } else sfx("kill");
}

/** 街防衛戦の一手（味方→敵→市民被害→波/ボス進行→勝敗）。術/持ち物/melee が turnPass 経由でここへ。 */
async function raidEndTurn(): Promise<void> {
  if (!floor || !world.current || !raid) return;
  const ch = world.current;
  if (armorBuffTurns > 0) armorBuffTurns--;
  if (counterTurns > 0) counterTurns--; // 反撃の好機は短い（見切った直後の1〜2手だけ）
  if (attackBuffTurns > 0) attackBuffTurns--;
  const hasted = hasteTurns > 0; if (hasteTurns > 0) hasteTurns--;
  if (deathDoorTurns > 0) { deathDoorTurns--; if (deathDoorTurns === 0) { addExp(0.4); log("死戸が閉じる……（深蝕＋0.4）。", "warn"); } }
  for (const m of floor.monsters) if (m.hp > 0 && m.poison && m.poison > 0) { const pd = m.poisonDmg ?? 1; m.hp -= pd; m.poison--; floatFx(m.x, m.y, String(pd), "fl-dmg"); if (m.hp <= 0) raidKill(m); }
  if (poisonTurns > 0) { poisonTurns--; if (deathDoorTurns === 0) { hp -= poisonDmg; sfx("drain"); log(`毒が回る……（HP -${poisonDmg}）`, "warn"); } }
  resolveSummons();
  if (hasted) log("疾走――もう一手。", "dim");
  if (!hasted) {
    // 味方の手番（隣接敵を討つ／@に追従）。
    for (const a of allies) {
      if (a.hp <= 0) continue;
      const cr = resolveCompanion(floor, player, a, allyBlockers(a));
      if (cr.hit) { sfx("hit"); if (cr.hit.hp <= 0) { log(`${a.name}が${cr.hit.kind.name}を討ち取った。`); raidKill(cr.hit); } else log(`${a.name}が${cr.hit.kind.name}に${cr.dmg}の一撃。`, "dim"); }
    }
    // 敵の手番（標的＝@ or 味方の近い方）。
    const res = resolveMonsters(floor, player, null, allies);
    if (res.hits.length) sfx("hurt", 0.14);
    for (const h of res.hits) {
      if (h.target === "companion") {
        const a = allies.find((x) => x.hp > 0 && x.x === h.tx && x.y === h.ty);
        if (a) { a.hp -= h.dmg; floatFx(a.x, a.y, String(h.dmg), "fl-hurt"); log(`${h.monster.kind.name}の一撃が${a.name}を襲う！ ${h.dmg}の傷。`, "warn"); if (a.hp <= 0) log(`${a.name}が斃れた……。`, "warn"); }
      } else {
        let dmg = Math.max(1, Math.ceil(h.dmg * diffMods(world.difficulty).chipFrac), h.dmg - armorReduce(ch) - (armorBuffTurns > 0 ? ARMOR_BUFF : 0)); // 比例チップ（v0.121.0・raid も同式）
        if (deathDoorTurns > 0) dmg = 0;
        if (dmg > 0 && shadowGuard > 0) { shadowGuard--; dmg = 0; log(`${h.monster.kind.name}の一撃を、影が引き受けた。`, "dim"); }
        else if (h.effect === "heavy") { hp -= dmg; sfx("boss", 0.16); flashFx("warp"); floatFx(player.x, player.y, String(dmg), "fl-hurt"); log(`${h.monster.kind.name}の渾身の一撃！ ${dmg}の大ダメージ。`, "warn"); }
        else { hp -= dmg; floatFx(player.x, player.y, String(dmg), "fl-hurt"); log(`${h.monster.kind.name}の一撃！ ${dmg}の傷。`, "warn"); if (h.effect === "poison") { poisonTurns = Math.max(poisonTurns, VENOM_TURNS); poisonDmg = Math.max(poisonDmg, venomDmgAt(raid.pseudoDepth)); log("牙に毒が仕込まれていた。", "warn"); } }
      }
    }
    for (const m of res.dodges) log(`${m.kind.name}の一撃を見切った。`, "dim");
    if (res.dodges.length > 0 && hp > 0) { // D. 見切り反撃は raid でも同じ読み合い
      if (counterTurns === 0) { tileFx(player.x, player.y, "tfx-ready"); floatFx(player.x, player.y, "反撃の好機", "fl-dmg"); log("空振りの隙が見えた――反撃の好機。", "cue"); }
      counterTurns = COUNTER_WINDOW;
    }
    for (const a of allies) if (a.hp <= 0 && !raid.fallen.includes(a)) raid.fallen.push(a);
    // 市民への被害：隣接した獣が、逃げ遅れた者を呑む（守れなかった＝喪失）。
    for (const cv of civics) {
      if (cv.hp <= 0) continue;
      if (floor.monsters.some((m) => m.hp > 0 && Math.max(Math.abs(m.x - cv.x), Math.abs(m.y - cv.y)) <= 1)) { cv.hp = 0; raid.civicsLost++; sfx("hurt"); log("逃げ遅れた者が、獣に呑まれた……。", "warn"); }
    }
  }
  recordBestiary();
  if (hp <= 0) { draw(); updateStatus(); await raidDefeat(); return; }
  // 波／ボスの進行。
  const aliveMon = floor.monsters.filter((m) => m.hp > 0).length;
  if (aliveMon === 0) {
    if (raid.wave < raid.totalWaves) { raid.wave++; spawnRaidWave(); sfx("hurt"); log(`第${raid.wave}波――まだ来る。`, "warn"); }
    else if (raid.scale === "large" && !raid.bossSpawned) { raid.bossSpawned = true; spawnRaidBoss(); sfx("boss"); flashFx("warp"); log("地が揺れる――瓦礫を割って、一際大きな影が現れた。", "warn"); }
    else { planMonsters(floor, player, rng, null, allies); draw(); updateStatus(); await raidVictory(); return; }
  }
  planMonsters(floor, player, rng, null, allies);
  for (const a of allies) if (a.hp > 0) planCompanion(floor, player, a, rng, allyBlockers(a));
  draw(); updateStatus();
  await handleLevelUps();
  await handleDrops();
}

/** 戦死した味方を化石化（後世で再会＝4-14）。勝敗どちらでも呼ぶ。 */
function fossilizeRaidFallen(): void {
  if (!raid) return;
  for (const a of allies) if (a.hp <= 0 && !raid.fallen.includes(a)) raid.fallen.push(a);
  for (const a of raid.fallen) fossilizeCompanion(world, a.actor, { depth: raid.pseudoDepth, exposure: 0.6, bond: 1 });
}
/** 戦場の後片付け（盤上 ephemeral とバフ/毒/召喚をクリア）。 */
function clearRaidBoard(): void {
  raid = null; allies = []; civics = []; floor = null;
  armorBuffTurns = attackBuffTurns = hasteTurns = deathDoorTurns = poisonTurns = poisonDmg = shadowGuard = counterTurns = 0;
  summons = [];
}
/** 勝利＝街へ。報酬（規模×tier＋撃破＋救助＋生存仲間）・称号・年代記・戦死仲間の化石化。 */
async function raidVictory(): Promise<void> {
  busy = true;
  await handleLevelUps(); await handleDrops();
  const ch = world.current!; const r = raid!;
  let gold = (r.scale === "large" ? 20 : 12) * r.tier + r.killed + r.civicsSaved * 4;
  const survivors = allies.filter((a) => a.hp > 0).length;
  gold += survivors * 3;
  ch.gold += gold;
  const title = r.scale === "large" ? `守護者:第${world.generation}世代の総力戦` : `守護者:第${world.generation}世代の防衛`;
  if (!ch.traits.includes(title)) ch.traits.push(title);
  chronicle(world, "legend", `第${world.generation}世代、${ch.name}は街を襲った深層の獣を退けた（撃破${r.killed}${r.fallen.length ? `・斃れた仲間${r.fallen.length}` : ""}）。`, [ch.id]);
  sfx("intervene");
  fossilizeRaidFallen();
  const lines = [`〔報酬〕金貨 ＋${gold}`];
  if (r.civicsSaved) lines.push(`救った市民 ${r.civicsSaved}人`);
  if (r.civicsLost) lines.push(`喪われた者 ${r.civicsLost}人`);
  if (survivors) lines.push(`生き延びた仲間 ${survivors}人`);
  if (r.fallen.length) lines.push(`斃れた仲間 ${r.fallen.length}人（その亡骸は迷宮に還り、いつか再会するだろう）`);
  await sheet({ text: `静けさが戻った。街の者たちが、口々に礼を述べる。\n\n${lines.join("\n")}`, meta: "街の防衛 ── 鎮静", options: ["街へ"] });
  clearRaidBoard();
  busy = false; updateStatus(); save();
  const res = raidResolve; raidResolve = null; if (res) res(); // maybeTownEvent の await を解く→townLoop で街へ
}
/** 敗北＝プレイヤーの死。戦死仲間を化石化してから通常の死亡フローへ（deathFlow が次代の街ループを起こす）。 */
async function raidDefeat(): Promise<void> {
  fossilizeRaidFallen();
  raid = null; allies = []; civics = [];
  armorBuffTurns = attackBuffTurns = hasteTurns = deathDoorTurns = poisonTurns = poisonDmg = shadowGuard = counterTurns = 0; summons = [];
  raidResolve = null; // deathFlow が新しいゲームループを起こす＝この raid の await は孤児化（既存の死亡と同じ作法）
  log("街の防衛に斃れた――。", "warn");
  await deathFlow();
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
  if (exposure > 0) addExp(exposure);
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

// ---------- 奉献の碑（4-13D Phase4：メタ達成＝街の塗り替え） ----------
// 奉献（クリア）回数に応じて中央広場に像が建ち、調べると歴代の奉献者が並ぶ（snapshot 4-6C/4-13D）。
// 動的＝起動時 const の townGrid.propMap へ帰還ごと（townLoop）に注入し直す。
let monumentKey: string | null = null;
function ascendedNames(): string[] {
  return world.tracked.filter((t) => t.id.startsWith("ascended_")).map((t) => t.name);
}
function refreshAscendMonument() {
  if (monumentKey) { townGrid.propMap.delete(monumentKey); monumentKey = null; } // 前回分を消してから建て直す（二重設置防止）
  if ((world.ascended ?? 0) < 1) return;
  // 中央広場の空き床を候補から選ぶ（門への動線 x=28 列は塞がない）。群衆は床基準で自動回避。
  const cands: [number, number][] = [[30, 24], [26, 24], [30, 26], [26, 26], [30, 31], [26, 31]];
  const spot = cands.find(([x, y]) =>
    townTileAt(townGrid, x, y) === "floor" &&
    !townGrid.propMap.has(`${x},${y}`) && !townGrid.doorMap.has(`${x},${y}`) && !townGrid.guardMap.has(`${x},${y}`));
  if (!spot) return;
  const [x, y] = spot;
  monumentKey = `${x},${y}`;
  townGrid.propMap.set(monumentKey, {
    x, y, glyph: "像", color: "#e8c06a", glow: true,
    line: `奉献の像。深淵帯より聖遺物を持ち帰った者たちを讃える（奉献${world.ascended}回）。`,
  });
}
/** 奉献の像を調べる＝歴代の奉献者と回数を一覧（Phase4）。 */
async function monumentScene() {
  if (busy) return;
  busy = true;
  const n = world.ascended ?? 0;
  const names = ascendedNames();
  const lead = n <= 1
    ? "中央広場に、ひとつの像が建っている。深淵帯より聖遺物を持ち帰った者を讃える、街の新しい記念碑だ。"
    : `中央広場の像は、奉献を重ねるごとに台座を継ぎ足され、いまや街の威容のひとつだ（奉献${n}回）。`;
  const rows: SheetRow[] = names.length ? names.map((nm) => ({ text: nm })) : [{ text: "まだ名は刻まれていない", dim: true }];
  await sheet({ text: lead, sections: [{ header: "奉献を成した者", rows }], meta: "奉献の像 ── 街の記憶", options: ["立ち去る"] });
  busy = false;
}

// ---------- 貴族街の館（4-14G 層4・終盤メタ）：家格が街の地図に出る到達点＝自宅機能の格上げ ----------
/** 館（自宅機能の格上げ）の解放条件：奉献を成した（クリア）or 高家格（英傑の家系＝tier4+）。
 *  ※区画の通行（門が開く）はクリア限定＝`nobleQuarterOpen`。tier4 は自宅の蔵の充実のみ。 */
function manorEligible(): boolean { return (world.ascended ?? 0) >= 1 || houseRank().tier >= 4; }
/** 条件を満たし未解放なら一度だけ告知（統治者の grant・grantHomeScene パターン・冪等）。
 *  クリア済み＝貴族街の門が開き館/謁見の間が使える／未クリア(高家格のみ)＝自宅の蔵が充実、と文言を分ける。 */
async function maybeGrantManor() {
  if (world.manorUnlocked || !manorEligible()) return;
  world.manorUnlocked = true;
  busy = true;
  sfx("seal"); flashFx("warp");
  const hr = houseRank();
  const cleared = nobleQuarterOpen();
  await sheet({
    text: cleared
      ? `街に、統治者の使いが訪れた。\n「奉献を成した《${hr.label}》よ。──貴族街の門は、もうあなたに開かれている。家門の館を構え、いつでも玉座の間へ参られよ」\n\n貴族街が開かれた。北の門をくぐれば、家門の館と謁見の間がある。`
      : `街に、使いが訪れた。\n「《${hr.label}》の蔵は、いまや一族にふさわしい構えとなった。代々の物入れも、次代へ遺せるものも、広がっていよう」\n\n家の蔵が充実した（保管庫と相続枠が広がった）。`,
    meta: cleared ? "貴族街の解放 ── 家門の格上げ（4-14G）" : "家の蔵 ── 家門の格上げ（4-14G）", options: ["承る"],
  });
  log(cleared ? "貴族街が開かれた。北の門の奥に、家門の館と謁見の間がある。" : "家の蔵が充実した（保管庫・相続枠が広がった）。", "cue");
  chronicle(world, "legend", `${world.current?.name ?? "当主"}の家門が格上げされた（${hr.label}）。`, world.current ? [world.current.id] : []);
  busy = false;
  save();
}
/** 貴族街が歩けるか（4-14G 層4b）：奉献クリア後＝門が開き、上辺の貴族街区画（館・謁見の間）へ入れる。
 *  manorUnlocked（tier4 でも立つ・自宅格上げ）とは別軸＝区画の通行はクリア（ascended≥1）限定。 */
function nobleQuarterOpen(): boolean { return (world.ascended ?? 0) >= 1; }

/** 解禁時、貴族街の門番を退かせて門を通れるようにする（建物/装飾は town.json 静的データ）。
 *  townLoop の refresh ブロックで毎来訪呼ぶ＝`refreshAscendMonument` と同パターン・冪等。 */
function refreshNobleQuarter() {
  if (!nobleQuarterOpen()) return;
  // 門番（封鎖の番人）を guardMap から外す＝門が通行可になる（解禁後は招かれた身）。
  const gx = townGrid.data.nobleGate.x;
  for (const [k, g] of [...townGrid.guardMap]) {
    if (g.x === gx && g.y === townGrid.data.nobleGate.y + 1) townGrid.guardMap.delete(k);
  }
  // 宮廷の顔（4-14G 後続）：家令・廷臣＋再会の客人（歴代の伝説/退隠者）を区画に常駐させる（guardian 注入パターン）。
  for (const k of courtKeys.keys()) townGrid.propMap.delete(k);
  courtKeys.clear();
  courtSteward ??= mkCourtActor("steward");
  courtCourtier ??= mkCourtActor("courtier");
  // 客分の英雄＝貴族街専属の英雄（COURT_CHAMPIONS）。街の英雄からスカウトされ専属となった固定キャスト。
  // 退隠英雄（refreshRetireGuardians の街の「師」）やプレイヤーの伝説（player_legend）は宮廷の常駐には出さない
  //  ＝二重配置・死者の生者化を防ぐ（4-14G・辻褄）。プレイヤーの伝説/退隠は街の師・謁見の言及・英雄譜で讃える。
  // 世代でゆるく2名を巡回（来訪中は安定／世代を越えると顔ぶれが変わる）。
  const n = COURT_CHAMPIONS.length, g = world.generation;
  const pickedChamps = n >= 2 ? [COURT_CHAMPIONS[g % n], COURT_CHAMPIONS[(g + 1) % n]] : COURT_CHAMPIONS.slice(0, n);
  const placements: Array<{ entry: CourtEntry; glyph: string; color: string }> = [
    { entry: { role: "steward", la: courtSteward }, glyph: "家", color: "#d9b65c" },
    { entry: { role: "courtier", la: courtCourtier }, glyph: "臣", color: "#c9a8e0" },
    ...pickedChamps.map((cm) => ({ entry: { role: "guest" as const, champion: cm }, glyph: "客", color: cm.grade === "秘銀" ? "#cfe3ea" : "#e8c860" })),
  ];
  const cands: [number, number][] = [[24, 4], [29, 4], [20, 5], [35, 5], [26, 5], [30, 5], [19, 4], [36, 4]];
  let ci = 0;
  for (const pl of placements) {
    let spot: [number, number] | undefined;
    while (ci < cands.length) {
      const [x, y] = cands[ci++];
      if (townTileAt(townGrid, x, y) === "noble" && !townGrid.propMap.has(`${x},${y}`) &&
          !townGrid.doorMap.has(`${x},${y}`) && !townGrid.guardMap.has(`${x},${y}`)) { spot = [x, y]; break; }
    }
    if (!spot) break;
    const [x, y] = spot; const k = `${x},${y}`;
    courtKeys.set(k, pl.entry);
    const e = pl.entry;
    const name = e.role === "guest" ? e.champion.name : e.la.actor.name;
    const label = e.role === "guest" ? `客分の英雄（${e.champion.grade}級）` : e.role === "steward" ? "家令" : "廷臣";
    townGrid.propMap.set(k, { x, y, glyph: pl.glyph, color: pl.color, glow: e.role === "guest",
      line: `${label} ${name}。貴族街の宮廷に在る。` });
  }
}

// 宮廷NPC（家令/廷臣/客分の英雄）＝propMap key → 素性。guardianKeys と同じ管理（4-14G 後続）。
// guest＝貴族街専属の英雄（客分）。街の英雄から貴族にスカウトされ専属となった設定の固定ロスター
// （ミスリル/ゴールド数名）。退隠英雄（refreshRetireGuardians の街の「師」）とは別キャスト＝二重配置しない。
interface ChampionSpec { name: string; epithet: string; grade: "秘銀" | "金"; gear: string; catchphrase: string; blurb: string; }
const COURT_CHAMPIONS: ChampionSpec[] = [
  { name: "ガレオン", epithet: "不落の", grade: "秘銀", gear: "古強の大盾", catchphrase: "盾は、退くためにこそある",
    blurb: "幾度も深淵を覗き、ただ一人生きて帰り続けた不落の壁。その名を貴族が惜しみ、家門の盾として召し抱えた。" },
  { name: "リーゼ", epithet: "灰銀の", grade: "秘銀", gear: "細身の長剣", catchphrase: "光は、底でこそ要る",
    blurb: "深みで折れぬ剣士として街に名を馳せ、今は宮廷の守りに就く。退くことを知らぬ刃を、貴族は手放さなかった。" },
  { name: "トバイアス", epithet: "三度の", grade: "金", gear: "使い込んだ短槍",
    catchphrase: "もう一度、と思える間は終わらん", blurb: "三度、奉献の試練に挑んだ歴戦。その経験を見込まれ、若き探索者の指南役として専属に迎えられた。" },
  { name: "ネリ", epithet: "風斬りの", grade: "金", gear: "投げ刃の帯", catchphrase: "速さは、臆病者の知恵さ",
    blurb: "並ぶ者なき韋駄天として鳴らした斥候。貴族の急ぎ働きを駆け抜ける足として、宮廷に囲われた。" },
  { name: "ドルカス", epithet: "鉄腕の", grade: "金", gear: "鉄芯の棍", catchphrase: "硬いものほど、砕き甲斐がある",
    blurb: "怪力で鳴らした壁役。武と酒で宮廷を沸かせ、いつしか手放せぬ顔となった。" },
];
type CourtEntry = { role: "steward" | "courtier"; la: LivingActor } | { role: "guest"; champion: ChampionSpec };
const courtKeys = new Map<string, CourtEntry>();
let courtSteward: LivingActor | null = null;
let courtCourtier: LivingActor | null = null;
/** 家令/廷臣の生者アンカーを生成（名は mintActor／職分だけ宮廷向けに上書き）。一度生成しキャッシュ＝名が安定。 */
function mkCourtActor(role: "steward" | "courtier"): LivingActor {
  const a = mintActor(db, rng, {}, fossilNames(world));
  a.archetype = role === "steward" ? "家令" : "廷臣";
  return { id: `court_${role}`, actor: a, metGeneration: world.generation };
}
/** 宮廷NPCと語る：家令/廷臣は noble storylet を配信、再会の客人は歴代の縁者として固有の一言（4-14G 後続）。 */
async function courtNpcScene(entry: CourtEntry) {
  if (busy) return;
  busy = true;
  const ch = world.current;
  if (!ch) { busy = false; return; }
  // 再会の客人（伝説/退隠者）：まず再会の一言。
  const reunion: string[] = [];
  let la: LivingActor;
  if (entry.role === "guest") {
    // 客分の英雄＝街の英雄からスカウトされ貴族の専属となった固定キャスト（4-14G）。出自と矜持を一言で紹介。
    const cm = entry.champion;
    reunion.push(`宮廷の客分として召し抱えられているのは、かつて街に名を馳せた${cm.grade}級の英雄、${cm.epithet}${cm.name}だった。\n${cm.blurb}\n「${cm.catchphrase}」と、${cm.name}は不敵に笑った。`);
    la = { id: `court_champ_${cm.name}`, actor: { name: cm.name, archetype: "客分の英雄", gearTags: [cm.gear], epithet: cm.epithet, catchphrase: cm.catchphrase, alive: true }, metGeneration: world.generation };
  } else {
    la = entry.la;
  }
  const sl = selectTownStorylet(db, world, ch, la, rng, ["noble", "street"], recentSet(), entry.role); // 役職ゲート：役職固有 noble をその役職のNPCにだけ（4-14G・辻褄）
  if (sl) noteEvent(sl.id);
  if (sl && sl.choices) {
    const head = `${la.actor.epithet ?? ""}${la.actor.name}（${la.actor.archetype}）`;
    const intro = [head, ...reunion, fillActorText(la.actor, sl.text ?? "")].filter(Boolean).join("\n\n");
    const c = await sheet({ text: intro, options: sl.choices.map((o) => o.label) });
    const choice = sl.choices[c.pick - 1];
    const ov: string[] = [];
    const lines = applyActorEffects(world, ch, la, choice.effects, ov);
    await sheet({ text: [choice.text ? fillActorText(la.actor, choice.text) : "", ...lines].filter(Boolean).join("\n"), options: ["話を切り上げる"] });
    await resolveOverflow(ch, ov);
    save();
  } else {
    await sheet({ text: [...reunion, "宮廷の顔が、静かに会釈した。"].join("\n\n"), meta: "貴族街 ── 宮廷", options: ["うなずく"] });
  }
  busy = false;
}

/** 謁見の間：統治者と謁見する（4-14G 層4b）。奉献回数/伝説/家格を織り込んだ戴き＋当主ごと一度きりの客人の礼。 */
async function audienceScene() {
  if (busy) return;
  busy = true;
  const ch = world.current!;
  const asc = world.ascended ?? 0;
  const legendNames = world.tracked.filter((t) => t.source === "player_legend").map((t) => t.name);
  const hr = houseRank();
  // 初謁見（当主ごと一度きり）＝称号「統治者の客人」＋客人の礼（深蝕−0.3）。heir も改めて謁見できる。
  if (!ch.traits.includes("統治者の客人")) {
    const lines = [
      "玉座の間。統治者が、あなたを見て言った。",
      `「奉献を${asc}度成した者よ。深淵より聖遺物を持ち帰る者は、幾代に一人だ」`,
    ];
    if (legendNames.length) lines.push(`「あなたの家が遺した伝説は${legendNames.length}柱。英雄譜が、その名で厚くなっていく」`);
    lines.push(`「《${hr.label}》──その名に恥じぬ働きを、これからも」`);
    const r = await sheet({ text: lines.join("\n"), meta: "謁見の間 ── 統治者", options: ["客人として礼を受ける", "辞す"] });
    if (r.pick === 1) {
      ch.traits.push("統治者の客人");
      const before = ch.exposure; ch.exposure = Math.max(0, ch.exposure - 0.3); sfx("seal");
      log("記憶に『統治者の客人』が刻まれた。", "cue");
      if (ch.exposure < before) log(`謁見の場の清浄が、深みに削られた芯を人へ還す（深蝕 -${(before - ch.exposure).toFixed(2)}）。`, "dim");
      chronicle(world, "legend", `${ch.name}が統治者に謁見し、客人の礼を受けた。`, [ch.id]);
      save();
    }
    busy = false; return;
  }
  // 既に客人＝謁見の話題を回す（深淵の問い／伝説の称賛／大命の前振り／褒賞／結び）。rng で来訪ごとに変化・バランス中立。
  const topics: Array<{ text: string; opt: string; run?: () => void }> = [
    { text: "「底には、何があった。あなたは、見たのだろう」と統治者は静かに問うた。", opt: "静かに語る",
      run: () => { const b = ch.exposure; ch.exposure = Math.max(0, ch.exposure - 0.05); if (ch.exposure < b) log(`語ることで、深みの澱がわずかに晴れた（深蝕 -${(b - ch.exposure).toFixed(2)}）。`, "dim"); } },
    { text: "「深みは、まだ我らを試している。──大命がある。いつでも、この間で受けるがよい」", opt: "承る" },
    { text: `「《${hr.label}》の名は、もはや街の柱だ。お前の家が栄える限り、人は深淵を恐れずに済む」`, opt: "頭を垂れる" },
  ];
  if (legendNames.length) topics.push({ text: `「${rng.pick(legendNames)}の名を、英雄譜で見た。よき血を、よき教えを遺したな」`, opt: "礼を述べる" });
  if (asc >= 2) topics.push({ text: "統治者は傍らから金貨を掴ませた。「幾度も深淵を越えた者への、ささやかな証だ」", opt: "拝領する",
    run: () => { ch.gold += 12; sfx("coin"); log("統治者から12金貨を賜った（所持 " + ch.gold + "）。", "dim"); } });
  const topic = topics[Math.floor(rng.next() * topics.length)];
  const r = await sheet({ text: `玉座の間。\n${topic.text}`, meta: "謁見の間 ── 統治者", options: [topic.opt, "辞す"] });
  if (r.pick === 1 && topic.run) { topic.run(); save(); }
  busy = false;
}

// ---------- 運命の弧（4-6D）：retire 終端＝引退した英雄が街の守護者として常駐する（街の差分） ----------
// terminal に達した retire の tracked を、街角の固定NPC（propMap）として注入。warped 終端（深みに呑まれた）は出さない。
const guardianKeys = new Map<string, string>(); // propMap key → tracked id
function refreshRetireGuardians() {
  for (const k of guardianKeys.keys()) townGrid.propMap.delete(k);
  guardianKeys.clear();
  const retired = world.tracked.filter((t) => t.terminal && t.arcType === "retire" && t.pick !== "warped");
  if (!retired.length) return;
  // 中央広場まわりの空き床候補（門への動線 x=28 列は避ける・群衆は床基準で自動回避）。
  const cands: [number, number][] = [[26, 24], [30, 26], [26, 26], [30, 31], [26, 31], [24, 24], [32, 24], [24, 26], [32, 26], [24, 31], [32, 31]];
  let ci = 0;
  for (const t of retired) {
    let spot: [number, number] | undefined;
    while (ci < cands.length) {
      const [x, y] = cands[ci++];
      if (townTileAt(townGrid, x, y) === "floor" && !townGrid.propMap.has(`${x},${y}`) &&
          !townGrid.doorMap.has(`${x},${y}`) && !townGrid.guardMap.has(`${x},${y}`)) { spot = [x, y]; break; }
    }
    if (!spot) break; // 空き床が尽きたら以降は出さない（稀）
    const [x, y] = spot;
    const key = `${x},${y}`;
    guardianKeys.set(key, t.id);
    townGrid.propMap.set(key, {
      x, y, glyph: "師", color: "#6fcf7f", glow: true,
      line: `引退した英雄 ${t.name}。街の若い冒険者たちを見守っている。`,
    });
  }
}
/** 引退した英雄（守護者）と語る。初回は薫陶＝一度きりの小祝福（深蝕を少し清め、形質を授ける）。 */
async function guardianScene(trackedId: string) {
  if (busy) return;
  busy = true;
  const t = world.tracked.find((x) => x.id === trackedId);
  const ch = world.current;
  if (!t) { busy = false; return; }
  const flagKey = `guardian_boon_${t.id}`;
  const given = (world.flags ?? []).includes(flagKey);
  if (!given && ch) {
    (world.flags ??= []).push(flagKey);
    const before = ch.exposure;
    ch.exposure = Math.max(0, ch.exposure - 0.3); // 一度きりの小祝福（バランス中立・浅い清め）
    if (!ch.traits.includes("守護者の薫陶")) ch.traits.push("守護者の薫陶");
    chronicle(world, "legend", `${ch.name}は引退した英雄${t.name}の薫陶を受けた。`, [t.id]);
    sfx("intervene");
    const cleanse = before > ch.exposure ? `\n深みに削られた芯が、少し人へ還る（深蝕 -${(before - ch.exposure).toFixed(2)}）。` : "";
    await sheet({
      text: `街角で、引退した英雄 ${t.name} が若い冒険者たちに囲まれている。\nあなたに気づくと、目を細めて言った。\n\n「お前さんの目、昔の儂とよく似ている。……これをやろう。深みに呑まれそうになったら、儂の声を思い出せ」\n\n記憶に『守護者の薫陶』が刻まれた。${cleanse}`,
      meta: `${t.name} ── 引退した英雄（運命の弧）`, options: ["礼を言う"],
    });
    save();
  } else {
    await sheet({
      text: `${t.name} は今日も街角で、若い冒険者たちに昔語りをしている。\n「無理はするな。生きて還ってこそ、また酒が飲める」`,
      meta: `${t.name} ── 引退した英雄`, options: ["うなずく"],
    });
  }
  busy = false;
}

// ---------- 街の差分（4-6C／4-4 パリンプセスト）：慰霊碑＝歴代の死者で街が自分の史に塗り替わる ----------
// 既存の静的「碑」（town.json props）を生きた記念碑にする。悼んだ先人（world.town.memorials）と
// 歴代の自キャラ化石が層を成し、堆積に応じて広場に供花（見た目の差分）が増える。
let cenotaphKey: string | null = null;
const memorialKeys = new Set<string>();
let portalKey: string | null = null; // 慰霊碑の傍の帰還の扉（街側・一回だけ）の propMap key
/** 慰霊碑に刻まれる名（悼んだ先人＋歴代の自キャラ・重複排除）。 */
function rememberedDead(): { names: string[]; mourned: Set<string> } {
  const mourned = new Set(world.town?.memorials ?? []);
  const ownFallen = world.fossils.filter((f) => f.kind === "character").map((f) => f.origin.name);
  const names = Array.from(new Set([...(world.town?.memorials ?? []), ...ownFallen]));
  return { names, mourned };
}
function refreshMemorialSites() {
  for (const k of memorialKeys) townGrid.propMap.delete(k);
  memorialKeys.clear();
  if (portalKey) { townGrid.propMap.delete(portalKey); portalKey = null; } // 前回分を消してから建て直す（駐機解除で消える）
  if (!cenotaphKey) { // 静的な慰霊碑（glyph「碑」）の位置を一度だけ特定
    for (const [k, pr] of townGrid.propMap) if (pr.glyph === "碑") { cenotaphKey = k; break; }
  }
  const count = rememberedDead().names.length;
  if (cenotaphKey) { // 碑の説明文を堆積に応じて更新（静的 prop を動的に上書き）
    const c = townGrid.propMap.get(cenotaphKey);
    if (c) c.line = count > 0
      ? `慰霊碑。迷宮に還らなかった者たちの名が、層を成して刻まれている（${count}名）。`
      : "慰霊碑。迷宮に還らなかった者たちの名が刻まれている。";
  }
  // 帰還の扉（街側・一回だけ）：ボス撃破後の駐機があれば、慰霊碑の傍へ扉を据える（bump で useReturnPortal）。
  const portal = world.town?.returnPortal;
  if (portal) {
    const doorCands: [number, number][] = [[28, 30], [28, 32], [27, 31], [29, 31], [27, 32], [29, 32]];
    for (const [x, y] of doorCands) {
      const key = `${x},${y}`;
      if (townTileAt(townGrid, x, y) === "floor" && !townGrid.propMap.has(key) &&
          !townGrid.doorMap.has(key) && !townGrid.guardMap.has(key)) {
        townGrid.propMap.set(key, { x, y, glyph: "扉", color: "#e8c66a", glow: true,
          line: `帰還の扉。討ち倒した相手のいた あの階（深度${portal.depth}）へ、一度だけ戻れる。` });
        portalKey = key;
        break;
      }
    }
  }
  // 堆積に応じて供花を足す（見た目の差分・上限6）。碑(28,31)まわりの空き床へ。占有/非床は自動回避。
  const cands: [number, number][] = [[27, 31], [29, 31], [27, 30], [29, 30], [26, 30], [30, 30]];
  const n = Math.min(Math.floor(count / 2), cands.length); // 2名ごとに供花ひとつ
  for (let i = 0; i < n; i++) {
    const [x, y] = cands[i];
    const key = `${x},${y}`;
    if (townTileAt(townGrid, x, y) === "floor" && !townGrid.propMap.has(key) &&
        !townGrid.doorMap.has(key) && !townGrid.guardMap.has(key)) {
      townGrid.propMap.set(key, { x, y, glyph: "花", color: "#d8a8e8", glow: true, walkable: true, line: "供花。誰かが手向けた、祈りの痕跡。" });
      memorialKeys.add(key);
    }
  }
}
/** 慰霊碑を読む＝街の記憶（パリンプセスト）。悼んだ先人と歴代の自キャラが層を成す。 */
async function memorialScene() {
  if (busy) return;
  busy = true;
  const { names, mourned } = rememberedDead();
  if (!names.length) {
    await sheet({
      text: "真新しい慰霊碑。まだ、刻まれた名はない。\nいずれ、お前自身もここに名を連ねるのだろう。",
      meta: "慰霊碑 ── 街の記憶", options: ["黙礼する"],
    });
    busy = false;
    return;
  }
  const shown = names.slice(-12).reverse(); // 直近12名（新しい順・古い層は碑の底に沈む）
  const rows: SheetRow[] = shown.map((nm) => ({ text: `${nm}${mourned.has(nm) ? "　（悼）" : ""}` }));
  if (names.length > 12) rows.push({ text: `…ほか${names.length - 12}名、碑の底に沈んでいる`, dim: true });
  await sheet({
    text: "慰霊碑の前に立つ。迷宮に還らなかった者たちの名が、層を成して刻まれている。世代を重ねるほど、この碑は深くなる。（悼）＝慰霊堂で悼んだ先人。",
    sections: [{ header: "ここに眠る者たち", rows }],
    meta: `慰霊碑 ── 街の記憶（全${names.length}名）`, options: ["黙礼する"],
  });
  busy = false;
}

function townLoop(): Promise<void> {
  return new Promise((resolve) => {
    townDescendResolve = resolve;
    mode = "town"; floor = null; resetMapView(); setAmbient(false); setBgm("town"); clearDive(); // 街に戻った＝潜行スナップショット破棄（地図/照準の持ち越しも断つ）
    const t = world.town;
    crowd = spawnCrowd(townGrid, rng, t.pos ?? townGrid.data.start);
    refreshAscendMonument(); // 奉献の碑をこの来訪の最新状態に（4-13D Phase4）
    refreshRetireGuardians(); // 引退した英雄を街角に常駐（運命の弧 4-6D・retire 終端）
    refreshMemorialSites(); // 慰霊碑を堆積に応じて生きた記念碑に（街の差分 4-6C）
    refreshNobleQuarter(); // 貴族街解禁（クリア後）＝門番を退かせ門を通行可に（4-14G 層4b）
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
// viaDoor＝帰還の扉での一時帰還→再降下（同一フロアへ戻る）。護衛の到達判定を発火させない（扉の無リスク往復で escort を即達成させないため・issue4）。
function enterFloor(depth: number, fromAbove: boolean, abyss = false, viaDoor = false) {
  resetMapView(); // フロアが変わる＝古いフロアの地図/照準は無効（残すと VIEW/旧フロア寸法のグリッドで drawMapMode がクラッシュ）
  const cached = abyss ? undefined : floorCache.get(depth); // 深淵帯は毎回新規（試練）。通常階は再訪で同じ盤面を復元。
  inAbyss = abyss;
  floor = cached ?? genFloor(world, depth, abyss ? { abyss: true } : undefined);
  if (!cached && !abyss) floorCache.set(depth, floor); // 初訪のみキャッシュ
  pursuerCount = 0; turnsSinceFloor = 0;
  armorBuffTurns = 0; attackBuffTurns = 0; hasteTurns = 0; deathDoorTurns = 0; chantTurns = 0; // 術バフはフロアを跨がない（戦闘内のみ）
  poisonTurns = 0; poisonDmg = 0; // 毒もフロアを跨がない（4-11G）
  summons = []; shadowGuard = 0; counterTurns = 0; // 召喚・影分け・反撃の好機もフロアを跨がない
  mendTick = 0; // 遺物 mending の回復タイマーもフロア毎に仕切り直す（前フロアの貯めで降下直後に回復させない）
  const ch = world.current!;
  ch.depth = depth;
  if (!cached && ch.exposureBrand) ch.exposureBrand = Math.max(ch.exposureTaint ?? 0, ch.exposureBrand - BRAND_DECAY); // 教団の烙印（一時分）は潜るほど薄れる＝ただし永続汚染 exposureTaint までで止まる（新フロア初訪のみ）
  // 世界クロック（4-14G 層1）：この潜行の最深を更新（生還時に深度積分でクロックを進める）＋
  // フロンティア相対①：到達した深度までの frontierHeld 化石に reachedAt を刻む（出会う前に歪ませない）。
  world.diveMaxDepth = Math.max(world.diveMaxDepth ?? 0, depth);
  stampReached(world, depth);
  // 深蝕リワーク v2：降下・探索・移動では深蝕は増えない（じっくり攻略を罰しない）。
  // 蓄積源は①術使用（castSpell）②異物装備の毎手drip（endTurn）③聖遺物携行の毎手（endTurn）の3つだけ。
  player = { ...(fromAbove ? floor.stairsUp : floor.stairsDown) };
  if (!cached) {
    // 化石の配置（再会重み 4-7。同一潜行で会った相手は除外）。初訪のみ＝再訪で増殖しない。
    // 出現数は面積に追従（迷宮拡張に合わせて増やす＝イベント遭遇も拡張に比例）：d1≈2 / d50≈4。
    const exclude = new Set<string>(seenThisDive);
    // P2 密度正規化＋P1 序盤抑制：浅層は疎（深度1〜3は1体まで）、深いほど面積比で増える（世代で過密にしない）。
    let fossilTries = (depth >= 4 ? 2 : 1) + (depth >= 4 ? Math.min(2, Math.floor((floor.w * floor.h) / 3600)) : 0);
    // 4-10H 第二層・凪検知（因縁を浮上）：無風が続き、未完の絆を抱えているなら化石を1体上乗せ。
    // rollEncounter は未完因縁に +3.0 の重みを既に与えるため、1体増やすだけで因縁化石が盤上に出やすくなる。
    if (quietDescents >= PITY_BOND_AT && ch.bonds.some((b) => b.unfinished)) fossilTries += 1;
    for (let i = 0; i < fossilTries; i++) {
      const fossil = rollEncounter(world, ch, rng, exclude);
      if (!fossil) break;
      if (Math.abs(fossil.laidDepth - depth) <= 4 && placeFossil(floor, rng, player, fossil)) exclude.add(fossil.id);
    }
    // 入口B：手負いの冒険者を稀に配置（相棒不在時のみ＝1体限定。深度2以降）。初訪のみ。
    floor.downed = null;
    if (!world.companion?.alive && depth >= 2 && rng.next() < 0.14) {
      const at = randomFloorAway(floor, rng, player, 5);
      if (at) {
        // 手負いは一定確率で★中核の本人（名簿）＝救助/見殺しが固有名の物語になる（4-14・B）。
        const rosterLa = rng.next() < ROSTER_DOWNED_CHANCE ? pickRosterActor(world, db, rng) : null;
        floor.downed = rosterLa
          ? { id: rosterLa.id, actor: rosterLa.actor, x: at.x, y: at.y }
          : { id: `downed_${depth}_${world.generation}`, actor: mintActor(db, rng, {}, fossilNames(world)), x: at.x, y: at.y };
      }
    }
    // 入口C：同時に潜る生者の冒険者（4-14・すれ違いの軽イベント）。相棒の有無に関わらず時々／深度2以降／初訪のみ。
    floor.delver = null;
    if (depth >= 2 && rng.next() < DELVER_CHANCE) {
      const at = randomFloorAway(floor, rng, player, 5);
      // 手負いと同じマスを避ける（randomFloorAway は downed を見ないため）。
      if (at && !(floor.downed && floor.downed.x === at.x && floor.downed.y === at.y)) {
        // 時々★中核の本人（名簿）＝後で街で見かける「また会えそう」の余韻になりうる（4-14・E）。
        const rosterLa = rng.next() < ROSTER_DELVER_CHANCE ? pickRosterActor(world, db, rng) : null;
        floor.delver = rosterLa
          ? { id: rosterLa.id, actor: rosterLa.actor, x: at.x, y: at.y }
          : { id: `delver_${depth}_${world.generation}_${world.diveCount ?? 0}`, actor: mintActor(db, rng, {}, fossilNames(world)), x: at.x, y: at.y };
      }
    }
    // メインの縦糸「アウレルの遺した問い」（4-15）：章に応じ、このフロアに遺構「痕」／ライラ・境を置く。
    // 確定配置（縦糸の灯台＝迷わせない）。手負い/すれ違いと同マスなら今回は見送り（次のフロアでまた出る）。
    floor.aurelSite = null;
    if (aurelCh() === 1 && !abyss && depth >= AUREL_MARK_DEPTH) {
      const at = randomFloorAway(floor, rng, player, 6);
      if (at && !(floor.downed && floor.downed.x === at.x && floor.downed.y === at.y) && !(floor.delver && floor.delver.x === at.x && floor.delver.y === at.y)) {
        floor.aurelSite = { x: at.x, y: at.y, kind: "mark" };
        log("……この層のどこかに、灼き付いた「痕」の気配がする。", "cue");
      }
    } else if (aurelCh() === 4 && abyss) {
      const at = randomFloorAway(floor, rng, player, 6);
      if (at && !(floor.downed && floor.downed.x === at.x && floor.downed.y === at.y) && !(floor.delver && floor.delver.x === at.x && floor.delver.y === at.y)) {
        floor.aurelSite = { x: at.x, y: at.y, kind: "laila" };
        log("岩壁のどこかに、呼吸の気配がある。生きて、待っている。", "cue");
      }
    }
  }
  // 同行（4-14C）：相棒がいれば @ の隣に展開（階段は隣接で同行降下）。ephemeral＝再訪でも再展開。
  companion = null;
  if (world.companion?.alive) spawnCompanionNear(player);
  bossEnragedSeen.clear(); bossHeavySeen.clear(); // ボス告知状態をフロアごとにリセット（B）
  planMonsters(floor, player, rng, companion); // 入った瞬間に見えている敵は予告を出す
  announceBossCues(); // 入った瞬間に見えるボスの大技構えも告知（B）
  if (companion) planCompanion(floor, player, companion, rng);
  setAmbient(true, depth); // 環境ドローン（深いほど低い）
  // 場面 BGM：深淵帯=③沈淵／通常迷宮=②冷たい石の広間（深度連動で暗く低くなる）
  if (abyss) setBgm("abyss", depth); else { setBgm("dungeon", depth); setBgmDepth(depth); }
  hidePeek();
  applyDepthBand(depth, abyss); // 松明の色調＝深度帯（v0.99.0）
  // 秘宝のフロア進入フック（2026-07-03）：farsight＝地図/宝/化石を開示／hasten＝進入時ヘイスト。
  const eq = world.current?.equipment;
  if (eq?.relic?.relic === "farsight") { for (let i = 0; i < floor.explored.length; i++) floor.explored[i] = true; }
  if (eq?.armor?.proc === "hasten") { hasteTurns = Math.max(hasteTurns, HASTEN_TURNS); }
  draw();
  showFloorBanner(abyss ? "深淵 ─ 試練" : `深度 ${depth} ─ ${depthBandLabel({ minDepth: depth })}`, abyss);
  log(`── 深度${depth} ──`, "dim");
  for (const l of onReachDepth(world, depth)) { log(l, "cue"); save(); } // 到達系の依頼達成
  // 護衛（escort）：依頼人を生かして対象深度へ＝達成。依頼人はここで別れる（残りは自力で行くと言う）。
  // ★扉での再降下（viaDoor）では判定しない＝無リスクの往復で escort を即達成させない（issue4・ユーザー承認）。
  if (!viaDoor && world.companion?.alive && world.companion.escortQuestId) {
    const lines = onEscortArrive(world, world.companion.escortQuestId, depth);
    if (lines.length) {
      const name = companionName();
      for (const l of lines) log(l, "cue");
      log(`${name}は深く頭を下げた。「ここまでで充分だ。恩に着る」──そう言って、通路の陰へ消えていった。`, "cue");
      persistCompanionRecord(); // 絆/等級の蓄積は生者NPCへ書き戻し（再会・再雇用の余地）
      world.companion = undefined;
      companion = null;
      sfx("companion_join");
      save();
      draw(); // 盤上から依頼人（青@）を消す＝離脱の直後に再描画（次入力まで隣に残らないように）
    }
  }
  // 奉献の試練・印⑤：深淵手前の高深度に到達（4-13A）
  if (depth >= DEPTH_SEAL_AT && !abyss && awardSeal(world, "depth", [ch.id])) {
    sfx("seal"); log("◆ 「深淵への到達」の印を得た。", "warn"); save();
  }
  if (abyss) { sfx("boss"); log("封じられていた層――空気が、軋むほど濃い。最奥で何かが、聖遺物を抱いている。", "warn"); }
  saveDive(); // 降りた直後にも保存（この一歩で閉じても新しい深度から再開）
}

// ---------- 同行（相棒）：4-14C。盤上は ephemeral、世代越えは world.companion。 ----------
const companionName = () => world.companion?.actor.name ?? "相棒";
// 連帯深蝕（Phase B）：閾値で奇癖（erratic 逸脱）が始まり、危険閾値で C（討つ/鎮める）を迫る。
const COMPANION_ERRATIC_AT = 0.6;  // この連帯深蝕から挙動がぶれ始める
const COMPANION_DANGER_AT = 1.2;   // この連帯深蝕で危険化＝生者のうちに決断（プレイヤーの蝕み閾値と対称）
const COMPANION_QUIRK_AT = [0.6, 1.2]; // 相棒の奇癖が刻まれる深蝕段（erratic 開始／危険化に対応）
const ROSTER_DOWNED_CHANCE = 0.5; // 手負いが出るとき、★中核の本人（名簿）である確率（4-14・B）。0で従来=無名のみ
const DELVER_CHANCE = 0.22;        // 生者の冒険者が同じフロアにいる確率（初訪・深度2+・すれ違いの軽イベント）。要テストプレイ調整
const ROSTER_DELVER_CHANCE = 0.4;  // すれ違う冒険者が★名簿員（後で街で見かける余韻になりうる）である確率
const companionErraticRate = (exposure: number) =>
  exposure < COMPANION_ERRATIC_AT ? 0 : Math.min(0.5, (exposure - COMPANION_ERRATIC_AT) * 0.4);
/** 相棒の名前付き奇癖（Phase B）：連帯深蝕の段ごとに「奇癖:…」を相棒の traits に刻む（プレイヤー機構の転用）。 */
function applyCompanionQuirks(): void {
  const c = world.companion; if (!c?.alive) return;
  const traits = (c.traits ??= []);
  const want = COMPANION_QUIRK_AT.filter((th) => c.exposure >= th).length;
  while (traits.filter((t) => t.startsWith("奇癖:")).length < want) {
    const pool = filterByTags(db, "exposure_quirk", {});
    const used = new Set(traits);
    const cand = pool.filter((f) => !used.has(`奇癖:${f.text}`));
    if (!cand.length) break;
    const q = rng.pick(cand);
    traits.push(`奇癖:${q.text}`);
    log(`${companionName()}に深みが滲む――奇癖「${q.text}」。`, "warn");
  }
}
/** 相棒エンティティを @ の隣の空きマスへ展開（無ければ近傍を順に探す）。連帯深蝕の現状を erratic に反映。 */
function spawnCompanionNear(at: Pos): void {
  if (!floor || !world.companion?.alive) return;
  const occupied = (x: number, y: number) =>
    (x === at.x && y === at.y) || floor!.monsters.some((m) => m.hp > 0 && m.x === x && m.y === y) ||
    floor!.fossils.some((e) => e.x === x && e.y === y) || floor!.chests.some((c) => c.x === x && c.y === y) ||
    (!!floor!.downed && floor!.downed.x === x && floor!.downed.y === y) ||
    (!!floor!.delver && floor!.delver.x === x && floor!.delver.y === y);
  for (let r = 1; r <= 4; r++) {
    for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
      const x = at.x + dx, y = at.y + dy;
      if (inBounds(floor, x, y) && tileAt(floor, x, y) === 1 && !occupied(x, y)) {
        const cHp = companionMaxHp(world.companion.grade, floor.depth); // 等級＋潜行深度で再計算（深部追従）
        companion = {
          x, y, hp: cHp, maxHp: cHp, intent: null,
          erratic: companionErraticRate(world.companion.exposure),
          dmg: companionDmg(world.companion.grade, floor.depth), // 等級＋深度で攻撃力が変動（4-4E）
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
  // 護衛（escort）の依頼人が斃れた＝依頼失敗（取り下げ）。
  if (world.companion.escortQuestId) for (const l of failEscortQuest(world, world.companion.escortQuestId)) log(l, "warn");
  // 慈悲のとどめ＝深みに呑まれる前の安らかな解放。連帯深蝕を清めて化石化し、後世で亡霊/怨念へ寄せない
  // （討つ＝神話/喪失寄り／戦死(combat)＝高深蝕のまま＝未決着の亡霊化を残す）。
  const exposureAtRest = reason === "mercy" ? Math.min(world.companion.exposure, 0.2) : world.companion.exposure;
  const fossil = fossilizeCompanion(world, world.companion.actor, {
    depth: floor.depth, exposure: exposureAtRest, bond: world.companion.bond,
  });
  floor.fossils.push({ id: `fe_${fossil.id}`, fossilId: fossil.id, x: companion.x, y: companion.y, resolved: false });
  world.companion.alive = false;
  companion = null;
  sfx(reason === "mercy" ? "intervene" : "companion_down");
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
  const quirks = (world.companion.traits ?? []).filter((t) => t.startsWith("奇癖:")).map((t) => t.slice(3));
  const quirkLine = quirks.length ? `\n奇癖：${quirks.join("、")}` : "";
  const r = await sheet({
    text: `${name}の様子がおかしい。眼の奥に、見覚えのある昏さ――深みが、もう半ば呑み込んでいる。\nまだ生者のうちに、決めねばならない。${quirkLine}`,
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
      // 鎮めた証＝奇癖がひとつ薄れる（正気を取り戻す）。
      const tr = world.companion.traits ?? [];
      const qi = tr.map((t, i) => ({ t, i })).filter((x) => x.t.startsWith("奇癖:")).pop();
      if (qi) { tr.splice(qi.i, 1); world.companion.traits = tr; }
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
  sfx("companion_join");
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
  const fee = hireFee(grade, ch.level);
  if (ch.gold < fee) {
    await sheet({
      text: `${la.actor.name}に同行を持ちかける。\n「いいだろう。だが先立つものは前金で ── ${fee}金貨だ」。\n……今の持ち金（${ch.gold}）では足りない。`,
      meta: "同行 ── 前金が足りない", options: ["引き下がる"],
    });
    return;
  }
  const r = await sheet({
    text: `${GRADE_LABELS[grade]}の${la.actor.name}に、共に潜らないかと持ちかける。\n「いいだろう。前金は ${fee}金貨。道中で得た金貨は、山分けだ」。\n（雇えば次の潜行から隣を歩く。詳細・解散はステータスの「相棒を見る」から）`,
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
    for (const l of onRescueDelver(world)) log(l, "cue"); // 救助依頼（rescue）の達成
    // 名簿員（adv_*）なら安定idのまま＝再会/永続/setpiece が本人に紐づく。無名は従来どおり世代付きid。
    const laId = downed.id.startsWith("adv_") ? downed.id : `npc_${world.generation}_${downed.id}`;
    const la: LivingActor = { id: laId, actor: downed.actor, metGeneration: world.generation };
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

/** 同時に潜る生者の冒険者とのすれ違い（4-14・軽イベント）。会話／アイテムや金貨の分け合い等＝一度きり。
 *  街と同じ生者アンカーの仕組み（selectDelverStorylet → applyActorEffects）を流用。bond/plant が立てば
 *  rememberActor で永続化＝後で街で見かける「また会えそう」の余韻になりうる（4-14・E）。相棒勧誘はしない（軽さ優先）。 */
async function delverScene(d: DelverActor): Promise<void> {
  if (busy) return;
  busy = true;
  const ch = world.current!;
  if (floor) floor.delver = null; // すれ違いは一度きり（盤上から消す）
  markEventFired(); // 4-10H 第二層：人に出会う＝イベントが起きた＝凪を解除
  sfx("ui");
  const head = `${d.actor.epithet ?? ""}${d.actor.name}（${d.actor.archetype}）`;
  // 名簿員（adv_*）は安定idのまま＝再会/余韻が本人に紐づく。無名は世代付きid。
  const laId = d.id.startsWith("adv_") ? d.id : `npc_${world.generation}_${d.id}`;
  const la: LivingActor = { id: laId, actor: d.actor, metGeneration: world.generation };
  const sl = selectDelverStorylet(db, world, ch, la, rng, recentSet());
  if (sl && sl.choices && sl.choices.length) {
    noteEvent(sl.id);
    const c = await sheet({
      text: `${head}\n\n${fillActorText(la.actor, sl.text ?? "")}`,
      meta: `深度${floor?.depth ?? 1} ── すれ違う冒険者`, options: sl.choices.map((o) => o.label),
    });
    const choice = sl.choices[c.pick - 1];
    const ov: string[] = [];
    const lines = applyActorEffects(world, ch, la, choice.effects, ov);
    const body = [choice.text ? fillActorText(la.actor, choice.text) : "", ...lines].filter(Boolean).join("\n");
    if (body) log(body);
    await resolveOverflow(ch, ov);
  } else {
    // 候補が無ければ素っ気ない会釈で別れる（破綻させない）。
    await sheet({
      text: `${head}\n\n通路の角ですれ違った。互いに無言で会釈を交わし、また別々の闇へ消えていく。`,
      meta: `深度${floor?.depth ?? 1} ── すれ違う冒険者`, options: ["先へ進む"],
    });
  }
  save();
  busy = false;
  draw();
}

let seenThisDive: string[] = [];
// P1 ペーシング：直近に出したイベントid（context横断のリング）。同じ話の短期再発を抑える。
const recentEvents: string[] = [];
function noteEvent(id: string): void { recentEvents.push(id); while (recentEvents.length > 6) recentEvents.shift(); }
const recentSet = (): Set<string> => new Set(recentEvents);
const curLevel = (): number => world.current?.level ?? 1;

// 4-10H 第二層（ペーシング・ディレクター・2026-06-21 ユーザー承認）。第一層（深度逓増・1降下1イベント・
// recentEvents 重複回避）の上に、緊張と緩和のリズムを監督する薄い調停層を足す。数値は要テストプレイ調整。
const SETPIECE_COOLDOWN = 12; // 山場連発防止：山場を見せたら N 手は次の山場演出を抑制（ダイブを跨ぐ）。
const PITY_STEP = 0.15;       // 凪検知（ピティ）：無風の降下1回ごとに迷宮イベント率へ加点。
const PITY_BOND_AT = 2;       // 凪が PITY_BOND_AT 降下続き、未完の絆を持つなら因縁化石を1体上乗せ（因縁を浮上）。
let setPieceCooldown = 0;     // >0 の間、山場（legend_return/grudge_hunt）演出を抑え通常遭遇へ。endTurn で毎手減算。
let mendTick = 0;             // 遺物 mending の回復タイマー（endTurn で加算・MEND_EVERY 手ごとに +1HP）。
const MEND_EVERY = 5;        // mending：この手数ごとに +1HP（要テストプレイ調整）。
let quietDescents = 0;        // 直近の降下からイベントが一度も起きていない回数（イベント発火で 0 に戻す）。
// 何らかのイベント（迷宮の気配/行商人/化石遭遇/宝箱）が起きたらピティを解除＝凪カウンタをリセット。
function markEventFired(): void { quietDescents = 0; }
// 同一潜行中に訪れた階を保持（再訪で再生成しない＝宝箱/化石/倒した敵の状態が残る。FB：上り下りで宝箱が復活していた）。
// 潜行ごとにクリア（startDive）。途中状態は DiveSnapshot で保存＝アプリを閉じても同じ深度・盤面から再開。
let floorCache = new Map<number, Floor>();
let inAbyss = false; // 現在のフロアが深淵帯（奉献の試練）か（帰還の扉を出さない判定に使う：v2）
// 帰還の試練（4-13C）：聖遺物携行中の追手カウンタ（フロアごとにリセット）
let pursuerCount = 0;
let turnsSinceFloor = 0;
// 術のプレイヤーバフ計時（4-11F③・援系）。各 *Turns は残り手数（毎手 endTurn で減算）。フロア内のみ・セーブ非対象。
let armorBuffTurns = 0;  // 硬鱗：>0 の間 被ダメ −ARMOR_BUFF
let attackBuffTurns = 0; // 焦躁：>0 の間 近接 +ATTACK_BUFF（詠唱で深蝕も増す）
let hasteTurns = 0;      // 疾走：>0 の間、敵手番をスキップ（自分だけ余分に動く）
let deathDoorTurns = 0;  // 死戸：>0 の間は無敵だが回復不可、明けに深みの揺り戻し（深蝕）
let chantTurns = 0;      // 帰還の詠唱（v2）：>0 の間 詠唱中（無防備）。移動で中断。0到達で地上へ還る
let poisonTurns = 0;     // 毒（敵 venom 能力・4-11G）：>0 の間 毎手 poisonDmg を受ける（プレイヤー側）
let poisonDmg = 0;       // 毒の1手あたりダメージ（被弾時に深度で決まる・テクスチャ＝控えめ）
const ARMOR_BUFF = 4, ATTACK_BUFF = 5; // バフ量（理で伸ばさず固定＝読みやすさ優先）
const VENOM_TURNS = 4; // 敵 venom の毒の持続手数（4-11G）。1手あたりダメージは被弾深度で決まる（venomDmgAt）。
const VENOM_DMG_CAP = 3; // 毒の1手ダメ上限（横断E・シム検証：深度線形×4手×解毒手段なしで深部の毒系が突出スケール→上限で頭打ち）
const venomDmgAt = (depth: number) => Math.min(VENOM_DMG_CAP, Math.max(1, Math.round(depth * 0.08))); // テクスチャ＝控えめ（D38+ で 3 頭打ち）
const REFLECT_FRAC = 0.35;  // 敵 reflect（棘・深淵帯 PR2）：プレイヤーの近接命中で与ダメの 35% を反射で被る（術/投擲を促す）
const CURSE_EXP = 0.25;     // 敵 curse（蝕み・深淵帯 PR2）：命中で深蝕を上塗り（heartFactor で心が効く＝addExp 経由）
// 遺物の新効果（物量レビュー PR3）。すべて web 適用＝純エンジン不変。
const THORNS_FRAC = 0.5;    // 遺物 thorns（茨）：被弾した近接ダメージの 50% を反射で相手へ
const SIPHON_FRAC = 0.2;    // 遺物 siphon（渇き）：近接で与えたダメージの 20% を回復
const POTENCY_MUL = 1.25;   // 遺物 potency（術理）：術ダメージ ×1.25
const SPELLCROWN_MUL = 1.6; // 秘宝 spellcrown（秘術の宝冠）：術ダメージ ×1.6（potency の上位）
const SPELLCROWN_COST_MUL = 0.6; // 秘宝 spellcrown：術の深蝕コストを 0.6 倍（−40%）
let revenantUsed = false;   // 遺物 revenant（不死鳥の灰）：潜行ごと一度だけ致死を1で耐える。enterFloor 開始で潜行単位にリセット
let blinkUsed = false;      // 秘宝 blink（転移の護符）：潜行ごと一度だけ致死を安全地帯転移で回避。startDive でリセット
const TIMESLIP_CHANCE = 0.18; // 秘宝 timeslip（時詠み）：被弾を低確率で完全回避
/** 術の基礎ダメージ（理由来＋遺物 potency）。castSpell の全術はこれを基準にする。 */
const spellBase = (ch: Character): number => {
  const r = ch.equipment.relic?.relic;
  const mult = r === "spellcrown" ? SPELLCROWN_MUL : r === "potency" ? POTENCY_MUL : 1; // 秘宝 spellcrown＞遺物 potency
  return warpDamage(effectiveReason(ch)) * mult;
};
// 発動効果つき武器（物量レビュー PR4）：命中時に発動。武器に初の「挙動差」を与える（従来は近接+ダメージのみ）。
const CLEAVE_FRAC = 0.5;    // 薙ぎ：隣接の他の敵へ与ダメの 50%
const STUN_CHANCE = 0.3;    // 当て止め：命中ごと 30% で目標を1手止める
const REND_TURNS = 3;       // 裂傷：継続ダメの手数
const SAP_TURNS = 3;        // 弱体：目標の攻撃減（WEAK_AMT）の手数
/** 武器の発動効果（proc）を命中時に適用。target=殴った敵・dmg=与えた近接ダメージ。潜行(dive)のみ。 */
// 秘宝の武器 proc 係数（特殊効果・2026-07-03）。
const ARC_FRAC = 0.7, ARC_RANGE = 6;   // 雷撃＝別の最寄り敵へ連鎖（実質遠距離）
const BLAST_FRAC = 0.6, BLAST_RADIUS = 2; // 炎の範囲
const PIERCE_FRAC = 0.8;               // 貫通＝攻撃方向の奥1マス
const FREEZE_TURNS = 2;                 // 凍結＝目標+隣接を rooted+slowed
const DRAIN_FRAC = 0.4;                 // 吸命＝与ダメの一部を回復
function applyWeaponProc(ch: Character, target: Monster, dmg: number): void {
  const proc = ch.equipment.weapon?.proc;
  if (!proc || !floor) return;
  if (proc === "cleave") { // 隣接の他の敵にも余波（群れに強い）
    const splash = Math.max(1, Math.round(dmg * CLEAVE_FRAC));
    for (const m of floor.monsters) {
      if (m.hp <= 0 || m === target) continue;
      if (Math.max(Math.abs(m.x - target.x), Math.abs(m.y - target.y)) > 1) continue;
      m.hp -= splash; flashFx("warp", { x: m.x, y: m.y });
      if (m.hp <= 0) downOrKill(m, `薙ぎが${m.kind.name}を巻き込んだ。`);
    }
    return;
  }
  if (proc === "blast") { // 秘宝：炎の範囲（目標の周囲半径2の全敵）
    const splash = Math.max(1, Math.round(dmg * BLAST_FRAC));
    for (const m of floor.monsters) {
      if (m.hp <= 0 || m === target) continue;
      if (Math.max(Math.abs(m.x - target.x), Math.abs(m.y - target.y)) > BLAST_RADIUS) continue;
      m.hp -= splash; flashFx("warp", { x: m.x, y: m.y }); floatFx(m.x, m.y, String(splash), "fl-dmg");
      if (m.hp <= 0) downOrKill(m, `業炎が${m.kind.name}を焼いた。`);
    }
    return;
  }
  if (proc === "arc") { // 秘宝：雷撃＝視界内の別の最寄り敵へ連鎖（遠距離）
    let best: Monster | null = null, bd = ARC_RANGE + 1;
    for (const m of floor.monsters) {
      if (m.hp <= 0 || m === target) continue;
      const d = Math.hypot(m.x - target.x, m.y - target.y);
      if (d <= ARC_RANGE && d < bd) { bd = d; best = m; }
    }
    if (best) {
      const arc = Math.max(1, Math.round(dmg * ARC_FRAC));
      best.hp -= arc; flashFx("blink", { x: best.x, y: best.y }); floatFx(best.x, best.y, String(arc), "fl-dmg");
      if (best.hp <= 0) downOrKill(best, `雷撃が${best.kind.name}を貫いた。`); else log(`雷鳴が${best.kind.name}へ連鎖した（${arc}）。`, "dim");
    }
    return;
  }
  if (proc === "pierce") { // 秘宝：貫通＝攻撃方向の奥1マスの敵も打つ（直線の遠距離リーチ）
    const dx = Math.sign(target.x - player.x), dy = Math.sign(target.y - player.y);
    const bx = target.x + dx, by = target.y + dy;
    const beyond = floor.monsters.find((m) => m.hp > 0 && m.x === bx && m.y === by);
    if (beyond) {
      const p = Math.max(1, Math.round(dmg * PIERCE_FRAC));
      beyond.hp -= p; flashFx("warp", { x: bx, y: by }); floatFx(bx, by, String(p), "fl-dmg");
      if (beyond.hp <= 0) downOrKill(beyond, `刃が${beyond.kind.name}まで貫いた。`);
    }
    return;
  }
  if (proc === "freeze") { // 秘宝：目標＋隣接を凍結(rooted)＋鈍化（範囲無力化）
    for (const m of floor.monsters) {
      if (m.hp <= 0) continue;
      if (Math.max(Math.abs(m.x - target.x), Math.abs(m.y - target.y)) > 1) continue;
      m.rooted = Math.max(m.rooted ?? 0, FREEZE_TURNS); m.slowed = Math.max(m.slowed ?? 0, FREEZE_TURNS);
    }
    log(`氷結が${target.kind.name}とその周囲を縛る。`, "dim");
    return;
  }
  if (proc === "drain") { // 秘宝：与ダメの一部を回復（魔法吸収）
    if (hp < maxHp(ch) && deathDoorTurns === 0) {
      const heal = Math.max(1, Math.round(dmg * DRAIN_FRAC));
      const before = hp; hp = Math.min(maxHp(ch), hp + heal);
      if (hp > before) { floatFx(player.x, player.y, `+${hp - before}`, "fl-heal"); log(`吸命が巡る（HP＋${hp - before}）。`, "dim"); }
    }
    return;
  }
  if (target.hp <= 0) return; // 以下は生存している目標に効く状態異常
  if (proc === "stun" && rng.next() < STUN_CHANCE) {
    target.stunned = Math.max(target.stunned ?? 0, 1); log(`鎖星が${target.kind.name}を当て止めた。`, "dim");
  } else if (proc === "rend") {
    target.poison = Math.max(target.poison ?? 0, REND_TURNS);
    target.poisonDmg = Math.max(target.poisonDmg ?? 0, Math.max(1, Math.round(dmg * 0.3)));
    log(`${target.kind.name}が裂傷を負う（継続ダメ）。`, "dim");
  } else if (proc === "sap") {
    target.weak = Math.max(target.weak ?? 0, SAP_TURNS); log(`${target.kind.name}の力が萎える。`, "dim");
  }
}
// 発動効果つき防具（2026-07-01）：被弾時に発動。武器 proc と対称に防具へ「挙動差」を与える。web 適用＝純エンジン不変。
const ARMOR_BLOCK_CHANCE = 0.3;   // 受け：被弾ごと 30% でその一撃を軽減
const ARMOR_BLOCK_KEEP = 0.5;     // 受け：軽減後に残る割合（＝半減）
const ARMOR_BARBS_FRAC = 0.4;     // 棘：近接被弾の 40% を反射で相手へ（遺物 thorns と別枠・重複可）
const ARMOR_CLEANSE = 0.06;       // 清め：被弾ごとに深蝕を薄める量（heartFactor は掛けない＝清め側の恩恵は素で効かせる）
const ARMOR_STAGGER_CHANCE = 0.35; // 怯み：殴った敵を鈍化させる確率
const ARMOR_STAGGER_TURNS = 2;
const ARMOR_DAUNT_CHANCE = 0.25;  // 威圧：殴った敵を恐慌させる確率
const ARMOR_DAUNT_TURNS = 2;
// 秘宝の防具 proc 係数（2026-07-03）。
const ARMOR_REFLECTALL_FRAC = 0.4; // 反射結界：近接も遠距離も被弾の 40% を返す
const ARMOR_NEGATE_CHANCE = 0.25;  // 虚無の法衣：一定確率でその一撃を完全無効
const ARMOR_PURGE = 0.18;          // 浄化：被弾ごとに深蝕を強く祓う（cleanse の約3倍）
const HASTEN_TURNS = 6;            // 疾風の外套：フロア進入時に得るヘイストの手数
/** 防具 proc のうち「受け（被害軽減）／無効化」を被ダメ確定前に適用＝軽減後の dmg を返す。潜行(dive)のみ。 */
function armorBlock(ch: Character, dmg: number): number {
  const proc = ch.equipment.armor?.proc;
  if (dmg <= 0) return dmg;
  if (proc === "negate" && rng.next() < ARMOR_NEGATE_CHANCE) { log("虚無の法衣が、一撃を消し去った。", "dim"); return 0; } // 秘宝：完全無効
  if (proc !== "block") return dmg;
  if (rng.next() >= ARMOR_BLOCK_CHANCE) return dmg;
  const kept = Math.max(1, Math.round(dmg * ARMOR_BLOCK_KEEP));
  if (kept < dmg) log("受けの鎧が一撃を受け流した。", "dim");
  return kept;
}
/** 防具 proc（受け以外）を被弾後に適用。m=殴ってきた敵・dmg=実際に受けた傷（>0 の時のみ効く）。潜行(dive)のみ。 */
function applyArmorProc(ch: Character, m: Monster, dmg: number): void {
  const proc = ch.equipment.armor?.proc;
  if (!proc || dmg <= 0) return;
  if (proc === "barbs" && m.hp > 0) { // 棘＝近接被弾を反射
    const recoil = Math.max(1, Math.round(dmg * ARMOR_BARBS_FRAC));
    m.hp -= recoil;
    if (m.hp <= 0) downOrKill(m, `${m.kind.name}は棘鎧に貫かれて斃れた。`);
    else log(`棘鎧が${m.kind.name}へ${recoil}を返す。`, "dim");
  } else if (proc === "stagger" && m.hp > 0 && rng.next() < ARMOR_STAGGER_CHANCE) {
    m.slowed = Math.max(m.slowed ?? 0, ARMOR_STAGGER_TURNS); log(`怯ませの鎧が${m.kind.name}を鈍らせた。`, "dim");
  } else if (proc === "daunt" && m.hp > 0 && rng.next() < ARMOR_DAUNT_CHANCE) {
    m.fear = Math.max(m.fear ?? 0, ARMOR_DAUNT_TURNS); log(`威圧の鎧が${m.kind.name}を怯えさせた。`, "dim");
  } else if (proc === "cleanse") { // 清め＝被弾で深蝕を薄める（深蝕テーマの防御。烙印/永続汚染より下へは祓えない＝既存ルール尊重）
    cleanseExposure(ch, ARMOR_CLEANSE);
  } else if (proc === "purge") { // 秘宝：浄化＝被弾で深蝕を強く祓う（cleanse 上位）
    cleanseExposure(ch, ARMOR_PURGE);
  } else if (proc === "reflectall" && m.hp > 0) { // 秘宝：反射結界＝近接も遠距離も被弾を反射（applyArmorProc は近接/遠距離 両方の被弾後に呼ばれる）
    const recoil = Math.max(1, Math.round(dmg * ARMOR_REFLECTALL_FRAC));
    m.hp -= recoil;
    if (m.hp <= 0) downOrKill(m, `${m.kind.name}は反射結界に還されて斃れた。`);
    else log(`反射結界が${m.kind.name}へ${recoil}を返す。`, "dim");
  }
}
// 召喚＝一時味方（4-11F③・召系）。盤上 ephemeral：数手で霧散。隣接敵を毎手討ち、いなければ最寄りへ寄る。
// monsters のターゲットには乗らない（簡潔さ優先）＝味方AIは攻撃のみ。echo_summon(4-10I) とは別物（術側は割り切り）。
interface SummonEntity extends Pos { glyph: string; name: string; dmg: number; turns: number; follow: boolean; }
let summons: SummonEntity[] = [];
let shadowGuard = 0; // 影分け：>0 の間、敵の一撃を影が肩代わり（被ダメを無効化し1減）

// ── 位置取りの通貨（2026-07-04 ユーザー承認・戦闘C/D・web限定＝golden不変）──
// C. 挟撃：味方（相棒/召喚/raid共闘者）と敵を挟んだ近接は増し。回り込む1歩に意味を持たせる。
// D. ジャスト見切り→反撃：テレグラフを退いて空振りさせた直後は「反撃の好機」＝次の近接が会心。
//    読んで避けるだけでなく「避けて刺す」へ。数値はテストプレイ調整候補。
const FLANK_MULT = 1.15;   // 挟撃の近接倍率（v0.117.0＝1.3 から抑制：終始シビアを守る。相棒AI改善で挟撃が常態化したぶん控えめに）
const COUNTER_MULT = 1.2;  // 見切り反撃の会心倍率（v0.117.0＝1.75 から抑制：狙って作れるバーストが難易度を崩していたFB対応。エフェクトが手応えを担うので倍率は控えめでよい）
const COUNTER_WINDOW = 2;  // 反撃の好機の持続（手）＝見切った次の1〜2手
let counterTurns = 0;      // >0 の間、次の近接が会心（消費で0・ephemeral＝フロアを跨がない）

/** 挟撃判定：この敵に隣接する生存味方（相棒/召喚/raid共闘者）がいるか。 */
function flankedByAlly(m: Monster): boolean {
  const adj = (x: number, y: number) => Math.max(Math.abs(m.x - x), Math.abs(m.y - y)) <= 1;
  if (companion && companion.hp > 0 && adj(companion.x, companion.y)) return true;
  if (summons.some((s) => adj(s.x, s.y))) return true;
  if (allies.some((a) => a.hp > 0 && adj(a.x, a.y))) return true;
  return false;
}

/** 近接ダメージに位置取り補正（挟撃＋見切り反撃）を適用し、演出も出す（v0.115.0＝専用エフェクト）。
 *  会心（希少）＝斬光＋マイクロシェイク＋特大数字／挟撃（高頻度）＝控えめな楔＝頻度に合わせた強度。 */
function meleeWithPositioning(base: number, mon: Monster): { dmg: number; crit: boolean; flank: boolean } {
  let dmg = base;
  const crit = counterTurns > 0;
  const flank = flankedByAlly(mon);
  if (crit) { dmg = Math.round(dmg * COUNTER_MULT); counterTurns = 0; } // 好機は一撃で消費
  if (flank) dmg = Math.round(dmg * FLANK_MULT);
  if (flank) tileFx(mon.x, mon.y, "tfx-press"); // 挟撃＝両側から閉じる楔（控えめ）
  if (crit) { tileFx(mon.x, mon.y, "tfx-slash"); shakeGrid(); sfx("crit"); log(`見切りからの反撃！ 会心の${dmg}。`, "cue"); }
  else if (flank) log(`挟み撃ち！ ${dmg}の一撃。`);
  return { dmg, crit, flank };
}

let abyssDivePending = false; // 次の潜行が「奉献の試練」（深淵帯への直下降）か
let portalDivePending = false; // 次の startDive が「帰還の扉（街側・一回だけ）」＝駐機盤面の復元か

async function startDive() {
  stopWander(); // 街の群衆ループを止める
  mode = "dive";
  // 帰還の扉（街側・一回だけ）：駐機した あの階の盤面（ボス討伐済み）へ戻る。新規潜行のリセットはせず同じ盤面を継続。
  if (portalDivePending) { portalDivePending = false; restoreFromPortal(); return; }
  if (world.town?.returnPortal) clearPortal(); // 新しい潜行を始めた＝駐機していた帰還の扉（あの階への帰り道）を諦める
  seenThisDive = [];
  floorCache = new Map(); // 新しい潜行＝階の記憶をリセット（深度1から）
  setPieceCooldown = 0; quietDescents = 0; // 4-10H 第二層：新しい潜行はペーシング調停層もまっさらから
  revenantUsed = false; // 遺物 revenant（不死鳥の灰）：潜行ごと一度きり＝新しい潜行で復活
  blinkUsed = false;    // 秘宝 blink（転移の護符）：潜行ごと一度きり＝新しい潜行で復活
  world.diveCount = (world.diveCount ?? 0) + 1; // 潜行ごとに別ダンジョン＝再潜行farm防止（genFloor のseed nonce）
  world.diveMaxDepth = 0; // 世界クロック（4-14G 層1）：新しい潜行は最深をリセット（死で帰還しなかった前回の値を持ち越さない）
  if (world.current) hp = townHealHp(); // 街で癒えた状態から潜る（難易度 townHeal<1 なら満タンに戻らない＝消耗）
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
  // 門出の一杯（酒場・2026-07-02）：enterFloor がバフをリセットした後に適用＝最初のフロアの出だしに乗る。
  const pb = world.current?.pendingDiveBuff;
  if (pb) {
    if (pb.atk) { attackBuffTurns = Math.max(attackBuffTurns, pb.turns); log(`門出の一杯が効いてくる──腕が冴える（近接+${ATTACK_BUFF}・${pb.turns}手）。`, "cue"); }
    if (pb.arm) { armorBuffTurns = Math.max(armorBuffTurns, pb.turns); log(`門出の一杯が効いてくる──体が守られている（被ダメ−${ARMOR_BUFF}・${pb.turns}手）。`, "cue"); }
    world.current!.pendingDiveBuff = undefined; // 1潜行1回＝消費
    updateStatus(); save();
  }
}

/** 帰還の扉（街側・一回だけ）で駐機盤面へ戻る。startDive の portalDivePending 分岐から呼ぶ＝
 *  同じ盤面（ボス討伐済み・floorCache 込み）を復元し、そこから潜行を続ける。くぐった時点で消費（farm根絶）。 */
function restoreFromPortal(): void {
  const snap = loadPortal();
  const depth = world.town?.returnPortal?.depth ?? snap?.depth ?? 1;
  clearPortal(); // 一度きり＝消費（盤面の有無に関わらず閉じる）
  if (snap) {
    resumeDive(snap); // mode/floorCache/グリッド/敵予告/描画まで面倒を見る
    if (world.current) hp = townHealHp(); // 街で癒えた分（難易度 townHeal<1 なら満タンでない＝消耗）
    if (floor?.returnDoor) player = { ...floor.returnDoor }; // 扉のあった場所へ再出現
    if (world.current?.alive && world.companion?.alive) spawnCompanionNear(player);
    draw(); updateStatus();
  } else {
    // 保険：スナップショット消失＝深度だけ戻す（新規盤面で再生成・farm は一度きりゆえ起きない）。
    seenThisDive = []; floorCache = new Map();
    buildGridDom(VIEW_W, VIEW_H);
    if (world.current) hp = townHealHp();
    enterFloor(depth, true, false, true); // viaDoor=true＝escort 到達を判定しない（issue4）
  }
  save();
  log(`帰還の扉――深度${depth}へ戻った。`, "cue");
}

/** 保存した潜行を再開（boot 時）：街に戻さず、同じ深度・盤面・HP から続ける。 */
function resumeDive(snap: DiveSnapshot): void {
  mode = "dive"; seenThisDive = []; resetMapView(); // 再開はプレイ視点から（地図/照準を持ち越さない＝グリッド寸法の齟齬を防ぐ）
  floorCache = new Map(snap.cache);
  floor = snap.floor;
  player = snap.player;
  hp = snap.hp;
  inAbyss = snap.inAbyss;
  pursuerCount = snap.pursuerCount ?? 0;
  turnsSinceFloor = snap.turnsSinceFloor ?? 0;
  setPieceCooldown = snap.setPieceCooldown ?? 0; // 4-10H 第二層：途中閉じでクールダウン/ピティをリセットさせない（抜け道封じ）
  quietDescents = snap.quietDescents ?? 0;
  if (world.current) world.current.depth = floor.depth;
  buildGridDom(VIEW_W, VIEW_H);
  companion = null;
  if (world.current?.alive && world.companion?.alive) spawnCompanionNear(player);
  planMonsters(floor, player, rng, companion); // 予告を出し直す
  if (companion) planCompanion(floor, player, companion, rng);
  setAmbient(true, floor.depth);
  if (inAbyss) setBgm("abyss", floor.depth); else { setBgm("dungeon", floor.depth); setBgmDepth(floor.depth); }
  applyChrome(); // dive 用の下部タブ/術・品・地図の有効化
  draw(); updateStatus();
  // HP0のまま閉じた＝死の選択前。盤面に戻さず、呼び出し側で即・最期の一手へ（復活に見える混乱と確定先延ばしの隙間を塞ぐ）。
  if (hp > 0) log(`（${world.current?.name ?? "探索者"}は深度${floor.depth}で潜行を続けている）`, "dim");
}

// ---------- 1ターンの処理 ----------
async function playerAct(dx: number, dy: number) {
  if (busy || overlayEl.classList.contains("show") || mode !== "dive" || !floor || !world.current) return; // シート表示中は盤面を動かさない（入れ子シート裏での再入防止）
  hidePeek(); // 行動したら「調べる」ポップは畳む

  if (!(dx === 0 && dy === 0)) {
    if (chantTurns > 0) { chantTurns = 0; log("帰還の詠唱が、途切れた。", "warn"); } // 動くと中断（v2）
    const nx = player.x + dx, ny = player.y + dy;
    if (!moveOrInteract(nx, ny)) return; // 壁
  }
  // 化石・階段の場面が開いた場合は、このターンの進行（深蝕・敵の手番）を保留する
  if (busy) { draw(); return; }
  await endTurn();
}

/** 深蝕の即時の牙（4-10C）：この深蝕を超えると歩くだけで蝕まれる（＝怨念寄りライン）。 */
const CORRUPTION_DRAIN_FROM = 1.5;
/** 牙の加速幅：深蝕がこれだけ深まるごとにドレインが＋1（緩やかな逓増＝死の螺旋を回避）。 */
const CORRUPTION_DRAIN_STEP = 2.0;
/** 牙の毎手上限：どれだけ深く染まってもこれ以上は削れない（青天井の死の螺旋を断つ）。 */
const CORRUPTION_DRAIN_CAP = 2;
/** 帰還の詠唱（v2）：完成までの詠唱手数（この間は無防備＝敵が動く。移動で中断）。 */
const HOMEWARD_CHANT = 3;
/** 異物（呪い装備）の深蝕＝「降下1階ごと」の固定係数（毎手 exposurePerTurn を1階ぶんに束ねる）。
 *  滞在ターン非依存＝大マップでじっくり探索しても青天井にならない（2026-06-19 バランス是正）。
 *  両異物(0.05)×10×心係数 ≈ 0.5/floor（heart2）＝予測可能な呪いの代償。 */
const ODDITY_DESCENT_MULT = 10;
/** 1手ぶんの後処理：深蝕→奇癖→蝕み→敵の手番→予告更新→描画→昇級→死。移動も詠唱もここに合流する。 */
// 一手の経過＝場面に応じた手番処理（迷宮＝endTurn／街防衛戦＝raidEndTurn）。術・消耗品・残響が共用。
const turnPass = (): Promise<void> => (mode === "raid" ? raidEndTurn() : endTurn());

async function endTurn() {
  if (!floor || !world.current) return;
  const ch = world.current;

  if (setPieceCooldown > 0) setPieceCooldown--; // 4-10H 第二層：山場クールダウンの毎手減算（フロアを跨ぐ）
  // 遺物 mending：潜行中、数手ごとに最大HPまでゆっくり回復（持久の遺物）。数値はテストプレイ調整候補。
  if (ch.equipment.relic?.relic === "mending" && hp < maxHp(ch) && (++mendTick % MEND_EVERY === 0)) {
    hp = Math.min(maxHp(ch), hp + 1);
  }
  // 術バフの計時（毎手減算。疾走中はこの手番の敵を飛ばす。死戸は明けに揺り戻し）。
  if (armorBuffTurns > 0) armorBuffTurns--;
  if (counterTurns > 0) counterTurns--; // 反撃の好機は短い（見切った直後の1〜2手だけ）
  if (attackBuffTurns > 0) attackBuffTurns--;
  const hasted = hasteTurns > 0; if (hasteTurns > 0) hasteTurns--;
  if (deathDoorTurns > 0) { deathDoorTurns--; if (deathDoorTurns === 0) { addExp(0.4); log("死戸が閉じる……深みの揺り戻し（深蝕＋0.4）。", "warn"); } }
  // 腐喰（継続ダメ・4-11F③）：毒を受けた敵は毎手 poisonDmg を失う。死亡は通常の撃破処理へ。
  for (const m of floor.monsters) {
    if (m.hp > 0 && m.poison && m.poison > 0) {
      const pd = m.poisonDmg ?? 1;
      m.hp -= pd; m.poison--; floatFx(m.x, m.y, String(pd), "fl-dmg"); // 継続ダメも数字ポップ（毒の効きを可視化）
      if (m.hp <= 0) downOrKill(m, `腐喰が${m.kind.name}を朽ち果てさせた。`);
    }
  }
  // 毒（敵 venom・4-11G）：被毒中は毎手 poisonDmg を受ける（死戸中は無効＝痛まずカウントのみ）。HP0 は手番末の通常死（2613）で拾う。
  if (poisonTurns > 0) {
    poisonTurns--;
    if (deathDoorTurns === 0) { hp -= poisonDmg; sfx("drain"); log(`毒が回る……（HP -${poisonDmg}）`, "warn"); }
  }

  // 深蝕の累積（リワーク v2）：探索・移動・降下では一切増えない。毎手で増えるのは
  //   ②異物装備の drip（呪われた装備の代償・equipExposure）と ③聖遺物携行のときだけ。
  //   （①術使用は castSpell で都度加算。これら3源以外に受動累積は無い＝じっくり攻略を罰しない。）
  // 深蝕の累積（リワーク v2／2026-06-19 微調整）：探索・移動では一切増えない。毎手で増えるのは
  //   ③聖遺物携行のときだけ。①術使用は castSpell で都度／②異物装備は降下ごと（stairsPrompt down）に課金。
  //   （滞在ターンに比例しないため「じっくり攻略」を罰しない＝大マップでも異物が青天井にならない。）

  // 帰還の試練（4-13C）：聖遺物携行中は深みが覚醒＝毎手 深蝕が騰がり、追手の怨霊が湧く。
  if (ch.carryingRelic) {
    addExp(RELIC_EXPOSURE_PER_TURN * heartFactor(ch)); // ③聖遺物携行も心で和らぐ
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

  // 深蝕の即時の牙：深く染まると歩くだけで深みに蝕まれる。閾値1.5以上で逐増（+2.0ごとに+1・上限3/手）。
  // これで深蝕は「後世（死亡時の怨念化）」だけでなく在りし日の生存圧にもなる。HP0は手番末の通常死＝
  // 高い exposureAtDeath で強い怨念化。街は endTurn を通らない＝安全地帯。
  if (ch.exposure >= CORRUPTION_DRAIN_FROM) {
    const bite = Math.min(CORRUPTION_DRAIN_CAP, 1 + Math.floor((ch.exposure - CORRUPTION_DRAIN_FROM) / CORRUPTION_DRAIN_STEP));
    hp -= bite;
    sfx("drain");
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
    // 相棒の名前付き奇癖（Phase B）：プレイヤーと同じ機構を転用。深蝕段ごとに「奇癖:…」を刻む。
    applyCompanionQuirks();
  }

  // 敵の手番：予告した一手を実行（退いた予告は空振り＝見切り。静止中はwait）。標的は @ or 相棒。
  const res = resolveMonsters(floor, player, companion);
  // 被弾音は少し遅らせる＝自分の攻撃音(hit/術)と同時に潰れず「攻撃→（間）→反撃を食らう」と順次に聞こえる。
  if (res.hits.length) sfx("hurt", 0.14);
  for (const h of res.hits) {
    if (h.target === "companion" && companion) {
      companion.hp -= h.dmg; // 相棒は防具軽減なし（v1）
      floatFx(companion.x, companion.y, String(h.dmg), "fl-hurt");
      log(`${h.monster.kind.name}の一撃が${companionName()}を襲う！ ${h.dmg}の傷。`, "warn");
    } else {
      // 秘宝 timeslip（時詠みの懐中時計）：被弾を低確率で完全回避（時をわずかに滑らせる）。死戸/影分けの前に判定。
      if (ch.equipment.relic?.relic === "timeslip" && rng.next() < TIMESLIP_CHANCE) {
        floatFx(player.x, player.y, "時滑", "fl-miss"); log(`時が滑り、${h.monster.kind.name}の一撃が逸れた。`, "dim"); continue;
      }
      // 防具＋硬鱗で軽減。下限＝max(固定1, 素の攻×chipFrac)＝比例チップ（v0.121.0 防具飽和対策：normal+ では
      // 軽減をどれだけ積んでも強敵の一撃は最低限痛い。easy は chipFrac=0＝従来の下限1）。
      let dmg = Math.max(1, Math.ceil(h.dmg * diffMods(world.difficulty).chipFrac), h.dmg - armorReduce(ch) - (armorBuffTurns > 0 ? ARMOR_BUFF : 0));
      dmg = armorBlock(ch, dmg); // 防具 proc「受け／無効化」：一定確率でその一撃を軽減 or 0に（被ダメ確定前）
      if (deathDoorTurns > 0) dmg = 0; // 死戸＝無敵
      if (dmg > 0 && shadowGuard > 0) { shadowGuard--; dmg = 0; log(`${h.monster.kind.name}の一撃を、影が引き受けた。`, "dim"); } // 影分け
      else if (deathDoorTurns > 0) log(`${h.monster.kind.name}の一撃を、死戸が弾く。`, "warn");
      else if (h.effect === "heavy") { // ①溜め大技（B）：渾身の一撃を受けた＝重い被弾の演出
        hp -= dmg; sfx("boss", 0.16); flashFx("warp");
        floatFx(player.x, player.y, String(dmg), "fl-hurt");
        log(`${h.monster.kind.name}の渾身の一撃が炸裂した！ ${dmg}の大ダメージ。`, "warn");
      }
      else {
        hp -= dmg; log(`${h.monster.kind.name}の一撃！ ${dmg}の傷。`, "warn");
        floatFx(player.x, player.y, String(dmg), "fl-hurt");
        const clarity = ch.equipment.relic?.relic === "clarity"; // 遺物 clarity（澄心）：毒・侵蝕の蓄積を半減
        if (h.effect === "poison") { // venom（4-11G）：傷が通ると毒が回り始める（次手から継続ダメ）
          poisonTurns = Math.max(poisonTurns, clarity ? Math.ceil(VENOM_TURNS / 2) : VENOM_TURNS);
          poisonDmg = Math.max(poisonDmg, venomDmgAt(floor.depth));
          log(clarity ? `牙の毒も、澄心が和らげる（毒${Math.ceil(VENOM_TURNS / 2)}手）。` : `牙に毒が仕込まれていた――体が熱い（毒${VENOM_TURNS}手）。`, "warn");
        } else if (h.effect === "curse") { // curse（深淵帯 PR2）：傷とともに深蝕が上塗りされる
          addExp(clarity ? CURSE_EXP / 2 : CURSE_EXP);
          log(clarity ? "侵蝕が滲むが、澄心が大半を弾く。" : "傷口から深みの理が染み込む――深蝕が濃くなる。", "warn");
        }
      }
      // 遺物 thorns（茨）：被弾した近接ダメージの一部を相手へ反射（実際に傷を負った時のみ・死戸/影分けで無効化された時は出ない）
      if (dmg > 0 && ch.equipment.relic?.relic === "thorns" && h.monster.hp > 0) {
        const recoil = Math.max(1, Math.round(dmg * THORNS_FRAC));
        h.monster.hp -= recoil;
        if (h.monster.hp <= 0) downOrKill(h.monster, `${h.monster.kind.name}は茨に貫かれて斃れた。`);
        else log(`茨が${h.monster.kind.name}へ${recoil}を返す。`, "dim");
      }
      // 防具 proc（棘/怯み/威圧/清め）：実際に傷を負った時のみ発動（受けは上で dmg に適用済み）
      applyArmorProc(ch, h.monster, dmg);
    }
  }
  for (const m of res.dodges) { floatFx(player.x, player.y, "見切", "fl-miss"); log(`${m.kind.name}の一撃を見切った。`, "dim"); }
  if (res.dodges.length > 0 && hp > 0) { // D. ジャスト見切り→反撃：空振りを誘った直後は次の近接が会心
    if (counterTurns === 0) { tileFx(player.x, player.y, "tfx-ready"); floatFx(player.x, player.y, "反撃の好機", "fl-dmg"); log("空振りの隙が見えた――反撃の好機（次の近接が会心）。", "cue"); }
    counterTurns = COUNTER_WINDOW;
  }
  if (companion && companion.hp <= 0) companionDies(); // 相棒の戦死＝化石化
  } // end if(!hasted)
  // 敵図鑑：視界内の生存敵を記録（遭遇＝図鑑に編む。web限定・決定論）。
  recordBestiary();
  // 次の一手を予告する（プレイヤーが見て動けるように。相棒は連帯深蝕で erratic にぶれる）
  planMonsters(floor, player, rng, companion);
  if (companion) planCompanion(floor, player, companion, rng);
  announceBossCues(); // ボスの覚醒・大技の溜めを告知（B）

  draw();
  updateStatus(); // HP/深蝕の即時反映（蝕み・被弾・持ち物使用が毎手バーに出る）
  saveDive(); // 毎手スナップショット＝アプリを閉じても同じ深度・HPから再開（途中閉じで0階に戻る抜け道を塞ぐ）
  await handleBossResolve();
  await handleLevelUps();
  await handleDrops();
  // 連帯深蝕の危機（Phase B・C）：危険化した相棒を生者のうちに討つ/鎮める
  if (hp > 0 && companion && world.companion && world.companion.exposure >= COMPANION_DANGER_AT && !companion.crisisShown) {
    companion.crisisShown = true;
    await companionCrisis();
  }
  // 遺物 revenant（不死鳥の灰）：潜行ごと一度だけ、致死の一撃を HP1 で耐える（死戸とは別物・受動）。
  if (hp <= 0 && !revenantUsed && world.current?.equipment.relic?.relic === "revenant") {
    revenantUsed = true; hp = 1;
    sfx("seal"); flashFx("still"); updateStatus();
    log("不死鳥の灰が燃え上がる――灰の中から、もう一度。（HP1 で持ちこたえた）", "warn");
  }
  // 秘宝 blink（転移の護符）：潜行ごと一度だけ、致死を受けると死なず安全地帯へ転移し HP を一部回復（回避型）。
  if (hp <= 0 && !blinkUsed && world.current?.equipment.relic?.relic === "blink" && floor) {
    blinkUsed = true; hp = Math.max(1, Math.round(maxHp(ch) * 0.4));
    const safe = randomFloorAway(floor, rng, player, 7) ?? randomFloorAway(floor, rng, player, 3);
    if (safe) { player = { x: safe.x, y: safe.y }; if (companion) spawnCompanionNear(player); }
    sfx("intervene"); flashFx("blink"); planMonsters(floor, player, rng, companion); updateStatus();
    log("転移の護符が砕け、光がお前を物陰へ運んだ――危機を脱した。", "warn");
  }
  if (hp <= 0) { await deathFlow(); return; }
  // 帰還の詠唱（v2）：詠唱が満ちたら地上へ還る（聖遺物携行中は奉献成立＝NetHack 昇天ラン型の山場）。
  if (chantTurns > 0) {
    chantTurns--;
    if (chantTurns === 0) {
      sfx("intervene"); flashFx("warp");
      if (ch.carryingRelic) { await ascendWithRelic(); return; }
      log("詠唱が満ちる――視界が白に溶け、地上の光が射した。", "cue");
      await surfaceReturn();
      return;
    }
    log(`帰還の詠唱――地が遠ざかってゆく（あと${chantTurns}手）。`, "cue");
  }
}

// ---------- 装備（4-11F④）。拾得＝装備プロンプト。ボス/宝箱から入手。 ----------
let pendingDrops: Item[] = [];
let pendingBossResolve: Monster[] = [];

// ボスの戦術化（B）の演出告知：engine（dungeon.ts）は純粋ゆえ、覚醒・大技の溜めは web 側で一度ずつログ＋音に。
const bossEnragedSeen = new Set<string>();
const bossHeavySeen = new Set<string>();
function announceBossCues() {
  if (!floor) return;
  for (const m of floor.monsters) {
    if (m.boss !== "area" || m.hp <= 0) continue;
    if (m.enraged && !bossEnragedSeen.has(m.id)) { // ②怒りフェーズ：覚醒の瞬間を告知（一度きり）
      bossEnragedSeen.add(m.id);
      sfx("boss"); flashFx("warp");
      log(`${m.kind.name}が覚醒した……！ 攻撃が鋭さを増し、眷属を呼び始める。`, "warn");
    }
    const heavy = m.intent?.type === "attack" && m.intent.heavy; // ①溜め大技：構えを告知（構え直すたび）
    if (heavy && !bossHeavySeen.has(m.id)) {
      bossHeavySeen.add(m.id);
      sfx("drain", 0.05);
      log(`${m.kind.name}が渾身の一撃を溜めている！ 間合いから退くか、備えよ。`, "warn");
    } else if (!heavy) bossHeavySeen.delete(m.id);
  }
}

/** 撃破処理の入口。敵性化探索者ボス（出自=化石）は「討つ/鎮める」へ。それ以外は通常撃破。 */
function downOrKill(mon: Monster, killLine?: string) {
  floatFx(mon.x, mon.y, "＊", "fl-kill"); // 撃破の燐光（v0.99.0・純表示）
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
    // 出自の化石と縁を読む（4-6 物語化）：知っていた相手なら決着に重みが出る。
    const fossil = boss.fossilId ? world.fossils.find((f) => f.id === boss.fossilId) : undefined;
    const bond = boss.fossilId ? ch.bonds.find((b) => b.entityRef === boss.fossilId) : undefined;
    const wasComp = !!fossil?.wasCompanion;
    const wasAlly = !!fossil?.wasAlly;
    const known = wasComp || wasAlly || (!!bond && (bond.value > 0 || bond.unfinished));
    const isDoom = !!boss.fossilId && (world.tracked ?? []).some(
      (t) => t.originRef === boss.fossilId && (t.arcType === "doom" || t.arcType === "fall"),
    );
    // setpiece 級の決着文を組む（化石の出自・口癖・縁・弧を織り込む）。
    const lines: string[] = [`${boss.kind.name}が、膝をついた。かつて人だったものの眼が、こちらを見ている。`];
    if (wasComp) lines.push("――かつて共に深みを歩いた相棒だ。歪んだ貌の奥に、あの面影がまだ揺らいでいる。");
    else if (bond?.unfinished) lines.push("――果たせなかった約束の相手だった。こんな姿で再び巡り合うとは。");
    else if (known) lines.push("――かつて縁を結んだ者。覚えている、この眼を。");
    if (fossil?.origin.catchphrase) lines.push(`ひび割れた声が、生前の口癖を漏らす。『${fossil.origin.catchphrase}』`);
    if (isDoom) lines.push("いつか英雄と謳われたその名が、深みに食われ、ここまで堕ちた。弧の終端が、目の前にある。");
    lines.push(known ? "とどめを刺すか、鎮めるか――それとも、名を呼ぶか。" : "とどめを刺すか――それとも、鎮めるか。");

    const opts = ["討つ（とどめ：XP満額＋遺物）", "鎮める（祈り：非殺・年代記に残る）"];
    if (known) opts.push("名を呼ぶ（呼び戻しを試みる）"); // 縁ある相手だけの第三の決着（4-6）
    const r = await sheet({
      text: lines.join("\n"),
      meta: `${boss.kind.name} ── 決着（戦闘版の干渉）${known ? " / 縁" : ""}`,
      options: opts,
    });
    const halfXp = () => { ch.xp += killXpFor(boss.kind.hp, floor?.depth ?? ch.depth ?? 1, 0.5); }; // 非殺＝報酬控えめ（慈悲の代償）・深度係留込み

    if (opts[r.pick - 1] === "名を呼ぶ（呼び戻しを試みる）" && boss.fossilId) {
      // 呼び戻し＝人だった芯に届く最も人間的な決着。安らかに送り、記憶に深く刻む。
      sfx("intervene"); flashFx("still");
      intervene(world, boss.fossilId, "memorial"); // 因縁を閉じる＋弧の時計を巻き戻す（accrueArcWarp）
      halfXp();
      const before = ch.exposure;
      ch.exposure = Math.max(0, ch.exposure - 0.5); // 届いた手応え＝人間性の回復（山場級）
      ch.traits.push(`${fossil?.origin.name ?? boss.kind.name}を呼び戻した`);
      log(`★ ${ch.name}は${fossil?.origin.name ?? boss.kind.name}の名を呼んだ。歪みの底で、一瞬、人の貌が還った。`, "warn");
      if (ch.exposure < before) log(`その手応えが、深みに削られた芯を人へ還す（深蝕 -${(before - ch.exposure).toFixed(2)}）。`, "dim");
      chronicle(world, "legend", `${ch.name}が深度${floor!.depth}で${boss.kind.name}に名を呼びかけ、安らかに送った。`, [ch.id, boss.fossilId]);
      if (isDoom) log(`${fossil?.origin.name ?? boss.kind.name}の堕ちゆく弧が、ここで静かに閉じた。`, "cue");
      if (boss.boss === "area") spawnReturnDoor(boss);
      recordCompanionFeat();
    } else if (r.pick === 2 && boss.fossilId) {
      sfx("intervene"); flashFx("still");
      intervene(world, boss.fossilId, "requiem"); // 出自の化石を鎮魂（4-2 干渉動詞）
      halfXp();
      log(`★ ${ch.name}は${boss.kind.name}を鎮めた。深みの底で、何かが静かになった。`, "warn");
      chronicle(world, "intervention", `${ch.name}が深度${floor!.depth}で${boss.kind.name}を鎮めた。`, [ch.id, boss.fossilId]);
      if (isDoom) log(`${fossil?.origin.name ?? boss.kind.name}の堕ちゆく弧が、ここで閉じた。`, "cue");
      if (boss.boss === "area") spawnReturnDoor(boss); // 帰還の扉＝往復チェックポイント（v2・鎮めでも出現）
      recordCompanionFeat(); // 相棒と共にボスを鎮めた＝偉業（4-4E 昇格ゲート）
    } else {
      rewardKill(boss); // 討つ＝通常撃破（XP満額＋ドロップ＋legend＋abyss_boss 印）
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
    meta: `${SLOT_LABEL[item.slot]} ── 拾い物（荷物 ${packUsed(ch)}/${packCapacity(ch)}）`,
    options: [cur ? `装備する（今の${SLOT_LABEL[item.slot]}は荷物へ）` : "装備する", "荷物にしまう（街/行商人で売る）", "見送る（置いていく）"],
  });
  if (r.pick === 1) {
    item.unidentified = false; // 装備で鑑定
    ch.equipment[item.slot] = item;
    sfx("equip");
    log(`${item.name} を装備した（${itemPower(item)}）。`);
    if (item.exposurePerTurn) log("……身につけた途端、深みがじわりと滲む。", "warn");
    if (cur) await gearBagPush(cur); // 外した今の装備は袋へ（消失しない。満杯なら捨てる物を選ばせる）
  } else if (r.pick === 2) {
    await gearBagPush(item);
  }
  save();
}

/** 袋から「同じ実体（参照）」の重複を除く防御。万一どこかで同一 Item オブジェクトが二重に入っても、
 *  売却/装備リストに二度現れて「持っていない物を売れる」状態（テストプレイFB・再発）を断つ。
 *  値が同じだけの別実体（正当な同名ドロップ）は残す＝参照一致のみ除去。 */
function dedupeGearBag(ch: Character): void {
  const bag = ch.gearBag;
  if (!bag || bag.length < 2) return;
  const seen = new Set<Item>();
  const cleaned = bag.filter((it) => (seen.has(it) ? false : (seen.add(it), true)));
  if (cleaned.length !== bag.length) { ch.gearBag = cleaned; save(); } // 重複を実際に除いたら永続化
}

/** 拾った装備を袋へ。満杯なら入れ替え（古いものを置いていく）か見送りを選ばせる。 */
async function gearBagPush(item: Item): Promise<void> {
  const ch = world.current!;
  ch.gearBag ??= [];
  const cap = packCapacity(ch);
  if (packUsed(ch) >= cap) { // 荷物（武具＋消耗品）が満杯＝何かを置くか見送る
    const r = await sheet({
      text: `荷物がいっぱいだ（${packUsed(ch)}/${cap}）。\n武具を置いて、これを入れるか？（薬を減らすなら持ち物から）`,
      meta: "荷物 ── 満杯",
      options: [...ch.gearBag.map((g) => `「${itemLabel(g)}」を置いて入れ替える`), "これを見送る"],
    });
    const i = r.pick - 1;
    if (i < 0 || i >= ch.gearBag.length) { log(`${item.name} は置いていった。`, "dim"); return; }
    const dropped = ch.gearBag.splice(i, 1)[0];
    ch.gearBag.push(item);
    log(`「${itemLabel(dropped)}」を置き、${item.name} を荷物に入れた。`, "dim");
    return;
  }
  ch.gearBag.push(item);
  sfx("pickup");
  log(`${item.name} を荷物にしまった（${packUsed(ch)}/${cap}）。街の武具屋か、迷宮の行商人に売れる。`, "dim");
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
  const hasEcho = (world.echoes?.length ?? 0) > 0; // 残響の遺灰（4-10I）を持つか
  const canCast = ch.spells.length > 0 && activeLoadout(ch).length > 0;
  if (!canCast && !hasEcho) {
    if (ch.spells.length === 0) log("まだ術を識らない。レベルアップ/深淵/教団で識れる。", "dim");
    else log("術を構えていない。下部タブ「ステータス」→術（構え・図鑑）で構えを整えよ。", "dim");
    return;
  }
  // 残響の遺灰を持つなら、術詠唱と展開の二択を挟む（術を識らずとも遺灰だけは使える）。
  if (hasEcho) {
    if (!canCast) { await deployEcho(ch); return; }
    busy = true;
    const r = await sheet({ text: "術を撃つか、在りし日の残響を喚ぶか。", meta: "術 / 残響", options: [`残響の遺灰を使う（×${world.echoes!.length}）`, "術を撃つ", "やめる"] });
    busy = false;
    if (r.pick === 1) { await deployEcho(ch); return; }
    if (r.pick === 3) return;
  }
  const loadout = activeLoadout(ch);
  busy = true;
  const known = loadout.map((k) => spellByKey(k)).filter((s): s is NonNullable<typeof s> => !!s);
  // 選びやすい2列グリッド：学派の色チップ＋深蝕コスト＋効果（4-11F③）。
  const cells = known.map((s) => ({
    html: `<span class="chip ${schoolCls(s.school)}">${s.school}</span><div class="nm">${s.name}</div><div class="sub">深蝕<span class="cost">＋${s.cost}</span>・${s.desc}</div>`,
  }));
  const i = await chooseGrid({ title: `術 ── 構え ${loadout.length}/${LOADOUT_CAP}（深蝕で支払う・今 ${ch.exposure.toFixed(2)}）`, cells, cancel: "やめる" });
  busy = false;
  if (i >= 0) await castSpell(known[i].key);
};
// 持ち物ボタン（潜行中）：消耗品を使う。使うと一手かかる＝敵が動く（戦術的判断）。
$("bagBtn").onclick = async () => {
  if (busy || (mode !== "dive" && mode !== "raid") || !floor || !world.current) return;
  const ch = world.current;
  const inv = ch.inventory ?? [];
  if (!inv.length) { log("持ち物は空だ。街の道具屋ハルで消耗品を仕入れられる。", "dim"); return; }
  busy = true;
  const cells = inv.map((s) => {
    const def = consumableByKey(s.key);
    return { html: `<div class="nm">${def?.name ?? s.key} <span style="color:#9aa4b0;font-weight:400">×${s.qty}</span></div><div class="sub">${def?.desc ?? ""}</div>` };
  });
  const i = await chooseGrid({ title: `持ち物 ${packUsed(ch)}/${packCapacity(ch)}（使うと一手）`, cells, cancel: "やめる" });
  busy = false;
  if (i < 0 || i >= inv.length) return;
  const s = inv[i], def = consumableByKey(s.key);
  const msg = applyConsumable(ch, s.key); consumeOne(ch, s.key);
  sfx("consume");
  log(`${def?.name} を使った（${msg}）。`, "warn");
  await turnPass(); // 一手経過＝敵の手番（迷宮／街防衛戦）
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
/** 残響の遺灰を展開（4-10I）：神話極の鎮魂で得た遺灰を1つ消費し、強めの一時味方を喚ぶ。代償＝深蝕。一手かかる。 */
async function deployEcho(ch: Character) {
  const echoes = world.echoes ?? [];
  if (!echoes.length || (mode !== "dive" && mode !== "raid") || !floor) return;
  busy = true;
  const cells = echoes.map((e) => ({
    html: `<span class="chip c-sup">残響</span><div class="nm">${e.name}の残響</div><div class="sub">威力${e.dmg}・8手・追従／代償 深蝕＋${ECHO_DEPLOY_COST}</div>`,
  }));
  const i = await chooseGrid({ title: "残響の遺灰を使う（一手・展開で消費）", lead: "在りし日の英雄が、束の間、傍らに立つ。", cells, cancel: "やめる" });
  busy = false;
  if (i < 0 || i >= echoes.length) return;
  const e = echoes[i];
  const ok = spawnSummon(player, "Ψ", `${e.name}の残響`, e.dmg, 8, true); // 術 echo（6手）より強め・長寿命（8手）
  if (!ok) { log("残響の立つ隙間がない。", "dim"); return; } // 隙間なし＝遺灰は消費しない
  consumeEcho(world, ch, i); // 遺灰を1つ消費＋展開の代償（深蝕＋ECHO_DEPLOY_COST）＝純関数・world.ts
  sfx("spell_summon"); flashFx("warp", { x: player.x, y: player.y });
  log(`${e.name}の残響が、傍らに立った（威力${e.dmg}・8手・深蝕＋${ECHO_DEPLOY_COST}）。`, "cue");
  save(); updateStatus();
  await turnPass(); // 一手経過＝敵の手番（術・消耗品と同じ。街防衛戦でも可）
}
/** 召喚の手番：隣接敵を討つ／いなければ最寄り敵（follow なら @）へ1歩。寿命を消費し、尽きたら霧散。 */
function resolveSummons() {
  if (!floor || !summons.length) return;
  for (const s of summons) {
    const adj = floor.monsters.find((m) => m.hp > 0 && Math.max(Math.abs(m.x - s.x), Math.abs(m.y - s.y)) <= 1);
    if (adj) {
      adj.hp -= s.dmg; floatFx(adj.x, adj.y, String(s.dmg), "fl-dmg"); flashFx("warp", { x: adj.x, y: adj.y }); // 召喚の与ダメも数字ポップ（毎手ゆえログは出さない）
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
  if (busy || (mode !== "dive" && mode !== "raid") || !floor || !world.current) return;
  const ch = world.current;
  const def = spellByKey(key);
  if (!def) return;
  const vis = computeFov(floor, player);
  const visMon = floor.monsters.filter((m) => m.hp > 0 && vis.has(mapIdx(floor!, m.x, m.y)));

  if (key === "warp_strike") {
    if (!visMon.length) { log("討つべき敵が見えない。", "dim"); draw(); return; }
    const target = visMon.reduce((a, b) =>
      Math.hypot(a.x - player.x, a.y - player.y) <= Math.hypot(b.x - player.x, b.y - player.y) ? a : b);
    const dmg = spellBase(ch); // 遺物「理脈」で威力+
    target.hp -= dmg;
    floatFx(target.x, target.y, String(dmg), "fl-dmg"); // 盤上ダメージ数字（近接と揃える・術の手応え）
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
    const dmg = Math.round(spellBase(ch) * 0.8);
    let hitN = 0;
    for (let i = 1; i <= 9; i++) {
      const x = player.x + sx * i, y = player.y + sy * i;
      if (tileAt(floor, x, y) !== 1) break; // 壁で止まる
      const m = floor.monsters.find((mm) => mm.hp > 0 && mm.x === x && mm.y === y);
      if (m) { m.hp -= dmg; hitN++; floatFx(x, y, String(dmg), "fl-dmg"); flashFx("warp", { x, y }); if (m.hp <= 0) downOrKill(m, `裂界が${m.kind.name}を裂いた。`); }
    }
    sfx("spell_warp");
    log(hitN ? `裂界が一直線を貫く（${hitN}体・各${dmg}）。` : "裂界は空を裂いた。");
  } else if (key === "collapse") { // 崩落＝最寄りを中心に範囲ダメージ
    if (!visMon.length) { log("崩す相手が見えない。", "dim"); draw(); return; }
    const t = nearestMon(visMon);
    const dmg = Math.round(spellBase(ch) * 0.7);
    let hitN = 0;
    for (const m of floor.monsters) {
      if (m.hp > 0 && Math.max(Math.abs(m.x - t.x), Math.abs(m.y - t.y)) <= 1) {
        m.hp -= dmg; hitN++; floatFx(m.x, m.y, String(dmg), "fl-dmg"); flashFx("warp", { x: m.x, y: m.y });
        if (m.hp <= 0) downOrKill(m, `崩落が${m.kind.name}を呑んだ。`);
      }
    }
    sfx("spell_warp");
    log(`崩落（${hitN}体・各${dmg}）。`);
  } else if (key === "thunder") { // 雷霆＝可視の敵すべてに放射状の雷（弱め）
    if (!visMon.length) { log("雷を落とす敵が見えない。", "dim"); draw(); return; }
    const dmg = Math.max(1, Math.round(spellBase(ch) * 0.5));
    for (const m of visMon) { m.hp -= dmg; floatFx(m.x, m.y, String(dmg), "fl-dmg"); if (m.hp <= 0) downOrKill(m, `雷霆が${m.kind.name}を撃ち抜いた。`); }
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
    floatFx(t.x, t.y, String(dmg), "fl-dmg");
    sfx("spell_blink");
    if (t.hp <= 0) downOrKill(t, `迫り、${t.kind.name}を討ち砕いた。`);
    else log(`迫って${t.kind.name}を斬りつける（${dmg}）。`);
  } else if (key === "heal") { // 癒し＝HP回復（理＋体）。死戸中は回復不可
    if (deathDoorTurns > 0) { log("死戸が開いている間は、癒えない。", "dim"); draw(); return; }
    const amt = effectiveReason(ch) + ch.stats.body;
    const before = hp; hp = Math.min(maxHp(ch), hp + amt);
    sfx("spell_heal"); flashFx("still");
    if (hp > before) floatFx(player.x, player.y, `+${hp - before}`, "fl-heal");
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
    const dmg = Math.round(spellBase(ch) * 0.6);
    const dealt = Math.min(dmg, t.hp);
    t.hp -= dmg;
    floatFx(t.x, t.y, String(dmg), "fl-dmg");
    const before = hp; if (deathDoorTurns === 0) hp = Math.min(maxHp(ch), hp + Math.ceil(dealt / 2)); // 死戸中は吸命しても癒えない
    if (hp > before) floatFx(player.x, player.y, `+${hp - before}`, "fl-heal");
    sfx("spell_warp"); flashFx("warp", { x: t.x, y: t.y });
    if (t.hp <= 0) downOrKill(t, `吸命が${t.kind.name}を干涸びさせた。`);
    else log(`吸命が${t.kind.name}を蝕む（与${dmg}／HP＋${hp - before}）。`);
  } else if (key === "ironscale") { // 硬鱗＝数手 被ダメ軽減
    armorBuffTurns = 5;
    sfx("spell_still"); flashFx("still");
    log(`硬鱗。鱗が立ち、守りが固まった（被ダメ−${ARMOR_BUFF}・5手）。`);
  } else if (key === "haste") { // 疾走＝数手 敵手番スキップ
    hasteTurns = 3;
    sfx("spell_blink"); flashFx("blink", { x: player.x, y: player.y });
    log("疾走。世界が、ゆっくりと流れ出す（3手）。");
  } else if (key === "frenzy") { // 焦躁＝数手 近接ダメ上乗せ
    attackBuffTurns = 5;
    sfx("spell_still"); flashFx("warp", { x: player.x, y: player.y });
    log(`焦躁。手が冴え、苛立ちが募る（攻撃＋${ATTACK_BUFF}・5手）。`);
  } else if (key === "deathdoor") { // 死戸＝数手 無敵だが癒えず、明けに反動
    deathDoorTurns = 4;
    sfx("spell_still"); flashFx("still");
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
  } else if (key === "homeward") { // 帰還の詠唱（v2）＝数手の詠唱で地上へ還る（聖遺物携行中は奉献成立）。詠唱中は無防備・動くと中断
    chantTurns = HOMEWARD_CHANT;
    sfx("spell_still"); flashFx("warp", { x: player.x, y: player.y });
    log(ch.carryingRelic
      ? `帰還の詠唱を始める。聖遺物を抱いたまま――満ちれば、奉献が成る（${HOMEWARD_CHANT}手・無防備・動くと中断）。`
      : `帰還の詠唱を始める（${HOMEWARD_CHANT}手・詠唱中は無防備・動くと中断）。`, "cue");
  } else if (key === "cleanse") { // 解呪＝今この場で深蝕をいくらか祓う（潜行中の浄化弁）
    const before = ch.exposure;
    cleanseExposure(ch, 0.6); // 教団の烙印より下へは祓えない（②）
    sfx("spell_heal"); flashFx("still");
    log(`解呪。胸の澱が祓われる（深蝕 -${(before - ch.exposure).toFixed(2)}）。`);
  } else if (key === "survey") { // 地相＝フロアの地形を感知（地図が開く）
    for (let i = 0; i < floor.explored.length; i++) floor.explored[i] = true;
    sfx("spell_still");
    log("地相を読む。この階の輪郭が、頭に灯った。");
  } else if (key === "ice_tomb") { // 氷棺＝高威力＋凍結
    if (!visMon.length) { log("討つべき敵が見えない。", "dim"); draw(); return; }
    const t = nearestMon(visMon);
    const dmg = Math.round(spellBase(ch) * 1.3);
    t.hp -= dmg; t.stunned = Math.max(t.stunned ?? 0, 2);
    floatFx(t.x, t.y, String(dmg), "fl-dmg");
    sfx("spell_warp"); flashFx("still", { x: t.x, y: t.y });
    if (t.hp <= 0) downOrKill(t, `氷棺が${t.kind.name}を砕いた。`); else log(`氷棺が${t.kind.name}を封じる（${dmg}・凍結）。`);
  } else if (key === "wither") { // 痩身＝現在HPの割合を削る（硬い敵に効く）
    if (!visMon.length) { log("削る相手が見えない。", "dim"); draw(); return; }
    const t = nearestMon(visMon);
    const cut = Math.max(1, Math.ceil(t.hp * 0.4));
    t.hp -= cut;
    floatFx(t.x, t.y, String(cut), "fl-dmg");
    sfx("spell_warp"); flashFx("warp", { x: t.x, y: t.y });
    if (t.hp <= 0) downOrKill(t, `痩身が${t.kind.name}を朽ちさせた。`); else log(`痩身が${t.kind.name}を削る（HP−${cut}）。`);
  } else if (key === "condemn") { // 断罪＝一撃必殺級（深蝕は極めて重い）
    if (!visMon.length) { log("断ずべき敵が見えない。", "dim"); draw(); return; }
    const t = nearestMon(visMon);
    const dmg = Math.round(spellBase(ch) * 3);
    t.hp -= dmg;
    floatFx(t.x, t.y, String(dmg), "fl-dmg");
    sfx("spell_warp"); flashFx("warp", { x: t.x, y: t.y });
    if (t.hp <= 0) downOrKill(t, `断罪。${t.kind.name}は赦されなかった。`); else log(`断罪が${t.kind.name}を灼く（${dmg}）。`);
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
    for (const m of visMon) { m.hp -= dmg; floatFx(m.x, m.y, String(dmg), "fl-dmg"); flashFx("warp", { x: m.x, y: m.y }); if (m.hp <= 0) downOrKill(m, `万象斬が${m.kind.name}を断った。`); }
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
    sfx("spell_still");
    log(census ? `看破：${census}` : "看破：視界に敵影なし。", "warn");
  } else if (key === "scent") { // 嗅ぎ＝宝箱・化石・下り階段の在処を地図に灯す
    let n = 0;
    for (const c of floor.chests) if (!c.opened) { floor.explored[mapIdx(floor, c.x, c.y)] = true; n++; }
    for (const fo of floor.fossils) floor.explored[mapIdx(floor, fo.x, fo.y)] = true;
    floor.explored[mapIdx(floor, floor.stairsDown.x, floor.stairsDown.y)] = true;
    sfx("spell_still");
    log(`嗅ぎ：宝箱${n}・化石${floor.fossils.length}の気配を地図に灯した。`, "warn");
  } else if (key === "minions") { // 蝕兵＝最寄りの敵の傍に短命の眷属2体
    if (!visMon.length) { log("眷属を差し向ける敵が見えない。", "dim"); draw(); return; }
    const t = nearestMon(visMon);
    const dmg = Math.max(2, Math.round(effectiveReason(ch)));
    let n = 0; for (let i = 0; i < 2; i++) if (spawnSummon(t, "ψ", "蝕兵", dmg, 5, false)) n++;
    sfx("spell_summon"); flashFx("warp", { x: t.x, y: t.y });
    log(n ? `蝕兵を${n}体起こした（各${dmg}・5手）。` : "湧かせる隙間がない。");
  } else if (key === "orbblade") { // 廻刃＝自分の傍を回る刃（@に追従）
    const dmg = Math.max(2, Math.round(effectiveReason(ch) * 1.2));
    const ok = spawnSummon(player, "‡", "廻刃", dmg, 6, true);
    sfx("spell_summon"); flashFx("warp", { x: player.x, y: player.y });
    log(ok ? `廻刃を侍らせた（${dmg}・6手・追従）。` : "刃を置く隙間がない。");
  } else if (key === "echo") { // 残響召喚＝在りし日の残響（強めの一時味方・@に追従）
    const dmg = Math.max(3, Math.round(effectiveReason(ch) * 1.6));
    const ok = spawnSummon(player, "Ψ", "残響", dmg, 6, true);
    sfx("spell_summon"); flashFx("still", { x: player.x, y: player.y });
    log(ok ? `在りし日の残響が、傍らに立った（${dmg}・6手）。` : "残響の立つ隙間がない。");
  } else if (key === "shadowclone") { // 影分け＝数手 敵の一撃を肩代わり
    shadowGuard = 3;
    sfx("spell_blink"); flashFx("blink", { x: player.x, y: player.y });
    log("影分け。三つの影が、身代わりに立つ（3度まで）。");
  }

  // 秘宝 spellcrown（秘術の宝冠）：術の深蝕コストを軽減＝魔法ビルドの核。
  const crownCost = ch.equipment.relic?.relic === "spellcrown" ? SPELLCROWN_COST_MUL : 1;
  const gain = def.cost * heartFactor(ch) * crownCost; // 心（染み込み係数）で術の深蝕代償が和らぐ＝v2 の主累積源①
  addExp(gain);
  log(`（${def.name}の代償：深蝕＋${gain.toFixed(2)}）`, "dim");
  await turnPass();
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
      sfx("levelup");
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
          text: `深みから術が滲む。1つ識るか？（${LEARN_EVERY}レベルに1度。構えは 下部タブ「ステータス」→術 で整える）`,
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
/** 図でタップした既踏破地点まで自動移動。敵が見えたら/場面が開いたら止まる（4-11 便利機能）。 */
async function autoTravel(dest: Pos) {
  if (busy || mode !== "dive" || !floor) return;
  const path = bfsPath(floor, player, dest);
  if (!path || !path.length) { log("そこへの道が見つからない。", "dim"); return; }
  for (const step of path) {
    if (busy || mode !== "dive" || !floor) break;
    // 敵が見えていたら自動移動は危険なので止める
    const vis = computeFov(floor, player);
    if (floor.monsters.some((m) => m.hp > 0 && vis.has(mapIdx(floor!, m.x, m.y)))) { log("敵の気配。自動移動を止めた。", "warn"); break; }
    const dx = Math.sign(step.x - player.x), dy = Math.sign(step.y - player.y);
    const px = player.x, py = player.y;
    if (!moveOrInteract(player.x + dx, player.y + dy)) break; // 壁
    if (busy) { draw(); break; } // 宝箱/化石/階段の場面が開いた＝そこで止める
    await endTurn();
    if (hp <= 0 || (player.x === px && player.y === py)) break; // 死亡 or 進めず
    await sleep(70);
  }
}

// ---------- 照準モード（地図でタップ→マーカー→D-padで微調整→確定・改善FB 2026-06-23）----------
/** 照準バーの表示更新（到達可否で「ここへ移動」を活性/非活性）。 */
function updateAimBar(): void {
  const bar = $("aimBar");
  if (!aim) { bar.hidden = true; return; }
  bar.hidden = false;
  bar.classList.toggle("unreach", !aimReachable);
  $("aimMsg").textContent = aimReachable ? "目標を方向パッドで調整" : "そこへは道がない";
}
/** マーカーを置く/動かす（clamp＋到達判定＋再描画）。 */
function setAim(x: number, y: number): void {
  if (!floor) return;
  const nx = Math.max(0, Math.min(floor.w - 1, x)), ny = Math.max(0, Math.min(floor.h - 1, y));
  aim = { x: nx, y: ny };
  aimPath = bfsPath(floor, player, aim); // 経路を保持＝地図に点で描く（v0.99.0）
  aimReachable = !!aimPath;
  ensureMapVisible(aim); // 照準を D-pad で画面外へ動かしたらカメラが追う（v0.109.0）
  updateAimBar();
  drawMapMode();
}
/** 照準を解除（地図モードは維持＝再タップで置き直せる）。 */
function cancelAim(): void { aim = null; aimPath = null; updateAimBar(); if (mapMode) drawMapMode(); }
/** 確定＝マーカーまで自動移動（到達可のときだけ）。 */
function confirmAim(): void {
  if (!aim || !floor) return;
  if (!aimReachable) { log("そこへの道が見つからない。", "dim"); return; }
  const dest = aim;
  cancelAim();
  setMapMode(false);
  void autoTravel(dest);
}

/** 帰還の扉を据える（v2）：エリアボス撃破地点に往復チェックポイントを生成。深淵帯では出さない
 *  （試練の脱出は上り階段／帰還の詠唱のみ）。1フロア1つ。塞がっていれば近傍へ。 */
function spawnReturnDoor(mon: Monster): void {
  if (!floor || inAbyss || floor.returnDoor) return;
  const at = (tileAt(floor, mon.x, mon.y) === 1) ? { x: mon.x, y: mon.y } : freeFloorSpotNear({ x: mon.x, y: mon.y });
  if (!at) return;
  floor.returnDoor = at;
  log("討たれたものの居た場所に、ほのかな光の門が立ち上がった――帰還の扉。街と往復できる。", "warn");
}

/** 撃破時の報酬：XP（敵の堅さ比例）。ボスは特別演出＋年代記に刻む（4-11F）。 */
// ── 秘宝（artifact）の入手（2026-07-03・酒場の裏取引を廃止→深層レアドロップ＋統治者の大命の褒賞）──
const ARTIFACT_MIN_DEPTH = 20;    // これ未満の深度では秘宝は出ない（中盤以降）
const ARTIFACT_CHEST_BASE = 0.04; // 宝箱：深度20で4%、深いほど上昇
const ARTIFACT_BOSS_BASE = 0.35;  // エリアボス：深度20で35%、深いほど上昇（ボスは秘宝の主源）
/** 深度に応じた秘宝ドロップ率（上限つき・深いほど高い）。 */
function artifactChance(depth: number, base: number, cap: number): number {
  if (depth < ARTIFACT_MIN_DEPTH) return 0;
  return Math.min(cap, base + (depth - ARTIFACT_MIN_DEPTH) * 0.004);
}
/** 秘宝を1点生成（鑑定済み）。武器/防具は深度で +N が少し伸びる（深いほど強い）。遺物は基効果のみ。 */
function rollArtifact(depth: number): Item | null {
  const names = artifactBaseNames();
  if (!names.length) return null;
  const base = names[Math.floor(rng.next() * names.length)];
  const ench = 1 + Math.min(2, Math.floor((depth - ARTIFACT_MIN_DEPTH) / 14)); // depth20→+1・34→+2・48+→+3
  const it = forgeItem(base, null, ench);
  if (it) it.unidentified = false;
  return it;
}
function rewardKill(mon: Monster, killLine?: string) {
  const ch = world.current!;
  ch.xp += killXpFor(mon.kind.hp, floor?.depth ?? ch.depth ?? 1); // 遺物「貪欲」（難易度別倍率）＋深度係留込み（v0.121.0）
  if (mon.boss) {
    sfx("boss_down");
    flashFx("warp");
    log(`★ ${mon.kind.name}を打ち倒した！`, "warn");
    chronicle(world, "legend", `${ch.name}が深度${floor!.depth}で${mon.kind.name}を打ち倒した。`, [ch.id]);
    // ボスドロップ：エリアは確定、エリートは高確率（手番末の装備プロンプトへ）
    if (mon.boss === "area" || rng.next() < 0.7) pendingDrops.push(rollItem(floor!.depth, rng, { boss: true }));
    // 秘宝レアドロップ（2026-07-03）：エリアボスは深度20+で高確率に秘宝を追加で落とす（秘宝の主源）。
    if (mon.boss === "area" && rng.next() < artifactChance(floor!.depth, ARTIFACT_BOSS_BASE, 0.6)) {
      const art = rollArtifact(floor!.depth);
      if (art) { pendingDrops.push(art); log("亡骸の奥で、秘宝が妖しく脈打っている。", "warn"); }
    }
    // 奉献の試練・印①：エリアボス（成れの果て）を撃破（4-13A）
    if (mon.boss === "area" && awardSeal(world, "abyss_boss", [ch.id])) {
      sfx("seal"); log("◆ 「成れの果ての討伐」の印を得た。", "warn");
    }
    if (mon.boss === "area") spawnReturnDoor(mon); // 帰還の扉＝往復チェックポイント（v2・深淵帯を除く）
    if (mon.boss === "area") for (const l of onSlayBoss(world, floor!.depth)) log(l, "cue"); // 討伐系の大命達成（4-14G）
    recordCompanionFeat(); // 相棒と共にボスを討った＝偉業（4-4E 昇格ゲート）
    // ボスは金貨も確定で落とす（rare＝farm無し）。
    const bonus = 5 * mon.kind.tier + floor!.depth * 3; // 深度係数を強化（旧 +depth は深度50で75金＝雑魚以下だった）
    ch.gold += bonus; sfx("coin", 0.12);
    log(`亡骸から ${bonus} 金貨を得た（所持 ${ch.gold}）。`, "dim");
  } else {
    sfx("kill");
    log(killLine ?? `${mon.kind.name}を倒した。`);
    rollKillLoot(mon); // 雑魚の討伐報酬（控えめ・深度スケール・farm根絶下なので安全：NetHack流のたまドロップ）
  }
  // 討伐依頼（bounty）：対象種の撃破を数える（純ヘルパを web からのみ呼ぶ＝golden 安全）。
  for (const l of onKillMonster(world, mon.kind.key, floor?.depth ?? 1)) log(l, "cue");
}

/** 雑魚討伐のドロップ（4-10G 拡張・NetHack の death drop 流＝たまに・深度依存）。
 *  気前＝控えめ：金貨~15%／武具~1/8(+tier)／消耗品~6%。袋満杯なら武具は見送り（売って空ける）。 */
function rollKillLoot(mon: Monster): void {
  const ch = world.current; if (!ch || !floor) return;
  const depth = floor.depth, tier = mon.kind.tier;
  if (rng.next() < 0.15) { // 金貨：亡骸から拾うめぼしい物
    let g = 1 + tier + Math.floor(depth * 0.35) + Math.floor(rng.next() * 3);
    if (ch.equipment.relic?.relic === "fortune") g = Math.round(g * 1.5); // 遺物 fortune＝拾う金貨↑
    else if (ch.equipment.relic?.relic === "goldvein") g = Math.round(g * 2.2); // 秘宝 goldvein（金蔓の指輪）＝拾う金貨を大幅増
    ch.gold += g; sfx("coin", 0.1);
    log(`亡骸から ${g} 金貨を拾った（所持 ${ch.gold}）。`, "dim");
  }
  if (rng.next() < 0.125 + (tier - 1) * 0.03) { // 武具：既存 rollItem→荷物（消耗品と共有の容量制）
    ch.gearBag ??= [];
    const it = rollItem(depth, rng);
    if (packUsed(ch) < packCapacity(ch)) { // 空きがあれば低摩擦の自動収納（従来どおり）
      ch.gearBag.push(it); sfx("pickup", 0.1);
      log(`亡骸が ${itemLabel(it)} を遺していた（荷物 ${packUsed(ch)}/${packCapacity(ch)}）。`, "dim");
    } else { // 満杯でも捨てない＝手番のあとに装備/入替/見送りを選ぶ（宝箱/ボスと同じ pendingDrops→handleDrops 経路）
      pendingDrops.push(it); sfx("pickup", 0.1);
      log(`亡骸が ${itemLabel(it)} を遺した——荷物は満杯。取捨はこの手番のあとで選ぶ。`, "dim");
    }
  }
  if (rng.next() < 0.06) { // 消耗品：たまに薬の類（上位品は等級で解禁＝浅層で深部品を落とさない）
    const c = rng.pick(CONSUMABLES.filter((x) => (x.minLevel ?? 0) <= ch.level));
    if (addConsumable(ch, c.key)) { sfx("pickup", 0.1); log(`亡骸から ${c.name} を見つけた。`, "dim"); }
  }
}

/** 移動 or 体当たり。falseなら手番を消費しない（壁） */
function moveOrInteract(nx: number, ny: number): boolean {
  const f = floor!;
  if (tileAt(f, nx, ny) !== 1) return false;

  const mon = f.monsters.find((m) => m.hp > 0 && m.x === nx && m.y === ny);
  if (mon) { // 攻撃（確定命中・確定ダメージ＝力依存＋焦躁バフ＋位置取り補正）
    const ch = world.current!;
    const hitR = meleeWithPositioning(meleeDmg(ch) + (attackBuffTurns > 0 ? ATTACK_BUFF : 0), mon); // 挟撃/見切り反撃（C/D）
    const dmg = hitR.dmg;
    mon.hp -= dmg;
    sfx(mon.boss ? "crit" : "hit");
    floatFx(nx, ny, String(dmg), hitR.crit ? "fl-crit" : "fl-dmg"); // 盤上ダメージ数字（会心は特大金白・命中フラッシュ＝敵グリフ白重ねは視認性のため廃止・FB 2026-07-03）
    if (ch.equipment.relic?.relic === "siphon" && deathDoorTurns === 0 && hp < maxHp(ch)) { // 遺物 siphon（渇き）：与ダメぶん吸命
      const drained = Math.max(1, Math.round(dmg * SIPHON_FRAC));
      hp = Math.min(maxHp(ch), hp + drained);
    }
    applyWeaponProc(ch, mon, dmg); // 発動効果つき武器（PR4）：薙ぎ/当て止め/裂傷/弱体（cleave は撃破時も余波）
    if (mon.hp <= 0) downOrKill(mon); // 撃破→ボスは討つ/鎮める、他は通常（手番末で処理）
    else {
      log(`${mon.kind.name}に${dmg}の一撃。`);
      if (mon.kind.ability === "reflect" && deathDoorTurns === 0) { // 棘＝近接を罰する（術/投擲が安全策）。死戸中は無効
        const recoil = Math.max(1, Math.round(dmg * REFLECT_FRAC));
        hp -= recoil; sfx("hurt"); flashFx("warp", { x: player.x, y: player.y });
        floatFx(player.x, player.y, String(recoil), "fl-hurt");
        log(`${mon.kind.name}の棘が反射する――${recoil}の傷。`, "warn");
      }
    }
    return true;
  }

  const fe = f.fossils.find((e) => e.x === nx && e.y === ny);
  if (fe && !fe.resolved) { void fossilScene(fe); return true; }

  const ce = f.chests.find((c) => c.x === nx && c.y === ny);
  if (ce && !ce.opened) { void chestScene(ce); return true; }

  // 手負いの冒険者（4-14C 入口B）：救助＝相棒化／見捨てる
  if (f.downed && f.downed.x === nx && f.downed.y === ny) { void rescueScene(f.downed); return true; }

  // 同時に潜る生者の冒険者（4-14・すれ違い）：接触で軽い会話（一度きり）
  if (f.delver && f.delver.x === nx && f.delver.y === ny) { void delverScene(f.delver); return true; }

  // メインの縦糸「アウレルの遺した問い」（4-15）：遺構「痕」／ライラ・境（踏み込むと章が進む）
  if (f.aurelSite && f.aurelSite.x === nx && f.aurelSite.y === ny) {
    if (f.aurelSite.kind === "mark") void aurelMarkScene(f); else void aurelLailaScene(f);
    return true;
  }

  // 相棒のマスへ踏み込む＝位置を入れ替える（相棒が @ の元いたマスへ）。手番は消費。
  if (companion && companion.x === nx && companion.y === ny) {
    companion.x = player.x; companion.y = player.y;
    player = { x: nx, y: ny };
    sfx("move");
    return true;
  }

  // 帰還の扉（v2）：踏むと一時帰還の確認へ（街⇔このフロアの往復チェックポイント）。
  if (f.returnDoor && f.returnDoor.x === nx && f.returnDoor.y === ny) { void returnViaDoor(); return true; }

  // 回復ノード（v2）：踏むと一度だけ効く（効く余地が無ければ温存して素通り）。
  const shr = f.shrines.find((s) => !s.used && s.x === nx && s.y === ny);
  if (shr) useShrine(shr);

  player = { x: nx, y: ny };
  sfx("move");

  // 階段
  if (nx === f.stairsDown.x && ny === f.stairsDown.y) void stairsPrompt("down");
  else if (nx === f.stairsUp.x && ny === f.stairsUp.y) void stairsPrompt("up");
  return true;
}

/** 回復ノードの使用（v2）：泉＝HP回復／安息所＝深蝕浄化。効く余地が無ければ温存（消えない）。 */
const SPRING_HEAL_FRAC = 0.6; // 回復の泉：最大HPの6割を癒す
const REST_CLEANSE = 0.8;     // 安息所：深蝕をこれだけ祓う（術コスト数発ぶん）
function useShrine(s: Shrine): void {
  const ch = world.current!;
  if (s.kind === "spring") {
    if (hp >= maxHp(ch)) return; // 満タンなら温存
    const before = hp; hp = Math.min(maxHp(ch), hp + Math.max(1, Math.round(maxHp(ch) * SPRING_HEAL_FRAC)));
    sfx("heal");
    floatFx(player.x, player.y, `+${hp - before}`, "fl-heal");
    log(`回復の泉。澄んだ水を含むと、傷が塞がってゆく（HP＋${hp - before}）。泉は涸れた。`, "cue");
  } else {
    if (ch.exposure <= 0.05) return; // 浄める澱が無ければ温存
    const before = ch.exposure; cleanseExposure(ch, REST_CLEANSE); // 教団の烙印より下へは祓えない（②）
    sfx("heal");
    log(`安息所。息を整えると、胸の澱がほどけてゆく（深蝕 -${(before - ch.exposure).toFixed(2)}）。安息所は鎮まった。`, "cue");
  }
  s.used = true;
  const i = floor!.shrines.indexOf(s); if (i >= 0) floor!.shrines.splice(i, 1);
}

/** 地上への生還（フル離脱・v2）：傷は癒え深みは残る。潜行を終え街へ→次は新ダンジョン1階から
 *  （startDive が floorCache/diveCount をリセット＝farm根絶を維持）。上り階段(深度1)・帰還の詠唱から呼ぶ。 */
/** 世界クロックを進める（4-14G 層1）：生還＝街到着のたび、この潜行の最深を深度積分で eraClock に足す。
 *  ビート発火で世界が老ける（弧が進む・縁ある生者が深みへ還る）。浅層(≤8)の周回では gain=0＝進まない。
 *  喪失を可視化＝縁者が還ったら「お前が生き延びる間に…」と即座に告げる（4-14G「喪失を見せる」要件）。 */
function tickWorldClock() {
  const { beats, fell } = accrueWorldClock(world, world.diveMaxDepth ?? 0);
  world.diveMaxDepth = 0;
  for (const name of fell) log(`お前が生き延びる間に、${name}は深みへと還っていった。縁を結んだ顔が、またひとつ。`, "warn");
  if (beats > 0) save();
}

async function surfaceReturn() {
  const ch = world.current!;
  hp = maxHp(ch); ch.depth = 0;
  tickWorldClock(); // 世界クロック（4-14G 層1）：深部での営みで世界が老ける（死を回避しても進む）
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
  await townLoop(); await startDive();
}

/** 帰還の扉（v2→街側・一回だけ）：エリアボス撃破で出現する扉をくぐると、あの階の盤面（ボス討伐済み）を
 *  「駐機」し（parkPortal＝world セーブ＋専用スナップショット）街へ戻す。以後、慰霊碑の傍に開く帰還の扉から
 *  一度だけ同じ盤面へ戻れる（useReturnPortal）。駐機は world に保存＝リロード/アプリ再起動でも消えない。 */
async function returnViaDoor() {
  if (busy) return;
  busy = true;
  const ch = world.current!;
  const depth = floor!.depth;
  const r = await sheet({
    text: `帰還の扉が、静かに口を開けている。\nここから街へ一度戻れる。あの階（深度${depth}）への帰り道は、街の慰霊碑の傍にもう一度だけ開く。\n（潜行は続く＝盤面はそのまま・ボスは討たれたまま。傷は街で癒えるが、深みは残る）`,
    meta: "帰還の扉 ── 街へ戻る", options: ["扉をくぐる（街へ）", "とどまる"],
  });
  if (r.pick !== 1) { busy = false; draw(); return; }
  parkPortal(); // あの階の盤面を駐機（world.town.returnPortal ＋ 専用スナップショット）＝リロードでも消えない
  hp = maxHp(ch); ch.depth = 0;
  companion = null; // 相棒は world.companion として街へ同道（再降下で再展開）
  tickWorldClock(); // 世界クロック（4-14G 層1）：扉での一時帰還も「深部から地上へ」＝世界が進む
  save();
  sfx("stairs_up"); flashFx("warp");
  log("帰還の扉をくぐる――束の間の地上。慰霊碑の傍に、あの階へ戻る扉が待っている。", "cue");
  log("（街の慰霊碑（碑）の傍に開いた「帰還の扉（扉）」から、一度だけ あの階へ戻れる）", "dim");
  busy = false;
  await townLoop();
  await startDive(); // 街の「迷宮の口」から潜った＝新規潜行（startDive が駐機 portal を破棄＝checkpoint を諦めた）
}

/** 慰霊碑の傍の帰還の扉（街側・一回だけ）：あの階へ戻る。街の他の潜行と同じく leaveTownToDive で
 *  townLoop を解決し、呼び出し側の startDive が portalDivePending を見て駐機盤面を復元する。 */
async function useReturnPortal() {
  if (busy) return;
  const portal = world.town?.returnPortal;
  if (!portal) return;
  busy = true;
  const depth = portal.depth;
  const r = await sheet({
    text: `慰霊碑の傍に、ほのかな光の門が開いている――帰還の扉。\nくぐれば、討ち倒した相手のいた あの階（深度${depth}）へ戻る。潜行の続きだ。\n（この扉は一度きり。くぐれば閉じる。傷は街で癒えたが、深みは残ったまま）`,
    meta: "帰還の扉 ── あの階へ戻る", options: [`扉をくぐる（深度${depth}へ）`, "とどまる"],
  });
  busy = false;
  if (r.pick !== 1) return;
  portalDivePending = true; // 呼び出し側（townLoop→startDive）が駐機盤面を復元する目印
  leaveTownToDive();        // 街の他の潜行と同じ経路で townLoop を解決
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
    if (r.pick === 1) {
      // 異物（呪い装備）の深蝕＝降下1階ごとに1回（v2 微調整・滞在ターン非依存）。装備していなければ0。
      const ch = world.current!;
      const oddity = equipExposure(ch) * ODDITY_DESCENT_MULT * heartFactor(ch);
      if (oddity > 0) { addExp(oddity); log(`異物が、深みを一段呼び込む（深蝕 ＋${oddity.toFixed(2)}）。`, "warn"); }
      sfx("stairs_down"); enterFloor(f.depth + 1, true);
      // 4-10H 第二層：迷宮の気配も行商人も出なかった降下は「無風」＝ピティ加算（次の降下で発火率が上がる）。
      if (!((await maybeDungeonEvent(floor!.depth)) || (await maybeMerchantEncounter()))) quietDescents++;
    }
  } else if (f.depth === 1) {
    const r = await sheet({ text: "地上への階段だ。街へ戻るか？\n（傷は癒えるが、浴びた深みは消えない）", options: ["街へ戻る", "とどまる"] });
    if (r.pick === 1) { await surfaceReturn(); return; }
  } else {
    const r = await sheet({ text: `上り階段がある。深度${f.depth - 1}へ戻るか？`, options: ["戻る", "とどまる"] });
    if (r.pick === 1) {
      enterFloor(f.depth - 1, false);
      if (!((await maybeDungeonEvent(floor!.depth)) || (await maybeMerchantEncounter()))) quietDescents++;
    }
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
  if (!getArc(world, "noble_ack")) setArc(world, { key: "noble_ack", step: 1 }); // 貴族街が奉献者を認知（Phase4・Lv45 nobleアークと別軸）
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
async function maybeDungeonEvent(depth: number): Promise<boolean> {
  // P1 序盤スロープ：浅いほど低頻度（深度2≈0.19 → 深いほど上限0.55）。深度1は出さない。
  if (depth < 2) return false;
  // 4-10H 第二層・凪検知（ピティ）：無風の降下が続くほど発火率を上げ、長い無風を自己補正する（上限0.9）。
  const p = Math.min(0.9, Math.min(0.55, 0.12 + depth * 0.035) + quietDescents * PITY_STEP);
  if (rng.next() >= p) return false;
  const ev = selectDungeonStorylet(db, depth, rng, world.current?.exposure ?? 0, world, curLevel(), recentSet());
  if (!ev || !ev.choices || ev.choices.length === 0) return false;
  noteEvent(ev.id);
  markEventFired();
  sfx("ui");
  const wasBusy = busy; busy = true;
  const r = await sheet({
    text: fillDungeonText(depth, ev.text ?? ""),
    meta: `深度${depth} ── 迷宮の気配`,
    options: ev.choices.map((c) => c.label),
  });
  const choice = ev.choices[r.pick - 1];
  if (choice.text) log(fillDungeonText(depth, choice.text));
  const ov: string[] = [];
  for (const line of applyDungeonEffects(world, world.current!, depth, choice.effects, ov)) log(line, "dim");
  await resolveOverflow(world.current!, ov);
  save();
  busy = wasBusy;
  if (!wasBusy) draw();
  return true;
}

/** 迷宮の行商人との出会い（4-10G）：袋の拾い物を安値（itemValue×0.45）でその場買い取り。
 *  売る物があるときだけ稀に出る。帰還の試練中は出ない（追われている最中なので）。 */
async function maybeMerchantEncounter(): Promise<boolean> {
  const ch = world.current;
  if (!ch || !floor || ch.carryingRelic) return false;
  dedupeGearBag(ch); // 防御：袋の参照重複を除いてから（持っていない物を売れる再発の根を断つ）
  const bag = ch.gearBag ?? [];
  if (!bag.length || rng.next() >= 0.3) return false;
  markEventFired(); // 4-10H 第二層：行商人との遭遇も「イベントが起きた」＝凪を解除
  busy = true;
  sfx("ui");
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
    const it = b[i], gross = sellGear(it, MERCHANT_SELL_MUL);
    if (!(await confirmSellGear(it, gross))) continue; // 誤売防止＝確認を挟む
    const idx = b.indexOf(it); // 実体で除去＝確認中に袋が変わっても「在る品」だけを手放す（持っていない物を売れない）
    if (idx < 0) { log("その品は、もう袋にない。", "dim"); continue; }
    b.splice(idx, 1);
    const val = splitGold(gross); // 同行中は売却益も折半（4-14C）
    ch.gold += val; sfx("sell");
    log(`${it.name} を行商人に売った（＋${val}金貨／所持 ${ch.gold}）。`, "dim");
    save();
  }
  busy = false;
  draw();
  return true;
}

// ---------- 化石との対面（再発見 → 干渉） ----------
async function fossilScene(fe: { fossilId: string; resolved: boolean }) {
  if (busy) return;
  busy = true;
  const fossil = world.fossils.find((f) => f.id === fe.fossilId)!;
  sfx("ui");
  const v = computeVariation(fossil, worldTime(world));
  // 山場（遭-④）：有効候補から rng で1件選ぶ＝frame文と型を「同じ1件」から導く（二重抽選を避ける）。
  const sp0 = matchSetPiece(db, fossil, v, rng);
  let setPiece = sp0 ? fillStoryletText(fossil, sp0.frame) : null;
  let spType = sp0?.type; // 山場の型（遭-④）
  // 4-10H 第二層・山場連発防止：直近に山場を見せていれば、この遭遇は山場演出を抑え通常遭遇に落とす
  // （大マップで化石が複数並んでも legend_return/grudge_hunt が立て続けに起きない）。
  if (spType && setPieceCooldown > 0) { spType = undefined; setPiece = null; }
  if (spType) setPieceCooldown = SETPIECE_COOLDOWN; // 山場を見せる＝以後 N 手は次の山場を抑制
  const baseText = setPiece ?? renderRediscovery(db, rng, fossil, v);
  // 相棒由来の化石は「相棒だと分かる」一言を添える（4-14C Phase C・固有性）。
  // 〈調べる〉〈捜索〉の結果はシート自体に反映する（可変）。log() だけだとオーバーレイの裏に隠れ、
  // 「押しても同じ文面のまま何も起きない」ように見えるため（テストプレイFB 2026-06-22）。
  let text = fossil.wasCompanion
    ? `${fossil.death.manner === "betrayed" ? "――見捨てたあの者が、宿敵となって還った。" : "――かつて共に歩いた相棒の、亡骸だ。"}\n${baseText}`
    : fossil.wasAlly
      ? `――かつて街で、迷宮で、言葉を交わした者だ。こんな姿で再び巡り合うとは。\n${baseText}`
      : baseText;
  recordRediscovery(world, fossil.id);
  seenThisDive.push(fossil.id);
  markEventFired(); // 4-10H 第二層：化石遭遇＝イベントが起きた＝凪を解除
  for (const l of onRediscoverFossil(world, fossil.id)) { log(l, "cue"); save(); } // 回収系の依頼達成
  const ch = world.current!;
  // 盗掘（plunder・酒場のグレー依頼）：この化石が盗掘対象なら暴いて依頼達成＋冒涜の代償を課す。
  //   代償＝深蝕＋（死者を暴いた）＋この化石を怨念（grudge）へ傾ける＝後世で宿敵として還りやすくなる（4-2）。
  //   ＝「金のために自分の未来の敵を作る」グレーの重み。web 限定・engine 非改変。
  const plunderLogs = onPlunderFossil(world, fossil.id);
  if (plunderLogs.length) {
    addExp(PLUNDER_EXPOSURE); // 冒涜の深蝕
    fossil.tonePole = "grudge"; // 怨念極へ（encounter/setpiece が grudge として読む）
    fossil.bondAtDeath = Math.max(fossil.bondAtDeath ?? 0, 3); // grudge_hunt（宿敵）適格へ
    fossil.lastTouchedGeneration = world.generation; // 変質クロックを起こす（暴きは干渉＝新しい起点）
    chronicle(world, "intervention", `${ch.name}が${fossil.origin.name}の亡骸を暴き、遺品を剥いだ。`, [fossil.id, ch.id]);
    for (const l of plunderLogs) log(l, "warn");
    log(`${fossil.origin.name}を暴いた――胸に、拭えぬ澱が残る（深蝕＋${PLUNDER_EXPOSURE.toFixed(2)}）。`, "warn");
    save();
  }

  // 継承は1化石1回のみ（既に継いだ化石は再提示しない＝先代の武器を潜行ごとに複製する farm を防ぐ。
  //  rollEncounter は seenThisDive しか除外せず潜行ごとリセットゆえ、同じ化石が後の潜行で再遭遇しうる）。
  const canInherit = (fossil.death.finalAct.choice === "leave_will" || fossil.death.finalAct.choice === "guard_relic")
    && !fossil.interventions.some((iv) => iv.type === "inherit");
  const storylet = selectStorylet(db, world, ch, fossil, v, rng, recentSet());
  if (storylet) noteEvent(storylet.id);
  const done = new Set<string>();

  // 遭遇＝イベントノード（4-12）：〈調べる〉〈捜索〉で掘り下げ／伏線を残してから干渉動詞を選ぶ
  for (;;) {
    const opts: string[] = [];
    // 山場の固有決着（遭-④）：通常動詞より先に提示
    if (spType === "legend_return") opts.push("導きを受ける（祝福）");
    if (spType === "grudge_hunt") { opts.push("向き合って詫びる"); opts.push("怨みを撥ねつける"); }
    if (spType === "inheritance") { opts.push("遺志を継ぐ（受け継ぐ）"); opts.push("安らかに送る（鎮魂）"); }
    if (storylet?.investigate && !done.has("investigate")) opts.push("調べる");
    if (storylet?.search && !done.has("search")) opts.push("周辺を捜索する");
    opts.push("鎮魂する（末路を閉じ、変質の時計を巻き戻す）");
    if (canInherit && spType !== "inheritance") opts.push("遺されたものを継ぐ"); // inheritance 山場時は climax「遺志を継ぐ」が代替＝重複回避
    opts.push("そっと立ち去る");

    const r = await sheet({
      text,
      meta: `${fossil.origin.name}の化石 ── 極=${poleLabel(fossil.tonePole)} / 変質=${v.stage}${setPiece ? " / 山場" : ""}`,
      options: opts,
    });
    const label = opts[r.pick - 1];

    if (label === "調べる" && storylet?.investigate) {
      done.add("investigate");
      const t = fillStoryletText(fossil, storylet.investigate.text);
      log(t);
      const ov: string[] = [];
      const fx = applyEffects(world, ch, fossil, storylet.investigate.effects, ov);
      for (const line of fx) log(line, "dim");
      text = t + (fx.length ? `\n\n${fx.join("\n")}` : ""); // シートに反映＝掘り下げが見える
      await resolveOverflow(ch, ov);
      save();
      continue;
    }
    if (label === "周辺を捜索する" && storylet?.search) {
      done.add("search");
      const t = fillStoryletText(fossil, storylet.search.text);
      log(t);
      const ov: string[] = [];
      const fx = applyEffects(world, ch, fossil, storylet.search.effects, ov);
      for (const line of fx) log(line, "dim");
      text = t + (fx.length ? `\n\n${fx.join("\n")}` : ""); // シートに反映＝掘り下げが見える
      await resolveOverflow(ch, ov);
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
      log(`${fossil.origin.name}の光が、行く道を照らした。記憶に『導きの印』が刻まれた。`);
      if (ch.exposure < before) log(`深みに削られた芯が、人へ還る（深蝕 -${(before - ch.exposure).toFixed(2)}）。`, "dim");
      // 奉献の試練・印③：山場（legend_return）を決着（4-13A）
      if (awardSeal(world, "setpiece", [fossil.id])) { sfx("seal"); log("◆ 「山場の決着」の印を得た。", "warn"); }
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
      if (awardSeal(world, "setpiece", [fossil.id])) { sfx("seal"); log("◆ 「山場の決着」の印を得た。", "warn"); }
      recordCompanionFeat(); // 相棒と共に山場を決着＝偉業（4-4E 昇格ゲート）
      save();
      break;
    }
    if (label === "怨みを撥ねつける") { // grudge_hunt（遭-④）：拒絶＝再来の種＋深蝕
      addExp(0.2);
      const gb = ch.bonds.find((b) => b.entityRef === fossil.id);
      if (gb) gb.unfinished = true; else ch.bonds.push({ entityRef: fossil.id, value: 0, unfinished: true });
      chronicle(world, "rediscovery", `${ch.name}は${fossil.origin.name}の怨みを撥ねつけた。（未完のまま・再来の種）`, [fossil.id]);
      log(`怨みを否定した。だがそれは、より深い闇となって絡みつく（深蝕 +0.20）。いつか、また。`, "warn");
      save();
      break;
    }
    if (label === "遺志を継ぐ（受け継ぐ）") { // inheritance（遭-④）：loss 極の決着＝遺志を背負う（既存の継承機構を山場へ昇華）
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
      const before = ch.exposure;
      ch.exposure = Math.max(0, ch.exposure - 0.4); // 山場の決着＝legend_return と同格の人間性回復
      chronicle(world, "legend", `${ch.name}は${fossil.origin.name}の遺志を継いだ。`, [fossil.id, ch.id]);
      if (ch.exposure < before) log(`託された想いが、削られた芯を人へ還す（深蝕 -${(before - ch.exposure).toFixed(2)}）。`, "dim");
      // 奉献の試練・印③：山場（inheritance）を決着（4-13A）
      if (awardSeal(world, "setpiece", [fossil.id])) { sfx("seal"); log("◆ 「山場の決着」の印を得た。", "warn"); }
      recordCompanionFeat(); // 相棒と共に山場を決着＝偉業（4-4E 昇格ゲート）
      save();
      break;
    }
    if (label === "安らかに送る（鎮魂）") { // inheritance（遭-④）：継がず、安息を選ぶ別の決着
      sfx("intervene");
      intervene(world, fossil.id, "requiem"); // 因縁を閉じる（loss 極ゆえ requiem 印は付かない＝山場の印を明示付与）
      const before = ch.exposure;
      ch.exposure = Math.max(0, ch.exposure - 0.4);
      chronicle(world, "intervention", `${ch.name}は${fossil.origin.name}を安らかに送った。`, [fossil.id]);
      log(`遺志は継がず、ただ静かに見送った。${fossil.origin.name}の輪郭が、安らかにほどけていく。`);
      if (ch.exposure < before) log(`別れを受け入れた芯が、人へ還る（深蝕 -${(before - ch.exposure).toFixed(2)}）。`, "dim");
      // 奉献の試練・印③：山場（inheritance）を決着（4-13A）
      if (awardSeal(world, "setpiece", [fossil.id])) { sfx("seal"); log("◆ 「山場の決着」の印を得た。", "warn"); }
      recordCompanionFeat(); // 相棒と共に山場を決着＝偉業（4-4E 昇格ゲート）
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
      // 残響召喚の種（4-10I・snapshot 524）：神話極の化石を鎮魂すると「残響の遺灰」を得る（grantEchoOnRequiem＝純関数・world.ts）。
      // 潜行中に1回だけ強めの一時味方として展開できる（術ボタン→「残響の遺灰を使う」）。farm防止＝1化石1遺灰（神話極の初回鎮魂のみ）。
      const ash = grantEchoOnRequiem(world, fossil, floor?.depth ?? fossil.death.depth ?? 1);
      if (ash) { log(`${ash.name}の残響が、遺灰となって掌に宿った。いつか、傍らに喚び出せる。`, "cue"); sfx("seal"); }
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
      markEventFired(); // 4-10H 第二層：聖遺物の奪取＝大きな節目＝凪を解除
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
    markEventFired(); // 4-10H 第二層：宝箱を開ける＝イベントが起きた＝凪を解除
    sfx("chest");
    // 開けた宝箱はマップから取り除く（空き箱を残さない）
    const i = floor!.chests.indexOf(ce);
    if (i >= 0) floor!.chests.splice(i, 1);
    // 秘宝レアドロップ（2026-07-03）：深度20+の宝箱に低確率で秘宝（深いほど上昇）。当たれば通常抽選より優先。
    if (depth >= ARTIFACT_MIN_DEPTH && rng.next() < artifactChance(depth, ARTIFACT_CHEST_BASE, 0.18)) {
      const art = rollArtifact(depth);
      if (art) { sfx("seal"); log("宝箱の底に、妖しく脈打つ秘宝が眠っていた。", "warn"); await equipPrompt(art); save(); busy = false; draw(); return; }
    }
    const roll = rng.next();
    const kept = roll >= 0.15 && roll < 0.15 + KEEPSAKE_CHANCE ? grantKeepsake(depth) : null; // 拾得品（詩情系の収集物・band 適合）
    if (roll < 0.15) { // 罠
      const dmg = 0.12 + rng.next() * 0.12;
      addExp(dmg);
      log("蓋を開けた瞬間、淀んだ気が噴き上がった——罠だ。", "warn");
      log(`深みが、まともに染みた（深蝕 +${dmg.toFixed(2)}）。`, "dim");
    } else if (kept) { // 拾得品＝書記の館で読み返せる収集物（出現頻度は KEEPSAKE_CHANCE が司る）
      sfx("pickup");
      await sheet({ text: `${kept.story}\n\n――懐に納めた。街へ持ち帰れば、書記イェンが好古の棚に加えてくれる。`, meta: `深度${depth} ── 拾得品「${kept.title}」`, options: ["懐に納める"] });
      log(`心に残る品を見つけた──「${kept.title}」。街の書記の館（記）で読み返せる。`);
    } else if (roll < 0.58) { // 装備ドロップ（序盤の入手を底上げ・約28%→約31%＝初期0.55と0.62の中間・FB 2026-07-03 案B→中間調整。初期支給はそのまま）
      const item = rollItem(depth, rng);
      log("宝箱から、何かを手にした。");
      await equipPrompt(item);
    } else { // 中身の物語（P2：既存の chest storylet を web でも出す＝金貨/消耗品/小さな所見）
      const out = rollChestOutcome(db, depth, rng, world, curLevel(), recentSet());
      if (out?.result) {
        noteEvent(out.id);
        log(fillDungeonText(depth, out.result.text));
        const ov: string[] = [];
        for (const line of applyDungeonEffects(world, ch, depth, out.result.effects, ov)) log(line, "dim");
        await resolveOverflow(ch, ov);
      } else { // フォールバック：所見が無ければ従来どおり装備
        const item = rollItem(depth, rng);
        log("宝箱から、何かを手にした。");
        await equipPrompt(item);
      }
    }
  }
  save();
  busy = false;
  draw();
}

// ---------- 死 → 最後の一手（4-10B）→ 世代交代 ----------
async function deathFlow() {
  busy = true;
  sfx("death"); setAmbient(false); setBgm("death");
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

// ---------- 設定（下部タブ「設定」から） ----------
const SZJP = { lg: "大", md: "中", sm: "小" } as const;
const ARC_KEY_LABEL: Record<string, string> = { noble: "封鎖区の大命「原初の証」", noble_ack: "奉献者への眼差し" };

// ---------- あそびかた・記号の凡例（M5・設定ハブから・チュートリアル代替の静的ヘルプ）----------
//   実行時LLMゼロ整合の固定テキスト。グリフは draw 実装・town.json と一致（コード照合済み）。
const HELP_FLOW =
  "《 あそびかた 》\n\n" +
  "▍ながれ\n" +
  "灰の街で支度し、中央広場の門「>」から迷宮へ潜る。深く潜るほど身は深蝕に蝕まれる。財や術を持ち帰り、街で力を蓄える。死は終わりではない――あなたは化石となって世界に堆積し、次の世代がその名と因縁を継ぐ。\n\n" +
  "▍うごかす（8方向）\n" +
  "・スワイプ（8方向）／方向パッド（設定でオン・位置と大きさを調整）\n" +
  "・キー：矢印・WASD・viキー(y u b n)・テンキー(1〜9)\n" +
  "・「.」またはパッド中央＝その場で待機（1手）\n" +
  "・盤面をタップ＝そのマスを調べる（敵の強さ・傷・能力が分かる。手番は使わない）\n" +
  "・敵は次の一手を予告する（テレグラフ）。退いて空振りさせるのが「見切り」。\n" +
  "・見切った直後は「反撃の好機」＝次の近接攻撃が会心になる。\n" +
  "・相棒・召喚・共闘者と敵を挟むと「挟み撃ち」＝近接攻撃が増す。\n\n" +
  "▍地図とねらい\n" +
  "地図ボタンでフロア全体を表示。地図をタップ→最寄りの床にマーカー→パッドで微調整→「移動」で自動で歩く。";
const HELP_LEGEND =
  "《 記号の凡例 》\n\n" +
  "▍迷宮\n" +
  "@ 金＝あなた／@ 青＝相棒／@ 緑＝すれ違う冒険者\n" +
  "& 琥珀＝手負いの冒険者（救助できる）\n" +
  "痕・境＝古き徴（踏み込むと読める・物語が進む）\n" +
  "敵＝記号×色（上位の色ほど強い）\n" +
  "ψ ‡ Ψ 菫＝あなたが召喚した一時の味方\n" +
  "泉 青緑＝回復の泉（HP回復）／安 緑＝安息所（深蝕を祓う）\n" +
  "扉 金＝帰還の扉／> ＝下り階段／< ＝上り階段\n\n" +
  "▍街\n" +
  "漢字の看板＝店・施設（入って話す）\n" +
  "ラテン文字＝街の人々：c 町民／$ 商人／n 貴族／t ならず者／f 冒険者\n" +
  "碑・像＝先人と、あなたの歴代の記憶\n\n" +
  "▍画面の見方\n" +
  "深蝕バー＝深く潜るほど溜まる。高いと牙（HPドレイン）。\n" +
  "毒N＝継続ダメージ（数手で抜ける）。バフ＝術の残り手数。";
// ---------- セーブの書き出し/読み込み（M5・バックアップ＝クラウド無しPWAの命綱）----------
function downloadText(name: string, text: string): boolean {
  try {
    const blob = new Blob([text], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a"); a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1500);
    return true;
  } catch { return false; }
}
async function exportSave(): Promise<void> {
  busy = true;
  const data = JSON.stringify(world);
  const r = await sheet({
    text: `この世界（第${world.generation}世代・化石${world.fossils.length}件）をバックアップします。\nクリップボードにコピーするか、ファイルに保存して保管してください。\n機種変更や再インストールのとき「読み込む」に戻せば復元できます。`,
    meta: "セーブを書き出す",
    options: ["クリップボードにコピー", "ファイルに保存", "閉じる"],
  });
  busy = false;
  if (r.pick === 1) {
    let ok = false;
    try { if (navigator.clipboard?.writeText) { await navigator.clipboard.writeText(data); ok = true; } } catch { /* fall through */ }
    if (!ok) ok = downloadText(`sekitsui-save-g${world.generation}.json`, data); // コピー不可ならファイルへ
    await sheet({ text: ok ? "コピーしました（または保存しました）。メモ帳などに貼り付けて保管してください。" : "コピーできませんでした。別の方法（ファイル保存）をお試しください。", meta: "書き出し", options: ["閉じる"] });
    await exportSave();
  } else if (r.pick === 2) {
    const ok = downloadText(`sekitsui-save-g${world.generation}.json`, data);
    await sheet({ text: ok ? "ファイルに保存しました。" : "保存できませんでした。クリップボードへのコピーをお試しください。", meta: "書き出し", options: ["閉じる"] });
    await exportSave();
  }
}
async function importSave(): Promise<void> {
  busy = true;
  const r = await sheet({ text: "バックアップした文字列を貼り付けて読み込みます。\n※ 今の世界は上書きされ、元には戻せません（先に書き出しを推奨）。", meta: "セーブを読み込む", options: ["読み込む", "やめる"], input: "ここにセーブの文字列を貼り付け" });
  busy = false;
  if (r.pick !== 1) return;
  const text = (r.text ?? "").trim();
  if (!text) return;
  let w: World;
  try { w = migrateWorld(JSON.parse(text) as World); if (!Array.isArray(w.fossils) || typeof w.generation !== "number") throw new Error("shape"); }
  catch { await sheet({ text: "読み込めませんでした。文字列が壊れているか、このゲームのセーブではない可能性があります。", meta: "読み込み失敗", options: ["閉じる"] }); return; }
  const c = await sheet({ text: `第${w.generation}世代・化石${w.fossils.length}件の世界を読み込みます。\n今の世界は上書きされ、元に戻せません。よろしいですか？`, meta: "復元の確認", options: ["いいえ", "はい、読み込む"] });
  if (c.pick !== 2) return;
  try { localStorage.setItem(SAVE_KEY, JSON.stringify(w)); clearDive(); localStorage.removeItem(PORTAL_KEY); } catch { /* ignore */ }
  log("セーブを読み込んだ。世界を復元する……", "cue");
  location.reload(); // 再起動でクリーンに再初期化（タイトル→続きから）
}

async function helpSheet(page: "flow" | "legend" = "flow"): Promise<void> {
  busy = true;
  if (page === "flow") {
    const r = await sheet({ text: HELP_FLOW, meta: "あそびかた", options: ["記号の凡例へ →", "閉じる"] });
    busy = false;
    if (r.pick === 1) await helpSheet("legend");
  } else {
    const r = await sheet({ text: HELP_LEGEND, meta: "記号の凡例", options: ["← あそびかたへ", "閉じる"] });
    busy = false;
    if (r.pick === 1) await helpSheet("flow");
  }
}

async function settingsSheet() {
  busy = true;
  const bgmVolJp = bgmVolume() < 0.45 ? "小" : bgmVolume() < 0.72 ? "中" : "大";
  const sfxVolJp = sfxVolume() < 0.45 ? "小" : sfxVolume() < 0.72 ? "中" : "大";
  // ラベル先頭の識別子でディスパッチ（並び替えに強い）。グループ見出し＝あそびかた／音／操作・表示／データ（横断F ①・Swift の Section にミラー）。
  const HELP = "❓ あそびかた・記号の凡例";
  const opts: SheetOption[] = [
    { label: HELP, header: "あそびかた" },
    { label: isMuted() ? "♪ 音を出す" : "🔇 すべての音を消す", header: "音" },
    isBgmOn() ? "🎵 BGM：オン → オフ" : "🎵 BGM：オフ → オン",
    `🎵 BGM音量：${bgmVolJp}（小→中→大）`,
    `🔊 効果音音量：${sfxVolJp}（小→中→大）`,
    { label: dpadOn ? "🕹 方向パッド：オン → オフ" : "🕹 方向パッド：オフ → オン", header: "操作・表示" },
    `🕹 方向パッドの位置：${dpadPos === "right" ? "右下" : dpadPos === "left" ? "左下" : "中央"}（右下→左下→中央）`,
    `🕹 方向パッドの大きさ：${SZJP[dpadSize]}（大→中→小）`,
    dpadAutorun ? "🕹 長押しで連続移動：オン → オフ" : "🕹 長押しで連続移動：オフ → オン",
    `🔤 文字サイズ：${SZJP[logSize]}（小→中→大）`,
    { label: "💾 セーブを書き出す（バックアップ）", header: "データ" },
    "📂 セーブを読み込む（復元）",
    "🔧 テスト",
    "⟲ 世界を最初からやり直す", // ← 自動で danger 役割（"やり直す" を含む）
    "閉じる",                    // ← 自動で cancel 役割
  ];
  const r = await sheet({ text: "音・操作・表示を整える。困ったら「あそびかた」へ。", meta: `設定 ── v${APP_VERSION}（build ${APP_BUILD}）`, options: opts });
  busy = false;
  const c = optLabel(opts[r.pick - 1] ?? "");
  if (c === HELP) { await helpSheet(); await settingsSheet(); }
  else if (c.includes("音を消す") || c.includes("音を出す")) { ensureAudio(); setMuted(!isMuted()); await settingsSheet(); }
  else if (c.includes("BGM：")) { ensureAudio(); setBgmEnabled(!isBgmOn()); await settingsSheet(); }
  else if (c.includes("BGM音量")) { ensureAudio(); setBgmVolume(bgmVolume() < 0.45 ? 0.6 : bgmVolume() < 0.72 ? 0.85 : 0.35); await settingsSheet(); }
  else if (c.includes("効果音音量")) { ensureAudio(); setSfxVolume(sfxVolume() < 0.45 ? 0.6 : sfxVolume() < 0.72 ? 0.85 : 0.35); sfx("equip"); await settingsSheet(); }
  else if (c.includes("方向パッド：")) { setDpad(!dpadOn); await settingsSheet(); }
  else if (c.includes("位置")) { setDpadPos(dpadPos === "right" ? "left" : dpadPos === "left" ? "center" : "right"); await settingsSheet(); }
  else if (c.includes("大きさ")) { setDpadSize(dpadSize === "lg" ? "md" : dpadSize === "md" ? "sm" : "lg"); await settingsSheet(); }
  else if (c.includes("連続移動")) { setDpadAutorun(!dpadAutorun); await settingsSheet(); }
  else if (c.includes("文字サイズ")) { setLogSize(logSize === "sm" ? "md" : logSize === "md" ? "lg" : "sm"); await settingsSheet(); }
  else if (c.includes("書き出す")) { await exportSave(); await settingsSheet(); }
  else if (c.includes("読み込む")) { await importSave(); await settingsSheet(); }
  else if (c.includes("テスト")) { await testSheet(); }
  else if (c.includes("やり直す")) { await resetWorld(); }
}

// ---------- 🔧 テストモード（開発用・web限定）。設定→テスト。レベル/深度を即変更しバランス検証を加速。 ----------
/** レベルを target に設定：体/力へ交互配分（典型近接ビルド）・XPリセット・HP全回復。 */
function testSetLevel(target: number): void {
  const ch = world.current; if (!ch) return;
  target = Math.max(1, Math.min(60, Math.floor(target)));
  ch.stats = { ...BASE_STATS };
  for (let i = 0; i < target - 1; i++) ch.stats[STAT_KEYS[[1, 0][i % 2]]]++; // 力→体 交互
  ch.level = target; ch.xp = 0;
  hp = maxHp(ch);
  save();
  updateStatus();
}
/** 今いる場所から深度 depth へ直接降りる（街なら潜行を開始してその階へ）。 */
function testJump(depth: number): void {
  if (!world.current) return;
  depth = Math.max(1, Math.min(ABYSS_DEPTH, Math.floor(depth)));
  if (mode !== "dive") {
    stopWander(); mode = "dive"; seenThisDive = [];
    hp = maxHp(world.current);
    buildGridDom(VIEW_W, VIEW_H);
  }
  world.diveCount = (world.diveCount ?? 0) + 1; // 別ダンジョンとして生成
  floorCache = new Map();
  enterFloor(depth, true);
  log(`【テスト】深度${depth}へ跳んだ。`, "warn");
  save();
}
/** 全術を識り、構え（上限まで）を満たす。 */
function testLearnAll(): void {
  const ch = world.current; if (!ch) return;
  for (const s of SPELLS) learnSpell(ch, s.key);
  save();
  updateStatus();
}
/** 金貨と消耗品を付与し、相棒（中堅等級）を一人つける。 */
function testGiveResources(): void {
  const ch = world.current; if (!ch) return;
  ch.gold += 1000;
  for (const c of CONSUMABLES) for (let i = 0; i < 3; i++) addConsumable(ch, c.key);
  const grade = 2;
  world.companion = {
    actorRef: `test_comp_${world.generation}_${Math.floor(rng.next() * 1e6)}`,
    actor: mintActor(db, rng, {}, fossilNames(world)),
    bond: 1, exposure: 0, alive: true,
    maxHp: companionMaxHp(grade), recruitedGeneration: world.generation,
    grade, feats: 0, traits: [],
  };
  if (mode === "dive" && floor) spawnCompanionNear(player);
  save();
  updateStatus();
}

async function testSheet(): Promise<void> {
  busy = true;
  const ch = world.current;
  const info = ch
    ? `Lv${ch.level}／${statsLine(ch)}／HP${maxHp(ch)} 攻${meleeDmg(ch)}／金${ch.gold}／術${ch.spells.length}/${SPELLS.length}／相棒${world.companion?.alive ? "有" : "無"}`
    : "（キャラ不在）";
  const r = await sheet({
    text: `開発用のテストモード。数値はその場で反映される。\n現在：${info}`,
    meta: "🔧 テスト",
    options: ["レベルを設定", "深度へ跳ぶ", "全術を識り構えを満たす", "金貨1000＋消耗品＋相棒", "戻る"],
  });
  busy = false;
  if (r.pick === 1) {
    const a = await sheet({ text: "設定するレベル（1〜60）。体/力に自動配分し、HPは全回復する。", meta: "🔧 レベル設定", options: ["設定する", "やめる"], input: "レベル" });
    if (a.pick === 1) { const n = parseInt(a.text, 10); if (Number.isFinite(n)) { testSetLevel(n); log(`【テスト】Lv${world.current?.level} に設定（${statsLine(world.current!)}）。`, "warn"); } }
    await testSheet();
  } else if (r.pick === 2) {
    const a = await sheet({ text: `跳ぶ深度（1〜${ABYSS_DEPTH}）。今いる場所から直接その階へ降りる。`, meta: "🔧 深度ジャンプ", options: ["跳ぶ", "やめる"], input: "深度" });
    if (a.pick === 1) { const n = parseInt(a.text, 10); if (Number.isFinite(n)) { testJump(n); return; } } // 跳んだら迷宮へ＝メニューは閉じる
    await testSheet();
  } else if (r.pick === 3) {
    testLearnAll(); log(`【テスト】全${SPELLS.length}術を識り、構えを満たした。`, "warn"); await testSheet();
  } else if (r.pick === 4) {
    testGiveResources(); log("【テスト】金貨1000・消耗品・相棒（中堅）を付与した。", "warn"); await testSheet();
  }
}

/** 下部タブ「ステータス」：身上＋装備＋術＋進行中＋年代記＋敵図鑑（旧「冒険の記録」を統合）。装備換装は非戦闘で可。 */
async function charScreen() {
  const ch = world.current; if (!ch) return;
  busy = true;
  for (;;) {
    // 主画面は要約のみ（中身の列挙は「装備・持ち物を見る」へ）＝情報ダンプを避ける（テストプレイFB）。
    // 横断F ①＝Wizardry 流の整列（ラベル淡／値強・右寄せ・セクション朱罫。Swift ＝ Section/LabeledContent）。
    const eqSlots: ItemSlot[] = ["weapon", "armor", "relic", "bag"];
    const consN = (ch.inventory ?? []).reduce((a, s) => a + s.qty, 0); // 薬・巻物の合計個数
    const gearN = (ch.gearBag ?? []).length;                            // 拾った武具の点数
    const lo = activeLoadout(ch);
    const loNames = lo.map((k) => spellByKey(k)?.name ?? k).join("、");

    const selfRows: SheetRow[] = [
      { label: "能力", value: statsLine(ch) },
      { label: "最大HP", value: String(maxHp(ch)) },
      { label: "攻撃", value: String(meleeDmg(ch)) },
      { label: "次のLvまで", value: String(Math.max(0, xpToNext(ch.level) - ch.xp)) },
      { label: "深蝕", value: ch.exposure.toFixed(2), cls: "exp", note: "牙の閾 1.5" },
    ];
    if (ch.carryingRelic) selfRows.push({ text: "★聖遺物 携行中", cls: "warn" });
    const gearRows: SheetRow[] = eqSlots.map((sl) => ({
      label: SLOT_LABEL[sl], value: ch.equipment[sl] ? itemLabel(ch.equipment[sl]!) : "—",
    }));
    const spellRows: SheetRow[] = ch.spells.length
      ? [{ label: "構え", value: `${lo.length}/${LOADOUT_CAP}` }, { text: loNames || "なし", dim: true }]
      : [{ text: "未識得", dim: true }];
    const packRows: SheetRow[] = [
      { label: "薬・巻物", value: `${consN}個` },
      { label: "武具", value: `${gearN}点` },
      { text: "※中身は「装備・持ち物を見る」", dim: true },
    ];
    const sections: SheetSection[] = [
      { rows: selfRows },
      { header: "装備", rows: gearRows },
      { header: "術", rows: spellRows },
      { header: `荷物　${packUsed(ch)}/${packCapacity(ch)} 枠`, rows: packRows },
    ];
    // 相棒（雇用中）＝主画面に要約を出し、詳細・解散は「相棒を見る」へ（解散導線を見つけやすく・テストプレイFB）。
    const hired = world.companion?.alive ? world.companion : null;
    if (hired) sections.push({ header: "相棒", rows: [
      { label: hired.actor.name, value: GRADE_LABELS[hired.grade] },
      { text: `絆${hired.bond}・偉業${hired.feats ?? 0}　※詳細は「相棒を見る」`, dim: true },
    ] });
    if (ch.traits.length) sections.push({ header: "記憶", rows: [{ label: "記憶", value: `${ch.traits.length}件` }] });

    const opts: SheetOption[] = [
      "装備・持ち物を見る", "術（構え・図鑑）", "進行中（依頼・因縁・印）",
      { label: "人物と年代記", gap: true }, "敵図鑑",
    ];
    if (hired) opts.push(`相棒を見る（${hired.actor.name}）`);
    if (ch.traits.length) opts.push(`記憶を見る（${ch.traits.length}）`);
    opts.push("閉じる");
    const r = await sheet({
      text: `《${ch.name}》　Lv ${ch.level}`,
      meta: `ステータス ── 第${world.generation}世代・${DIFFICULTY_LABEL[world.difficulty ?? "easy"]}`,
      sections, options: opts,
    });
    busy = false;
    const label = optLabel(opts[r.pick - 1] ?? "");
    if (label === "装備・持ち物を見る") await gearSheet(ch);
    else if (label === "術（構え・図鑑）") await spellMenu(ch);
    else if (label === "進行中（依頼・因縁・印）") await eventsScreen();
    else if (label === "人物と年代記") await chronicleScene();
    else if (label === "敵図鑑") await bestiaryScreen();
    else if (label?.startsWith("相棒を見る")) await companionSheet();
    else if (label?.startsWith("記憶を見る")) await memoriesSheet(ch);
    else break;
    busy = true;
  }
  busy = false;
}

/** 記憶（旧「形質」）を一覧する。「カテゴリ:中身」の接頭辞でグループ化＝見出し＋箇条書きで読みやすく。 */
async function memoriesSheet(ch: Character) {
  busy = true;
  const groups = new Map<string, string[]>();
  for (const t of ch.traits) {
    const m = t.match(/^([^:：]{1,12})[:：](.+)$/); // 「遺品:◯◯」等の接頭辞でカテゴリ分け
    const cat = m ? m[1] : "その他";
    const item = m ? m[2] : t;
    let arr = groups.get(cat);
    if (!arr) { arr = []; groups.set(cat, arr); }
    arr.push(item);
  }
  const sections: SheetSection[] = [];
  for (const [cat, items] of groups) sections.push({ header: cat, rows: items.map((it) => ({ text: it })) });
  if (!sections.length) sections.push({ rows: [{ text: "まだ何も刻まれていない。", dim: true }] });
  await sheet({ sections, meta: `記憶 ${ch.traits.length}件`, options: ["閉じる"] });
  busy = false;
}

/** 装備・持ち物のカード一覧（読みやすさ最優先＝テストプレイFB「装備・持ち物が見づらい」対応）。
 *  装備カードをタップ＝そのスロットを換装／消耗品カードをタップ＝使う・捨てる（街のみ）。 */
const GEAR_SLOT_CLS: Record<ItemSlot, string> = { weapon: "c-atk", armor: "c-ctl", relic: "c-lore", bag: "c-sup" };
// 拾得物のシジル（横断F ①・Wizardry/シレン流の1字圧縮）：装備中=★（金泥）／未鑑定=？（淡）／発動効果=〔…〕（朱）。
const PROC_MARK: Record<NonNullable<Item["proc"]>, string> = {
  cleave: "薙", stun: "止", rend: "裂", sap: "萎",
  block: "受", barbs: "棘", cleanse: "清", daunt: "威", stagger: "怯",
  // 秘宝（2026-07-03）
  arc: "雷", blast: "炎", pierce: "貫", freeze: "氷", drain: "吸",
  reflectall: "反", negate: "無", hasten: "疾", adapt: "順", purge: "浄",
};
function nameWithSigils(it: Item, equipped: boolean): string {
  const pre = it.unidentified ? `<span class="sigq">？</span>` : equipped ? `<span class="sig">★</span>` : "";
  const name = it.unidentified ? `見知らぬ${SLOT_LABEL[it.slot]}（未鑑定）` : it.name;
  const mark = (!it.unidentified && it.proc) ? `<span class="mark">〔${PROC_MARK[it.proc]}〕</span>` : "";
  return `${pre}${name}${mark}`;
}
async function gearSheet(ch: Character) {
  dedupeGearBag(ch); // 防御：袋の参照重複を除いてから表示
  const eqSlots: ItemSlot[] = ["weapon", "armor", "relic", "bag"];
  for (;;) {
    busy = true;
    const inv = ch.inventory ?? [];
    const cells: { html: string }[] = [];
    // 装備（4スロット＝カードで一目）。空きは淡色で「（空き）」。
    for (const sl of eqSlots) {
      const it = ch.equipment[sl];
      const body = it
        ? `<div class="nm">${nameWithSigils(it, true)}</div><div class="sub">${it.unidentified ? "正体不明――装備中" : itemPower(it)}</div>`
        : `<div class="nm" style="color:var(--tx-dim)">（空き）</div><div class="sub">迷宮で拾った${SLOT_LABEL[sl]}を着けられる</div>`;
      cells.push({ html: `<span class="chip ${GEAR_SLOT_CLS[sl]}">${SLOT_LABEL[sl]}</span>${body}` });
    }
    // 薬・巻物（消耗品）。同種はまとめて ×N。
    for (const s of inv) {
      const def = consumableByKey(s.key);
      cells.push({ html: `<span class="chip c-mov">薬・巻物</span><div class="nm">${def?.name ?? s.key}${s.qty > 1 ? `　×${s.qty}` : ""}</div><div class="sub">${def?.desc ?? ""}</div>` });
    }
    // 拾った武具（荷物の中＝未装備）。タップで装備／捨てる。これまで売却画面でしか見えなかったのを荷物として可視化。
    const bag = ch.gearBag ?? [];
    for (const g of bag) {
      cells.push({ html: `<span class="chip ${GEAR_SLOT_CLS[g.slot]}">武具(${SLOT_LABEL[g.slot]})</span><div class="nm">${nameWithSigils(g, false)}</div><div class="sub">${g.unidentified ? "正体不明――装備で分かる" : itemPower(g)}</div>` });
    }
    const lo = activeLoadout(ch);
    const loNames = lo.map((k) => spellByKey(k)?.name ?? k).join("、");
    const lead = (ch.spells.length ? `構え ${lo.length}/${LOADOUT_CAP}：${loNames || "なし"}\n` : "") +
      "★=装備中／？=未鑑定／〔…〕=発動効果。装備枠＝着け替え／薬＝使う・捨てる（街）／武具＝装備・置く。";
    const i = await chooseGrid({
      title: `装備・荷物 ── 荷物 ${packUsed(ch)}/${packCapacity(ch)} 枠`,
      lead, cells, cancel: "閉じる", cols: 1,
    });
    busy = false;
    if (i < 0) break;
    if (i < eqSlots.length) await swapSlot(ch, eqSlots[i]);
    else if (i < eqSlots.length + inv.length) { const s = inv[i - eqSlots.length]; if (s) await useOrDropConsumable(ch, s.key); }
    else { const g = bag[i - eqSlots.length - inv.length]; if (g) await manageBagGear(ch, g); }
  }
}

/** 荷物の中の拾った武具を操作（装備する／置いていく）。装備すると今の装備は荷物へ戻る。 */
async function manageBagGear(ch: Character, item: Item) {
  busy = true;
  const label = item.unidentified ? `見知らぬ${SLOT_LABEL[item.slot]}（未鑑定）` : `${item.name}（${itemPower(item)}）`;
  const r = await sheet({
    text: `荷物の中の${SLOT_LABEL[item.slot]}：${label}${item.unidentified ? "\n（装備すれば正体が分かる）" : ""}`,
    meta: "荷物 ── 武具",
    options: ["装備する", "置いていく（捨てる）", "戻る"],
  });
  busy = false;
  if (r.pick === 1) {
    const idx = (ch.gearBag ?? []).indexOf(item);
    if (idx < 0) return;
    ch.gearBag!.splice(idx, 1); // 先に荷物から取り出す（容量の二重計上を避ける）
    const cur = ch.equipment[item.slot];
    item.unidentified = false; // 装備で鑑定
    ch.equipment[item.slot] = item;
    sfx("equip");
    log(`${item.name} を装備した（${itemPower(item)}）。`);
    if (item.exposurePerTurn) log("……身につけた途端、深みがじわりと滲む。", "warn");
    if (cur) { (ch.gearBag ??= []).push(cur); log(`外した「${itemLabel(cur)}」は荷物へ。`, "dim"); }
    save();
  } else if (r.pick === 2) {
    const idx = (ch.gearBag ?? []).indexOf(item);
    if (idx >= 0) { ch.gearBag!.splice(idx, 1); log(`「${itemLabel(item)}」を置いていった。`, "dim"); save(); }
  }
}

/** 1スロットだけを着け替える（袋の同スロット品から選ぶ／外す）。非戦闘（視界に敵なし）でのみ。 */
async function swapSlot(ch: Character, slot: ItemSlot) {
  busy = true;
  if (!canSwapNow()) { await sheet({ text: "敵が近い。装備は戦いの最中には換えられない。", meta: "装備", options: ["わかった"] }); busy = false; return; }
  const bag = (ch.gearBag ??= []);
  const cur = ch.equipment[slot] ?? null;
  const matches = bag.map((it, idx) => ({ it, idx })).filter((o) => o.it.slot === slot);
  if (!matches.length && !cur) {
    await sheet({ text: `袋に${SLOT_LABEL[slot]}がない。迷宮で拾うと、ここで着け替えられる。`, meta: `装備 ── ${SLOT_LABEL[slot]}`, options: ["閉じる"] });
    busy = false; return;
  }
  const cells = matches.map((o) => ({ html: `<span class="chip ${GEAR_SLOT_CLS[slot]}">${SLOT_LABEL[slot]}</span><div class="nm">${itemLabel(o.it)}</div>` }));
  if (cur) cells.push({ html: `<div class="nm" style="color:var(--tx-dim)">外して袋へしまう</div>` });
  const lead = cur ? `今の${SLOT_LABEL[slot]}：${itemLabel(cur)}` : `今は${SLOT_LABEL[slot]}を着けていない。`;
  const i = await chooseGrid({ title: `${SLOT_LABEL[slot]}を換える`, lead, cells, cancel: "やめる", cols: 1 });
  busy = false;
  if (i < 0) return;
  if (i < matches.length) {
    const chosen = matches[i];
    chosen.it.unidentified = false; // 装備＝鑑定（拾い物フローと同じ）
    ch.equipment[slot] = chosen.it;
    bag.splice(chosen.idx, 1);
    if (cur) bag.push(cur);
    sfx("equip");
    log(`${chosen.it.name} を装備した（${itemPower(chosen.it)}）。`, "cue");
    if (chosen.it.exposurePerTurn) log("……身につけた途端、深みがじわりと滲む。", "warn");
  } else {
    if (!cur) return;
    bag.push(cur); ch.equipment[slot] = null;
    sfx("equip");
    log(`${cur.name} を外して袋にしまった。`, "dim");
  }
  save(); updateStatus();
}

/** 持ち物（消耗品）を使う／捨てる。潜行中の「使う」は一手かかる＝下部の『持ち物』ボタンに誘導（手番処理の再入を避ける）。 */
async function useOrDropConsumable(ch: Character, key: string) {
  busy = true;
  const def = consumableByKey(key);
  const inDive = mode === "dive";
  const a = await sheet({
    text: `${def?.name ?? key}（${def?.desc ?? ""}）`,
    meta: "持ち物",
    options: ["使う", "捨てる", "戻る"],
  });
  if (a.pick === 1) {
    if (inDive) {
      await sheet({ text: "潜行中の使用は一手かかる。画面下の『持ち物』ボタンから使うこと。", options: ["わかった"] });
    } else if (isCombatConsumable(def)) {
      await sheet({ text: "ここで使うものではない。潜ってから役に立つ。", options: ["わかった"] });
    } else {
      const msg = applyConsumable(ch, key); consumeOne(ch, key); sfx("consume");
      log(`${def?.name} を使った（${msg}）。`, "dim"); updateStatus(); save();
    }
  } else if (a.pick === 2) {
    consumeOne(ch, key); log(`${def?.name} を捨てた。`, "dim"); save();
  }
  busy = false;
}

async function spellMenu(ch: Character) {
  busy = true;
  if (ch.spells.length === 0) { await sheet({ text: "まだ術を識らない。レベルアップ・深淵・教団で識れる。", meta: "術", options: ["閉じる"] }); busy = false; return; }
  const r = await sheet({
    text: canSwapNow() ? "戦闘で撃てるのは「構え」だけ。視界に敵がいなければ構え替え可。" : "構え替えは安全な間合い（視界に敵なし）でのみ。図鑑はいつでも見られる。",
    meta: `術 ── 識得 ${ch.spells.length}/${SPELLS.length} ・ 構え ${activeLoadout(ch).length}/${LOADOUT_CAP}`,
    options: ["構えを整える", "術の図鑑を見る", "閉じる"],
  });
  busy = false;
  if (r.pick === 1) { if (canSwapNow()) { busy = true; await manageLoadout(ch); busy = false; } else log("敵が近い。構えは戦いの最中には変えられない。", "dim"); }
  else if (r.pick === 2) await spellCodex(ch);
}

async function spellCodex(ch: Character) {
  busy = true;
  const lo = new Set(activeLoadout(ch));
  const cells = SPELLS.map((s) => {
    const known = ch.spells.includes(s.key);
    const mark = lo.has(s.key) ? "◆構え" : known ? "・識得" : `◇未識得 Lv${s.minLevel ?? 1}`;
    return { html: `<span class="chip ${schoolCls(s.school)}">${s.school}</span><div class="nm">${s.name} <span style="color:#8b94a0;font-weight:400;font-size:11px">${mark}</span></div><div class="sub">深蝕＋${s.cost}・${s.desc}</div>` };
  });
  await chooseGrid({ title: `術の図鑑 ── 識得 ${ch.spells.length}/${SPELLS.length}`, cells, cancel: "閉じる" });
  busy = false;
}

// 依頼の達成条件を一行で明示する（ステータス画面／ギルド board 共用）。目標深度・回収対象を data から導出。
/** 納品系（fetch/contraband）の「袋のこの品が納品対象か」判定。fetch＝指定スロット／contraband＝未鑑定の異物。 */
function questItemMatch(q: Quest, it: Item): boolean {
  if (q.kind === "contraband") return !!it.unidentified; // 密売＝正体の知れぬ品（スロット不問）
  return it.slot === q.targetKind; // fetch＝指定スロット
}

function questConditionLine(q: Quest): string {
  switch (q.kind) {
    case "descend":
      return `深度${q.targetDepth}まで到達し、街へ生還する`;
    case "slay":
      return `深度${q.targetDepth}の《成れの果て》（エリアボス）を撃破する`;
    case "reclaim": {
      const f = q.targetFossilId ? world.fossils.find((x) => x.id === q.targetFossilId) : undefined;
      const who = f?.origin.name ?? "対象";
      return `深度${q.targetDepth ?? "?"}付近で「${who}」の痕跡を再発見する`;
    }
    case "bounty": {
      const name = MONSTER_KINDS.find((k) => k.key === q.targetKind)?.name ?? "対象の魔物";
      return `〔${q.have ?? 0}/${q.need ?? 1}〕「${name}」を討伐する`;
    }
    case "rescue":
      return `深みで手負いの冒険者を救い出す`;
    case "escort":
      return `依頼人「${q.targetKind ?? "同行者"}」を生かして深度${q.targetDepth ?? "?"}まで連れて行く`;
    case "fetch": {
      const label: Record<string, string> = { weapon: "武具（武器）", armor: "武具（防具）", relic: "遺物", bag: "鞄" };
      const have = (world.current?.gearBag ?? []).filter((it) => it.slot === q.targetKind).length;
      return `〔${Math.min(have, q.need ?? 1)}/${q.need ?? 1}〕${label[q.targetKind ?? ""] ?? "指定の品"}を持ち帰り納品する`;
    }
    case "plunder": {
      const f = q.targetFossilId ? world.fossils.find((x) => x.id === q.targetFossilId) : undefined;
      const who = f?.origin.name ?? "対象";
      return `深度${q.targetDepth ?? "?"}付近で「${who}」の亡骸を暴き、遺品を剥ぐ（冒涜＝深蝕を負う）`;
    }
    case "contraband": {
      const have = (world.current?.gearBag ?? []).filter((it) => it.unidentified).length;
      return `〔${Math.min(have, q.need ?? 1)}/${q.need ?? 1}〕未鑑定の異物を鑑定せず故買屋へ密売する`;
    }
    default:
      return q.desc || "（条件不明）";
  }
}

// ---------- メインの縦糸「アウレルの遺した問い」（4-15・2026-07-04 ユーザー承認） ----------
// 世界に一本の「謎の背骨」を通す：欠けた頁 → 遺構「痕」 → 教団の声 → ミラの導き → ライラ・境 → 問いの継承。
// 鉄則＝答えは出さない（4-3①「底は永久に未到達」）。各章は謎を「解く」のでなく「深める」。
// 章は World.aurelChapter（0..6）に蓄積＝世代を跨ぐ＝「解読を継ぐ家系」になる。全て既存機構の上＝web限定・golden 不変。
const AUREL_MARK_DEPTH = 15; // 第二章：遺構「痕」が現れ始める深度（テスト調整候補）
function aurelCh(): number { return world.aurelChapter ?? 0; }
function setAurelCh(n: number): void { world.aurelChapter = n; save(); }

/** 進行ヒント（「進行中の事ども」に常設表示＝縦糸の可視化。次にどこへ行けばいいかだけを言う）。 */
function aurelHint(): string {
  switch (aurelCh()) {
    case 0: return "書記の館の老書記が、誰にも読めない頁を抱えているという。";
    case 1: return `深み（深度${AUREL_MARK_DEPTH}以深）のどこかに、始祖の「痕」が灼き付いているという。`;
    case 2: return "教団〈深淵を讃える者たち〉は、何かを知っているらしい。";
    case 3: return "五つの印が揃うとき、迷宮の口で道を示す者が現れる。";
    case 4: return "深淵帯のどこかで、「境」と呼ばれた人が待っている。";
    case 5: return "奉献を果たしたら、書記イェンにすべてを語れ。";
    default: return "問いは、この家系に継がれた。";
  }
}

/** 序章→第一章＝欠けた頁：書記の館でイェンが年代記の失われた冒頭を見せる（一度きり）。 */
async function maybeAurelIntro(): Promise<void> {
  if (aurelCh() !== 0 || !world.current || busy) return;
  busy = true;
  await sheet({
    text: "老書記イェンが、ふと手を止めた。\n「お前は物を見る目がある。……ひとつ、見せておきたいものがある」。\n\n書架の最奥から、鎖で綴じられた最初の巻が下ろされる。年代記の、いちばん古い一冊。\n開かれた冒頭は――焼け落ちたように、数頁ぶん失われていた。",
    meta: "アウレルの遺した問い ── 序章", options: ["頁をのぞき込む"],
  });
  await sheet({
    text: "「年代記はすべてを覚えている、と皆は言う。だが本当の最初の頁は、誰も読んだことがない」。\n\n「始祖――と呼ぶしかない誰かが、最初にあの深みへ入った。名は失われ、いまは『烙印（アウレル）』とだけ伝わる。何を求めて潜り、何を見て、なぜ還らなかったのか。……この欠けた頁が、儂の生涯の宿題だ」。\n\n「深みで『痕』を見つけたら、教えてくれ。深く潜る者にしか、見えぬものだ」。",
    meta: "アウレルの遺した問い ── 第一章「欠けた頁」", options: ["心に留める"],
  });
  chronicle(world, "legend", "老書記イェンから、年代記の欠けた冒頭頁――始祖アウレルの話を聞いた。", []);
  setAurelCh(1);
  log("《アウレルの遺した問い》――縦糸が始まった（進行は「進行中の事ども」で読める）。", "cue");
  busy = false;
}

/** 第二章＝遺構「痕」（深度15+の盤上ランドマーク・bump で読む）。 */
async function aurelMarkScene(f: Floor): Promise<void> {
  if (busy) return;
  busy = true;
  await sheet({
    text: "岩肌に、聖痕のようなしるしが灼き付いていた。\n炎でも、鑿でもない。深みの理そのものが、ここだけ誰かの意志の形に固まっている。\n\n触れると、熱くも冷たくもない。ただ――「先へ」とだけ、感じる。",
    meta: "アウレルの遺した問い ── 第二章「痕」", options: ["しるしに手を当てる"],
  });
  await sheet({
    text: "指の下で、しるしが一瞬だけ言葉になった。読んだのではない。思い出したのに近い。\n\n『名を残すな。名は、深みに喰われる。\n　おれの代わりに、底を見ろ。\n　そして誰かに――これが問いだったと、伝えてくれ』\n\n目を離すと、しるしはもう、ただの模様に戻っていた。",
    meta: "アウレルの遺した問い ── 第二章「痕」", options: ["目に焼き付ける"],
  });
  f.aurelSite = null;
  chronicle(world, "legend", "深みで始祖の遺構「痕」に触れ、断章を読んだ。『おれの代わりに、底を見ろ』。", []);
  setAurelCh(2);
  busy = false;
  draw(); saveDive();
}

/** 第三章＝教団の「声」：教団の戸をくぐったとき、教主が一度だけ素の声で語る。 */
async function maybeAurelCult(): Promise<void> {
  if (aurelCh() !== 2 || !world.current || busy) return;
  busy = true;
  await sheet({
    text: "祭壇の香が揺れた。仮面の教主が、ふいに――祝詞ではない、素の声で言った。\n\n「……『痕』に触れたな。匂いで分かる」。",
    meta: "アウレルの遺した問い ── 第三章「声」", options: ["黙って先を促す"],
  });
  await sheet({
    text: "「我らが讃えるのは、深淵そのものではないよ。深淵の底から、誰かがずっと、呼んでいるのだ。\n始祖の声だと言う者がいる。神の声だと言う者がいる。ただの残響だと嗤う者もいる。\n――確かめた者だけが、どこにもいない」。\n\n仮面の奥で、教主が笑ったのか泣いたのか、分からなかった。\n「お前は底を見に行く目をしている。……見たら、教えておくれ。呼んでいたのが、誰だったのか」。",
    meta: "アウレルの遺した問い ── 第三章「声」", options: ["祭壇に背を向ける"],
  });
  chronicle(world, "legend", "教団の教主が素の声で語った――深淵の底から、誰かがずっと呼んでいる、と。", []);
  setAurelCh(3);
  busy = false;
}

/** 第四章＝道を示す者：5印が揃った迷宮の口で、ミラ・片目（生死で分岐）がライラへの伝言を託す。 */
async function maybeAurelMira(): Promise<void> {
  if (aurelCh() !== 3 || !world.current || busy) return;
  const miraDead = (world.fossils ?? []).some((fo) => fo.origin.name === "ミラ・片目");
  busy = true;
  if (!miraDead) {
    await sheet({
      text: "迷宮の口の脇に、女がひとり、壁にもたれて立っていた。\n左目が、深みの色――銀に濁っている。深淵帯を見て還った、ただ一人の生き残り。ミラ・片目。\n\n「五つの印。……あんたが、そうか」。",
      meta: "アウレルの遺した問い ── 第四章「導き」", options: ["頷く"],
    });
    await sheet({
      text: "「忠告はしない。行く奴は、何を言っても行く。私がそうだった」。\nミラは懐から、片目の刻印がある小さな骨片を取り出し、押し付けるように渡した。\n\n「底の近くに、ライラという人がいる。……人、と呼んでいいのか、もう分からないが。\n岩壁が呼吸していたら、それだ。これを見せろ。私の名を出せ。それで足りる」。\n\n「――底に何があったか、聞かないのか、と思っているだろう」。銀の左目が、笑った。「聞くな。自分の目で見ろ。それがあの人の流儀で、たぶん、始祖の流儀だ」。",
      meta: "アウレルの遺した問い ── 第四章「導き」", options: ["骨片を受け取る"],
    });
    chronicle(world, "legend", "ミラ・片目が深淵帯への手引きをくれた――底の近くにいる「ライラ」への伝言と共に。", []);
  } else {
    await sheet({
      text: "ギルドの預かり箱に、宛名のない古い手記が届いていた。差出人の欄には、片目の刻印だけ。\n\n――ミラ・片目。深淵帯を見て還った、ただ一人だった人。いまは深みで、静かに変わりつつある人。",
      meta: "アウレルの遺した問い ── 第四章「導き」", options: ["手記を開く"],
    });
    await sheet({
      text: "『私が還れなかったなら、これを読むのは、五つの印を集めた誰かだ。\n　底の近くに、ライラという人がいる。境と呼ばれた人だ。岩壁が呼吸していたら、それだ。\n　私の名を出せ。それで足りる。\n　――そして、聞くな。自分の目で見ろ。それがあの人の流儀で、たぶん、始祖の流儀だ』\n\n手記に挟まれて、片目の刻印がある小さな骨片が落ちてきた。",
      meta: "アウレルの遺した問い ── 第四章「導き」", options: ["骨片を受け取る"],
    });
    chronicle(world, "legend", "亡きミラ・片目の手記が、深淵帯の「ライラ」への手引きを遺していた。", []);
  }
  world.current.traits.push("伝言:ライラ・境へ（ミラより）");
  setAurelCh(4);
  busy = false;
}

/** 第五章＝ライラ・境（深淵帯の盤上ランドマーク・bump で邂逅）。生ける神話＝世界の果ての証人。 */
async function aurelLailaScene(f: Floor): Promise<void> {
  if (busy) return;
  busy = true;
  await sheet({
    text: "岩壁が、人の形に盛り上がっている。\n皮膚は石板のように変色し、目は光を持たない。それでも――呼吸している。胸が、ゆっくりと上下している。\n\n「……ミラの匂いがする」。岩が、しゃがれた声で言った。「まだ生きているか、あの子は」。",
    meta: "アウレルの遺した問い ── 第五章「境」", options: ["骨片を見せる"],
  });
  await sheet({
    text: "ライラ・境。生きたまま秘銀に至った、歴史上ただ一人の例外。\n骨片を見ると、石の顔がわずかにほどけた。\n\n「底に何があるか、聞きに来たのだろう。みんなそうだ。……わからない。ほんとうに、わからないんだ。\nでも、美しい。それだけは、何度でも言える」。\n\n「怖いか？　なら、まだ引き返せる。美しいと思ったら――もう、遅い」。",
    meta: "アウレルの遺した問い ── 第五章「境」", options: ["アウレルのことを訊く"],
  });
  await sheet({
    text: "「烙印の人か」。ライラは長いこと黙った。岩壁の呼吸だけが、洞に響いた。\n\n「――あの人は、答えを見つけて還らなかったのではないよ。\n順序が逆だ。問いのほうが、あの人を選んだのだ。\n選ばれた者は、底を見る。見て、どうするかは……それぞれだ。私は、ここで境になることにした」。\n\n「おまえにも、いずれ分かる。聖遺物を抱いて地上の光を見た瞬間に、な。\n……行け。呼ばれているうちに」。\n\n岩壁は、それきり何も言わなかった。ただ、呼吸だけが続いていた。",
    meta: "アウレルの遺した問い ── 第五章「境」", options: ["深く一礼して離れる"],
  });
  f.aurelSite = null;
  chronicle(world, "legend", "深淵帯でライラ・境に会った。『問いのほうが、あの人を選んだ』。", []);
  setAurelCh(5);
  busy = false;
  draw(); saveDive();
}

/** 終章＝問いの継承：奉献を果たしたのち、書記の館で。答えは出ない――問いが家系に継がれる。 */
async function maybeAurelFinale(): Promise<void> {
  if (aurelCh() !== 5 || (world.ascended ?? 0) < 1 || !world.current || busy) return;
  busy = true;
  await sheet({
    text: "イェンは、あなたの話を最後まで黙って聞いた。欠けた頁。痕の断章。教団の声。ミラの骨片。そして――岩壁の呼吸と、『問いのほうが、あの人を選んだ』という言葉。\n\n老書記は長いこと目を閉じ、それから、新しい一頁を年代記に綴じた。\n最初の欠けた頁は、埋まらないまま。",
    meta: "アウレルの遺した問い ── 終章「継がれる問い」", options: ["「頁は、埋まらないのか」"],
  });
  await sheet({
    text: "「埋まらんよ、この頁は。儂の代でも、お前の代でも」。\nイェンは笑った。皺の奥で、目だけが若かった。\n\n「だが、いいことを教えてやろう。欠けた頁の“次の頁”は、もう書かれ始めている。\nお前と、お前の家系が、ずっと書き続けている。斃れた者も、退いた者も、みな一行ずつ。\n\n……問いは、答えより長生きするものだ。それでいい。それが、いい」。\n\n窓の外で、街の鐘がひとつ鳴った。深みは今日も、そこにある。",
    meta: "アウレルの遺した問い ── 終章「継がれる問い」", options: ["年代記を閉じる"],
  });
  chronicle(world, "legend", "奉献の顛末を書記に語った。欠けた頁は埋まらぬまま――問いは、この家系に継がれた。", []);
  setAurelCh(6);
  busy = false;
}

async function eventsScreen() {
  busy = true;
  const act = activeQuests(world), done = doneQuests(world);
  const claimAt = (q: Quest) => (q.patron === "noble" ? "謁見の間" : q.source === "tavern" ? "酒場" : "ギルド");
  const questRows: SheetRow[] = [];
  for (const q of act) {
    questRows.push({ text: `${q.patron === "noble" ? "【大命】" : ""}${q.title}` });
    questRows.push({ text: `条件：${questConditionLine(q)}／報酬 金${q.rewardGold}${q.rewardRelic ? "＋秘宝" : ""}`, dim: true });
  }
  for (const q of done) questRows.push({ text: `【達成】${q.title} → ${claimAt(q)}で 金${q.rewardGold} を受領` });
  if (!questRows.length) questRows.push({ text: "依頼はない", dim: true });
  const arcRows: SheetRow[] = (world.arcs ?? []).filter((a) => !a.done).map((a) => ({ text: `${ARC_KEY_LABEL[a.key] ?? a.key}（第${a.step}段）` }));
  if (!arcRows.length) arcRows.push({ text: "進行中の因縁はない", dim: true });
  const sealRows: SheetRow[] = sealProgressLine().split("\n").map((t) => ({ text: t.trim() }));
  if (world.current?.carryingRelic) sealRows.push({ text: "★聖遺物を携行中（地上へ生還せよ）", cls: "warn" });
  const aurelRows: SheetRow[] = [
    { text: `読み解いた章：${aurelCh()}／6`, dim: true },
    { text: aurelHint() },
  ];
  await sheet({ sections: [
    { header: "アウレルの遺した問い", rows: aurelRows },
    { header: "依頼", rows: questRows },
    { header: "因縁・長尺", rows: arcRows },
    { header: "奉献の印", rows: sealRows },
  ], meta: "進行中の事ども", options: ["閉じる"] });
  busy = false;
}

// 能力の説明＋対処のヒント（図鑑の詳細・図鑑拡充）。ラベルは盤面/図鑑共通。
const ABILITY_LABEL: Record<string, string> = { ranged: "遠隔", venom: "毒", leech: "吸命", breeder: "増殖", reflect: "反射", curse: "侵蝕" };
const ABILITY_INFO: Record<string, string> = {
  ranged: "射程の外から狙撃する。接近されると間合いを取り直す＝詰め寄れば弱い。",
  venom:  "命中で毒を盛り、次手から継続ダメージ。解毒の丸薬・遺物〈澄心〉が効く。",
  leech:  "与えたぶん自己回復する。火力を集中し、一気に削れ。",
  breeder:"ときおり眷属を湧かす。数で圧される前に、母体を断て。",
  reflect:"近接で殴ると一部を返す。術・投擲が安全。遺物〈茨〉で対抗できる。",
  curse:  "命中で深蝕を上塗りする。深追いは禁物。遺物〈澄心〉で半減。",
};
// モンスター寸評（博物誌風・1行・純フレーバー＝ゲーム性ゼロ）。key は MONSTER_KINDS の key。
const MONSTER_LORE: Record<string, string> = {
  rat: "迷宮の浅みに棲みつく、ただ大きいだけの鼠。深みの理には、まだ遠い。",
  beetle: "硬い甲殻にくるまれ、一撃では割れない。火力は無いが、道を塞ぐ壁となる。",
  bat: "気まぐれに飛び交い、軌道が読めない。脆いが、数で苛立たせる。",
  snake: "岩肌に擬態して待ち伏せる。噛みつきは、見た目より重い。",
  ghoul: "死肉に群がる深みの常連。単体は鈍いが、淀みに潜んでいる。",
  wisp: "ふらりと漂う燐光。触れれば灼ける。実体は薄く、脆い。",
  wraith: "帰れなかった者の残響。冷たい一撃を放つ。",
  ogre: "岩のような巨躯。動きは鈍いが、一打は重い。",
  spitter: "間合いの外から酸を吐く。詰め寄れば、もがいて退く。",
  viper: "牙に毒を仕込む。傷そのものより、巡る毒が怖い。",
  leecher: "吸った血で己を癒す。長引くほど、しぶとくなる。",
  brood: "蠢く卵嚢。放っておけば眷属が湧き、数で圧してくる。",
  troll: "深層の壁。膨大な体力で、ただ道を阻む。",
  drake: "深みの竜の成れの果て。一撃が鋭く、重い。",
  horror: "形を保てぬ顔。動きが読めず、最も底に近い。",
  imp: "素早く、脆い。深みの最初の洗礼。",
  crawler: "壁を這い、じわりと間合いを詰める。",
  hound: "影を駆け、瞬く間に懐へ飛び込む。",
  brute: "鉄の腕で殴りつける、硬い壁役。",
  reaver: "鋭い刃をふるう高火力の近接。受ければ深く斬られる。",
  golem: "石を寄せ集めた鈍重な兵。崩すのに骨が折れる。",
  gloom: "蠢く闇の塊。深層で群れをなす。",
  phantom: "実在の定かでない影。不規則に揺らぎ、狙いが定まらない。",
  colossus: "最深の壁。見上げるほどの巨体が道を埋める。",
  archer: "朽ちた弓を構える骸。遠間から正確に射る。",
  seer: "深部に浮かぶ眼。視界の外から、こちらを射抜く。",
  spore: "弾けて胞子を撒く。漂う毒が、じわりと体を蝕む。",
  slug: "這った跡が腐り落ちる。毒の継続が、深部では重い。",
  wailer: "嘆きながら毒を振りまく、深部の哀しき種。",
  drainer: "命を喰らって傷を埋める。深部の、しぶとい吸血種。",
  mother: "蠢く母体。絶えず眷属を産み落とし続ける。",
  voiddrake: "深淵帯の竜。理を失い、ただ巨大で、苛烈。",
  thornward: "全身を棘で覆う番人。近づいて殴る者を、確かに罰する。",
  defiler: "触れた者へ深みを上塗りする影。傷より、侵蝕が怖い。",
  voideye: "深淵に浮かぶ瞳。彼方からこちらを見据え、射抜く。",
  abyssmaw: "肉の塊が、際限なく仔を吐き出す。深淵の数の暴力。",
  endbringer: "底に最も近い貌。その一撃は、すべてを終わらせる。",
};
const tierStars = (t: number) => "★".repeat(t) + "☆".repeat(Math.max(0, 5 - t));
const erraticWord = (e: number) => e <= 0.1 ? "規則的" : e < 0.25 ? "やや不規則" : e < 0.45 ? "気まぐれ" : "不規則";
const depthBandLabel = (k: { minDepth: number }) => k.minDepth > 50 ? "深淵帯" : k.minDepth >= 38 ? "深層の底" : k.minDepth >= 25 ? "深層" : k.minDepth >= 9 ? "中層" : "浅層";

/** モンスター図鑑：遭遇した敵を色付きグリフ＋危険度＋能力タグの一覧で示し、タップで詳細（ステ・攻撃・対処・寸評）。 */
async function bestiaryScreen() {
  busy = true;
  // 遭遇名のうち MONSTER_KINDS に在る正規種のみ（ボス/手負い等の一回限りの固有名は除外＝図鑑を整える）。
  const seenKinds = (world.bestiary ?? [])
    .map((n) => MONSTER_KINDS.find((k) => k.name === n))
    .filter((k): k is NonNullable<typeof k> => !!k)
    .sort((a, b) => a.minDepth - b.minDepth);
  for (;;) {
    if (!seenKinds.length) {
      await sheet({ text: "まだ何も見ていない。深みで出会った敵が、ここに記される。", meta: "モンスター図鑑 ── 遭遇 0種", options: ["閉じる"] });
      break;
    }
    const cells = seenKinds.map((k) => ({
      html: `<div class="nm"><span class="g-mon-t${k.tier}" style="font-size:1.25em">${k.glyph}</span>　${k.name}`
        + `${k.ability ? ` <span style="color:#9aa4b0;font-weight:400">〔${ABILITY_LABEL[k.ability]}〕</span>` : ""}</div>`
        + `<div class="sub"><span class="g-mon-t${k.tier}">${tierStars(k.tier)}</span>　深度${k.minDepth}〜${k.maxDepth ? k.maxDepth : ""}・${depthBandLabel(k)}</div>`,
    }));
    const i = await chooseGrid({ title: `モンスター図鑑 ── 遭遇 ${seenKinds.length}／${MONSTER_KINDS.length}種`, cells, cancel: "閉じる", cols: 1 });
    if (i < 0 || i >= seenKinds.length) break;
    const k = seenKinds[i];
    const rows: SheetRow[] = [
      { label: "危険度", value: `${tierStars(k.tier)}（tier ${k.tier}）` },
      { label: "出現", value: `深度${k.minDepth}〜${k.maxDepth ? k.maxDepth : "（最深まで）"}・${depthBandLabel(k)}` },
      { label: "体力", value: String(k.hp), note: "基礎値" },
      { label: "攻撃", value: String(k.dmg), note: "深く潜るほど増す" },
      { label: "動き", value: erraticWord(k.erratic) },
      { label: "能力", value: k.ability ? `〔${ABILITY_LABEL[k.ability]}〕` : "なし（素の近接）" },
    ];
    if (k.ability && ABILITY_INFO[k.ability]) rows.push({ text: ABILITY_INFO[k.ability], dim: true });
    const lore = MONSTER_LORE[k.key] ?? "";
    const sections: SheetSection[] = [{ rows }];
    if (lore) sections.push({ header: "寸評", rows: [{ text: lore }] });
    await sheet({ text: `${k.glyph}　${k.name}`, sections, meta: `図鑑 ── ${k.name}`, options: ["戻る"] });
  }
  busy = false;
}

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
  try { localStorage.removeItem(SAVE_KEY); localStorage.removeItem(PORTAL_KEY); } catch { /* ignore */ }
  clearDive();
  log("世界をまっさらに戻す……", "warn");
  location.reload(); // 再起動＝boot() が新規 World＋キャラ作成から走る（一時状態の取りこぼし無し）
}

/** 術の構え（ロードアウト）を整える。識得済みの中から LOADOUT_CAP 個を選んで構える（安全地帯のみ）。 */
async function manageLoadout(ch: Character) {
  if (!ch.loadout) ch.loadout = ch.spells.slice(0, LOADOUT_CAP);
  for (;;) {
    const known = ch.spells.map((k) => spellByKey(k)).filter((s): s is NonNullable<typeof s> => !!s);
    // 学派チップ＋構え印のカード（術の図鑑 spellCodex と同じ見た目）。タップで 構え⇄控え を入れ替える。
    const cells = known.map((s) => {
      const on = ch.loadout!.includes(s.key);
      return { html: `<span class="chip ${schoolCls(s.school)}">${s.school}</span>`
        + `<div class="nm">${on ? `<span style="color:#ffd87a">◆</span>` : ""}${s.name} <span style="color:#8b94a0;font-weight:400;font-size:11px">${on ? "構え中" : "控え"}</span></div>`
        + `<div class="sub">深蝕＋${s.cost}・${s.desc}</div>` };
    });
    const i = await chooseGrid({
      title: `術の構え ── ${ch.spells.length}種 識得`,
      lead: `戦闘で撃てるのは「構え」だけ。タップで 構え⇄控え を入れ替える。　構え ${ch.loadout!.length}/${LOADOUT_CAP}`,
      cells, cancel: "閉じる", cols: 1,
    });
    if (i < 0 || i >= known.length) break;
    const s = known[i];
    const at = ch.loadout!.indexOf(s.key);
    if (at >= 0) { ch.loadout!.splice(at, 1); log(`${s.name} を控えに戻した。`, "dim"); }
    else if (ch.loadout!.length < LOADOUT_CAP) { ch.loadout!.push(s.key); log(`${s.name} を構えた。`, "dim"); }
    else log(`構えは${LOADOUT_CAP}つまで。何か外してから。`, "dim");
  }
  save();
}

// ---------- 入力（8方向：スワイプ／方向キー／numpad／viキー(yubn)／D-pad。タップ＝待機／図でタップ＝自動移動／.＝待機） ----------
// 操作系の端末設定（設定＝⌃メニュー）：D-pad オンオフ／位置／大きさ、ログ文字サイズ。すべて localStorage 記憶。
const DPAD_KEY = "sekitsui.dpad";
const DPAD_POS_KEY = "sekitsui.dpad.pos";
const DPAD_SIZE_KEY = "sekitsui.dpad.size";
const DPAD_AUTORUN_KEY = "sekitsui.dpad.autorun";
const LOG_SIZE_KEY = "sekitsui.logsize";
type Sz = "lg" | "md" | "sm";
let dpadOn = true; // 既定オン
let dpadPos: "right" | "left" | "center" = "right"; // 既定は右下（利き手側）。中央も選べる（メニュー下置きで余裕あり）
let dpadSize: Sz = "md"; // 既定 中
let dpadAutorun = true; // 長押しで連続移動（既定オン）。危険・場面で自動停止
let logSize: Sz = "md"; // 既定 中（ログを読みやすく）
function loadDpadPref() {
  try {
    dpadOn = localStorage.getItem(DPAD_KEY) !== "0"; // 未設定＝オン
    const dp = localStorage.getItem(DPAD_POS_KEY);
    dpadPos = dp === "left" || dp === "center" ? dp : "right";
    const dz = localStorage.getItem(DPAD_SIZE_KEY); if (dz === "lg" || dz === "md" || dz === "sm") dpadSize = dz;
    dpadAutorun = localStorage.getItem(DPAD_AUTORUN_KEY) !== "0"; // 未設定＝オン
    const lz = localStorage.getItem(LOG_SIZE_KEY); if (lz === "lg" || lz === "md" || lz === "sm") logSize = lz;
  } catch { /* ignore */ }
}
function setDpadAutorun(on: boolean) { dpadAutorun = on; if (!on) dpadHoldEnd(); try { localStorage.setItem(DPAD_AUTORUN_KEY, on ? "1" : "0"); } catch { /* ignore */ } }
/** 下部の操作系（タブバー・D-pad）を mode と設定に応じて表示更新。updateStatus から毎度呼ぶ。 */
function applyChrome() {
  const inGame = !!world.current;
  const dive = mode === "dive";
  const combat = dive || mode === "raid"; // 術/品は街防衛戦でも使える
  const walk = combat || mode === "town" || mode === "interior";
  // 下部タブバー＝在ゲーム中は常駐（術/品/地図/ステータス/設定）。position:fixed で最下端固定。
  $("tabbar").classList.toggle("show", inGame);
  document.body.classList.toggle("has-tabbar", inGame); // バー高ぶんの下部余白を本体に確保
  // 術/品 は迷宮＋街防衛戦で有効／地図は迷宮のみ。ステータス/設定は常時有効。
  ($("spellBtn") as HTMLElement).classList.toggle("dis", !combat);
  ($("bagBtn") as HTMLElement).classList.toggle("dis", !combat);
  ($("mapBtn") as HTMLElement).classList.toggle("dis", !dive);
  // D-pad 帯（移動補助）＝歩ける場面で常駐・タブバーの上。
  const showDpad = dpadOn && walk;
  const deck = $("deck");
  deck.classList.toggle("show", inGame && showDpad);
  deck.classList.remove("pos-left", "pos-center", "nopad");
  if (dpadPos === "left") deck.classList.add("pos-left");
  else if (dpadPos === "center") deck.classList.add("pos-center");
  const dp = $("dpad");
  dp.classList.toggle("show", showDpad);
  dp.classList.remove("sz-lg", "sz-md", "sz-sm"); dp.classList.add(`sz-${dpadSize}`);
}
function applyLogSize() { $("log").classList.remove("s-sm", "s-lg"); if (logSize === "sm") $("log").classList.add("s-sm"); else if (logSize === "lg") $("log").classList.add("s-lg"); }
function setDpad(on: boolean) { dpadOn = on; try { localStorage.setItem(DPAD_KEY, on ? "1" : "0"); } catch { /* ignore */ } applyChrome(); }
function setDpadPos(p: "right" | "left" | "center") { dpadPos = p; try { localStorage.setItem(DPAD_POS_KEY, p); } catch { /* ignore */ } applyChrome(); }
function setDpadSize(s: Sz) { dpadSize = s; try { localStorage.setItem(DPAD_SIZE_KEY, s); } catch { /* ignore */ } applyChrome(); }
function setLogSize(s: Sz) { logSize = s; try { localStorage.setItem(LOG_SIZE_KEY, s); } catch { /* ignore */ } applyLogSize(); }

// 操作パネル/メニューのアイコン（インラインSVG・細線＋currentColor の淡い glow。発光グリフに合わせる）。
const ICONS = {
  spell: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M12 12c0-1.5 1.2-2.6 2.7-2.4 1.9.3 2.8 2.2 2.2 4-.8 2.4-3.4 3.4-5.7 2.4-2.9-1.2-4-4.6-2.6-7.3 1.7-3.3 5.9-4.5 9.3-2.5"/></svg>`,
  bag: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M8.5 8c0-2.2 1.5-3.8 3.5-3.8S15.5 5.8 15.5 8"/><path d="M6.6 8h10.8l1.1 7.6a3.8 3.8 0 0 1-3.8 4.3H9.3a3.8 3.8 0 0 1-3.8-4.3L6.6 8z"/><path d="M9.2 12.2h5.6"/></svg>`,
  stat: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="8" r="3.3"/><path d="M5.5 19.5c0-3.7 2.9-6.2 6.5-6.2s6.5 2.5 6.5 6.2"/></svg>`,
  map: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6.2l6-2 6 2 6-2v13.6l-6 2-6-2-6 2V6.2z"/><path d="M9 4.2v13.6M15 6.2v13.6"/></svg>`,
  hub: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M12 6.2C9.8 4.9 7.2 4.6 4.5 5.2v13c2.7-.6 5.3-.3 7.5 1 2.2-1.3 4.8-1.6 7.5-1v-13C16.8 4.6 14.2 4.9 12 6.2z"/><path d="M12 6.2v13"/></svg>`,
  cog: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M5 7h6M15 7h4M5 12h2M11 12h8M5 17h9M18 17h1"/><circle cx="13" cy="7" r="2"/><circle cx="9" cy="12" r="2"/><circle cx="16" cy="17" r="2"/></svg>`,
};
// 下部タブバー：術／品／地図／ステータス／設定＝アイコンのみ（文字なし＝ゲームUI標準）。
$("spellBtn").innerHTML = ICONS.spell;
$("bagBtn").innerHTML = ICONS.bag;
$("mapBtn").innerHTML = ICONS.map;
$("statBtn").innerHTML = ICONS.stat;
$("cogBtn").innerHTML = ICONS.cog;
// 地図タブ：踏破範囲の俯瞰を即トグル（迷宮のみ）。
$("mapBtn").onclick = () => { if (mode !== "dive") return; setMapMode(!mapMode); };
// 照準バー：ボタンは地図のスワイプ/タップ判定から隔離（touch を mapWrap へ伝播させない）。
$("aimGo").onclick = () => confirmAim();
$("aimCancel").onclick = () => cancelAim();
$("mapOverviewBtn").onclick = () => toggleMapOverview();
for (const ev of ["touchstart", "touchend", "pointerdown"]) {
  $("aimBar").addEventListener(ev, (e) => e.stopPropagation(), { passive: true });
  $("mapOverviewBtn").addEventListener(ev, (e) => e.stopPropagation(), { passive: true }); // 地図のタップ/パン判定へ伝播させない
}
// ステータスタブ＝身上・装備・術・進行中・年代記・敵図鑑（旧「冒険の記録」を統合）。
$("statBtn").onclick = () => { if (!busy) void charScreen(); };
// 設定タブ＝音・操作・表示。
$("cogBtn").onclick = () => { if (!busy) void settingsSheet(); };
// HUD のバフ帯タップ＝今かかっている加護・状態の説明（SPD 流）。
$("stBuff").onclick = () => { if (!busy && (mode === "dive" || mode === "raid")) void buffSheet(); };

/** 視界内に生存敵がいる＝戦闘中（既存の自動移動中断と同じ判定）。 */
function inSight(): boolean {
  if (mode !== "dive" || !floor) return false;
  const vis = computeFov(floor, player);
  return floor.monsters.some((m) => m.hp > 0 && vis.has(mapIdx(floor!, m.x, m.y)));
}
/** 術の構え替え・装備換装が可能か＝街/安全地帯、または迷宮でも視界に敵がいなければ可（4-11F③ 緩和）。 */
function canSwapNow(): boolean { return mode !== "dive" || !inSight(); }
/** 敵図鑑：視界内の生存敵の種名を World に蓄積（世代越え）。 */
function recordBestiary() {
  if (mode !== "dive" || !floor) return;
  const vis = computeFov(floor, player);
  const bag = (world.bestiary ??= []);
  for (const m of floor.monsters) {
    // 正規種（MONSTER_KINDS）のみ図鑑に編む＝ボス/手負い/眷属の一回限りの固有名は載せない（図鑑を整える）。
    if (m.hp > 0 && vis.has(mapIdx(floor, m.x, m.y)) && MONSTER_KINDS.some((k) => k.key === m.kind.key) && !bag.includes(m.kind.name)) bag.push(m.kind.name);
  }
}

/** 移動入力の合流点（キー／スワイプ／D-pad）。8方向＋待機。mode と図モードの面倒を見る。 */
function dirMove(dx: number, dy: number) {
  if (busy || overlayEl.classList.contains("show")) return; // シート表示中は盤面を動かさない（街と同じ＝確認等の入れ子シート裏での誤操作・再入防止）
  ensureAudio();
  if (mode === "town" || mode === "interior") { if (dx === 0 && dy === 0) return; townAct(dx, dy); return; }
  if (mode === "raid") { void raidAct(dx, dy); return; } // 街防衛戦＝盤上で迎え撃つ
  if (mode !== "dive") return;
  if (mapMode) {
    if (aim) { // 照準モード：方向で1マス調整／中央(0,0)で確定
      if (dx === 0 && dy === 0) confirmAim();
      else setAim(aim.x + dx, aim.y + dy);
      return;
    }
    setMapMode(false); return;
  }
  void playerAct(dx, dy);
}

/** スワイプのベクトルを8方向へ量子化（45°セクタ。tan22.5°≈0.414 で斜めと直交を分ける）。 */
function octant(dx: number, dy: number): [number, number] {
  const adx = Math.abs(dx), ady = Math.abs(dy);
  const sx = adx > ady * 0.414 ? Math.sign(dx) : 0;
  const sy = ady > adx * 0.414 ? Math.sign(dy) : 0;
  return [sx, sy];
}

// 長押しで連続移動（D-pad・テストプレイFB「方向キーの連打が面倒」対応）。
// タップ＝1歩は不変／長押し（DPAD_HOLD_DELAY 超）で連続移動。危険・場面・壁で自動停止（誤爆防止）。
const DPAD_HOLD_DELAY = 280; // ms：これ以上押し続けたら連続移動を開始（タップとの区別）
const DPAD_REPEAT_MS = 110;  // ms：連続移動の1歩あたり間隔
let dpadHoldDir: [number, number] | null = null;
let dpadHoldTimer: ReturnType<typeof setTimeout> | null = null;
let dpadRunning = false;

/** 連続移動の1歩。続行可なら true。安全停止（敵が視界／被ダメ／場面/壁/死/モード変化）で false。 */
async function dpadStep(dx: number, dy: number): Promise<boolean> {
  if (busy || overlayEl.classList.contains("show") || mapMode) return false;
  if (mode === "town") { // 街：壁/NPC/景物（動けない）と場面オープンで停止
    const before = `${townPlayer.x},${townPlayer.y}`;
    townAct(dx, dy);
    if (busy || mode !== "town") return false;
    return `${townPlayer.x},${townPlayer.y}` !== before;
  }
  if (mode !== "dive" || !floor || !world.current) return false;
  const vis = computeFov(floor, player);
  if (floor.monsters.some((m) => m.hp > 0 && vis.has(mapIdx(floor!, m.x, m.y)))) { log("敵の気配。連続移動を止めた。", "warn"); return false; }
  const px = player.x, py = player.y, hpBefore = hp;
  if (!moveOrInteract(player.x + dx, player.y + dy)) return false; // 壁
  if (busy) { draw(); return false; } // 宝箱/化石/階段/帰還扉の場面が開いた＝そこで止める
  await endTurn();
  if (hp <= 0 || hp < hpBefore || (player.x === px && player.y === py)) return false; // 死/被ダメ/進めず
  return true;
}
/** 押しっぱなしの間、同じ方向へ歩き続ける（dpadStep が false を返すまで）。 */
async function dpadHoldLoop(dx: number, dy: number) {
  if (dpadRunning) return;
  dpadRunning = true;
  while (dpadHoldDir && dpadHoldDir[0] === dx && dpadHoldDir[1] === dy) {
    if (!(await dpadStep(dx, dy))) break;
    await sleep(DPAD_REPEAT_MS);
  }
  dpadRunning = false;
}
function dpadHoldStart(dx: number, dy: number) {
  if (!dpadAutorun || (dx === 0 && dy === 0)) return; // オフ時・待機(中央)は連続しない
  dpadHoldDir = [dx, dy];
  if (dpadHoldTimer) clearTimeout(dpadHoldTimer);
  dpadHoldTimer = setTimeout(() => { if (dpadHoldDir && dpadHoldDir[0] === dx && dpadHoldDir[1] === dy) void dpadHoldLoop(dx, dy); }, DPAD_HOLD_DELAY);
}
function dpadHoldEnd() {
  dpadHoldDir = null;
  if (dpadHoldTimer) { clearTimeout(dpadHoldTimer); dpadHoldTimer = null; }
}

// D-pad のボタン（body 直下＝mapWrap のタッチ判定と干渉しない）。pointer で押下=即1歩＋長押し連続。
for (const btn of Array.from($("dpad").querySelectorAll("button"))) {
  const el = btn as HTMLElement;
  const dx = Number(el.dataset.dx), dy = Number(el.dataset.dy);
  el.addEventListener("pointerdown", (e) => { e.preventDefault(); dirMove(dx, dy); dpadHoldStart(dx, dy); });
  el.addEventListener("pointerup", dpadHoldEnd);
  el.addEventListener("pointercancel", dpadHoldEnd);
  el.addEventListener("pointerleave", dpadHoldEnd);
}
// 指/マウスがボタン外で離れても確実に止める（touch はボタン外 up を拾えないことがある）。
addEventListener("pointerup", dpadHoldEnd);
addEventListener("pointercancel", dpadHoldEnd);

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
let mapPanLast: { x: number; y: number } | null = null; // 地図ドラッグの直近位置（パン差分の起点）
let mapPanned = false;                                    // このタッチでパンが起きたか（起きたら tap 扱いしない）
$("mapWrap").addEventListener("touchstart", (e) => {
  touchStart = { x: e.touches[0].clientX, y: e.touches[0].clientY };
  mapPanLast = { ...touchStart };
  mapPanned = false;
}, { passive: true });
$("mapWrap").addEventListener("touchmove", (e) => {
  // 地図モードでフロアが収まりきらないとき＝ドラッグでカメラをパン（v0.109.0）。
  if (!mapMode || !floor || !mapPannable() || !mapPanLast || cellSize <= 0) return;
  const cx = e.touches[0].clientX, cy = e.touches[0].clientY;
  const dxT = Math.round((cx - mapPanLast.x) / cellSize), dyT = Math.round((cy - mapPanLast.y) / cellSize);
  if (dxT === 0 && dyT === 0) return;
  mapCam = { x: clampCam(mapCam.x - dxT, floor.w, mapCols), y: clampCam(mapCam.y - dyT, floor.h, mapRows) }; // 指の向きと逆＝紙をつまんで動かす感覚
  mapPanLast = { x: cx, y: cy };
  mapPanned = true;
  drawMapMode();
}, { passive: true });
$("mapWrap").addEventListener("touchend", (e) => {
  if (!touchStart) return;
  const tx = e.changedTouches[0].clientX, ty = e.changedTouches[0].clientY;
  const dx = tx - touchStart.x, dy = ty - touchStart.y;
  touchStart = null; mapPanLast = null;
  const tap = Math.hypot(dx, dy) < 24;
  if (mapPanned) { mapPanned = false; return; } // ドラッグでパンした＝タップ/スワイプ扱いしない

  if (mode === "town" || mode === "interior") {
    if (!tap) { // スワイプ＝8方向移動
      const [sx, sy] = octant(dx, dy); townAct(sx, sy);
    } else { // タップ＝隣接マスへ一歩（斜め含む）。hitCell＝中央寄せ補正込み（v0.99.0）
      const h = hitCell(tx, ty);
      if (h) {
        const ddx = cam.x + h.x - townPlayer.x, ddy = cam.y + h.y - townPlayer.y;
        if (Math.max(Math.abs(ddx), Math.abs(ddy)) === 1) townAct(Math.sign(ddx), Math.sign(ddy));
      }
    }
    return;
  }

  if (mapMode) {
    // 図：タップ→最寄りの到達マスにマーカー（照準モード）。D-padで微調整→確定で自動移動（FB 2026-06-23）。
    if (tap && floor) {
      const h = hitCell(tx, ty); // グリッド相対＝mapCam を足してワールド座標に（v0.109.0 カメラ窓）
      if (h) {
        const snap = nearestReachable(floor, player, mapCam.x + h.x, mapCam.y + h.y); // 指のズレを吸収＝最寄りの到達床へ
        if (snap) { setAim(snap.x, snap.y); return; }
      }
    }
    // タップ（床外/到達不能）：照準中なら解除、無ければ地図を閉じる。パン可能な地図でのスワイプは何もしない（誤爆で閉じない）。
    if (tap) { if (aim) cancelAim(); else setMapMode(false); }
    else if (!mapPannable()) { if (aim) cancelAim(); else setMapMode(false); }
    return;
  }

  const act = mode === "raid" ? raidAct : playerAct; // 街防衛戦も同じ操作で迎え撃つ
  if (!tap) { // スワイプ＝8方向移動
    const [sx, sy] = octant(dx, dy); void act(sx, sy);
    return;
  }
  // タップ＝そのマスを調べる（v0.99.0・NetHack「;」の現代化。手番は消費しない）。
  // 旧仕様「タップ＝待機」は廃止＝誤タップの1手消費事故も解消。待機は D-pad 中央「待」／「.」キー。
  const h = hitCell(tx, ty);
  if (h) showPeek(cam.x + h.x, cam.y + h.y);
}, { passive: true });

addEventListener("resize", () => {
  if (mode === "town") { buildGridDom(townGrid.data.view.w, townGrid.data.view.h); drawTown(); return; }
  if (mode === "interior" && interior) { buildGridDom(interior.w, interior.h); drawInterior(); return; }
  if (mode !== "dive") return;
  if (mapMode && floor) { layoutMapView(); drawMapMode(); }
  else { buildGridDom(); draw(); }
});

// ---------- 起動 ----------
// ---------- タイトル画面（M5・起動の入口。続きから／新しい物語／設定）----------
//   起動でいきなり街/キャラ作成に入らず、まず一枚挟む（最初の操作音＋版数確認＋途中再開の明示化）。
//   ゲーム本体は townLoop→startDive→… の自己連鎖。タイトルはそこへ一度分岐するだけ（設定は自分へ戻る）。
/** 専用タイトル画面（#title オーバーレイ）にメニューを流し込み、選んだ index を返す（横断F 段階1）。 */
// タイトルの音声ゲート（autoplay 対策）：ブラウザは初回ユーザー操作まで音を出せないため、
// コールド起動時のみ「画面に触れてはじめる」を一枚挟み、その一手で AudioContext を起こして
// ④追憶（setBgm("title")）を立ち上げてからメニューを出す。音声解禁済み／BGMオフ／ミュート時は出さない。
function titleGate(sub: string): Promise<void> {
  return new Promise((resolve) => {
    $("titleSub").textContent = sub;
    $("titleVer").textContent = `v${APP_VERSION} ／ build ${APP_BUILD}`;
    const menu = $("titleMenu");
    menu.innerHTML = "";
    const b = document.createElement("button");
    b.type = "button"; b.className = "primary"; b.textContent = "▶ 画面に触れて、はじめる";
    b.onclick = () => { ensureAudio(); resolve(); }; // この一手で音声解禁＝タイトルBGMが立ち上がる
    menu.appendChild(b);
    $("title").classList.add("show");
  });
}
function titleChoose(items: { label: string; primary?: boolean }[], sub: string): Promise<number> {
  return new Promise((resolve) => {
    $("titleSub").textContent = sub;
    $("titleVer").textContent = `v${APP_VERSION} ／ build ${APP_BUILD}`;
    const menu = $("titleMenu");
    menu.innerHTML = "";
    const shownAt = performance.now();
    items.forEach((it, i) => {
      const b = document.createElement("button");
      b.type = "button"; b.textContent = it.label;
      if (it.primary) b.className = "primary";
      b.onclick = () => { if (performance.now() - shownAt < 300) return; $("title").classList.remove("show"); resolve(i); };
      menu.appendChild(b);
    });
    $("title").classList.add("show");
  });
}

async function titleScreen(): Promise<void> {
  setBgm("title");
  const ch = world.current;
  const living = !!(ch && ch.alive);
  const snap = living ? loadDive() : null;
  const sub = living
    ? (snap ? `${ch!.name} は 深度 ${snap.depth} に潜っている` : `${ch!.name} は 灰の街にいる（第${world.generation}世代）`)
    : (world.generation > 0 ? `第${world.generation}世代まで堆積した世界` : "まだ誰も、ここへは潜っていない");
  const items = living
    ? [{ label: "▶ 続きから", primary: true }, { label: "新しい物語をはじめる" }, { label: "設定" }]
    : [{ label: "▶ 新しい物語をはじめる", primary: true }, { label: "設定" }];
  // autoplay 対策：コールド起動（音声未解禁）かつ BGM 有効時のみ、最初の一手でタイトルBGMを立ち上げる。
  if (!audioStarted() && isBgmOn() && !isMuted()) await titleGate(sub);
  const pick = await titleChoose(items, sub);
  const chosen = items[pick]?.label ?? items[0].label;
  if (chosen.includes("続きから")) {                       // 途中再開（潜行中ならその深度・街なら街）
    if (snap) { try { resumeDive(snap); if (hp <= 0) { await deathFlow(); return; } return; } catch { clearDive(); } }
    world.current!.depth = 0;
    log(`（${world.current!.name}は街にいる）`, "dim");
    await townLoop(); await startDive(); return;
  }
  if (chosen.includes("新しい物語")) {
    if (living) {                                          // 既存世界がある＝最初からやり直す（resetWorld の二重確認・確定でreload）
      await resetWorld();                                 // キャンセル時のみ下へ戻る
      await titleScreen(); return;
    }
    clearDive(); await characterCreation();               // まっさらな初回 or 死亡後の次世代
    await townLoop(); await startDive(); return;
  }
  await settingsSheet(); await titleScreen();              // 設定→タイトルへ戻る
}

async function boot() {
  loadMutePref();
  loadBgmPref();
  setBgm("title"); // タイトル/世代の始まり＝④追憶（最初の操作で鳴り始める）
  loadDpadPref();
  applyLogSize();
  applyChrome();
  buildGridDom();
  updateStatus();
  await titleScreen(); // 起動はまずタイトルへ（続きから／新しい物語／設定）。本体はここから分岐。
}
void boot();

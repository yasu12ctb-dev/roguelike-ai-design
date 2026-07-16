// 実ブラウザ E2E（PR4・v0.153.0）：余白の三注記（オンボーディング）。
//   実装は src/web/main.ts のみ（showGuideOnce/maybeIntentGuide・guide_active/guide_town_seen/guide_intent_seen/
//   guide_dodge_seen/guide_kill_seen）。強制チュートリアルやモーダルを増やさず、状況が起きた時に一度だけ
//   既存のログ cue で最小語彙を教える＝入力・手番・RNG・盤面を一切消費しない（log と world.flags のみ）。
// 検証観点：
//   (A) 新規ワールド＝街/予告/見切り/撃破の各注記が一度ずつ出る
//   (B) 再表示なし＝同条件を繰り返しても再出しない／リロードでも再出しない（potential gap 調査済み＝毎手
//       saveDive() は潜行スナップショット[DIVE_KEY]のみだが、endTurn 内で await する handleLevelUps() が
//       レベルアップの有無に関わらず末尾で必ず save()［世界全体＝SAVE_KEY・guide_* flags 含む］を呼ぶため、
//       実際には毎手 world.flags が永続化されている＝reload でも再出しないことを実測で確認する）
//   (C) 既存セーブ（guide_active 無し）＝注記が一切出ない＋JS例外0
//   (D) 非干渉の裏取り＝同一キャラ・同一操作で注記 on/off の盤面(HP/敵HP/敵intent/@位置)が一致することを確認
//   (E) 390×844 でログ・D-pad・タブバーが重ならない
// __hazTest フック（"sekitsui.dbg"="1"）で盤面を制御して決定論検証。ローカル専用（CI外・playwright は package.json に入れない規約）。
import { chromium } from "playwright";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { join, extname } from "node:path";

const WEB_DIR = new URL("../web/", import.meta.url).pathname;
const PORT = 43700 + Math.floor(Math.random() * 900);
const EXEC = "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
const MIME = { ".html": "text/html", ".js": "text/javascript", ".json": "application/json", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png", ".webmanifest": "application/manifest+json" };

const server = createServer(async (req, res) => {
  try {
    const url = (req.url || "/").split("?")[0];
    const file = url === "/" ? "index.html" : url;
    const body = await readFile(join(WEB_DIR, file));
    res.writeHead(200, { "Content-Type": MIME[extname(file)] || "text/html" });
    res.end(body);
  } catch { res.writeHead(404); res.end("nf"); }
});
await new Promise((r) => server.listen(PORT, r));

const results = [];
const ok = (name, cond, extra = "") => { results.push({ name, pass: !!cond, extra }); console.log(`${cond ? "✅" : "❌"} ${name}${extra ? "  " + extra : ""}`); };
const note = (msg) => { console.log(`ℹ️  ${msg}`); };

const SAVE_KEY = "sekitsui.world.v0";
const url = `http://localhost:${PORT}/`;

const browser = await chromium.launch({ headless: true, executablePath: EXEC, args: ["--no-sandbox"] });

// ── ページ生成ヘルパ：新規コンテキスト（dbg=1 を先に立ててからロード＝window.__hazTest を有効化）。
async function newPage(viewport = { width: 480, height: 900 }) {
  const ctx = await browser.newContext({ viewport, serviceWorkers: "block" });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push("pageerror: " + (e.message || e)));
  page.on("console", (m) => { if (m.type() === "error") errors.push("console.error: " + m.text()); });
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await page.evaluate(() => { try { localStorage.clear(); localStorage.setItem("sekitsui.dbg", "1"); } catch {} });
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(400);
  return { ctx, page, errors };
}

// タイトル→（新しい物語 or 続きから）→（難易度=easy・新規のみ）→名前→intro3枚 を消化して「街」で止める
// （潜行はしない＝forceDive は呼び出し側が明示的に行う）。
async function reachTown(page) {
  for (let i = 0; i < 100; i++) {
    const st = await page.evaluate(() => ({
      title: !!document.querySelector("#title")?.classList.contains("show"),
      titleBtns: [...document.querySelectorAll("#titleMenu button")].map((b) => (b.textContent || "").trim()),
      shown: !!document.querySelector("#overlay")?.classList.contains("show"),
      hasInput: !!document.querySelector("#sheetInputRow")?.classList.contains("show"),
      meta: document.querySelector("#sheetMeta")?.textContent || "",
      btns: [...document.querySelectorAll("#sheetButtons button")].map((b) => (b.textContent || "").trim()),
      mode: (window).__hazTest?.state?.().mode ?? null,
    }));
    if (st.mode === "town" && !st.shown && !st.title) return true;
    if (st.title) {
      // reachTown は常にクリアな localStorage から呼ぶ前提（既存セーブの再開は reachContinue が別途担当）＝
      // 「新しい物語をはじめる」（または起動直後の「触れて」ゲート）を選べばよい。
      const idx = Math.max(0, st.titleBtns.findIndex((t) => /物語|はじま|触れて/.test(t)));
      await page.locator("#titleMenu button").nth(idx).click({ timeout: 3000 }).catch(() => {});
      await page.waitForTimeout(150); continue;
    }
    if (st.shown) {
      if (st.hasInput) await page.fill("#sheetInput", "検証者").catch(() => {});
      if (/難易度/.test(st.meta)) { const di = st.btns.findIndex((t) => /やさし|easy|安|快適/i.test(t)); await page.locator("#sheetButtons button").nth(di >= 0 ? di : 0).click().catch(() => {}); await page.waitForTimeout(150); continue; }
      await page.locator("#sheetButtons button").nth(0).click().catch(() => {}); await page.waitForTimeout(150); continue;
    }
    await page.waitForTimeout(80);
  }
  return false;
}
// 「続きから」だけを選んで町/潜行いずれかへ復帰（reload 後の再開専用・intro/難易度は出ない前提）。
async function reachContinue(page) {
  for (let i = 0; i < 100; i++) {
    const st = await page.evaluate(() => ({
      title: !!document.querySelector("#title")?.classList.contains("show"),
      titleBtns: [...document.querySelectorAll("#titleMenu button")].map((b) => (b.textContent || "").trim()),
      shown: !!document.querySelector("#overlay")?.classList.contains("show"),
      mode: (window).__hazTest?.state?.().mode ?? null,
    }));
    if (!st.shown && !st.title && (st.mode === "town" || st.mode === "dive")) return true;
    if (st.title) {
      const idx = Math.max(0, st.titleBtns.findIndex((t) => /続き|触れて/.test(t)));
      await page.locator("#titleMenu button").nth(idx).click({ timeout: 3000 }).catch(() => {});
      await page.waitForTimeout(150); continue;
    }
    if (st.shown) { await page.locator("#sheetButtons button").nth(0).click().catch(() => {}); await page.waitForTimeout(150); continue; }
    await page.waitForTimeout(80);
  }
  return false;
}
async function getLogs(page) {
  return page.evaluate(() => [...document.querySelectorAll("#log > div")].map((d) => ({ text: d.textContent || "", cls: d.className || "" })));
}
async function readFlags(page) {
  return page.evaluate((k) => { try { const w = JSON.parse(localStorage.getItem(k) || "null"); return w?.flags ?? null; } catch { return null; } }, SAVE_KEY);
}
const countText = (logs, text) => logs.filter((l) => l.text === text).length;

// 各注記の正確な文言（main.ts のログ文と一致させる＝実装の言い換えを見逃さない）。
const TXT_A = "金の @ はお前だ。方向パッドで歩き、青白い『>』――迷宮の口へ。";
const TXT_B = "敵の赤い印は、次の一手。印の外へ退けば見切れる。敵のいる方へ踏み込めば攻撃する。";
const TXT_C1 = "いま反撃の好機――敵へ踏み込め。";
const TXT_C2 = "静けさが戻る。地図で『>』を探せば、次の層へ続く。";

// 5x5 の開けたアリーナを @ の周囲に作る（決定論・盤面は完全に制御下）。
async function openArena(page, hp = 60) {
  await page.evaluate((hpv) => {
    const t = (window).__hazTest;
    t.clearMons();
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) t.setTile(dx, dy, 1);
    t.setHp(hpv);
  }, hp);
}

// ============================================================
// ctxA：新規ワールド（guide_active あり）＝ A/B/C-1/C-2 と再表示なし・reload の検証
// ============================================================
const A = await newPage();
ok("[準備] ctxA 起動", true);
const reachedTown = await reachTown(A.page);
ok("[準備] ctxA：街まで到達", reachedTown);

// ── (A) 新規ワールド：導入直後の街注記
const logsTown = await getLogs(A.page);
const flagsTown = await readFlags(A.page);
ok("A: 街注記が一度だけログに出た（cue）", countText(logsTown, TXT_A) === 1 && logsTown.some((l) => l.text === TXT_A && l.cls === "cue"), `count=${countText(logsTown, TXT_A)}`);
ok("A: world.flags に guide_active/guide_town_seen が永続化（characterCreation の save()）", Array.isArray(flagsTown) && flagsTown.includes("guide_active") && flagsTown.includes("guide_town_seen"), JSON.stringify(flagsTown));

// 後段の (C)/(D) 用に「街に着いた直後（guide_active あり・未潜行）」の世界を丸ごと複製しておく。
const savedWorldAtTown = await A.page.evaluate((k) => localStorage.getItem(k), SAVE_KEY);

// 潜行開始（__hazTest.forceDive）。
const dove = await A.page.evaluate(() => (window).__hazTest?.forceDive?.());
await A.page.waitForTimeout(300);
ok("[準備] ctxA：潜行(dive)へ到達", dove && (await A.page.evaluate(() => (window).__hazTest?.state?.().mode)) === "dive");

// ── (B) 予告注記：隣接する攻撃意図の敵を配置→一手経過で発火。
await openArena(A.page, 60);
const stateOn_B = await A.page.evaluate(async () => {
  const t = (window).__hazTest;
  t.spawnKind(1, 0, "rat", 6); // 隣接＝spawnKind 内の planMonsters が即 attack intent を立てる
  const hpBefore = t.getHp();
  await new Promise((r) => { t.step(); setTimeout(r, 240); }); // 敵の手番解決→再計画→maybeIntentGuide()
  return { hpBefore, hpAfter: t.getHp(), mon: t.monAt(1, 0), playerPos: t.playerAt() };
});
let logsB = await getLogs(A.page);
ok("B: 予告注記が一度だけログに出た（cue）", countText(logsB, TXT_B) === 1 && logsB.some((l) => l.text === TXT_B && l.cls === "cue"), `count=${countText(logsB, TXT_B)}`);
ok("B: 手番・盤面は消費された（敵が実際に行動した＝注記が手番を奪っていない）", stateOn_B.hpAfter <= stateOn_B.hpBefore, `hp ${stateOn_B.hpBefore}→${stateOn_B.hpAfter}`);

// ── (B) 再表示なし：同条件を繰り返しても再出しない（同一セッション内）。
await A.page.evaluate(async () => {
  const t = (window).__hazTest;
  t.clearMons();
  for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) t.setTile(dx, dy, 1);
  t.setHp(60);
  t.spawnKind(1, 0, "rat", 6);
  await new Promise((r) => { t.step(); setTimeout(r, 240); });
});
logsB = await getLogs(A.page);
ok("B: 再表示なし（同条件を繰り返しても cue は1回のまま・同一セッション内）", countText(logsB, TXT_B) === 1, `count=${countText(logsB, TXT_B)}`);

// ── (C-1) 見切り注記：敵の予告マスから手番を消費せず退く→見切り（dodge）成立で発火。
await openArena(A.page, 60);
const stateOn_C1 = await A.page.evaluate(async () => {
  const t = (window).__hazTest;
  t.spawnKind(1, 0, "rat", 6); // 東隣接＝予告は現在の@位置を狙う
  t.movePlayer(-1, 0);        // 手番を消費せず西へ退く＝予告マスが空く
  const hpBefore = t.getHp();
  await new Promise((r) => { t.step(); setTimeout(r, 240); }); // 予告解決＝見切り（dodge）
  return { hpBefore, hpAfter: t.getHp(), mon: t.monAt(2, 0), playerPos: t.playerAt() }; // 敵は「移動」でなく「攻撃」を空振りしただけ＝この一手では位置不変（元の東隣接＝新@から見て+2,0）
});
let logsC1 = await getLogs(A.page);
ok("C-1: 見切り成立で無傷（dodge が成立した検証の裏取り）", stateOn_C1.hpAfter === stateOn_C1.hpBefore, `hp ${stateOn_C1.hpBefore}→${stateOn_C1.hpAfter}`);
ok("C-1: 見切り注記が一度だけログに出た（cue）", countText(logsC1, TXT_C1) === 1 && logsC1.some((l) => l.text === TXT_C1 && l.cls === "cue"), `count=${countText(logsC1, TXT_C1)}`);

// ── (C-1) 再表示なし。
await A.page.evaluate(async () => {
  const t = (window).__hazTest;
  t.clearMons();
  for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) t.setTile(dx, dy, 1);
  t.setHp(60);
  t.spawnKind(1, 0, "rat", 6);
  t.movePlayer(-1, 0);
  await new Promise((r) => { t.step(); setTimeout(r, 240); });
});
logsC1 = await getLogs(A.page);
ok("C-1: 再表示なし（同条件を繰り返しても cue は1回のまま）", countText(logsC1, TXT_C1) === 1, `count=${countText(logsC1, TXT_C1)}`);

// ── (C-2) 撃破注記：非ボスを討つと発火（dive 限定）。
await openArena(A.page, 60);
const stateOn_C2 = await A.page.evaluate(async () => {
  const t = (window).__hazTest;
  t.spawnKind(1, 0, "rat", 1); // 隣接・低HP＝一撃で討てる
  const before = t.getHp();
  await new Promise((r) => { t.bump(1, 0); setTimeout(r, 240); }); // 近接で仕留める（一手＝downOrKill 経由）
  return { hpAfter: t.getHp(), hpBefore: before, monGone: t.monAt(1, 0) === null, playerPos: t.playerAt() };
});
let logsC2 = await getLogs(A.page);
ok("C-2: 対象を撃破した（monAt が null）", stateOn_C2.monGone);
ok("C-2: 撃破注記が一度だけログに出た（cue）", countText(logsC2, TXT_C2) === 1 && logsC2.some((l) => l.text === TXT_C2 && l.cls === "cue"), `count=${countText(logsC2, TXT_C2)}`);

// ── (C-2) 再表示なし。
await A.page.evaluate(async () => {
  const t = (window).__hazTest;
  t.clearMons();
  for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) t.setTile(dx, dy, 1);
  t.setHp(60);
  t.spawnKind(1, 0, "rat", 1);
  await new Promise((r) => { t.bump(1, 0); setTimeout(r, 240); });
});
logsC2 = await getLogs(A.page);
ok("C-2: 再表示なし（同条件を繰り返しても cue は1回のまま）", countText(logsC2, TXT_C2) === 1, `count=${countText(logsC2, TXT_C2)}`);

const preReloadCounts = { B: countText(logsB, TXT_B), C1: countText(logsC1, TXT_C1), C2: countText(logsC2, TXT_C2) };

// ── (B) リロード（続きから）でも再出しないこと。
// guide_town_seen/guide_active は characterCreation の save() で SAVE_KEY に永続化済み＝街の注記Aは
// characterCreation 経路でしか呼ばれない（構造上、続きから経路では二度と呼ばれない）ため冪等は自明。
// guide_intent_seen/guide_dodge_seen/guide_kill_seen は endTurn() 自体は saveDive()（DIVE_KEY のみ）しか
// 呼ばないが、endTurn が await する handleLevelUps() がレベルアップの有無に関わらず末尾で無条件に
// save()（世界全体＝SAVE_KEY）を呼ぶため、実際には毎手 world.flags ごと永続化されている（動的トレースで
// 確認済み：monkeypatch した Storage.prototype.setItem のスタックトレースが handleLevelUps 経由を指した）。
// 以下はその実測での裏取り＝リロード→続きから→同条件を再現して cue が再出しないことを確認する。
const flagsBeforeReload = await readFlags(A.page);
note(`reload 前の SAVE_KEY.flags（潜行中フラグの永続状況の裏取り）＝ ${JSON.stringify(flagsBeforeReload)}`);
await A.page.reload({ waitUntil: "domcontentloaded" });
await A.page.waitForTimeout(400);
const resumed = await reachContinue(A.page);
ok("[準備] ctxA：reload→「続きから」で復帰", resumed);
const flagsAfterReload = await readFlags(A.page);
ok("B/reload: guide_active/guide_town_seen は reload 後も維持（characterCreation save() 済み）", Array.isArray(flagsAfterReload) && flagsAfterReload.includes("guide_active") && flagsAfterReload.includes("guide_town_seen"), JSON.stringify(flagsAfterReload));
const logsAfterReloadImmediate = await getLogs(A.page);
ok("B/reload: 街注記Aが reload 直後に再出しない（続きから経路は characterCreation を通らない）", countText(logsAfterReloadImmediate, TXT_A) === 0, `count=${countText(logsAfterReloadImmediate, TXT_A)}`);

// reload 後、同条件（隣接attack）を再現して guide_intent_seen が再出するか確認。
await openArena(A.page, 60);
await A.page.evaluate(async () => {
  const t = (window).__hazTest;
  t.spawnKind(1, 0, "rat", 6);
  await new Promise((r) => { t.step(); setTimeout(r, 240); });
});
const logsAfterReloadB = await getLogs(A.page);
const countB_afterReload = countText(logsAfterReloadB, TXT_B);
ok("B/reload: 予告注記は reload 後も再出しない（handleLevelUps() の毎手 save() で guide_intent_seen が永続化されている）", countB_afterReload === 0, `count=${countB_afterReload}`);

// reload 後、同条件（見切り）を再現して guide_dodge_seen が再出するか確認。
await openArena(A.page, 60);
await A.page.evaluate(async () => {
  const t = (window).__hazTest;
  t.spawnKind(1, 0, "rat", 6);
  t.movePlayer(-1, 0);
  await new Promise((r) => { t.step(); setTimeout(r, 240); });
});
const logsAfterReloadC1 = await getLogs(A.page);
const countC1_afterReload = countText(logsAfterReloadC1, TXT_C1);
ok("C-1/reload: 見切り注記は reload 後も再出しない", countC1_afterReload === 0, `count=${countC1_afterReload}`);

// reload 後、同条件（撃破）を再現して guide_kill_seen が再出するか確認。
await openArena(A.page, 60);
await A.page.evaluate(async () => {
  const t = (window).__hazTest;
  t.spawnKind(1, 0, "rat", 1);
  await new Promise((r) => { t.bump(1, 0); setTimeout(r, 240); });
});
const logsAfterReloadC2 = await getLogs(A.page);
const countC2_afterReload = countText(logsAfterReloadC2, TXT_C2);
ok("C-2/reload: 撃破注記は reload 後も再出しない", countC2_afterReload === 0, `count=${countC2_afterReload}`);

// ── (E) レイアウト：390×844 でログ・D-pad・タブバーが重ならない。
await A.page.setViewportSize({ width: 390, height: 844 });
await A.page.waitForTimeout(200);
const rects = await A.page.evaluate(() => {
  const r = (sel) => { const el = document.querySelector(sel); if (!el) return null; const b = el.getBoundingClientRect(); const shown = el.classList.contains("show"); return { shown, top: b.top, bottom: b.bottom, left: b.left, right: b.right, w: b.width, h: b.height }; };
  return { log: r("#log"), dpad: r("#dpad"), tabbar: r("#tabbar") };
});
const rectsOverlap = (a, b) => !(a.right <= b.left || a.left >= b.right || a.bottom <= b.top || a.top >= b.bottom);
ok("E: #log が表示されている（390×844）", !!rects.log, JSON.stringify(rects.log));
ok("E: #dpad が表示されている（390×844・既定オン）", !!rects.dpad && rects.dpad.shown, JSON.stringify(rects.dpad));
ok("E: #tabbar が表示されている（390×844）", !!rects.tabbar && rects.tabbar.shown, JSON.stringify(rects.tabbar));
if (rects.log && rects.dpad) ok("E: #log と #dpad は重ならない", !rectsOverlap(rects.log, rects.dpad), JSON.stringify({ log: rects.log, dpad: rects.dpad }));
if (rects.log && rects.tabbar) ok("E: #log と #tabbar は重ならない", !rectsOverlap(rects.log, rects.tabbar), JSON.stringify({ log: rects.log, tabbar: rects.tabbar }));
if (rects.dpad && rects.tabbar) ok("E: #dpad と #tabbar は重ならない", !rectsOverlap(rects.dpad, rects.tabbar), JSON.stringify({ dpad: rects.dpad, tabbar: rects.tabbar }));

ok("ctxA：例外・console.error ゼロ", A.errors.length === 0, A.errors.slice(0, 5).join(" | "));

// ============================================================
// ctxB：既存セーブ相当（guide_active 無し）＝ (C) の検証 ＋ (D) の対照サンプル
//   savedWorldAtTown（街到着直後・guide_active あり）を複製し、guide_* フラグだけを剥がして注入。
//   guide_active は maybeIntro() 内でしか付与されず、intro_seen は既に立っている（＝street再演もされない）ので、
//   これは「PR4以前からの既存セーブが二度と guide_active を得ない」という実際の挙動を正確に模している。
// ============================================================
const B = await newPage();
await B.page.evaluate((raw) => {
  try {
    localStorage.clear();
    localStorage.setItem("sekitsui.dbg", "1");
    const w = JSON.parse(raw);
    w.flags = (w.flags || []).filter((f) => !String(f).startsWith("guide_"));
    localStorage.setItem("sekitsui.world.v0", JSON.stringify(w));
  } catch (e) { throw e; }
}, savedWorldAtTown);
await B.page.goto(url, { waitUntil: "domcontentloaded" });
await B.page.waitForTimeout(400);
const flagsLegacy = await readFlags(B.page);
ok("[準備] ctxB：guide_* を剥がした「既存セーブ」を注入", Array.isArray(flagsLegacy) && !flagsLegacy.some((f) => String(f).startsWith("guide_")) && flagsLegacy.includes("intro_seen"), JSON.stringify(flagsLegacy));
const reachedTownB = await reachContinue(B.page);
ok("[準備] ctxB：「続きから」で街へ復帰（既存セーブ扱い）", reachedTownB);
const logsTownB = await getLogs(B.page);
ok("C: 既存セーブ＝街注記が一切出ない", countText(logsTownB, TXT_A) === 0, `count=${countText(logsTownB, TXT_A)}`);

const doveB = await B.page.evaluate(() => (window).__hazTest?.forceDive?.());
await B.page.waitForTimeout(300);
ok("[準備] ctxB：潜行(dive)へ到達", doveB && (await B.page.evaluate(() => (window).__hazTest?.state?.().mode)) === "dive");

// (C) 予告シナリオ：既存セーブでは出ない ＋ (D) 対照：注記ありの stateOn_B と盤面が一致するか。
await openArena(B.page, 60);
const stateOff_B = await B.page.evaluate(async () => {
  const t = (window).__hazTest;
  t.spawnKind(1, 0, "rat", 6);
  const hpBefore = t.getHp();
  await new Promise((r) => { t.step(); setTimeout(r, 240); });
  return { hpBefore, hpAfter: t.getHp(), mon: t.monAt(1, 0), playerPos: t.playerAt() };
});
const logsOffB = await getLogs(B.page);
ok("C: 既存セーブ＝予告注記が一切出ない", countText(logsOffB, TXT_B) === 0, `count=${countText(logsOffB, TXT_B)}`);

// (C) 見切りシナリオ：既存セーブでは出ない ＋ (D) 対照。
await openArena(B.page, 60);
const stateOff_C1 = await B.page.evaluate(async () => {
  const t = (window).__hazTest;
  t.spawnKind(1, 0, "rat", 6);
  t.movePlayer(-1, 0);
  const hpBefore = t.getHp();
  await new Promise((r) => { t.step(); setTimeout(r, 240); });
  return { hpBefore, hpAfter: t.getHp(), playerPos: t.playerAt() };
});
const logsOffC1 = await getLogs(B.page);
ok("C: 既存セーブ＝見切り注記が一切出ない", countText(logsOffC1, TXT_C1) === 0, `count=${countText(logsOffC1, TXT_C1)}`);

// (C) 撃破シナリオ：既存セーブでは出ない ＋ (D) 対照。
await openArena(B.page, 60);
const stateOff_C2 = await B.page.evaluate(async () => {
  const t = (window).__hazTest;
  t.spawnKind(1, 0, "rat", 1);
  const before = t.getHp();
  await new Promise((r) => { t.bump(1, 0); setTimeout(r, 240); });
  return { hpAfter: t.getHp(), hpBefore: before, monGone: t.monAt(1, 0) === null, playerPos: t.playerAt() };
});
const logsOffC2 = await getLogs(B.page);
ok("C: 既存セーブ＝撃破注記が一切出ない", countText(logsOffC2, TXT_C2) === 0, `count=${countText(logsOffC2, TXT_C2)}`);

ok("ctxB（既存セーブ）：例外・console.error ゼロ", B.errors.length === 0, B.errors.slice(0, 5).join(" | "));

// ── (D) 非干渉の裏取り：同一キャラ・同一操作で、注記あり(ctxA)/なし(ctxB) の盤面・敵状態・HPが一致するか。
//   showGuideOnce は world.flags への push と log() 呼び出ししか行わない（コード上も RNG/盤面 API には触れない）。
//   ここでは実測でそれを裏取りする＝一致すれば「log/flags 以外に副作用がない」ことの実証になる。
ok("D: 予告シナリオ＝HP推移が on/off で一致", stateOn_B.hpBefore === stateOff_B.hpBefore && stateOn_B.hpAfter === stateOff_B.hpAfter, `on ${stateOn_B.hpBefore}→${stateOn_B.hpAfter} / off ${stateOff_B.hpBefore}→${stateOff_B.hpAfter}`);
ok("D: 予告シナリオ＝敵状態・@位置が on/off で一致", JSON.stringify(stateOn_B.mon) === JSON.stringify(stateOff_B.mon) && JSON.stringify(stateOn_B.playerPos) === JSON.stringify(stateOff_B.playerPos), `mon on=${JSON.stringify(stateOn_B.mon)} off=${JSON.stringify(stateOff_B.mon)}`);
ok("D: 見切りシナリオ＝HP推移（無傷）が on/off で一致", stateOn_C1.hpBefore === stateOff_C1.hpBefore && stateOn_C1.hpAfter === stateOff_C1.hpAfter, `on ${stateOn_C1.hpBefore}→${stateOn_C1.hpAfter} / off ${stateOff_C1.hpBefore}→${stateOff_C1.hpAfter}`);
ok("D: 見切りシナリオ＝@位置が on/off で一致", JSON.stringify(stateOn_C1.playerPos) === JSON.stringify(stateOff_C1.playerPos), `on=${JSON.stringify(stateOn_C1.playerPos)} off=${JSON.stringify(stateOff_C1.playerPos)}`);
ok("D: 撃破シナリオ＝撃破結果・HPが on/off で一致", stateOn_C2.monGone === stateOff_C2.monGone && stateOn_C2.hpAfter === stateOff_C2.hpAfter, `on gone=${stateOn_C2.monGone} hp=${stateOn_C2.hpAfter} / off gone=${stateOff_C2.monGone} hp=${stateOff_C2.hpAfter}`);

await A.ctx.close();
await B.ctx.close();
await browser.close();
server.close();

console.log("\n--- 補足（reload 前の同一セッション内カウント・全て1回であるべき） ---");
console.log(JSON.stringify(preReloadCounts));

const failed = results.filter((r) => !r.pass);
console.log(`\n=== E2E 余白の三注記（オンボーディング）：${results.length - failed.length}/${results.length} pass ===`);
if (failed.length) { console.log("FAILED:", failed.map((f) => f.name).join(", ")); process.exit(1); }

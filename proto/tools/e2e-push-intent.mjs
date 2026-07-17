// 実ブラウザ E2E（バグ2 受入検証・2026-07-17）：pushEnemy の「相殺防止」修正（web/main.ts）を検証する。
//
// バグ2：敵を相対移動（clear 分岐）で押し出しても、敵の“古い move 予告”（押し出し前に @ へ接近する destination で
//   計算済みの queued intent）が残ったままだと、直後の endTurn 内 resolveMonsters がその stale な move を適用し、
//   押し出した座標を上書きしてしまう（距離2の敵を巻き込む薙刀の会心押し出しが狙った方向へ飛ばない体感バグ）。
// 修正：pushEnemy の clear 分岐で `mon.hp>0 && mon.intent?.type==="move"` なら `mon.intent={type:"wait"}` にする。
//
// 本テストは既存 tools/e2e-weapon-parity.mjs の MECH-1a シナリオと**同一の盤面**を使うが、
// ★clearIntent は使わない（＝実挙動をそのまま観測する＝タスク指示どおり）。
// 旧 e2e-weapon-parity.mjs の m1aRaw（clearIntentなし参考記録・pass/fail対象外だった）を、
// 本スクリプトでは正式な assert に格上げする＝「押し出し方向（@から離れる向き・距離3）に着地し、
// resolveMonsters 後もその位置が維持される」ことを検証する。
//
// ローカル専用（CI外・playwright は package.json に入れない規約）。
import { chromium } from "playwright";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { join, extname } from "node:path";

const WEB_DIR = new URL("../web/", import.meta.url).pathname;
const PORT = 42890 + Math.floor(Math.random() * 900);
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

const browser = await chromium.launch({ headless: true, executablePath: EXEC, args: ["--no-sandbox"] });
const ctx = await browser.newContext({ viewport: { width: 480, height: 900 }, serviceWorkers: "block" });
const page = await ctx.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push("pageerror: " + (e.message || e)));
page.on("console", (m) => { if (m.type() === "error") errors.push("console.error: " + m.text()); });

const url = `http://localhost:${PORT}/`;
await page.goto(url, { waitUntil: "domcontentloaded" });
await page.evaluate(() => { try { localStorage.clear(); localStorage.setItem("sekitsui.dbg", "1"); } catch {} });
await page.goto(url, { waitUntil: "domcontentloaded" });
await page.waitForTimeout(400);

async function reachTownThenDive() {
  for (let i = 0; i < 80; i++) {
    const st = await page.evaluate(() => ({
      title: !!document.querySelector("#title")?.classList.contains("show"),
      titleBtns: [...document.querySelectorAll("#titleMenu button")].map((b) => (b.textContent || "").trim()),
      shown: !!document.querySelector("#overlay")?.classList.contains("show"),
      hasInput: !!document.querySelector("#sheetInputRow")?.classList.contains("show"),
      meta: document.querySelector("#sheetMeta")?.textContent || "",
      btns: [...document.querySelectorAll("#sheetButtons button")].map((b) => (b.textContent || "").trim()),
      mode: (window).__hazTest?.state?.().mode ?? null,
      hasChar: (window).__hazTest ? true : false,
    }));
    if (st.mode === "dive") return true;
    if (!st.shown && !st.title && (st.mode === "town" || st.mode === "interior")) {
      const ok2 = await page.evaluate(() => (window).__hazTest?.forceDive?.());
      if (ok2) { await page.waitForTimeout(300); const m = await page.evaluate(() => (window).__hazTest?.state?.().mode); if (m === "dive") return true; }
    }
    if (st.title) {
      const idx = Math.max(0, st.titleBtns.findIndex((t) => /物語|続き|はじま|触れて/.test(t)));
      await page.locator("#titleMenu button").nth(idx).click({ timeout: 3000 }).catch(() => {});
      await page.waitForTimeout(120); continue;
    }
    if (st.shown) {
      if (st.hasInput) await page.fill("#sheetInput", "検証者").catch(() => {});
      if (/難易度/.test(st.meta)) { const di = st.btns.findIndex((t) => /やさし|easy|安|快適/i.test(t)); await page.locator("#sheetButtons button").nth(di >= 0 ? di : 0).click().catch(() => {}); await page.waitForTimeout(120); continue; }
      await page.locator("#sheetButtons button").nth(0).click().catch(() => {});
      await page.waitForTimeout(120); continue;
    }
    await page.waitForTimeout(80);
  }
  return false;
}
const inDive = await reachTownThenDive();
ok("潜行(dive)へ到達", inDive);

// 「上」入力＝bump(0,-1) 基準の距離2バー座標（薙刀 v0.150.0 の geometry・既存 e2e-weapon-parity.mjs / e2e-guard-stagger.mjs と同一）。
const NAG_OPEN = [[0, -1], [0, -2], [1, -2], [-1, -2], [0, -3], [2, -3], [-2, -3], [1, 0], [-1, 0], [0, 1]];

// 同一シナリオを複数回（安定性確認）走らせる：clearIntent を使わず、spawn直後の自然な queued intent（"move"＝@へ接近）の
// ままで、会心の薙ぎ→押し出しを行い、resolveMonsters（同一 endTurn 内で直後に実行される敵の手番）後の座標を検証する。
async function runOnce(open) {
  return await page.evaluate(async (open) => {
    const t = (window).__hazTest;
    t.giveWeapon("大薙刀");
    t.clearMons();
    for (const [dx, dy] of open) t.setTile(dx, dy, 1);
    t.setHp(80);
    t.spawnMon(0, -2, 60);  // 中央（距離2直線）＝spawn直後の queued intent は通常 "move"（@へ接近）
    t.spawnMon(1, -2, 60);  // 肩・右
    t.spawnMon(-1, -2, 60); // 肩・左
    const centerIntentBefore = t.monAt(0, -2)?.intent ?? null; // 修正の前提＝押し出し前は "move" が積まれていること
    t.setCounter(2); // 会心確定
    await new Promise((r) => { t.bump(0, -1); setTimeout(r, 240); });
    return {
      counterAfter: t.state().counterTurns,
      centerIntentBefore,
      // 押し出し方向（@から離れる向き・距離3）＝(0,-3)
      centerAtPushDest: t.monAt(0, -3),
      // 修正前の症状＝@へ1歩戻る（stale move intent が resolveMonsters で解決され、押し出し前の接近先へ上書きされる）
      centerAtOneStepCloser: t.monAt(0, -1),
      // 押し出し前の距離2位置に取り残されていないか（何も起きなかった場合の検出）
      centerStillAtOrigin: t.monAt(0, -2),
      rightAtPushDest: t.monAt(2, -3),
      leftAtPushDest: t.monAt(-2, -3),
    };
  }, open);
}

const RUNS = 5;
let allPass = true;
for (let i = 0; i < RUNS; i++) {
  const r = await runOnce(NAG_OPEN);
  const centerOk = r.centerAtPushDest !== null && r.centerAtOneStepCloser === null && r.centerStillAtOrigin === null;
  const shoulderOk = r.rightAtPushDest !== null && r.leftAtPushDest !== null;
  const critOk = r.counterAfter === 0;
  const preconditionOk = r.centerIntentBefore === "move"; // 修正が意味を持つための前提（stale move intent が実在した）
  ok(`run${i + 1}: 前提＝押し出し前の中央の queued intent は "move"`, preconditionOk, `intent=${r.centerIntentBefore}`);
  ok(`run${i + 1}: 中央が押し出し方向(@から離れる・距離3)に着地し維持される`, centerOk, JSON.stringify(r));
  ok(`run${i + 1}: 肩(左右)も押し出し方向に着地し維持される`, shoulderOk, JSON.stringify({ right: r.rightAtPushDest, left: r.leftAtPushDest }));
  ok(`run${i + 1}: counterTurns は会心で消費される(→0)`, critOk, `counter=${r.counterAfter}`);
  if (!(centerOk && shoulderOk && critOk && preconditionOk)) allPass = false;
}
ok(`${RUNS}回連続で安定して pass する`, allPass);

ok("例外・console.error ゼロ", errors.length === 0, errors.slice(0, 5).join(" | "));

await browser.close();
server.close();

const failed = results.filter((r) => !r.pass);
console.log(`\n=== E2E push-intent（バグ2受入）：${results.length - failed.length}/${results.length} pass ===`);
if (failed.length) { console.log("FAILED:", failed.map((f) => f.name).join(", ")); process.exit(1); }

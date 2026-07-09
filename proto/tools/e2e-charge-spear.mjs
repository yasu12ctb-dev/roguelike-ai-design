// 実ブラウザ E2E（フェーズ1・v0.141.0）：①槍の距離1ダメージ減衰／②突進する敵（カイト封じ）。
// __hazTest フック（"sekitsui.dbg"="1"）で盤面を制御して決定論検証。ローカル専用（CI外・playwrightはpackage.jsonに入れない規約）。
import { chromium } from "playwright";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { join, extname } from "node:path";

const WEB_DIR = new URL("../web/", import.meta.url).pathname;
const PORT = 42600 + Math.floor(Math.random() * 900);
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
const ok = (name, cond, extra = "") => { results.push({ name, pass: !!cond }); console.log(`${cond ? "✅" : "❌"} ${name}${extra ? "  " + extra : ""}`); };

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

async function reachDive() {
  for (let i = 0; i < 80; i++) {
    const st = await page.evaluate(() => ({
      title: !!document.querySelector("#title")?.classList.contains("show"),
      titleBtns: [...document.querySelectorAll("#titleMenu button")].map((b) => (b.textContent || "").trim()),
      shown: !!document.querySelector("#overlay")?.classList.contains("show"),
      hasInput: !!document.querySelector("#sheetInputRow")?.classList.contains("show"),
      meta: document.querySelector("#sheetMeta")?.textContent || "",
      btns: [...document.querySelectorAll("#sheetButtons button")].map((b) => (b.textContent || "").trim()),
      mode: (window).__hazTest?.state?.().mode ?? null,
    }));
    if (st.mode === "dive") return true;
    if (!st.shown && !st.title && (st.mode === "town" || st.mode === "interior")) {
      const ok2 = await page.evaluate(() => (window).__hazTest?.forceDive?.());
      if (ok2) { await page.waitForTimeout(300); const m = await page.evaluate(() => (window).__hazTest?.state?.().mode); if (m === "dive") return true; }
    }
    if (st.title) { const idx = Math.max(0, st.titleBtns.findIndex((t) => /物語|続き|はじま|触れて/.test(t))); await page.locator("#titleMenu button").nth(idx).click({ timeout: 3000 }).catch(() => {}); await page.waitForTimeout(120); continue; }
    if (st.shown) {
      if (st.hasInput) await page.fill("#sheetInput", "検証者").catch(() => {});
      if (/難易度/.test(st.meta)) { const di = st.btns.findIndex((t) => /やさし|easy|安|快適/i.test(t)); await page.locator("#sheetButtons button").nth(di >= 0 ? di : 0).click().catch(() => {}); await page.waitForTimeout(120); continue; }
      await page.locator("#sheetButtons button").nth(0).click().catch(() => {}); await page.waitForTimeout(120); continue;
    }
    await page.waitForTimeout(80);
  }
  return false;
}
ok("潜行(dive)へ到達", await reachDive());

// 東方向に一直線の床を確保（距離1..5）＋周囲も床に。
async function carveEast() {
  await page.evaluate(() => { const t = (window).__hazTest; for (let k = 1; k <= 5; k++) t.setTile(k, 0, 1); t.setTile(0, 1, 1); t.setTile(0, -1, 1); });
}

// ── シナリオ1：槍の距離1減衰。距離2の与ダメ（満額）と距離1の与ダメ（減衰）を同一敵・同一武器で厳密計測。
await carveEast();
const cmp = await page.evaluate(async () => {
  const t = (window).__hazTest;
  t.giveWeapon("長槍"); t.setCounter(0);
  const HP = 99;
  // 距離2（primary=奥）：敵は (2,0) のみ。@ は動かず（前に敵がいないと前進する可能性）→ (1,0) を壁にすると前進不可で突きに専念？
  // 単純化：距離2の敵のみを置き、bump east。reach2 は「その場から突く」＝移動しない（前方に敵がいれば）。
  t.clearMons(); t.spawnKind(2, 0, "beetle", HP);
  await new Promise((r) => { t.bump(1, 0); setTimeout(r, 200); });
  const after2 = t.monAt(2, 0)?.hp ?? t.nearestMon()?.hp ?? HP;
  const dmg2 = HP - after2;
  // 距離1（primary=手前）：敵は (1,0) のみ。
  t.clearMons(); t.spawnKind(1, 0, "beetle", HP);
  await new Promise((r) => { t.bump(1, 0); setTimeout(r, 200); });
  const after1 = t.monAt(1, 0)?.hp ?? t.nearestMon()?.hp ?? HP;
  const dmg1 = HP - after1;
  return { dmg2, dmg1 };
});
ok("S1 距離2の突き（満額）でダメージが入る", cmp.dmg2 > 0, `dmg2=${cmp.dmg2}`);
ok("S1 距離1の突き（減衰）でもダメージは入る", cmp.dmg1 > 0, `dmg1=${cmp.dmg1}`);
ok("S1 距離1 < 距離2（近距離で弱い＝約半減）", cmp.dmg1 < cmp.dmg2, `dmg1=${cmp.dmg1} < dmg2=${cmp.dmg2}`);

// ── シナリオ2：突進する敵。直線3マスから突進を予告→詰めて隣接で突く。
const s2 = await page.evaluate(async () => {
  const t = (window).__hazTest;
  t.giveWeapon("長剣"); // 通常武器（槍でない）
  t.setCounter(0);
  t.clearMons();
  for (let k = 1; k <= 5; k++) t.setTile(k, 0, 1);
  t.setHp(60);
  t.spawnKind(3, 0, "charger", 20); // 距離3・直線東（spawnKind が planMonsters を呼ぶ＝突進を予告）
  const tel = t.monAt(3, 0); // 予告＝charge（attack かつ charge フラグ）
  const before = t.getHp();
  await new Promise((r) => { t.step(); setTimeout(r, 240); }); // 敵の手番＝突進実行（詰めて突く）
  const near = t.nearestMon(); // 突進で隣接まで詰めたか
  const after = t.getHp();
  return { telIntent: tel?.intent, telCharge: tel?.charge, cheb: near?.cheb, before, after, tookDmg: after < before };
});
ok("S2 突進を予告（intent=attack + charge）", s2.telIntent === "attack" && s2.telCharge === true, `intent=${s2.telIntent} charge=${s2.telCharge}`);
ok("S2 突進で隣接まで間合いを詰めた（cheb=1）", s2.cheb === 1, `cheb=${s2.cheb}`);
ok("S2 詰められて突進被弾（HP減）", s2.tookDmg, `hp ${s2.before}→${s2.after}`);

// ── シナリオ2b：突入ラインから横へ退けば空振り（だが距離は詰められる＝カイト封じ）。
const s2b = await page.evaluate(async () => {
  const t = (window).__hazTest;
  t.giveWeapon("長剣"); t.setCounter(0); t.clearMons();
  for (let k = 1; k <= 5; k++) t.setTile(k, 0, 1); t.setTile(0, 1, 1); t.setTile(1, 1, 1);
  t.setHp(60);
  t.spawnKind(3, 0, "charger", 20);
  const before = t.getHp();
  // プレイヤーが直線(東西)から外れる＝南へ1歩（突入ラインから退避）
  await new Promise((r) => { t.bump(0, 1); setTimeout(r, 240); }); // 南へ移動＝この手で敵も突進を実行
  const after = t.getHp();
  const near = t.nearestMon();
  return { before, after, dmg: before - after, cheb: near?.cheb };
});
ok("S2b 横へ退くと突進は空振り（被弾なし/軽微）", s2b.dmg <= 0 || s2b.dmg < 8, `dmg=${s2b.dmg}`);

ok("例外・console.error ゼロ", errors.length === 0, errors.slice(0, 5).join(" | "));

await browser.close();
server.close();
const failed = results.filter((r) => !r.pass);
console.log(`\n=== E2E 突進/槍減衰：${results.length - failed.length}/${results.length} pass ===`);
if (failed.length) { console.log("FAILED:", failed.map((f) => f.name).join(", ")); process.exit(1); }

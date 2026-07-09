// 実ブラウザ E2E（フェーズ2・v0.142.0）：③押し出しで射程外へ出したら予告一撃をキャンセル／④長柄（射程2）は1マス押しても届く。
// __hazTest フック（"sekitsui.dbg"="1"）で盤面を制御して決定論検証。ローカル専用（CI外・playwrightはpackage.jsonに入れない規約）。
import { chromium } from "playwright";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { join, extname } from "node:path";

const WEB_DIR = new URL("../web/", import.meta.url).pathname;
const PORT = 42700 + Math.floor(Math.random() * 900);
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

// ── シナリオ1：③ 押し出しで射程外（reach1 の通常敵）→ 予告一撃をキャンセル（無傷）。
const s1 = await page.evaluate(async () => {
  const t = (window).__hazTest;
  t.giveWeapon("長剣"); t.setCounter(0); t.clearMons();
  for (let k = 1; k <= 4; k++) t.setTile(k, 0, 1);
  t.setHp(50);
  t.spawnKind(1, 0, "beetle", 99); // 隣接の reach1 敵（planMonsters で攻撃を予告）
  const telBefore = t.monAt(1, 0)?.intent; // "attack"
  t.push(1, 0); // 東へ1マス押す＝(2,0) 距離2＝reach1 では届かない→キャンセル
  const telAfter = t.monAt(2, 0)?.intent; // "wait"（キャンセル）
  const before = t.getHp();
  await new Promise((r) => { t.step(); setTimeout(r, 220); }); // 敵の手番＝キャンセル済みで無攻撃
  return { telBefore, telAfter, dmg: before - t.getHp() };
});
ok("S1 reach1 敵は隣接で攻撃を予告", s1.telBefore === "attack", `intent=${s1.telBefore}`);
ok("S1 射程外へ押し出すと予告がキャンセル（wait）", s1.telAfter === "wait", `intent=${s1.telAfter}`);
ok("S1 押し出した手番は被弾なし（無傷の取引）", s1.dmg === 0, `dmg=${s1.dmg}`);

// ── シナリオ2：④ 長柄（reach2）は1マス押しても射程内→予告は温存→反撃を受ける。
const s2 = await page.evaluate(async () => {
  const t = (window).__hazTest;
  t.giveWeapon("長剣"); t.setCounter(0); t.clearMons();
  for (let k = 1; k <= 4; k++) t.setTile(k, 0, 1);
  t.setHp(50);
  t.spawnKind(1, 0, "thruster", 99); // 隣接の reach2 長柄
  t.push(1, 0); // 東へ1マス押す＝(2,0) 距離2＝reach2 では まだ届く→温存
  const telAfter = t.monAt(2, 0)?.intent; // "attack"（温存）
  const before = t.getHp();
  await new Promise((r) => { t.step(); setTimeout(r, 220); });
  return { telAfter, dmg: before - t.getHp() };
});
ok("S2 長柄は1マス押しても予告温存（attack）", s2.telAfter === "attack", `intent=${s2.telAfter}`);
ok("S2 射程内なので押しても反撃を受ける（被弾）", s2.dmg > 0, `dmg=${s2.dmg}`);

// ── シナリオ3：長柄は直線の距離2から突いてくる（遠間攻撃）。
const s3 = await page.evaluate(async () => {
  const t = (window).__hazTest;
  t.giveWeapon("長剣"); t.setCounter(0); t.clearMons();
  for (let k = 1; k <= 4; k++) t.setTile(k, 0, 1);
  t.setHp(50);
  t.spawnKind(2, 0, "thruster", 99); // 距離2・直線東（planMonsters で reach 攻撃を予告）
  const tel = t.monAt(2, 0)?.intent; // "attack"（距離2から）
  const before = t.getHp();
  await new Promise((r) => { t.step(); setTimeout(r, 220); }); // @ 不動＝距離2の突きが当たる
  return { tel, dmg: before - t.getHp() };
});
ok("S3 長柄は距離2から突きを予告", s3.tel === "attack", `intent=${s3.tel}`);
ok("S3 距離2の突きが命中（@不動）", s3.dmg > 0, `dmg=${s3.dmg}`);

ok("例外・console.error ゼロ", errors.length === 0, errors.slice(0, 5).join(" | "));

await browser.close();
server.close();
const failed = results.filter((r) => !r.pass);
console.log(`\n=== E2E 押し出しキャンセル/長柄：${results.length - failed.length}/${results.length} pass ===`);
if (failed.length) { console.log("FAILED:", failed.map((f) => f.name).join(", ")); process.exit(1); }

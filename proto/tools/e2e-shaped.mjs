// 実ブラウザ E2E（PR1・v0.145.0）：形つき予告の一般敵〈旋刃鬼(arc)/震地鬼(slam)/射抜きの眼(beam)〉。
// (1)予告 cells が複数マス描画 (2)予告マス外へ退けば無傷 (3)予告マス内に留まれば被弾 (4)beam の CD(1手おき) (5)slam の距離2回避 (6)剣/槍/薙刀の既存戦闘回帰＝例外0。
// __hazTest フック（"sekitsui.dbg"="1"）で盤面を制御して決定論検証。ローカル専用（CI外・playwright は package.json に入れない規約）。
import { chromium } from "playwright";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { join, extname } from "node:path";

const WEB_DIR = new URL("../web/", import.meta.url).pathname;
const PORT = 42800 + Math.floor(Math.random() * 900);
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

// 開けた 5x5 アリーナを @ の周囲に作る。
async function openArena() {
  await page.evaluate(() => {
    const t = (window).__hazTest;
    t.giveWeapon("長剣"); t.setCounter(0); t.clearMons(); t.setHp(80);
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) t.setTile(dx, dy, 1);
  });
}

// ── S1：旋刃鬼(arc)＝隣接で前方弧3マスを予告。cells 複数＋DOM tele-shape 描画。
await openArena();
const s1 = await page.evaluate(async () => {
  const t = (window).__hazTest;
  t.spawnKind(1, 0, "whirl", 99);
  const cells = t.cellsAt(1, 0);
  t.redraw();
  const dom = document.querySelectorAll(".cell.tele-shape").length;
  return { n: cells ? cells.length : 0, dom };
});
ok("S1 旋刃鬼(arc) は複数マスを予告（cells≥2）", s1.n >= 2, `cells=${s1.n}`);
ok("S1 予告マスが盤上に描画される（tele-shape DOM）", s1.dom >= 2, `dom=${s1.dom}`);

// ── S2：予告マス内に留まれば被弾。
const s2 = await page.evaluate(async () => {
  const t = (window).__hazTest;
  const before = t.getHp();
  await new Promise((r) => { t.step(); setTimeout(r, 220); });
  return { dmg: before - t.getHp() };
});
ok("S2 旋刃鬼の弧に留まれば被弾", s2.dmg > 0, `dmg=${s2.dmg}`);

// ── S3：弧の外（斜め後ろ）へ退けば無傷。
await openArena();
const s3 = await page.evaluate(async () => {
  const t = (window).__hazTest;
  t.spawnKind(1, 0, "whirl", 99);            // 東に隣接＝弧は @ の(0,0)/(0,±1)を覆う
  const cells = t.cellsAt(1, 0);             // 予告は @ 位置(0,0 相当)で固定
  t.movePlayer(-1, 0);                        // 西（敵と反対）へ退く＝弧の外
  const before = t.getHp();
  await new Promise((r) => { t.step(); setTimeout(r, 220); });
  return { n: cells ? cells.length : 0, dmg: before - t.getHp() };
});
ok("S3 弧の外へ退けば無傷（見切り）", s3.dmg === 0, `dmg=${s3.dmg}`);

// ── S4：震地鬼(slam)＝隣接で周囲8マスを予告（大きな範囲）。
await openArena();
const s4 = await page.evaluate(async () => {
  const t = (window).__hazTest;
  t.spawnKind(1, 0, "quaker", 99);
  const cells = t.cellsAt(1, 0);
  const before = t.getHp();
  await new Promise((r) => { t.step(); setTimeout(r, 220); });   // @ 留まる＝周囲8に含まれ被弾
  return { n: cells ? cells.length : 0, dmg: before - t.getHp() };
});
ok("S4 震地鬼(slam) は周囲8マスを予告（cells≥5）", s4.n >= 5, `cells=${s4.n}`);
ok("S4 全周撃に留まれば被弾", s4.dmg > 0, `dmg=${s4.dmg}`);

// ── S5：slam の距離2回避＝一歩離せば周囲8の外＝無傷。
await openArena();
const s5 = await page.evaluate(async () => {
  const t = (window).__hazTest;
  t.spawnKind(1, 0, "quaker", 99);            // 東に隣接で予告（@ の(0,0)を含む8マス）
  t.movePlayer(-1, 0);                         // 西へ1歩＝敵から距離2＝周囲8の外
  const before = t.getHp();
  await new Promise((r) => { t.step(); setTimeout(r, 220); });
  return { dmg: before - t.getHp() };
});
ok("S5 距離2へ離れれば全周撃を回避（無傷）", s5.dmg === 0, `dmg=${s5.dmg}`);

// ── S6：射抜きの眼(beam)＝直線を予告（複数マス）。1手おき(CD 1)で撃つ。
const s6 = await page.evaluate(async () => {
  const t = (window).__hazTest;
  t.giveWeapon("長剣"); t.setCounter(0); t.clearMons(); t.setHp(80);
  for (let k = -1; k <= 6; k++) { t.setTile(k, 0, 1); t.setTile(k, 1, 0); t.setTile(k, -1, 0); } // 東西1幅の通路（線から外れられない）
  t.spawnKind(2, 0, "piercer", 99);           // 直線東・距離2＝ビーム予告
  const cells = t.cellsAt(2, 0);
  const h0 = t.getHp();
  await new Promise((r) => { t.step(); setTimeout(r, 200); });  // 手番1：ビーム命中
  const d1 = h0 - t.getHp();
  const h1 = t.getHp();
  await new Promise((r) => { t.step(); setTimeout(r, 200); });  // 手番2：CD＝撃たない（接近のみ）
  const d2 = h1 - t.getHp();
  return { n: cells ? cells.length : 0, d1, d2 };
});
ok("S6 射抜きの眼(beam) は直線を予告（cells≥2）", s6.n >= 2, `cells=${s6.n}`);
ok("S6 通路で直線に居れば貫かれる（手番1で被弾）", s6.d1 > 0, `d1=${s6.d1}`);
ok("S6 CD＝1手おき（手番2は撃たない＝無傷）", s6.d2 === 0, `d2=${s6.d2}`);

// ── S7：既存戦闘の回帰＝剣/槍/薙刀で通常敵を殴って斃せる（例外0）。
for (const [wp, label] of [["長剣", "剣"], ["刺突槍", "槍"], ["大薙刀", "薙刀"]]) {
  const r = await page.evaluate(async ({ wp }) => {
    const t = (window).__hazTest;
    t.giveWeapon(wp); t.setCounter(0); t.clearMons(); t.setHp(80);
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) t.setTile(dx, dy, 1);
    t.spawnKind(1, 0, "rat", 3);
    const hp0 = t.monAt(1, 0)?.hp ?? -1;
    t.bump(1, 0);                                // 東の敵を殴る（槍は距離1でも突ける／薙刀は薙ぐ）
    await new Promise((res) => setTimeout(res, 220));
    const after = t.monAt(1, 0);                 // 斃れていれば null
    return { hp0, gone: after === null, afterHp: after?.hp ?? -1 };
  }, { wp });
  ok(`S7 ${label}で通常敵に有効打（斃す/削る）`, r.hp0 > 0 && (r.gone || r.afterHp < r.hp0), `hp0=${r.hp0} afterHp=${r.afterHp} gone=${r.gone}`);
}

ok("例外・console.error ゼロ", errors.length === 0, errors.slice(0, 5).join(" | "));

await browser.close();
server.close();
const failed = results.filter((r) => !r.pass);
console.log(`\n=== E2E 形つき予告の一般敵：${results.length - failed.length}/${results.length} pass ===`);
if (failed.length) { console.log("FAILED:", failed.map((f) => f.name).join(", ")); process.exit(1); }

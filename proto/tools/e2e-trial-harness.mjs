// 実ブラウザ E2E（外部レビュー PR5・試技ハーネス）：__hazTest.trial(scenario, weapon) が3シナリオ×3武器の
//   全組み合わせで例外なく起動し、以後は通常操作（bump/step）で普通に戦えることを確認する起動スモーク。
//   ローカル専用（CI外・playwright は package.json に入れない規約）。既存 e2e-guard-stagger.mjs 等と同一手法。
import { chromium } from "playwright";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { join, extname } from "node:path";

const WEB_DIR = new URL("../web/", import.meta.url).pathname;
const PORT = 41890 + Math.floor(Math.random() * 900);
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

const SCENARIOS = ["corridor", "room3", "mixed"];
const WEAPONS = ["sword", "spear", "naginata"];

for (const scenario of SCENARIOS) {
  for (const weapon of WEAPONS) {
    const errBefore = errors.length;
    const r = await page.evaluate(async ({ scenario, weapon }) => {
      const t = (window).__hazTest;
      t.setHp(200);
      const started = t.trial(scenario, weapon);
      if (!started) return { started };
      const monsCount0 = t.state().mons;
      // 起動後、通常操作（step）を数手回して普通に戦えることを確認（bump は方向依存で武器ごとに射程が異なるため、
      // ここでは「例外なく手番が進む」ことを主眼に step を用いる＝敵がいれば攻めてくる・いなければ何も起きない）。
      for (let i = 0; i < 3; i++) { t.step(); await new Promise((res) => setTimeout(res, 60)); }
      return { started, monsCount0, hpAfter: t.getHp() };
    }, { scenario, weapon });
    const newErrors = errors.slice(errBefore);
    ok(`trial(${scenario}, ${weapon}) 起動＋数手が例外なく進行`, r.started === true && newErrors.length === 0, JSON.stringify(r) + (newErrors.length ? " ERRORS: " + newErrors.join(" | ") : ""));
  }
}

// コンソールから起動できることの直接確認（page.evaluate 経由だが、ユーザーが実際に打つコマンド文字列をそのまま実行する）。
const consoleStart = await page.evaluate(() => {
  try {
    // eslint-disable-next-line no-eval
    const r = (0, eval)('window.__hazTest.trial("corridor","spear")');
    return { ok: r === true };
  } catch (e) { return { ok: false, err: String(e) }; }
});
ok("コンソールから __hazTest.trial(\"corridor\",\"spear\") で起動できる", consoleStart.ok === true, JSON.stringify(consoleStart));

ok("例外・console.error ゼロ（全体）", errors.length === 0, errors.slice(0, 8).join(" | "));

await browser.close();
server.close();

const failed = results.filter((r) => !r.pass);
console.log(`\n=== E2E 試技ハーネス（trial・3シナリオ×3武器）：${results.length - failed.length}/${results.length} pass ===`);
if (failed.length) { console.log("FAILED:", failed.map((f) => f.name).join(", ")); process.exit(1); }

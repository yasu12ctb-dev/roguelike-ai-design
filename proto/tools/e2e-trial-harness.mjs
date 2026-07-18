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

const SCENARIOS = ["corridor", "room3", "sweepbar", "mixed"];
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

// ── PR-3 拡張の検証 ──

// ①武器正規化：3クラスとも装備武器の dmg が等しく（TRIAL_DMG）、reach/sweep がクラス相応か。
const norm = await page.evaluate(async () => {
  const t = (window).__hazTest; t.setHp(200);
  const info = {};
  for (const w of ["sword", "spear", "naginata"]) { t.trial("room3", w); info[w] = t.weaponInfo(); }
  return info;
});
const dmgs = ["sword", "spear", "naginata"].map((w) => norm[w]?.dmg);
ok("①武器正規化：3クラスの攻撃値(dmg)が等しい", dmgs.every((d) => d === dmgs[0] && d > 0), JSON.stringify(norm));
ok("①クラス機構が保たれる（剣=近接／槍=reach2／薙刀=sweep）", norm.sword?.reach === 1 && !norm.sword?.sweep && norm.spear?.reach === 2 && norm.naginata?.sweep === true, JSON.stringify({ sword: norm.sword, spear: norm.spear, naginata: norm.naginata }));

// ②薙刀の距離2バー：sweepbar＋薙刀で東へ薙ぐと距離2の横3マス（3体）に届く＝敵HP総量が減る。
const sweep = await page.evaluate(async () => {
  const t = (window).__hazTest; t.setHp(200);
  t.trial("sweepbar", "naginata");
  const before = t.state().mons; // 生存3体
  const ehp0 = t.state().monList.reduce((s, m) => s + m.hp, 0);
  await t.trialTurn(1, 0); // 東へ薙ぐ（距離2バー発火）
  const ehp1 = t.state().monList.reduce((s, m) => s + m.hp, 0);
  return { before, ehp0, ehp1, hit: ehp1 < ehp0 };
});
ok("②薙刀の距離2バーが3体に届く（敵HP総量が減る）", sweep.before === 3 && sweep.hit === true, JSON.stringify(sweep));

// ③gearBag＋一手交換：控えに他クラス2種、trialSwapWeapon で持ち替え＝一手消費（swaps 加算・武器が入替）。
const swap = await page.evaluate(async () => {
  const t = (window).__hazTest; t.setHp(200);
  t.trial("room3", "spear");
  const bag0 = t.bagWeapons().length;
  const before = t.weaponInfo();
  const swapped = await t.trialSwapWeapon("naginata");
  const after = t.weaponInfo();
  const st = t.trialStats();
  return { bag0, before: before?.name, swapped, afterSweep: after?.sweep, swaps: st?.swaps, turns: st?.turns };
});
ok("③控えに他クラス2種が入っている", swap.bag0 === 2, JSON.stringify(swap));
ok("③一手交換で薙刀へ持ち替わる＋交換回数を記録", swap.afterSweep === true && swap.swaps === 1, JSON.stringify(swap));

// ④stats記録：room3(全隣接)で薙刀＝距離1は死角ゆえ東へ薙いでも当たらず「攻撃不能手番」が積まれる／被ダメも積む。
const stats = await page.evaluate(async () => {
  const t = (window).__hazTest; t.setHp(200);
  t.trial("room3", "naginata"); // 3体全隣接＝薙刀の死角
  for (let i = 0; i < 4; i++) await t.trialTurn(1, 0); // 東へ薙ごうとする（隣接ゆえ届かない）
  return t.trialStats();
});
ok("④攻撃不能手番を記録（薙刀×全隣接＝死角で当たらない手番がある）", (stats?.noHitTurns ?? 0) >= 1, JSON.stringify(stats));
ok("④被ダメ・手番数を記録している", (stats?.turns ?? 0) === 4 && (stats?.dmgTaken ?? 0) >= 0, JSON.stringify(stats));

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

// 実ブラウザ E2E（最期の残響・RFC・P1）：静穏(calm)/遺言(will) の配置・表示・機構を検証する。
//   ローカル専用（CI外・playwright は package.json に入れない規約）。既存 e2e-*.mjs と同一手法。
import { chromium } from "playwright";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { join, extname } from "node:path";

const WEB_DIR = new URL("../web/", import.meta.url).pathname;
const PORT = 41990 + Math.floor(Math.random() * 900);
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
      if (st.hasInput) await page.fill("#sheetInput", "残響検証").catch(() => {});
      if (/難易度/.test(st.meta)) { const di = st.btns.findIndex((t) => /ふつう|normal|普/i.test(t)); await page.locator("#sheetButtons button").nth(di >= 0 ? di : 0).click().catch(() => {}); await page.waitForTimeout(120); continue; }
      await page.locator("#sheetButtons button").nth(0).click().catch(() => {}); await page.waitForTimeout(120); continue;
    }
    await page.waitForTimeout(80);
  }
  return false;
}
ok("潜行(dive)へ到達", await reachDive());
// normal 固定（静穏の増援抑制を検証するため）＝新規が easy を選んでいたら上書き。
await page.evaluate(() => (window).__hazTest.setDifficulty("normal"));

// ① 配置＋表示（オーラ）：静穏の残響を隣に置くと、盤面に echo オーラ（トーン色）が1つ現れる。
const disp = await page.evaluate(async () => {
  const t = (window).__hazTest;
  t.clearMons(); t.clearHaz();
  const before = t.echoAuraInDom();
  const id = t.spawnEcho("calm", "loss", 1, 0, {});
  const after = t.echoAuraInDom();
  return { id: !!id, before, after };
});
ok("①静穏の残響を配置＝盤面にトーン色オーラが出る", disp.id && disp.before === 0 && disp.after === 1, JSON.stringify(disp));

// ② peek：残響マスを調べると「◯◯の残響：（静穏の1行）」が出る。
const peek = await page.evaluate(() => (window).__hazTest.peekAt(1, 0));
ok("②残響マスの peek に『残響』『静穏』が出る", /残響/.test(peek) && /静穏/.test(peek), JSON.stringify(peek));

// ③ 静穏＝静かなマス：蝕の霧の上でも、静穏の残響のそばでは深蝕が澱まない（0 のまま）。
const calm = await page.evaluate(async () => {
  const t = (window).__hazTest;
  t.clearMons(); t.clearHaz();
  t.spawnEcho("calm", "loss", 1, 0, {});   // 隣（Cheb1・半径2内）
  t.putHaz(0, 0, "miasma");                 // 足元に蝕の霧
  const active = t.calmActive();
  const e0 = t.getExposure();
  t.step();                                 // 手番終了＝霧の判定
  const e1 = t.getExposure();
  return { active, e0, e1, suppressed: e1 <= e0 + 1e-9 };
});
ok("③静穏のそば＝霧の上でも深蝕が増えない（澱みが凪ぐ）", calm.active && calm.suppressed, JSON.stringify(calm));

// ③b 対照：静穏が無ければ、霧で深蝕は増える。
const calmOff = await page.evaluate(async () => {
  const t = (window).__hazTest;
  t.clearMons(); t.clearHaz();
  if (window.__floorEchoNull) {} // no-op
  // 残響を遠くへ（半径外）＝静かなマスの外。
  t.spawnEcho("calm", "loss", 6, 0, {});
  t.putHaz(0, 0, "miasma");
  const active = t.calmActive();
  const e0 = t.getExposure();
  t.step();
  const e1 = t.getExposure();
  return { active, e0, e1, rose: e1 > e0 };
});
ok("③b対照：静かなマスの外では霧で深蝕が増える", calmOff.active === false && calmOff.rose, JSON.stringify(calmOff));

// ④ 遺言の型・剣＝次の受け1回を完全無効化（hp 不変）＋boon 消費。
const willSword = await page.evaluate(async () => {
  const t = (window).__hazTest;
  t.clearMons(); t.clearHaz();
  t.giveWeapon("長剣");
  t.setHp(50);
  t.setEchoBoon("sword");
  t.spawnDmg(1, 0, "rat", 6, 40);   // 隣接の攻撃役（dmg6・hp40）
  t.armGuard();                      // 受けを構える
  const hp0 = t.getHp();
  t.step();                          // 敵手番＝受け（boon で完全無効化）
  const hp1 = t.getHp();
  return { boonAfter: t.echoBoonState(), hp0, hp1, negated: hp1 === hp0 };
});
ok("④遺言・剣＝次の受けを完全無効化（hp 不変）＋boon 消費", willSword.negated && willSword.boonAfter === null, JSON.stringify(willSword));

// ⑤ 遺言の型・槍＝隣接（距離1）の突きで boon を消費（距離1減衰なしのフラグが立つ）。
const willSpear = await page.evaluate(async () => {
  const t = (window).__hazTest;
  t.clearMons(); t.clearHaz();
  t.giveWeapon("刺突槍");
  t.setHp(80);
  t.setEchoBoon("spear");
  t.spawnDmg(1, 0, "rat", 1, 60);   // 隣接（距離1）の敵
  t.bump(1, 0);                      // 東へ突く（隣接＝本来は減衰／boon で満額）
  await new Promise((r) => setTimeout(r, 80));
  return { boonAfter: t.echoBoonState() };
});
ok("⑤遺言・槍＝隣接の突きで boon を消費", willSpear.boonAfter === null, JSON.stringify(willSpear));

// ⑥ boon は「その潜行限り」＝別の型を跨がない（sword boon は槍攻撃では消えない）。
const isolation = await page.evaluate(async () => {
  const t = (window).__hazTest;
  t.clearMons(); t.clearHaz();
  t.giveWeapon("刺突槍");
  t.setEchoBoon("sword");            // 剣の boon
  t.spawnDmg(1, 0, "rat", 1, 60);
  t.bump(1, 0);                      // 槍で突く＝剣 boon は消費されない
  await new Promise((r) => setTimeout(r, 80));
  return { boonAfter: t.echoBoonState() };
});
ok("⑥剣 boon は槍攻撃では消費されない（型が混ざらない）", isolation.boonAfter === "sword", JSON.stringify(isolation));

// ── P1-B（守り手/呪詛）──
async function openArea() { await page.evaluate(() => { const t = (window).__hazTest; t.clearMons(); t.clearHaz(); for (let dx = -4; dx <= 4; dx++) for (let dy = -4; dy <= 4; dy++) t.setTile(dx, dy, 1); }); }
async function clickOption(re) {
  const btns = await page.evaluate(() => [...document.querySelectorAll("#sheetButtons button")].map((b) => (b.textContent || "").trim()));
  const idx = btns.findIndex((t) => re.test(t));
  await page.locator("#sheetButtons button").nth(idx >= 0 ? idx : 0).click().catch(() => {});
  await page.waitForTimeout(150);
}
async function drainSheets(max = 8) { for (let i = 0; i < max; i++) { const shown = await page.evaluate(() => !!document.querySelector("#overlay")?.classList.contains("show")); if (!shown) break; await page.locator("#sheetButtons button").first().click().catch(() => {}); await page.waitForTimeout(120); } }

// ⑦ 守り手：未鎮魂で奪取→番人が覚醒（floor.monsters へ注入）。
await openArea();
const gAwakeB0 = await page.evaluate(() => { const t = (window).__hazTest; t.setHp(200); t.setDifficulty("normal"); const id = t.spawnEcho("guard", "myth", 2, 0, { gear: "長剣" }); return { id, board: t.echoBoard() }; });
await page.evaluate(() => (window).__hazTest.triggerGuardTake());
await page.waitForTimeout(170);
await clickOption(/奪う/);
await drainSheets();
const gAwakeB1 = await page.evaluate(() => (window).__hazTest.echoBoard());
ok("⑦守り手：遺品＋眠り番人が配置される", gAwakeB0.id && gAwakeB0.board?.loot && gAwakeB0.board?.ward && gAwakeB0.board?.ward.awake === false, JSON.stringify(gAwakeB0));
ok("⑦守り手：未鎮魂で奪取→番人が覚醒（floor.monsters に注入）", gAwakeB1?.loot?.taken === true && gAwakeB1?.ward?.awake === true && gAwakeB1?.wardInMons === true, JSON.stringify(gAwakeB1));

// ⑧ 守り手：鎮魂済みなら静かに受け取り、番人は崩れる（floor.monsters に入らない）。
await openArea();
const gCalmId = await page.evaluate(() => { const t = (window).__hazTest; t.setHp(200); const id = t.spawnEcho("guard", "myth", 2, 0, { gear: "長剣" }); t.requiemFossil(id); return id; });
await page.evaluate(() => (window).__hazTest.triggerGuardTake());
await page.waitForTimeout(170);
await clickOption(/静かに受け取る/);
await drainSheets();
const gCalmB = await page.evaluate(() => (window).__hazTest.echoBoard());
ok("⑧守り手：鎮魂済みなら番人は覚醒せず崩れる", gCalmB?.loot?.taken === true && gCalmB?.ward === null && gCalmB?.wardInMons === false, JSON.stringify(gCalmB));

// ⑨ 呪詛：蝕の霧＋怨念の影が配置され、影を討てば先代Lv比例 gold。
await openArea();
const curse = await page.evaluate(() => {
  const t = (window).__hazTest;
  const id = t.spawnEcho("curse", "grudge", 3, 0, {});
  const b0 = t.echoBoard();
  const g0 = t.getGold();
  const killed = t.killShade();
  const g1 = t.getGold();
  const b1 = t.echoBoard();
  return { id, b0, g0, killed, g1, b1 };
});
ok("⑨呪詛：蝕の霧＋怨念の影が配置される", curse.b0?.miasma > 0 && !!curse.b0?.shadeId, JSON.stringify({ miasma: curse.b0?.miasma, shade: curse.b0?.shadeId }));
ok("⑨呪詛：影を討てば gold を得る＋影が消える", curse.killed === true && curse.g1 > curse.g0 && curse.b1?.shadeId === null, JSON.stringify({ g0: curse.g0, g1: curse.g1, shade: curse.b1?.shadeId }));

// ⑩ 呪詛：鎮魂で浄化＝蝕の霧が晴れ、怨念の影が還る。
await openArea();
const purify = await page.evaluate(() => {
  const t = (window).__hazTest;
  t.spawnEcho("curse", "grudge", 3, 0, {});
  const b0 = t.echoBoard();
  t.purifyCurse();
  const b1 = t.echoBoard();
  return { b0, b1 };
});
ok("⑩呪詛：鎮魂で霧が晴れ影が還る（浄化）", purify.b0?.miasma > 0 && purify.b1?.miasma === 0 && purify.b1?.shadeId === null && purify.b1?.purified === true, JSON.stringify(purify));

ok("例外・console.error ゼロ（全体）", errors.length === 0, errors.slice(0, 8).join(" | "));

await browser.close();
server.close();
const failed = results.filter((r) => !r.pass);
console.log(`\n=== E2E 最期の残響（calm/will）：${results.length - failed.length}/${results.length} pass ===`);
if (failed.length) { console.log("FAILED:", failed.map((f) => f.name).join(", ")); process.exit(1); }

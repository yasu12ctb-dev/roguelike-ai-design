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

// ⑪ P2-A（相棒/縁者の残響）：実選定ゲート pickFloorEcho が相棒/縁者化石を採択し、シード explorer は除外する。
await openArea();
const p2comp = await page.evaluate(() => {
  const t = (window).__hazTest;
  t.clearEchoFossils();
  const id = t.injectEchoFossil("accept", 2, 0, { bond: "companion", name: "レン" });
  const picked = t.runEchoSelection();
  const peek = t.peekAt(2, 0);
  return { id, picked, peek };
});
ok("⑪P2-A：死んだ相棒（accept）が残響に採択される", p2comp.picked === p2comp.id, JSON.stringify({ picked: p2comp.picked, id: p2comp.id }));
ok("⑪P2-A：相棒の残響 peek に『共に歩いた相棒』が出る", /共に歩いた相棒/.test(p2comp.peek), p2comp.peek);

const p2ally = await page.evaluate(() => {
  const t = (window).__hazTest;
  t.clearEchoFossils();
  const id = t.injectEchoFossil("guard_relic", 2, 0, { bond: "ally", gear: "長剣", name: "セラ" });
  const picked = t.runEchoSelection();
  const board = t.echoBoard();
  const peek = t.peekAt(2, 0);
  return { id, picked, board, peek };
});
ok("⑪P2-A：縁を結んだ者（guard）が残響に採択され遺品が置かれる", p2ally.picked === p2ally.id && !!p2ally.board?.loot, JSON.stringify({ picked: p2ally.picked, loot: p2ally.board?.loot }));
ok("⑪P2-A：縁者の残響 peek に『縁を結んだ者』が出る", /縁を結んだ者/.test(p2ally.peek), p2ally.peek);

const p2seed = await page.evaluate(() => {
  const t = (window).__hazTest;
  t.clearEchoFossils();
  t.injectEchoFossil("accept", 2, 0, { seed: true, name: "見知らぬ骨" });
  return { picked: t.runEchoSelection() };
});
ok("⑪P2-A：シード化石（explorer）は残響に採択されない（自血統/相棒/縁者のみ）", p2seed.picked === null, JSON.stringify(p2seed));

const p2aband = await page.evaluate(() => {
  const t = (window).__hazTest;
  t.clearEchoFossils();
  const id = t.injectEchoFossil("curse_dungeon", 3, 0, { bond: "companion", name: "ダン" });
  const picked = t.runEchoSelection();
  const peek = t.peekAt(3, 0);
  const board = t.echoBoard();
  const g0 = t.getGold();
  const killed = t.killShade();
  const g1 = t.getGold();
  return { id, picked, peek, board, killed, g0, g1 };
});
ok("⑪P2-A：見捨てた相棒（betrayed→curse）が呪詛の残響に採択される", p2aband.picked === p2aband.id && p2aband.board?.kind === "curse", JSON.stringify({ picked: p2aband.picked, kind: p2aband.board?.kind }));
ok("⑪P2-A：見捨てた相棒の呪詛 peek に『見捨てた相棒』が出る", /見捨てた相棒/.test(p2aband.peek), p2aband.peek);
ok("⑪P2-A：見捨てた相棒の影を討てば gold を得る", p2aband.killed === true && p2aband.g1 > p2aband.g0, JSON.stringify({ g0: p2aband.g0, g1: p2aband.g1 }));

// ⑫ P2-B（tonePole の機械的修飾）：loss=基準／myth=プレイヤー恵み／grudge=険しく報われる。
// ⑫a 静穏の半径：grudge は −1（距離2はゾーン外）／loss は距離2まで有効。
await openArea();
const calmRadius = await page.evaluate(() => {
  const t = (window).__hazTest;
  t.clearMons(); t.clearHaz();
  t.spawnEcho("calm", "grudge", 2, 0, {}); const g = t.calmActive();
  t.clearEchoFossils(); t.clearMons(); t.clearHaz();
  t.spawnEcho("calm", "loss", 2, 0, {}); const l = t.calmActive();
  return { grudge: g, loss: l };
});
ok("⑫a静穏：grudge は半径 −1（距離2はゾーン外）／loss は距離2で有効", calmRadius.grudge === false && calmRadius.loss === true, JSON.stringify(calmRadius));

// ⑫b 怨念の影 hp：grudge は loss より高い（×1.15）。
const shadeHp = await page.evaluate(() => {
  const t = (window).__hazTest;
  t.clearEchoFossils(); t.clearMons(); t.clearHaz(); t.spawnEcho("curse", "grudge", 3, 0, {}); const g = t.shadeHp();
  t.clearEchoFossils(); t.clearMons(); t.clearHaz(); t.spawnEcho("curse", "loss", 3, 0, {}); const l = t.shadeHp();
  return { grudge: g, loss: l };
});
ok("⑫b呪詛：grudge の影 hp は loss より高い（×1.15）", shadeHp.grudge > shadeHp.loss, JSON.stringify(shadeHp));

// ⑫c 影撃破 gold：grudge は係数 +2（×8 vs ×6）＝より報われる。
const shadeGold = await page.evaluate(() => {
  const t = (window).__hazTest;
  t.clearEchoFossils(); t.clearMons(); t.clearHaz(); t.setExposure(0); const g0 = t.getGold(); t.spawnEcho("curse", "grudge", 3, 0, {}); t.killShade(); const gg = t.getGold() - g0;
  t.clearEchoFossils(); t.clearMons(); t.clearHaz(); const l0 = t.getGold(); t.spawnEcho("curse", "loss", 3, 0, {}); t.killShade(); const lg = t.getGold() - l0;
  return { grudge: gg, loss: lg };
});
ok("⑫c呪詛：grudge の影撃破 gold は loss より多い（係数 +2）", shadeGold.grudge > shadeGold.loss, JSON.stringify(shadeGold));

// ⑫d 呪詛の浄化：myth はプレイヤーに深蝕減の恵み／loss は恵みなし。
const purifyRelief = await page.evaluate(() => {
  const t = (window).__hazTest;
  t.clearEchoFossils(); t.clearMons(); t.clearHaz(); t.setExposure(1.0); t.spawnEcho("curse", "myth", 3, 0, {}); t.purifyCurse(); const m = 1.0 - t.getExposure();
  t.clearEchoFossils(); t.clearMons(); t.clearHaz(); t.setExposure(1.0); t.spawnEcho("curse", "loss", 3, 0, {}); t.purifyCurse(); const l = 1.0 - t.getExposure();
  return { myth: m, loss: l };
});
ok("⑫d呪詛：myth の浄化はプレイヤー深蝕減／loss は恵みなし", purifyRelief.myth > 0.1 && Math.abs(purifyRelief.loss) < 1e-9, JSON.stringify(purifyRelief));

// ⑫e 番人 hp：grudge は loss より高い（×1.15）。遺品を奪って番人覚醒→hp を読む。
async function wardHpFor(tone) {
  await page.evaluate((tn) => {
    const t = (window).__hazTest;
    t.clearEchoFossils(); t.clearMons(); t.clearHaz(); t.setHp(200);
    for (let dx = -4; dx <= 4; dx++) for (let dy = -4; dy <= 4; dy++) t.setTile(dx, dy, 1);
    t.spawnEcho("guard", tn, 2, 0, { gear: "長剣" });
    t.triggerGuardTake();
  }, tone);
  await page.waitForTimeout(150);
  await clickOption(/奪う/).catch(() => {});
  await drainSheets();
  return await page.evaluate(() => (window).__hazTest.wardHp());
}
const wardHpG = await wardHpFor("grudge");
const wardHpL = await wardHpFor("loss");
ok("⑫e守り手：grudge の番人 hp は loss より高い（×1.15）", wardHpG !== null && wardHpL !== null && wardHpG > wardHpL, JSON.stringify({ grudge: wardHpG, loss: wardHpL }));

// ⑬ P2-C（alien 変質の形状変化）：放置で歪んだ（alien）残響は面影を失い形が変わる。weathered/twisting は不変。
// ⑬a 呪詛：alien の影は「歪影」＝名が変わり hp も高い（loss 同士で alien vs 非alien）。
const curseAlien = await page.evaluate(() => {
  const t = (window).__hazTest;
  t.clearEchoFossils(); t.clearMons(); t.clearHaz(); t.spawnEcho("curse", "loss", 3, 0, { alien: true }); const a = { hp: t.shadeHp(), name: t.shadeName() };
  t.clearEchoFossils(); t.clearMons(); t.clearHaz(); t.spawnEcho("curse", "loss", 3, 0, {}); const n = { hp: t.shadeHp(), name: t.shadeName() };
  return { a, n };
});
ok("⑬a呪詛：alien は『歪影』＝名が変わり hp も高い", curseAlien.a.name === "歪影" && curseAlien.n.name === "怨念の影" && curseAlien.a.hp > curseAlien.n.hp, JSON.stringify(curseAlien));

// ⑬b 守り手：alien の番人は「歪んだ番人」＝名が変わり hp も高い。
async function wardFor(alien) {
  await page.evaluate((al) => {
    const t = (window).__hazTest;
    t.clearEchoFossils(); t.clearMons(); t.clearHaz(); t.setHp(200);
    for (let dx = -4; dx <= 4; dx++) for (let dy = -4; dy <= 4; dy++) t.setTile(dx, dy, 1);
    t.spawnEcho("guard", "loss", 2, 0, { gear: "長剣", alien: al });
    t.triggerGuardTake();
  }, alien);
  await page.waitForTimeout(150);
  await clickOption(/奪う/).catch(() => {});
  await drainSheets();
  return await page.evaluate(() => ({ hp: (window).__hazTest.wardHp(), name: (window).__hazTest.wardName() }));
}
const wardAlien = await wardFor(true);
const wardNorm = await wardFor(false);
ok("⑬b守り手：alien は『歪んだ番人』＝名が変わり hp も高い", wardAlien.name === "歪んだ番人" && wardNorm.name === "遺品の番人" && wardAlien.hp > wardNorm.hp, JSON.stringify({ wardAlien, wardNorm }));

// ⑬c 静穏：alien は十字のみ（対角はゾーン外）。距離1の対角(1,1)＝非alien は安らぎ／alien は安らがない。
await openArea();
const calmAlien = await page.evaluate(() => {
  const t = (window).__hazTest;
  t.clearEchoFossils(); t.clearMons(); t.clearHaz(); t.spawnEcho("calm", "loss", 1, 1, { alien: true }); const a = t.calmActive();
  t.clearEchoFossils(); t.clearMons(); t.clearHaz(); t.spawnEcho("calm", "loss", 1, 1, {}); const n = t.calmActive();
  return { alien: a, normal: n };
});
ok("⑬c静穏：alien は十字のみ＝対角(1,1)は安らがない／非alien は安らぐ", calmAlien.alien === false && calmAlien.normal === true, JSON.stringify(calmAlien));

ok("例外・console.error ゼロ（全体）", errors.length === 0, errors.slice(0, 8).join(" | "));

await browser.close();
server.close();
const failed = results.filter((r) => !r.pass);
console.log(`\n=== E2E 最期の残響（P1 ＋ P2-A ＋ P2-B ＋ P2-C alien）：${results.length - failed.length}/${results.length} pass ===`);
if (failed.length) { console.log("FAILED:", failed.map((f) => f.name).join(", ")); process.exit(1); }

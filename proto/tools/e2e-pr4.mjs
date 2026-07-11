// 実ブラウザ E2E（PR4・v0.148.0）：経路湧き増援(④)＋攻撃力の外科的強化(①)＋深蝕を被弾に紐づけ(B)。
// (1)normal で滞在し続けると視界外に増援が湧く・easy では湧かない (2)増援はフロア上限(WANDER_FLOOR_CAP)で頭打ち
// (3)burst 被弾で深蝕が増える・回避/押し出しキャンセルなら増えない (4)chipFrac 反映＝軽減を積んでも最低ダメが以前より大きい(normal0.20/hard0.24)
// (5)既存戦闘（剣/槍/薙刀/burst 押し出しキャンセル）回帰＝例外0。
// __hazTest フック（"sekitsui.dbg"="1"）で盤面を制御して決定論検証。ローカル専用（CI外・playwright は package.json に入れない規約）。
import { chromium } from "playwright";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { join, extname } from "node:path";

const WEB_DIR = new URL("../web/", import.meta.url).pathname;
const PORT = 44600 + Math.floor(Math.random() * 900);
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

// 開けたアリーナを @ の周囲に作る（半径 r）。
async function arena(r) {
  await page.evaluate((r) => {
    const t = (window).__hazTest;
    t.giveWeapon("長剣"); t.setCounter(0); t.clearMons(); t.setHp(999);
    for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) t.setTile(dx, dy, 1);
  }, r);
}

// ── W1：経路湧き増援(④)＝easy では WANDER_EVERY を超えて手を進めても湧かない。
await arena(3);
const w1 = await page.evaluate(async () => {
  const t = (window).__hazTest;
  t.setDifficulty("easy"); t.clearMons(); t.setHp(999); t.resetWander();
  for (let i = 0; i < 30; i++) await new Promise((r) => { t.step(); setTimeout(r, 15); });
  return t.wanderState();
});
ok("W1 easy：30手経過しても増援は湧かない", w1.count === 0, `count=${w1.count}`);

// ── W2：normal では WANDER_EVERY(35) 手ごとに1体・視界外に湧く。
const w2 = await page.evaluate(async () => {
  const t = (window).__hazTest;
  t.setDifficulty("normal"); t.clearMons(); t.setHp(999); t.resetWander();
  for (let i = 0; i < 34; i++) await new Promise((r) => { t.step(); setTimeout(r, 15); });
  const before = t.wanderState();
  const posBefore = t.wanderPositions();
  await new Promise((r) => { t.step(); setTimeout(r, 15); }); // 35手目＝湧くはず
  const after = t.wanderState();
  const pos = t.wanderPositions();
  const vis = pos.length ? t.farVisible(pos[0].x, pos[0].y) : null;
  return { before, after, posBeforeLen: posBefore.length, posLen: pos.length, vis };
});
ok("W2 normal：34手では未湧き", w2.before.count === 0 && w2.posBeforeLen === 0, `before=${JSON.stringify(w2.before)}`);
ok("W2 normal：35手目に1体湧く（WANDER_EVERY）", w2.after.count === 1 && w2.posLen === 1, `after=${JSON.stringify(w2.after)}`);
ok("W2 湧いた増援は@の視界外（4-11A：突然ポップしない）", w2.vis === false, `vis=${w2.vis}`);

// ── W3：フロア上限(WANDER_FLOOR_CAP=6)で頭打ち＝居座り続けても無限には増えない（じっくり攻略を罰しない＝上限で止まる）。
const w3 = await page.evaluate(async () => {
  const t = (window).__hazTest;
  t.setDifficulty("normal"); t.clearMons(); t.setHp(999); t.resetWander();
  for (let i = 0; i < 280; i++) await new Promise((r) => { t.step(); setTimeout(r, 8); });
  const at280 = t.wanderState();
  for (let i = 0; i < 80; i++) await new Promise((r) => { t.step(); setTimeout(r, 8); });
  const at360 = t.wanderState();
  return { at280, at360 };
});
ok("W3 280手で上限(6)に到達", w3.at280.count === 6, `count=${w3.at280.count}`);
ok("W3 さらに80手進めても上限で頭打ち（無限に増えない）", w3.at360.count === 6, `count=${w3.at360.count}`);

// ── B1：burst 被弾で深蝕が増える（回避不能の炸裂を丸受けした時だけ）。
await arena(4);
const b1 = await page.evaluate(async () => {
  const t = (window).__hazTest;
  t.setDifficulty("normal"); t.clearMons(); t.setHp(999);
  const before = t.getExposure();
  t.spawnKind(2, 0, "burster", 99); // 東・距離2＝炸裂予告
  await new Promise((r) => { t.step(); setTimeout(r, 220); });
  return { before, after: t.getExposure() };
});
ok("B1 burst 被弾で深蝕が増える", b1.after > b1.before, `before=${b1.before} after=${b1.after}`);

// ── B2：押し出しで射程外へ出す（予告キャンセル＝無傷）と深蝕は増えない。
await arena(4);
const b2 = await page.evaluate(async () => {
  const t = (window).__hazTest;
  t.setDifficulty("normal"); t.clearMons(); t.setHp(999);
  const before = t.getExposure();
  t.spawnKind(2, 0, "burster", 99);  // 東・距離2で炸裂予告
  t.push(2, 0);                       // 東へ突き飛ばす→dist3＝射程外＝予告キャンセル
  await new Promise((r) => { t.step(); setTimeout(r, 220); });
  return { before, after: t.getExposure() };
});
ok("B2 押し出しキャンセルで無傷＝深蝕も増えない", b2.after === b2.before, `before=${b2.before} after=${b2.after}`);

// ── C1：chipFrac 反映＝巨大な軽減を積んでも最低ダメは normal=ceil(dmg*0.20)/hard=ceil(dmg*0.24)（easyは固定床1）。
await arena(3);
const RAW = 20;
async function chipDmgAt(diff) {
  return page.evaluate(async ({ diff, RAW }) => {
    const t = (window).__hazTest;
    t.setDifficulty(diff);
    t.clearMons();
    t.giveArmor("革鎧", 999); // 巨大な軽減＝生ダメ経路を完全に塞ぐ＝下限(chipFrac)だけが見える
    t.setHp(999);
    t.spawnDmg(1, 0, "rat", RAW, 99); // 隣接・raw dmg=RAW・自分は倒されない高HP
    const before = t.getHp();
    await new Promise((r) => { t.step(); setTimeout(r, 200); });
    return before - t.getHp();
  }, { diff, RAW });
}
const dmgEasy = await chipDmgAt("easy");
const dmgNormal = await chipDmgAt("normal");
const dmgHard = await chipDmgAt("hard");
ok("C1 easy：巨大軽減で被ダメは固定床1（chipFrac=0・従来どおり）", dmgEasy === 1, `dmg=${dmgEasy}`);
ok("C1 normal：chipFrac=0.20＝ceil(20*0.20)=4（従来0.15の3より大きい＝外科的強化を確認）", dmgNormal === 4, `dmg=${dmgNormal}`);
ok("C1 hard：chipFrac=0.24＝ceil(20*0.24)=5（従来0.18の4より大きい）", dmgHard === 5, `dmg=${dmgHard}`);
ok("C1 最低ダメは以前（固定床1）より明確に大きい（normal/hard）", dmgNormal > dmgEasy && dmgHard > dmgEasy, `easy=${dmgEasy} normal=${dmgNormal} hard=${dmgHard}`);

// 溜まったXP等で開いたシート（レベルアップ/戦利品）を閉じる＝playerAct が busy で早期 return するのを防ぐ。
async function dismissOverlays() {
  for (let i = 0; i < 8; i++) {
    const shown = await page.evaluate(() => !!document.querySelector("#overlay")?.classList.contains("show"));
    if (!shown) break;
    await page.locator("#sheetButtons button").nth(0).click({ timeout: 1500 }).catch(() => {});
    await page.waitForTimeout(120);
  }
}
// ── R1：既存戦闘の回帰＝剣/槍/薙刀で通常敵を殴って斃せる（例外0）。
for (const [wp, label] of [["長剣", "剣"], ["刺突槍", "槍"], ["大薙刀", "薙刀"]]) {
  await dismissOverlays();
  const r = await page.evaluate(async ({ wp }) => {
    const t = (window).__hazTest;
    t.setDifficulty("normal");
    t.giveWeapon(wp); t.setCounter(0); t.clearMons(); t.setHp(80);
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) t.setTile(dx, dy, 1);
    t.spawnKind(1, 0, "rat", 3);
    const hp0 = t.monAt(1, 0)?.hp ?? -1;
    t.bump(1, 0);
    await new Promise((res) => setTimeout(res, 220));
    const after = t.monAt(1, 0);
    return { hp0, gone: after === null, afterHp: after?.hp ?? -1 };
  }, { wp });
  ok(`R1 ${label}で通常敵に有効打（斃す/削る）`, r.hp0 > 0 && (r.gone || r.afterHp < r.hp0), `hp0=${r.hp0} afterHp=${r.afterHp} gone=${r.gone}`);
}
// ── R2：burst の押し出しキャンセル回帰（PR3 機能が PR4 で壊れていないか）。
await dismissOverlays();
await arena(4);
const r2 = await page.evaluate(async () => {
  const t = (window).__hazTest;
  t.setDifficulty("normal"); t.clearMons(); t.setHp(90);
  t.spawnKind(2, 0, "burster", 99);
  t.push(2, 0);
  const pushed = t.monAt(3, 0);
  const before = t.getHp();
  await new Promise((r) => { t.step(); setTimeout(r, 220); });
  return { intent: pushed?.intent ?? null, dmg: before - t.getHp() };
});
ok("R2 burst 押し出しキャンセル回帰＝無傷", r2.intent === "wait" && r2.dmg === 0, `intent=${r2.intent} dmg=${r2.dmg}`);

ok("例外・console.error ゼロ", errors.length === 0, errors.slice(0, 5).join(" | "));

await browser.close();
server.close();
const failed = results.filter((r) => !r.pass);
console.log(`\n=== E2E PR4（経路湧き増援＋外科的強化＋burst深蝕）：${results.length - failed.length}/${results.length} pass ===`);
if (failed.length) { console.log("FAILED:", failed.map((f) => f.name).join(", ")); process.exit(1); }

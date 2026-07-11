// 実ブラウザ E2E（PR3・v0.147.0）：回避不能の炸裂〈爆ぜ胞子(burst)〉＋再生の雫(mending・案Y)。
// (1)burster が3×3を予告し全マス tele-shape 描画 (2)@が1マス動いても被弾（回避不能） (3)押し出しで詠唱者を dist>2 へ出すと予告キャンセル＝無傷
// (3b)dist2 に留めれば依然炸裂（＝完全に出した時だけ無傷） (4)炸裂前に倒すと不発 (5)mending＝敵視界内は回復せず/安全時は6割まで回復/6割超は回復しない
// (6)既存戦闘（剣/槍/薙刀）回帰＝例外0。__hazTest フック（"sekitsui.dbg"="1"）で盤面を制御して決定論検証。ローカル専用（CI外・playwright は package.json に入れない規約）。
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
    t.giveWeapon("長剣"); t.setCounter(0); t.clearMons(); t.setHp(90);
    for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) t.setTile(dx, dy, 1);
  }, r);
}

// ── S1：爆ぜ胞子(burst)＝距離2から3×3を予告。cells 9マス＋DOM tele-shape 描画。
await arena(3);
const s1 = await page.evaluate(async () => {
  const t = (window).__hazTest;
  t.spawnKind(2, 0, "burster", 99);          // 東・距離2＝炸裂予告
  const cells = t.cellsAt(2, 0);
  t.redraw();
  const dom = document.querySelectorAll(".cell.tele-shape").length;
  return { n: cells ? cells.length : 0, dom };
});
ok("S1 爆ぜ胞子(burst) は3×3を予告（cells=9）", s1.n === 9, `cells=${s1.n}`);
ok("S1 予告マスが盤上に描画される（tele-shape DOM≥8）", s1.dom >= 8, `dom=${s1.dom}`);

// ── S2：回避不能＝どの方向へ1マス退いても3×3内＝被弾。
for (const [dx, dy, label] of [[-1, -1, "北西へ退避"], [0, 1, "南へ退避"], [-1, 0, "西（敵と反対）へ退避"]]) {
  await arena(3);
  const s2 = await page.evaluate(async ({ dx, dy }) => {
    const t = (window).__hazTest;
    t.spawnKind(2, 0, "burster", 99);
    t.movePlayer(dx, dy);                      // 手番を消費せず1マス退く（予告は旧位置の3×3のまま）
    const before = t.getHp();
    await new Promise((r) => { t.step(); setTimeout(r, 220); });
    return { dmg: before - t.getHp() };
  }, { dx, dy });
  ok(`S2 ${label}でも炸裂に巻き込まれる（回避不能）`, s2.dmg > 0, `dmg=${s2.dmg}`);
}

// ── S3：押し出しで詠唱者を dist>2 の外へ出せば予告キャンセル＝無傷。
await arena(4);
const s3 = await page.evaluate(async () => {
  const t = (window).__hazTest;
  t.spawnKind(2, 0, "burster", 99);            // 東・距離2で炸裂予告
  t.push(2, 0);                                 // 東へ突き飛ばす→(3,0)＝dist3＝射程外
  const pushed = t.monAt(3, 0);                 // 押し出し後の位置と intent
  const before = t.getHp();
  await new Promise((r) => { t.step(); setTimeout(r, 220); });
  return { intent: pushed?.intent ?? null, dmg: before - t.getHp() };
});
ok("S3 dist>2 へ押し出すと予告が wait に潰れる", s3.intent === "wait", `intent=${s3.intent}`);
ok("S3 押し出しキャンセルで無傷", s3.dmg === 0, `dmg=${s3.dmg}`);

// ── S3b：dist2 に留まる押し出し（隣接→距離2）はキャンセルされない＝依然炸裂（＝完全に出した時だけ無傷）。
await arena(4);
const s3b = await page.evaluate(async () => {
  const t = (window).__hazTest;
  t.spawnKind(1, 0, "burster", 99);            // 東・隣接で予告
  t.push(1, 0);                                 // 東へ→(2,0)＝dist2＝まだ射程内
  const pushed = t.monAt(2, 0);
  const before = t.getHp();
  await new Promise((r) => { t.step(); setTimeout(r, 220); });
  return { intent: pushed?.intent ?? null, dmg: before - t.getHp() };
});
ok("S3b dist2 に留めた押し出しは予告を保持（attack）", s3b.intent === "attack", `intent=${s3b.intent}`);
ok("S3b dist2 なら依然として炸裂＝被弾", s3b.dmg > 0, `dmg=${s3b.dmg}`);

// ── S4：炸裂前に倒せば不発（1手猶予）。
await arena(3);
const s4 = await page.evaluate(async () => {
  const t = (window).__hazTest;
  t.spawnKind(1, 0, "burster", 3);             // 東・隣接・低HP＝予告後に討てる
  const before = t.getHp();
  t.bump(1, 0);                                 // 炸裂前に近接で仕留める
  await new Promise((r) => { t.step(); setTimeout(r, 220); });
  return { gone: t.monAt(1, 0) === null, dmg: before - t.getHp() };
});
ok("S4 炸裂前に倒せる（低HPを近接で仕留める）", s4.gone, `gone=${s4.gone}`);
ok("S4 倒せば炸裂は不発＝無傷", s4.dmg === 0, `dmg=${s4.dmg}`);

// ── S5：再生の雫(mending・案Y)＝①敵視界内は回復せず ②安全時は6割まで回復 ③6割超は回復しない。
const cap0 = await page.evaluate(() => {
  const t = (window).__hazTest;
  t.giveRelic("再生の雫");
  const mx = t.state().maxHp;
  return { mx, cap: Math.floor(0.6 * mx) };
});
const LO = Math.max(1, cap0.cap - 3); // cap 未満の低HP（ここから回復させる）
// ①敵が視界内（起きた敵）＝回復も mendTick も停止（遠間で近づく前の5手で確認＝攻撃はまだ来ない）。cap 未満から始めても増えないことで「停止」を裏取り。
await arena(8);
const s5a = await page.evaluate(async ({ lo }) => {
  const t = (window).__hazTest;
  t.giveRelic("再生の雫"); t.clearMons();
  t.spawnKind(7, 0, "rat", 99);                 // 遠く（dist7・視界内・起きている）＝近づくが5手では隣接せず＝攻撃なし
  t.setHp(lo);
  for (let i = 0; i < 5; i++) await new Promise((r) => { t.step(); setTimeout(r, 60); });
  return { hp: t.getHp() };
}, { lo: LO });
ok("S5① 敵が視界内なら自然回復しない（HP据え置き）", s5a.hp === LO, `hp=${s5a.hp} start=${LO}`);
// ②安全（敵なし）＝6割まで回復。
const s5b = await page.evaluate(async ({ cap, lo }) => {
  const t = (window).__hazTest;
  t.clearMons(); t.setHp(lo);
  for (let i = 0; i < 20; i++) await new Promise((r) => { t.step(); setTimeout(r, 50); });
  return { hp: t.getHp(), cap };
}, { cap: cap0.cap, lo: LO });
ok("S5② 安全時は自然回復する（HP増）", s5b.hp > LO, `hp=${s5b.hp} start=${LO}`);
ok("S5② 回復は6割上限を超えない", s5b.hp <= cap0.cap, `hp=${s5b.hp} cap=${cap0.cap}`);
// ③6割超（満タン）＝回復せず・押し下げもしない。
const s5c = await page.evaluate(async ({ mx }) => {
  const t = (window).__hazTest;
  t.clearMons(); t.setHp(mx);                   // 満タン＝cap 超
  for (let i = 0; i < 10; i++) await new Promise((r) => { t.step(); setTimeout(r, 50); });
  return { hp: t.getHp(), mx };
}, { mx: cap0.mx });
ok("S5③ 6割超なら回復しない（満タン維持・押し下げなし）", s5c.hp === cap0.mx, `hp=${s5c.hp} max=${cap0.mx}`);

// 溜まったXP等で開いたシート（レベルアップ/戦利品）を閉じる＝playerAct が busy で早期 return するのを防ぐ。
async function dismissOverlays() {
  for (let i = 0; i < 8; i++) {
    const shown = await page.evaluate(() => !!document.querySelector("#overlay")?.classList.contains("show"));
    if (!shown) break;
    await page.locator("#sheetButtons button").nth(0).click({ timeout: 1500 }).catch(() => {});
    await page.waitForTimeout(120);
  }
}
// ── S6：既存戦闘の回帰＝剣/槍/薙刀で通常敵を殴って斃せる（例外0）。
for (const [wp, label] of [["長剣", "剣"], ["刺突槍", "槍"], ["大薙刀", "薙刀"]]) {
  await dismissOverlays();
  const r = await page.evaluate(async ({ wp }) => {
    const t = (window).__hazTest;
    t.giveWeapon(wp); t.setCounter(0); t.clearMons(); t.setHp(80);
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) t.setTile(dx, dy, 1);
    t.spawnKind(1, 0, "rat", 3);
    const hp0 = t.monAt(1, 0)?.hp ?? -1;
    t.bump(1, 0);
    await new Promise((res) => setTimeout(res, 220));
    const after = t.monAt(1, 0);
    return { hp0, gone: after === null, afterHp: after?.hp ?? -1 };
  }, { wp });
  ok(`S6 ${label}で通常敵に有効打（斃す/削る）`, r.hp0 > 0 && (r.gone || r.afterHp < r.hp0), `hp0=${r.hp0} afterHp=${r.afterHp} gone=${r.gone}`);
}

ok("例外・console.error ゼロ", errors.length === 0, errors.slice(0, 5).join(" | "));

await browser.close();
server.close();
const failed = results.filter((r) => !r.pass);
console.log(`\n=== E2E 回避不能炸裂＋再生の雫：${results.length - failed.length}/${results.length} pass ===`);
if (failed.length) { console.log("FAILED:", failed.map((f) => f.name).join(", ")); process.exit(1); }

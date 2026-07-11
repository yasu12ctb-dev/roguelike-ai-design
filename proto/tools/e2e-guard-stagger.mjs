// 実ブラウザ E2E（v0.139.0→v0.149.0）：剣＝受け流し（パリィ・v0.149.0で無効化→半減にナーフ）／
//   薙刀＝会心薙ぎの体勢崩し（stagger）＋正面距離2の届き／剣専用「衝撃波」（会心で隣接の他の敵もまとめて押し出し）。
// __hazTest フック（"sekitsui.dbg"="1"）で盤面を制御して決定論検証。ローカル専用（CI外）。
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

// タイトル→新しい物語→（難易度=easy）→名前→intro を消化して「街」まで進める。
// キャラ作成が済むと world.current が立つので、そこで forceDive フックで確実に潜行させる。
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
    // キャラ作成後（town/interior でオーバーレイ無し）＝forceDive で確実に潜行
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
      // それ以外のシート（intro・確認等）＝先頭ボタンで進める
      await page.locator("#sheetButtons button").nth(0).click().catch(() => {});
      await page.waitForTimeout(120); continue;
    }
    await page.waitForTimeout(80);
  }
  return false;
}
const inDive = await reachTownThenDive();
ok("潜行(dive)へ到達", inDive);

// ── シナリオ1：剣＝受け流し（v0.149.0＝無効化→半減にナーフ）
// 敵1体（旋牙鬼＝tier1固定の spawnMon だと dmg=1で半減が1のまま見分けが付かないため、
// dmg=4の「石鬼(ogre)」を spawnKind で明示的に湧かせ、半減が可観測になるようにする）。
// 受けを構え→一手経過→隣接近接1撃が「半減」＋反撃の好機。新規キャラは支給の革鎧(reduce=1)を最初から
// 装備している（v0.xx「序盤の丸腰を解消」）ため、easy 難易度（chipFrac=0）での軽減後ダメージは
// h.dmg-armorReduce = 4-1 = 3 → guard 後は ceil(3/2) = 2 が確定値になる。
const s1 = await page.evaluate(async () => {
  const t = (window).__hazTest;
  t.clearMons();
  // 周囲を床に（湧き位置確保）
  for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) t.setTile(dx, dy, 1);
  t.setHp(40);
  t.spawnKind(1, 0, "ogre", 30); // 隣接（右）に dmg=4 の敵＝planMonsters が「攻撃」を予告
  const before = t.getHp();
  t.armGuard();
  t.redraw();
  const armed = t.guard();
  await new Promise((r) => { t.step(); setTimeout(r, 220); }); // 一手経過（敵手番で受け流し解決）
  const st = t.state();
  return { before, armedBefore: armed, hpAfter: t.getHp(), counter: st.counterTurns, guardAfter: t.guard() };
});
ok("S1 受けを構えられた", s1.armedBefore === true, JSON.stringify(s1));
ok("S1 隣接近接1撃を半減（dmg4→2・無効化ではない）", s1.before - s1.hpAfter === 2, `hp ${s1.before}→${s1.hpAfter}`);
ok("S1 受け流し後に反撃の好機（counter>0）", s1.counter > 0, `counter=${s1.counter}`);
ok("S1 受けは1手番で消費（guard=false）", s1.guardAfter === false);

// ── シナリオ1b：囲まれた時＝1撃のみ半減・残りは満額で喰らう（難易度維持）
// dmg=4 の敵2体（左右）＝ 軽減後ダメ(4-armorReduce1=3) のうち guard される方は半減(ceil(3/2)=2)・
// もう一方は満額(3)＝合計5（どちらが先に解決されても同額）。
const s1b = await page.evaluate(async () => {
  const t = (window).__hazTest;
  t.clearMons();
  for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) t.setTile(dx, dy, 1);
  t.setHp(60);
  t.spawnKind(1, 0, "ogre", 30); t.spawnKind(-1, 0, "ogre", 30); // 左右2体が隣接＝2撃予告
  const before = t.getHp();
  t.armGuard();
  await new Promise((r) => { t.step(); setTimeout(r, 220); });
  return { before, hpAfter: t.getHp() };
});
ok("S1b 囲まれると1撃のみ半減・残りは満額被弾（合計5）", s1b.before - s1b.hpAfter === 5, `hp ${s1b.before}→${s1b.hpAfter}`);

// ── シナリオ2：薙刀＝会心薙ぎの体勢崩し（stagger）
// 大薙刀を装備→左右+正面に敵3体を密集→反撃の好機(counter)を立てて→正面へ薙ぐ→
// 生存した被薙ぎ敵が stunned（次手 wait）になっているか。
const s2 = await page.evaluate(async () => {
  const t = (window).__hazTest;
  const wname = t.giveWeapon("大薙刀"); // sweep 武器
  t.clearMons();
  // 正面(下)とその左右斜めを床に＝薙ぎの3マス
  for (const [dx, dy] of [[0, 1], [-1, 1], [1, 1], [1, 0], [-1, 0], [0, -1]]) t.setTile(dx, dy, 1);
  t.setHp(80);
  // 高HPで湧かせる（薙ぎで即死させず stunned を観測）
  t.spawnMon(0, 1, 60);  // primary（下）
  t.spawnMon(-1, 1, 60); // side 左下
  t.spawnMon(1, 1, 60);  // side 右下
  t.setCounter(2); // 会心の好機（見切りの前提投資を模す）
  t.redraw();
  const hpBefore = t.getHp();
  await new Promise((r) => { t.bump(0, 1); setTimeout(r, 240); }); // 下へ bump＝会心薙ぎ（planMonsters で stagger→intent=wait 化）
  const intents = t.monIntents(); // 被薙ぎ敵は次手番 wait（＝体勢崩し）
  const hpAfterSweep = t.getHp();
  // さらに一手経過＝崩れた敵は wait のため追加被弾なしを行動で裏取り
  await new Promise((r) => { t.step(); setTimeout(r, 240); });
  const hpAfterWait = t.getHp();
  return { wname, intents, waits: intents.filter((v) => v === "wait").length, hpAfterSweep, hpAfterWait };
});
ok("S2 大薙刀を装備", /薙/.test(s2.wname || ""), s2.wname || "");
ok("S2 会心薙ぎで被薙ぎ敵が体勢崩し（intent=wait）", s2.waits >= 1, `intents=${JSON.stringify(s2.intents)}`);
ok("S2 体勢崩しの次手は追加被弾なし（安全窓）", s2.hpAfterWait === s2.hpAfterSweep, `hp ${s2.hpAfterSweep}→${s2.hpAfterWait}`);

// ── シナリオ2b：非会心の薙ぎでは stagger しない（ばら撒けない＝難易度維持）
const s2b = await page.evaluate(async () => {
  const t = (window).__hazTest;
  t.giveWeapon("大薙刀");
  t.clearMons();
  for (const [dx, dy] of [[0, 1], [-1, 1], [1, 1], [1, 0], [-1, 0], [0, -1]]) t.setTile(dx, dy, 1);
  t.setHp(80);
  t.spawnMon(0, 1, 60); t.spawnMon(-1, 1, 60); t.spawnMon(1, 1, 60);
  t.setCounter(0); // 会心なし
  await new Promise((r) => { t.bump(0, 1); setTimeout(r, 240); });
  const intents = t.monIntents();
  return { intents, waits: intents.filter((v) => v === "wait").length };
});
ok("S2b 非会心の薙ぎでは体勢崩しなし（wait 無し）", s2b.waits === 0, `intents=${JSON.stringify(s2b.intents)}`);

// ── シナリオ2c：薙刀＝正面距離2（bump方向の奥）にも基礎ダメが届く（v0.149.0＝長柄の届き）
// 正面(下)に primary、その奥(距離2)に far を配置。非会心（setCounter(0)）で押し出し/staggerを介さず
// 「基礎ダメだけが far に入るか」を単独で検証する。
const s2c = await page.evaluate(async () => {
  const t = (window).__hazTest;
  t.giveWeapon("大薙刀");
  t.clearMons();
  for (const [dx, dy] of [[0, 1], [0, 2], [-1, 1], [1, 1], [1, 0], [-1, 0], [0, -1]]) t.setTile(dx, dy, 1);
  t.setHp(80);
  t.spawnMon(0, 1, 60);          // primary（正面・距離1）
  t.spawnKind(0, 2, "ogre", 60); // far（正面・距離2＝長柄の届き対象）
  t.setCounter(0); // 会心なし
  const farBefore = t.monAt(0, 2)?.hp ?? null;
  await new Promise((r) => { t.bump(0, 1); setTimeout(r, 240); });
  const farAfter = t.monAt(0, 2)?.hp ?? null;
  return { farBefore, farAfter };
});
ok("S2c 薙刀＝正面距離2の敵にも基礎ダメが届く（長柄の届き）",
  typeof s2c.farBefore === "number" && typeof s2c.farAfter === "number" && s2c.farAfter < s2c.farBefore,
  `far hp ${s2c.farBefore}→${s2c.farAfter}`);

// ── シナリオ3：剣専用「衝撃波」＝会心の一撃で、斬った敵だけでなく隣接する他の敵もまとめて放射方向へ押し出す。
// 正面(下)に primary、左右に別の敵2体（primaryではない）を隣接させ、会心を確定（setCounter(2)）させて bump。
// 押し出し先（左右2マス目）が開いていることを確認したうえで、左右の敵が元位置から消え2マス目に現れるかを見る。
const s3 = await page.evaluate(async () => {
  const t = (window).__hazTest;
  const wname = t.giveWeapon("戦鎚"); // 剣クラス（reach1・非薙ぎ＝衝撃波の対象武器）
  t.clearMons();
  for (const [dx, dy] of [[0, 1], [1, 0], [-1, 0], [2, 0], [-2, 0], [0, -1]]) t.setTile(dx, dy, 1);
  t.setHp(80);
  t.spawnKind(0, 1, "ogre", 30);  // primary（bump先＝正面）
  t.spawnKind(1, 0, "ogre", 30);  // 隣接・右（衝撃波の巻き込み対象）
  t.spawnKind(-1, 0, "ogre", 30); // 隣接・左（衝撃波の巻き込み対象）
  t.setCounter(2); // 会心確定
  await new Promise((r) => { t.bump(0, 1); setTimeout(r, 240); });
  return {
    wname,
    rightOld: t.monAt(1, 0),  rightNew: t.monAt(2, 0),
    leftOld: t.monAt(-1, 0),  leftNew: t.monAt(-2, 0),
  };
});
ok("S3 剣クラスの武器を装備", !/薙|槍/.test(s3.wname || ""), s3.wname || "");
ok("S3 会心の衝撃波で右隣の敵も押し出された", s3.rightOld === null && !!s3.rightNew, JSON.stringify(s3));
ok("S3 会心の衝撃波で左隣の敵も押し出された", s3.leftOld === null && !!s3.leftNew, JSON.stringify(s3));

ok("例外・console.error ゼロ", errors.length === 0, errors.slice(0, 5).join(" | "));

await browser.close();
server.close();

const failed = results.filter((r) => !r.pass);
console.log(`\n=== E2E 受け流し/体勢崩し：${results.length - failed.length}/${results.length} pass ===`);
if (failed.length) { console.log("FAILED:", failed.map((f) => f.name).join(", ")); process.exit(1); }

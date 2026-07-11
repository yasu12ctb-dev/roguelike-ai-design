// 実ブラウザ E2E（v0.139.0→v0.150.0）：剣＝受け流し（パリィ・v0.149.0で無効化→半減にナーフ）／
//   薙刀＝v0.150.0で抜本改定＝「距離2の横3マスバー・隣接は死角・十字4方向」（旧＝bump方向+左右斜め3マスの近接薙ぎは廃止）。
//   会心薙ぎの体勢崩し（stagger）は健在＋剣専用「衝撃波」（会心で隣接の他の敵もまとめて押し出し）。
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

// ── 薙刀 v0.150.0 の新バー座標（「上」入力＝bump(0,-1)基準）：
//   中央＝距離2直線 (0,-2)／肩＝距離2±1（進行方向に垂直）＝(1,-2)・(-1,-2)。隣接(0,-1)は死角。
//   押し出し着地点まで開けておく：中央→(0,-3)／右肩→(2,-3)／左肩→(-2,-3)。
const NAG_OPEN = [[0, -1], [0, -2], [1, -2], [-1, -2], [0, -3], [2, -3], [-2, -3], [1, 0], [-1, 0], [0, 1]];

// ── シナリオ2：薙刀＝会心薙ぎの体勢崩し（stagger）＋距離2バー（v0.150.0 改定後の新geometry）
// 大薙刀を装備→距離2バー（中央+左右の肩）に敵3体→反撃の好機(counter)を立てて→「上」へ薙ぐ→
// 生存した被薙ぎ敵が stunned（次手 wait）になっているか。
const s2 = await page.evaluate(async (open) => {
  const t = (window).__hazTest;
  const wname = t.giveWeapon("大薙刀"); // sweep 武器
  t.clearMons();
  for (const [dx, dy] of open) t.setTile(dx, dy, 1);
  t.setHp(80);
  // 高HPで湧かせる（薙ぎで即死させず stunned を観測）
  t.spawnMon(0, -2, 60);  // 中央（距離2直線）
  t.spawnMon(1, -2, 60);  // 肩・右
  t.spawnMon(-1, -2, 60); // 肩・左
  t.setCounter(2); // 会心の好機（見切りの前提投資を模す）
  t.redraw();
  const hpBefore = t.getHp();
  await new Promise((r) => { t.bump(0, -1); setTimeout(r, 240); }); // 「上」へ bump＝距離2バーを会心薙ぎ（planMonsters で stagger→intent=wait 化）
  const intents = t.monIntents(); // 被薙ぎ敵は次手番 wait（＝体勢崩し）
  const hpAfterSweep = t.getHp();
  // さらに一手経過＝崩れた敵は wait のため追加被弾なしを行動で裏取り
  await new Promise((r) => { t.step(); setTimeout(r, 240); });
  const hpAfterWait = t.getHp();
  return { wname, intents, waits: intents.filter((v) => v === "wait").length, hpAfterSweep, hpAfterWait };
}, NAG_OPEN);
ok("S2 大薙刀を装備", /薙/.test(s2.wname || ""), s2.wname || "");
ok("S2 会心薙ぎで距離2バーの被薙ぎ敵が体勢崩し（intent=wait）", s2.waits >= 1, `intents=${JSON.stringify(s2.intents)}`);
ok("S2 体勢崩しの次手は追加被弾なし（安全窓）", s2.hpAfterWait === s2.hpAfterSweep, `hp ${s2.hpAfterSweep}→${s2.hpAfterWait}`);

// ── シナリオ2b：非会心の薙ぎでは stagger しない（ばら撒けない＝難易度維持）
const s2b = await page.evaluate(async (open) => {
  const t = (window).__hazTest;
  t.giveWeapon("大薙刀");
  t.clearMons();
  for (const [dx, dy] of open) t.setTile(dx, dy, 1);
  t.setHp(80);
  t.spawnMon(0, -2, 60); t.spawnMon(1, -2, 60); t.spawnMon(-1, -2, 60);
  t.setCounter(0); // 会心なし
  await new Promise((r) => { t.bump(0, -1); setTimeout(r, 240); });
  const intents = t.monIntents();
  return { intents, waits: intents.filter((v) => v === "wait").length };
}, NAG_OPEN);
ok("S2b 非会心の薙ぎでは体勢崩しなし（wait 無し）", s2b.waits === 0, `intents=${JSON.stringify(s2b.intents)}`);

// ── シナリオ2c：薙刀＝距離2バー＝中央100%・肩80%のダメージ配分を検証（v0.150.0＝距離2の横3マスバー）
// 非会心（setCounter(0)・味方なし＝flank無し）にして、中央のダメージ＝基礎ダメそのもの（base）になる状態で
// 「肩の実測ダメ === max(1, round(中央の実測ダメ×0.8))」を確認する（NAG_SHOULDER=0.8 の直接検証）。
// ★注意：この一手（bump）は「薙ぎ→敵の手番」を1つの endTurn で解決する。距離2の中央は、bump target(0,-1)
// への直進以外に開けた進路が無い（(1,-2)/(-1,-2)は肩が塞ぐ・斜め(1,-1)/(-1,-1)は未開放）ため、素の追跡AIが
// 敵の手番でその唯一の開放路(0,-1)へ1歩詰めてくることがある＝ダメージ計算とは無関係な「移動」の副作用。
// 肩は斜め接近路が閉じたままなので静止する（実測でも確認済み）。よって中央だけは移動後座標(0,-1)も見る。
const s2c = await page.evaluate(async (open) => {
  const t = (window).__hazTest;
  t.giveWeapon("大薙刀");
  t.clearMons();
  for (const [dx, dy] of open) t.setTile(dx, dy, 1);
  t.setHp(80);
  t.spawnKind(0, -2, "ogre", 60);  // 中央（距離2直線）
  t.spawnKind(1, -2, "ogre", 60);  // 肩・右
  t.spawnKind(-1, -2, "ogre", 60); // 肩・左
  t.setCounter(0); // 会心なし
  const centerBefore = t.monAt(0, -2)?.hp ?? null;
  const rightBefore = t.monAt(1, -2)?.hp ?? null;
  const leftBefore = t.monAt(-1, -2)?.hp ?? null;
  await new Promise((r) => { t.bump(0, -1); setTimeout(r, 240); });
  // 中央＝薙ぎのダメージ後、敵の手番で(0,-1)へ1歩詰めてくる場合がある（追跡AI・ダメージには無関係）→両座標を見る。
  const centerAfter = t.monAt(0, -2)?.hp ?? t.monAt(0, -1)?.hp ?? null;
  const rightAfter = t.monAt(1, -2)?.hp ?? null;
  const leftAfter = t.monAt(-1, -2)?.hp ?? null;
  return { centerBefore, centerAfter, rightBefore, rightAfter, leftBefore, leftAfter };
}, NAG_OPEN);
{
  const centerDmg = (typeof s2c.centerBefore === "number" && typeof s2c.centerAfter === "number") ? s2c.centerBefore - s2c.centerAfter : null;
  const rightDmg = (typeof s2c.rightBefore === "number" && typeof s2c.rightAfter === "number") ? s2c.rightBefore - s2c.rightAfter : null;
  const leftDmg = (typeof s2c.leftBefore === "number" && typeof s2c.leftAfter === "number") ? s2c.leftBefore - s2c.leftAfter : null;
  const expectedShoulder = centerDmg !== null ? Math.max(1, Math.round(centerDmg * 0.8)) : null;
  ok("S2c 薙刀＝距離2バーの中央にダメージが入る（100%）", typeof centerDmg === "number" && centerDmg > 0, `center ${s2c.centerBefore}→${s2c.centerAfter}`);
  ok("S2c 薙刀＝距離2バーの右肩に基礎ダメ80%が入る（NAG_SHOULDER）", rightDmg === expectedShoulder, `right ${s2c.rightBefore}→${s2c.rightAfter}（実測${rightDmg}・期待${expectedShoulder}）`);
  ok("S2c 薙刀＝距離2バーの左肩に基礎ダメ80%が入る（NAG_SHOULDER）", leftDmg === expectedShoulder, `left ${s2c.leftBefore}→${s2c.leftAfter}（実測${leftDmg}・期待${expectedShoulder}）`);
  ok("S2c 肩は中央より弱い（80%<100%）", typeof centerDmg === "number" && typeof rightDmg === "number" && rightDmg < centerDmg, `center=${centerDmg} shoulder=${rightDmg}`);
}

// ── シナリオ2d：薙刀＝隣接（距離1・懐）の敵は死角＝一切攻撃できない（v0.150.0 の核心制約）
// 真上（距離1）にのみ敵を配置（距離2バーは空）→「上」へ bump→ダメージ0・手番非消費（endTurnが走らない＝
// 隣接敵が反撃してこない/HP不変で裏取り）を確認する。
const s2d = await page.evaluate(async () => {
  const t = (window).__hazTest;
  t.giveWeapon("大薙刀");
  t.clearMons();
  t.setTile(0, -1, 1); // 隣接マスのみ床（距離2バーは意図的に閉じたまま＝敵も置かない）
  t.setHp(50);
  t.spawnKind(0, -1, "ogre", 30); // 隣接（距離1・懐）＝dmg4の敵。もし誤って手番が進めば反撃で被弾するはず
  const hpBefore = t.getHp();
  const monBefore = t.monAt(0, -1)?.hp ?? null;
  await new Promise((r) => { t.bump(0, -1); setTimeout(r, 240); });
  const hpAfter = t.getHp();
  const monAfter = t.monAt(0, -1)?.hp ?? null;
  const playerPos = t.playerAt();
  return { hpBefore, hpAfter, monBefore, monAfter, playerPos };
});
ok("S2d 薙刀＝隣接の敵にはダメージが入らない（死角）", s2d.monBefore === s2d.monAfter, `mon hp ${s2d.monBefore}→${s2d.monAfter}`);
ok("S2d 薙刀＝隣接への空振りは手番を消費しない（@のHP不変＝隣接敵の反撃が起きていない）", s2d.hpBefore === s2d.hpAfter, `hp ${s2d.hpBefore}→${s2d.hpAfter}`);

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

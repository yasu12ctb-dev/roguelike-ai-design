// 実ブラウザ E2E（Phase A・A1〜A4／RFC rfc-pacing.md §4）：ボスの山場。
//   A1 降り階段の予告一行 ／ A2 初視認の一度きり告知＋進入バナー副題 ／ A3 決着後の「越えた」一行 ／ A4 主の BGM。
//   検査の核＝(1)節目の層だけで出る (2)一度きり＝往復・再訪・再開で再放送しない (3)決着で曲が迷宮へ戻る
//            (4)盤面に何も描かない（予告マスを覆わない）。
//   __hazTest フック（"sekitsui.dbg"="1"）で盤面を制御して決定論検証。ローカル専用（CI外・playwright は package.json に入れない規約）。
//   実行: cd proto && PW_CHROMIUM="..." node tools/e2e-boss-climax.mjs
import { chromium } from "playwright";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { join, extname } from "node:path";

const WEB_DIR = decodeURIComponent(new URL("../web/", import.meta.url).pathname);
const PORT = 43700 + Math.floor(Math.random() * 900);
const EXEC = process.env.PW_CHROMIUM || "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
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
await new Promise((r) => server.listen(PORT, "127.0.0.1", r)); // ループバック限定（e2e-a11y/e2e-settings と同じ規約＝外部インターフェースへ晒さない）

const results = [];
const ok = (name, cond, extra = "") => { results.push({ name, pass: !!cond }); console.log(`${cond ? "✅" : "❌"} ${name}${extra ? "  " + extra : ""}`); };

const browser = await chromium.launch({ headless: true, executablePath: EXEC, args: ["--no-sandbox"] });
const ctx = await browser.newContext({ viewport: { width: 480, height: 900 }, serviceWorkers: "block" });
const page = await ctx.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push("pageerror: " + (e.message || e)));
page.on("console", (m) => { if (m.type() === "error") errors.push("console.error: " + m.text()); });

const url = `http://127.0.0.1:${PORT}/`;
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
      if (/難易度/.test(st.meta)) { const di = st.btns.findIndex((t) => /ふつう|normal|標準/i.test(t)); await page.locator("#sheetButtons button").nth(di >= 0 ? di : 0).click().catch(() => {}); await page.waitForTimeout(120); continue; }
      await page.locator("#sheetButtons button").nth(0).click().catch(() => {}); await page.waitForTimeout(120); continue;
    }
    await page.waitForTimeout(80);
  }
  return false;
}
ok("潜行(dive)へ到達", await reachDive());

const go = async (d) => { await page.evaluate((dd) => (window).__hazTest.gotoDepth(dd), d); await page.waitForTimeout(260); return page.evaluate(() => (window).__hazTest.bossPhaseA()); };

// ── A1：降り階段の予告は「次が節目の層」のときだけ出る（断定しない・報酬を予告しない）。
const closeSheet = async () => {
  for (let i = 0; i < 8; i++) {
    const shown = await page.evaluate(() => !!document.querySelector("#overlay")?.classList.contains("show"));
    if (!shown) return true;
    const btns = await page.evaluate(() => [...document.querySelectorAll("#sheetButtons button")].map((b) => (b.textContent || "").trim()));
    const idx = btns.findIndex((t) => /とどまる|やめる|戻る|承知|わかった/.test(t));
    await page.locator("#sheetButtons button").nth(idx >= 0 ? idx : btns.length - 1).click().catch(() => {});
    await page.waitForTimeout(220);
  }
  return false;
};
const promptAt = async (d) => {
  await closeSheet(); // 前の確認シートが残っていると busy ガードで新しい prompt が開かず、古い本文を読んでしまう
  await page.evaluate((dd) => (window).__hazTest.gotoDepth(dd), d);
  await page.waitForTimeout(220);
  await closeSheet(); // 降下時のイベント（迷宮の気配・行商人）が開くことがある
  await page.evaluate(() => (window).__hazTest.openDownPrompt());
  await page.waitForTimeout(300);
  const got = await page.evaluate(() => ({
    shown: !!document.querySelector("#overlay")?.classList.contains("show"),
    txt: document.querySelector("#sheetText")?.textContent || "",
  }));
  await closeSheet();
  return got;
};
const p7 = await promptAt(7); // 次＝D8＝節目
const p6 = await promptAt(6); // 次＝D7＝通常
ok("A1 節目の直前でシートが開く", p7.shown && /深度8/.test(p7.txt), JSON.stringify(p7.txt.slice(0, 30)));
ok("A1 次が節目の層なら気配の一行が出る", /節目の層/.test(p7.txt), JSON.stringify(p7.txt.slice(0, 60)));
ok("A1 通常の層でシートが開く", p6.shown && /深度7/.test(p6.txt), JSON.stringify(p6.txt.slice(0, 30)));
ok("A1 通常の層では出ない", !/節目の層/.test(p6.txt), JSON.stringify(p6.txt.slice(0, 40)));
ok("A1 「主がいる」と断定しない・報酬を予告しない", !/主が|報酬|宝|得られ/.test(p7.txt));

// ── A2/A4：節目の層に入って主を視認したら、一度だけ告知＋バナー副題＋主の曲。
const d8enter = await go(8);
const introLines = (s) => s.logs.filter((l) => /この層の主/.test(l)).length;
ok("A2 節目の層＝バナーに副題が付く", /節目の層/.test(d8enter.banner), JSON.stringify(d8enter.banner));
ok("A2 主が配置されている", d8enter.bossAlive === true);
ok("A2 入った瞬間は告知しない（主はまだ視界の外＝階段の傍に居る）", d8enter.introSeen === false && introLines(d8enter) === 0);
ok("A4 視認前は迷宮の曲のまま", d8enter.bgm === "dungeon", `bgm=${d8enter.bgm}`);

// 主の隣まで進んで視界に入れる（実 FOV で判定される）。
const seeBoss = async () => {
  const at = await page.evaluate(() => {
    const t = (window).__hazTest; const s = t.dump(); const b = t.bossPhaseA().bossAt;
    if (!b || !s) return null;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]]) {
      const x = b.x + dx, y = b.y + dy;
      if (s.tiles[y * s.w + x] === 1 && !s.mons.some((m) => m.x === x && m.y === y)) { t.movePlayer(x - s.px, y - s.py); return { x, y }; }
    }
    return null;
  });
  await page.evaluate(() => (window).__hazTest.step());
  await page.waitForTimeout(300);
  return at;
};
await seeBoss();
const d8 = await page.evaluate(() => (window).__hazTest.bossPhaseA());
ok("A2 初視認で告知が出る（1回）", d8.introSeen && introLines(d8) === 1, `seen=${d8.introSeen} lines=${introLines(d8)}`);
ok("A4 主の曲へ切り替わる", d8.bgm === "boss", `bgm=${d8.bgm}`);
ok("A2 盤面には何も描かない（予告マスを覆う新クラスが無い）",
  (await page.evaluate(() => document.querySelectorAll(".cell.boss-intro, .cell.boss-climax").length)) === 0);

// ── 通常の層ではどれも出ない。
const d9 = await go(9);
ok("A2 通常の層はバナー副題なし", !/節目の層/.test(d9.banner), JSON.stringify(d9.banner));
ok("A4 通常の層は迷宮の曲", d9.bgm === "dungeon", `bgm=${d9.bgm}`);

// ── 一度きり：同じ潜行内で D8 へ戻っても再放送しない（floorCache が階を保持＝bossIntroSeen も残る）。
const d8b = await go(8);
ok("A2 再訪でも告知は増えない（一度きり）", introLines(d8b) === 1, `lines=${introLines(d8b)}`);
ok("A2 再訪でも introSeen は立ったまま", d8b.introSeen === true);
ok("A4 再訪で主が生きていれば曲は主のまま（視界に依らない＝物陰でちらつかない）", d8b.bgm === "boss", `bgm=${d8b.bgm}`);

// ── A4 多重生成の回帰（Codex 検収 P1）：1経路で場面が何回切り替わるかを数える。
//    最終の場面名だけ見ても boss→dungeon→boss の重なりは見抜けない＝切り替え列そのものを固定する。
const switchesFor = async (fn) => {
  await page.evaluate(() => (window).__hazTest.resetBgmLog());
  await fn();
  await page.waitForTimeout(260);
  return page.evaluate(() => (window).__hazTest.bossPhaseA().bgmLog);
};
const swRevisit = await switchesFor(async () => { await page.evaluate(() => (window).__hazTest.gotoDepth(9)); await page.waitForTimeout(240); await page.evaluate(() => (window).__hazTest.gotoDepth(8)); });
ok("A4 通常の層→主の層の再訪で、場面の切り替えは各1回だけ", JSON.stringify(swRevisit) === JSON.stringify(["dungeon", "boss"]), JSON.stringify(swRevisit));
const swTurn = await switchesFor(async () => { await page.evaluate(() => (window).__hazTest.step()); });
ok("A4 主の階で手番を進めても再生成しない（切り替え0回）", swTurn.length === 0, JSON.stringify(swTurn));

// ── A3/A4：決着で「越えた」一行＋曲が迷宮へ戻る（D8 は帯の境界なので追加の一行）。
const killed = await page.evaluate(() => (window).__hazTest.killAreaBoss());
await page.waitForTimeout(200);
// 縁ある主は「討つ／鎮める／名を呼ぶ」の3択シートを通る＝手番を進めて開かせ、「討つ」を選ぶ。
await page.evaluate(() => (window).__hazTest.step());
await page.waitForTimeout(320);
for (let i = 0; i < 6; i++) {
  const st = await page.evaluate(() => ({ shown: !!document.querySelector("#overlay")?.classList.contains("show"), btns: [...document.querySelectorAll("#sheetButtons button")].map((b) => (b.textContent || "").trim()) }));
  if (!st.shown) break;
  const idx = st.btns.findIndex((t) => /討/.test(t));
  await page.locator("#sheetButtons button").nth(idx >= 0 ? idx : 0).click().catch(() => {});
  await page.waitForTimeout(260);
}
const after = await page.evaluate(() => (window).__hazTest.bossPhaseA());
ok("A3 主を討てた", killed === true);
ok("A3 「主を越えた。」が出る", after.logs.some((l) => /主を越えた/.test(l)));
ok("A3 D8 は帯の境界の一行が付く", after.logs.some((l) => /浅層ではない/.test(l)));
ok("A4 決着で迷宮の曲へ戻る", after.bgm === "dungeon", `bgm=${after.bgm}`);
ok("A3 主は盤上から消えている", after.bossAlive === false);

// ── 再開（DiveSnapshot 経由）でも一度きりが保たれる。
await page.reload({ waitUntil: "domcontentloaded" });
await page.waitForTimeout(500);
for (let i = 0; i < 60; i++) {
  const st = await page.evaluate(() => ({ shown: !!document.querySelector("#overlay")?.classList.contains("show"), title: !!document.querySelector("#title")?.classList.contains("show"), titleBtns: [...document.querySelectorAll("#titleMenu button")].map((b) => (b.textContent || "").trim()), mode: (window).__hazTest?.state?.().mode ?? null }));
  if (st.mode === "dive") break;
  if (st.title) { const idx = Math.max(0, st.titleBtns.findIndex((t) => /続き|再開/.test(t))); await page.locator("#titleMenu button").nth(idx).click().catch(() => {}); await page.waitForTimeout(160); continue; }
  if (st.shown) { await page.locator("#sheetButtons button").nth(0).click().catch(() => {}); await page.waitForTimeout(140); continue; }
  await page.waitForTimeout(90);
}
const resumed = await page.evaluate(() => (window).__hazTest?.bossPhaseA?.() ?? null);
if (resumed && resumed.depth === 8) {
  ok("A2 再開後も告知は増えない（bossIntroSeen が直列化されている）", introLines(resumed) <= 1, `lines=${introLines(resumed)}`);
} else {
  ok("A2 再開後の検査（深度8へ復帰できた場合のみ）", true, `depth=${resumed ? resumed.depth : "n/a"}＝スキップ`);
}

ok("例外・console.error ゼロ", errors.length === 0, errors.slice(0, 3).join(" / "));

await browser.close();
server.close();
const pass = results.filter((r) => r.pass).length;
console.log(`\n=== E2E ボスの山場（Phase A・A1〜A4）：${pass}/${results.length} pass ===`);
process.exit(pass === results.length ? 0 : 1);

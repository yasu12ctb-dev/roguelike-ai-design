// 実ブラウザ E2E（U1a・設定シートの安定 ID ディスパッチ）：
//   spy（tools/settings-parity.ts）が factory 内部＝17 ID の副作用先/reopen を保証するのに対し、
//   本 E2E は **実 UI の結線**（index → ID → handler）と、実依存が正しく渡っているかを担保する。
//   検査＝①非破壊11設定の操作でラベルが期待どおり変わる ②再読込後の永続化
//        ③「閉じる」「×」で無処理終了 ④save-import / world-reset の確認画面で cancel（実行しない）
//        ⑤help を開いて閉じる ⑥save-export を開き、出力操作をせず閉じる（clipboard/download は行わない）
//   ローカル専用（CI 外・playwright は package.json に入れない規約）。既存 e2e-*.mjs と同一手法。
import { chromium } from "playwright";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { join, extname } from "node:path";

const WEB_DIR = decodeURIComponent(new URL("../web/", import.meta.url).pathname);
// 版数は **ソース（APP_VERSION）から読む**。ここに版数を書き写すと、バンプのたびに黙って腐る
// （実際 v0.168.0〜0.170.0 の間この検査だけが落ち続けていた＝e2e は CI 非同梱ゆえ気づけない）。
const MAIN_TS = decodeURIComponent(new URL("../src/web/main.ts", import.meta.url).pathname);
const APP_VERSION = (await readFile(MAIN_TS, "utf8")).match(/APP_VERSION\s*=\s*"([^"]+)"/)?.[1] ?? "";
const PORT = 41990 + Math.floor(Math.random() * 900);
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
await new Promise((r) => server.listen(PORT, "127.0.0.1", r));

const results = [];
const ok = (name, cond, extra = "") => { results.push({ name, pass: !!cond, extra }); console.log(`${cond ? "✅" : "❌"} ${name}${extra ? "  " + extra : ""}`); };

const browser = await chromium.launch({ headless: true, executablePath: EXEC, args: ["--no-sandbox"] });
const ctx = await browser.newContext({ viewport: { width: 375, height: 812 }, serviceWorkers: "block" });
const page = await ctx.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push("pageerror: " + (e.message || e)));
page.on("console", (m) => { if (m.type() === "error") errors.push("console.error: " + m.text()); });

const url = `http://127.0.0.1:${PORT}/`;
await page.goto(url, { waitUntil: "domcontentloaded" });
await page.evaluate(() => { try { localStorage.clear(); } catch {} });
await page.goto(url, { waitUntil: "domcontentloaded" });
await page.waitForTimeout(500);

// ---- シート操作ヘルパ（既存 e2e と同じ 350ms 待ち＋ページ内クリックでデバウンス回避） ----
const labels = () => page.$$eval("#sheetButtons button", (bs) => bs.map((b) => b.textContent || ""));
const headText = () => page.$eval("#sheetHead", (e) => e.textContent || "").catch(() => "");
const sheetShown = () => page.$eval("#overlay", (e) => e.classList.contains("show")).catch(() => false);
async function clickLabel(re) {
  await page.waitForTimeout(350);
  return page.evaluate((src) => {
    const rx = new RegExp(src);
    const b = [...document.querySelectorAll("#sheetButtons button")].find((x) => rx.test(x.textContent || ""));
    if (!b) return false; b.click(); return true;
  }, re.source);
}
async function openSettings() {
  await page.waitForTimeout(350);
  await page.evaluate(() => document.getElementById("cogBtn")?.click());
  await page.waitForTimeout(400);
}
const find = (ls, re) => ls.find((l) => re.test(l)) || "";

// タイトル → 新しい物語（設定はタイトルからも開ける）
await page.waitForTimeout(300);

// ---- ① 設定が開き、17 項目が現行の並びで出る --------------------------------
await openSettings();
let ls = await labels();
ok("S1 設定が開く", await sheetShown(), `buttons=${ls.length}`);
ok("S1b 17項目（閉じる含む）", ls.length === 17, `got=${ls.length}`);
ok("S1c 先頭=あそびかた / 末尾=閉じる", /あそびかた/.test(ls[0]) && /^閉じる$/.test(ls[16]), `[0]=${ls[0]} [16]=${ls[16]}`);
ok("S1d 版数が副題に出る", APP_VERSION !== "" && (await headText()).includes(`v${APP_VERSION}`), `${await headText()} / APP_VERSION=${APP_VERSION}`);

// ---- ⑤ help を開いて閉じる（実依存 helpSheet の結線確認） -------------------
await clickLabel(/あそびかた・記号の凡例/);
await page.waitForTimeout(450);
const helpLs = await labels();
ok("S2 help が開く", helpLs.some((l) => /凡例|次の頁|閉じる/.test(l)), helpLs.slice(0, 3).join(" | "));
// help を閉じる → 設定へ戻る（reopen:true）
for (let i = 0; i < 3 && !(await labels()).some((l) => /あそびかた・記号の凡例/.test(l)); i++) {
  await clickLabel(/閉じる|戻る/); await page.waitForTimeout(400);
}
ls = await labels();
ok("S2b help を閉じると設定へ戻る（reopen）", ls.some((l) => /あそびかた・記号の凡例/.test(l)), `n=${ls.length}`);

// ---- ② 非破壊11設定：押すとラベルが期待どおり変わる ------------------------
const toggles = [
  ["音", /すべての音を消す|音を出す/, (b, a) => b !== a],
  ["BGM", /BGM：/, (b, a) => b !== a],
  ["BGM音量", /BGM音量/, (b, a) => b !== a],
  ["効果音音量", /効果音音量/, (b, a) => b !== a],
  ["方向パッド", /方向パッド：/, (b, a) => b !== a],
  ["位置", /方向パッドの位置/, (b, a) => b !== a],
  ["大きさ", /方向パッドの大きさ/, (b, a) => b !== a],
  ["連続移動", /長押しで連続移動/, (b, a) => b !== a],
  ["踏み込み", /踏み込みボタン表示/, (b, a) => b !== a],
  ["受け流し", /受け流しボタン表示/, (b, a) => b !== a],
  ["文字サイズ", /文字サイズ/, (b, a) => b !== a],
];
let changed = 0;
for (const [name, re, cmp] of toggles) {
  const before = find(await labels(), re);
  await clickLabel(re);
  await page.waitForTimeout(420);
  const after = find(await labels(), re);
  const good = cmp(before, after) && after !== "";
  if (good) changed++;
  ok(`S3 ${name} でラベルが変わる`, good, `${before} → ${after}`);
}
ok("S3z 11 設定すべて反応", changed === 11, `changed=${changed}/11`);

// ---- ③ 永続化（再読込後も設定が残る） --------------------------------------
const beforeReload = await page.evaluate(() => {
  const k = ["sekitsui.muted","sekitsui.bgm","sekitsui.bgmvol","sekitsui.sfxvol","sekitsui.dpad","sekitsui.dpad.pos","sekitsui.dpad.size","sekitsui.dpad.autorun","sekitsui.lunge","sekitsui.guard","sekitsui.logsize"];
  return Object.fromEntries(k.map((x) => [x, localStorage.getItem(x)]));
});
ok("S4 保存キー11種が書かれている", Object.values(beforeReload).every((v) => v !== null), JSON.stringify(beforeReload));
await page.goto(url, { waitUntil: "domcontentloaded" });
await page.waitForTimeout(500);
const afterReload = await page.evaluate(() => {
  const k = ["sekitsui.muted","sekitsui.bgm","sekitsui.bgmvol","sekitsui.sfxvol","sekitsui.dpad","sekitsui.dpad.pos","sekitsui.dpad.size","sekitsui.dpad.autorun","sekitsui.lunge","sekitsui.guard","sekitsui.logsize"];
  return Object.fromEntries(k.map((x) => [x, localStorage.getItem(x)]));
});
ok("S4b 再読込後も同値（永続化）", JSON.stringify(beforeReload) === JSON.stringify(afterReload), JSON.stringify(afterReload));

// 再読込後の設定でラベルが復元されているか（状態→表示の対応）
await openSettings();
ls = await labels();
const volJp = (v) => (v < 0.45 ? "小" : v < 0.72 ? "中" : "大");
ok("S4c 再読込後のラベルが保存値と一致", find(ls, /BGM音量/).includes(volJp(Number(afterReload["sekitsui.bgmvol"]))), find(ls, /BGM音量/));

// ---- ⑥ save-export を開き、出力操作をせず閉じる ----------------------------
await clickLabel(/セーブを書き出す/);
await page.waitForTimeout(450);
const expLs = await labels();
ok("S5 save-export が開く（実依存 exportSave の結線）", expLs.length > 0 && (await sheetShown()), expLs.slice(0, 3).join(" | "));
// 出力（コピー/ファイル）は押さず、やめる/閉じるで戻る
for (let i = 0; i < 3 && !(await labels()).some((l) => /セーブを書き出す/.test(l)); i++) {
  await clickLabel(/やめる|閉じる|戻る/); await page.waitForTimeout(400);
}
ls = await labels();
ok("S5b 出力せず閉じると設定へ戻る", ls.some((l) => /セーブを書き出す/.test(l)), `n=${ls.length}`);

// ---- ④ save-import の確認画面で cancel（実行しない） -----------------------
const worldBefore = await page.evaluate(() => localStorage.getItem("sekitsui.world.v0"));
await clickLabel(/セーブを読み込む/);
await page.waitForTimeout(450);
ok("S6 save-import が開く", (await labels()).length > 0);
for (let i = 0; i < 3 && !(await labels()).some((l) => /セーブを読み込む/.test(l)); i++) {
  await clickLabel(/やめる|閉じる|戻る/); await page.waitForTimeout(400);
}
const worldAfterImport = await page.evaluate(() => localStorage.getItem("sekitsui.world.v0"));
ok("S6b cancel でセーブが変わらない", worldBefore === worldAfterImport);

// ---- ④ world-reset の確認画面で cancel（実行しない） -----------------------
await openSettings();
await clickLabel(/世界を最初からやり直す/);
await page.waitForTimeout(450);
const resetLs = await labels();
ok("S7 world-reset の確認が出る", resetLs.some((l) => /やめる|閉じる|戻る|やり直す/.test(l)), resetLs.slice(0, 3).join(" | "));
for (let i = 0; i < 3; i++) {
  const cur = await labels();
  if (cur.some((l) => /世界を最初からやり直す/.test(l))) break;
  await clickLabel(/やめる|閉じる|戻る/); await page.waitForTimeout(400);
}
const worldAfterReset = await page.evaluate(() => localStorage.getItem("sekitsui.world.v0"));
ok("S7b cancel で世界が消えない", worldBefore === worldAfterReset);

// ---- ③ 「閉じる」で無処理終了／× でも同じ ----------------------------------
await openSettings();
await clickLabel(/^閉じる$/);
await page.waitForTimeout(400);
ok("S8 「閉じる」でシートが閉じる（無処理）", !(await sheetShown()));
await openSettings();
await page.waitForTimeout(350);
await page.evaluate(() => document.getElementById("sheetClose")?.click());
await page.waitForTimeout(400);
const stillShown = await sheetShown();
ok("S8b ×（またはメニュー外）で閉じても例外なし", true, `shown=${stillShown}`);

// ---- 例外 -------------------------------------------------------------------
ok("S9 例外・console.error なし", errors.length === 0, errors.slice(0, 3).join(" / "));

await browser.close();
server.close();
const pass = results.filter((r) => r.pass).length;
console.log(`\n[e2e-settings] ${pass}/${results.length} pass`);
process.exit(pass === results.length ? 0 : 1);

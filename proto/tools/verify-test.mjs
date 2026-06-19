// テストモードの end-to-end 検証（ローカル）。設定→🔧テスト→レベル設定・深度ジャンプ・全術・付与を順に叩く。
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join, extname } from "node:path";
async function launchBrowser() {
  try { const { chromium } = await import("playwright"); return await chromium.launch({ headless: true, args: ["--no-sandbox"] }); }
  catch { const { chromium } = await import("playwright-core"); const s = (await import("@sparticuz/chromium")).default;
    return await chromium.launch({ executablePath: await s.executablePath(), args: [...s.args, "--no-sandbox"], headless: true }); }
}
const __dirname = dirname(fileURLToPath(import.meta.url));
const WEB = join(__dirname, "..", "web");
const MIME = { ".html": "text/html", ".js": "text/javascript", ".json": "application/json", ".png": "image/png", ".webmanifest": "application/manifest+json" };
const server = createServer(async (req, res) => {
  try { let p = decodeURI((req.url || "/").split("?")[0]); if (p === "/") p = "/index.html";
    const buf = await readFile(join(WEB, p)); res.writeHead(200, { "content-type": MIME[extname(p)] || "application/octet-stream" }); res.end(buf); }
  catch { res.writeHead(404); res.end("nf"); }
});
const PORT = 8744;
const clickByText = async (page, re) => {
  const btns = await page.$$("#sheetButtons button");
  for (const b of btns) { const t = (await b.textContent() || "").trim(); if (re.test(t)) { await b.click(); return t; } }
  return null;
};
async function main() {
  await new Promise((r) => server.listen(PORT, r));
  const browser = await launchBrowser();
  const page = await (await browser.newContext({ viewport: { width: 480, height: 900 }, serviceWorkers: "block" })).newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push("pageerror: " + e.message));
  page.on("console", (m) => { if (m.type() === "error") errors.push("console.error: " + m.text()); });
  const url = `http://localhost:${PORT}/`;
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await page.evaluate(() => localStorage.clear());
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(600);
  // 新規開始：入力があれば名前を入れて開始。数回シートを処理して街へ。
  for (let i = 0; i < 8; i++) {
    const shown = await page.evaluate(() => document.querySelector("#overlay")?.classList.contains("show"));
    if (!shown) break;
    if (await page.evaluate(() => document.querySelector("#sheetInputRow")?.classList.contains("show"))) await page.fill("#sheetInput", "検証者");
    await page.waitForTimeout(350);
    if (!(await clickByText(page, /.+/))) await page.keyboard.press("Enter");
    await page.waitForTimeout(300);
  }
  const dump = async (tag) => { console.log(tag, await page.evaluate(() => ({ depth: document.querySelector("#stDepth")?.textContent, lv: document.querySelector("#stName")?.parentElement?.textContent?.replace(/\s+/g," ").trim().slice(0,60), hp: document.querySelector("#stHp")?.textContent }))); };
  await dump("起動後:");
  // メニュー(^handle) → 設定 → 🔧テスト
  const openTest = async () => {
    await page.click("#handle"); await page.waitForTimeout(350);
    // メニューgrid：設定（4番目セル）
    const cells = await page.$$("#sheetButtons button");
    await cells[3].click(); await page.waitForTimeout(350);
    await clickByText(page, /テスト/); await page.waitForTimeout(350);
  };
  // ① レベル設定 30
  await openTest();
  await clickByText(page, /レベルを設定/); await page.waitForTimeout(300);
  await page.fill("#sheetInput", "30"); await page.waitForTimeout(350);
  await clickByText(page, /設定する/); await page.waitForTimeout(300);
  await clickByText(page, /戻る/); await page.waitForTimeout(200);
  await dump("Lv30設定後:");
  // ② 全術＋付与
  await openTest();
  await clickByText(page, /全術/); await page.waitForTimeout(300);
  await clickByText(page, /金貨/); await page.waitForTimeout(300);
  await clickByText(page, /戻る/); await page.waitForTimeout(200);
  // ③ 深度40へジャンプ
  await openTest();
  await clickByText(page, /深度へ跳ぶ/); await page.waitForTimeout(300);
  await page.fill("#sheetInput", "40"); await page.waitForTimeout(350);
  await clickByText(page, /跳ぶ/); await page.waitForTimeout(600);
  await dump("深度40ジャンプ後:");
  await page.screenshot({ path: join(__dirname, "shots", "testmode_D40.png") });
  // 術が撃てるか（spellBtn）一回
  await page.click("#spellBtn").catch(() => {});
  await page.waitForTimeout(400);
  await page.screenshot({ path: join(__dirname, "shots", "testmode_spell.png") });
  console.log("JS例外:", errors.length, errors.slice(0, 10));
  await browser.close(); server.close();
}
main().catch((e) => { console.error(e); process.exit(1); });

// 自動テストプレイ（ローカル実行用）。Playwright で実ブラウザに本体を読み込み、
// 「街を歩く／シートの選択肢を押す／潜って戦う」をファジングして、
//   ・JS 例外（console.error / pageerror）を収集＝バグ検出
//   ・節目ごとにスクリーンショット＝見た目・画面遷移の確認
// を行う。リモート（Web版 Claude）環境はブラウザCDNが遮断され動かないため、ローカルで使う。
//
// 使い方（proto/ で）：
//   npm run build:web                 # web/app.js を最新化
//   npx playwright install chromium   # 初回のみ（ブラウザ取得）
//   node tools/playtest.mjs                  # ヘッドレスで 400 手・スクショは tools/shots/
//   HEADED=1 SLOWMO=120 node tools/playtest.mjs   # 実ブラウザを「見ながら」ゆっくり
//   STEPS=800 SEED=42 node tools/playtest.mjs     # 手数・乱択シード指定
//
// 環境変数：HEADED(0/1)・SLOWMO(ms)・STEPS(手数)・SEED(乱択再現)・PORT・EXPLORE(0..1 選択肢の冒険度)
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, extname } from "node:path";

// ブラウザ取得：ローカルは playwright（フルDL版）、それが無い環境（リモート等）は
// playwright-core ＋ @sparticuz/chromium（npm レジストリ経由でバイナリ取得）にフォールバック。
async function launchBrowser({ headless, slowMo }) {
  try {
    const { chromium } = await import("playwright");
    return await chromium.launch({ headless, slowMo, args: ["--no-sandbox"] });
  } catch {
    const { chromium } = await import("playwright-core");
    const sparticuz = (await import("@sparticuz/chromium")).default;
    const executablePath = await sparticuz.executablePath();
    return await chromium.launch({ executablePath, args: [...sparticuz.args, "--no-sandbox"], headless });
  }
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const WEB_DIR = join(__dirname, "..", "web");
const SHOTS = join(__dirname, "shots");
mkdirSync(SHOTS, { recursive: true });

const PORT = +(process.env.PORT || 8731);
const STEPS = +(process.env.STEPS || 400);
const HEADED = process.env.HEADED === "1";
const SLOWMO = +(process.env.SLOWMO || (HEADED ? 80 : 0));
const EXPLORE = Math.min(1, Math.max(0, +(process.env.EXPLORE || 0.4)));
// 乱択シード（再現用の簡易 mulberry32）
let _s = (+(process.env.SEED || 12345)) >>> 0;
const rnd = () => { _s |= 0; _s = (_s + 0x6D2B79F5) | 0; let t = Math.imul(_s ^ (_s >>> 15), 1 | _s); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const pick = (a) => a[Math.floor(rnd() * a.length)];

const MIME = { ".html": "text/html", ".js": "application/javascript", ".css": "text/css", ".json": "application/json", ".svg": "image/svg+xml", ".webmanifest": "application/manifest+json" };

const server = createServer(async (req, res) => {
  try {
    const url = (req.url || "/").split("?")[0];
    const path = join(WEB_DIR, url === "/" ? "index.html" : url);
    const body = await readFile(path);
    res.writeHead(200, { "Content-Type": MIME[extname(path)] || "application/octet-stream" });
    res.end(body);
  } catch { res.writeHead(404); res.end("not found"); }
});

async function main() {
  await new Promise((r) => server.listen(PORT, r));
  const url = `http://localhost:${PORT}/`;
  console.log(`serving ${WEB_DIR} at ${url}`);

  const browser = await launchBrowser({ headless: !HEADED, slowMo: SLOWMO });
  const ctx = await browser.newContext({ viewport: { width: 480, height: 900 }, serviceWorkers: "block" });
  const page = await ctx.newPage();

  // バグ検出：JS 例外・console.error を収集
  const errors = [];
  page.on("pageerror", (e) => errors.push("pageerror: " + (e.message || String(e))));
  page.on("console", (m) => { if (m.type() === "error") errors.push("console.error: " + m.text()); });

  // 新規ゲームから始める（前回のセーブを消す）
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await page.evaluate(() => { try { localStorage.clear(); } catch {} });
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(600);

  const ARROWS = ["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"];
  let shots = 0, sheetsHandled = 0, moves = 0, dives = 0, maxDepth = 0;
  const milestones = new Set();
  let prevDepth = "0";
  let heading = "ArrowDown", lastAx = -1, lastAy = -1; // 迷宮探索の慣性

  for (let step = 0; step < STEPS; step++) {
    const state = await page.evaluate(() => ({
      shown: !!document.querySelector("#overlay")?.classList.contains("show"),
      hasInput: !!document.querySelector("#sheetInputRow")?.classList.contains("show"),
      nButtons: document.querySelectorAll("#sheetButtons button").length,
      meta: document.querySelector("#sheetMeta")?.textContent || "",
      depth: document.querySelector("#stDepth")?.textContent || "",
      hp: document.querySelector("#stHp")?.textContent || "",
      name: document.querySelector("#stName")?.textContent || "",
    }));

    if (state.shown) {
      if (state.hasInput) await page.fill("#sheetInput", "試" + Math.floor(rnd() * 1000)).catch(() => {});
      const btns = await page.$$eval("#sheetButtons button", (els) => els.map((e) => (e.textContent || "").trim()));
      if (btns.length > 0) {
        // 降りる/関わるを優先（深層・content を踏む）。無ければ先頭＝上り階段では「街へ戻る」で循環し再潜行。
        const ENGAGE = /降り|潜|頼む|救助|奪|受ける|買|鎮|継ぐ|調べ|捜索|戦|供|捧|祈|診|預|取り出|整え|導き|向き合|詫/;
        const eng = btns.findIndex((t) => ENGAGE.test(t));
        const idx = (eng >= 0 && rnd() > EXPLORE) ? eng : (rnd() < EXPLORE ? Math.floor(rnd() * btns.length) : 0);
        await page.locator("#sheetButtons button").nth(idx).click({ timeout: 4000 }).catch(() => {});
        sheetsHandled++;
      } else {
        await page.keyboard.press("Enter").catch(() => {});
      }
    } else {
      // grid 解析で進む：@ を見つけ、迷宮では敵を狩り `>` 下り階段へ／街では門 `>` へ寄せる
      const view = await page.evaluate(() => {
        const grid = document.querySelector("#grid");
        if (!grid) return null;
        const cols = getComputedStyle(grid).gridTemplateColumns.split(" ").length;
        const cells = [...grid.querySelectorAll(".cell")];
        const rows = Math.round(cells.length / cols);
        const MON = new Set(["r", "k", "b", "s", "g", "w", "W", "O", "Ω"]); // 敵グリフ（街の群衆 c/$/n/t/f とは非衝突）
        let ax = -1, ay = -1, down = null; const mons = [];
        for (let i = 0; i < cells.length; i++) {
          const t = (cells[i].textContent || "").trim();
          if (!t) continue;
          const x = i % cols, y = Math.floor(i / cols);
          if (t === "@") { ax = x; ay = y; }
          else if (t === ">") down = { x, y };
          else if (MON.has(t)) mons.push({ x, y });
        }
        return { cols, rows, ax, ay, down, mons };
      });
      const toward = (ax, ay, tx, ty) => Math.abs(tx - ax) >= Math.abs(ty - ay)
        ? (tx > ax ? "ArrowRight" : "ArrowLeft") : (ty > ay ? "ArrowDown" : "ArrowUp");
      const inTown = !state.depth || state.depth === "0";
      let key;
      if (view && view.ax >= 0) {
        let nm = null, nd = 1e9;
        if (!inTown) for (const m of view.mons) { const d = Math.abs(m.x - view.ax) + Math.abs(m.y - view.ay); if (d < nd) { nd = d; nm = m; } }
        if (nm && nd <= 5) key = toward(view.ax, view.ay, nm.x, nm.y);           // 近い敵を狩る（XP→生存）
        else if (view.down) key = toward(view.ax, view.ay, view.down.x, view.down.y); // 下り階段/門へ
        else if (inTown) key = rnd() < 0.6 ? "ArrowUp" : pick(ARROWS);           // 街：門は北
        else { // 迷宮の探索＝慣性（詰まったら向き変更）
          if (view.ax === lastAx && view.ay === lastAy) heading = pick(ARROWS);
          else if (rnd() < 0.25) heading = pick(ARROWS);
          key = heading;
        }
        lastAx = view.ax; lastAy = view.ay;
      } else key = inTown ? (rnd() < 0.6 ? "ArrowUp" : pick(ARROWS)) : pick(ARROWS);
      await page.keyboard.press(key).catch(() => {});
      moves++;
    }
    // 潜行の検知（深度が 0→正数 / 増加）
    if (state.depth && state.depth !== "0") { maxDepth = Math.max(maxDepth, +state.depth || 0); }
    if (prevDepth === "0" && state.depth && state.depth !== "0") dives++;
    prevDepth = state.depth || prevDepth;
    await page.waitForTimeout(HEADED ? 60 : 25);

    // 節目スクショ：深度が変わった・40手ごと
    const key = `d${state.depth}`;
    if ((step % 40 === 0) || (!milestones.has(key) && state.depth && state.depth !== "0")) {
      milestones.add(key);
      await page.screenshot({ path: join(SHOTS, `s${String(shots).padStart(3, "0")}_step${step}_${state.meta ? "sheet" : "map"}_D${state.depth}.png`) }).catch(() => {});
      shots++;
    }
  }
  await page.screenshot({ path: join(SHOTS, `s${String(shots).padStart(3, "0")}_final.png`) }).catch(() => {});

  console.log(`\n=== 自動テストプレイ完了 ===`);
  console.log(`手数=${STEPS} シート処理=${sheetsHandled} 移動=${moves} 潜行回数=${dives} 最深到達=D${maxDepth} スクショ=${shots + 1}枚 → ${SHOTS}`);
  console.log(`JS例外/console.error = ${errors.length}件`);
  for (const e of [...new Set(errors)].slice(0, 30)) console.log("  ⚠ " + e);
  if (errors.length === 0) console.log("  ✅ 例外なし");

  await browser.close();
  server.close();
}
main().catch((e) => { console.error(e); process.exit(1); });

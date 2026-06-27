// 改良版 自動テストプレイ（デスクトップ Claude Code 用・実ブラウザ ファジング）。
// 既存 playtest.mjs の課題を解消：
//  ・タイトル画面(#title)を処理して新規ゲームへ入る（現ビルドは起動時タイトルで停止する）
//  ・難易度を指定して開始（DIFF=easy|normal|hard）
//  ・タブボタン（術/品/地図/ステ/設定）を時々叩いて main.ts のシート群を踏む
//  ・複数シードを連続実行（SEEDS="1,2,3"）・例外にシード/手数/直近操作の文脈を付す
//  ・タイトル/シート/グリッドのどれにも当てはまらず固まったら Enter/Escape で回復
//
// 使い方（proto/ で・要 npm run build:web 済み）：
//   node tools/playtest2.mjs
//   STEPS=1200 SEEDS=1,2,3,4 DIFF=hard node tools/playtest2.mjs
//   EXEC=/opt/pw-browsers/chromium-1194/chrome-linux/chrome  ← 自動既定
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, extname } from "node:path";
// playwright はローカル専用ツール依存（package.json には入れない＝本体は esbuild のみ）。
// ローカルで `npm i -D playwright` 済みなら動く。CI（npm run check）はこのツールを使わない。
const { chromium } = await import("playwright");

const __dirname = dirname(fileURLToPath(import.meta.url));
const WEB_DIR = join(__dirname, "..", "web");
const SHOTS = join(__dirname, "shots2");
mkdirSync(SHOTS, { recursive: true });

const EXEC = process.env.EXEC || "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
const PORT = +(process.env.PORT || 8741);
const STEPS = +(process.env.STEPS || 900);
const SEEDS = (process.env.SEEDS || "1,2,3").split(",").map((s) => +s.trim()).filter((n) => !isNaN(n));
const DIFF = (process.env.DIFF || "").trim(); // "" → ランダムに選ぶ
const HEADED = process.env.HEADED === "1";
const SLOWMO = +(process.env.SLOWMO || (HEADED ? 60 : 0));
const TAB_CHANCE = Math.min(1, Math.max(0, +(process.env.TABS || 0.12)));
const EXPLORE = Math.min(1, Math.max(0, +(process.env.EXPLORE || 0.35)));
const SHOT = process.env.SHOT === "1";
const GATE = process.env.GATE === "1"; // 街では会話を切り上げ門へ直行＝迷宮を深く潜らせる

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

// 迷宮の敵グリフ（街の群衆 c/$/n/t/f とは context で切り分け）
const MON = new Set("rkbsgwWOjvlmTDYinhBeFGPCaQcuAHMzΩ".split(""));
const DIFF_RE = { easy: /やさし|easy|安/i, normal: /ふつう|normal|標準/i, hard: /むずか|hard|苛/i };
const TABS = ["#spellBtn", "#bagBtn", "#mapBtn", "#statBtn", "#cogBtn"];

function mkRnd(seed) {
  let s = seed >>> 0;
  return () => { s |= 0; s = (s + 0x6D2B79F5) | 0; let t = Math.imul(s ^ (s >>> 15), 1 | s); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

async function runSeed(browser, seed, diff) {
  const rnd = mkRnd(seed);
  const pick = (a) => a[Math.floor(rnd() * a.length)];
  const ctx = await browser.newContext({ viewport: { width: 480, height: 900 }, serviceWorkers: "block" });
  const page = await ctx.newPage();
  const errors = [];
  let lastAction = "init";
  const note = (e) => errors.push(`[seed${seed} ${diff} ${lastAction}] ${e}`);
  page.on("pageerror", (e) => note("pageerror: " + (e.message || String(e))));
  page.on("console", (m) => { if (m.type() === "error") note("console.error: " + m.text()); });

  const url = `http://localhost:${PORT}/`;
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await page.evaluate(() => { try { localStorage.clear(); } catch {} });
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(500);

  let heading = "ArrowDown", lastAx = -1, lastAy = -1;
  let moves = 0, sheets = 0, tabs = 0, maxDepth = 0, dives = 0, prevDepth = "0";
  const ENGAGE = /降り|潜|頼む|救助|奪|受ける|買|鎮|継ぐ|調べ|捜索|戦|供|捧|祈|診|預|取り出|整え|導き|向き合|詫|名を呼|送る|読/;

  for (let step = 0; step < STEPS; step++) {
    let st;
    try {
      st = await page.evaluate(() => ({
        title: !!document.querySelector("#title")?.classList.contains("show"),
        titleBtns: [...document.querySelectorAll("#titleMenu button")].map((b) => (b.textContent || "").trim()),
        shown: !!document.querySelector("#overlay")?.classList.contains("show"),
        hasInput: !!document.querySelector("#sheetInputRow")?.classList.contains("show"),
        meta: document.querySelector("#sheetMeta")?.textContent || "",
        sheetText: (document.querySelector("#sheetText")?.textContent || "").slice(0, 40),
        btns: [...document.querySelectorAll("#sheetButtons button")].map((b) => (b.textContent || "").trim()),
        depth: document.querySelector("#stDepth")?.textContent || "",
        hp: document.querySelector("#stHpVal")?.textContent || "",
      }));
    } catch (e) { note("evaluate-state: " + e.message); break; }

    if (st.title) {
      // タイトル：新しい物語 / 続きから / はじまり を優先
      const want = st.titleBtns.findIndex((t) => /物語|続き|はじま|触れて/.test(t));
      const idx = want >= 0 ? want : 0;
      lastAction = `title:${st.titleBtns[idx] || "?"}`;
      await page.locator("#titleMenu button").nth(idx).click({ timeout: 4000 }).catch(() => {});
      await page.waitForTimeout(120);
      continue;
    }

    if (st.shown) {
      if (st.hasInput) await page.fill("#sheetInput", "名" + Math.floor(rnd() * 1000)).catch(() => {});
      if (st.btns.length > 0) {
        let idx;
        const inTownSheet = !st.depth || st.depth === "0";
        // 難易度シートは指定難易度を選ぶ
        if (/難易度/.test(st.meta) && diff) {
          const di = st.btns.findIndex((t) => DIFF_RE[diff]?.test(t));
          idx = di >= 0 ? di : 0;
        } else if (GATE && inTownSheet) {
          // GATE モード：街では会話を即切り上げて門へ向かう。降りる系は必ず／退出系を決定論で／無ければ最終ボタン（=退出/閉じる）。
          const dive = st.btns.findIndex((t) => /降り|潜る/.test(t));
          const leave = st.btns.findIndex((t) => /立ち去|席を立|切り上|閉じ|やめ|戻る|去る|断る|いいえ|今は|出る|外へ|街へ|あとに|後にする|また/.test(t));
          idx = dive >= 0 ? dive : (leave >= 0 ? leave : st.btns.length - 1);
        } else {
          const eng = st.btns.findIndex((t) => ENGAGE.test(t));
          idx = (eng >= 0 && rnd() > EXPLORE) ? eng : (rnd() < EXPLORE ? Math.floor(rnd() * st.btns.length) : 0);
        }
        lastAction = `sheet[${st.meta.slice(0, 16)}|${st.sheetText.slice(0, 16)}]→${st.btns[idx] || "?"}`;
        await page.locator("#sheetButtons button").nth(idx).click({ timeout: 4000 }).catch(() => note("click-sheet timeout"));
        sheets++;
      } else {
        lastAction = "sheet:enter";
        await page.keyboard.press("Enter").catch(() => {});
      }
      await page.waitForTimeout(HEADED ? 50 : 18);
      continue;
    }

    // 盤面：たまにタブを叩いて術/品/地図/ステ/設定を踏む（main.ts のシート群を網羅）
    const inTown = !st.depth || st.depth === "0";
    if (rnd() < TAB_CHANCE) {
      const tab = pick(TABS);
      lastAction = `tab:${tab}`;
      await page.click(tab, { timeout: 3000 }).catch(() => {});
      tabs++;
      await page.waitForTimeout(HEADED ? 50 : 18);
      continue;
    }

    let view = null;
    try {
      view = await page.evaluate(() => {
        const grid = document.querySelector("#grid");
        if (!grid) return null;
        const cols = getComputedStyle(grid).gridTemplateColumns.split(" ").length;
        const cells = [...grid.querySelectorAll(".cell")];
        const MON = new Set("rkbsgwWOjvlmTDYinhBeFGPCaQcuAHMzΩ".split(""));
        let ax = -1, ay = -1, down = null; const mons = [];
        for (let i = 0; i < cells.length; i++) {
          const t = (cells[i].textContent || "").trim();
          if (!t) continue;
          const x = i % cols, y = Math.floor(i / cols);
          if (t === "@") { ax = x; ay = y; }
          else if (t === ">") down = { x, y };
          else if (MON.has(t)) mons.push({ x, y });
        }
        return { ax, ay, down, mons };
      });
    } catch (e) { note("evaluate-view: " + e.message); }

    const toward = (ax, ay, tx, ty) => Math.abs(tx - ax) >= Math.abs(ty - ay)
      ? (tx > ax ? "ArrowRight" : "ArrowLeft") : (ty > ay ? "ArrowDown" : "ArrowUp");
    let key;
    if (view && view.ax >= 0) {
      let nm = null, nd = 1e9;
      if (!inTown) for (const m of view.mons) { const d = Math.abs(m.x - view.ax) + Math.abs(m.y - view.ay); if (d < nd) { nd = d; nm = m; } }
      if (nm && nd <= 5) key = toward(view.ax, view.ay, nm.x, nm.y);
      else if (view.down) key = toward(view.ax, view.ay, view.down.x, view.down.y);
      else if (inTown) key = rnd() < 0.6 ? "ArrowUp" : pick(["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"]);
      else {
        if (view.ax === lastAx && view.ay === lastAy) heading = pick(["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"]);
        else if (rnd() < 0.25) heading = pick(["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"]);
        key = heading;
      }
      lastAx = view.ax; lastAy = view.ay;
    } else key = pick(["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Enter"]);
    lastAction = `move:${key}@D${st.depth}`;
    await page.keyboard.press(key).catch(() => {});
    moves++;

    if (st.depth && st.depth !== "0") maxDepth = Math.max(maxDepth, +st.depth || 0);
    if (prevDepth === "0" && st.depth && st.depth !== "0") dives++;
    prevDepth = st.depth || prevDepth;
    await page.waitForTimeout(HEADED ? 50 : 14);

    if (SHOT && step % 100 === 0) await page.screenshot({ path: join(SHOTS, `seed${seed}_${diff}_step${step}.png`) }).catch(() => {});
  }

  await page.screenshot({ path: join(SHOTS, `seed${seed}_${diff}_final.png`) }).catch(() => {});
  await ctx.close();
  return { seed, diff, moves, sheets, tabs, dives, maxDepth, errors };
}

async function main() {
  await new Promise((r) => server.listen(PORT, r));
  console.log(`serving ${WEB_DIR} at http://localhost:${PORT}/  exec=${EXEC}`);
  const browser = await chromium.launch({ headless: !HEADED, slowMo: SLOWMO, executablePath: EXEC, args: ["--no-sandbox"] });

  const allErrors = [];
  const diffs = ["easy", "normal", "hard"];
  for (let i = 0; i < SEEDS.length; i++) {
    const seed = SEEDS[i];
    const diff = DIFF || diffs[i % diffs.length];
    process.stdout.write(`▶ seed=${seed} diff=${diff} ... `);
    const r = await runSeed(browser, seed, diff);
    console.log(`移動${r.moves} シート${r.sheets} タブ${r.tabs} 潜行${r.dives} 最深D${r.maxDepth} 例外${r.errors.length}`);
    allErrors.push(...r.errors);
  }

  console.log(`\n=== 完了：シード${SEEDS.length}本 × ${STEPS}手 ===`);
  console.log(`JS例外/console.error = ${allErrors.length}件`);
  const uniq = [...new Set(allErrors)];
  for (const e of uniq.slice(0, 60)) console.log("  ⚠ " + e);
  if (allErrors.length === 0) console.log("  ✅ 例外なし");
  else console.log(`  （ユニーク ${uniq.length}件）`);

  await browser.close();
  server.close();
}
main().catch((e) => { console.error(e); process.exit(1); });

// G: 視覚/レイアウト回帰（実ブラウザ撮影＋PIL 解析・デスクトップ専用）。
// 縦持ち端末ビュー(480×900)で主要画面（タイトル/街/深層/深淵/各オーバーレイ）を撮影し、
// PIL（tools/visual-analyze.py）で「空/破綻描画・主要帯の無内容・下部セーフエリアの取りこぼし」を定量検出。
// 実行: node --experimental-strip-types tools/visual-check.ts   （→ shots2/ に PNG ＋ 解析JSON）
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, extname } from "node:path";
import { spawnSync } from "node:child_process";
import { newWorld, createCharacter } from "../src/world.ts";
import { genFloor } from "../src/dungeon.ts";
import { maxHp } from "../src/progression.ts";
import { SPELLS } from "../src/spells.ts";
import type { World } from "../src/types.ts";

const { chromium } = await import("playwright");
const __dirname = dirname(fileURLToPath(import.meta.url));
const WEB_DIR = join(__dirname, "..", "web");
const SHOTS = join(__dirname, "shots2", "visual");
mkdirSync(SHOTS, { recursive: true });
const EXEC = process.env.EXEC || "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
const PORT = +(process.env.PORT || 8761);
const SAVE_KEY = "sekitsui.world.v0", DIVE_KEY = "sekitsui.dive.v0";

const MIME: Record<string, string> = { ".html": "text/html", ".js": "application/javascript", ".css": "text/css", ".json": "application/json", ".svg": "image/svg+xml", ".webmanifest": "application/manifest+json" };
const server = createServer(async (req, res) => {
  try { const url = (req.url || "/").split("?")[0]; const path = join(WEB_DIR, url === "/" ? "index.html" : url); const body = await readFile(path); res.writeHead(200, { "Content-Type": MIME[extname(path)] || "application/octet-stream" }); res.end(body); }
  catch { res.writeHead(404); res.end("nf"); }
});

function townWorld(seed: number): string { // 街にいる（dive なし）世界
  const w: World = newWorld(seed); w.difficulty = "normal";
  const ch = createCharacter(w, "視覚検証者", "wanderer", { relation: "none" });
  ch.level = 20; ch.gold = 300; w.current = ch;
  return JSON.stringify(w);
}
function deepWorldAndDive(seed: number, depth: number, abyss: boolean): { world: string; dive: string } {
  const w: World = newWorld(seed); w.difficulty = "normal";
  const ch = createCharacter(w, "視覚検証者", "wanderer", { relation: "none" });
  ch.level = 46; ch.gold = 500; ch.stats = { body: 16, power: 14, reason: 14, heart: 12 };
  ch.spells = SPELLS.map((s) => s.key); ch.loadout = ch.spells.slice(0, 10); ch.depth = depth; w.current = ch;
  const floor = genFloor(w, depth, abyss ? { abyss: true } : undefined);
  const snap = { depth, hp: maxHp(ch), inAbyss: abyss, player: { x: floor.stairsUp.x, y: floor.stairsUp.y }, floor, cache: [], pursuerCount: 0, turnsSinceFloor: 0 };
  return { world: JSON.stringify(w), dive: JSON.stringify(snap) };
}

async function main() {
  await new Promise<void>((r) => server.listen(PORT, () => r()));
  const browser = await chromium.launch({ headless: true, executablePath: EXEC, args: ["--no-sandbox"] });
  const url = `http://localhost:${PORT}/`;
  const shots: string[] = [];

  async function newPage(inject?: { world?: string; dive?: string }) {
    const ctx = await browser.newContext({ viewport: { width: 480, height: 900 }, deviceScaleFactor: 1, serviceWorkers: "block" });
    const page = await ctx.newPage();
    await page.goto(url, { waitUntil: "domcontentloaded" });
    await page.evaluate(({ w, d, sk, dk }) => {
      try { localStorage.clear(); localStorage.setItem("sekitsui.bgm", "0"); localStorage.setItem("sekitsui.mute", "1"); if (w) localStorage.setItem(sk, w); if (d) localStorage.setItem(dk, d); } catch {}
    }, { w: inject?.world, d: inject?.dive, sk: SAVE_KEY, dk: DIVE_KEY });
    await page.goto(url, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(500);
    return { ctx, page };
  }
  async function snap(page: any, name: string) { const p = join(SHOTS, name + ".png"); await page.screenshot({ path: p }).catch(() => {}); shots.push(p); }
  async function clickTitle(page: any, re: RegExp) {
    const btns = await page.$$eval("#titleMenu button", (els: any[]) => els.map((e) => (e.textContent || "").trim()));
    let i = btns.findIndex((t: string) => re.test(t)); if (i < 0) i = 0;
    await page.locator("#titleMenu button").nth(i).click({ timeout: 4000 }).catch(() => {});
    await page.waitForTimeout(300);
  }

  // 1. タイトル
  { const { ctx, page } = await newPage(); await snap(page, "01_title"); await ctx.close(); }
  // 2. 街（dive なし世界を注入→続きから→街）
  { const { ctx, page } = await newPage({ world: townWorld(7) }); await clickTitle(page, /続き|物語|はじま|触れて/); await page.waitForTimeout(400); await snap(page, "02_town"); await ctx.close(); }
  // 3-6. 深層(D40)＋各オーバーレイ
  for (const [tag, depth, abyss] of [["03_deep_d40", 40, false], ["04_abyss_d50", 50, true]] as const) {
    const inj = deepWorldAndDive(101, depth, abyss);
    const { ctx, page } = await newPage(inj); await clickTitle(page, /続き|触れて/); await page.waitForTimeout(500);
    await snap(page, tag);
    if (!abyss) {
      for (const [btn, label] of [["#spellBtn", "05_overlay_spell"], ["#bagBtn", "06_overlay_bag"], ["#statBtn", "07_overlay_stat"], ["#mapBtn", "08_overlay_map"]] as const) {
        await page.click(btn, { timeout: 3000 }).catch(() => {}); await page.waitForTimeout(350); await snap(page, label);
        await page.keyboard.press("Escape").catch(() => {}); await page.waitForTimeout(200);
        // オーバーレイが閉じない場合に備え、閉じるボタンも試す
        await page.evaluate(() => { const b = [...document.querySelectorAll("#sheetButtons button")].find((x) => /閉じ|やめ|戻る|出る/.test(x.textContent || "")); (b as HTMLButtonElement)?.click(); }).catch(() => {});
        await page.waitForTimeout(200);
      }
    }
    await ctx.close();
  }
  await browser.close(); server.close();

  // PIL 解析を呼ぶ
  const py = spawnSync("python3", [join(__dirname, "visual-analyze.py"), ...shots], { encoding: "utf8" });
  process.stdout.write(py.stdout || ""); if (py.stderr) process.stderr.write(py.stderr);
  process.exit(py.status ?? 0);
}
main().catch((e) => { console.error(e); process.exit(1); });

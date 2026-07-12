// QA専用スクリプト（ゲーム本体は変更しない）＝v0.151.0 部屋aggro（`f.rooms &&` ガード）の後方互換検証。
// 「Floor.rooms 未定義の旧セーブ」を模して DiveSnapshot（＋floorCache）から rooms フィールドを剥がし、
// resumeDive（「続きから」）経路で normal/hard 難易度でも JS例外が出ないことを実ブラウザで確認する。
// playtest-deep.ts の注入方式を流用しつつ、floor.rooms を意図的に削除する点だけが異なる。
// 実行: node --experimental-strip-types tools/qa-legacy-rooms-resume.ts
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join, extname } from "node:path";
import { newWorld, createCharacter } from "../src/world.ts";
import { genFloor } from "../src/dungeon.ts";
import { maxHp } from "../src/progression.ts";
import type { World } from "../src/types.ts";

const { chromium } = await import("playwright");
const __dirname = dirname(fileURLToPath(import.meta.url));
const WEB_DIR = join(__dirname, "..", "web");
const EXEC = process.env.EXEC || "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
const PORT = +(process.env.PORT || 8761);
const STEPS = +(process.env.STEPS || 500);
const SAVE_KEY = "sekitsui.world.v0";
const DIVE_KEY = "sekitsui.dive.v0";

const MIME: Record<string, string> = { ".html": "text/html", ".js": "application/javascript", ".css": "text/css", ".json": "application/json", ".svg": "image/svg+xml", ".webmanifest": "application/manifest+json" };
const server = createServer(async (req, res) => {
  try { const url = (req.url || "/").split("?")[0]; const path = join(WEB_DIR, url === "/" ? "index.html" : url); const body = await readFile(path); res.writeHead(200, { "Content-Type": MIME[extname(path)] || "application/octet-stream" }); res.end(body); }
  catch { res.writeHead(404); res.end("nf"); }
});

// 「rooms フィールドが無かった頃のセーブ」を模す＝genFloor で生成した Floor から rooms を剥がす。
function stripRooms(floor: any): any {
  const f = { ...floor };
  delete f.rooms;
  return f;
}

function buildInjection(seed: number, depth: number, diff: string) {
  const w: World = newWorld(seed);
  w.difficulty = diff as any;
  const ch = createCharacter(w, "旧セーブ検証者", "wanderer", { relation: "none" });
  ch.level = 30; ch.xp = 0; ch.gold = 400;
  ch.stats = { body: 14, power: 12, reason: 12, heart: 10 };
  ch.depth = depth;
  ch.gearBag = [];
  w.current = ch;
  const floor = stripRooms(genFloor(w, depth));
  const snap = {
    depth, hp: maxHp(ch), inAbyss: false,
    player: { x: floor.stairsUp.x, y: floor.stairsUp.y },
    floor, // rooms 欠落
    cache: [] as any[], // floorCache も rooms 欠落フロアのみ（旧セーブ相当）
    pursuerCount: 0, turnsSinceFloor: 0, setPieceCooldown: 0, quietDescents: 0,
  };
  return { world: JSON.stringify(w), dive: JSON.stringify(snap) };
}

function mkRnd(seed: number) { let s = seed >>> 0; return () => { s |= 0; s = (s + 0x6D2B79F5) | 0; let t = Math.imul(s ^ (s >>> 15), 1 | s); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

async function runConfig(browser: any, cfg: { seed: number; depth: number; diff: string }) {
  const rnd = mkRnd(cfg.seed + cfg.depth);
  const pick = (a: any[]) => a[Math.floor(rnd() * a.length)];
  const inj = buildInjection(cfg.seed, cfg.depth, cfg.diff);
  const ctx = await browser.newContext({ viewport: { width: 480, height: 900 }, serviceWorkers: "block" });
  const page = await ctx.newPage();
  const errors: string[] = [];
  let last = "init";
  const note = (e: string) => errors.push(`[legacy-rooms d${cfg.depth} ${cfg.diff} ${last}] ${e}`);
  page.on("pageerror", (e) => note("pageerror: " + (e.message || String(e))));
  page.on("console", (m) => { if (m.type() === "error") note("console.error: " + m.text()); });

  const url = `http://localhost:${PORT}/`;
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await page.evaluate(({ s, d, sk, dk }) => { try { localStorage.clear(); localStorage.setItem(sk, s); localStorage.setItem(dk, d); localStorage.setItem("sekitsui.bgm", "0"); localStorage.setItem("sekitsui.mute", "1"); } catch {} }, { s: inj.world, d: inj.dive, sk: SAVE_KEY, dk: DIVE_KEY });
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(400);

  let dove = false, moves = 0, sheets = 0, maxDepth = cfg.depth;
  const MON = new Set("rkbsgwWOjvlmTDYinhBeFGPCaQcuAHMzΩ".split(""));
  let heading = "ArrowDown";
  for (let step = 0; step < STEPS; step++) {
    let st: any;
    try {
      st = await page.evaluate(() => ({
        title: !!document.querySelector("#title")?.classList.contains("show"),
        titleBtns: [...document.querySelectorAll("#titleMenu button")].map((b) => (b.textContent || "").trim()),
        shown: !!document.querySelector("#overlay")?.classList.contains("show"),
        hasInput: !!document.querySelector("#sheetInputRow")?.classList.contains("show"),
        btns: [...document.querySelectorAll("#sheetButtons button")].map((b) => (b.textContent || "").trim()),
        meta: document.querySelector("#sheetMeta")?.textContent || "",
        depth: document.querySelector("#stDepth")?.textContent || "",
      }));
    } catch (e: any) { note("evaluate: " + e.message); break; }

    if (st.title) {
      const i = st.titleBtns.findIndex((t: string) => /続き|物語|はじま|触れて/.test(t));
      last = `title:${st.titleBtns[i] || "?"}`;
      await page.locator("#titleMenu button").nth(Math.max(0, i)).click({ timeout: 4000 }).catch(() => {});
      await page.waitForTimeout(150); continue;
    }
    if (st.depth && st.depth !== "0") { dove = true; maxDepth = Math.max(maxDepth, +st.depth || 0); }

    if (st.shown) {
      if (st.hasInput) await page.fill("#sheetInput", "名" + Math.floor(rnd() * 99)).catch(() => {});
      if (st.btns.length) {
        const idx = rnd() < 0.7 ? Math.floor(rnd() * st.btns.length) : 0;
        last = `sheet[${st.meta.slice(0, 14)}]→${st.btns[idx] || "?"}`;
        await page.locator("#sheetButtons button").nth(idx).click({ timeout: 4000 }).catch(() => {});
        sheets++;
      } else { last = "sheet:enter"; await page.keyboard.press("Enter").catch(() => {}); }
      await page.waitForTimeout(14); continue;
    }

    let view: any = null;
    try {
      view = await page.evaluate(() => {
        const grid = document.querySelector("#grid"); if (!grid) return null;
        const cols = getComputedStyle(grid as Element).gridTemplateColumns.split(" ").length;
        const cells = [...grid.querySelectorAll(".cell")]; const MON = new Set("rkbsgwWOjvlmTDYinhBeFGPCaQcuAHMzΩ".split(""));
        let ax = -1, ay = -1, down: any = null; const mons: any[] = [];
        for (let i = 0; i < cells.length; i++) { const t = (cells[i].textContent || "").trim(); if (!t) continue; const x = i % cols, y = Math.floor(i / cols); if (t === "@") { ax = x; ay = y; } else if (t === ">") down = { x, y }; else if (MON.has(t)) mons.push({ x, y }); }
        return { ax, ay, down, mons };
      });
    } catch (e: any) { note("view: " + e.message); }
    const toward = (ax: number, ay: number, tx: number, ty: number) => Math.abs(tx - ax) >= Math.abs(ty - ay) ? (tx > ax ? "ArrowRight" : "ArrowLeft") : (ty > ay ? "ArrowDown" : "ArrowUp");
    let key = heading;
    if (view && view.ax >= 0) {
      let nm: any = null, nd = 1e9;
      for (const m of view.mons) { const d = Math.abs(m.x - view.ax) + Math.abs(m.y - view.ay); if (d < nd) { nd = d; nm = m; } }
      if (nm && nd <= 6) key = toward(view.ax, view.ay, nm.x, nm.y);
      else if (view.down) key = toward(view.ax, view.ay, view.down.x, view.down.y);
      else { if (rnd() < 0.3) heading = pick(["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"]); key = heading; }
    } else key = pick(["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"]);
    last = `move:${key}@D${st.depth}`;
    await page.keyboard.press(key).catch(() => {});
    moves++;
    await page.waitForTimeout(12);
  }
  await ctx.close();
  return { ...cfg, dove, moves, sheets, maxDepth, errors };
}

async function main() {
  await new Promise<void>((r) => server.listen(PORT, () => r()));
  console.log(`serving ${WEB_DIR} :${PORT}`);
  console.log("== QA: 旧セーブ（Floor.rooms 欠落）の resumeDive 経路＝部屋aggroガード裏取り ==");
  const browser = await chromium.launch({ headless: true, executablePath: EXEC, args: ["--no-sandbox"] });
  const configs = [
    { seed: 811, depth: 6, diff: "normal" },
    { seed: 812, depth: 12, diff: "normal" },
    { seed: 813, depth: 20, diff: "hard" },
    { seed: 814, depth: 28, diff: "hard" },
  ];
  const all: string[] = [];
  for (const cfg of configs) {
    const res = await runConfig(browser, cfg);
    console.log(`▶ d${cfg.depth} ${cfg.diff} (rooms欠落注入): 復帰${res.dove ? "✓" : "✗"} 移動${res.moves} シート${res.sheets} 最深D${res.maxDepth} 例外${res.errors.length}`);
    all.push(...res.errors);
  }
  console.log(`\n=== qa-legacy-rooms-resume 完了：${configs.length}構成 ===`);
  console.log(`JS例外/console.error = ${all.length}件`);
  const uniq = [...new Set(all)];
  for (const e of uniq.slice(0, 60)) console.log("  ⚠ " + e);
  if (all.length === 0) console.log("  ✅ Floor.rooms 欠落の旧セーブでも resumeDive→部屋aggro 判定で例外なし（f.rooms && ガードが機能）");
  await browser.close(); server.close();
  process.exit(all.length === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });

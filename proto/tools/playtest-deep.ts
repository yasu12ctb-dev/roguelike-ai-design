// D+E: 深層 main.ts カバレッジ（セーブ注入）＋全36術の網羅ファジング（デスクトップ専用・実ブラウザ）。
// 黒箱ファジングは霧ダンジョンの下り探索が非効率で D1 止まりだった（前回）。本ツールは Node でエンジンから
// 「深層 dive 中」の有効セーブ＋DiveSnapshot を生成し localStorage に注入→「続きから」で深層に直接復帰させ、
// castSpell（全36術をロードアウト巡回で網羅）・ボス戦・宝箱・持ち物・階段など web 限定グルーをファジングする。
// 実行: node --experimental-strip-types tools/playtest-deep.ts
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join, extname } from "node:path";
import { newWorld, createCharacter } from "../src/world.ts";
import { genFloor } from "../src/dungeon.ts";
import { maxHp } from "../src/progression.ts";
import { SPELLS } from "../src/spells.ts";
import type { World } from "../src/types.ts";

const { chromium } = await import("playwright");
const __dirname = dirname(fileURLToPath(import.meta.url));
const WEB_DIR = join(__dirname, "..", "web");
const EXEC = process.env.EXEC || "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
const PORT = +(process.env.PORT || 8751);
const STEPS = +(process.env.STEPS || 700);
const SAVE_KEY = "sekitsui.world.v0";
const DIVE_KEY = "sekitsui.dive.v0";
const ALL_SPELLS = SPELLS.map((s) => s.key);

const MIME: Record<string, string> = { ".html": "text/html", ".js": "application/javascript", ".css": "text/css", ".json": "application/json", ".svg": "image/svg+xml", ".webmanifest": "application/manifest+json" };
const server = createServer(async (req, res) => {
  try { const url = (req.url || "/").split("?")[0]; const path = join(WEB_DIR, url === "/" ? "index.html" : url); const body = await readFile(path); res.writeHead(200, { "Content-Type": MIME[extname(path)] || "application/octet-stream" }); res.end(body); }
  catch { res.writeHead(404); res.end("nf"); }
});

// 深層 dive 中の有効セーブ＋スナップショットを生成。loadout に術サブセットを構える。
function buildInjection(seed: number, depth: number, diff: string, loadout: string[], abyss: boolean) {
  const w: World = newWorld(seed);
  w.difficulty = diff as any;
  const ch = createCharacter(w, "深層検証者", "wanderer", { relation: "none" });
  ch.level = 46; ch.xp = 0; ch.gold = 800;
  ch.stats = { body: 16, power: 14, reason: 14, heart: 12 };
  ch.spells = [...ALL_SPELLS];           // 全術を習得済みに
  ch.loadout = loadout.slice(0, 10);     // 構えは10まで（このランで撃てる術）
  ch.depth = depth;
  // 装備・袋（gearSheet/bag のファジング用に少し持たせる）
  ch.gearBag = [];
  w.current = ch;
  const floor = genFloor(w, depth, abyss ? { abyss: true } : undefined);
  const snap = { depth, hp: maxHp(ch), inAbyss: abyss, player: { x: floor.stairsUp.x, y: floor.stairsUp.y }, floor, cache: [] as any[], pursuerCount: 0, turnsSinceFloor: 0, setPieceCooldown: 0, quietDescents: 0 };
  return { world: JSON.stringify(w), dive: JSON.stringify(snap) };
}

function mkRnd(seed: number) { let s = seed >>> 0; return () => { s |= 0; s = (s + 0x6D2B79F5) | 0; let t = Math.imul(s ^ (s >>> 15), 1 | s); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

async function runConfig(browser: any, cfg: { seed: number; depth: number; diff: string; loadout: string[]; abyss: boolean }) {
  const rnd = mkRnd(cfg.seed + cfg.depth);
  const pick = (a: any[]) => a[Math.floor(rnd() * a.length)];
  const inj = buildInjection(cfg.seed, cfg.depth, cfg.diff, cfg.loadout, cfg.abyss);
  const ctx = await browser.newContext({ viewport: { width: 480, height: 900 }, serviceWorkers: "block" });
  const page = await ctx.newPage();
  const errors: string[] = [];
  let last = "init";
  const note = (e: string) => errors.push(`[d${cfg.depth} ${cfg.diff} ${last}] ${e}`);
  page.on("pageerror", (e) => note("pageerror: " + (e.message || String(e))));
  page.on("console", (m) => { if (m.type() === "error") note("console.error: " + m.text()); });

  const url = `http://localhost:${PORT}/`;
  await page.goto(url, { waitUntil: "domcontentloaded" });
  // セーブ＋スナップショット注入＋音声オフ（autoplay ゲートを避ける）
  await page.evaluate(({ s, d, sk, dk }) => { try { localStorage.clear(); localStorage.setItem(sk, s); localStorage.setItem(dk, d); localStorage.setItem("sekitsui.bgm", "0"); localStorage.setItem("sekitsui.mute", "1"); } catch {} }, { s: inj.world, d: inj.dive, sk: SAVE_KEY, dk: DIVE_KEY });
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(400);

  let dove = false, casts = 0, moves = 0, sheets = 0, maxDepth = cfg.depth;
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

    if (st.title) { // 「続きから」で深層復帰
      const i = st.titleBtns.findIndex((t: string) => /続き|物語|はじま|触れて/.test(t));
      last = `title:${st.titleBtns[i] || "?"}`;
      await page.locator("#titleMenu button").nth(Math.max(0, i)).click({ timeout: 4000 }).catch(() => {});
      await page.waitForTimeout(150); continue;
    }
    if (st.depth && st.depth !== "0") { dove = true; maxDepth = Math.max(maxDepth, +st.depth || 0); }

    if (st.shown) {
      if (st.hasInput) await page.fill("#sheetInput", "名" + Math.floor(rnd() * 99)).catch(() => {});
      if (st.btns.length) {
        // 術シートは各術を順に撃つ／その他は engage 寄り・たまにランダム
        const idx = rnd() < 0.7 ? Math.floor(rnd() * st.btns.length) : 0;
        last = `sheet[${st.meta.slice(0, 14)}]→${st.btns[idx] || "?"}`;
        if (/術|構え|spell/i.test(st.meta) || cfg.loadout.some((k) => st.btns.some((b: string) => b.includes(k)))) casts++;
        await page.locator("#sheetButtons button").nth(idx).click({ timeout: 4000 }).catch(() => {});
        sheets++;
      } else { last = "sheet:enter"; await page.keyboard.press("Enter").catch(() => {}); }
      await page.waitForTimeout(14); continue;
    }

    // 盤面：30%で術ボタン（castSpell 網羅）、20%で品/ステ、残りは移動/攻撃
    const r = rnd();
    if (r < 0.30) { last = "tab:spell"; await page.click("#spellBtn", { timeout: 3000 }).catch(() => {}); await page.waitForTimeout(14); continue; }
    if (r < 0.40) { last = "tab:bag"; await page.click("#bagBtn", { timeout: 3000 }).catch(() => {}); await page.waitForTimeout(14); continue; }
    if (r < 0.46) { last = "tab:stat"; await page.click("#statBtn", { timeout: 3000 }).catch(() => {}); await page.waitForTimeout(14); continue; }
    if (r < 0.50) { last = "tab:map"; await page.click("#mapBtn", { timeout: 3000 }).catch(() => {}); await page.waitForTimeout(14); continue; }

    // 最寄り敵へ／無ければ下り階段/探索
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
  return { ...cfg, dove, casts, moves, sheets, maxDepth, errors };
}

async function main() {
  await new Promise<void>((r) => server.listen(PORT, () => r()));
  console.log(`serving ${WEB_DIR} :${PORT}`);
  const browser = await chromium.launch({ headless: true, executablePath: EXEC, args: ["--no-sandbox"] });
  // ロードアウトを巡回して全36術を網羅（10ずつ×4ラン＝36術＋深度/難易度/abyss を散らす）
  const chunks: string[][] = [];
  for (let i = 0; i < ALL_SPELLS.length; i += 9) chunks.push(ALL_SPELLS.slice(i, i + 9));
  const configs = [
    { seed: 101, depth: 16, diff: "normal", loadout: chunks[0], abyss: false },
    { seed: 202, depth: 24, diff: "hard", loadout: chunks[1], abyss: false },   // ボス階
    { seed: 303, depth: 33, diff: "normal", loadout: chunks[2], abyss: false },
    { seed: 404, depth: 40, diff: "hard", loadout: chunks[3], abyss: false },
    { seed: 505, depth: 50, diff: "normal", loadout: ALL_SPELLS.slice(0, 10), abyss: true }, // 深淵帯
  ];
  const all: string[] = [];
  for (const cfg of configs) {
    const res = await runConfig(browser, cfg);
    console.log(`▶ d${cfg.depth} ${cfg.diff}${cfg.abyss ? " abyss" : ""}: 復帰${res.dove ? "✓" : "✗"} 移動${res.moves} 術試行${res.casts} シート${res.sheets} 最深D${res.maxDepth} 例外${res.errors.length}`);
    all.push(...res.errors);
  }
  console.log(`\n=== playtest-deep 完了：${configs.length}構成 ===`);
  console.log(`JS例外/console.error = ${all.length}件`);
  const uniq = [...new Set(all)];
  for (const e of uniq.slice(0, 60)) console.log("  ⚠ " + e);
  if (all.length === 0) console.log("  ✅ 深層・全術ファジングで例外なし");
  await browser.close(); server.close();
}
main().catch((e) => { console.error(e); process.exit(1); });

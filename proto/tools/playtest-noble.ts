// クリア後の街（貴族街/謁見/館/専属英雄）ファジング（デスクトップ専用・実ブラウザ・BFSナビ版）。
//   playtest2 は新規ワールド＝門が閉じ貴族街に入れない／playtest-deep は dive。よって v0.61-0.63 で入った
//   「歩ける貴族街・宮廷NPC・謁見・館・COURT_CHAMPIONS」の web グルーは両者の死角だった。
//   ★無誘導歩行は迷宮門の枠を迂回できず貴族街(街上部・ngate 1マス)に入れない＝BFSで経路を引いて確実に侵入。
//   ascended≥1（manor/home 解禁）の有効セーブを注入→続きから→街へ→ngate へ BFS→貴族街侵入→
//   館/謁見の扉・宮廷NPCを bump して courtNpcScene/audienceScene/lineageHallScene/champion 紹介を発火、
//   生じた全オーバーレイのボタンを総当たりで踏んで JS 例外/未充填スロット/throw を炙る。
//   ※ window.__dbg（main.ts のデバッグフック・未コミット）が必要。実行: node --experimental-strip-types tools/playtest-noble.ts
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join, extname } from "node:path";
import { newWorld, createCharacter } from "../src/world.ts";
import type { World } from "../src/types.ts";

const { chromium } = await import("playwright");
const __dirname = dirname(fileURLToPath(import.meta.url));
const WEB_DIR = join(__dirname, "..", "web");
const EXEC = process.env.EXEC || "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
const PORT = +(process.env.PORT || 8771);
const SEEDS = (process.env.SEEDS || "11,23,37,52,68").split(",").map((s) => +s);
const SAVE_KEY = "sekitsui.world.v0";
const DIVE_KEY = "sekitsui.dive.v0";
const NOBLE_RE = /家令|廷臣|客分|客人|謁見|統治者|宮廷|館|大命|系譜|戴|領主|英雄譜|専属|覇者/;

const MIME: Record<string, string> = { ".html": "text/html", ".js": "application/javascript", ".css": "text/css", ".json": "application/json", ".svg": "image/svg+xml", ".webmanifest": "application/manifest+json" };
const server = createServer(async (req, res) => {
  try { const url = (req.url || "/").split("?")[0]; const path = join(WEB_DIR, url === "/" ? "index.html" : url); const body = await readFile(path); res.writeHead(200, { "Content-Type": MIME[extname(path)] || "application/octet-stream" }); res.end(body); }
  catch { res.writeHead(404); res.end("nf"); }
});

function clearedTownWorld(seed: number, diff: string): string {
  const w: World = newWorld(seed);
  w.difficulty = diff as any; w.ascended = 1; w.manorUnlocked = true; w.homeUnlocked = true; w.questsDone = 12;
  const ch = createCharacter(w, "宮廷検証者", "wanderer", { relation: "none" });
  ch.level = 50; ch.gold = 2000; ch.stats = { body: 16, power: 14, reason: 14, heart: 14 }; w.current = ch;
  return JSON.stringify(w);
}

// 歩行可能（dive 門 "gate" は潜行に落ちるので除外・noble/ngate は解禁前提）。doors は目標として別途扱う。
const WALK = new Set(["floor", "noble", "ngate"]);
// 8方向 BFS で from→target への次の一歩キーを返す。target が建物扉なら「扉の隣」までで止め最後に扉へ踏み込む。
function bfsNextKey(grid: string[][], W: number, H: number, from: { x: number; y: number }, target: { x: number; y: number }, allowTargetTile = false): string | null {
  const key = (x: number, y: number) => y * W + x;
  // 対角は vi キー（y=左上/u=右上/b=左下/n=右下）。ゲームは矢印＋yubn＋numpad のみ認識。
  const dirs: [number, number, string][] = [[0,-1,"ArrowUp"],[0,1,"ArrowDown"],[-1,0,"ArrowLeft"],[1,0,"ArrowRight"],[-1,-1,"y"],[1,-1,"u"],[-1,1,"b"],[1,1,"n"]];
  const prev = new Map<number, { px: number; py: number; k: string }>();
  const q = [from]; const seen = new Set([key(from.x, from.y)]);
  while (q.length) {
    const c = q.shift()!;
    if (c.x === target.x && c.y === target.y) {
      // 経路を遡って最初の一歩を得る
      let cur = c; let firstKey: string | null = null;
      while (!(cur.x === from.x && cur.y === from.y)) { const p = prev.get(key(cur.x, cur.y))!; firstKey = p.k; cur = { x: p.px, y: p.py }; }
      return firstKey;
    }
    for (const [dx, dy, k] of dirs) {
      const nx = c.x + dx, ny = c.y + dy; if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
      const t = grid[ny]?.[nx]; const isTarget = nx === target.x && ny === target.y;
      if (!WALK.has(t) && !(isTarget && allowTargetTile)) continue;
      if (seen.has(key(nx, ny))) continue;
      seen.add(key(nx, ny)); prev.set(key(nx, ny), { px: c.x, py: c.y, k }); q.push({ x: nx, y: ny });
    }
  }
  return null;
}

async function runSeed(browser: any, seed: number, diff: string) {
  const ctx = await browser.newContext({ viewport: { width: 480, height: 900 }, serviceWorkers: "block" });
  const page = await ctx.newPage();
  const errors: string[] = [];
  let last = "init";
  const note = (e: string) => errors.push(`[${seed}/${diff} ${last}] ${e}`);
  page.on("pageerror", (e) => note("pageerror: " + (e.message || String(e))));
  page.on("console", (m) => { if (m.type() === "error") note("console.error: " + m.text()); });

  const url = `http://localhost:${PORT}/`;
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await page.evaluate(({ s, sk, dk }) => { try { localStorage.clear(); localStorage.setItem(sk, s); localStorage.removeItem(dk); localStorage.setItem("sekitsui.bgm", "0"); localStorage.setItem("sekitsui.mute", "1"); localStorage.setItem("sekitsui.dbg", "1"); } catch {} }, { s: clearedTownWorld(seed, diff), sk: SAVE_KEY, dk: DIVE_KEY });
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(400);
  // 続きから
  const tb = await page.$$eval("#titleMenu button", (els: any[]) => els.map((e) => (e.textContent || "").trim()));
  const ti = tb.findIndex((t: string) => /続き|物語|はじま|触れて/.test(t));
  await page.locator("#titleMenu button").nth(Math.max(0, ti)).click({ timeout: 4000 }).catch(() => {});
  await page.waitForTimeout(500);

  const dbg = async () => page.evaluate(() => (window as any).__dbg?.());
  const overlayShown = async () => page.evaluate(() => !!document.querySelector("#overlay")?.classList.contains("show"));
  let scenes = 0, nobleScenes = 0;
  // オーバーレイが出ていたら本文検査＋ボタン総当たりで閉じる
  async function handleOverlay(): Promise<boolean> {
    if (!(await overlayShown())) return false;
    const info = await page.evaluate(() => ({ btns: [...document.querySelectorAll("#sheetButtons button")].map((b) => (b.textContent || "").trim()), body: ((document.querySelector("#sheetText")?.textContent || "") + " " + (document.querySelector("#sheetMeta")?.textContent || "")).slice(0, 500) }));
    scenes++;
    if (NOBLE_RE.test(info.body)) nobleScenes++;
    if (/#[a-z_]+#/.test(info.body)) note(`leftover-slot: ${info.body.slice(0, 80)}`);
    if (/undefined|NaN/.test(info.body)) note(`undefined-in-body: ${info.body.slice(0, 80)}`);
    let idx = info.btns.findIndex((t: string) => /閉じ|やめ|戻る|出る|去る|済ま|後で|いいえ/.test(t));
    if (idx < 0) idx = 0;
    last = `scene:${info.btns[idx] || "?"}`;
    await page.locator("#sheetButtons button").nth(idx).click({ timeout: 4000 }).catch(() => {});
    await page.waitForTimeout(140);
    return true;
  }
  // BFS で target へ歩く（最大 maxSteps）。途中シーンは閉じる。
  // BFS で target へ歩く。群衆NPCが経路を塞いだら同方向 bump がそのまま会話/遭遇を発火＝ファジング目的に適う
  // （bump こそが court NPC/扉シーンのトリガーなので、振りほどき回避はしない）。一定手数で打ち切り別 spot へ。
  async function navTo(target: { x: number; y: number }, allowTargetTile: boolean, maxSteps = 80): Promise<boolean> {
    for (let s = 0; s < maxSteps; s++) {
      if (await handleOverlay()) continue;
      const d = await dbg(); if (!d) return false;
      if (d.townPlayer.x === target.x && d.townPlayer.y === target.y) return true;
      const k = bfsNextKey(d.grid, d.W, d.H, d.townPlayer, target, allowTargetTile);
      if (!k) return false;
      last = `nav→(${target.x},${target.y})`;
      await page.keyboard.press(k); await page.waitForTimeout(45);
    }
    return false;
  }

  // ① ngate(27,8) の真下(27,9) まで歩き、② ngate を踏んで貴族街へ、③ 区画内の扉/床を巡る
  const d0 = await dbg();
  const ng = d0?.ngate ?? { x: 27, y: 8 };
  await navTo({ x: ng.x, y: ng.y + 1 }, false, 90);   // ngate の隣
  await navTo({ x: ng.x, y: ng.y }, true, 6);          // ngate を踏む
  await navTo({ x: ng.x, y: ng.y - 1 }, true, 6);      // 貴族街側へ一歩
  // 貴族街内の見どころ：館扉(22,6)・謁見扉(32,6)・区画の床を数点 bump（宮廷NPC遭遇）
  const spots = [ { x: 22, y: 6 }, { x: 32, y: 6 }, { x: 20, y: 5 }, { x: 34, y: 5 }, { x: 27, y: 4 }, { x: 18, y: 4 }, { x: 38, y: 4 }, { x: 22, y: 6 }, { x: 32, y: 6 } ];
  for (const sp of spots) {
    await navTo(sp, true, 40);
    // 扉/NPC を bump（同方向に数回押して相互作用を起こす）
    for (let b = 0; b < 3; b++) { if (await handleOverlay()) { b--; continue; } await page.keyboard.press("ArrowUp").catch(() => {}); await page.waitForTimeout(60); }
  }
  // 残った謁見/館オーバーレイを掃く
  for (let s = 0; s < 30; s++) { if (!(await handleOverlay())) { await page.keyboard.press("ArrowDown").catch(() => {}); await page.waitForTimeout(40); } }

  const dEnd = await dbg();
  await ctx.close();
  return { seed, diff, scenes, nobleScenes, reachedNoble: !!dEnd && dEnd.townPlayer.y < 8, finalPos: dEnd?.townPlayer, errors };
}

async function main() {
  await new Promise<void>((r) => server.listen(PORT, () => r()));
  console.log(`serving ${WEB_DIR} :${PORT}  (クリア後貴族街ファジング・BFSナビ)`);
  const browser = await chromium.launch({ headless: true, executablePath: EXEC, args: ["--no-sandbox"] });
  const diffs = ["easy", "normal", "hard"];
  const all: string[] = [];
  for (let i = 0; i < SEEDS.length; i++) {
    const r = await runSeed(browser, SEEDS[i], diffs[i % diffs.length]);
    console.log(`▶ seed=${r.seed} ${r.diff}: シーン${r.scenes}（宮廷${r.nobleScenes}） 貴族街到達=${r.reachedNoble ? "✓" : "✗"} 終点=${JSON.stringify(r.finalPos)} 例外${r.errors.length}`);
    all.push(...r.errors);
  }
  await browser.close(); server.close();
  console.log(`\n=== 完了：${SEEDS.length} シード ===`);
  console.log(`JS例外/未充填/undefined = ${all.length}件`);
  if (all.length) { console.log("--- 詳細（最大40件）---"); all.slice(0, 40).forEach((e) => console.log("  " + e)); process.exitCode = 1; }
  else console.log("  ✅ 例外なし");
}
main().catch((e) => { console.error(e); process.exit(1); });

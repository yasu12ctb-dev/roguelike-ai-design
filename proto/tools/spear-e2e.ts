// 一時検証スクリプト（槍武器 v0.124.0 の実ブラウザE2E）。検証後に削除する。
// 実行: cd proto && node --experimental-strip-types tools/spear-e2e.ts
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, extname } from "node:path";
import { newWorld, createCharacter } from "../src/world.ts";
import { genFloor, MONSTER_KINDS, type Monster, type Floor } from "../src/dungeon.ts";
import { forgeItem } from "../src/items.ts";
import { maxHp } from "../src/progression.ts";
import type { World } from "../src/types.ts";

const { chromium } = await import("playwright");
const __dirname = dirname(fileURLToPath(import.meta.url));
const WEB_DIR = join(__dirname, "..", "web");
const SHOTS = join(__dirname, "..", "..", "..", "..", "tmp", "spear-shots"); // fallback below
const OUT = process.env.SHOTS_DIR || "/tmp/claude-0/-home-user-roguelike-ai-design/2f2ddac3-1f20-5c24-9644-2364f16abc2c/scratchpad/spear-shots";
mkdirSync(OUT, { recursive: true });
const EXEC = process.env.EXEC || "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
const PORT = +(process.env.PORT || 8790);
const SAVE_KEY = "sekitsui.world.v0";
const DIVE_KEY = "sekitsui.dive.v0";

const MIME: Record<string, string> = { ".html": "text/html", ".js": "application/javascript", ".css": "text/css", ".json": "application/json", ".svg": "image/svg+xml", ".webmanifest": "application/manifest+json" };
const server = createServer(async (req, res) => {
  try { const url = (req.url || "/").split("?")[0]; const path = join(WEB_DIR, url === "/" ? "index.html" : url); const body = await readFile(path); res.writeHead(200, { "Content-Type": MIME[extname(path)] || "application/octet-stream" }); res.end(body); }
  catch { res.writeHead(404); res.end("nf"); }
});

const KIND = MONSTER_KINDS.find((k) => k.key === "ghoul")!; // tier3・能力なし・素直な近接

let monSeq = 0;
function mkMon(x: number, y: number, hp: number): Monster {
  return { id: `qa_${monSeq++}`, kind: { ...KIND }, hp, awake: true, intent: null, x, y } as Monster;
}

// 中央に開けた床の正方領域を彫り、指定モンスターを置いた検証用フロアと注入セーブを作る。
function buildInjection(weaponBase: string, monsters: (f: Floor, cx: number, cy: number) => Monster[]) {
  const w: World = newWorld(12345);
  w.difficulty = "easy" as any;
  const ch = createCharacter(w, "槍検証者", "wanderer", { relation: "none" });
  ch.level = 10; ch.xp = 0; ch.gold = 100;
  ch.stats = { body: 14, power: 10, reason: 8, heart: 8 };
  const wp = forgeItem(weaponBase, null, 0)!; wp.unidentified = false; ch.equipment.weapon = wp;
  ch.depth = 5;
  w.current = ch;

  const floor = genFloor(w, 5);
  // 中央付近に 9x9 の開けた床を彫る（player を中心に据える）。周囲エンティティは全消去。
  const cx = Math.floor(floor.w / 2), cy = Math.floor(floor.h / 2);
  const R = 4;
  for (let y = cy - R; y <= cy + R; y++) for (let x = cx - R; x <= cx + R; x++) {
    if (x <= 0 || y <= 0 || x >= floor.w - 1 || y >= floor.h - 1) continue;
    floor.tiles[y * floor.w + x] = 1;
  }
  floor.monsters = monsters(floor, cx, cy);
  floor.fossils = []; floor.chests = []; floor.shrines = []; floor.downed = null; floor.delver = null;
  floor.returnDoor = null;
  floor.explored = new Array(floor.w * floor.h).fill(true);
  floor.stairsUp = { x: cx, y: cy }; // 上り階段が player 位置に来ないよう遠くへ
  floor.stairsUp = { x: 1, y: 1 }; floor.tiles[1 * floor.w + 1] = 1;
  floor.stairsDown = { x: floor.w - 2, y: floor.h - 2 }; floor.tiles[(floor.h - 2) * floor.w + (floor.w - 2)] = 1;

  const snap = { depth: 5, hp: maxHp(ch), inAbyss: false, player: { x: cx, y: cy }, floor, cache: [] as any[], pursuerCount: 0, turnsSinceFloor: 0, setPieceCooldown: 0, quietDescents: 0 };
  return { world: JSON.stringify(w), dive: JSON.stringify(snap), cx, cy };
}

async function loadScenario(browser: any, inj: { world: string; dive: string }, errors: string[], tag: string) {
  const ctx = await browser.newContext({ viewport: { width: 480, height: 900 }, serviceWorkers: "block" });
  const page = await ctx.newPage();
  page.on("pageerror", (e: any) => errors.push(`[${tag}] pageerror: ${e.message || e}`));
  page.on("console", (m: any) => { if (m.type() === "error") errors.push(`[${tag}] console.error: ${m.text()}`); });
  const url = `http://localhost:${PORT}/`;
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await page.evaluate(({ s, d, sk, dk }: any) => { try { localStorage.clear(); localStorage.setItem(sk, s); localStorage.setItem(dk, d); localStorage.setItem("sekitsui.bgm", "0"); localStorage.setItem("sekitsui.mute", "1"); } catch {} }, { s: inj.world, d: inj.dive, sk: SAVE_KEY, dk: DIVE_KEY });
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(300);
  // タイトルが出れば「続きから」で復帰
  const title = await page.evaluate(() => !!document.querySelector("#title")?.classList.contains("show"));
  if (title) {
    const btns = await page.$$eval("#titleMenu button", (bs: any[]) => bs.map((b) => (b.textContent || "").trim()));
    let i = btns.findIndex((t: string) => /続き|物語|はじま|触れて/.test(t));
    if (i < 0) i = 0;
    await page.locator("#titleMenu button").nth(i).click({ timeout: 4000 }).catch(() => {});
    await page.waitForTimeout(400);
  }
  return { ctx, page };
}

// 現在の生モンスターHPと player 座標・ログ末尾・floats を読む。
async function readState(page: any) {
  return await page.evaluate(({ dk }: any) => {
    let mons: any[] = [], player: any = null;
    try { const s = JSON.parse(localStorage.getItem(dk) || "{}"); if (s.floor) { mons = s.floor.monsters.map((m: any) => ({ id: m.id, hp: m.hp, x: m.x, y: m.y })); player = s.player; } } catch {}
    const logText = (document.querySelector("#log")?.textContent || "");
    const floats = (document.querySelector("#floats")?.textContent || "");
    const lungeShown = !!document.querySelector("#lungeBtn")?.classList.contains("show");
    const hp = document.querySelector("#stHpVal")?.textContent || "";
    // グリッド上の @ 位置
    let ax = -1, ay = -1;
    const grid = document.querySelector("#grid");
    if (grid) { const cols = getComputedStyle(grid as Element).gridTemplateColumns.split(" ").length; const cells = [...grid.querySelectorAll(".cell")]; for (let i = 0; i < cells.length; i++) { if ((cells[i].textContent || "").trim() === "@") { ax = i % cols; ay = Math.floor(i / cols); } } }
    return { mons, player, logText, floats, lungeShown, hp, ax, ay };
  }, { dk: DIVE_KEY });
}

async function main() {
  await new Promise<void>((r) => server.listen(PORT, () => r()));
  const browser = await chromium.launch({ headless: true, executablePath: EXEC, args: ["--no-sandbox"] });
  const errors: string[] = [];
  const results: string[] = [];
  const pass = (n: string, ok: boolean, detail: string) => results.push(`${ok ? "PASS" : "FAIL"} ${n}: ${detail}`);

  // ---- A: 槍・直線距離2に敵・距離1空き → 右キーで敵HP減＆座標不変＆手番消費 ----
  {
    const inj = buildInjection("木槍", (f, cx, cy) => [mkMon(cx + 2, cy, 100)]); // 右2マスに敵、右1は空き
    const { ctx, page } = await loadScenario(browser, inj, errors, "A");
    const before = await readState(page);
    await page.keyboard.press("ArrowRight"); await page.waitForTimeout(250);
    await page.screenshot({ path: join(OUT, "A_spear_reach2.png") }).catch(() => {});
    const after = await readState(page);
    const m0 = before.mons[0], m1 = after.mons.find((m: any) => m.id === m0.id);
    const hpDrop = m1 && m1.hp < m0.hp;
    const coordSame = after.player && after.player.x === inj.cx && after.player.y === inj.cy;
    const turnConsumed = after.floats.length > 0 || /一撃/.test(after.logText);
    pass("A(射程2直線攻撃)", !!(hpDrop && coordSame && turnConsumed),
      `敵HP ${m0.hp}→${m1?.hp} / player=(${after.player?.x},${after.player?.y}) 期待(${inj.cx},${inj.cy}) / floats="${after.floats.slice(0,20)}"`);
    await ctx.close();
  }

  // ---- B: 距離1と距離2に敵 → 1入力で両方HP減（貫通・奥は基礎ダメ） ----
  {
    const inj = buildInjection("木槍", (f, cx, cy) => [mkMon(cx + 1, cy, 100), mkMon(cx + 2, cy, 100)]);
    const { ctx, page } = await loadScenario(browser, inj, errors, "B");
    const before = await readState(page);
    await page.keyboard.press("ArrowRight"); await page.waitForTimeout(250);
    await page.screenshot({ path: join(OUT, "B_spear_pierce.png") }).catch(() => {});
    const after = await readState(page);
    const near0 = before.mons.find((m: any) => m.x === inj.cx + 1)!, far0 = before.mons.find((m: any) => m.x === inj.cx + 2)!;
    const near1 = after.mons.find((m: any) => m.id === near0.id), far1 = after.mons.find((m: any) => m.id === far0.id);
    const bothDrop = near1 && far1 && near1.hp < near0.hp && far1.hp < far0.hp;
    const pierceLog = /槍が貫き、奥の/.test(after.logText);
    pass("B(貫通・両方被弾)", !!(bothDrop && pierceLog),
      `手前HP ${near0.hp}→${near1?.hp}・奥HP ${far0.hp}→${far1?.hp} / 貫きログ=${pierceLog}`);
    await ctx.close();
  }

  // ---- C: 斜め隣接に敵 → 斜め入力で攻撃されず手番非消費 ----
  {
    const inj = buildInjection("木槍", (f, cx, cy) => [mkMon(cx + 1, cy + 1, 100)]); // 右下斜め隣接
    const { ctx, page } = await loadScenario(browser, inj, errors, "C");
    const before = await readState(page);
    await page.keyboard.press("n"); await page.waitForTimeout(250); // n = 右下 [1,1]
    await page.screenshot({ path: join(OUT, "C_spear_no_diag.png") }).catch(() => {});
    const after = await readState(page);
    const m0 = before.mons[0], m1 = after.mons.find((m: any) => m.id === m0.id);
    const hpSame = m1 && m1.hp === m0.hp;
    const playerSame = after.player && after.player.x === inj.cx && after.player.y === inj.cy && after.ax >= 0;
    const diagLog = /斜めには突けない/.test(after.logText);
    const noFloat = after.floats.trim().length === 0;
    pass("C(斜め攻撃不可・非消費)", !!(hpSame && playerSame && diagLog && noFloat),
      `敵HP ${m0.hp}→${m1?.hp} / player=(${after.player?.x},${after.player?.y}) 期待(${inj.cx},${inj.cy}) / ログ斜め=${diagLog} / floats空=${noFloat}`);
    await ctx.close();
  }

  // ---- D: 槍装備中 #lungeBtn 非表示 / 剣なら表示 ----
  {
    const injSpear = buildInjection("木槍", () => []);
    const s1 = await loadScenario(browser, injSpear, errors, "D-spear");
    await s1.page.waitForTimeout(150);
    const spearState = await readState(s1.page);
    await s1.ctx.close();

    const injSword = buildInjection("長剣", () => []);
    const s2 = await loadScenario(browser, injSword, errors, "D-sword");
    await s2.page.waitForTimeout(150);
    const swordState = await readState(s2.page);
    await s2.page.screenshot({ path: join(OUT, "D_sword_lunge_shown.png") }).catch(() => {});
    await s2.ctx.close();
    pass("D(踏ボタン槍で非表示/剣で表示)", spearState.lungeShown === false && swordState.lungeShown === true,
      `槍lungeShown=${spearState.lungeShown} / 剣lungeShown=${swordState.lungeShown}`);
  }

  // ---- D2: 実際の持ち替え（袋の剣に装備し直して #lungeBtn が出るか）----
  {
    const inj = buildInjection("木槍", () => []);
    // 袋に剣を入れておく
    const w = JSON.parse(inj.world); const sword = forgeItem("長剣", null, 0)!; sword.unidentified = false;
    w.current.gearBag = [sword]; inj.world = JSON.stringify(w);
    const { ctx, page } = await loadScenario(browser, inj, errors, "D2-swap");
    const beforeSwap = await readState(page);
    // ステータス(#statBtn) → 「装備・持ち物を見る」→ 袋の「長剣」カード → 「装備する」。
    const clickBtn = async (re: RegExp) => {
      await page.waitForTimeout(380); // chooseGrid/sheet は表示から 300ms 未満のクリックを無視するガードがある
      const btns = await page.$$eval("#sheetButtons button", (bs: any[]) => bs.map((b) => (b.textContent || "").trim()));
      const i = btns.findIndex((t: string) => re.test(t));
      if (i >= 0) { await page.locator("#sheetButtons button").nth(i).click({ timeout: 3000 }).catch(() => {}); await page.waitForTimeout(220); return true; }
      return false;
    };
    let swapped = false;
    try {
      await page.click("#statBtn", { timeout: 3000 }).catch(() => {});
      await page.waitForTimeout(220);
      await clickBtn(/装備・持ち物を見る/);          // charScreen → gearSheet
      await clickBtn(/長剣/);                          // gearSheet 袋カード → manageBagGear
      swapped = await clickBtn(/装備する/);            // manageBagGear → 装備実行
      // シートを閉じて盤面へ戻す
      for (let k = 0; k < 6; k++) {
        const shown = await page.evaluate(() => !!document.querySelector("#overlay")?.classList.contains("show"));
        if (!shown) break;
        if (!await clickBtn(/閉じ|戻る|やめ/)) await page.keyboard.press("Escape").catch(() => {});
        await page.waitForTimeout(150);
      }
    } catch { /* best effort */ }
    await page.waitForTimeout(200);
    const afterSwap = await readState(page);
    const equippedSword = await page.evaluate(({ dk, sk }: any) => { try { const w = JSON.parse(localStorage.getItem(sk) || "{}"); return w.current?.equipment?.weapon?.baseName || w.current?.equipment?.weapon?.name || "?"; } catch { return "?"; } }, { dk: DIVE_KEY, sk: SAVE_KEY });
    await page.screenshot({ path: join(OUT, "D2_after_swap.png") }).catch(() => {});
    pass("D2(持ち替えで踏ボタン出現)", swapped && afterSwap.lungeShown === true,
      `swap試行=${swapped} / 装備武器=${equippedSword} / 持替後lungeShown=${afterSwap.lungeShown}（槍時=${beforeSwap.lungeShown}）`);
    await ctx.close();
  }

  // ---- E: 剣装備で斜め隣接攻撃が可能（回帰） ----
  {
    const inj = buildInjection("長剣", (f, cx, cy) => [mkMon(cx + 1, cy + 1, 100)]);
    const { ctx, page } = await loadScenario(browser, inj, errors, "E");
    const before = await readState(page);
    await page.keyboard.press("n"); await page.waitForTimeout(250);
    await page.screenshot({ path: join(OUT, "E_sword_diag.png") }).catch(() => {});
    const after = await readState(page);
    const m0 = before.mons[0], m1 = after.mons.find((m: any) => m.id === m0.id);
    const hpDrop = m1 && m1.hp < m0.hp;
    pass("E(剣・斜め攻撃可・回帰)", !!hpDrop, `敵HP ${m0.hp}→${m1?.hp} / floats="${after.floats.slice(0,16)}"`);
    await ctx.close();
  }

  // ---- F: 槍で敵を倒せる（downOrKill 経路・例外なし） ----
  {
    const inj = buildInjection("木槍", (f, cx, cy) => [mkMon(cx + 2, cy, 3)]); // 低HP＝一撃で倒れる
    const { ctx, page } = await loadScenario(browser, inj, errors, "F");
    const before = await readState(page);
    await page.keyboard.press("ArrowRight"); await page.waitForTimeout(300);
    await page.screenshot({ path: join(OUT, "F_spear_kill.png") }).catch(() => {});
    const after = await readState(page);
    const m1 = after.mons.find((m: any) => m.id === before.mons[0].id);
    const killed = !m1 || m1.hp <= 0; // 撃破＝snapshot から消えるか hp<=0
    pass("F(槍で撃破)", killed, `撃破後の該当敵=${m1 ? `hp${m1.hp}` : "消滅"} / ログ末尾に例外なし`);
    await ctx.close();
  }

  console.log("\n===== 槍 E2E 結果 =====");
  for (const r of results) console.log("  " + r);
  console.log(`\nJS例外/console.error = ${errors.length}件`);
  for (const e of [...new Set(errors)]) console.log("  ⚠ " + e);
  const fails = results.filter((r) => r.startsWith("FAIL")).length;
  console.log(`\n合否: ${results.length - fails}/${results.length} pass, 例外${errors.length}`);
  console.log(`スクショ: ${OUT}`);

  await browser.close(); server.close();
}
main().catch((e) => { console.error(e); process.exit(1); });

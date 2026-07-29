// 実ブラウザ E2E（横断F ②・タイトルの来歴／ステータスの詰め版／節見出しのウェイト）：
//   §10.2b が宣言する三点を **実ブラウザが実際にそう解決するか** で固定する。
//   検査＝①堆積した世界でタイトル中央に来歴 3 行＋金泥の細罫が出る（文言・出典つき）
//        ②「還った」でなく「眠る者」＝副題（まだ誰も潜っていない）と食い違わない
//        ③ステータスは `compact`＝480×900 で**内容が視野に収まる**（はみ出し 0）
//        ④見出し（.sec-h / .sg）は weight 700
//        ⑤詰め版でもタッチ最小 48px を割らない・短い選択肢が 2 列・`閉じる` は全幅
//        ⑥HP/攻撃は能力行へ、薬・巻物/武具は持ち物 1 行へ集約されている
//        ⑦★compact が**他のシートへ残らない**（設定シートは詰め版でない）
//   ★③⑤⑥は数値・構造を厳密に見る＝「詰め版をやめた」「行を戻した」変更で必ず落ちる。
//   ローカル専用（CI 外・playwright は package.json に入れない規約）。既存 e2e-*/visual-check と同一手法。
// 実行: EXEC=<chromium> node --experimental-strip-types tools/e2e-ui-prefs.ts
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, extname } from "node:path";
import { newWorld, createCharacter, fossilizeCurrent } from "../src/world.ts";
import { SPELLS } from "../src/spells.ts";
import type { World } from "../src/types.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const WEB_DIR = join(__dirname, "..", "web");
const SHOTS = join(__dirname, "shots2", "prefs");
mkdirSync(SHOTS, { recursive: true });
const EXEC = process.env.EXEC || "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
const PORT = +(process.env.PORT || 8793);
const SAVE_KEY = "sekitsui.world.v0";
const { chromium } = await import("playwright");
const MIME: Record<string, string> = { ".html": "text/html", ".js": "application/javascript", ".json": "application/json", ".svg": "image/svg+xml", ".webmanifest": "application/manifest+json" };
const server = createServer(async (req, res) => {
  try { const url = (req.url || "/").split("?")[0]; const p = join(WEB_DIR, url === "/" ? "index.html" : url); const b = await readFile(p); res.writeHead(200, { "Content-Type": MIME[extname(p)] || "application/octet-stream" }); res.end(b); }
  catch { res.writeHead(404); res.end("nf"); }
});

/** 化石が積もった世界（第7世代・印2つ）＋生きた Lv46 の当代。 */
function agedWorld(): string {
  const w: World = newWorld(7); w.difficulty = "normal";
  for (let i = 0; i < 6; i++) {
    const dead = createCharacter(w, `先代${i + 1}`, "wanderer", { relation: "none" });
    dead.depth = 8 + i * 5; w.current = dead;
    fossilizeCurrent(w, "combat", { kind: "none" } as never);
    w.generation++;
  }
  w.seals = ["abyss_boss", "requiem"];
  const ch = createCharacter(w, "灰かぶりのイオ", "wanderer", { relation: "none" });
  ch.level = 46; ch.gold = 480; ch.stats = { body: 16, power: 14, reason: 14, heart: 12 };
  ch.spells = SPELLS.map((s) => s.key); ch.loadout = ch.spells.slice(0, 10);
  ch.exposure = 0.62; ch.xp = 120; w.current = ch;
  return JSON.stringify(w);
}
/** 新規世界（化石ゼロ）＝来歴は出さないことの確認用。 */
function freshWorld(): string {
  const w: World = newWorld(3); w.difficulty = "normal";
  const ch = createCharacter(w, "はじまりの者", "wanderer", { relation: "none" });
  w.current = ch;
  return JSON.stringify(w);
}

async function main() {
  await new Promise<void>((r) => server.listen(PORT, () => r()));
  const browser = await chromium.launch({ headless: true, executablePath: EXEC, args: ["--no-sandbox"] });
  const url = `http://localhost:${PORT}/`;
  let fails = 0;
  const ok = (c: boolean, m: string) => { console.log(`${c ? "  ok " : "  NG "}${m}`); if (!c) fails++; };

  async function newPage(world?: string) {
    const ctx = await browser.newContext({ viewport: { width: 480, height: 900 }, deviceScaleFactor: 2, serviceWorkers: "block" });
    const page = await ctx.newPage();
    const errs: string[] = [];
    page.on("pageerror", (e: any) => errs.push(String(e)));
    page.on("console", (m: any) => { if (m.type() === "error") errs.push(m.text()); });
    await page.goto(url, { waitUntil: "domcontentloaded" });
    await page.evaluate(({ w, sk }) => { try { localStorage.clear(); localStorage.setItem("sekitsui.bgm", "0"); localStorage.setItem("sekitsui.mute", "1"); if (w) localStorage.setItem(sk, w); } catch {} }, { w: world, sk: SAVE_KEY });
    await page.goto(url, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(700);
    return { ctx, page, errs };
  }

  // 1. タイトルの来歴（堆積した世界＝出る／新規世界＝出ない）
  {
    const { ctx, page, errs } = await newPage(agedWorld());
    const lore = await page.evaluate(() => {
      const el = document.getElementById("titleLore")!;
      const s = getComputedStyle(el);
      return { hidden: el.hidden, text: el.textContent, display: s.display, color: s.color, size: s.fontSize, rules: el.querySelectorAll(".rule").length };
    });
    console.log("  lore:", JSON.stringify(lore));
    ok(!lore.hidden && lore.display !== "none", "堆積した世界では来歴が出る");
    ok(/この深みに 眠る者 \d+人/.test(lore.text ?? ""), "化石数の行");
    ok(/最も深く 眠るのは 深度 \d+/.test(lore.text ?? ""), "最深の行");
    ok(/捧げられた印 2／5/.test(lore.text ?? ""), "印の行");
    ok(lore.rules === 1, "金泥の細罫が1本");
    await page.screenshot({ path: join(SHOTS, "title_aged.png") });
    ok(errs.length === 0, `console/pageerror 0（${errs.length}）`);
    await ctx.close();
  }
  {
    const { ctx, page } = await newPage(freshWorld());
    const h = await page.evaluate(() => {
      const el = document.getElementById("titleLore")!;
      return { hidden: el.hidden, text: el.textContent, sub: document.getElementById("titleSub")?.textContent };
    });
    console.log("  fresh:", JSON.stringify(h));
    ok(!h.hidden && /眠る者/.test(h.text ?? ""), "新規世界でも種化石ぶんの来歴が出る");
    ok(!/還った/.test(h.text ?? ""), "副題と食い違う「還った」を使っていない");
    await page.screenshot({ path: join(SHOTS, "title_fresh.png") });
    await ctx.close();
  }

  // 2. ステータスシート（compact）と見出しウェイト
  {
    const { ctx, page, errs } = await newPage(agedWorld());
    const btns = await page.$$eval("#titleMenu button", (els: any[]) => els.map((e) => (e.textContent || "").trim()));
    let i = btns.findIndex((t: string) => /続き|触れて/.test(t)); if (i < 0) i = 0;
    await page.locator("#titleMenu button").nth(i).click({ timeout: 4000 }).catch(() => {});
    await page.waitForTimeout(800);
    await page.click("#statBtn", { timeout: 4000 }).catch(() => {});
    await page.waitForTimeout(600);
    const m = await page.evaluate(() => {
      const s = document.getElementById("sheet")!;
      const head = document.querySelector("#sheetList .sec-h") as HTMLElement;
      const hs = getComputedStyle(head);
      const btns = [...document.querySelectorAll<HTMLElement>("#sheetButtons button")];
      const widths = btns.map((b) => Math.round(b.getBoundingClientRect().width));
      const heights = btns.map((b) => Math.round(b.getBoundingClientRect().height));
      return {
        compact: s.classList.contains("compact"), content: s.scrollHeight, view: s.clientHeight,
        headWeight: hs.fontWeight, headColor: hs.color,
        labels: btns.map((b) => (b.textContent || "").trim()), widths, minH: Math.min(...heights),
        rows: [...document.querySelectorAll("#sheetList .kvrow")].map((r) => (r.querySelector(".kvlab")?.textContent || "").trim()),
      };
    });
    console.log("  sheet:", JSON.stringify(m));
    ok(m.compact, "ステータスは compact");
    ok(m.headWeight === "700", `見出し weight 700（${m.headWeight}）`);
    ok(m.minH >= 48, `タッチ最小 48px 維持（最小 ${m.minH}）`);
    ok(!m.rows.includes("最大HP") && !m.rows.includes("攻撃"), "HP/攻撃は能力行へ集約");
    ok(m.rows.includes("持ち物"), "薬・巻物/武具は持ち物1行へ");
    ok(m.content <= m.view, `480×900 で一画面に収まる（はみ出し ${m.content - m.view}px・content=${m.content} view=${m.view}）`);
    // 2列になっているか＝同じ幅の短いボタンが2つ以上ある
    const half = m.widths.filter((w: number) => w < 260).length;
    ok(half >= 2, `短い選択肢が2列（半幅ボタン ${half}）`);
    await page.screenshot({ path: join(SHOTS, "status_compact.png") });
    // 他のシートに compact が残らないこと＝末尾の「閉じる」で畳んでから設定シートを開いて確認
    await page.evaluate(() => {
      const b = [...document.querySelectorAll<HTMLElement>("#sheetButtons button")].find((x) => /閉じる/.test(x.textContent || ""));
      b?.click();
    });
    await page.waitForTimeout(600);
    await page.click("#cogBtn", { timeout: 4000 }).catch(() => {});
    await page.waitForTimeout(800);
    const s2 = await page.evaluate(() => {
      const s = document.getElementById("sheet")!;
      const sg = document.querySelector("#sheetButtons .sg") as HTMLElement | null;
      return { compact: s.classList.contains("compact"), cols: getComputedStyle(document.getElementById("sheetButtons")!).display, sgWeight: sg ? getComputedStyle(sg).fontWeight : "n/a" };
    });
    ok(!s2.compact && s2.cols !== "grid", `設定シートは詰め版でない（compact=${s2.compact} display=${s2.cols}）`);
    ok(s2.sgWeight === "700", `設定の群見出しも 700（${s2.sgWeight}）`);
    await page.screenshot({ path: join(SHOTS, "settings.png") });
    ok(errs.length === 0, `console/pageerror 0（${errs.length}）`);
    await ctx.close();
  }

  await browser.close(); server.close();
  console.log(fails === 0 ? "\n== すべて pass ==" : `\n== ${fails} 件 NG ==`);
  process.exit(fails ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });

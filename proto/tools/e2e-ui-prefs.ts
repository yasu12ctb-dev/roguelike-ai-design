// 実ブラウザ E2E（横断F ②・タイトルの来歴／ステータスの詰め版／節見出しのウェイト）：
//   §10.2b が宣言する三点を **実ブラウザが実際にそう解決するか** で固定する。
//   検査＝①堆積した世界でタイトル中央に来歴 3 行＋金泥の細罫が出る（文言・出典つき）
//        ②「還った」でなく「眠る者」＝副題（まだ誰も潜っていない）と食い違わない
//        ③ステータスは `compact`＝**375×812（実機相当）と 480×900 の両方**で内容が視野に収まる
//        ④見出し（.sec-h / .sg）は weight 700 かつ **色が :root の `--tx-2` と一致**（rgb は書き写さず読む）
//        ⑤詰め版のボタン組みを**ラベル対応**で固定＝半幅4つが均等／`進行中…` と `閉じる` は全幅／全て 48px 以上
//        ⑥HP/攻撃は能力行へ、薬・巻物/武具は持ち物 1 行へ集約・**装備の節は2列（先頭行は左右とも上罫なし）**
//        ⑦★compact が**他のシートへ残らない**＝`chooseGrid`（装備・持ち物＝カード一覧）へ実際に入って外れることと、
//           設定シート（`sheet()` 経路）が詰め版でないことの両方を踏む
//   ★③⑤⑥は数値・構造を厳密に見る＝「詰め版をやめた」「行を戻した」「全幅指定を外した」変更で必ず落ちる。
//   ローカル専用（CI 外・playwright は package.json に入れない規約）。既存 e2e-*/visual-check と同一手法。
// 実行: EXEC=<chromium> node --experimental-strip-types tools/e2e-ui-prefs.ts
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, extname } from "node:path";
import { newWorld, createCharacter, fossilizeCurrent } from "../src/world.ts";
import { forgeItem, itemByName } from "../src/items.ts";
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

/** 化石が積もった世界（第7世代・印2つ）＋生きた Lv46 の当代。
 *  ★装備4枠は**必ず実物を埋める**。空（すべて「—」）で測ると装備行が最短になり、
 *  「一画面に収まる」の検査が甘くなる（実装備で +86px はみ出す状態を見落とした反省・2026-07-30）。 */
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
  ch.exposure = 0.62; ch.xp = 120;
  // 終盤想定の実装備（性能説明つきラベルなら数行に伸びる長さ＝要約が短名であることの検査面）
  ch.equipment.weapon = forgeItem("薙刀", "keen", 2)!;   // 鋭利な薙刀+2（攻＋5・薙ぎ払い…）
  ch.equipment.armor = forgeItem("鎖帷子", "fine", 1)!;  // 業物の鎖帷子+1（被ダメ−3）
  ch.equipment.relic = itemByName("不死鳥の灰")!;        // （一度だけ致死を耐える）
  ch.equipment.bag = itemByName("探索者の背嚢")!;        // （持てる量＋5）
  w.current = ch;
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

  async function newPage(world?: string, vp = { width: 480, height: 900 }) {
    const ctx = await browser.newContext({ viewport: vp, deviceScaleFactor: 2, serviceWorkers: "block" });
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

  // 2. ステータスシート（compact）＝**実機相当 375×812 と 480×900 の両方**で検査する。
  //    ★ここを 480 だけで見ていたために 375 の 77px はみ出しを見落とした（Codex 指摘・2026-07-30）。
  //    期待するボタン組み＝2列。ただし長いラベル（進行中…）と cancel（閉じる）は全幅。
  const HALF = ["装備・持ち物を見る", "術（構え・図鑑）", "人物と年代記", "敵図鑑"];
  const FULL = ["進行中（依頼・因縁・印）", "閉じる"];
  for (const vp of [{ width: 375, height: 812 }, { width: 480, height: 900 }]) {
    const tag = `${vp.width}×${vp.height}`;
    const { ctx, page, errs } = await newPage(agedWorld(), vp);
    const btns = await page.$$eval("#titleMenu button", (els: any[]) => els.map((e) => (e.textContent || "").trim()));
    let i = btns.findIndex((t: string) => /続き|触れて/.test(t)); if (i < 0) i = 0;
    await page.locator("#titleMenu button").nth(i).click({ timeout: 4000 }).catch(() => {});
    await page.waitForTimeout(800);
    await page.click("#statBtn", { timeout: 4000 }).catch(() => {});
    await page.waitForTimeout(600);
    const m = await page.evaluate(() => {
      // --tx-2 は :root から読む（rgb を書き写すとトークンを変えたときに黙って腐る）。
      const hex = getComputedStyle(document.documentElement).getPropertyValue("--tx-2").trim();
      const rgbOf = (h: string) => {
        const x = h.replace("#", "");
        const n = x.length === 3 ? [...x].map((c) => c + c) : [x.slice(0, 2), x.slice(2, 4), x.slice(4, 6)];
        return `rgb(${n.map((p) => parseInt(p, 16)).join(", ")})`;
      };
      const s = document.getElementById("sheet")!;
      const head = document.querySelector("#sheetList .sec-h") as HTMLElement;
      const hs = getComputedStyle(head);
      const geom: Record<string, { w: number; h: number }> = {};
      for (const b of document.querySelectorAll<HTMLElement>("#sheetButtons button")) {
        const r = b.getBoundingClientRect();
        geom[(b.textContent || "").trim()] = { w: Math.round(r.width), h: Math.round(r.height) };
      }
      const gearGrid = document.querySelector("#sheetList .kvgrid");
      return {
        tokenTx2: rgbOf(hex), tokenRaw: hex,
        compact: s.classList.contains("compact"), content: s.scrollHeight, view: s.clientHeight,
        headWeight: hs.fontWeight, headColor: hs.color, geom,
        listWidth: Math.round(document.getElementById("sheetList")!.getBoundingClientRect().width),
        gearCols: gearGrid ? getComputedStyle(gearGrid).gridTemplateColumns.split(" ").length : 0,
        gearBorders: gearGrid ? [...gearGrid.querySelectorAll<HTMLElement>(".kvrow")].map((r) => getComputedStyle(r).borderTopWidth) : [],
        gearVals: gearGrid ? [...gearGrid.querySelectorAll<HTMLElement>(".kvval")].map((v) => (v.textContent || "").trim()) : [],
        gearLines: gearGrid ? [...gearGrid.querySelectorAll<HTMLElement>(".kvrow")].map((r) => Math.round(r.getBoundingClientRect().height)) : [],
        rows: [...document.querySelectorAll("#sheetList .kvrow")].map((r) => (r.querySelector(".kvlab")?.textContent || "").trim()),
      };
    });
    console.log(`  [${tag}]`, JSON.stringify(m));
    ok(m.compact, `[${tag}] ステータスは compact`);
    // ★①一画面に収まる（両ビューポート）
    ok(m.content <= m.view, `[${tag}] 一画面に収まる（はみ出し ${m.content - m.view}px・content=${m.content} view=${m.view}）`);
    // ★②見出しの色が --tx-2 であることを直接 assert（weight とセット）
    ok(m.headWeight === "700", `[${tag}] 見出し weight 700（${m.headWeight}）`);
    ok(m.headColor === m.tokenTx2, `[${tag}] 見出し色＝--tx-2（${m.tokenRaw} → ${m.tokenTx2}／実測 ${m.headColor}）`);
    // ★③ラベル対応で 2列＋全幅を assert（幅の閾値ではなくラベルで固定する）
    const found = Object.keys(m.geom);
    ok(HALF.every((l) => l in m.geom) && FULL.every((l) => l in m.geom),
      `[${tag}] 期待ラベル6つが揃う（${found.join(" / ")}）`);
    const halfW = HALF.map((l) => m.geom[l]?.w ?? -1);
    const fullW = FULL.map((l) => m.geom[l]?.w ?? -1);
    ok(new Set(halfW).size === 1 && halfW[0] > 0, `[${tag}] 半幅4つが均等（${halfW.join(",")}）`);
    ok(new Set(fullW).size === 1 && fullW[0] > halfW[0] * 1.8, `[${tag}] 全幅2つ（${fullW.join(",")}）＝半幅の約2倍`);
    ok(Math.abs(fullW[0] - m.listWidth) <= 2, `[${tag}] 全幅がシート幅と一致（${fullW[0]} vs ${m.listWidth}）`);
    ok(Object.values(m.geom).every((g: any) => g.h >= 48), `[${tag}] タッチ最小 48px 維持（${Object.values(m.geom).map((g: any) => g.h).join(",")}）`);
    // 行の集約と装備2列
    ok(!m.rows.includes("最大HP") && !m.rows.includes("攻撃"), `[${tag}] HP/攻撃は能力行へ集約`);
    ok(m.rows.includes("持ち物"), `[${tag}] 薬・巻物/武具は持ち物1行へ`);
    ok(m.gearCols === 2, `[${tag}] 装備の節が2列（cols=${m.gearCols}）`);
    ok(m.gearBorders.slice(0, 2).every((b: string) => b === "0px"), `[${tag}] 2列の先頭行は左右とも上罫なし（${m.gearBorders.join(",")}）`);
    // ★装備は実物が入っている（＝空欄で測って収まったことにしない）
    ok(m.gearVals.length === 4 && m.gearVals.every((v: string) => v !== "" && v !== "—"),
      `[${tag}] 装備4枠に実物が入っている（${m.gearVals.join(" / ")}）`);
    // ★要約は短名＝性能説明（「（攻＋5…」）を出さない。出すと 375 で装備行が数行に伸びる。
    ok(m.gearVals.every((v: string) => !v.includes("（") || v.includes("未鑑定")),
      `[${tag}] 装備の値は銘・+N までの短名（性能説明を出さない）`);
    ok(m.gearLines.every((h: number) => h <= 34), `[${tag}] 装備行が1行に収まる（${m.gearLines.join(",")}）`);
    await page.screenshot({ path: join(SHOTS, `status_compact_${vp.width}.png`) });
    // ★④chooseGrid（カード一覧）へ入ったら compact が外れる＝remove 経路を実際に踏む
    await page.evaluate(() => {
      const b = [...document.querySelectorAll<HTMLElement>("#sheetButtons button")].find((x) => /装備・持ち物を見る/.test(x.textContent || ""));
      b?.click();
    });
    await page.waitForTimeout(800);
    const g = await page.evaluate(() => ({
      compact: document.getElementById("sheet")!.classList.contains("compact"),
      grid: !!document.querySelector("#sheetButtons .selgrid"),
      head: document.getElementById("sheetHeadTitle")?.textContent ?? "",
    }));
    console.log(`  [${tag}] chooseGrid:`, JSON.stringify(g));
    ok(g.grid, `[${tag}] chooseGrid のカード一覧が出た（${g.head}）`);
    ok(!g.compact, `[${tag}] chooseGrid では compact が外れる`);
    await page.screenshot({ path: join(SHOTS, `gearsheet_${vp.width}.png`) });
    // 他のシートに compact が残らないこと＝閉じてから設定シートを開いて確認（sheet() 側の toggle 経路）
    for (let k = 0; k < 3; k++) {
      await page.evaluate(() => {
        const b = [...document.querySelectorAll<HTMLElement>("#sheetButtons button,#sheetButtons .selgrid button")].find((x) => /^閉じる|閉じる$/.test((x.textContent || "").trim()));
        b?.click();
      });
      await page.waitForTimeout(500);
      if (!(await page.evaluate(() => document.getElementById("overlay")!.classList.contains("show")))) break;
    }
    await page.click("#cogBtn", { timeout: 4000 }).catch(() => {});
    await page.waitForTimeout(800);
    const s2 = await page.evaluate(() => {
      const s = document.getElementById("sheet")!;
      const sg = document.querySelector("#sheetButtons .sg") as HTMLElement | null;
      const hex = getComputedStyle(document.documentElement).getPropertyValue("--tx-2").trim();
      return {
        compact: s.classList.contains("compact"),
        cols: getComputedStyle(document.getElementById("sheetButtons")!).display,
        sgWeight: sg ? getComputedStyle(sg).fontWeight : "n/a",
        sgColor: sg ? getComputedStyle(sg).color : "n/a",
        tx2: hex,
      };
    });
    ok(!s2.compact && s2.cols !== "grid", `[${tag}] 設定シートは詰め版でない（compact=${s2.compact} display=${s2.cols}）`);
    ok(s2.sgWeight === "700", `[${tag}] 設定の群見出しも 700（${s2.sgWeight}）`);
    ok(s2.sgColor === m.tokenTx2, `[${tag}] 設定の群見出し色＝--tx-2（実測 ${s2.sgColor}）`);
    await page.screenshot({ path: join(SHOTS, `settings_${vp.width}.png`) });
    ok(errs.length === 0, `[${tag}] console/pageerror 0（${errs.length}）`);
    await ctx.close();
  }

  await browser.close(); server.close();
  console.log(fails === 0 ? "\n== すべて pass ==" : `\n== ${fails} 件 NG ==`);
  process.exit(fails ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });

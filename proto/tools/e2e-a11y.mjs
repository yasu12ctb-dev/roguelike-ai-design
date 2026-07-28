// 実ブラウザ E2E（U1b・高コントラスト / Reduce Motion）：
//   静的検査（tools/a11y-check.ts）は「CSS の文字列がそう書いてある」ことしか保証しない。
//   本 E2E は **実ブラウザが実際にそう解決するか**＝メディアクエリが効いているか、
//   既定モードが無変化か、B（状態・予告）が Reduce Motion でも見えているかを実測で担保する。
//   検査＝①既定モードのトークンが従来値のまま ②prefers-contrast: more で 7 変数だけが差し替わる
//        ③その状態で WCAG 比が基準を満たす（getComputedStyle の実測値から再計算）
//        ④prefers-reduced-motion: reduce で A/C の animation-name が none
//        ⑤★B（テレグラフ）は animation が止まっても静的な高視認状態が残る（消えていない）
//        ⑥Reduce Motion でも情報表示そのもの（bannerfade / fxflash）は残る
//   ローカル専用（CI 外・playwright は package.json に入れない規約）。既存 e2e-*.mjs と同一手法。
import { chromium } from "playwright";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { join, extname } from "node:path";

const WEB_DIR = decodeURIComponent(new URL("../web/", import.meta.url).pathname);
const PORT = 41990 + Math.floor(Math.random() * 900);
const EXEC = process.env.PW_CHROMIUM || "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
const MIME = { ".html": "text/html", ".js": "text/javascript", ".json": "application/json", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png", ".webmanifest": "application/manifest+json" };

const server = createServer(async (req, res) => {
  try {
    const url = (req.url || "/").split("?")[0];
    const file = url === "/" ? "index.html" : url;
    const body = await readFile(join(WEB_DIR, file));
    res.writeHead(200, { "Content-Type": MIME[extname(file)] || "text/html" });
    res.end(body);
  } catch { res.writeHead(404); res.end("nf"); }
});
await new Promise((r) => server.listen(PORT, "127.0.0.1", r));

const results = [];
const ok = (name, cond, extra = "") => { results.push({ name, pass: !!cond, extra }); console.log(`${cond ? "✅" : "❌"} ${name}${extra ? "  " + extra : ""}`); };

const browser = await chromium.launch({ executablePath: EXEC });
const page = await browser.newPage({ viewport: { width: 480, height: 900 } });
// ★エラー収集は goto の前に登録する（window.__errs を読むだけでは何も集まらず空テストになる）
const pageErrors = [];
page.on("pageerror", (e) => pageErrors.push(String(e)));
page.on("console", (m) => { if (m.type() === "error") pageErrors.push(m.text()); });
await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: "domcontentloaded" });

/** :root の CSS 変数を実測（getComputedStyle＝ブラウザが解決した値）。 */
const vars = (names) => page.evaluate((ns) => {
  const cs = getComputedStyle(document.documentElement);
  return Object.fromEntries(ns.map((n) => [n, cs.getPropertyValue("--" + n).trim()]));
}, names);
/** セレクタに一致する要素を作って、解決後のスタイルを読む（盤面セルは実際に生成されないため合成する）。 */
const styleOf = (html, sel, props) => page.evaluate(({ html, sel, props }) => {
  const host = document.createElement("div");
  host.style.cssText = "position:absolute;left:-9999px;top:0";
  host.innerHTML = html;
  document.body.appendChild(host);
  const el = host.querySelector(sel);
  const cs = getComputedStyle(el);
  const out = Object.fromEntries(props.map((p) => [p, cs.getPropertyValue(p)]));
  const after = getComputedStyle(el, "::after"), before = getComputedStyle(el, "::before");
  out["::after.animation-name"] = after.animationName; out["::after.border-top-color"] = after.borderTopColor;
  out["::after.background-color"] = after.backgroundColor;
  out["::before.animation-name"] = before.animationName; out["::before.background-color"] = before.backgroundColor;
  host.remove();
  return out;
}, { html, sel, props });

const HC = { "tx-meta": "#988d79", "tx-faint": "#897d66", line: "#716048", "line-2": "#8b7656", "line-3": "#8b7656", "g-wall": "#708298", "g-floor": "#576578" };
const DEFAULT = { "tx-meta": "#857a66", "tx-faint": "#6b6250", line: "#372f23", "line-2": "#4a3f2e", "line-3": "#4a3f2e", "g-wall": "#39434f", "g-floor": "#2c333d" };
const KEEP = ["g-player", "c-hp", "c-exp", "acc", "gold-leaf", "g-boss", "g-fossil", "bg-app", "bg-void"]; // 変わってはいけない正典色

// ---- ① 既定モード（雰囲気優先＝従来値のまま） -------------------------------
await page.emulateMedia({ reducedMotion: "no-preference", contrast: "no-preference" });
const d = await vars([...Object.keys(DEFAULT), ...KEEP]);
ok("① 既定モード：7 変数が従来値のまま", Object.entries(DEFAULT).every(([k, v]) => d[k] === v), Object.entries(DEFAULT).filter(([k, v]) => d[k] !== v).map(([k]) => k).join(",") || "全一致");
const keepDefault = Object.fromEntries(KEEP.map((k) => [k, d[k]]));

// ---- ② 高コントラスト：7 変数だけが差し替わる ------------------------------
await page.emulateMedia({ contrast: "more" });
const h = await vars([...Object.keys(HC), ...KEEP]);
ok("② prefers-contrast: more で 7 変数が高コントラスト値へ", Object.entries(HC).every(([k, v]) => h[k] === v), Object.entries(HC).filter(([k, v]) => h[k] !== v).map(([k]) => `${k}=${h[k]}`).join(",") || "全一致");
ok("② 正典色（自分/HP/深蝕/朱/金泥/ボス/化石/背景）は不変", KEEP.every((k) => h[k] === keepDefault[k]), KEEP.filter((k) => h[k] !== keepDefault[k]).join(",") || "全一致");

// ---- ③ その状態で WCAG 比が基準を満たす（実測値から再計算） ----------------
{
  const ratio = await page.evaluate((pairs) => {
    const lin = (c) => { const s = c / 255; return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4); };
    const parse = (h) => { const n = parseInt(h.replace("#", ""), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; };
    const lum = (h) => { const [r, g, b] = parse(h); return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b); };
    const cs = getComputedStyle(document.documentElement);
    const v = (n) => cs.getPropertyValue("--" + n).trim();
    return pairs.map(([fg, bg, need]) => {
      const a = lum(v(fg)) + 0.05, b = lum(v(bg)) + 0.05;
      return { fg, r: +(a > b ? a / b : b / a).toFixed(2), need };
    });
    // ★判定面は §10.2f の規則表どおり（tx-faint は .fl-miss が盤面に載るため最悪面 bg-wall）
  }, [["tx-meta", "bg-sheet", 4.5], ["tx-faint", "bg-wall", 4.5], ["line", "bg-sheet", 3], ["line-2", "bg-sheet", 3], ["g-wall", "bg-wall", 3], ["g-floor", "bg-wall", 3]]);
  ok("③ 高コントラスト適用後の WCAG 比が基準以上", ratio.every((x) => x.r >= x.need), ratio.map((x) => `${x.fg} ${x.r}:1`).join(" / "));
}

// ---- ④⑤⑥ Reduce Motion ------------------------------------------------------
await page.emulateMedia({ contrast: "no-preference", reducedMotion: "reduce" });
{
  // A＝装飾：止まる（★.g-boss / .g-fossil は Codex 検収で B へ移したので A の検査に使わない）
  const a1 = await styleOf('<span class="g-spring">泉</span>', ".g-spring", ["animation-name"]);
  const a2 = await styleOf('<span class="g-downed">&</span>', ".g-downed", ["animation-name"]);
  ok("④ A（装飾）の animation が停止", a1["animation-name"] === "none" && a2["animation-name"] === "none", `spring=${a1["animation-name"]} downed=${a2["animation-name"]}`);
  // C＝単発：移動・振動は止まる
  const c1 = await styleOf('<div class="shake-crit"></div>', ".shake-crit", ["animation-name"]);
  const c2 = await styleOf('<div id="floats"><span class="fl fl-crit">9</span></div>', ".fl-crit", ["animation-name", "font-size", "color"]);
  ok("④ C（単発）の shake / crit が停止", c1["animation-name"] === "none" && c2["animation-name"] === "none");
  // ※字の大きさは検査しない：`#floats .fl`(id+class) が `.fl-crit`(class) に詳細度で勝ち、
  //   §10.3 が謳う「特大 21px の会心数字」は U1b 以前から 15px で描かれている（既存の乖離・別件）。
  //   ここで見るのは「RM で停止させても数字が消えていないこと」だけ。
  ok("④ C 停止後も会心数字は見える（表示自体は残す）",
    c2.color === "rgb(255, 255, 255)" && parseFloat(c2["font-size"]) > 0, `${c2["font-size"]} ${c2.color}`);

  // ★B＝状態・予告：止まるが静的な高視認状態が残る（消えていない）
  const b1 = await styleOf('<span class="g-player-danger">@</span>', ".g-player-danger", ["animation-name", "text-shadow", "color"]);
  ok("⑤ B: 被攻撃予告 @ は停止しても赤＋最大発光が残る",
    b1["animation-name"] === "none" && b1["text-shadow"].includes("18px") && b1.color === "rgb(255, 79, 60)", b1["text-shadow"].slice(0, 60));
  const b2 = await styleOf('<span class="g-mon-atk g-mon-t3">o</span>', ".g-mon-atk", ["animation-name", "text-shadow", "filter"]);
  ok("⑤ B: 敵の攻撃予告は停止しても強発光＋輝度が残る",
    b2["animation-name"] === "none" && b2["text-shadow"].includes("26px") && b2.filter.includes("brightness(1.5)"), b2.filter);
  const b3 = await styleOf('<div class="cell tele-atk"></div>', ".cell.tele-atk", []);
  ok("⑤ B: 討たれるマスの赤枠は停止しても濃いまま",
    b3["::after.animation-name"] === "none" && b3["::after.border-top-color"] === "rgba(255, 79, 60, 0.98)", b3["::after.border-top-color"]);
  const b4 = await styleOf('<div class="cell tele-boss"></div>', ".cell.tele-boss", []);
  ok("⑤ B: ボスの確定範囲は停止しても塗りが濃い側で固定",
    b4["::before.animation-name"] === "none" && b4["::before.background-color"] === "rgba(255, 140, 40, 0.24)", b4["::before.background-color"]);
  const b5 = await styleOf('<div class="cell hz-crumble hz-cracked"></div>', ".cell.hz-crumble", ["animation-name", "background-color"]);
  ok("⑤ B: 崩れ床の軋みは停止しても警告色で固定",
    b5["animation-name"] === "none" && b5["background-color"] === "rgba(220, 170, 70, 0.5)", b5["background-color"]);
  const b6 = await styleOf('<button id="lungeBtn" class="stance">踏</button>', "#lungeBtn", ["animation-name", "box-shadow"]);
  ok("⑤ B: 踏み込みの構え中は停止しても発光が残る", b6["animation-name"] === "none" && b6["box-shadow"].includes("20px"), b6["box-shadow"].slice(0, 50));

  // ★B（pulse 共用の情報用途・Codex 検収で A から移した5件）：停止後も「静的に区別できる」こと
  const f1 = await styleOf('<span class="g-fossil">†</span>', ".g-fossil", ["animation-name", "text-shadow", "color"]);
  const f2 = await styleOf('<span class="g-fossil-quiet">†</span>', ".g-fossil-quiet", ["animation-name", "text-shadow", "color"]);
  ok("⑤ B: 化石（未鎮め）と鎮め済みが RM 停止後も静的に区別できる",
    f1["animation-name"] === "none" && f1["text-shadow"].includes("30px") && f2["text-shadow"] === "none" && f1.color !== f2.color,
    `未鎮め=${f1.color}/glow有 鎮め済=${f2.color}/glow=${f2["text-shadow"]}`);
  const e1 = await styleOf('<span class="g-companion-erratic">@</span>', ".g-companion-erratic", ["animation-name", "text-shadow", "color"]);
  const e2 = await styleOf('<span class="g-companion">@</span>', ".g-companion", ["text-shadow", "color"]);
  ok("⑤ B: 奇癖の相棒と通常の相棒が RM 停止後も静的に区別できる",
    e1["animation-name"] === "none" && e1.color !== e2.color && e1["text-shadow"] !== e2["text-shadow"], `${e1.color} vs ${e2.color}`);
  const m5 = await styleOf('<span class="g-mon-t5">M</span>', ".g-mon-t5", ["animation-name", "text-shadow", "text-decoration-line"]);
  const m4 = await styleOf('<span class="g-mon-t4">M</span>', ".g-mon-t4", ["text-shadow"]);
  ok("⑤ B: 最危険敵（t5）が RM 停止後も静的な強発光で t4 と差がつく",
    m5["animation-name"] === "none" && m5["text-shadow"].includes("28px") && !m4["text-shadow"].includes("28px"), m5["text-shadow"].slice(0, 50));
  // ★同じ t5 敵の「通常時」と「攻撃予告中」が静的に区別できること（発光チャネルの奪い合いを
  //   形＝下線という別チャネルで解消した。Codex 検収 #404 の修正必須3）
  const atk5 = await styleOf('<span class="g-mon-atk g-mon-t5">M</span>', ".g-mon-atk", ["animation-name", "text-decoration-line"]);
  ok("⑤ B: 攻撃予告中の t5 と通常の t5 が静的に区別できる（下線の有無）",
    atk5["animation-name"] === "none" && atk5["text-decoration-line"] === "underline" && m5["text-decoration-line"] !== "underline",
    `予告中=${atk5["text-decoration-line"]} / 通常=${m5["text-decoration-line"]}`);

  // ⑥ 情報表示そのもの（不透明度だけのフェード）は残す
  const k1 = await styleOf('<div id="floorBanner" class="show">深度 12</div>', "#floorBanner", ["animation-name"]);
  const k2 = await styleOf('<div id="fx" class="warp"></div>', "#fx", ["animation-name"]);
  ok("⑥ 情報表示のフェード（バナー / 術の点滅）は残る", k1["animation-name"] === "bannerfade" && k2["animation-name"] === "fxflash", `${k1["animation-name"]} / ${k2["animation-name"]}`);
}

// ---- 既定モードに戻すとアニメが復活する（RM が効いているだけで壊していない） ----
await page.emulateMedia({ reducedMotion: "no-preference" });
{
  const r = await styleOf('<span class="g-boss">Ω</span>', ".g-boss", ["animation-name"]);
  const t = await styleOf('<div class="cell tele-atk"></div>', ".cell.tele-atk", []);
  ok("⑦ 既定モードではアニメが復活（RM 以外に影響していない）", r["animation-name"] === "pulse" && t["::after.animation-name"] === "tele", `${r["animation-name"]} / ${t["::after.animation-name"]}`);
}

ok("⑧ pageerror / console error 0", pageErrors.length === 0, pageErrors.slice(0, 2).join(" | "));

await browser.close();
server.close();
const pass = results.filter((r) => r.pass).length;
console.log(`\n== e2e-a11y: ${pass}/${results.length} pass ==`);
process.exit(pass === results.length ? 0 : 1);

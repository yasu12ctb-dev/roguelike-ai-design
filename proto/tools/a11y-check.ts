// アクセシビリティの受理検査（U1b・`npm run check` 同梱・純データ・playwright 非依存）。
//
// ★位置づけ：**宣言（prototype-spec.md §10.2d/§10.2f）を正典とし、実装（web/index.html）との差を落とす。**
//   U1c の教訓（実装を正典にしない・鍵ドリフトを毎回機械検査する）を UI アニメと配色へ適用したもの。
//
// 検査内容：
//   A) keyframes ドリフト   … `@keyframes` 集合 ＝ §10.2d の表の ID 集合（片側にしか無い ID は fail）
//   B) Reduce Motion 被覆   … 不透明度以外を動かす keyframe は、それを使う **全セレクタ** が
//                              `@media (prefers-reduced-motion: reduce)` に現れること
//   C) 静的代替の存在       … §10.2d で **B 分類（状態・予告）** の keyframe を使うセレクタは、
//                              RM ブロックで `animation` 以外のプロパティも宣言していること
//                              （＝テレグラフを「消すだけ」の実装を拒否する）
//   D) 高コントラスト突合   … §10.2f の表 ＝ `@media (prefers-contrast: more)` の :root 上書き（集合も値も）
//   E) WCAG 再計算          … 高コントラスト適用後、**全前景トークン**が対象別基準を満たす
//                              （`:root` の色変数が要件表に無ければ fail＝トークン追加の取りこぼし防止）
//   F) 参照ドリフト         … `main.ts` が `screen-model.ts` を import していない（bundle 膨張の予防）
//   G) self-test（変異試験） … 上記の拒否枝が効くことを **毎回** in-memory で自動検証
//
// 実行: node --experimental-strip-types tools/a11y-check.ts

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const HTML = join(__dirname, "..", "web", "index.html");
const MAIN = join(__dirname, "..", "src", "web", "main.ts");
const SPEC = join(__dirname, "..", "..", "prototype-spec.md");

type Issue = { code: string; msg: string };

// ---- WCAG 相対輝度・コントラスト比 -------------------------------------------
const rgb = (h: string): [number, number, number] => {
  const n = parseInt(h.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};
const lin = (c: number) => { const s = c / 255; return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4); };
const lum = (h: string) => { const [r, g, b] = rgb(h); return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b); };
export const contrast = (fg: string, bg: string): number => {
  const a = lum(fg) + 0.05, b = lum(bg) + 0.05;
  return a > b ? a / b : b / a;
};

// ---- 前景トークンの要件表（`:root` の色変数はすべてここに載っていること＝E のドリフト検査） ----
/** 判定区分：text=4.5:1／large=3:1（盤面グリフ＝大きな文字扱い）／ui=3:1（非テキスト UI）／skip=背景・非色 */
type Need = "text" | "large" | "ui" | "skip";
const ON_BOARD = ["bg-void", "bg-wall"] as const; // 盤面は最悪ケース（bg-wall）で判定
const REQ: Record<string, { on: readonly string[]; need: Need }> = {
  "bg-app": { on: [], need: "skip" }, "bg-panel": { on: [], need: "skip" }, "bg-void": { on: [], need: "skip" },
  "bg-wall": { on: [], need: "skip" }, "bg-sheet": { on: [], need: "skip" }, "bg-input": { on: [], need: "skip" },
  "bg-btn": { on: [], need: "skip" }, "bg-btn-active": { on: [], need: "skip" },
  line: { on: ["bg-sheet", "bg-panel"], need: "ui" }, "line-2": { on: ["bg-sheet", "bg-panel"], need: "ui" },
  "line-3": { on: ["bg-sheet", "bg-panel"], need: "ui" },
  tx: { on: ["bg-sheet"], need: "text" }, "tx-strong": { on: ["bg-sheet"], need: "text" },
  "tx-2": { on: ["bg-sheet"], need: "text" }, "tx-dim": { on: ["bg-sheet"], need: "text" },
  "tx-meta": { on: ["bg-sheet"], need: "text" }, "tx-faint": { on: ["bg-sheet"], need: "text" },
  "tx-status": { on: ["bg-panel"], need: "text" }, "tx-log": { on: ["bg-panel"], need: "text" },
  "tx-log-dim": { on: ["bg-panel"], need: "text" },
  acc: { on: ["bg-sheet"], need: "ui" }, "acc-2": { on: ["bg-sheet"], need: "ui" },
  "gold-leaf": { on: ["bg-sheet"], need: "ui" },
  "c-hp": { on: ["bg-panel"], need: "ui" }, "c-exp": { on: ["bg-panel"], need: "ui" },
  "c-gold": { on: ["bg-panel"], need: "ui" }, "c-buff": { on: ["bg-panel"], need: "ui" },
  "c-warn": { on: ["bg-panel"], need: "ui" },
  "c-atk": { on: ["bg-sheet"], need: "text" }, "c-ctl": { on: ["bg-sheet"], need: "text" },
  "c-mov": { on: ["bg-sheet"], need: "text" }, "c-sup": { on: ["bg-sheet"], need: "text" },
  "c-lore": { on: ["bg-sheet"], need: "text" }, "c-sum": { on: ["bg-sheet"], need: "text" },
  "g-player": { on: ON_BOARD, need: "large" }, "g-danger": { on: ON_BOARD, need: "large" },
  "g-companion": { on: ON_BOARD, need: "large" }, "g-companion-erratic": { on: ON_BOARD, need: "large" },
  "g-delver": { on: ON_BOARD, need: "large" }, "g-downed": { on: ON_BOARD, need: "large" },
  "g-summon": { on: ON_BOARD, need: "large" }, "g-stairs": { on: ON_BOARD, need: "large" },
  "g-wall": { on: ON_BOARD, need: "ui" }, "g-floor": { on: ON_BOARD, need: "ui" },
  "g-mon-t1": { on: ON_BOARD, need: "large" }, "g-mon-t2": { on: ON_BOARD, need: "large" },
  "g-mon-t3": { on: ON_BOARD, need: "large" }, "g-mon-t4": { on: ON_BOARD, need: "large" },
  "g-mon-t5": { on: ON_BOARD, need: "large" }, "g-elite": { on: ON_BOARD, need: "large" },
  "g-boss": { on: ON_BOARD, need: "large" }, "g-fossil": { on: ON_BOARD, need: "large" },
  "g-fossil-quiet": { on: ON_BOARD, need: "large" }, "g-chest": { on: ON_BOARD, need: "large" },
  "g-chest-open": { on: ON_BOARD, need: "large" }, "g-spring": { on: ON_BOARD, need: "large" },
  "g-rest": { on: ON_BOARD, need: "large" }, "g-door": { on: ON_BOARD, need: "large" },
  "g-aurel": { on: ON_BOARD, need: "large" }, "g-laila": { on: ON_BOARD, need: "large" },
};
const RATIO: Record<Exclude<Need, "skip">, number> = { text: 4.5, large: 3, ui: 3 };

// ---- CSS 抽出（正規表現＝依存追加なし。構造は限定的で足りる） --------------------
/** `@media (...) { ... }` のブロック本文を取り出す（1階層のネストに対応）。 */
function mediaBlock(css: string, cond: string): string | null {
  const head = css.indexOf(`@media ${cond}`);
  if (head < 0) return null;
  let i = css.indexOf("{", head), depth = 0;
  for (let j = i; j < css.length; j++) {
    if (css[j] === "{") depth++;
    else if (css[j] === "}") { depth--; if (depth === 0) return css.slice(i + 1, j); }
  }
  return null;
}
/** `--name:#hex` を拾う（値が hex 色でないものは無視＝`--r-btn:3px` 等）。 */
function colorVars(block: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of block.matchAll(/--([a-z0-9-]+)\s*:\s*(#[0-9a-fA-F]{6})\b/g)) out[m[1]] = m[2].toLowerCase();
  return out;
}
/** `selector { ... }` の一覧（コメントは除去済み前提）。 */
function rules(block: string): { sel: string; body: string }[] {
  const out: { sel: string; body: string }[] = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  for (const m of block.matchAll(re)) out.push({ sel: m[1].trim(), body: m[2] });
  return out;
}
const stripComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "");

export function parseCss(html: string) {
  const style = stripComments(html.slice(html.indexOf("<style>"), html.indexOf("</style>")));
  const rm = mediaBlock(style, "(prefers-reduced-motion: reduce)") ?? "";
  const hc = mediaBlock(style, "(prefers-contrast: more)") ?? "";
  // keyframes: 名前 → 本文で動かすプロパティ集合
  const kf: Record<string, Set<string>> = {};
  for (const m of style.matchAll(/@keyframes\s+([A-Za-z0-9_-]+)\s*\{/g)) {
    const start = m.index! + m[0].length;
    let depth = 1, j = start;
    for (; j < style.length && depth > 0; j++) { if (style[j] === "{") depth++; else if (style[j] === "}") depth--; }
    const body = style.slice(start, j - 1);
    kf[m[1]] = new Set([...body.matchAll(/([a-z-]+)\s*:/g)].map((p) => p[1]));
  }
  // animation 宣言: keyframes 名 → 使用セレクタ
  const users: Record<string, Set<string>> = {};
  const base = style.slice(0, style.indexOf("@media (prefers-contrast") >= 0 ? style.indexOf("@media (prefers-contrast") : style.length);
  for (const r of rules(base)) {
    for (const a of r.body.matchAll(/animation\s*:\s*([^;]+);?/g)) {
      for (const name of Object.keys(kf)) {
        if (new RegExp(`(^|[\\s,])${name}([\\s,]|$)`).test(a[1])) (users[name] ??= new Set()).add(r.sel);
      }
    }
  }
  return { kf, users, rmRules: rules(rm), hcVars: colorVars(hc), rootVars: colorVars(style.slice(style.indexOf(":root"), style.indexOf("}", style.indexOf(":root")))) };
}

// ---- doc（正典）抽出 ---------------------------------------------------------
/** §10.2d の表から keyframe ID → RM 分類（A/B/C）。ID は `` `name` `` の連なりで複数書ける。 */
export function docMotion(spec: string): { cls: Record<string, string>; issues: Issue[] } {
  const issues: Issue[] = [];
  const s = spec.indexOf("### 10.2d"), e = spec.indexOf("### 10.2f");
  if (s < 0 || e < 0 || e <= s) { issues.push({ code: "doc-range", msg: "§10.2d の範囲を特定できない" }); return { cls: {}, issues }; }
  const cls: Record<string, string> = {};
  for (const line of spec.slice(s, e).split("\n")) {
    if (!line.startsWith("|") || line.startsWith("|---")) continue;
    const c = line.split("|");
    if (c.length < 5) continue;
    const rm = c[3].replace(/\*/g, "").trim();
    if (!["A", "B", "C"].includes(rm)) continue;
    for (const m of c[1].matchAll(/`([A-Za-z0-9_-]+)`/g)) {
      if (cls[m[1]]) issues.push({ code: "doc-dup", msg: `§10.2d に重複 ID: ${m[1]}` });
      cls[m[1]] = rm;
    }
  }
  return { cls, issues };
}
/** §10.2f の表から トークン → 高コントラスト値。 */
export function docContrast(spec: string): { hc: Record<string, string>; issues: Issue[] } {
  const issues: Issue[] = [];
  const s = spec.indexOf("### 10.2f"), e = spec.indexOf("### 10.3 ");
  if (s < 0 || e < 0 || e <= s) { issues.push({ code: "doc-range", msg: "§10.2f の範囲を特定できない" }); return { hc: {}, issues }; }
  const hc: Record<string, string> = {};
  for (const line of spec.slice(s, e).split("\n")) {
    if (!line.startsWith("| `--")) continue;
    const c = line.split("|");
    const id = c[1].match(/`--([a-z0-9-]+)`/)?.[1];
    const val = c[4].match(/`(#[0-9a-fA-F]{6})`/)?.[1];
    if (id && val) hc[id] = val.toLowerCase();
  }
  return { hc, issues };
}

// ---- 検査本体 ----------------------------------------------------------------
export function audit(html: string, spec: string, mainTs: string): Issue[] {
  const out: Issue[] = [];
  const bad = (code: string, msg: string) => out.push({ code, msg });
  const css = parseCss(html);
  const { cls, issues: di } = docMotion(spec);
  const { hc: docHc, issues: di2 } = docContrast(spec);
  out.push(...di, ...di2);

  // A) keyframes ドリフト（両方向）
  for (const k of Object.keys(css.kf)) if (!cls[k]) bad("kf-undocumented", `§10.2d に無い @keyframes: ${k}`);
  for (const k of Object.keys(cls)) if (!css.kf[k]) bad("kf-missing", `§10.2d にあるが CSS に無い keyframe: ${k}`);

  // B/C) Reduce Motion 被覆と静的代替
  const rmSel = new Map<string, string>(); // 個別セレクタ → 宣言本文
  for (const r of css.rmRules) for (const s of r.sel.split(",")) rmSel.set(s.trim(), (rmSel.get(s.trim()) ?? "") + r.body);
  for (const [name, props] of Object.entries(css.kf)) {
    const onlyOpacity = props.size > 0 && [...props].every((p) => p === "opacity");
    const kind = cls[name];
    for (const sel of css.users[name] ?? []) {
      const body = rmSel.get(sel);
      if (!body) {
        if (onlyOpacity) continue; // 不透明度だけのフェードは残してよい（C の規定）
        bad("rm-uncovered", `Reduce Motion 未対応: ${sel}（${name}／分類 ${kind ?? "?"}）`);
        continue;
      }
      if (!/animation\s*:/.test(body)) bad("rm-no-stop", `RM ブロックに animation 宣言が無い: ${sel}`);
      if (kind === "B" && !/[a-z-]+\s*:/.test(body.replace(/animation\s*:[^;]*;?/g, "")))
        bad("rm-no-static", `B（状態・予告）なのに静的代替が無い: ${sel}（${name}）＝テレグラフを消してはならない`);
    }
  }

  // D) 高コントラスト：doc と CSS の突合（集合も値も）
  for (const [k, v] of Object.entries(docHc)) {
    if (!(k in css.hcVars)) bad("hc-missing", `§10.2f にあるが CSS の高コントラストに無い: --${k}`);
    else if (css.hcVars[k] !== v) bad("hc-value", `--${k} の値が doc(${v}) と CSS(${css.hcVars[k]}) で不一致`);
  }
  for (const k of Object.keys(css.hcVars)) if (!(k in docHc)) bad("hc-undocumented", `§10.2f に無い高コントラスト上書き: --${k}`);

  // E) WCAG 再計算（高コントラスト適用後・要件表のドリフトも見る）
  const eff = { ...css.rootVars, ...css.hcVars };
  for (const k of Object.keys(css.rootVars)) if (!(k in REQ)) bad("req-undocumented", `要件表に無い色トークン: --${k}（a11y-check の REQ に追加すること）`);
  for (const [k, req] of Object.entries(REQ)) {
    if (req.need === "skip") continue;
    if (!(k in eff)) { bad("req-stale", `要件表にあるが CSS に無いトークン: --${k}`); continue; }
    const worst = Math.min(...req.on.map((b) => contrast(eff[k], eff[b])));
    if (worst < RATIO[req.need]) bad("contrast", `高コントラストで基準未達: --${k} ${eff[k]} = ${worst.toFixed(2)}:1（必要 ${RATIO[req.need]}:1）`);
  }

  // F) 参照ドリフト（screen-model は production 描画から参照しない）
  if (/from\s+["'][^"']*screen-model/.test(mainTs)) bad("model-leak", "main.ts が screen-model を import している（bundle 膨張・U1c の前提が崩れる）");

  return out;
}

// ============ 実行 ============================================================
const html = readFileSync(HTML, "utf8"), spec = readFileSync(SPEC, "utf8"), mainTs = readFileSync(MAIN, "utf8");
let fail = 0;
const err = (m: string) => { if (fail < 30) console.error("  ✗ " + m); fail++; };

// G) self-test（変異試験・毎回実行）＝各拒否枝が実際に効くことの裏取り
{
  const T: { name: string; expect: string; run: () => Issue[] }[] = [
    { name: "@keyframes を doc から消す", expect: "kf-undocumented", run: () => audit(html, spec.replace(/\| `pulse` \|/, "| `pulse-x` |"), mainTs) },
    { name: "CSS から keyframes を消す", expect: "kf-missing", run: () => audit(html.replace("@keyframes pulse", "@keyframes pulseZ"), spec, mainTs) },
    { name: "RM 被覆から装飾セレクタを外す", expect: "rm-uncovered", run: () => audit(html.replace("\n      .g-mon-t5, .g-elite, .g-boss,", "\n      .g-elite, .g-boss,"), spec, mainTs) },
    { name: "B の静的代替を消す（テレグラフを消すだけの実装）", expect: "rm-no-static", run: () => audit(html.replace(/\.g-mon-atk \{\n\s*animation: none;[^}]*\}/, ".g-mon-atk {\n        animation: none; }"), spec, mainTs) },
    { name: "高コントラスト値を doc と食い違わせる", expect: "hc-value", run: () => audit(html.replace("--tx-meta:#988d79", "--tx-meta:#8b8272"), spec, mainTs) },
    { name: "高コントラスト上書きを1件落とす", expect: "hc-missing", run: () => audit(html.replace("--g-floor:#576578;", ""), spec, mainTs) },
    { name: "基準未達の値を高コントラストに入れる", expect: "contrast", run: () => audit(html.replace("--g-wall:#708298", "--g-wall:#39434f"), spec, mainTs) },
    { name: "要件表に無い色トークンを :root に足す", expect: "req-undocumented", run: () => audit(html.replace("--g-laila:#c9a3ff;", "--g-laila:#c9a3ff; --g-newbie:#123456;"), spec, mainTs) },
    { name: "main.ts が screen-model を import", expect: "model-leak", run: () => audit(html, spec, `import { SEM_TONES } from "./screen-model.ts";\n${mainTs}`) },
  ];
  let ng = 0;
  for (const t of T) {
    if (!t.run().some((i) => i.code === t.expect)) { err(`self-test 未検出: ${t.name}（期待 ${t.expect}）`); ng++; }
  }
  const clean = audit(html, spec, mainTs);
  if (clean.length) { for (const i of clean) err(`[${i.code}] ${i.msg}`); ng++; }
  console.log(`  self-test（変異試験）: ${T.length} 拒否枝 ＋ 正常系1 / NG ${ng}`);
}

// 実測サマリ
{
  const css = parseCss(html);
  const { cls } = docMotion(spec);
  const n = (k: string) => Object.values(cls).filter((v) => v === k).length;
  const eff = { ...css.rootVars, ...css.hcVars };
  const worstOf = (k: string) => Math.min(...REQ[k].on.map((b) => contrast(eff[k], eff[b])));
  const checked = Object.keys(REQ).filter((k) => REQ[k].need !== "skip" && k in eff);
  const min = checked.reduce((m, k) => Math.min(m, worstOf(k) / RATIO[REQ[k].need as Exclude<Need, "skip">]), Infinity);
  console.log(`  (A) keyframes: CSS ${Object.keys(css.kf).length} / doc ${Object.keys(cls).length}（A=${n("A")} B=${n("B")} C=${n("C")}）`);
  console.log(`  (B/C) Reduce Motion: RM ルール ${css.rmRules.length} 件・B の静的代替あり`);
  console.log(`  (D/E) 高コントラスト: 上書き ${Object.keys(css.hcVars).length} 変数 / WCAG 検査 ${checked.length} トークン（最小余裕 ×${min.toFixed(2)}）`);
}

if (fail) { console.error(`\n[a11y-check] FAIL: ${fail} 件`); process.exit(1); }
console.log("[a11y-check] OK  ※Dynamic Type と VoiceOver は Swift（U2）＝web では未検査");

// アクセシビリティの受理検査（U1b・`npm run check` 同梱・純データ・playwright 非依存）。
//
// ★位置づけ：**宣言（prototype-spec.md §10.2d/§10.2f）を正典とし、実装（web/index.html）との差を落とす。**
//   U1c の教訓（実装を正典にしない・鍵ドリフトを毎回機械検査する）を UI アニメと配色へ適用したもの。
//   ★閾値表もツールに持たず **§10.2f の規則表から生成**する（二重管理をしない）。
//
// 検査内容：
//   A) keyframe 集合 1:1     … `@keyframes` 29 ↔ §10.2d 意味論表 29（両方向＋件数）
//   B) 個別セレクタ 1:1      … `animation` 宣言のセレクタリストを **カンマで分解**し `@keyframes` を
//                              参照するものだけを採った 48 ↔ §10.2d RM 分類表 48（両方向＋件数）。
//                              `animation: none` のみ（`#light.town`）は対象外。1 セレクタが複数
//                              keyframe を使っても 1 件（`.fl-crit`）。
//   C) Reduce Motion 被覆    … A/B/C 分類のセレクタは RM ブロックに現れること。
//                              **免除（不透明度のみ）は逆に RM ブロックへ入れてはならない**
//                              （入れると情報表示そのものが消える＝`#floorBanner.show` は base opacity 0）
//   D) 静的代替の存在        … **B 分類**のセレクタは RM ブロックで `animation` 以外も宣言していること
//                              （＝テレグラフを「消すだけ」の実装を拒否する）
//   E) 高コントラスト突合    … §10.2f 差分表 ＝ `@media (prefers-contrast: more)` の :root 上書き
//   F) WCAG 再計算           … §10.2f **規則表から閾値・判定面を生成**し、`:root` の全色変数が
//                              ちょうど1行に解決されること＋高コントラスト適用後に基準を満たすこと
//   I) ルール内ハードコード前景色 … §10.2f の閉包は `:root` の変数についてしか閉じておらず、CSS ルールへ
//                              直接書いた色（`color`/`border-color`/`border` 系ショートハンド＝実測 55 宣言）は
//                              母集合の外にあった（v0.171.0 まで落款と朱塗りボタンの文字が 4.18:1 で未達）。
//                              **§10.2g の閉じた表と 1:1 に突合**する。抽出は**宣言単位で全件**（最初の 1 宣言だけ
//                              見ると後勝ちの二重宣言を取り逃がす）。前景の値は**不透明 3/6 桁 hex と rgb(a) だけ**を
//                              受け、4/8 桁 hex・hsl()・色名は未対応構文として fail（alpha の黙殺＝過大評価を防ぐ）。
//                              判定面は①`:root` トークン②`on:<sel>` の `background`③半透明なら `over:<トークン>` へ
//                              アルファ合成④`js:MAP_BG.*` の **4 形態だけ**。gradient は**全 stop を解析できた場合のみ**
//                              受理する。半透明の前景は面へ合成してから比を採る。判定の向き（any/all）は行が宣言する。
//   G) 参照ドリフト          … `main.ts` が `screen-model.ts` を import していない（bundle 膨張の予防）
//   H) self-test（変異試験）  … 上記の拒否枝が効くことを **毎回** in-memory で自動検証
//
// 実行: node --experimental-strip-types tools/a11y-check.ts

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const HTML = join(__dirname, "..", "web", "index.html");
const MAIN = join(__dirname, "..", "src", "web", "main.ts");
const SPEC = join(__dirname, "..", "..", "prototype-spec.md");

/** 正典が宣言する件数（doc 側の行を消したときに両側から同時に消える事故を捕まえるため固定値でも持つ）。 */
const EXPECT_KEYFRAMES = 29;
const EXPECT_SELECTORS = 48;
const EXPECT_TRANSITIONS = 1;

type Issue = { code: string; msg: string };
type Rule = { ids: string[]; globs: string[]; on: string[]; need: number | null };

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

// ---- CSS 抽出（正規表現＝依存追加なし。構造は限定的で足りる） --------------------
const stripComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "");
/** `@media (...) { ... }` のブロック本文（ネスト対応）。 */
function mediaBlock(css: string, cond: string): string | null {
  const head = css.indexOf(`@media ${cond}`);
  if (head < 0) return null;
  const i = css.indexOf("{", head);
  let depth = 0;
  for (let j = i; j < css.length; j++) {
    if (css[j] === "{") depth++;
    else if (css[j] === "}") { depth--; if (depth === 0) return css.slice(i + 1, j); }
  }
  return null;
}
/**
 * ★custom property を **値の形で 3 分岐**して閉じる（母集団から黙って消える経路を作らない）。
 *   - 6 桁 hex        … 色トークン＝規則表で解決し WCAG 検査
 *   - それ以外の色形式 … 3/4/8 桁 hex・rgb()/rgba()/hsl()/color()・色名 ＝ **fail**（許容は 6 桁 hex のみ）
 *   - 非色             … 許容リスト（下）に載っているものだけ通す。載っていない非色値も fail
 */
const NON_COLOR_VARS = new Set(["r-btn", "r-card", "r-chip", "gauge-h", "gauge-r", "torch-rgb"]);
const HEX6 = /^#[0-9a-fA-F]{6}$/;
const LOOKS_COLOR = /^(#|rgba?\(|hsla?\(|color\(|hwb\(|lab\(|lch\(|oklab\(|oklch\(|(red|blue|green|white|black|gray|grey|orange|purple|yellow|pink|brown|cyan|magenta|transparent|currentcolor)\b)/i;
/** プロジェクトの命名規約（小文字・数字・ハイフンのみ）。CSS 的にはもっと広いので**規約外は明示 fail**。 */
const VAR_NAME_OK = /^[a-z0-9-]+$/;
function customProps(block: string, where: string): { colors: Record<string, string>; names: string[]; issues: Issue[] } {
  const colors: Record<string, string> = {};
  const names: string[] = [];
  const issues: Issue[] = [];
  // ★名前は「拾ってから弾く」。旧実装は --([a-z0-9-]+) で、規約外の名前（大文字・underscore 等）が
  //   マッチせず **issue にならずに読み飛ばされて**いた＝母集団の入口で黙って消える穴だった。
  //   `()` を除外文字に入れるのは var(--x) の参照を名前と誤認しないため。
  for (const m of block.replace(/var\(\s*--[^)]*\)/g, "").matchAll(/--([^\s:;{}]+)\s*:\s*([^;{}]+)/g)) {
    const name = m[1], raw = m[2].trim();
    names.push(name);
    if (!VAR_NAME_OK.test(name)) {
      issues.push({ code: "var-name", msg: `[${where}] custom property 名が規約外（小文字・数字・ハイフンのみ）: --${name}` });
      continue;
    }
    if (HEX6.test(raw)) { colors[name] = raw.toLowerCase(); continue; }
    if (LOOKS_COLOR.test(raw))
      issues.push({ code: "color-format", msg: `[${where}] --${name} の色形式が許容外（6 桁 hex のみ）: ${raw}` });
    else if (!NON_COLOR_VARS.has(name))
      issues.push({ code: "var-unclassified", msg: `[${where}] --${name} は色でも既知の非色でもない: ${raw}（a11y-check の NON_COLOR_VARS へ登録するか色に直す）` });
  }
  return { colors, names, issues };
}

// ================= ★受け付ける CSS 文法（ホワイトリスト）=======================
// 4 度の検収で「怪しい形を見つけて弾く」方向（ブラックリスト）では原理的に閉じないと判明した。
// そこで **受け付ける形を宣言し、それ以外はすべて fail** する。新しい構文を使いたくなったら
// まず本宣言を更新する運用にする（黙って母集合から消える経路を作らない）。
//   G1 `<style>` はちょうど 1 個
//   G2 at-rule は `@keyframes` と `@media` のみ（@import/@supports/@layer/@container/@scope は不可）
//   G3 `@media` の条件は許容 3 種のみ（正規化して比較）。`prefers-contrast`/`prefers-reduced-motion`
//      は **各ちょうど 1 個**
//   G4 高コントラストと Reduce Motion のブロックは **style の末尾 2 ブロック**（以降に宣言を置かない）
//   G5 animation 系は `animation:` ショートハンドのみ・**1 ルール 1 宣言**・値に `var(` を含まない
//      （`animation-name` 等の個別プロパティ／二重宣言／var 経由は「未対応構文」として fail）
//   G6 custom property は `var(--x)` 参照を除去してから抽出＝括弧やエスケープを含む名前も必ず届く
//   G7 canonical case ＝ HTML タグ・at-rule・CSS プロパティ名はすべて小文字（大文字表記は fail）
//   G10 スクロール API（scroll / scrollTo / scrollBy / scrollIntoView）と style.scrollBehavior は
//       未対応＝値ではなく API の面を禁じる（現状 0 件）
//   G9 CSS の scroll-behavior は未対応（スムーススクロールも「動き」＝現状 0 件）
//   G8 CSS 外からアニメ/動きを足さない＝`style.animation` / bracket 記法 / `setProperty("animation")` /
//      Web Animations API（`.animate(` / `new Animation(`）/ JS からの stylesheet 注入
//      （`insertRule` / `adoptedStyleSheets` / `createElement("style")`）はすべて fail
//   ★文法違反があれば audit はそこで打ち切る（壊れた入力に無意味な診断をカスケードさせない）
const MEDIA_ALLOW = ["(display-mode:standalone)", "(prefers-contrast:more)", "(prefers-reduced-motion:reduce)"];
const normCond = (c: string) => c.replace(/\s+/g, "").toLowerCase();
const A11Y_CONDS = ["(prefers-contrast:more)", "(prefers-reduced-motion:reduce)"];

/** 許容文法の検査。ここで fail した場合、以降の検査結果は信用できない。 */
export function assertGrammar(html: string, mainTs: string): Issue[] {
  const out: Issue[] = [];
  const bad = (code: string, msg: string) => out.push({ code, msg });
  // G1/G7：<style> は case-insensitive に位置を取り（さもないと slice が壊れて診断がカスケードする）、
  //         そのうえで canonical（小文字）でなければ fail。
  const tags = html.match(/<\/?style[\s>]/gi) ?? [];
  if (tags.length !== 2) bad("grammar-style-count", `<style> はちょうど 1 個であること（タグ ${tags.length} 個）`);
  for (const t of tags) if (t !== t.toLowerCase()) bad("grammar-case", `HTML タグは小文字表記であること: ${t.trim()}`);
  const so = html.search(/<style[^>]*>/i), sc = html.search(/<\/style>/i);
  if (so < 0 || sc < 0 || sc <= so) { bad("grammar-style-count", "<style>…</style> を特定できない"); return out; }
  const style = stripComments(html.slice(so + html.slice(so).indexOf(">") + 1, sc));
  // G2/G7：at-rule は @keyframes / @media のみ・小文字表記のみ
  for (const m of style.matchAll(/@([A-Za-z-]+)/g)) {
    if (m[1] !== m[1].toLowerCase()) { bad("grammar-case", `at-rule は小文字表記であること: @${m[1]}`); continue; }
    if (!["keyframes", "media"].includes(m[1])) bad("grammar-at-rule", `未対応の at-rule: @${m[1]}（許容は @keyframes / @media のみ）`);
  }
  // G7：CSS プロパティ名も小文字（宣言位置のみを見る＝値の大文字〔font-family 等〕は対象外）
  for (const r of rules(style))
    for (const d of r.body.matchAll(/(^|;)\s*([-A-Za-z]+)\s*:/g)) {
      // custom property（--*）は CSS 的に case-sensitive ＝「大文字表記」ではなく命名規約の問題。
      // customProps() の var-name が扱うため、ここでは対象外にする（診断を取り違えないため）。
      if (d[2].startsWith("--")) continue;
      if (d[2] !== d[2].toLowerCase()) bad("grammar-case", `CSS プロパティ名は小文字表記であること: ${d[2]}（${r.sel.trim().slice(0, 40)}）`);
    }
  // G3：@media 条件は許容 3 種のみ・HC/RM は各ちょうど 1 個
  const conds = [...style.matchAll(/@media([^{]*)\{/g)].map((m) => normCond(m[1]));
  for (const c of conds) if (!MEDIA_ALLOW.includes(c)) bad("grammar-media-cond", `未対応の @media 条件: ${c}`);
  for (const need of A11Y_CONDS) {
    const n = conds.filter((c) => c === need).length;
    if (n !== 1) bad("grammar-media-count", `@media ${need} はちょうど 1 個であること（実際 ${n} 個）`);
  }
  // G4：HC と RM は **他の宣言を挟まない連続した suffix**（間・後ろの両方を検査する）
  const blocks: { start: number; end: number }[] = [];
  for (const m of style.matchAll(/@media([^{]*)\{/g)) {
    if (!A11Y_CONDS.includes(normCond(m[1]))) continue;
    let depth = 0, j = style.indexOf("{", m.index!);
    for (; j < style.length; j++) { if (style[j] === "{") depth++; else if (style[j] === "}") { depth--; if (!depth) break; } }
    blocks.push({ start: m.index!, end: j + 1 });
  }
  blocks.sort((a, b) => a.start - b.start);
  if (blocks.length === 2) {
    const gap = style.slice(blocks[0].end, blocks[1].start), tail = style.slice(blocks[1].end);
    if (/[^\s]/.test(gap)) bad("grammar-tail", `高コントラストと Reduce Motion のブロックの間に宣言がある: ${gap.trim().slice(0, 60)}…`);
    if (/[^\s]/.test(tail)) bad("grammar-tail", `a11y ブロックより後に宣言がある: ${tail.trim().slice(0, 60)}…`);
  }
  // G5：animation / transition 系プロパティの構文を閉じる（動きを生む経路は両方とも対象）
  for (const r of rules(style)) {
    for (const [head, code] of [["animation", "anim"], ["transition", "trans"]] as const) {
      const decls = [...r.body.matchAll(new RegExp(`(^|[;{\\s])(${head}[a-z-]*)\\s*:\\s*([^;]*)`, "g"))];
      const shorthand = decls.filter((d) => d[2] === head);
      for (const d of decls) if (d[2] !== head) bad(`grammar-${code}-prop`, `未対応の ${head} 個別プロパティ: ${d[2]}（${r.sel.trim().slice(0, 40)}）`);
      if (shorthand.length > 1) bad(`grammar-${code}-dup`, `1 ルールに ${head} 宣言が複数（後勝ちは解析しない）: ${r.sel.trim().slice(0, 40)}`);
      for (const d of shorthand) if (/var\(/.test(d[3])) bad(`grammar-${code}-var`, `${head} の値に var() は未対応: ${r.sel.trim().slice(0, 40)}`);
    }
  }
  // G9：CSS のスムーススクロールは未対応（現状 0 件。使うときは先に正典と検査を更新する）
  for (const r of rules(style))
    if (/(^|[;{\s])scroll-behavior\s*:/.test(r.body)) bad("grammar-scroll", `scroll-behavior は未対応（動きの経路）: ${r.sel.trim().slice(0, 40)}`);
  // G8：CSS 外（JS）からアニメ・スタイルを足す経路をすべて塞ぐ
  const JS_ANIM: [RegExp, string][] = [
    [/\.style\.(animation|transition)/, "style.animation / style.transition への代入"],
    [/\.style\s*\[\s*["'`](animation|transition)/, "style[\"animation\"] / style[\"transition\"]（bracket 記法）"],
    [/(animationName|transitionProperty)\s*=/, "animationName / transitionProperty への代入"],
    [/setProperty\(\s*["'`](animation|transition)/, 'setProperty("animation" / "transition", …)'],
    // ★スクロール系は「値の書き方」ではなく **API の面** を禁じる（値の変種は無限に作れるため）。
    [/\.style\.scrollBehavior/, "style.scrollBehavior への代入"],
    [/\.style\s*\[\s*["'`]scroll-?[bB]ehavior/, 'style["scrollBehavior"]（bracket 記法）'],
    [/setProperty\(\s*["'`]scroll-behavior/, 'setProperty("scroll-behavior", …)'],
    [/\.animate\s*\(/, "Web Animations API（.animate）"],
    [/new\s+Animation\s*\(/, "Web Animations API（new Animation）"],
    [/insertRule\s*\(/, "JS からの stylesheet 注入（insertRule）"],
    [/adoptedStyleSheets/, "JS からの stylesheet 注入（adoptedStyleSheets）"],
    [/createElement\(\s*["'`]style/, 'JS からの stylesheet 注入（createElement("style")）'],
  ];
  for (const [re, label] of JS_ANIM) if (re.test(mainTs)) bad("grammar-js-anim", `CSS 外からアニメ/スタイルを足している: ${label}`);
  // G10：スクロール API は未対応（現状 0 件＝main.ts は scrollTop / scrollHeight の
  //       プロパティ代入・参照のみで、単語境界により誤検出しない）。
  //       ★**呼び出し構文を一切解析せず、識別子の出現そのもの**を禁じる。これで bracket
  //       （window["scrollTo"]）・optional chaining（scrollTo?.()）・alias（const m = scrollTo）・
  //       prototype 経由（Element.prototype.scrollIntoView.call）を同時に閉じられる。
  //       構文の側を見ると変種が無限に作れる＝前回と同じ誤りを繰り返さないための形。
  for (const m of mainTs.matchAll(/\b(scroll|scrollTo|scrollBy|scrollIntoView)\b/g))
    bad("grammar-js-scroll", `スクロール API は未対応（動きの経路）: ${m[1]}`);
  return out;
}

// ※issues を捨てるヘルパ（旧 colorVars）は置かない＝取りこぼしの再発経路を作らないため。
//   custom property を読む箇所は必ず customProps() を通し、issues を audit へ集約する。
const rules = (block: string) => [...block.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({ sel: m[1].trim(), body: m[2] }));

/** at-rule 文脈つきの走査（§10.2g 用）。`@keyframes danger` の `50%` のような
 *  「同名になりうるセレクタ」を一意な鍵で呼べるようにする＝平坦な正規表現では区別できない。 */
export function scanRules(style: string): { ctx: string; sel: string; body: string }[] {
  const out: { ctx: string; sel: string; body: string }[] = [];
  const stack: string[] = [];
  let buf = "";
  for (let i = 0; i < style.length; ) {
    const c = style[i];
    if (c === "{") {
      const head = buf.replace(/\s+/g, " ").trim(); buf = "";
      if (head.startsWith("@")) { stack.push(head); i++; continue; }
      let depth = 1, j = i + 1;
      for (; j < style.length && depth > 0; j++) { if (style[j] === "{") depth++; else if (style[j] === "}") depth--; }
      out.push({ ctx: stack.join(" "), sel: head, body: style.slice(i + 1, j - 1) });
      i = j; continue;
    }
    if (c === "}") { stack.pop(); buf = ""; i++; continue; }
    buf += c; i++;
  }
  return out;
}
const fgKey = (ctx: string, sel: string) => (ctx ? `${ctx} ${sel}` : sel);
/** 前景を直接指定するプロパティ。 */
const FG_PROPS = ["color", "border-color"];
/** 色を内包しうるショートハンド（`border-radius` 等に誤爆しないよう**完全一致の列挙**にする）。 */
const SHORTHAND_PROPS = ["border", "border-top", "border-right", "border-bottom", "border-left", "outline"];
const HARD_PROPS = [...FG_PROPS, ...SHORTHAND_PROPS];
/** 3桁 hex を 6桁へ（ルール内は `#fff` の略記が普通に出る＝輝度計算の前に正規化する）。 */
const expandHex = (h: string) => (h.length === 4 ? "#" + [...h.slice(1)].map((c) => c + c).join("") : h.toLowerCase());
/** 面を作らない値＝母集合に入れない（色ではない／継承）。ここに無い非 hex は全て未対応構文で fail。 */
const NO_PAINT = new Set(["transparent", "inherit", "currentcolor", "none", "unset", "initial", "0"]);

/** 宣言を top-level `;` で分割（`rgba(…)` / `linear-gradient(…)` の中では割らない）。 */
export function decls(body: string): { prop: string; val: string }[] {
  const out: { prop: string; val: string }[] = [];
  const push = (s: string) => {
    const i = s.indexOf(":");
    if (i < 0) return;
    const p = s.slice(0, i).trim().toLowerCase();
    if (!p || p.startsWith("--")) return;
    out.push({ prop: p, val: s.slice(i + 1).trim() });
  };
  let depth = 0, cur = "";
  for (const ch of body) {
    if (ch === "(") depth++;
    else if (ch === ")") depth--;
    if (ch === ";" && depth === 0) { push(cur); cur = ""; continue; }
    cur += ch;
  }
  push(cur);
  return out;
}

/** ★色リテラルの**閉じた**文法。受け付けるのは「不透明 3/6 桁 hex」と「rgb()/rgba()」だけ。
 *  4/8 桁 hex・hsl()・色名は **alpha を正しく扱えない／未検証**なので未対応構文として fail する
 *  （黙って不透明として計算すると、半透明の色を過大評価して基準未達を見逃す）。 */
export type Lit = { hex: string; a: number };
export function parseColorLiteral(v: string): { lit?: Lit; skip?: boolean; bad?: string } {
  const s = v.trim().toLowerCase();
  if (s.startsWith("var(")) return { skip: true };          // トークン経由＝§10.2f の母集合
  if (NO_PAINT.has(s)) return { skip: true };
  if (/^#[0-9a-f]{3}$/.test(s) || /^#[0-9a-f]{6}$/.test(s)) return { lit: { hex: expandHex(s), a: 1 } };
  if (/^#[0-9a-f]{4}$/.test(s) || /^#[0-9a-f]{8}$/.test(s)) return { bad: `alpha つき hex は未対応構文: ${s}` };
  const m = s.match(/^rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*(?:,\s*(\d*\.?\d+)\s*)?\)$/);
  if (m) {
    const a = m[4] === undefined ? 1 : +m[4];
    if (!(a >= 0 && a <= 1)) return { bad: `alpha が範囲外: ${s}` };
    return { lit: { hex: "#" + [m[1], m[2], m[3]].map((n) => (+n).toString(16).padStart(2, "0")).join(""), a } };
  }
  return { bad: `未対応の色構文: ${s}` };
}
/** ショートハンド値から色らしいトークンを取り出す（`1.5px` `dashed` 等は色形に当たらない）。 */
export function colorTokens(val: string): string[] {
  const toks: string[] = [];
  let depth = 0, cur = "";
  for (const ch of val) {
    if (ch === "(") depth++;
    else if (ch === ")") depth--;
    if (/\s/.test(ch) && depth === 0) { if (cur) toks.push(cur); cur = ""; continue; }
    cur += ch;
  }
  if (cur) toks.push(cur);
  return toks.filter((t) => LOOKS_COLOR.test(t) && !NO_PAINT.has(t.toLowerCase()));
}

export function parseCss(html: string) {
  const style = stripComments(html.slice(html.indexOf("<style>"), html.indexOf("</style>")));
  const rm = mediaBlock(style, "(prefers-reduced-motion: reduce)") ?? "";
  const hc = mediaBlock(style, "(prefers-contrast: more)") ?? "";
  // keyframes: 名前 → 動かすプロパティ集合
  const kf: Record<string, Set<string>> = {};
  for (const m of style.matchAll(/@keyframes\s+([A-Za-z0-9_-]+)\s*\{/g)) {
    const start = m.index! + m[0].length;
    let depth = 1, j = start;
    for (; j < style.length && depth > 0; j++) { if (style[j] === "{") depth++; else if (style[j] === "}") depth--; }
    kf[m[1]] = new Set([...style.slice(start, j - 1).matchAll(/([a-z-]+)\s*:/g)].map((p) => p[1]));
  }
  // ★個別セレクタ（カンマ分解）→ 使用 keyframe 集合。RM/HC ブロック内の宣言は数えない。
  const heads = ["@media (prefers-contrast", "@media (prefers-reduced-motion"]
    .map((k) => (style.indexOf(k) < 0 ? style.length : style.indexOf(k)));
  const selKf: Record<string, Set<string>> = {};
  for (const r of rules(style.slice(0, Math.min(...heads)))) {
    const a = r.body.match(/animation\s*:\s*([^;]+)/);
    if (!a) continue;
    const used = Object.keys(kf).filter((n) => new RegExp(`(^|[\\s,])${n}([\\s,]|$)`).test(a[1]));
    if (!used.length) continue; // `animation: none` のみ＝対象外
    for (const s of r.sel.split(",")) for (const u of used) (selKf[s.trim()] ??= new Set()).add(u);
  }
  // ★非 keyframe motion：base 領域で transition を宣言する個別セレクタ（カンマ分解）
  const selTr: Record<string, string> = {};
  for (const r of rules(style.slice(0, Math.min(...heads)))) {
    const t = r.body.match(/(^|[;{\s])transition\s*:\s*([^;]+)/);
    if (!t) continue;
    for (const sel of r.sel.split(",")) selTr[sel.trim()] = t[2].trim();
  }
  // RM ブロックの個別セレクタ → 宣言本文
  const rmSel = new Map<string, string>();
  for (const r of rules(rm)) for (const s of r.sel.split(",")) rmSel.set(s.trim(), (rmSel.get(s.trim()) ?? "") + r.body);
  const rootStart = style.indexOf(":root");
  // ★:root と高コントラストブロックの**両方**へ同じ閉じた検査を掛ける（対称化）。
  //   HC 側だけ素通りしていたのが U1b 検収の指摘＝色形式・未知プロパティが黙って消えていた。
  const root = customProps(style.slice(rootStart, style.indexOf("}", rootStart)), ":root");
  const hcp = customProps(hc, "prefers-contrast: more");
  // ★§10.2g：ルール内にリテラル hex で書かれた前景色（color / border-color）と、面を引くための background。
  //   母集合はここで閉じる（:root の変数しか見ていなかったのが 10.2f の閉包の穴）。
  const hardFg: { key: string; prop: string; lit: Lit }[] = [];
  const hardDup: string[] = [];
  const hardBad: string[] = [];
  const bgOf: Record<string, string> = {};
  const seen = new Set<string>();
  for (const r of scanRules(style)) {
    const ds = decls(r.body);
    // ★同一ルール内の二重宣言を拒否（後勝ちで前の宣言が黙って無効になる＝検査の抜け道になる）。
    const cnt: Record<string, number> = {};
    for (const d of ds) if (HARD_PROPS.includes(d.prop) || d.prop === "background") cnt[d.prop] = (cnt[d.prop] ?? 0) + 1;
    // `border` ショートハンドは border-color を含むので、同じルールでの併記も後勝ちの温床＝拒否する。
    const borderish = Object.keys(cnt).filter((p) => p === "border" || p === "border-color").length;
    for (const raw of r.sel.split(",")) {
      const key = fgKey(r.ctx, raw.trim());
      for (const [p, n] of Object.entries(cnt)) if (n > 1) hardDup.push(`${key}|${p}（同一ルール内 ${n} 回）`);
      if (borderish > 1) hardDup.push(`${key}|border と border-color の併記`);
      for (const d of ds) {
        if (d.prop === "background") { bgOf[key] = d.val; continue; }
        if (!HARD_PROPS.includes(d.prop)) continue;
        // color / border-color は値そのものが色。ショートハンドは色らしいトークンを1つだけ許す。
        const vals = FG_PROPS.includes(d.prop) ? [d.val] : colorTokens(d.val);
        if (!FG_PROPS.includes(d.prop) && vals.length > 1) { hardBad.push(`${key}|${d.prop}: 色トークンが複数ある（${d.val}）`); continue; }
        for (const v of vals) {
          const p = parseColorLiteral(v);
          if (p.skip) continue;
          if (p.bad || !p.lit) { hardBad.push(`${key}|${d.prop}: ${p.bad}`); continue; }
          const id = `${key}|${d.prop}`;
          if (seen.has(id)) hardDup.push(id); else seen.add(id);
          hardFg.push({ key, prop: d.prop, lit: p.lit });
        }
      }
    }
  }
  return {
    kf, selKf, selTr, rmSel, hcVars: hcp.colors, hcNames: hcp.names,
    rootVars: root.colors, varIssues: [...root.issues, ...hcp.issues],
    hardFg, hardDup, hardBad, bgOf,
  };
}

// ---- doc（正典）抽出 ---------------------------------------------------------
const section = (spec: string, from: string, to: string) => {
  const s = spec.indexOf(from), e = spec.indexOf(to);
  return s < 0 || e < 0 || e <= s ? null : spec.slice(s, e);
};
const cells = (line: string) => line.split("|");
/** 宣言値の正規化（空白圧縮・小文字化・末尾セミコロン除去）＝doc と CSS を完全一致で比べるため。 */
const normDecl = (v: string) => v.replace(/^transition\s*:/, "").replace(/\s+/g, " ").replace(/;\s*$/, "").trim().toLowerCase();
const ticks = (s: string) => [...s.matchAll(/`([^`]+)`/g)].map((m) => m[1]);

/** §10.2d：keyframe ID（意味論表）と セレクタ→分類（RM 分類表）。 */
export function docMotion(spec: string): { kf: string[]; sel: Record<string, string>; tr: Record<string, string>; issues: Issue[] } {
  const issues: Issue[] = [];
  const sec = section(spec, "### 10.2d", "### 10.2f");
  if (!sec) { issues.push({ code: "doc-range", msg: "§10.2d の範囲を特定できない" }); return { kf: [], sel: {}, tr: {}, issues }; }
  const split = sec.indexOf("| RM | セレクタ");
  if (split < 0) { issues.push({ code: "doc-range", msg: "§10.2d に RM 分類表が無い" }); return { kf: [], sel: {}, tr: {}, issues }; }
  const kf: string[] = [];
  for (const line of sec.slice(0, split).split("\n")) {
    if (!line.startsWith("| `")) continue;
    for (const id of ticks(cells(line)[1])) {
      if (kf.includes(id)) issues.push({ code: "doc-dup", msg: `§10.2d 意味論表に重複 ID: ${id}` });
      kf.push(id);
    }
  }
  const sel: Record<string, string> = {};
  for (const line of sec.slice(split).split("\n")) {
    if (!line.startsWith("| ") || line.startsWith("|---")) continue;
    const c = cells(line);
    if (c.length < 4) continue;
    const cls = c[1].replace(/\*/g, "").trim();
    if (!["A", "B", "C", "免除"].includes(cls)) continue;
    for (const s of ticks(c[2])) {
      if (sel[s]) issues.push({ code: "doc-dup", msg: `§10.2d 分類表に重複セレクタ: ${s}` });
      sel[s] = cls;
    }
  }
  // 非 keyframe motion（transition）の閉集合
  const tr: Record<string, string> = {};
  const ts = sec.indexOf("★非 keyframe motion"), te = sec.indexOf("★アニメでないもの");
  if (ts < 0 || te < 0 || te <= ts) issues.push({ code: "doc-range", msg: "§10.2d に非 keyframe motion（transition）の表が無い" });
  else for (const line of sec.slice(ts, te).split("\n")) {
    if (!line.startsWith("| `")) continue;
    const c = cells(line);
    const sel = ticks(c[1])[0];
    if (!sel) continue;
    if (sel in tr) issues.push({ code: "doc-dup", msg: `§10.2d transition 表に重複セレクタ: ${sel}` });
    // 通常列（2列目）の `transition: …` を正典値として取り出す
    const norm = ticks(c[2]).find((t) => /^transition\s*:/.test(t));
    if (!norm) issues.push({ code: "doc-trans-value", msg: `§10.2d transition 表の ${sel} に通常時の値が無い` });
    tr[sel] = normDecl(norm ?? "");
    if (!/transition\s*:\s*none/.test(c[3] ?? "")) issues.push({ code: "doc-trans-rm", msg: `§10.2d transition 表の ${sel} に Reduce Motion 時の transition: none が無い` });
  }
  return { kf, sel, tr, issues };
}

/** §10.2f：差分表（トークン→**既定値と**高コントラスト値）と 規則表（群→判定面・閾値）。 */
export function docContrast(spec: string): { hc: Record<string, string>; def: Record<string, string>; rules: Rule[]; issues: Issue[] } {
  const issues: Issue[] = [];
  // ★終端は §10.2g（10.3 にすると 10.2g の表まで規則表として読んでしまう）。
  const sec = section(spec, "### 10.2f", "### 10.2g");
  if (!sec) { issues.push({ code: "doc-range", msg: "§10.2f の範囲を特定できない" }); return { hc: {}, def: {}, rules: [], issues }; }
  const hc: Record<string, string> = {};
  const def: Record<string, string> = {};
  const rs: Rule[] = [];
  for (const line of sec.split("\n")) {
    if (!line.startsWith("| ")) continue;
    const c = cells(line);
    if (c.length < 4) continue;
    // 差分表：| `--tx-meta` | `#857a66` | 4.38:1 | **`#988d79`** | ...
    //   ★2列目（既定値）と4列目（高コントラスト値）の**両方**を読む（既定値の未照合が U1b 検収の指摘1）。
    const dif = c[1].match(/`--([a-z0-9-]+)`/);
    if (dif && c.length >= 5) {
      const d = c[2].match(/`(#[0-9a-fA-F]{6})`/), v = c[4].match(/`(#[0-9a-fA-F]{6})`/);
      if (v) {
        if (dif[1] in hc) issues.push({ code: "doc-dup", msg: `§10.2f 差分表に重複トークン: --${dif[1]}（後勝ちで矛盾が隠れる）` });
        hc[dif[1]] = v[1].toLowerCase();
        if (d) def[dif[1]] = d[1].toLowerCase();
        else issues.push({ code: "doc-default-missing", msg: `§10.2f 差分表の --${dif[1]} に既定値が無い` });
        continue;
      }
    }
    // 規則表：| `tx` / `tx-strong` … | `bg-sheet` `#17130e` | 4.5:1（文字） | 実例 |
    const idsRaw = ticks(c[1]).filter((t) => !t.startsWith("#"));
    if (!idsRaw.length) continue;
    const need = /対象外/.test(c[3]) ? null : Number(c[3].match(/([\d.]+):1/)?.[1] ?? NaN);
    if (need !== null && !Number.isFinite(need)) continue; // 表以外の行
    // 判定面＝2列目の `bg-*`（丸括弧内の例外面も union して最悪値を採る＝仕様より厳しい側に倒す）
    const on = ticks(c[2]).filter((t) => t.startsWith("bg-"));
    if (need !== null && !on.length) continue;
    rs.push({
      ids: idsRaw.filter((t) => !t.endsWith("*")),
      globs: idsRaw.filter((t) => t.endsWith("*")).map((t) => t.slice(0, -1)),
      on, need,
    });
  }
  return { hc, def, rules: rs, issues };
}

/** §10.2g：ルール内ハードコード前景色の判定面表（宣言 → 面・閾値）。 */
export interface HardRow { key: string; prop: string; faces: string[]; need: number | null; mode: "any" | "all" }
export function docHardFg(spec: string): { rows: HardRow[]; issues: Issue[] } {
  const issues: Issue[] = [];
  const sec = section(spec, "### 10.2g", "### 10.3 ");
  if (!sec) { issues.push({ code: "doc-range", msg: "§10.2g の範囲を特定できない" }); return { rows: [], issues }; }
  const rows: HardRow[] = [];
  const seen = new Set<string>();
  for (const line of sec.split("\n")) {
    if (!line.startsWith("| `")) continue;
    const c = cells(line);
    if (c.length < 6) continue;
    const key = ticks(c[1])[0], prop = ticks(c[2])[0];
    if (!key || !prop) continue;
    if (!HARD_PROPS.includes(prop)) { issues.push({ code: "doc-hard-prop", msg: `§10.2g の対象外プロパティ: ${key} ${prop}` }); continue; }
    const id = `${key}|${prop}`;
    if (seen.has(id)) issues.push({ code: "doc-dup", msg: `§10.2g に重複行: ${id}` }); else seen.add(id);
    const exempt = /免除/.test(c[4]);
    const need = exempt ? null : Number(c[4].match(/([\d.]+):1/)?.[1] ?? NaN);
    if (!exempt && !Number.isFinite(need)) { issues.push({ code: "doc-hard-need", msg: `§10.2g の閾値を読めない: ${id}` }); continue; }
    // ★罫（border 系）は「隣接面のどれか1面で足りる（any）」か「全面で満たす（all）」かを
    //   行ごとに明示させる（用途によって必要な隣接面が変わるため一般則にしない）。文字（color）は常に all。
    const hasAny = /\bany\b/.test(c[4]), hasAll = /\ball\b/.test(c[4]);
    const isBorder = prop !== "color";
    let mode: "any" | "all" = "all";
    if (!exempt) {
      if (hasAny && hasAll) { issues.push({ code: "doc-hard-mode", msg: `§10.2g の判定向きが any と all の両方: ${id}` }); continue; }
      if (isBorder && !hasAny && !hasAll) { issues.push({ code: "doc-hard-mode", msg: `§10.2g の罫は any / all の明示が要る: ${id}` }); continue; }
      if (!isBorder && (hasAny || hasAll)) { issues.push({ code: "doc-hard-mode", msg: `§10.2g の文字（color）に判定向きは書かない（常に all）: ${id}` }); continue; }
      mode = hasAny ? "any" : "all";
    }
    rows.push({ key, prop, faces: exempt ? [] : ticks(c[3]), need, mode });
  }
  return { rows, issues };
}

/** 半透明色を下地 hex へアルファ合成（面にも前景にも使う）。 */
export const compositeLit = (l: Lit, base: string) => {
  if (l.a >= 1) return l.hex;
  const [br, bg, bb] = rgb(base), [r, g, b] = rgb(l.hex);
  const mix = (f: number, k: number) => Math.round(f * l.a + k * (1 - l.a));
  return "#" + [mix(r, br), mix(g, bg), mix(b, bb)].map((n) => n.toString(16).padStart(2, "0")).join("");
};

/** §10.2g の判定面セルを実ソースから解決。**受け付ける文法は4形態だけ**で、それ以外は全て errs。 */
export function resolveFaces(
  faces: string[], css: { bgOf: Record<string, string>; rootVars: Record<string, string> }, mainTs: string,
): { hexes: string[]; errs: string[] } {
  const hexes: string[] = [], errs: string[] = [];
  const mapBg: Record<string, string> = {};
  const mb = mainTs.match(/const\s+MAP_BG\s*=\s*\{([\s\S]*?)\}\s*as const/);
  if (mb) for (const kv of mb[1].matchAll(/([A-Za-z0-9_]+)\s*:\s*"(#[0-9a-fA-F]{6})"/g)) mapBg[kv[1]] = kv[2].toLowerCase();
  for (let i = 0; i < faces.length; i++) {
    const t = faces[i];
    if (t.startsWith("over:")) { errs.push(`over: が単独で現れた（直前に rgba の on: が要る）: ${t}`); continue; }
    if (t.startsWith("js:")) {
      const k = t.match(/^js:MAP_BG\.([A-Za-z0-9_]+)$/);
      if (!k) { errs.push(`js: の書き方が文法外: ${t}`); continue; }
      if (!(k[1] in mapBg)) { errs.push(`main.ts の MAP_BG に無い: ${t}`); continue; }
      hexes.push(mapBg[k[1]]); continue;
    }
    if (t.startsWith("on:")) {
      const sel = t.slice(3), bg = css.bgOf[sel];
      if (!bg) { errs.push(`on: のセレクタに background が無い: ${sel}`); continue; }
      const v = bg.match(/^var\(--([a-z0-9-]+)\)$/);
      if (v) { const h = css.rootVars[v[1]]; if (!h) { errs.push(`on: の var() が :root に無い: ${bg}`); continue; } hexes.push(h); continue; }
      if (/^linear-gradient/.test(bg)) {
        // ★全 stop を解析できた場合だけ受理する。1つでも読めない stop があれば fail
        //   （hex stop だけ拾うと `white 50%` のような未解析 stop が黙って母集合から消える）。
        const inner = bg.slice(bg.indexOf("(") + 1, bg.lastIndexOf(")"));
        const parts: string[] = [];
        let d = 0, cur = "";
        for (const ch of inner) {
          if (ch === "(") d++; else if (ch === ")") d--;
          if (ch === "," && d === 0) { parts.push(cur); cur = ""; continue; }
          cur += ch;
        }
        parts.push(cur);
        let ok = true;
        for (let k = 0; k < parts.length; k++) {
          const seg = parts[k].trim();
          // 先頭だけは向き指定（`180deg` / `to bottom` 等）を許す
          if (k === 0 && /^(to\s|[\d.]+(deg|rad|turn|grad)$)/.test(seg)) continue;
          const toks = colorTokens(seg);
          if (toks.length !== 1) { errs.push(`linear-gradient の stop を解析できない: ${sel} → 「${seg}」`); ok = false; break; }
          const p = parseColorLiteral(toks[0]);
          if (p.lit && p.lit.a === 1) { hexes.push(p.lit.hex); continue; }
          if (p.skip && toks[0].startsWith("var(")) {
            const vn = toks[0].match(/^var\(--([a-z0-9-]+)\)$/);
            const h = vn && css.rootVars[vn[1]];
            if (h) { hexes.push(h); continue; }
          }
          errs.push(`linear-gradient の stop が文法外（不透明 hex / var() のみ）: ${sel} → 「${seg}」`);
          ok = false; break;
        }
        if (!ok) continue;
        continue;
      }
      const lit = parseColorLiteral(bg);
      if (lit.lit && lit.lit.a === 1) { hexes.push(lit.lit.hex); continue; }
      if (lit.lit) {
        const ov = (faces[i + 1] ?? "").match(/^over:([a-z0-9-]+)$/);
        if (!ov) { errs.push(`半透明の面には over:<トークン> が要る: ${sel}`); continue; }
        const base = css.rootVars[ov[1]];
        if (!base) { errs.push(`over: のトークンが :root に無い: ${ov[1]}`); continue; }
        i++; // over: を消費
        hexes.push(compositeLit(lit.lit, base)); continue;
      }
      errs.push(`on: の background が文法外（不透明hex / var() / linear-gradient / rgb(a) のみ）: ${sel} → ${bg}`);
      continue;
    }
    const h = css.rootVars[t];
    if (!h) { errs.push(`:root に無い面トークン: ${t}`); continue; }
    hexes.push(h);
  }
  return { hexes, errs };
}

/** トークン名を規則表の1行に解決（完全一致 > glob。0件/複数件は null＝fail）。 */
export function resolveRule(name: string, rs: Rule[]): Rule | null {
  const exact = rs.filter((r) => r.ids.includes(name));
  if (exact.length === 1) return exact[0];
  if (exact.length > 1) return null;
  const glob = rs.filter((r) => r.globs.some((g) => name.startsWith(g)));
  return glob.length === 1 ? glob[0] : null;
}

// ---- 検査本体 ----------------------------------------------------------------
export function audit(html: string, spec: string, mainTs: string): Issue[] {
  const out: Issue[] = [];
  const bad = (code: string, msg: string) => out.push({ code, msg });
  const css = parseCss(html);
  const dm = docMotion(spec), dc = docContrast(spec);
  const grammar = assertGrammar(html, mainTs);
  if (grammar.length) return grammar; // ★文法違反時は打ち切る＝壊れた入力に無意味な診断を重ねない
  out.push(...dm.issues, ...dc.issues, ...css.varIssues);

  // A) keyframe 集合 1:1 ＋ 件数
  for (const k of Object.keys(css.kf)) if (!dm.kf.includes(k)) bad("kf-undocumented", `§10.2d 意味論表に無い @keyframes: ${k}`);
  for (const k of dm.kf) if (!css.kf[k]) bad("kf-missing", `§10.2d にあるが CSS に無い keyframe: ${k}`);
  if (dm.kf.length !== EXPECT_KEYFRAMES) bad("kf-count", `§10.2d の keyframe 件数が ${EXPECT_KEYFRAMES} でない: ${dm.kf.length}`);

  // B) 個別セレクタ 1:1 ＋ 件数
  for (const s of Object.keys(css.selKf)) if (!dm.sel[s]) bad("sel-undocumented", `§10.2d 分類表に無い個別セレクタ: ${s}`);
  const docSel = Object.keys(dm.sel);
  for (const s of docSel) if (!css.selKf[s]) bad("sel-missing", `分類表にあるが CSS で keyframe を使っていない: ${s}`);
  if (docSel.length !== EXPECT_SELECTORS) bad("sel-count", `§10.2d 分類表の個別セレクタ件数が ${EXPECT_SELECTORS} でない: ${docSel.length}`);

  // B2) 非 keyframe motion（transition）1:1 ＋ 件数 ＋ RM で none
  for (const sel of Object.keys(css.selTr)) if (!(sel in dm.tr)) bad("trans-undocumented", `§10.2d transition 表に無い transition: ${sel}（${css.selTr[sel]}）`);
  for (const sel of Object.keys(dm.tr)) if (!(sel in css.selTr)) bad("trans-missing", `§10.2d transition 表にあるが CSS に transition が無い: ${sel}`);
  if (Object.keys(dm.tr).length !== EXPECT_TRANSITIONS) bad("trans-count", `§10.2d transition 表の件数が ${EXPECT_TRANSITIONS} でない: ${Object.keys(dm.tr).length}`);
  for (const [sel, want] of Object.entries(dm.tr)) {
    const got = css.selTr[sel] === undefined ? undefined : normDecl(css.selTr[sel]);
    if (got !== undefined && got !== want) bad("trans-value", `--transition の値が doc(${want}) と CSS(${got}) で不一致: ${sel}`);
  }
  for (const sel of Object.keys(dm.tr)) {
    const body = css.rmSel.get(sel);
    if (!body || !/transition\s*:\s*none/.test(body)) bad("trans-rm", `Reduce Motion で transition: none になっていない: ${sel}`);
  }

  // C/D) Reduce Motion 被覆・免除・静的代替
  for (const [sel, cls] of Object.entries(dm.sel)) {
    const body = css.rmSel.get(sel);
    if (cls === "免除") {
      if (body) bad("rm-exempt-disabled", `免除（不透明度のみ）なのに RM ブロックで止めている: ${sel}＝情報表示が消える`);
      continue;
    }
    if (!body) { bad("rm-uncovered", `Reduce Motion 未対応: ${sel}（分類 ${cls}）`); continue; }
    if (!/animation\s*:/.test(body)) bad("rm-no-stop", `RM ブロックに animation 宣言が無い: ${sel}`);
    if (cls === "B" && !/[a-z-]+\s*:/.test(body.replace(/animation\s*:[^;]*;?/g, "")))
      bad("rm-no-static", `B（状態・予告）なのに静的代替が無い: ${sel}＝テレグラフを消してはならない`);
  }

  // E) 高コントラスト：doc 差分表 ↔ CSS。**色に限らず全 custom property 名**で 1:1 にする
  //    （色だけを照合していたため、非色の追加上書き〔例 --r-btn:99px〕が素通りしていた）。
  for (const [k, v] of Object.entries(dc.hc)) {
    if (!css.hcNames.includes(k)) bad("hc-missing", `§10.2f にあるが CSS の高コントラストに無い: --${k}`);
    else if (css.hcVars[k] !== v) bad("hc-value", `--${k} の HC 値が doc(${v}) と CSS(${css.hcVars[k] ?? "非色"}) で不一致`);
  }
  for (const [k, v] of Object.entries(dc.def)) {
    if (!(k in css.rootVars)) bad("default-missing", `§10.2f 差分表にあるが :root に無い: --${k}`);
    else if (css.rootVars[k] !== v) bad("default-value", `--${k} の既定値が doc(${v}) と :root(${css.rootVars[k]}) で不一致`);
  }
  for (const k of css.hcNames) if (!(k in dc.hc)) bad("hc-undocumented", `§10.2f 差分表に無い高コントラスト上書き: --${k}`);

  // F) WCAG 再計算（閾値・判定面は §10.2f 規則表から生成）
  const eff = { ...css.rootVars, ...css.hcVars };
  for (const k of Object.keys(css.rootVars)) {
    const r = resolveRule(k, dc.rules);
    if (!r) { bad("rule-unresolved", `§10.2f 規則表のどの行にも一意に解決できない色トークン: --${k}`); continue; }
    if (r.need === null) continue; // 対象外（背景）
    const missing = r.on.filter((b) => !(b in eff));
    if (missing.length) { bad("rule-bg", `--${k} の判定面が :root に無い: ${missing.join(",")}`); continue; }
    const worst = Math.min(...r.on.map((b) => contrast(eff[k], eff[b])));
    if (worst < r.need) bad("contrast", `高コントラストで基準未達: --${k} ${eff[k]} = ${worst.toFixed(2)}:1（必要 ${r.need}:1）`);
  }

  // I) §10.2g：ルール内ハードコード前景色 ↔ 判定面表（10.2f の閉包の外にあった母集合を閉じる）
  const dh = docHardFg(spec);
  out.push(...dh.issues);
  for (const d of css.hardDup) bad("hard-duplicate", `同じ宣言が二度現れる（後勝ちで前の宣言が黙って無効になる）: ${d}`);
  for (const d of css.hardBad) bad("hard-value-form", `前景の色構文が未対応: ${d}`);
  const docIds = new Set(dh.rows.map((r) => `${r.key}|${r.prop}`));
  const cssIds = new Set(css.hardFg.map((f) => `${f.key}|${f.prop}`));
  for (const id of cssIds) if (!docIds.has(id)) bad("hard-undocumented", `§10.2g の表に無いハードコード前景色: ${id}`);
  for (const id of docIds) if (!cssIds.has(id)) bad("hard-stale", `§10.2g の表にあるが CSS に無い: ${id}`);
  for (const r of dh.rows) {
    const f = css.hardFg.find((x) => x.key === r.key && x.prop === r.prop);
    if (!f || r.need === null) continue; // 欠けは hard-stale で報告済み／null＝免除
    const { hexes, errs } = resolveFaces(r.faces, css, mainTs);
    for (const e of errs) bad("hard-face", `${r.key}|${r.prop}: ${e}`);
    if (errs.length) continue;
    if (!hexes.length) { bad("hard-face", `${r.key}|${r.prop}: 判定面が空`); continue; }
    // ★前景が半透明なら**その面へ合成してから**比を採る（不透明扱いすると過大評価で未達を見逃す）。
    const vals = hexes.map((h) => contrast(compositeLit(f.lit, h), h));
    // 判定の向きは行が宣言する（文字は常に all／罫は用途に応じて any か all）。
    const v = r.mode === "any" ? Math.max(...vals) : Math.min(...vals);
    if (v < r.need) bad("hard-contrast", `§10.2g 基準未達: ${r.key} ${r.prop} ${f.lit.hex}${f.lit.a < 1 ? `@${f.lit.a}` : ""} = ${v.toFixed(2)}:1（必要 ${r.need}:1・面 ${hexes.join(",")}）`);
  }

  // G) 参照ドリフト
  if (/from\s+["'][^"']*screen-model/.test(mainTs)) bad("model-leak", "main.ts が screen-model を import している（bundle 膨張・U1c の前提が崩れる）");

  return out;
}

// ============ 実行 ============================================================
const html = readFileSync(HTML, "utf8"), spec = readFileSync(SPEC, "utf8"), mainTs = readFileSync(MAIN, "utf8");
let fail = 0;
const err = (m: string) => { if (fail < 30) console.error("  ✗ " + m); fail++; };

// H) self-test（変異試験・毎回実行）
{
  const END_STYLE = "  </style>";
  // §10.2g で最も単純な行（面が :root トークン1つ）＝表の書き換え変異の共通アンカー。
  const NAME_ROW = "| `#title .name` | `color` | `bg-app` | 4.5:1（文字） | 題字 |";
  // 罫の行（判定向き any/all を持つ）と、面が var() で前景がリテラルの実ルール＝§10.2g 変異の共通アンカー。
  const TELE_ROW = "| `.cell.tele-atk::after` | `border` | `bg-void` `bg-wall` | 3:1（非テキスト・all） | 敵の攻撃予告（赤の実線枠） |";
  const SEAL = "background: var(--acc); color: #fffaf5;";
  const RM_HEAD = "    @media (prefers-reduced-motion: reduce) {";
  const GRID_ANCHOR = "    #grid { display: grid; width: 100%; }";
  const T: { name: string; expect: string; run: () => Issue[] }[] = [
    { name: "@keyframes を doc から消す", expect: "kf-undocumented", run: () => audit(html, spec.replace("| `pulse` |", "| `pulse-x` |"), mainTs) },
    { name: "CSS から keyframe を消す", expect: "kf-missing", run: () => audit(html.replace("@keyframes pulse", "@keyframes pulseZ"), spec, mainTs) },
    { name: "分類表からセレクタを1件消す", expect: "sel-undocumented", run: () => audit(html, spec.replace("／`.g-laila`", ""), mainTs) },
    { name: "分類表に CSS に無いセレクタを足す", expect: "sel-missing", run: () => audit(html, spec.replace("`.g-laila`", "`.g-laila`／`.g-nonexistent`"), mainTs) },
    { name: "A のセレクタを RM 被覆から外す", expect: "rm-uncovered", run: () => audit(html.replace("\n      .g-downed, .g-delver, .g-summon,", "\n      .g-delver, .g-summon,"), spec, mainTs) },
    { name: "B の静的代替を消す（テレグラフを消すだけ）", expect: "rm-no-static", run: () => audit(html.replace(/\.g-mon-atk \{\n\s*animation: none;[^}]*\}/, ".g-mon-atk {\n        animation: none; }"), spec, mainTs) },
    { name: "免除セレクタを RM で止める（情報表示が消える）", expect: "rm-exempt-disabled", run: () => audit(html.replace("      #peek, #floats .fl,", "      #floorBanner.show, #peek, #floats .fl,"), spec, mainTs) },
    { name: "高コントラスト値を doc と食い違わせる", expect: "hc-value", run: () => audit(html.replace("--tx-meta:#988d79", "--tx-meta:#8b8272"), spec, mainTs) },
    { name: "高コントラスト上書きを1件落とす", expect: "hc-missing", run: () => audit(html.replace("--g-floor:#576578;", ""), spec, mainTs) },
    { name: "基準未達の値を高コントラストに入れる", expect: "contrast", run: () => audit(html.replace("--g-wall:#708298", "--g-wall:#39434f"), spec, mainTs) },
    { name: "規則表に当たらない色トークンを :root に足す", expect: "rule-unresolved", run: () => audit(html.replace("--g-laila:#c9a3ff;", "--g-laila:#c9a3ff; --zz-newbie:#123456;"), spec, mainTs) },
    // ---- ★受け付ける CSS 文法（ホワイトリスト）の拒否枝＝#404 検収 4 巡目 ----
    { name: "a11y media の後に通常ルールを足す", expect: "grammar-tail", run: () => audit(html.replace(END_STYLE, "    .zz-late { animation: pulse 1s infinite; }\n" + END_STYLE), spec, mainTs) },
    { name: "2 個目の HC block", expect: "grammar-media-count", run: () => audit(html.replace(END_STYLE, "    @media (prefers-contrast: more) { :root { --tx-meta:#000000; } }\n" + END_STYLE), spec, mainTs) },
    { name: "空白表記の異なる HC block", expect: "grammar-media-count", run: () => audit(html.replace(END_STYLE, "    @media(prefers-contrast: more) { :root { --tx-meta:#000000; } }\n" + END_STYLE), spec, mainTs) },
    { name: "2 個目の RM block でアニメを再有効化", expect: "grammar-media-count", run: () => audit(html.replace(END_STYLE, "    @media (prefers-reduced-motion: reduce) { .g-fossil { animation:pulse 1s infinite; } }\n" + END_STYLE), spec, mainTs) },
    { name: "2 個目の style タグ", expect: "grammar-style-count", run: () => audit(html.replace("</head>", "<style>.zz-second { animation:pulse 1s infinite; }</style>\n</head>"), spec, mainTs) },
    { name: "未対応の at-rule（@supports）", expect: "grammar-at-rule", run: () => audit(html.replace(END_STYLE, "    @supports (display:grid) { .zz-s { color:#fff; } }\n" + END_STYLE), spec, mainTs) },
    { name: "未対応の @media 条件", expect: "grammar-media-cond", run: () => audit(html.replace(END_STYLE, "    @media (min-width: 900px) { .zz-w { color:#fff; } }\n" + END_STYLE), spec, mainTs) },
    { name: "animation-name の個別プロパティ", expect: "grammar-anim-prop", run: () => audit(html.replace(END_STYLE, "    .zz-an { animation-name:pulse; }\n" + END_STYLE), spec, mainTs) },
    { name: "animation の二重宣言（後勝ち）", expect: "grammar-anim-dup", run: () => audit(html.replace(END_STYLE, "    .zz-dup { animation:none; animation:pulse 1s infinite; }\n" + END_STYLE), spec, mainTs) },
    { name: "animation の値に var()", expect: "grammar-anim-var", run: () => audit(html.replace(END_STYLE, "    .zz-var { animation:var(--zz-anim); }\n" + END_STYLE), spec, mainTs) },
    { name: "main.ts から style.animation へ代入", expect: "grammar-js-anim", run: () => audit(html, spec, mainTs + '\nel.style.animation = "pulse 1s";\n') },
    { name: "escape を含む custom property 名（--zz\\(）", expect: "var-name", run: () => audit(html.replace("--g-laila:#c9a3ff;", "--g-laila:#c9a3ff; --zz\\(:#ffffff;"), spec, mainTs) },
    { name: "§10.2f 差分表に重複トークン", expect: "doc-dup", run: () => audit(html, spec.replace(/\| `--tx-meta` \| `#857a66`[^\n]*\n/, (m) => m.replace("#988d79", "#123456") + m), mainTs) },
    // ---- ★宣言した文法境界の実装検査（#404 検収 5 巡目）----
    { name: "HC と RM の間に宣言を挟む", expect: "grammar-tail", run: () => audit(html.replace(RM_HEAD, "    .zz-between { animation:pulse 1s infinite; }\n" + RM_HEAD), spec, mainTs) },
    { name: "<STYLE> の大文字表記", expect: "grammar-case", run: () => audit(html.replace("<style>", "<STYLE>").replace("</style>", "</STYLE>"), spec, mainTs) },
    { name: "@MEDIA の大文字表記", expect: "grammar-case", run: () => audit(html.replace("@media (prefers-contrast: more)", "@MEDIA (prefers-contrast: more)"), spec, mainTs) },
    { name: "base 領域の ANIMATION:（大文字プロパティ）", expect: "grammar-case", run: () => audit(html.replace(GRID_ANCHOR, GRID_ANCHOR + "\n    .zz-up { ANIMATION:pulse 1s infinite; }"), spec, mainTs) },
    { name: "★大文字表記は診断がカスケードしない（grammar-* のみ）", expect: "grammar-case", run: () => {
      const is = audit(html.replace("<style>", "<STYLE>").replace("</style>", "</STYLE>"), spec, mainTs);
      return is.every((i) => i.code.startsWith("grammar-")) ? is : []; // 無関係な診断が混じれば空＝fail
    } },
    { name: "JS: style[\"animation\"] への代入", expect: "grammar-js-anim", run: () => audit(html, spec, `${mainTs}\nel.style["animation"] = "pulse 1s";\n`) },
    { name: "JS: Web Animations API（.animate）", expect: "grammar-js-anim", run: () => audit(html, spec, `${mainTs}\nel.animate([{opacity:0},{opacity:1}], 1000);\n`) },
    { name: "JS: setProperty(\"animation\")", expect: "grammar-js-anim", run: () => audit(html, spec, `${mainTs}\nel.style.setProperty("animation", "pulse 1s");\n`) },
    { name: "JS: stylesheet 注入（insertRule）", expect: "grammar-js-anim", run: () => audit(html, spec, `${mainTs}\ndocument.styleSheets[0].insertRule(".zz{animation:pulse 1s}");\n`) },
    // ---- ★非 keyframe motion（transition）の閉集合＝#404 検収 6 巡目 ----
    { name: "transition を doc から消す", expect: "trans-undocumented", run: () => audit(html, spec.replace("| `#stBars .gauge .fill` |", "| `#stBars .gauge .fill-x` |"), mainTs) },
    { name: "doc にあるが CSS に transition が無い", expect: "trans-missing", run: () => audit(html.replace(" transition: width .18s ease;", ""), spec, mainTs) },
    { name: "RM で transition: none にしない", expect: "trans-rm", run: () => audit(html.replace("      #stBars .gauge .fill { transition: none; }", ""), spec, mainTs) },
    { name: "doc 無しで新しい transition を足す", expect: "trans-undocumented", run: () => audit(html.replace(GRID_ANCHOR, GRID_ANCHOR + "\n    .zz-tr { transition: opacity .3s ease; }"), spec, mainTs) },
    { name: "transition の個別プロパティ（transition-property）", expect: "grammar-trans-prop", run: () => audit(html.replace(GRID_ANCHOR, GRID_ANCHOR + "\n    .zz-tp { transition-property: opacity; }"), spec, mainTs) },
    { name: "transition の値に var()", expect: "grammar-trans-var", run: () => audit(html.replace(GRID_ANCHOR, GRID_ANCHOR + "\n    .zz-tv { transition: var(--zz-t); }"), spec, mainTs) },
    // ---- ★transition の値・非 keyframe motion の別入口＝#404 検収 7 巡目 ----
    { name: "CSS の transition 値を doc と食い違わせる", expect: "trans-value", run: () => audit(html.replace("transition: width .18s ease", "transition: opacity 9s linear"), spec, mainTs) },
    { name: "JS: style.transition への代入", expect: "grammar-js-anim", run: () => audit(html, spec, `${mainTs}\nel.style.transition = "width 9s";\n`) },
    { name: "JS: style[\"transition\"]（bracket 記法）", expect: "grammar-js-anim", run: () => audit(html, spec, `${mainTs}\nel.style["transition"] = "width 9s";\n`) },
    { name: "JS: setProperty(\"transition\")", expect: "grammar-js-anim", run: () => audit(html, spec, `${mainTs}\nel.style.setProperty("transition","width 9s");\n`) },
    { name: "CSS: scroll-behavior: smooth", expect: "grammar-scroll", run: () => audit(html.replace(GRID_ANCHOR, GRID_ANCHOR + "\n    .zz-sb { scroll-behavior: smooth; }"), spec, mainTs) },
    { name: "JS: scrollTo({ behavior: \"smooth\" })", expect: "grammar-js-scroll", run: () => audit(html, spec, `${mainTs}\nwindow.scrollTo({ top: 0, behavior: "smooth" });\n`) },
    { name: "JS: scrollIntoView({ behavior: \"smooth\" })", expect: "grammar-js-scroll", run: () => audit(html, spec, `${mainTs}\nel.scrollIntoView({ behavior: "smooth" });\n`) },
    // ---- ★スクロールの CSSOM / API 入口＝#404 検収 8 巡目（値でなく面を禁じる）----
    { name: "JS: style.scrollBehavior への代入", expect: "grammar-js-anim", run: () => audit(html, spec, `${mainTs}\nel.style.scrollBehavior = "smooth";\n`) },
    { name: "JS: style[\"scrollBehavior\"]（bracket 記法）", expect: "grammar-js-anim", run: () => audit(html, spec, `${mainTs}\nel.style["scrollBehavior"] = "smooth";\n`) },
    { name: "JS: setProperty(\"scroll-behavior\")", expect: "grammar-js-anim", run: () => audit(html, spec, `${mainTs}\nel.style.setProperty("scroll-behavior", "smooth");\n`) },
    { name: "JS: scrollTo({ \"behavior\": \"smooth\" })（クォート表記）", expect: "grammar-js-scroll", run: () => audit(html, spec, `${mainTs}\nscrollTo({ "behavior": "smooth" });\n`) },
    { name: "JS: 変数経由の短縮記法 scrollTo({ behavior })", expect: "grammar-js-scroll", run: () => audit(html, spec, `${mainTs}\nconst behavior = "smooth"; scrollTo({ behavior });\n`) },
    { name: "JS: scrollIntoView() の呼び出し自体", expect: "grammar-js-scroll", run: () => audit(html, spec, `${mainTs}\nel.scrollIntoView();\n`) },
    // ---- ★呼び出し構文の変種＝#404 検収 9 巡目（識別子の出現そのものを禁じる）----
    { name: "JS: window[\"scrollTo\"](…)（bracket）", expect: "grammar-js-scroll", run: () => audit(html, spec, `${mainTs}\nwindow["scrollTo"]({ top: 0, behavior: "smooth" });\n`) },
    { name: "JS: window.scrollTo?.(…)（optional chaining）", expect: "grammar-js-scroll", run: () => audit(html, spec, `${mainTs}\nwindow.scrollTo?.({ top: 0 });\n`) },
    { name: "JS: alias 経由（const move = window.scrollTo）", expect: "grammar-js-scroll", run: () => audit(html, spec, `${mainTs}\nconst move = window.scrollTo; move({ top: 0 });\n`) },
    { name: "JS: prototype 経由（scrollIntoView.call）", expect: "grammar-js-scroll", run: () => audit(html, spec, `${mainTs}\nElement.prototype.scrollIntoView.call(el, { behavior: "smooth" });\n`) },
    { name: "main.ts が screen-model を import", expect: "model-leak", run: () => audit(html, spec, `import { SEM_TONES } from "./screen-model.ts";\n${mainTs}`) },
    // ---- ★U1b 検収（#404）で塞いだ穴の裏取り ----
    { name: "既定値を doc と食い違わせる", expect: "default-value", run: () => audit(html.replace("--tx-meta:#857a66", "--tx-meta:#7a7060"), spec, mainTs) },
    { name: "差分表のトークンを :root から消す", expect: "default-missing", run: () => audit(html.replace("--tx-faint:#6b6250;", ""), spec, mainTs) },
    { name: "3 桁 hex を :root に足す", expect: "color-format", run: () => audit(html.replace("--g-laila:#c9a3ff;", "--g-laila:#c9a3ff; --zz-short:#fff;"), spec, mainTs) },
    { name: "rgb() を :root に足す", expect: "color-format", run: () => audit(html.replace("--g-laila:#c9a3ff;", "--g-laila:#c9a3ff; --zz-rgb:rgb(1,2,3);"), spec, mainTs) },
    { name: "8 桁 hex を :root に足す", expect: "color-format", run: () => audit(html.replace("--g-laila:#c9a3ff;", "--g-laila:#c9a3ff; --zz-a8:#11223344;"), spec, mainTs) },
    { name: "未登録の非色プロパティを :root に足す", expect: "var-unclassified", run: () => audit(html.replace("--g-laila:#c9a3ff;", "--g-laila:#c9a3ff; --zz-size:4px;"), spec, mainTs) },
    { name: "RM ブロックで animation を止め忘れる", expect: "rm-no-stop", run: () => audit(html.replace("animation: none; text-shadow: 0 0 22px", "text-shadow: 0 0 22px"), spec, mainTs) },
    { name: "doc に無い高コントラスト上書きを CSS に足す", expect: "hc-undocumented", run: () => audit(html.replace("--g-floor:#576578;", "--g-floor:#576578; --g-door:#ffe97a;"), spec, mainTs) },
    { name: "規則表の 2 行に同じトークンを載せる（多重一致）", expect: "rule-unresolved", run: () => audit(html, spec.replace("| `line` / `line-2` / `line-3` |", "| `line` / `line-2` / `line-3` / `tx-meta` |"), mainTs) },
    { name: "規則表の判定面を :root に無い面にする", expect: "rule-bg", run: () => audit(html, spec.replace("| `bg-sheet` `#17130e` | 4.5:1（文字） | 術名", "| `bg-nope` `#17130e` | 4.5:1（文字） | 術名"), mainTs) },
    // ---- ★:root と HC ブロックへ **同じ変異セットを対称に**流す（片側だけ塞ぐ事故の構造的防止）----
    //      ANCHOR は各ブロック末尾の宣言。ここへ足した変異が同じ code で落ちなければならない。
    ...([[":root", "--g-laila:#c9a3ff;"], ["HC", "--g-floor:#576578;"]] as const).flatMap(([wh, anchor]) => [
      { name: `${wh} に 3 桁 hex を足す`, expect: "color-format", run: () => audit(html.replace(anchor, `${anchor} --zz-3:#fff;`), spec, mainTs) },
      { name: `${wh} に rgb() を足す`, expect: "color-format", run: () => audit(html.replace(anchor, `${anchor} --zz-rgb:rgb(9,9,9);`), spec, mainTs) },
      { name: `${wh} に未登録の非色プロパティを足す`, expect: "var-unclassified", run: () => audit(html.replace(anchor, `${anchor} --zz-size:4px;`), spec, mainTs) },
      { name: `${wh} に大文字名（--ZZ）を足す`, expect: "var-name", run: () => audit(html.replace(anchor, `${anchor} --ZZ:#ffffff;`), spec, mainTs) },
      { name: `${wh} に underscore 名（--zz_bad）を足す`, expect: "var-name", run: () => audit(html.replace(anchor, `${anchor} --zz_bad:#ffffff;`), spec, mainTs) },
    ]),
    // HC は「§10.2f 差分表の 7 変数ちょうど」＝既知の非色すら追加上書きできない
    { name: "HC に既知の非色（--r-btn）を追加上書きする", expect: "hc-undocumented", run: () => audit(html.replace("--g-floor:#576578;", "--g-floor:#576578; --r-btn:99px;"), spec, mainTs) },
    { name: "分類表の行を消す（件数アサート）", expect: "sel-count", run: () => audit(html, spec.replace("／`.g-laila`", ""), mainTs) },
    { name: "意味論表の行を消す（件数アサート）", expect: "kf-count", run: () => audit(html, spec.replace(/\| `abyssair` \| 6s \|[^\n]*\n/, ""), mainTs) },
    // ---- ★§10.2g（ルール内ハードコード前景色）＝母集合・文法・閾値の三方向を変異で裏取り ----
    //      NAME_ROW は最も単純な行（面が :root トークン1つ）＝表の書き換え変異の共通アンカー。
    { name: "CSS に表に無いハードコード前景色を足す", expect: "hard-undocumented", run: () => audit(html.replace(GRID_ANCHOR, GRID_ANCHOR + "\n    .zz-new { color: #123456; }"), spec, mainTs) },
    { name: "表から行を1つ消す（CSS には残る）", expect: "hard-undocumented", run: () => audit(html, spec.replace(NAME_ROW, ""), mainTs) },
    { name: "表の宣言を CSS に無いセレクタにする", expect: "hard-stale", run: () => audit(html, spec.replace("| `#title .name` | `color`", "| `#title .zzz` | `color`"), mainTs) },
    { name: "同じ宣言を二度書く（@media 上書きの見落とし）", expect: "hard-duplicate", run: () => audit(html.replace(GRID_ANCHOR, GRID_ANCHOR + "\n    #title .name { color: #efe6d3; }"), spec, mainTs) },
    { name: "判定面を :root に無いトークンにする", expect: "hard-face", run: () => audit(html, spec.replace(NAME_ROW, NAME_ROW.replace("`bg-app`", "`bg-zzz`")), mainTs) },
    { name: "on: を background の無いセレクタにする", expect: "hard-face", run: () => audit(html, spec.replace("`on:#lungeBtn.stance`", "`on:#zzz`"), mainTs) },
    { name: "rgba の面から over: を落とす", expect: "hard-face", run: () => audit(html, spec.replace("`on:#guardBtn` `over:bg-app`", "`on:#guardBtn`"), mainTs) },
    { name: "over: を単独で置く", expect: "hard-face", run: () => audit(html, spec.replace(NAME_ROW, NAME_ROW.replace("`bg-app`", "`over:bg-app`")), mainTs) },
    { name: "js: を MAP_BG に無いキーにする", expect: "hard-face", run: () => audit(html, spec.replace("`js:MAP_BG.aimOk`", "`js:MAP_BG.zzz`"), mainTs) },
    { name: "閾値を読めない表記にする", expect: "doc-hard-need", run: () => audit(html, spec.replace(NAME_ROW, NAME_ROW.replace("4.5:1（文字）", "じゅうぶん")), mainTs) },
    { name: "対象外プロパティを表に書く", expect: "doc-hard-prop", run: () => audit(html, spec.replace(NAME_ROW, NAME_ROW.replace("| `color` |", "| `background` |")), mainTs) },
    { name: "表に同じ宣言の行を二度書く", expect: "doc-dup", run: () => audit(html, spec.replace(NAME_ROW, NAME_ROW + "\n" + NAME_ROW), mainTs) },
    { name: "基準未達の前景色へ戻す（落款）", expect: "hard-contrast", run: () => audit(html.replace("background: var(--acc); color: #fffaf5;", "background: var(--acc); color: #f6e8dc;"), spec, mainTs) },
    { name: "基準未達の前景色へ戻す（朱塗りボタン）", expect: "hard-contrast", run: () => audit(html.replace("#title .menu button.primary { color: #fffaf5;", "#title .menu button.primary { color: #f6e8dc;"), spec, mainTs) },
    { name: "§10.2g の見出しを消す", expect: "doc-range", run: () => audit(html, spec.replace("### 10.2g ルール内", "### 10.2zz ルール内"), mainTs) },
    // ---- ★Codex 検収（2026-07-31）で「黙って通る」と実証された入口を、そのまま拒否枝にする ----
    //      いずれも「最初の1宣言だけ match する／hex 以外を母集合外にする／gradient の未解析 stop を
    //      見逃す／alpha を不透明として計算する」ことに由来していた。
    { name: "新規 color: rgb(0,0,0)（hex 以外の前景）", expect: "hard-undocumented", run: () => audit(html.replace(GRID_ANCHOR, GRID_ANCHOR + "\n    .zz-rgb { color: rgb(0,0,0); }"), spec, mainTs) },
    { name: "新規 border shorthand のリテラル色", expect: "hard-undocumented", run: () => audit(html.replace(GRID_ANCHOR, GRID_ANCHOR + "\n    .zz-sh { border: 1px solid #777; }"), spec, mainTs) },
    { name: "同一ルール内で color を二度書く（後勝ち）", expect: "hard-duplicate", run: () => audit(html.replace(SEAL, SEAL + " color: #000;"), spec, mainTs) },
    { name: "同一ルール内で background を二度書く（判定面の後勝ち）", expect: "hard-duplicate", run: () => audit(html.replace("background: var(--acc); color: #fffaf5;", "background: var(--acc); background: #fff; color: #fffaf5;"), spec, mainTs) },
    { name: "border と border-color を併記する", expect: "hard-duplicate", run: () => audit(html.replace(GRID_ANCHOR, GRID_ANCHOR + "\n    .zz-bb { border: 1px solid #777; border-color: #888; }"), spec, mainTs) },
    { name: "gradient に未解析 stop（white 50%）を足す", expect: "hard-face", run: () => audit(html.replace("linear-gradient(180deg, #c2452f, #9c3423)", "linear-gradient(180deg, #c2452f, white 50%, #9c3423)"), spec, mainTs) },
    { name: "8 桁 hex（alpha つき）をルールに書く", expect: "hard-value-form", run: () => audit(html.replace(SEAL, "background: var(--acc); color: #fffaf5c0;"), spec, mainTs) },
    { name: "4 桁 hex（alpha つき）をルールに書く", expect: "hard-value-form", run: () => audit(html.replace(SEAL, "background: var(--acc); color: #fffa;"), spec, mainTs) },
    { name: "hsl() をルールに書く", expect: "hard-value-form", run: () => audit(html.replace(SEAL, "background: var(--acc); color: hsl(30,50%,90%);"), spec, mainTs) },
    { name: "色名をルールに書く", expect: "hard-value-form", run: () => audit(html.replace(SEAL, "background: var(--acc); color: papayawhip;"), spec, mainTs) },
    { name: "border shorthand に色トークンが2つ", expect: "hard-value-form", run: () => audit(html.replace(GRID_ANCHOR, GRID_ANCHOR + "\n    .zz-2c { border: 1px solid #777 #888; }"), spec, mainTs) },
    // ★半透明前景を面へ合成して判定していることの裏取り（不透明扱いなら 3:1 を割ったまま通ってしまう）
    { name: "半透明の罫を基準未達へ戻す（脅威の破線）", expect: "hard-contrast", run: () => audit(html.replace("border: 1.5px dashed rgba(255,79,60,.66)", "border: 1.5px dashed rgba(255,79,60,.6)"), spec, mainTs) },
    { name: "半透明の罫を基準未達へ戻す（着弾の枠）", expect: "hard-contrast", run: () => audit(html.replace("border: 1px solid rgba(201,167,90,.52)", "border: 1px solid rgba(201,167,90,.5)"), spec, mainTs) },
    // ★罫の判定向き（any / all）は行ごとの明示。省略・重複・文字への誤記はすべて拒否する。
    { name: "罫の行から any/all を落とす", expect: "doc-hard-mode", run: () => audit(html, spec.replace(TELE_ROW, TELE_ROW.replace("・all）", "）")), mainTs) },
    { name: "罫の行に any と all を両方書く", expect: "doc-hard-mode", run: () => audit(html, spec.replace(TELE_ROW, TELE_ROW.replace("・all）", "・any・all）")), mainTs) },
    { name: "文字（color）の行に判定向きを書く", expect: "doc-hard-mode", run: () => audit(html, spec.replace(NAME_ROW, NAME_ROW.replace("4.5:1（文字）", "4.5:1（文字・any）")), mainTs) },
  ];
  let ng = 0;
  for (const t of T) if (!t.run().some((i) => i.code === t.expect)) { err(`self-test 未検出: ${t.name}（期待 ${t.expect}）`); ng++; }
  const clean = audit(html, spec, mainTs);
  if (clean.length) { for (const i of clean) err(`[${i.code}] ${i.msg}`); ng++; }
  console.log(`  self-test（変異試験）: ${T.length} 拒否枝 ＋ 正常系1 / NG ${ng}`);
}

// 実測サマリ
{
  const css = parseCss(html), dm = docMotion(spec), dc = docContrast(spec);
  const n = (k: string) => Object.values(dm.sel).filter((v) => v === k).length;
  const eff = { ...css.rootVars, ...css.hcVars };
  const checked = Object.keys(css.rootVars).filter((k) => resolveRule(k, dc.rules)?.need != null);
  const margin = checked.reduce((m, k) => {
    const r = resolveRule(k, dc.rules)!;
    return Math.min(m, Math.min(...r.on.map((b) => contrast(eff[k], eff[b]))) / r.need!);
  }, Infinity);
  console.log(`  (A) keyframe 1:1: CSS ${Object.keys(css.kf).length} = doc ${dm.kf.length}`);
  console.log(`  (B) 個別セレクタ 1:1: CSS ${Object.keys(css.selKf).length} = doc ${Object.keys(dm.sel).length}（A${n("A")} B${n("B")} C${n("C")} 免除${n("免除")}）`);
  console.log(`  (B2) 非 keyframe motion: CSS ${Object.keys(css.selTr).length} = doc ${Object.keys(dm.tr).length}（RM で transition: none）`);
  console.log(`  (E/F) 高コントラスト: 上書き ${Object.keys(css.hcVars).length} 変数 / 規則表 ${dc.rules.length} 行で ${checked.length} トークンを検査（最小余裕 ×${margin.toFixed(2)}）`);
  // (I) §10.2g：CSS 側の母集合と doc の表が 1:1 か、実際に測った面の数と最小余裕。
  const dh = docHardFg(spec);
  const judged = dh.rows.filter((r) => r.need !== null);
  let faceN = 0, hMargin = Infinity;
  for (const r of judged) {
    const f = css.hardFg.find((x) => x.key === r.key && x.prop === r.prop);
    const { hexes, errs } = resolveFaces(r.faces, css, mainTs);
    if (!f || errs.length || !hexes.length) continue;
    faceN += hexes.length;
    // ★前景が半透明なら**その面へ合成してから**比を採る（不透明扱いすると過大評価で未達を見逃す）。
    const vals = hexes.map((h) => contrast(compositeLit(f.lit, h), h));
    hMargin = Math.min(hMargin, (r.mode === "any" ? Math.max(...vals) : Math.min(...vals)) / r.need!);
  }
  console.log(`  (I) ルール内ハードコード前景色: CSS ${css.hardFg.length} 宣言 = doc ${dh.rows.length} 行（判定 ${judged.length} / 免除 ${dh.rows.length - judged.length}）・面 ${faceN} 面を実測（最小余裕 ×${hMargin.toFixed(2)}）`);
}

if (fail) { console.error(`\n[a11y-check] FAIL: ${fail} 件`); process.exit(1); }
console.log("[a11y-check] OK  ※Dynamic Type と VoiceOver は Swift（U2）＝web では未検査");

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
//   G8 `main.ts` から `style.animation` / `animationName` へ代入しない（CSS 外の入口を塞ぐ）
const MEDIA_ALLOW = ["(display-mode:standalone)", "(prefers-contrast:more)", "(prefers-reduced-motion:reduce)"];
const normCond = (c: string) => c.replace(/\s+/g, "").toLowerCase();

/** 許容文法の検査。ここで fail した場合、以降の検査結果は信用できない。 */
export function assertGrammar(html: string, mainTs: string): Issue[] {
  const out: Issue[] = [];
  const bad = (code: string, msg: string) => out.push({ code, msg });
  // G1
  const opens = (html.match(/<style[\s>]/g) ?? []).length, closes = (html.match(/<\/style>/g) ?? []).length;
  if (opens !== 1 || closes !== 1) bad("grammar-style-count", `<style> はちょうど 1 個であること（開 ${opens} / 閉 ${closes}）`);
  const style = stripComments(html.slice(html.indexOf("<style>"), html.indexOf("</style>")));
  // G2
  for (const m of style.matchAll(/@([a-z-]+)/g))
    if (!["keyframes", "media"].includes(m[1])) bad("grammar-at-rule", `未対応の at-rule: @${m[1]}（許容は @keyframes / @media のみ）`);
  // G3
  const conds = [...style.matchAll(/@media([^{]*)\{/g)].map((m) => normCond(m[1]));
  for (const c of conds) if (!MEDIA_ALLOW.includes(c)) bad("grammar-media-cond", `未対応の @media 条件: ${c}`);
  for (const need of ["(prefers-contrast:more)", "(prefers-reduced-motion:reduce)"]) {
    const n = conds.filter((c) => c === need).length;
    if (n !== 1) bad("grammar-media-count", `@media ${need} はちょうど 1 個であること（実際 ${n} 個）`);
  }
  // G4：a11y の 2 ブロックが末尾＝最後の HC/RM ブロックの終端より後に宣言が無いこと
  const ends: number[] = [];
  for (const m of style.matchAll(/@media([^{]*)\{/g)) {
    if (!["(prefers-contrast:more)", "(prefers-reduced-motion:reduce)"].includes(normCond(m[1]))) continue;
    let depth = 0, j = style.indexOf("{", m.index!);
    for (; j < style.length; j++) { if (style[j] === "{") depth++; else if (style[j] === "}") { depth--; if (!depth) break; } }
    ends.push(j + 1);
  }
  if (ends.length) {
    const tail = style.slice(Math.max(...ends));
    if (/[^\s]/.test(tail)) bad("grammar-tail", `高コントラスト/Reduce Motion ブロックより後に宣言がある: ${tail.trim().slice(0, 60)}…`);
  }
  // G5：animation 系プロパティの構文を閉じる
  for (const r of rules(style)) {
    const decls = [...r.body.matchAll(/(^|[;{\s])(animation[a-z-]*)\s*:\s*([^;]*)/g)];
    const shorthand = decls.filter((d) => d[2] === "animation");
    for (const d of decls) if (d[2] !== "animation") bad("grammar-anim-prop", `未対応の animation 個別プロパティ: ${d[2]}（${r.sel.trim().slice(0, 40)}）`);
    if (shorthand.length > 1) bad("grammar-anim-dup", `1 ルールに animation 宣言が複数（後勝ちは解析しない）: ${r.sel.trim().slice(0, 40)}`);
    for (const d of shorthand) if (/var\(/.test(d[3])) bad("grammar-anim-var", `animation の値に var() は未対応: ${r.sel.trim().slice(0, 40)}`);
  }
  // G8：CSS 外（JS）からアニメを足す経路
  if (/\.style\.animation|animationName\s*=/.test(mainTs)) bad("grammar-js-anim", "main.ts が style.animation / animationName へ代入している（CSS 外のアニメ経路）");
  return out;
}

// ※issues を捨てるヘルパ（旧 colorVars）は置かない＝取りこぼしの再発経路を作らないため。
//   custom property を読む箇所は必ず customProps() を通し、issues を audit へ集約する。
const rules = (block: string) => [...block.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({ sel: m[1].trim(), body: m[2] }));

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
  // RM ブロックの個別セレクタ → 宣言本文
  const rmSel = new Map<string, string>();
  for (const r of rules(rm)) for (const s of r.sel.split(",")) rmSel.set(s.trim(), (rmSel.get(s.trim()) ?? "") + r.body);
  const rootStart = style.indexOf(":root");
  // ★:root と高コントラストブロックの**両方**へ同じ閉じた検査を掛ける（対称化）。
  //   HC 側だけ素通りしていたのが U1b 検収の指摘＝色形式・未知プロパティが黙って消えていた。
  const root = customProps(style.slice(rootStart, style.indexOf("}", rootStart)), ":root");
  const hcp = customProps(hc, "prefers-contrast: more");
  return {
    kf, selKf, rmSel, hcVars: hcp.colors, hcNames: hcp.names,
    rootVars: root.colors, varIssues: [...root.issues, ...hcp.issues],
  };
}

// ---- doc（正典）抽出 ---------------------------------------------------------
const section = (spec: string, from: string, to: string) => {
  const s = spec.indexOf(from), e = spec.indexOf(to);
  return s < 0 || e < 0 || e <= s ? null : spec.slice(s, e);
};
const cells = (line: string) => line.split("|");
const ticks = (s: string) => [...s.matchAll(/`([^`]+)`/g)].map((m) => m[1]);

/** §10.2d：keyframe ID（意味論表）と セレクタ→分類（RM 分類表）。 */
export function docMotion(spec: string): { kf: string[]; sel: Record<string, string>; issues: Issue[] } {
  const issues: Issue[] = [];
  const sec = section(spec, "### 10.2d", "### 10.2f");
  if (!sec) { issues.push({ code: "doc-range", msg: "§10.2d の範囲を特定できない" }); return { kf: [], sel: {}, issues }; }
  const split = sec.indexOf("| RM | セレクタ");
  if (split < 0) { issues.push({ code: "doc-range", msg: "§10.2d に RM 分類表が無い" }); return { kf: [], sel: {}, issues }; }
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
  return { kf, sel, issues };
}

/** §10.2f：差分表（トークン→**既定値と**高コントラスト値）と 規則表（群→判定面・閾値）。 */
export function docContrast(spec: string): { hc: Record<string, string>; def: Record<string, string>; rules: Rule[]; issues: Issue[] } {
  const issues: Issue[] = [];
  const sec = section(spec, "### 10.2f", "### 10.3 ");
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
  out.push(...assertGrammar(html, mainTs), ...dm.issues, ...dc.issues, ...css.varIssues);

  // A) keyframe 集合 1:1 ＋ 件数
  for (const k of Object.keys(css.kf)) if (!dm.kf.includes(k)) bad("kf-undocumented", `§10.2d 意味論表に無い @keyframes: ${k}`);
  for (const k of dm.kf) if (!css.kf[k]) bad("kf-missing", `§10.2d にあるが CSS に無い keyframe: ${k}`);
  if (dm.kf.length !== EXPECT_KEYFRAMES) bad("kf-count", `§10.2d の keyframe 件数が ${EXPECT_KEYFRAMES} でない: ${dm.kf.length}`);

  // B) 個別セレクタ 1:1 ＋ 件数
  for (const s of Object.keys(css.selKf)) if (!dm.sel[s]) bad("sel-undocumented", `§10.2d 分類表に無い個別セレクタ: ${s}`);
  const docSel = Object.keys(dm.sel);
  for (const s of docSel) if (!css.selKf[s]) bad("sel-missing", `分類表にあるが CSS で keyframe を使っていない: ${s}`);
  if (docSel.length !== EXPECT_SELECTORS) bad("sel-count", `§10.2d 分類表の個別セレクタ件数が ${EXPECT_SELECTORS} でない: ${docSel.length}`);

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
  console.log(`  (E/F) 高コントラスト: 上書き ${Object.keys(css.hcVars).length} 変数 / 規則表 ${dc.rules.length} 行で ${checked.length} トークンを検査（最小余裕 ×${margin.toFixed(2)}）`);
}

if (fail) { console.error(`\n[a11y-check] FAIL: ${fail} 件`); process.exit(1); }
console.log("[a11y-check] OK  ※Dynamic Type と VoiceOver は Swift（U2）＝web では未検査");

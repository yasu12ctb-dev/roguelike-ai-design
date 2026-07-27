// 画面状態 fixture の受理検査（U1c・`npm run check` 同梱・純データ・playwright 非依存）。
//
// ★位置づけ（誤認防止・prototype-spec §10.12）：
//   web 側は **(1a) schema/fixture validator** ＋ **U1a settings compatibility check** の2本立て。
//   **web の正式な (1b) Screen conformance は 0 画面・未実装**（production に Screen adapter が無い）。
//   本検査に通っても「§10.12 の移植受理ゲート完了」ではない（全画面・寸法・Dynamic Type 等は未達）。
//
// 検査内容：
//   A) closed schema validator      … fixture 定義自体の妥当性（未知 field/型違い/非有限数/判別 union 等を拒否）
//   B) settings compatibility       … production `buildSettingLabels()` の出力を profile `settings-row-v1`
//                                     （row.id / row.label / row.header / row.order の4欄・**validator 側の固定表が正**）
//                                     で fixture へ射影して照合。Screen.id は照合に含めない。
//   C) doc 突合                     … prototype-spec.md §10.2e の範囲だけを読み、SemTone 46 / IconId 10 /
//                                     重複0 / runtime 定数集合と完全一致
//   D) 状態被覆                     … 3 fixture が 11 入力の全値を通る（3値入力は3値・2値入力は両値）
//   E) oracle 独立照合              … fixture のラベルが U1a 凍結 oracle（基準 commit 由来）と一致
//                                     ＝fixture が production から作られていないことの担保
//   F) self-test（変異試験）        … 上記の拒否枝が実際に効くことを **毎回** in-memory で自動検証
//
// 実行: node --experimental-strip-types tools/ui-fixture-check.ts

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  SEM_TONES, ICON_IDS, ROW_KINDS, ROLES, INPUT_TYPES,
  ROW_FIELDS, SCREEN_FIELDS, SECTION_FIELDS, BADGE_FIELDS, GLYPH_FIELDS, OPTION_FIELDS,
} from "../src/web/screen-model.ts";
import { buildSettingLabels, type SettingsState } from "../src/web/settings-items.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE_ROOT = join(__dirname, "..", "fixtures", "ui");
const SPEC = join(__dirname, "..", "..", "prototype-spec.md");
const ORACLE = join(__dirname, "fixtures", "settings-oracle.json");

const KNOWN_SCHEMA_VERSIONS = new Set([1]);
/** ★compatibility profile の検査項目は **validator 側の固定表が正**（fixture が任意に減らせない）。 */
const PROFILES: Record<string, readonly string[]> = {
  "settings-row-v1": ["row.id", "row.label", "row.header", "row.order"],
};
const FIXTURE_FIELDS = ["schemaVersion", "fixtureId", "screenId", "derivedFrom", "webProjectionProfile", "state", "expected"] as const;
const DERIVED_FIELDS = ["spec", "oracle"] as const;
const ORACLE_BASE_COMMIT = "6a537d197d23865f578832ba56e88a753dc38825";
const STATE_FIELDS = ["muted", "bgmOn", "bgmVol", "sfxVol", "dpadOn", "dpadPos", "dpadSize", "autorun", "lunge", "guard", "logSize"] as const;
/** 11 入力の値域（D 状態被覆で使用）。 */
const STATE_DOMAIN: Record<string, readonly unknown[]> = {
  muted: [false, true], bgmOn: [false, true], dpadOn: [false, true],
  autorun: [false, true], lunge: [false, true], guard: [false, true],
  bgmVol: [0.35, 0.6, 0.85], sfxVol: [0.35, 0.6, 0.85],
  dpadPos: ["right", "left", "center"], dpadSize: ["lg", "md", "sm"], logSize: ["sm", "md", "lg"],
};

type Issue = { code: string; where: string; msg: string };
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isStr = (v: unknown): v is string => typeof v === "string";
const nonEmpty = (v: unknown): v is string => isStr(v) && v.length > 0;

// ============ A) closed schema validator =====================================
/** fixture 1件を検査して issue 配列を返す（空＝妥当）。**object を直接渡す経路**でも NaN/Infinity を拒否する。 */
export function validateFixture(fx: unknown, where = "fixture"): Issue[] {
  const out: Issue[] = [];
  const bad = (code: string, w: string, msg: string) => out.push({ code, where: w, msg });
  if (!isObj(fx)) { bad("not-object", where, "fixture がオブジェクトでない"); return out; }

  // -- メタ
  for (const k of Object.keys(fx)) if (!(FIXTURE_FIELDS as readonly string[]).includes(k)) bad("unknown-field", where, `未知 field: ${k}`);
  if (!("schemaVersion" in fx)) bad("schema-version-missing", where, "schemaVersion が無い");
  else if (typeof fx.schemaVersion !== "number" || !Number.isFinite(fx.schemaVersion) || !KNOWN_SCHEMA_VERSIONS.has(fx.schemaVersion))
    bad("schema-version-unknown", where, `未知の schemaVersion: ${String(fx.schemaVersion)}`);
  if (!nonEmpty(fx.fixtureId)) bad("fixture-id", where, "fixtureId が非空文字列でない");
  if (!nonEmpty(fx.screenId)) bad("screen-id", where, "screenId が非空文字列でない");

  // derivedFrom（固定形式＝spec と oracle@baseCommit を識別できること）
  const df = fx.derivedFrom;
  if (!isObj(df)) bad("derived-from", where, "derivedFrom がオブジェクトでない");
  else {
    for (const k of Object.keys(df)) if (!(DERIVED_FIELDS as readonly string[]).includes(k)) bad("unknown-field", `${where}.derivedFrom`, `未知 field: ${k}`);
    if (!nonEmpty(df.spec) || !/§10\.1b/.test(df.spec) || !/§10\.2e/.test(df.spec))
      bad("derived-spec", `${where}.derivedFrom`, "spec に §10.1b/§10.2e の識別が無い");
    if (!nonEmpty(df.oracle) || !df.oracle.includes("settings-oracle.json") || !df.oracle.includes(ORACLE_BASE_COMMIT))
      bad("derived-oracle", `${where}.derivedFrom`, `oracle が settings-oracle.json@${ORACLE_BASE_COMMIT.slice(0, 7)} 形式でない`);
  }

  // profile（validator 側の固定表と突合）
  const prof = fx.webProjectionProfile;
  if (!nonEmpty(prof)) bad("profile-missing", where, "webProjectionProfile が無い");
  else if (!(prof in PROFILES)) bad("profile-unknown", where, `未知 profile: ${prof}`);

  // -- state（11 入力・具体値必須）
  const st = fx.state;
  if (!isObj(st)) bad("state", where, "state がオブジェクトでない");
  else {
    for (const k of Object.keys(st)) if (!(STATE_FIELDS as readonly string[]).includes(k)) bad("unknown-field", `${where}.state`, `未知 field: ${k}`);
    for (const k of STATE_FIELDS) {
      if (!(k in st)) { bad("state-missing", `${where}.state`, `${k} が無い`); continue; }
      const v = st[k], dom = STATE_DOMAIN[k];
      if (typeof v === "number" && !Number.isFinite(v)) bad("non-finite", `${where}.state`, `${k} が非有限数`);
      else if (!dom.includes(v as never)) bad("state-domain", `${where}.state`, `${k} の値 ${JSON.stringify(v)} が値域外`);
    }
  }

  // -- expected（Screen）
  const sc = fx.expected;
  if (!isObj(sc)) { bad("screen", where, "expected がオブジェクトでない"); return out; }
  for (const k of Object.keys(sc)) if (!(SCREEN_FIELDS as readonly string[]).includes(k)) bad("unknown-field", `${where}.expected`, `未知 field: ${k}`);
  if (!nonEmpty(sc.id)) bad("screen-id", `${where}.expected`, "id が非空文字列でない");
  if (!nonEmpty(sc.title)) bad("screen-title", `${where}.expected`, "title が非空文字列でない");
  if ("subtitle" in sc && !isStr(sc.subtitle)) bad("type", `${where}.expected`, "subtitle が文字列でない");
  if (nonEmpty(fx.screenId) && nonEmpty(sc.id) && fx.screenId !== sc.id)
    bad("screen-id-mismatch", where, `screenId(${fx.screenId}) と expected.id(${sc.id}) が不一致`);
  if (!Array.isArray(sc.sections)) { bad("sections", `${where}.expected`, "sections が配列でない"); return out; }

  const secIds = new Set<string>(), rowIds = new Set<string>();
  sc.sections.forEach((secU, si) => {
    const w = `${where}.expected.sections[${si}]`;
    if (!isObj(secU)) { bad("section", w, "section がオブジェクトでない"); return; }
    for (const k of Object.keys(secU)) if (!(SECTION_FIELDS as readonly string[]).includes(k)) bad("unknown-field", w, `未知 field: ${k}`);
    if (!nonEmpty(secU.id)) bad("section-id", w, "id が非空文字列でない");
    else if (secIds.has(secU.id)) bad("section-id-dup", w, `Section.id 重複: ${secU.id}`);
    else secIds.add(secU.id);
    if ("header" in secU && !nonEmpty(secU.header)) bad("section-header", w, "header が非空文字列でない");
    if (!Array.isArray(secU.rows)) { bad("rows", w, "rows が配列でない"); return; }
    secU.rows.forEach((rowU, ri) => validateRow(rowU, `${w}.rows[${ri}]`, rowIds, bad));
  });
  return out;
}

function validateRow(r: unknown, w: string, rowIds: Set<string>, bad: (c: string, w: string, m: string) => void): void {
  if (!isObj(r)) { bad("row", w, "row がオブジェクトでない"); return; }
  const kind = r.kind;
  if (!isStr(kind) || !(ROW_KINDS as readonly string[]).includes(kind)) { bad("row-kind", w, `未知 kind: ${String(kind)}`); return; }
  const allowed = ROW_FIELDS[kind as keyof typeof ROW_FIELDS];
  for (const k of Object.keys(r)) if (!allowed.includes(k)) bad("unknown-field", w, `${kind} に未知 field: ${k}`);
  // 共通：id（Screen 全体で一意＝Section を跨いでも重複禁止）
  if (!nonEmpty(r.id)) bad("row-id", w, "id が非空文字列でない");
  else if (rowIds.has(r.id)) bad("row-id-dup", w, `Row.id 重複（Screen 全体）: ${r.id}`);
  else rowIds.add(r.id);
  // 数値は常に有限
  for (const [k, v] of Object.entries(r)) if (typeof v === "number" && !Number.isFinite(v)) bad("non-finite", w, `${k} が非有限数`);
  // tone / role / icon は runtime 定数集合に在ること
  if ("tone" in r && (!isStr(r.tone) || !(SEM_TONES as readonly string[]).includes(r.tone))) bad("tone-unknown", w, `未登録 tone: ${String(r.tone)}`);
  if ("role" in r && (!isStr(r.role) || !(ROLES as readonly string[]).includes(r.role))) bad("role-unknown", w, `未知 role: ${String(r.role)}`);
  if ("icon" in r && (!isStr(r.icon) || !(ICON_IDS as readonly string[]).includes(r.icon))) bad("icon-unknown", w, `未登録 icon: ${String(r.icon)}`);
  for (const key of ["badge", "glyph"] as const) {
    if (!(key in r)) continue;
    const b = r[key];
    const fields = key === "badge" ? BADGE_FIELDS : GLYPH_FIELDS;
    if (!isObj(b)) { bad(key, w, `${key} がオブジェクトでない`); continue; }
    for (const k of Object.keys(b)) if (!(fields as readonly string[]).includes(k)) bad("unknown-field", `${w}.${key}`, `未知 field: ${k}`);
    if (!nonEmpty(b[key === "badge" ? "text" : "char"])) bad(key, `${w}.${key}`, "必須文字列が空");
    if (!isStr(b.tone) || !(SEM_TONES as readonly string[]).includes(b.tone)) bad("tone-unknown", `${w}.${key}`, `未登録 tone: ${String(b.tone)}`);
  }
  // 種別ごとの必須欄
  switch (kind) {
    case "info": if (!nonEmpty(r.label)) bad("required", w, "info に label が無い"); break;
    case "text": if (!nonEmpty(r.text)) bad("required", w, "text に text が無い"); break;
    case "action": case "toggle": case "picker": case "input":
      if (!nonEmpty(r.label)) bad("required", w, `${kind} に label が無い`); break;
    case "card": if (!nonEmpty(r.title)) bad("required", w, "card に title が無い"); break;
  }
  if (kind === "toggle" && typeof r.on !== "boolean") bad("required", w, "toggle に boolean の on が無い");
  if (kind === "picker") {
    if (!Array.isArray(r.options) || r.options.length === 0) { bad("picker-options", w, "options が非空配列でない"); return; }
    const ids = new Set<string>();
    r.options.forEach((oU, oi) => {
      if (!isObj(oU)) { bad("picker-option", `${w}.options[${oi}]`, "option がオブジェクトでない"); return; }
      for (const k of Object.keys(oU)) if (!(OPTION_FIELDS as readonly string[]).includes(k)) bad("unknown-field", `${w}.options[${oi}]`, `未知 field: ${k}`);
      if (!nonEmpty(oU.id)) bad("option-id", `${w}.options[${oi}]`, "id が非空文字列でない");
      else if (ids.has(oU.id)) bad("option-id-dup", `${w}.options[${oi}]`, `option id 重複: ${oU.id}`);
      else ids.add(oU.id);
      if (!nonEmpty(oU.label)) bad("option-label", `${w}.options[${oi}]`, "label が非空文字列でない");
    });
    if (!nonEmpty(r.selected) || !ids.has(r.selected as string)) bad("picker-selected", w, `selected(${String(r.selected)}) が options の id に無い`);
  }
  if (kind === "input") {
    const t = r.inputType;
    if (!isStr(t) || !(INPUT_TYPES as readonly string[]).includes(t)) { bad("input-type", w, `未知 inputType: ${String(t)}`); return; }
    if (t === "number") {
      if ("multiline" in r) bad("input-mismatch", w, "number に multiline は不可");
      for (const k of ["min", "max", "step"] as const) if (k in r && typeof r[k] !== "number") bad("type", w, `${k} が数値でない`);
      const mn = r.min as number | undefined, mx = r.max as number | undefined, sp = r.step as number | undefined;
      if (typeof mn === "number" && typeof mx === "number" && mn > mx) bad("input-range", w, `min(${mn}) > max(${mx})`);
      if (typeof sp === "number" && sp <= 0) bad("input-step", w, `step(${sp}) が 0 以下`);
    } else {
      for (const k of ["min", "max", "step"] as const) if (k in r) bad("input-mismatch", w, `text に ${k} は不可`);
      if ("multiline" in r && typeof r.multiline !== "boolean") bad("type", w, "multiline が boolean でない");
    }
    if ("required" in r && typeof r.required !== "boolean") bad("type", w, "required が boolean でない");
  }
}

// ============ C) doc 突合（§10.2e の範囲だけ） ================================
function docTokenSets(): { tones: string[]; icons: string[]; issues: Issue[] } {
  const issues: Issue[] = [];
  const src = readFileSync(SPEC, "utf8");
  const start = src.indexOf("### 10.2e");
  const end = src.indexOf("### 10.2c");
  if (start < 0 || end < 0 || end <= start) { issues.push({ code: "doc-range", where: "spec", msg: "§10.2e の範囲を特定できない" }); return { tones: [], icons: [], issues }; }
  const sec = src.slice(start, end);
  // SemTone＝表の2列目のみ（見出し行・区切り行は除外）
  const tones: string[] = [];
  for (const line of sec.split("\n")) {
    if (!line.startsWith("|") || line.startsWith("|---") || line.includes("群 |")) continue;
    const cells = line.split("|");
    if (cells.length > 2) for (const m of cells[2].matchAll(/`([a-z0-9-]+)`/g)) tones.push(m[1]);
  }
  // IconId＝IconId 正典段落のみ
  const iconLine = sec.split("\n").find((l) => l.includes("`IconId` の正典一覧")) ?? "";
  const icons: string[] = [];
  for (const m of iconLine.matchAll(/`([a-z-]+)`/g)) if (m[1] !== "IconId" && m[1] !== "ICONS") icons.push(m[1]);
  return { tones, icons, issues };
}

// ============ 実行 ============================================================
let fail = 0;
const err = (m: string) => { if (fail < 30) console.error("  ✗ " + m); fail++; };

// -- F) self-test（変異試験・毎回実行）
const selfTests: { name: string; expect: string; make: () => unknown }[] = (() => {
  const base = () => JSON.parse(readFileSync(join(FIXTURE_ROOT, "settings", "default.json"), "utf8")) as any;
  return [
    { name: "Row.id 欠落", expect: "row-id", make: () => { const f = base(); delete f.expected.sections[0].rows[0].id; return f; } },
    { name: "Row.id 重複（Section 跨ぎ）", expect: "row-id-dup", make: () => { const f = base(); f.expected.sections[1].rows[0].id = f.expected.sections[0].rows[0].id; return f; } },
    { name: "Section.id 重複", expect: "section-id-dup", make: () => { const f = base(); f.expected.sections[1].id = f.expected.sections[0].id; return f; } },
    { name: "未登録 tone", expect: "tone-unknown", make: () => { const f = base(); f.expected.sections[0].rows[0].tone = "not-a-tone"; return f; } },
    { name: "未登録 icon", expect: "icon-unknown", make: () => { const f = base(); f.expected.sections[0].rows[0].icon = "no-such-icon"; return f; } },
    { name: "未知 role", expect: "role-unknown", make: () => { const f = base(); f.expected.sections[3].rows[3].role = "scary"; return f; } },
    { name: "未知 kind", expect: "row-kind", make: () => { const f = base(); f.expected.sections[0].rows[0].kind = "widget"; return f; } },
    { name: "未知 field（row）", expect: "unknown-field", make: () => { const f = base(); f.expected.sections[0].rows[0].bogus = 1; return f; } },
    { name: "未知 field（fixture）", expect: "unknown-field", make: () => { const f = base(); f.extra = true; return f; } },
    { name: "型違い（title に数値）", expect: "screen-title", make: () => { const f = base(); f.expected.title = 42; return f; } },
    { name: "非有限数（NaN・直接経路）", expect: "non-finite", make: () => { const f = base(); f.state.bgmVol = NaN; return f; } },
    { name: "非有限数（Infinity・直接経路）", expect: "non-finite", make: () => { const f = base(); f.expected.sections[1].rows[2].options[0].id = "x"; f.expected.sections[1].rows[2].selected = "x"; (f.expected.sections[0].rows[0] as any).value = Infinity; f.expected.sections[0].rows[0].kind = "info"; return f; } },
    { name: "schemaVersion 欠落", expect: "schema-version-missing", make: () => { const f = base(); delete f.schemaVersion; return f; } },
    { name: "schemaVersion 未知版", expect: "schema-version-unknown", make: () => { const f = base(); f.schemaVersion = 99; return f; } },
    { name: "screenId != expected.id", expect: "screen-id-mismatch", make: () => { const f = base(); f.screenId = "other"; return f; } },
    { name: "profile 欠落", expect: "profile-missing", make: () => { const f = base(); delete f.webProjectionProfile; return f; } },
    { name: "profile 未知", expect: "profile-unknown", make: () => { const f = base(); f.webProjectionProfile = "settings-row-v2"; return f; } },
    { name: "derivedFrom 欠落", expect: "derived-from", make: () => { const f = base(); delete f.derivedFrom; return f; } },
    { name: "derivedFrom の oracle が別 commit", expect: "derived-oracle", make: () => { const f = base(); f.derivedFrom.oracle = "tools/fixtures/settings-oracle.json@deadbeef"; return f; } },
    { name: "state 欠落", expect: "state-missing", make: () => { const f = base(); delete f.state.logSize; return f; } },
    { name: "state 値域外", expect: "state-domain", make: () => { const f = base(); f.state.dpadPos = "up"; return f; } },
    { name: "picker.selected が options 外", expect: "picker-selected", make: () => { const f = base(); f.expected.sections[1].rows[2].selected = "nope"; return f; } },
    { name: "option id 重複", expect: "option-id-dup", make: () => { const f = base(); const o = f.expected.sections[1].rows[2].options; o[1].id = o[0].id; return f; } },
    { name: "toggle に on が無い", expect: "required", make: () => { const f = base(); delete f.expected.sections[1].rows[0].on; return f; } },
    { name: "input number+multiline", expect: "input-mismatch", make: () => { const f = base(); f.expected.sections[0].rows.push({ kind: "input", id: "tmp-num", label: "x", inputType: "number", multiline: true }); return f; } },
    { name: "input min>max", expect: "input-range", make: () => { const f = base(); f.expected.sections[0].rows.push({ kind: "input", id: "tmp-num2", label: "x", inputType: "number", min: 9, max: 1 }); return f; } },
    { name: "input step<=0", expect: "input-step", make: () => { const f = base(); f.expected.sections[0].rows.push({ kind: "input", id: "tmp-num3", label: "x", inputType: "number", step: 0 }); return f; } },
    { name: "input text に min", expect: "input-mismatch", make: () => { const f = base(); f.expected.sections[0].rows.push({ kind: "input", id: "tmp-txt", label: "x", inputType: "text", min: 1 }); return f; } },
  ];
})();
{
  let ng = 0;
  for (const t of selfTests) {
    const issues = validateFixture(t.make(), "self");
    const hit = issues.some((i) => i.code === t.expect);
    if (!hit) { err(`self-test 未検出: ${t.name}（期待 code=${t.expect} / 実際=${issues.map((i) => i.code).join(",") || "なし"}）`); ng++; }
  }
  // 正常系は issue 0 でなければならない
  const clean = validateFixture(JSON.parse(readFileSync(join(FIXTURE_ROOT, "settings", "default.json"), "utf8")), "self-clean");
  if (clean.length) { err(`self-test: 正常な fixture が fail した（${clean.map((i) => i.code).join(",")}）`); ng++; }
  console.log(`  self-test（変異試験）: ${selfTests.length} 拒否枝 ＋ 正常系1 / NG ${ng}`);
}

// -- A) 実 fixture の schema 検査
const fixtures: { path: string; data: any }[] = [];
{
  const dirs = existsSync(FIXTURE_ROOT) ? readdirSync(FIXTURE_ROOT, { withFileTypes: true }).filter((d) => d.isDirectory()) : [];
  for (const d of dirs) {
    for (const f of readdirSync(join(FIXTURE_ROOT, d.name)).filter((x) => x.endsWith(".json"))) {
      const p = join(d.name, f);
      const data = JSON.parse(readFileSync(join(FIXTURE_ROOT, p), "utf8"));
      fixtures.push({ path: p, data });
      for (const i of validateFixture(data, p)) err(`[${i.code}] ${i.where}: ${i.msg}`);
    }
  }
  if (!fixtures.length) err("fixture が1件も無い");
  const ids = fixtures.map((f) => f.data?.fixtureId);
  const dup = ids.filter((x, i) => ids.indexOf(x) !== i);
  if (dup.length) err(`fixtureId 重複: ${[...new Set(dup)].join(", ")}`);
  console.log(`  (1a) schema validator: fixture ${fixtures.length} 件`);
}

// -- C) doc 突合
{
  const { tones, icons, issues } = docTokenSets();
  for (const i of issues) err(`[${i.code}] ${i.msg}`);
  const dupT = tones.filter((x, i) => tones.indexOf(x) !== i);
  const dupI = icons.filter((x, i) => icons.indexOf(x) !== i);
  if (dupT.length) err(`§10.2e の SemTone に重複: ${[...new Set(dupT)].join(", ")}`);
  if (dupI.length) err(`§10.2e の IconId に重複: ${[...new Set(dupI)].join(", ")}`);
  if (tones.length !== 46) err(`§10.2e の SemTone 件数が 46 でない: ${tones.length}`);
  if (icons.length !== 10) err(`§10.2e の IconId 件数が 10 でない: ${icons.length}`);
  const setEq = (a: readonly string[], b: readonly string[]) => a.length === b.length && [...a].sort().join("|") === [...b].sort().join("|");
  if (!setEq(tones, SEM_TONES)) err(`§10.2e の SemTone と runtime 定数が不一致（doc 側 ${tones.length} / 定数 ${SEM_TONES.length}）`);
  if (!setEq(icons, ICON_IDS)) err(`§10.2e の IconId と runtime 定数が不一致（doc 側 ${icons.length} / 定数 ${ICON_IDS.length}）`);
  console.log(`  (C) doc 突合: SemTone ${tones.length} / IconId ${icons.length}（重複 0・runtime 定数と一致）`);
}

// -- D) 状態被覆（3 fixture で 11 入力の全値）
{
  const settings = fixtures.filter((f) => f.data?.screenId === "settings");
  let miss = 0;
  for (const [k, dom] of Object.entries(STATE_DOMAIN)) {
    const seen = new Set(settings.map((f) => JSON.stringify(f.data?.state?.[k])));
    for (const v of dom) if (!seen.has(JSON.stringify(v))) { err(`状態被覆の欠け: ${k} の値 ${JSON.stringify(v)} を通る fixture が無い`); miss++; }
  }
  console.log(`  (D) 状態被覆: 11 入力 × 全値 / 欠け ${miss}`);
}

// -- E) oracle 独立照合 ＋ B) settings compatibility
{
  const oracle = JSON.parse(readFileSync(ORACLE, "utf8")) as {
    baseCommit: string; order: string[]; headers: Record<string, string>;
    fixedLabels: Record<string, string>; variableLabels: Record<string, Record<string, string>>;
  };
  if (oracle.baseCommit !== ORACLE_BASE_COMMIT) err(`oracle の baseCommit が想定と異なる: ${oracle.baseCommit}`);
  const volJp = (v: number) => (v < 0.45 ? "小" : v < 0.72 ? "中" : "大");
  const ownKey = (id: string, s: any): string | null => ({
    "audio-mute": String(s.muted), "bgm-toggle": String(s.bgmOn),
    "bgm-volume": volJp(s.bgmVol), "sfx-volume": volJp(s.sfxVol),
    "dpad-toggle": String(s.dpadOn), "dpad-position": s.dpadPos, "dpad-size": s.dpadSize,
    "dpad-autorun": String(s.autorun), "lunge-button": String(s.lunge), "guard-button": String(s.guard),
    "log-size": s.logSize,
  } as Record<string, string>)[id] ?? null;

  let cmp = 0;
  for (const { path, data } of fixtures.filter((f) => f.data?.screenId === "settings")) {
    const profile = PROFILES[data.webProjectionProfile as string];
    if (!profile) continue; // 未知 profile は A で報告済み
    // fixture の行を order 順に平坦化（Screen.id は照合に含めない＝production が出さないため）。
    // ★header は **グループ先頭行にだけ** 付く（production `SettingRow.header` の意味論と一致。
    //   Section.header は「その節の見出し」＝節の最初の行が担う）。
    const fxRows: { id: string; label: string; header?: string }[] =
      (data.expected.sections as any[]).flatMap((sec) => (sec.rows as any[]).map((r, ri) =>
        sec.header && ri === 0 ? { id: r.id, label: r.label, header: sec.header } : { id: r.id, label: r.label }));
    // E) fixture のラベルが oracle と一致（＝production 由来でないことの担保）
    for (const r of fxRows) {
      const k = ownKey(r.id, data.state);
      const want = k === null ? oracle.fixedLabels[r.id] : oracle.variableLabels[r.id]?.[k];
      if (want === undefined) { err(`[oracle] ${path}: ${r.id} の期待値が oracle に無い`); continue; }
      if (r.label !== want) err(`[oracle] ${path}: ${r.id} のラベルが oracle と不一致 got=${JSON.stringify(r.label)} want=${JSON.stringify(want)}`);
    }
    // B) production 出力を profile で射影して照合（4欄のみ・Screen.id は含めない）
    const prod = buildSettingLabels(data.state as SettingsState);
    if (prod.length !== fxRows.length) err(`[compat] ${path}: 行数不一致 prod=${prod.length} fixture=${fxRows.length}`);
    const n = Math.min(prod.length, fxRows.length);
    for (let i = 0; i < n; i++) {
      const p = prod[i], f = fxRows[i];
      if (profile.includes("row.order") && p.id !== f.id) err(`[compat] ${path}: order/id 不一致 index=${i} prod=${p.id} fixture=${f.id}`);
      if (profile.includes("row.id") && p.id !== f.id) err(`[compat] ${path}: id 不一致 index=${i}`);
      if (profile.includes("row.label") && p.label !== f.label) err(`[compat] ${path}: label 不一致 ${p.id} got=${JSON.stringify(p.label)} want=${JSON.stringify(f.label)}`);
      if (profile.includes("row.header") && (p.header ?? undefined) !== (f.header ?? undefined)) err(`[compat] ${path}: header 不一致 ${p.id} got=${String(p.header)} want=${String(f.header)}`);
      cmp++;
    }
  }
  console.log(`  (E) oracle 独立照合 ＋ (B) settings compatibility[settings-row-v1]: 行比較 ${cmp}`);
}

if (fail) {
  console.error(`\n[ui-fixture-check] FAIL: ${fail} 件`);
  process.exit(1);
}
console.log("[ui-fixture-check] OK  ※web の正式な (1b) Screen conformance は 0 画面・未実装＝§10.12 の移植受理ゲート完了ではない");

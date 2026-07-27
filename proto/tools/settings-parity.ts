// 設定シートの挙動不変検査（U1a・`npm run check` 同梱）。
//
// 何を証明するか：
//  A) 表示パリティ＝**production の buildSettingLabels()** が出すラベル/見出し/並び順が、
//     基準 commit 6a537d1（v0.166.0）の legacy 表示から採取した **凍結 oracle** と全状態で一致する。
//     状態直積 2×2×3×3×2×3×3×2×2×2×3 = 15,552、比較は 15,552×17 = 264,384。
//     ※oracle は「その項目自身の値→ラベル」で引くため、**他設定への偶発依存が生じたら fail** する。
//  B) 構造＝id の重複なし／件数一致／order と一致。
//  C) 実行パリティ＝**production の createSettingHandlers()** に spy 依存を注入し、全 17 ID について
//     「正しい依存だけが呼ばれる」「他は呼ばれない」「reopen が期待値」「循環の遷移順が legacy と同じ」。
//     ＝ handler の中身が正しい ID に結線されていることを型でなく実行で証明する。
//
// テスト用にロジックを再実装しない（production のモジュールを import して回す）。
// 実行: node --experimental-strip-types tools/settings-parity.ts

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildSettingLabels, SETTING_DEFS, type DpadPos, type SettingId, type SettingsState, type Sz } from "../src/web/settings-items.ts";
import { createSettingHandlers, type SettingDeps } from "../src/web/settings-handlers.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const oracle = JSON.parse(readFileSync(join(__dirname, "fixtures", "settings-oracle.json"), "utf8")) as {
  baseCommit: string;
  order: SettingId[];
  headers: Record<string, string>;
  fixedLabels: Record<string, string>;
  variableLabels: Record<string, Record<string, string>>;
};

let fail = 0;
const bad = (msg: string) => { if (fail < 20) console.error("  ✗ " + msg); fail++; };

// ---------- B) 構造 ----------------------------------------------------------
{
  const ids = SETTING_DEFS.map((d) => d.id);
  const dup = ids.filter((id, i) => ids.indexOf(id) !== i);
  if (dup.length) bad(`SettingId の重複: ${[...new Set(dup)].join(", ")}`);
  if (ids.length !== oracle.order.length) bad(`件数不一致: defs=${ids.length} oracle=${oracle.order.length}`);
  ids.forEach((id, i) => { if (id !== oracle.order[i]) bad(`順序不一致 index=${i}: defs=${id} oracle=${oracle.order[i]}`); });
  for (const d of SETTING_DEFS) {
    const expected = oracle.headers[d.id];
    if ((d.header ?? undefined) !== (expected ?? undefined)) bad(`header 不一致 ${d.id}: defs=${String(d.header)} oracle=${String(expected)}`);
  }
}

// ---------- A) 表示パリティ（15,552 状態の全列挙） ---------------------------
/** その項目のラベルを引くための「自分自身の値」キー（oracle の variableLabels のキー）。 */
function ownKey(id: SettingId, s: SettingsState): string | null {
  switch (id) {
    case "audio-mute": return String(s.muted);
    case "bgm-toggle": return String(s.bgmOn);
    case "bgm-volume": return s.bgmVol < 0.45 ? "小" : s.bgmVol < 0.72 ? "中" : "大";
    case "sfx-volume": return s.sfxVol < 0.45 ? "小" : s.sfxVol < 0.72 ? "中" : "大";
    case "dpad-toggle": return String(s.dpadOn);
    case "dpad-position": return s.dpadPos;
    case "dpad-size": return s.dpadSize;
    case "dpad-autorun": return String(s.autorun);
    case "lunge-button": return String(s.lunge);
    case "guard-button": return String(s.guard);
    case "log-size": return s.logSize;
    default: return null; // 固定ラベル
  }
}

const BOOL = [false, true];
const VOLS = [0.35, 0.6, 0.85];          // 小/中/大 の代表値（legacy の設定値）
const POS: DpadPos[] = ["right", "left", "center"];
const SZ: Sz[] = ["lg", "md", "sm"];

let states = 0, comparisons = 0;
for (const muted of BOOL) for (const bgmOn of BOOL) for (const bgmVol of VOLS) for (const sfxVol of VOLS)
for (const dpadOn of BOOL) for (const dpadPos of POS) for (const dpadSize of SZ) for (const autorun of BOOL)
for (const lunge of BOOL) for (const guard of BOOL) for (const logSize of SZ) {
  const s: SettingsState = { muted, bgmOn, bgmVol, sfxVol, dpadOn, dpadPos, dpadSize, autorun, lunge, guard, logSize };
  const rows = buildSettingLabels(s);
  states++;
  if (rows.length !== oracle.order.length) { bad(`行数不一致 ${rows.length}`); break; }
  rows.forEach((row, i) => {
    const id = oracle.order[i];
    if (row.id !== id) bad(`id 不一致 index=${i}: ${row.id} != ${id}`);
    const k = ownKey(id, s);
    const expected = k === null ? oracle.fixedLabels[id] : oracle.variableLabels[id]?.[k];
    if (expected === undefined) { bad(`oracle に期待値がない ${id} key=${String(k)}`); return; }
    if (row.label !== expected) bad(`ラベル不一致 ${id}: got=${JSON.stringify(row.label)} want=${JSON.stringify(expected)}`);
    if ((row.header ?? undefined) !== (oracle.headers[id] ?? undefined)) bad(`header 不一致 ${id}`);
    comparisons++;
  });
}

// ---------- C) 実行パリティ（17 ID の spy 検査） ------------------------------
type Call = { fn: string; args: unknown[] };
function spyDeps(state: {
  muted: boolean; bgmOn: boolean; bgmVol: number; sfxVol: number; dpadOn: boolean;
  dpadPos: DpadPos; dpadSize: Sz; autorun: boolean; lunge: boolean; guard: boolean; logSize: Sz;
}, calls: Call[]): SettingDeps {
  const rec = (fn: string) => (...args: unknown[]) => { calls.push({ fn, args }); };
  return {
    ensureAudio: rec("ensureAudio") as () => void,
    isMuted: () => state.muted, setMuted: rec("setMuted") as (b: boolean) => void,
    isBgmOn: () => state.bgmOn, setBgmEnabled: rec("setBgmEnabled") as (b: boolean) => void,
    bgmVolume: () => state.bgmVol, setBgmVolume: rec("setBgmVolume") as (v: number) => void,
    sfxVolume: () => state.sfxVol, setSfxVolume: rec("setSfxVolume") as (v: number) => void,
    sfx: rec("sfx") as (k: string) => void,
    dpadOn: () => state.dpadOn, setDpad: rec("setDpad") as (b: boolean) => void,
    dpadPos: () => state.dpadPos, setDpadPos: rec("setDpadPos") as (p: DpadPos) => void,
    dpadSize: () => state.dpadSize, setDpadSize: rec("setDpadSize") as (s: Sz) => void,
    dpadAutorun: () => state.autorun, setDpadAutorun: rec("setDpadAutorun") as (b: boolean) => void,
    lungeShow: () => state.lunge, setLungeShow: rec("setLungeShow") as (b: boolean) => void,
    guardShow: () => state.guard, setGuardShow: rec("setGuardShow") as (b: boolean) => void,
    logSize: () => state.logSize, setLogSize: rec("setLogSize") as (s: Sz) => void,
    helpSheet: async () => { calls.push({ fn: "helpSheet", args: [] }); },
    exportSave: async () => { calls.push({ fn: "exportSave", args: [] }); },
    importSave: async () => { calls.push({ fn: "importSave", args: [] }); },
    testSheet: async () => { calls.push({ fn: "testSheet", args: [] }); },
    resetWorld: async () => { calls.push({ fn: "resetWorld", args: [] }); },
  };
}

const BASE = { muted: false, bgmOn: true, bgmVol: 0.6, sfxVol: 0.6, dpadOn: true, dpadPos: "right" as DpadPos, dpadSize: "md" as Sz, autorun: true, lunge: true, guard: true, logSize: "md" as Sz };

/** 期待＝[呼ばれる依存（順序どおり）], reopen */
const EXPECT: Record<SettingId, { calls: Call[]; reopen: boolean }> = {
  "help": { calls: [{ fn: "helpSheet", args: [] }], reopen: true },
  "audio-mute": { calls: [{ fn: "ensureAudio", args: [] }, { fn: "setMuted", args: [true] }], reopen: true },
  "bgm-toggle": { calls: [{ fn: "ensureAudio", args: [] }, { fn: "setBgmEnabled", args: [false] }], reopen: true },
  "bgm-volume": { calls: [{ fn: "ensureAudio", args: [] }, { fn: "setBgmVolume", args: [0.85] }], reopen: true },
  "sfx-volume": { calls: [{ fn: "ensureAudio", args: [] }, { fn: "setSfxVolume", args: [0.85] }, { fn: "sfx", args: ["equip"] }], reopen: true },
  "dpad-toggle": { calls: [{ fn: "setDpad", args: [false] }], reopen: true },
  "dpad-position": { calls: [{ fn: "setDpadPos", args: ["left"] }], reopen: true },
  "dpad-size": { calls: [{ fn: "setDpadSize", args: ["sm"] }], reopen: true },
  "dpad-autorun": { calls: [{ fn: "setDpadAutorun", args: [false] }], reopen: true },
  "lunge-button": { calls: [{ fn: "setLungeShow", args: [false] }], reopen: true },
  "guard-button": { calls: [{ fn: "setGuardShow", args: [false] }], reopen: true },
  "log-size": { calls: [{ fn: "setLogSize", args: ["lg"] }], reopen: true },
  "save-export": { calls: [{ fn: "exportSave", args: [] }], reopen: true },
  "save-import": { calls: [{ fn: "importSave", args: [] }], reopen: true },
  "dev-tools": { calls: [{ fn: "testSheet", args: [] }], reopen: false },
  "world-reset": { calls: [{ fn: "resetWorld", args: [] }], reopen: false },
  "close": { calls: [], reopen: false },
};

for (const id of SETTING_DEFS.map((d) => d.id)) {
  const calls: Call[] = [];
  const handlers = createSettingHandlers(spyDeps({ ...BASE }, calls));
  const h = handlers[id];
  if (!h) { bad(`handler 欠落: ${id}`); continue; }
  await h.run();
  const want = EXPECT[id];
  const got = JSON.stringify(calls), exp = JSON.stringify(want.calls);
  if (got !== exp) bad(`副作用不一致 ${id}: got=${got} want=${exp}`);
  if (h.reopen !== want.reopen) bad(`reopen 不一致 ${id}: got=${h.reopen} want=${want.reopen}`);
}

// 循環の遷移順（legacy と同じ一巡）を production handler で実測
function cycle(id: SettingId, setter: string, seed: Record<string, unknown>, apply: (st: any, v: unknown) => void, steps: number): unknown[] {
  const st: any = { ...BASE, ...seed };
  const out: unknown[] = [];
  for (let i = 0; i < steps; i++) {
    const calls: Call[] = [];
    const handlers = createSettingHandlers(spyDeps(st, calls));
    void handlers[id].run();
    const v = calls.find((c) => c.fn === setter)?.args[0]; // 対象 setter の引数だけを見る（sfx("equip") 等を拾わない）
    out.push(v); apply(st, v);
  }
  return out;
}
const cyc: [SettingId, unknown[], () => unknown[]][] = [
  ["bgm-volume", [0.85, 0.35, 0.6], () => cycle("bgm-volume", "setBgmVolume", { bgmVol: 0.6 }, (s, v) => (s.bgmVol = v), 3)],
  ["sfx-volume", [0.85, 0.35, 0.6], () => cycle("sfx-volume", "setSfxVolume", { sfxVol: 0.6 }, (s, v) => (s.sfxVol = v), 3)],
  ["dpad-position", ["left", "center", "right"], () => cycle("dpad-position", "setDpadPos", { dpadPos: "right" }, (s, v) => (s.dpadPos = v), 3)],
  ["dpad-size", ["md", "sm", "lg"], () => cycle("dpad-size", "setDpadSize", { dpadSize: "lg" }, (s, v) => (s.dpadSize = v), 3)],
  ["log-size", ["md", "lg", "sm"], () => cycle("log-size", "setLogSize", { logSize: "sm" }, (s, v) => (s.logSize = v), 3)],
];
for (const [id, want, run] of cyc) {
  const got = run();
  if (JSON.stringify(got) !== JSON.stringify(want)) bad(`循環の遷移順 不一致 ${id}: got=${JSON.stringify(got)} want=${JSON.stringify(want)}`);
}

// ---------- 結果 -------------------------------------------------------------
if (fail) {
  console.error(`\n[settings-parity] FAIL: ${fail} 件（基準 oracle=${oracle.baseCommit.slice(0, 7)}）`);
  process.exit(1);
}
console.log(`[settings-parity] OK  状態 ${states} / ラベル比較 ${comparisons} / spy 17 ID / 循環 ${cyc.length} 種  （oracle 基準 ${oracle.baseCommit.slice(0, 7)}）`);

// イベント（storylet）整合性の決定論チェック。受理ゲート（npm run check）同梱。
// 狙い＝「弧が途中で繋がらない」「断片の tone/stage 欠落で遭遇描画が実行時 throw する」等を機械検出。
// 既存の companion-check / item-check / echo-check と同じ純エンジン方式（DOMフリー・node 実行）。
// 実行：node --experimental-strip-types src/event-check.ts
//
// 検査項目：
//  1. 弧の生産/消費バランス：prereq で要求される (arc, arcStep) が effect で生産される
//     か、コード初期化弧（main.ts の setArc）であること＝orphan 弧の検出。
//  2. arcPick 網羅：prereq.arcPick が同弧の effect.arc.pick で必ず生産されること。
//  3. step 連続性：各弧の消費 step が 1..max で穴が無いこと（飛びは warn）。
//  4. context 充足：encounter 既定／quest（仕様で空）を除く全 context に候補が ≥1 件。
//  5. 断片 tone×slot 網羅（最重要・ライブ遭遇のクラッシュ防止）：renderRediscovery が
//     遭遇描画時に (tone×stage) フレーム欠落・slot 断片の tone 欠落で throw するのを静的に防ぐ。
//  6. flag 伏線の対応：prereq.flag が content の plant かコード側の flag で必ず立てられること。
//
// ⚠ 語彙（TONES/STAGES/CONTEXTS/FINALACTS）は tools/validate-content.mjs と同期すること。

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { loadContent } from "./content-node.ts";
import { filterByTags } from "./content.ts";
import type { Effect, Prereq, Storylet } from "./types.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ---- 語彙（validate-content.mjs と同期）----
const TONES = ["loss", "myth", "grudge"] as const;
const STAGES = ["weathered", "twisting", "alien"] as const;
const FINALACTS = ["guard_relic", "curse_dungeon", "leave_will", "accept"] as const;
// context ?? "encounter"（storylets.ts）。encounter は既定なので別枠で確認。
// quest は型/CONTEXTS にあるが storylet 駆動でない（固定報酬）＝意図的に空。
const REQUIRED_CONTEXTS = ["dungeon", "street", "tavern", "guild", "shop", "chest", "delver"] as const;
const ALLOW_EMPTY_CONTEXTS = new Set(["quest"]);

// コード初期化弧：main.ts の setArc(...) で step を立てる弧（content に step1 産が無い）。
// key→コードで生産される step 集合。drift 防止のため main.ts のソースに setArc が在ることも確認する。
const CODE_INIT_ARCS: Record<string, number[]> = { noble: [1], noble_ack: [1] };

let pass = 0, fail = 0;
const warn: string[] = [];
function ok(cond: boolean, label: string, detail = "") {
  if (cond) pass++;
  else { fail++; console.log(`  ❌ ${label}${detail ? " :: " + detail : ""}`); }
}
function W(msg: string) { warn.push(msg); }

const db = loadContent();
const storylets: Storylet[] = db.storylets;

/** storylet 内の全 effect を集める（encounter=investigate/search・dungeon=choices・chest=result）。 */
function allEffects(s: Storylet): Effect[] {
  const out: Effect[] = [];
  if (s.investigate) out.push(...s.investigate.effects);
  if (s.search) out.push(...s.search.effects);
  if (s.result) out.push(...s.result.effects);
  for (const c of s.choices ?? []) out.push(...c.effects);
  return out;
}
const ctxOf = (s: Storylet) => s.context ?? "encounter";

// ============================================================
console.log("== 1-3. 弧（arc）の生産/消費・pick・step 連続性 ==");
// 生産：effect.arc が立てる (key→steps) と (key→picks)
const prodSteps: Record<string, Set<number>> = {};
const prodPicks: Record<string, Set<string>> = {};
for (const s of storylets) {
  for (const e of allEffects(s)) {
    if (!e.arc) continue;
    (prodSteps[e.arc.key] ??= new Set()).add(e.arc.step);
    if (e.arc.pick) (prodPicks[e.arc.key] ??= new Set()).add(e.arc.pick);
  }
}
// 消費：prereq の (key, arcStep, arcPick)。storylet id を添えて報告できるよう保持。
const consumeStep: Array<{ id: string; key: string; step: number }> = [];
const consumePick: Array<{ id: string; key: string; pick: string }> = [];
const consumedArcSteps: Record<string, Set<number>> = {};
for (const s of storylets) {
  const p: Prereq = s.prerequisites ?? {};
  if (p.arc === undefined) continue;
  (consumedArcSteps[p.arc] ??= new Set());
  if (p.arcStep !== undefined) { consumeStep.push({ id: s.id, key: p.arc, step: p.arcStep }); consumedArcSteps[p.arc].add(p.arcStep); }
  if (p.arcPick !== undefined) consumePick.push({ id: s.id, key: p.arc, pick: p.arcPick });
}

// 1. 各消費 step は生産されるか、コード初期化弧であること
for (const c of consumeStep) {
  const produced = prodSteps[c.key]?.has(c.step) ?? false;
  const codeInit = (CODE_INIT_ARCS[c.key] ?? []).includes(c.step);
  ok(produced || codeInit, `orphan 弧 step：${c.id} は arc="${c.key}" step=${c.step} を要求するが、生産元が無い`,
    `produced=[${[...(prodSteps[c.key] ?? [])].sort()}] codeInit=[${CODE_INIT_ARCS[c.key] ?? []}]`);
}

// 2. 各消費 pick は生産されるか
for (const c of consumePick) {
  const produced = prodPicks[c.key]?.has(c.pick) ?? false;
  ok(produced, `arcPick 欠落：${c.id} は arc="${c.key}" pick="${c.pick}" を要求するが、生産元が無い`,
    `produced picks=[${[...(prodPicks[c.key] ?? [])]}]`);
}

// 3. step 連続性（消費 step 集合が 1..max で穴無し。コード初期化分も既知として埋める）。穴は warn。
for (const key of Object.keys(consumedArcSteps)) {
  const steps = new Set([...consumedArcSteps[key], ...(CODE_INIT_ARCS[key] ?? [])]);
  const max = Math.max(...steps);
  for (let i = 1; i <= max; i++) if (!steps.has(i)) W(`弧 "${key}" の消費 step に穴：step ${i} を要求する storylet が無い（1..${max}）`);
}

// コード初期化弧の allowlist が main.ts のソースに実在するか（drift 検出）
{
  const mainSrc = readFileSync(join(__dirname, "web", "main.ts"), "utf8");
  for (const key of Object.keys(CODE_INIT_ARCS)) {
    ok(mainSrc.includes(`key: "${key}"`), `CODE_INIT_ARCS の drift：弧 "${key}" を立てる setArc が main.ts に見当たらない`);
  }
}

// ============================================================
console.log("== 4. context 充足（encounter 既定／quest 空を除く全 context に候補 ≥1） ==");
const ctxCount: Record<string, number> = {};
for (const s of storylets) ctxCount[ctxOf(s)] = (ctxCount[ctxOf(s)] ?? 0) + 1;
ok((ctxCount.encounter ?? 0) > 0, "encounter context に候補が無い");
for (const ctx of REQUIRED_CONTEXTS) ok((ctxCount[ctx] ?? 0) > 0, `context "${ctx}" に候補が無い`);
for (const ctx of Object.keys(ctxCount)) {
  if (ctx === "encounter" || REQUIRED_CONTEXTS.includes(ctx as never) || ALLOW_EMPTY_CONTEXTS.has(ctx)) continue;
  W(`未分類の context "${ctx}"（${ctxCount[ctx]}件）＝event-check の語彙更新漏れの可能性`);
}

// ============================================================
console.log("== 4b. keeper-voiced 充足（speaker:keeper の reachability・talkKeeper 結線ドリフト検出） ==");
const KEEPER_CTX = ["guild", "shop", "tavern"] as const;
const keeperCount: Record<string, number> = {};
for (const s of storylets) if ((s as { speaker?: string }).speaker === "keeper") keeperCount[ctxOf(s)] = (keeperCount[ctxOf(s)] ?? 0) + 1;
for (const c of KEEPER_CTX) ok((keeperCount[c] ?? 0) > 0, `keeper context "${c}" に speaker:"keeper" storylet が無い`);
{
  const mainSrc = readFileSync(join(__dirname, "web", "main.ts"), "utf8");
  ok(mainSrc.includes("selectKeeperStorylet("), "talkKeeper が selectKeeperStorylet を呼んでいない（keeper vignette 未結線）");
}

// 4c. 逆方向ドリフト（warn）：店主/受付/女将にしか言えない一人称セリフを持つのに speaker:"keeper" が
//   付いていない shop/guild/tavern storylet＝雑踏NPC（別の客）が店主口調で喋る辻褄崩れ（#230/#231 再発）。
//   4b は「タグ済み keeper の到達性」しか見ず、この未タグ方向を検出しないため補完する。高確度の売り手専用
//   フレーズに限定（客視点の観察文を誤検出しないよう保守的）。引っかかったら speaker:"keeper" を検討する。
const SELLER_VOICE = /負けとく|まけとく|今日の一番客|一番客だ|仕入れが滞|棚を補充|端数は負|うんと安く|安くするぞ|うちの品|まいど|毎度あり|らっしゃい|まとめてなら/;
for (const s of storylets) {
  if ((s as { speaker?: string }).speaker === "keeper") continue;
  if (!KEEPER_CTX.includes(ctxOf(s) as never)) continue;
  const quoted = [s.text ?? "", ...(s.choices ?? []).map((c) => c.text ?? "")].join(" ");
  if (SELLER_VOICE.test(quoted)) W(`店主口調なのに speaker:"keeper" 未タグ：${s.id}（${ctxOf(s)}）＝雑踏NPCが店主として喋る辻褄崩れの恐れ`);
}

// ============================================================
console.log("== 5. 断片 tone×stage×slot 網羅（renderRediscovery の throw を静的に防ぐ） ==");
// 5a. 全 tone×stage に rediscovery_frame が ≥1（render.ts:50-51 の throw 防止）
for (const tone of TONES) for (const stage of STAGES) {
  ok(filterByTags(db, "rediscovery_frame", { tone, stage }).length > 0,
    `フレーム欠落：rediscovery_frame tone=${tone} stage=${stage} が無い（遭遇描画が throw する）`);
}
// 5b. フレームが参照する slot（#ghost#/#behavior#/#recognition#）× 全 tone に断片が ≥1（render.ts:69 の throw 防止）
const slotMap: Record<string, string> = { ghost: "ghost_noun", behavior: "behavior", recognition: "recognition" };
const usedSlots = new Set<string>();
for (const f of db.fragments) {
  if (f.slotType !== "rediscovery_frame") continue;
  for (const m of f.text.matchAll(/#(ghost|behavior|recognition)#/g)) usedSlots.add(m[1]);
}
for (const slot of usedSlots) for (const tone of TONES) {
  ok(filterByTags(db, slotMap[slot], { tone }).length > 0,
    `断片欠落：slot ${slot}(${slotMap[slot]}) tone=${tone} が無い（遭遇描画が throw する）`);
}
// 5c. death_line が全 finalAct を網羅（render.ts:129 renderDeathLine の throw 防止）
for (const fa of FINALACTS) {
  ok(filterByTags(db, "death_line", { finalAct: fa }).length > 0,
    `death_line 欠落：finalAct=${fa} の死の一手の地の文が無い`);
}

// ============================================================
console.log("== 6. flag 伏線の対応（prereq.flag は plant かコード側で必ず立つ） ==");
// 生産：content の plant ＋ main.ts の flags.push("...") 文字列リテラル
const planted = new Set<string>();
for (const s of storylets) for (const e of allEffects(s)) if (e.plant) planted.add(e.plant);
{
  const mainSrc = readFileSync(join(__dirname, "web", "main.ts"), "utf8");
  for (const m of mainSrc.matchAll(/push\("([a-z0-9_]+)"\)/g)) planted.add(m[1]);
}
// 消費：positive な prereq.flag のみ（notFlag は未設定でも常真＝無害）
for (const s of storylets) {
  const f = s.prerequisites?.flag;
  if (f === undefined) continue;
  ok(planted.has(f), `発火不能：${s.id} は flag "${f}" を要求するが、plant もコード側 push も無い`);
}

// ============================================================
console.log("== 7. prereq の context 適用性（死蔵/no-op ゲートの検出） ==");
// 各 context の selection コードが実際に評価する prereq キー（storylets.ts の
// matches()/pickByContext()/townMatches()＋selectDelverStorylet の depth 補正より）。
// ここに無いキーをその context で使うと「評価されず無視される（no-op）」か「決して満たされない（死蔵）」。
// ＝chest minExposure（exposure=0 固定）/ town unfinished（生者は unfinished が立たない）等の罠を機械検出。
const ARCK = ["arc", "notArc", "arcStep", "arcPick"];
const APPLICABLE: Record<string, Set<string>> = {
  encounter: new Set(["tone", "stage", "finalAct", "kind", "minBond", "unfinished", "minExposure",
    "minLevel", "minDepth", "maxDepth", "hasCatchphrase", "flag", "notFlag", ...ARCK]),
  dungeon: new Set(["depthBand", "minDepth", "maxDepth", "minLevel", "minExposure", ...ARCK]),
  // chest は exposure=0 固定で渡るため minExposure は死蔵＝許可しない。
  chest: new Set(["depthBand", "minDepth", "maxDepth", "minLevel", ...ARCK]),
  // 街の生者（unfinished は立たない＝許可しない。depth 系も townMatches 非対応）。
  town: new Set(["actorId", "minBond", "minExposure", "minLevel", "flag", "notFlag", "arcActor", ...ARCK]),
  // delver は迷宮内＝minDepth/maxDepth を ch.depth で評価する（selectDelverStorylet）。
  delver: new Set(["actorId", "minBond", "minExposure", "minLevel", "flag", "notFlag", "arcActor",
    "minDepth", "maxDepth", ...ARCK]),
};
const TOWN_CTX = new Set(["street", "tavern", "guild", "shop", "quest"]);
for (const s of storylets) {
  const ctx = ctxOf(s);
  const allow = APPLICABLE[ctx] ?? (TOWN_CTX.has(ctx) ? APPLICABLE.town : APPLICABLE.encounter);
  for (const k of Object.keys(s.prerequisites ?? {})) {
    ok(allow.has(k), `死蔵/no-op ゲート：${s.id}（context=${ctx}）の prereq "${k}" はこの context で評価されない（無視される/決して満たされない）`);
  }
}

// ============================================================
console.log("== 8. setpiece（山場）の死蔵防止＝型と frame 充填性 ==");
// コード側（main.ts fossilScene）が決着分岐を持つ型のみ＝それ以外は発火しても選択肢が出ず死蔵。
const SETPIECE_HANDLED = new Set(["legend_return", "grudge_hunt", "inheritance"]);
// frame で使える slot（render.ts actorSlotValues）。常に充填可＝name/gear/depth、任意＝catchphrase/epithet。
const SP_SLOTS = new Set(["origin_name", "origin_gear", "depth", "origin_catchphrase", "origin_epithet"]);
const SP_ALWAYS = new Set(["origin_name", "origin_gear", "depth"]);
const slotsIn = (t: string) => [...t.matchAll(/#([a-z_]+)#/g)].map((m) => m[1]);
const spByType: Record<string, number> = {};
const spAlwaysByType: Record<string, number> = {};
for (const sp of db.setpieces) {
  ok(SETPIECE_HANDLED.has(sp.type), `setpiece 死蔵：${sp.id} の type "${sp.type}" は fossilScene に決着分岐が無い（legend_return/grudge_hunt のみ）`);
  const sl = slotsIn(sp.frame);
  for (const s of sl) ok(SP_SLOTS.has(s), `setpiece スロット不正：${sp.id} の #${s}# は frame で充填されない`);
  ok(sl.some((s) => s.startsWith("origin_") || s === "depth") , `setpiece 痕跡欠落：${sp.id} の frame に origin スロットが無い（痕跡 ASSERT に通らない）`);
  spByType[sp.type] = (spByType[sp.type] ?? 0) + 1;
  if (sl.every((s) => SP_ALWAYS.has(s))) spAlwaysByType[sp.type] = (spAlwaysByType[sp.type] ?? 0) + 1;
}
// 各型に「catchphrase/epithet 非依存（常に充填可）」frame が最低1つ＝口癖/異名の無い化石でも山場が出る保証。
for (const t of Object.keys(spByType)) {
  ok((spAlwaysByType[t] ?? 0) >= 1,
    `setpiece 充填漏れ：type "${t}" は常時充填可（name/gear/depth のみ）の frame が無い＝口癖/異名を持たぬ化石で山場が出ない`);
}

// ============================================================
if (warn.length) { console.log("\n-- warnings --"); for (const w of warn) console.log("  △ " + w); }
console.log(`\n=== event-check: ${pass} pass / ${fail} fail / ${warn.length} warn ===`);
if (fail) process.exit(1);

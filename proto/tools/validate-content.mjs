// 鋳造所（道2）の中核＝コンテンツ受理ゲート（4-9 / 4-12）。
// 研究知見「LLMは構造的に無効な出力を出しがち→スキーマ準拠の生成＋エンジン整合の受理ゲート（検証/修復）が要」
// （Schema-Governed LLM Pipeline 等）に基づき、storylets.json をエンジンのスキーマで厳密検証する。
// これにより、手書き／鋳造所(制作時LLM)で大量生成したバッチを「壊れた content をエンジンへ通さない」形で量産できる。
//
// 実行：node tools/validate-content.mjs   （CI スモークにも組込み。エラーがあれば exit 1）
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(ROOT, p), "utf-8");

// ---- エンジンのスキーマ（types.ts と同期。enum は安定。消耗品キーは items.ts から動的取得）----
const CONTEXTS = new Set(["encounter", "dungeon", "street", "tavern", "guild", "shop", "quest", "chest", "delver"]);
const TOWN = new Set(["street", "tavern", "guild", "shop", "quest"]);
const PREREQ_KEYS = new Set(["tone", "stage", "finalAct", "kind", "minBond", "unfinished", "minExposure", "minLevel", "minDepth", "maxDepth", "hasCatchphrase", "depthBand", "flag", "notFlag", "arc", "arcStep", "arcPick", "arcActor", "actorId", "notArc"]);
const EFFECT_KEYS = new Set(["bond", "closeUnfinished", "exposure", "trait", "chronicle", "plant", "arc", "gold", "item", "keepsake"]);
const TONES = new Set(["loss", "myth", "grudge"]);
const STAGES = new Set(["weathered", "twisting", "alien"]);
const FINALACTS = new Set(["guard_relic", "curse_dungeon", "leave_will", "accept"]);
const BANDS = new Set(["shallow", "mid", "deep", "abyss"]);
const KINDS = new Set(["character", "explorer", "relic"]);
// 消耗品キーは items.ts の CONSUMABLES 配列だけから取り出す（ドリフト防止）。
// ※配列に限定＝affix/gear の key を誤って拾わない／数字付きキー(soothe2 等)も取りこぼさない。
const CONSUMABLES_SRC = (read("src/items.ts").match(/CONSUMABLES[^[]*\[([\s\S]*?)\];/) ?? [, ""])[1];
const CONSUMABLES = new Set([...CONSUMABLES_SRC.matchAll(/key:\s*"([a-z0-9_]+)"/g)].map((m) => m[1]));
// 名簿id（actorId prereq の突合・4-14）。adventurers.json があれば集める。
let ROSTER_IDS = new Set();
try { ROSTER_IDS = new Set(JSON.parse(read("content/adventurers.json")).adventurers.map((a) => a.id)); } catch { /* 名簿なし＝空 */ }
// 拾得品プール（keepsakes.json）。effect.keepsake の参照整合に使う。あれば集める。
let KEEPSAKES = [];
try { KEEPSAKES = JSON.parse(read("content/keepsakes.json")).keepsakes ?? []; } catch { /* プールなし＝空 */ }
const KEEPSAKE_IDS = new Set(KEEPSAKES.map((k) => k.id));

// context ごとに本文へ充填できるスロット（fillDungeonText/fillStoryletText/fillActorText に対応）
const SLOTS = {
  dungeon: new Set(["depth"]), chest: new Set(["depth"]),
  // encounter は化石にアンカー。epithet は化石では任意（fossilizeCurrent 等は付けない）＝
  // #origin_epithet# を使うと epithet 無し化石で render の fillSlots が throw する。だから encounter では禁止。
  // （街/delver の生者は mintActor が epithet を必ず付けるので下の street セットでは許可。）
  encounter: new Set(["origin_name", "origin_gear", "origin_catchphrase", "depth"]),
  street: new Set(["origin_name", "origin_gear", "origin_epithet"]),
};
for (const c of ["tavern", "guild", "shop", "quest", "delver"]) SLOTS[c] = SLOTS.street;

const errors = [];
const warn = [];
const E = (id, msg) => errors.push(`✖ [${id}] ${msg}`);
const W = (id, msg) => warn.push(`△ [${id}] ${msg}`);

const data = JSON.parse(read("content/storylets.json"));
const list = data.storylets;
const seen = new Set();

function checkSlots(id, ctx, text) {
  const allow = SLOTS[ctx] ?? SLOTS.encounter;
  for (const m of String(text).matchAll(/#([a-z_]+)#/g)) {
    if (!allow.has(m[1])) E(id, `context=${ctx} で使えないスロット #${m[1]}#（許可: ${[...allow].map((s) => "#" + s + "#").join(",")}）`);
  }
}
function checkEffects(id, ctx, effects, where) {
  if (!Array.isArray(effects)) { E(id, `${where}.effects が配列でない`); return; }
  for (const e of effects) {
    for (const k of Object.keys(e)) if (!EFFECT_KEYS.has(k)) E(id, `${where} 不明な effect キー "${k}"`);
    if (e.arc !== undefined) {
      if (typeof e.arc !== "object" || typeof e.arc.key !== "string" || typeof e.arc.step !== "number")
        E(id, `${where} effect.arc は {key:string, step:number} が必須`);
      if (e.arc?.anchor && !TOWN.has(ctx)) E(id, `${where} effect.arc.anchor は街 context のみ（今: ${ctx}）`);
    }
    if (e.item !== undefined && !CONSUMABLES.has(e.item)) E(id, `${where} 不明な item キー "${e.item}"（許可: ${[...CONSUMABLES].join(",")}）`);
    if (e.gold !== undefined && typeof e.gold !== "number") E(id, `${where} gold は number`);
    if (e.bond !== undefined && typeof e.bond !== "number") E(id, `${where} bond は number`);
    if (e.exposure !== undefined && typeof e.exposure !== "number") E(id, `${where} exposure は number`);
    if (e.trait !== undefined) checkSlots(id, ctx, e.trait);
    if (e.keepsake !== undefined) {
      if (typeof e.keepsake !== "string") E(id, `${where} effect.keepsake は keepsakes.json の id（string）`);
      else if (!KEEPSAKE_IDS.has(e.keepsake)) E(id, `${where} 不明な keepsake id "${e.keepsake}"（keepsakes.json に未定義）`);
    }
    if (e.chronicle !== undefined) checkSlots(id, ctx, e.chronicle);
  }
}
function checkBranch(id, ctx, b, where) {
  if (typeof b?.text !== "string") E(id, `${where}.text（文字列）が無い`);
  else checkSlots(id, ctx, b.text);
  checkEffects(id, ctx, b.effects ?? [], where);
}

for (const s of list) {
  const id = s.id ?? "(no-id)";
  if (typeof s.id !== "string") E(id, "id が文字列でない");
  if (seen.has(s.id)) E(id, "id が重複"); seen.add(s.id);
  const ctx = s.context ?? "encounter";
  if (!CONTEXTS.has(ctx)) E(id, `不明な context "${ctx}"`);
  // speaker:"keeper"（固定NPC本人が語る街イベント）の整合：値・context・スロットを機械検証（辻褄崩れ再発防止）。
  if (s.speaker !== undefined) {
    if (s.speaker !== "keeper") E(id, `不明な speaker "${s.speaker}"（許可:"keeper"）`);
    if (s.speaker === "keeper" && !["guild", "shop", "tavern"].includes(ctx)) E(id, `speaker:"keeper" は guild/shop/tavern のみ（今: ${ctx}）`);
    if (s.speaker === "keeper") { // 店主に異名/装備/口癖が無く fillSlots が throw する→#origin_name# 以外のスロット禁止
      const slots = [...JSON.stringify(s).matchAll(/#(origin_[a-z]+|depth)#/g)].map((m) => m[1]).filter((x) => x !== "origin_name");
      if (slots.length) E(id, `speaker:"keeper" は #origin_name# 以外のスロット不可（検出: ${[...new Set(slots)].join(",")}）`);
    }
  }
  // prerequisites
  const p = s.prerequisites ?? {};
  for (const k of Object.keys(p)) if (!PREREQ_KEYS.has(k)) E(id, `不明な prereq キー "${k}"`);
  if (p.tone !== undefined && !TONES.has(p.tone)) E(id, `prereq.tone 不正 "${p.tone}"`);
  if (p.stage !== undefined && !STAGES.has(p.stage)) E(id, `prereq.stage 不正 "${p.stage}"`);
  if (p.finalAct !== undefined && !FINALACTS.has(p.finalAct)) E(id, `prereq.finalAct 不正 "${p.finalAct}"`);
  if (p.depthBand !== undefined && !BANDS.has(p.depthBand)) E(id, `prereq.depthBand 不正 "${p.depthBand}"`);
  if (p.kind !== undefined && !KINDS.has(p.kind)) E(id, `prereq.kind 不正 "${p.kind}"`);
  // unfinished は化石の bond にしか立たない（生者の bond.unfinished は決して true にならない）＝
  // encounter 以外で unfinished:true は永遠に発火しない死蔵になる。だから encounter 限定。
  if (p.unfinished !== undefined && ctx !== "encounter")
    E(id, `prereq.unfinished は encounter のみ（生者の未完は立たず死蔵になる。今: ${ctx}）`);
  if ((p.arcStep !== undefined || p.arcPick !== undefined || p.arcActor !== undefined) && p.arc === undefined)
    E(id, "arcStep/arcPick/arcActor を使うなら prereq.arc が必須");
  if (p.actorId !== undefined) { // 名簿員アンカー（街専用・4-14）
    if (!TOWN.has(ctx)) E(id, `actorId は街 context のみ（今: ${ctx}）`);
    if (ROSTER_IDS.size && !ROSTER_IDS.has(p.actorId)) E(id, `actorId "${p.actorId}" は名簿(adventurers.json)に無い`);
  }
  // weight
  if (typeof s.weight !== "number" || s.weight <= 0) E(id, `weight は正の number（今: ${s.weight}）`);
  // 本文（context別の形）
  if (ctx === "encounter") {
    if (!s.investigate && !s.search) E(id, "encounter は investigate か search が必要");
    if (s.investigate) checkBranch(id, ctx, s.investigate, "investigate");
    if (s.search) checkBranch(id, ctx, s.search, "search");
  } else if (ctx === "chest") {
    if (!s.result) E(id, "chest は result が必要");
    else checkBranch(id, ctx, s.result, "result");
  } else {
    if (typeof s.text !== "string") E(id, `${ctx} は text が必要`);
    else checkSlots(id, ctx, s.text);
    if (!Array.isArray(s.choices) || s.choices.length === 0) E(id, `${ctx} は choices（1つ以上）が必要`);
    else for (let i = 0; i < s.choices.length; i++) {
      const c = s.choices[i];
      if (typeof c.label !== "string") E(id, `choices[${i}].label が無い`);
      if (c.text !== undefined) checkSlots(id, ctx, c.text);
      checkEffects(id, ctx, c.effects ?? [], `choices[${i}]`);
    }
  }
  // catchphrase スロットは hasCatchphrase ガードが要る（encounter）
  const blob = JSON.stringify(s);
  if (blob.includes("#origin_catchphrase#") && p.hasCatchphrase !== true)
    W(id, "#origin_catchphrase# を使うが prereq.hasCatchphrase:true が無い（充填漏れの恐れ）");
}

// ---- 名簿（adventurers.json・4-14 冒険者B/C）の検証 ----
const ROSTER_HOOKS = new Set(["legend", "grudge", "requiem", "lineage"]);
try {
  const adv = JSON.parse(read("content/adventurers.json")).adventurers;
  const advSeen = new Set();
  for (const a of adv) {
    const id = a.id ?? "(no-id)";
    if (typeof a.id !== "string" || !a.id.startsWith("adv_")) E(id, "名簿 id は 'adv_' で始まる文字列が必須");
    if (advSeen.has(a.id)) E(id, "名簿 id が重複"); advSeen.add(a.id);
    if (typeof a.name !== "string" || !a.name) E(id, "name（文字列）が必須");
    if (typeof a.archetype !== "string" || !a.archetype) E(id, "archetype（文字列）が必須");
    if (!Array.isArray(a.gearTags) || a.gearTags.length === 0) E(id, "gearTags（非空配列）が必須");
    if (a.grade !== undefined && (!Number.isInteger(a.grade) || a.grade < 0 || a.grade > 4)) E(id, `grade は 0..4（今: ${a.grade}）`);
    const f = a.fate ?? {};
    if (!TONES.has(f.tone)) E(id, `fate.tone 不正 "${f.tone}"`);
    if (!ROSTER_HOOKS.has(f.hook)) E(id, `fate.hook 不正 "${f.hook}"（許可: ${[...ROSTER_HOOKS].join(",")}）`);
    if (f.arc !== undefined && typeof f.arc !== "string") E(id, "fate.arc は文字列");
  }
  console.log(`== 名簿（adventurers）：${adv.length}人 ==`);
} catch (e) {
  if (String(e).includes("ENOENT")) console.log("== 名簿（adventurers.json）なし＝スキップ ==");
  else E("adventurers.json", `読み込み/解析に失敗: ${e}`);
}

// arc 整合：anchor で開始する弧に、arcActor で戻る後段があるか（緩いチェック）
const arcsStarted = new Set();
for (const s of list) for (const c of s.choices ?? []) for (const e of c.effects ?? []) if (e.arc?.anchor) arcsStarted.add(e.arc.key);
const arcsReturned = new Set(list.filter((s) => s.prerequisites?.arcActor).map((s) => s.prerequisites.arc));
for (const k of arcsStarted) if (!arcsReturned.has(k)) W(k, `アンカー弧 "${k}" を開始するが、arcActor で戻る後段が見当たらない`);

// flag 連鎖（伏線→回収・4-12 遭-②）整合：plant↔flag/notFlag を base 名で突合。
// すべて警告止まり＝code 側で立つ flag（guardian_boon_*/arc 系/markEventFired 等）や意図的な一方向の
// 伏線があるため error にしない（デプロイを止めない）。
const allEffects = (s) => [
  ...(s.investigate?.effects ?? []), ...(s.search?.effects ?? []),
  ...(s.result?.effects ?? []), ...((s.choices ?? []).flatMap((c) => c.effects ?? [])),
];
const planted = new Set();   // content のどこかで plant される flag 名
const consumed = new Map();  // flag/notFlag で参照される flag 名 → 参照した storylet id[]
for (const s of list) {
  for (const e of allEffects(s)) if (typeof e.plant === "string") planted.add(e.plant);
  const p = s.prerequisites ?? {};
  for (const key of ["flag", "notFlag"]) if (typeof p[key] === "string") {
    if (!consumed.has(p[key])) consumed.set(p[key], []);
    consumed.get(p[key]).push(s.id);
  }
}
// ① 宙ぶらりんの consumer：参照されるが content のどこにも plant が無い flag（永遠に発火しない恐れ/タイポ）
for (const [name, ids] of consumed) if (!planted.has(name))
  W(name, `flag "${name}" を ${ids.join("/")} が参照するが content に plant が無い（code で立つ flag か要確認／タイポの恐れ）`);
// ② dungeon context の no-op：dungeon は flag/plant を機構上参照/適用しない（pickByContext/applyDungeonEffects）
for (const s of list) {
  if ((s.context ?? "encounter") !== "dungeon") continue;
  const p = s.prerequisites ?? {};
  if (p.flag !== undefined || p.notFlag !== undefined)
    W(s.id, `dungeon context で flag/notFlag を使用＝機構上 no-op（pickByContext は dungeon で flag を照合しない）`);
  if (allEffects(s).some((e) => e.plant !== undefined))
    W(s.id, `dungeon context で plant を使用＝機構上 no-op（applyDungeonEffects は plant を適用しない）`);
}
// ③ 情報：consumer の無い plant は一覧のみ（多くは意図的な一方向の伏線フレーバー＝error/warn にしない）
const danglingPlants = [...planted].filter((n) => !consumed.has(n));
if (danglingPlants.length) console.log(`== flag 連鎖：consumer の無い plant ${danglingPlants.length}件（一方向の伏線として正常）: ${danglingPlants.join(", ")} ==`);

// ---- 近似重複検出（4-9 鋳造所QA・量産の反復を防ぐ）：context バケツ内で本文の文字bigram Jaccard ----
// 研究知見「量産は同種の反復に陥りやすい」への対策。閾値0.50（現 content の最大≈0.38 に余裕）。
// warn 止まり＝正当なテーマ反復もあり deploy は止めない（レビューで表現の差別化を促す）。
const NEARDUP_WARN = 0.50;
function textBlob(s) {
  const parts = [];
  if (typeof s.text === "string") parts.push(s.text);
  for (const k of ["investigate", "search", "result"]) if (typeof s[k]?.text === "string") parts.push(s[k].text);
  for (const c of s.choices ?? []) { if (typeof c.text === "string") parts.push(c.text); if (typeof c.label === "string") parts.push(c.label); }
  return parts.join("").replace(/#[a-z_]+#/g, "").replace(/[\s　、。「」『』（）()！？,.!?:：・…—-]/g, "").toLowerCase();
}
function bigrams(t) {
  const g = new Set();
  if (t.length < 2) { if (t) g.add(t); return g; }
  for (let i = 0; i < t.length - 1; i++) g.add(t.slice(i, i + 2));
  return g;
}
const jaccard = (a, b) => { if (!a.size || !b.size) return 0; let inter = 0; for (const x of a) if (b.has(x)) inter++; return inter / (a.size + b.size - inter); };
const ndBuckets = new Map();
for (const s of list) { const ctx = s.context ?? "encounter"; if (!ndBuckets.has(ctx)) ndBuckets.set(ctx, []); ndBuckets.get(ctx).push([s.id, bigrams(textBlob(s))]); }
const ndPairs = [];
for (const [ctx, items] of ndBuckets) for (let i = 0; i < items.length; i++) for (let k = i + 1; k < items.length; k++) {
  const j = jaccard(items[i][1], items[k][1]);
  if (j >= NEARDUP_WARN) ndPairs.push([j, ctx, items[i][0], items[k][0]]);
}
ndPairs.sort((a, b) => b[0] - a[0]);
for (const [j, ctx, a, b] of ndPairs.slice(0, 20)) W(`${a}~${b}`, `近似重複の恐れ（${ctx}・bigram類似 ${j.toFixed(2)}）＝本文が酷似。表現の差別化を推奨`);
if (ndPairs.length) console.log(`== 近似重複（量産QA）：類似≥${NEARDUP_WARN} のペア ${ndPairs.length}件（warn）==`);

// ---- 拾得品プール（keepsakes.json）の検証＝量産しても typo/重複/形不整合を機械検出 ----
{
  const kseen = new Set();
  for (const k of KEEPSAKES) {
    const kid = k?.id ?? "(no-id)";
    if (typeof k.id !== "string" || !k.id) E(kid, "keepsake.id は非空 string");
    else if (kseen.has(k.id)) E(kid, "keepsake.id が重複"); else kseen.add(k.id);
    if (typeof k.title !== "string" || !k.title) E(kid, "keepsake.title は非空 string");
    if (typeof k.story !== "string" || !k.story) E(kid, "keepsake.story は非空 string");
    if (!BANDS.has(k.band)) E(kid, `keepsake.band は ${[...BANDS].join("/")} のいずれか（今: ${k.band}）`);
  }
  // 近似重複（量産QA）：story 本文の文字bigram Jaccard。閾値は storylet と同じ 0.50。
  const kg = KEEPSAKES.map((k) => [k.id, bigrams(String(k.story).replace(/[\s　、。「」『』（）()！？,.!?:：・…—-]/g, "").toLowerCase())]);
  const kp = [];
  for (let i = 0; i < kg.length; i++) for (let j = i + 1; j < kg.length; j++) {
    const s = jaccard(kg[i][1], kg[j][1]); if (s >= NEARDUP_WARN) kp.push([s, kg[i][0], kg[j][0]]);
  }
  kp.sort((a, b) => b[0] - a[0]);
  for (const [s, a, b] of kp.slice(0, 20)) W(`${a}~${b}`, `拾得品の近似重複（bigram類似 ${s.toFixed(2)}）＝story が酷似。差別化を推奨`);
  if (KEEPSAKES.length) console.log(`== 拾得品プール：keepsakes ${KEEPSAKES.length}件（近似重複 ${kp.length}件）==`);
}

console.log(`== コンテンツ検証：storylets ${list.length}件 / 消耗品キー [${[...CONSUMABLES].join(",")}] ==`);
if (warn.length) { console.log(`\n[警告 ${warn.length}]`); warn.forEach((w) => console.log("  " + w)); }
if (errors.length) { console.log(`\n[エラー ${errors.length}]`); errors.forEach((e) => console.log("  " + e)); console.log("\n❌ 受理ゲート：不合格"); process.exit(1); }
console.log(`\n✅ 受理ゲート：合格（エラー0${warn.length ? " / 警告" + warn.length : ""}）`);

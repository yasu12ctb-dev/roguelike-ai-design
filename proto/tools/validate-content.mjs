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
const CONTEXTS = new Set(["encounter", "dungeon", "street", "tavern", "guild", "shop", "quest", "chest"]);
const TOWN = new Set(["street", "tavern", "guild", "shop", "quest"]);
const PREREQ_KEYS = new Set(["tone", "stage", "finalAct", "kind", "minBond", "unfinished", "minExposure", "minLevel", "minDepth", "maxDepth", "hasCatchphrase", "depthBand", "flag", "notFlag", "arc", "arcStep", "arcPick", "arcActor", "actorId", "notArc"]);
const EFFECT_KEYS = new Set(["bond", "closeUnfinished", "exposure", "trait", "chronicle", "plant", "arc", "gold", "item"]);
const TONES = new Set(["loss", "myth", "grudge"]);
const STAGES = new Set(["weathered", "twisting", "alien"]);
const FINALACTS = new Set(["guard_relic", "curse_dungeon", "leave_will", "accept"]);
const BANDS = new Set(["shallow", "mid", "deep"]);
const KINDS = new Set(["character", "explorer", "relic"]);
// 消耗品キーは items.ts から取り出す（ドリフト防止）
const CONSUMABLES = new Set([...read("src/items.ts").matchAll(/key:\s*"([a-z_]+)"/g)].map((m) => m[1]));
// 名簿id（actorId prereq の突合・4-14）。adventurers.json があれば集める。
let ROSTER_IDS = new Set();
try { ROSTER_IDS = new Set(JSON.parse(read("content/adventurers.json")).adventurers.map((a) => a.id)); } catch { /* 名簿なし＝空 */ }

// context ごとに本文へ充填できるスロット（fillDungeonText/fillStoryletText/fillActorText に対応）
const SLOTS = {
  dungeon: new Set(["depth"]), chest: new Set(["depth"]),
  encounter: new Set(["origin_name", "origin_gear", "origin_epithet", "origin_catchphrase", "depth"]),
  street: new Set(["origin_name", "origin_gear", "origin_epithet"]),
};
for (const c of ["tavern", "guild", "shop", "quest"]) SLOTS[c] = SLOTS.street;

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
  // prerequisites
  const p = s.prerequisites ?? {};
  for (const k of Object.keys(p)) if (!PREREQ_KEYS.has(k)) E(id, `不明な prereq キー "${k}"`);
  if (p.tone !== undefined && !TONES.has(p.tone)) E(id, `prereq.tone 不正 "${p.tone}"`);
  if (p.stage !== undefined && !STAGES.has(p.stage)) E(id, `prereq.stage 不正 "${p.stage}"`);
  if (p.finalAct !== undefined && !FINALACTS.has(p.finalAct)) E(id, `prereq.finalAct 不正 "${p.finalAct}"`);
  if (p.depthBand !== undefined && !BANDS.has(p.depthBand)) E(id, `prereq.depthBand 不正 "${p.depthBand}"`);
  if (p.kind !== undefined && !KINDS.has(p.kind)) E(id, `prereq.kind 不正 "${p.kind}"`);
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

console.log(`== コンテンツ検証：storylets ${list.length}件 / 消耗品キー [${[...CONSUMABLES].join(",")}] ==`);
if (warn.length) { console.log(`\n[警告 ${warn.length}]`); warn.forEach((w) => console.log("  " + w)); }
if (errors.length) { console.log(`\n[エラー ${errors.length}]`); errors.forEach((e) => console.log("  " + e)); console.log("\n❌ 受理ゲート：不合格"); process.exit(1); }
console.log(`\n✅ 受理ゲート：合格（エラー0${warn.length ? " / 警告" + warn.length : ""}）`);

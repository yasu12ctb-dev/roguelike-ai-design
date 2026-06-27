// B: 死蔵・到達不能コンテンツ監査（デスクトップ Claude Code 用）。
// validate-content（参照整合）と event-check #7（context×prereq の no-op）は既存。
// 本監査は「同一 context 内で各キーは有効だが、数値の組合せが成立不能＝決して選ばれない」storylet と、
// 「何もしない/空の選択肢」「選択肢ゼロの storylet」を炙り出す＝プレイヤーが永遠に見ないコンテンツの検出。
// 実行: node --experimental-strip-types tools/audit-content.ts
import { loadContent } from "../src/content-node.ts";

const db = loadContent();
const arr = (db as any).storylets as any[];
let DEAD = 0, WARN = 0;
const issues: string[] = [];
function dead(id: string, m: string) { DEAD++; issues.push(`❌ [死蔵] ${id}: ${m}`); }
function warn(id: string, m: string) { WARN++; issues.push(`⚠ [注意] ${id}: ${m}`); }

// depthBand 境界（variation.ts）
const BAND_RANGE: Record<string, [number, number]> = { shallow: [1, 8], mid: [9, 24], deep: [25, 37], abyss: [38, 999] };
const BOND_MAX = 5; // 絆の上限（fossilizeCompanion 等の Math.min(5,...)）

for (const s of arr) {
  const p = s.prerequisites ?? {};
  const ctx = s.context || "encounter";

  // 1. minDepth > maxDepth ＝決して両立しない
  if (p.minDepth !== undefined && p.maxDepth !== undefined && p.minDepth > p.maxDepth)
    dead(s.id, `minDepth(${p.minDepth}) > maxDepth(${p.maxDepth})`);

  // 2. depthBand と minDepth/maxDepth の矛盾（dungeon/chest/encounter で depthBand 有効）
  if (p.depthBand !== undefined && BAND_RANGE[p.depthBand]) {
    const [lo, hi] = BAND_RANGE[p.depthBand];
    if (p.minDepth !== undefined && p.minDepth > hi) dead(s.id, `depthBand=${p.depthBand}(≤${hi}) なのに minDepth=${p.minDepth}`);
    if (p.maxDepth !== undefined && p.maxDepth < lo) dead(s.id, `depthBand=${p.depthBand}(≥${lo}) なのに maxDepth=${p.maxDepth}`);
  }

  // 3. minBond が上限超過
  if (p.minBond !== undefined && p.minBond > BOND_MAX) dead(s.id, `minBond(${p.minBond}) が絆上限(${BOND_MAX})超過`);

  // 4. arc と notArc が同一キーで矛盾
  if (p.arc !== undefined && p.notArc !== undefined && p.arc === p.notArc) dead(s.id, `arc と notArc が同一キー "${p.arc}"`);
  // flag と notFlag が同一
  if (p.flag !== undefined && p.notFlag !== undefined && p.flag === p.notFlag) dead(s.id, `flag と notFlag が同一 "${p.flag}"`);

  // 5. context ごとの必須インタラクション・フィールド（encounter=investigate/search・chest=result・
  //    dungeon/town/delver=choices）が欠けると interactive にならず死蔵。
  const choices = s.choices ?? [];
  const TOWN = new Set(["street", "tavern", "guild", "shop", "delver", "quest"]);
  if (ctx === "encounter") {
    if (!s.investigate && !s.search) dead(s.id, `encounter なのに investigate も search も無い（化石を調べられない）`);
  } else if (ctx === "chest") {
    if (!s.result) dead(s.id, `chest なのに result が無い（開封しても何も起きない）`);
  } else if (ctx === "dungeon" || TOWN.has(ctx)) {
    if (choices.length === 0) dead(s.id, `${ctx} なのに choices が空（選択肢が出ず会話/イベントが成立しない）`);
  }

  // 6. 完全に空の選択肢（label が無い＝押せない／label のみで text も effects も無い＝辞退かもしれず要確認）
  choices.forEach((c: any, i: number) => {
    const noLabel = !c.label || !String(c.label).trim();
    const noText = !c.text || !String(c.text).trim();
    const noEff = !Array.isArray(c.effects) || c.effects.length === 0;
    if (noLabel) dead(s.id, `choice[${i}] に label が無い（押せない/表示できない）`);
    else if (noText && noEff) warn(s.id, `choice[${i}] "${c.label}" は text も effects も無い（何も起きない＝意図的な辞退か要確認）`);
  });

  // 6b. branch（investigate/search/result）が空文字／effects 不正
  for (const bk of ["investigate", "search", "result"] as const) {
    const b = (s as any)[bk];
    if (b && (!b.text || !String(b.text).trim())) dead(s.id, `${bk}.text が空`);
    if (b && !Array.isArray(b.effects)) warn(s.id, `${bk}.effects が配列でない`);
  }

  // 7. minLevel が極端（Lv50 上限超過＝事実上死蔵）
  if (p.minLevel !== undefined && p.minLevel > 50) dead(s.id, `minLevel(${p.minLevel}) が Lv上限(50)超過`);

  // 8. バランス外れ値（warn）：「バランス中立 ＋ 大報酬はゲートで守る」方針の逸脱を検出。
  //   現 corpus は gold p95=26/exposure p95=0.1＝外れ値（大 gold／大浄化）が無ゲートだと序盤で farm 可能＝
  //   終始シビアを崩す。閾値は p95 を大きく超える地点に置き、ゲート（Lv/深度/帯/arc/flag/actor/絆/深蝕）が
  //   あれば終盤報酬として許容、無ければ警告。能動的バランス調整中の事故（無ゲート大報酬の混入）を抑止。
  const gated = !!(p.minLevel || p.minDepth || (p.depthBand && p.depthBand !== "shallow") || p.arc || p.flag || p.actorId || p.minBond || p.minExposure);
  const allEff = [
    ...choices.flatMap((c: any) => c.effects ?? []),
    ...(s.investigate?.effects ?? []), ...(s.search?.effects ?? []), ...(s.result?.effects ?? []),
  ];
  for (const e of allEff) {
    if (typeof e.gold === "number" && e.gold > 40 && !gated) warn(s.id, `無ゲートで大 gold +${e.gold}（p95=26 超／序盤 farm 可能＝終始シビアを崩す恐れ）`);
    if (typeof e.exposure === "number" && e.exposure < -0.3 && !gated) warn(s.id, `無ゲートで大浄化 ${e.exposure}（深蝕を安価に消せる＝深蝕圧の意義を損なう恐れ）`);
  }
}

console.log(`=== audit-content 完了：${arr.length} storylets ===`);
console.log(`死蔵 ${DEAD}件 / 注意 ${WARN}件`);
for (const i of issues.slice(0, 120)) console.log("  " + i);
if (DEAD === 0 && WARN === 0) console.log("  ✅ 死蔵・空選択肢なし");
process.exit(DEAD > 0 ? 1 : 0);

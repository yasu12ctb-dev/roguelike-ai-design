// ルートシステム（銘×基×+N）の決定論テスト。最重要＝合成名↔分解（itemByName）の往復一致を機械保証。
// 化石 gearTags（文字列）→継承で itemByName 復元する経路が壊れない／銘の前方一致が曖昧でないことを担保。
// 実行：node --experimental-strip-types src/item-check.ts
import { AFFIXES, baseList, forgeItem, itemByName, enchantUp } from "./items.ts";
import type { Item } from "./types.ts";

let pass = 0, fail = 0;
function ok(cond: boolean, label: string, detail = "") {
  if (cond) pass++;
  else { fail++; console.log(`  ❌ ${label}${detail ? " :: " + detail : ""}`); }
}
const sig = (it: Item) =>
  JSON.stringify({ b: it.baseName, a: it.affix ?? null, e: it.enchant ?? 0,
    d: it.dmg ?? 0, r: it.reduce ?? 0, x: it.exposurePerTurn ?? 0, c: it.capacity ?? 0, rel: it.relic ?? null });

console.log("== 往復一致（合成名 → itemByName → 同一） ==");
let combos = 0;
for (const base of baseList()) {
  // その基に適用しうる銘（スロット一致）＋無銘。
  const affixKeys: (string | null)[] = [null, ...AFFIXES.filter((a) => a.slots.includes(base.slot)).map((a) => a.key)];
  for (const ak of affixKeys) {
    for (let enc = 0; enc <= 6; enc++) {
      const made = forgeItem(base.name, ak, enc);
      ok(!!made, `forge失敗 ${base.name}/${ak}/+${enc}`);
      if (!made) continue;
      const back = itemByName(made.name);
      ok(!!back, `itemByName が null: 「${made.name}」`);
      if (!back) continue;
      // 構造＋焼かれた値が完全一致＝銘の取り違え・+Nの取りこぼしが無いこと
      ok(sig(made) === sig(back), `往復不一致「${made.name}」`, `${sig(made)} vs ${sig(back)}`);
      // 銘key・基名・+N の意味的一致も明示
      ok((back.affix ?? null) === (ak), `銘不一致「${made.name}」`, `${back.affix ?? null} vs ${ak}`);
      ok(back.baseName === base.name, `基不一致「${made.name}」`);
      ok((back.enchant ?? 0) === enc, `+N不一致「${made.name}」`);
      combos++;
    }
  }
}
console.log(`  （${combos} 通りの 基×銘×+N を検証）`);

console.log("== 旧セーブ後方互換（無銘の基名・+N文字列） ==");
ok(itemByName("短刀")?.baseName === "短刀", "旧無銘名の復元");
ok((itemByName("長剣")?.dmg ?? 0) === 2, "旧無銘の焼き値");
ok(itemByName("長剣+2")?.enchant === 2, "+N 付き名の復元");
ok(itemByName("存在しない刀") === null, "未知名は null（形質化）");

console.log("== 打ち直し（enchantUp） ==");
const w = forgeItem("長剣", "sharp", 1)!;            // 切れ味の良い長剣+1
const w2 = enchantUp(w)!;
ok(w2.enchant === 2, "enchantUp +1");
ok((w2.dmg ?? 0) === (w.dmg ?? 0) + 1, "enchantUp で dmg+1（武器）");
ok(w2.affix === "sharp" && w2.baseName === "長剣", "enchantUp が銘・基を保つ");
// 旧 Item（構造フィールド無し）＝名前から復元して+1
const legacy: Item = { id: "x", slot: "weapon", name: "戦士の短刀", dmg: 2 };
const lu = enchantUp(legacy);
ok(!!lu && lu.enchant === 1 && lu.affix === "warrior" && lu.baseName === "短刀", "旧Itemの打ち直し復元");

console.log("== 深蝕の符号（蝕=+／浄=−） ==");
ok((forgeItem("長剣", "hungry", 0)?.exposurePerTurn ?? 0) > 0, "蝕は深蝕+");
ok((forgeItem("長剣", "absolve", 0)?.exposurePerTurn ?? 0) < 0, "浄は深蝕−（深蝕を軽減する武器）");
ok((forgeItem("重鎧", "devour", 0)?.exposurePerTurn ?? 0) > 0, "効果高いが深蝕を帯びる防具");

console.log(`\n=== item-check: ${pass} pass / ${fail} fail ===`);
if (fail) process.exit(1);

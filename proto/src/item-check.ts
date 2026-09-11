// ルートシステム（銘×基×+N）の決定論テスト。最重要＝合成名↔分解（itemByName）の往復一致を機械保証。
// 化石 gearTags（文字列）→継承で itemByName 復元する経路が壊れない／銘の前方一致が曖昧でないことを担保。
// 実行：node --experimental-strip-types src/item-check.ts
import { AFFIXES, baseList, forgeItem, itemByName, enchantUp, itemPower, rollItem, weaponClassEntryDepth, itemWeaponClass } from "./items.ts";
import { makeRng } from "./rng.ts";
import { BASE_STATS, RELIC_VIGOR_HP, meleeDmg, maxHp, armorReduce, effectiveReason, xpMul } from "./progression.ts";
import type { Character, Item } from "./types.ts";

let pass = 0, fail = 0;
function ok(cond: boolean, label: string, detail = "") {
  if (cond) pass++;
  else { fail++; console.log(`  ❌ ${label}${detail ? " :: " + detail : ""}`); }
}
const sig = (it: Item) =>
  JSON.stringify({ b: it.baseName, a: it.affix ?? null, e: it.enchant ?? 0,
    d: it.dmg ?? 0, r: it.reduce ?? 0, x: it.exposurePerTurn ?? 0, c: it.capacity ?? 0, rel: it.relic ?? null, reach: it.reach ?? 0, sw: it.sweep ?? false });

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

console.log("== 遺物の効果（派生値への反映） ==");
// 派生関数は ch.stats と ch.equipment.relic しか読まないので最小キャラで十分（world.ts を引かない）。
const RELIC_BASE: Record<string, string> = {
  calm: "静心の護符", reason: "理脈の指輪", greed: "貪欲の徽章", might: "闘魂の小手",
  vigor: "不屈の護符", ward: "守護の円環", fortune: "黄金の指輪", mending: "再生の雫",
};
const relicNamed = (kind: string) => forgeItem(RELIC_BASE[kind], null, 0);
const charWith = (relic: Item | null): Character =>
  ({ stats: { ...BASE_STATS }, equipment: { weapon: null, armor: null, relic } } as unknown as Character);
const base = charWith(null);
ok(meleeDmg(charWith(relicNamed("might"))) === meleeDmg(base) + 1, "might→近接+1");
ok(maxHp(charWith(relicNamed("vigor"))) === maxHp(base) + RELIC_VIGOR_HP, "vigor→最大HP+6");
ok(armorReduce(charWith(relicNamed("ward"))) === armorReduce(base) + 1, "ward→被ダメ-1");
ok(effectiveReason(charWith(relicNamed("reason"))) === effectiveReason(base) + 1, "reason→理+1（回帰）");
ok(xpMul(charWith(relicNamed("greed"))) === 1.5, "greed→XP×1.5（回帰）");

console.log("== 遺物の表示（全 RelicKind が itemPower で名前を持つ） ==");
for (const kind of ["calm", "reason", "greed", "might", "vigor", "ward", "fortune", "mending"]) {
  const it = relicNamed(kind);
  ok(!!it && !!it.relic && !itemPower(it).includes("遺物"), `RELIC_DESC 欠落: ${kind}`, it ? itemPower(it) : "no-base");
}

// ── 武器クラスの解禁境界（v0.175.0 追加）──────────────────────────────────────────────
// #412 の穴＝薙鎌の minDepth を 3→8 に上げたのに、ボス経路（rollItem の depth+5 早期解禁）が D3〜D7 で薙刀クラスを
// 配り続けていた。通常経路しか測らなかったため受理ゲートも golden も検出できなかった。ここで両経路を固定する。
console.log("== 武器クラスの解禁境界（通常・boss 双方） ==");
const ENTRY_SPEC: Record<string, number> = { melee: 1, reach: 2, sweep: 8 }; // 剣 D1／槍 D2／薙刀 D8（設計の正＝変えるときはここも直す）
const entry = weaponClassEntryDepth();
for (const k of Object.keys(ENTRY_SPEC)) {
  ok(entry[k as keyof typeof entry] === ENTRY_SPEC[k], `武器クラス ${k} の入口深度`, `実測 ${entry[k as keyof typeof entry]} / 仕様 ${ENTRY_SPEC[k]}`);
}

// 不変条件：どの深度・どの経路で引いても、武器のクラスはその深度で既に解禁されたクラスに限る。
// ＝ボスの早期解禁は「同じクラスの上位品を少し早く」であって「まだ扱えないクラスの扉を開ける」ではない。
{
  const seen = new Map<string, Set<number>>(); // クラス → 出現した深度
  let violations = 0, firstBad = "";
  for (let depth = 1; depth <= 50; depth++) {
    for (const boss of [false, true]) {
      const rng = makeRng(0x5eed0000 + depth * 2 + (boss ? 1 : 0));
      for (let i = 0; i < 600; i++) {
        const it = rollItem(depth, rng, boss ? { boss: true } : {});
        const k = itemWeaponClass(it);
        if (!k) continue;
        if (!boss) (seen.get(k) ?? seen.set(k, new Set()).get(k)!).add(depth);
        if (entry[k] > depth) {
          violations++;
          if (!firstBad) firstBad = `D${depth}${boss ? "(boss)" : ""} で ${k}: ${it.baseName ?? it.name}`;
        }
      }
    }
  }
  ok(violations === 0, "未解禁クラスの武器がドロップしない（D1〜D50 × 通常/boss × 600回）", firstBad || `${violations} 件`);
  // 解禁の下側：薙刀クラスは D1〜D7 で一切出ない（#412 の意図＝序盤の面制圧を塞ぐ）。
  const sweepDepths = seen.get("sweep") ?? new Set<number>();
  for (let depth = 1; depth <= 7; depth++) ok(!sweepDepths.has(depth), `D${depth} に薙刀クラスが出ない`);
  // 解禁の上側：境界の D8 では実際に出る（ゲートを閉め過ぎて死蔵にしていないことの裏取り）。
  ok(sweepDepths.has(ENTRY_SPEC.sweep), `D${ENTRY_SPEC.sweep}（入口）で薙刀クラスが出る`);
}

console.log(`\n=== item-check: ${pass} pass / ${fail} fail ===`);
if (fail) process.exit(1);

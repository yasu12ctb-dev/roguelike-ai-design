// 装備アイテム（4-11F④・4-11E）。武器=攻撃+ / 防具=被ダメ- / 遺物=パッシブ。異物=未鑑定。
// 効果の適用は progression.ts（派生値）と web/main.ts（盤面）。ここは定義と抽選・表示のみ。

import type { Rng } from "./rng.ts";
import type { Item, ItemSlot } from "./types.ts";

interface Template {
  slot: ItemSlot; name: string; minDepth: number;
  dmg?: number; reduce?: number; relic?: Item["relic"]; exposurePerTurn?: number;
  oddity?: boolean; // 異物（必ず未鑑定）
}

// 実装の正。新装備はここに足すだけで宝箱/ボスドロップに乗る。
const TEMPLATES: Template[] = [
  // 武器（攻撃+）
  { slot: "weapon", name: "短刀",     minDepth: 1,  dmg: 1 },
  { slot: "weapon", name: "長剣",     minDepth: 4,  dmg: 2 },
  { slot: "weapon", name: "戦鎚",     minDepth: 11, dmg: 3 },
  { slot: "weapon", name: "深淵の刃", minDepth: 16, dmg: 4, exposurePerTurn: 0.02, oddity: true },
  // 防具（被ダメ-）
  { slot: "armor",  name: "革鎧",     minDepth: 1,  reduce: 1 },
  { slot: "armor",  name: "鎖帷子",   minDepth: 6,  reduce: 2 },
  { slot: "armor",  name: "重鎧",     minDepth: 14, reduce: 3 },
  // 遺物（パッシブ）
  { slot: "relic",  name: "静心の護符", minDepth: 2,  relic: "calm" },
  { slot: "relic",  name: "理脈の指輪", minDepth: 4,  relic: "reason" },
  { slot: "relic",  name: "貪欲の徽章", minDepth: 7,  relic: "greed" },
  { slot: "relic",  name: "昏き護符",   minDepth: 12, relic: "reason", exposurePerTurn: 0.03, oddity: true },
];

let n = 0;
const iid = () => `it_${(++n).toString(36)}`;

function fromTemplate(t: Template): Item {
  const item: Item = { id: iid(), slot: t.slot, name: t.name };
  if (t.dmg) item.dmg = t.dmg;
  if (t.reduce) item.reduce = t.reduce;
  if (t.relic) item.relic = t.relic;
  if (t.exposurePerTurn) item.exposurePerTurn = t.exposurePerTurn;
  return item;
}

/** 名前から装備を復元（鑑定済み）。継承で先代の武器を奪還する際に使う（4-11E）。
 *  既定装備名（テンプレに無い）なら null。 */
export function itemByName(name: string): Item | null {
  const t = TEMPLATES.find((t) => t.name === name);
  return t ? fromTemplate(t) : null;
}

/** 深度に応じた装備を1つ抽選。ボスは上位寄り。一部は異物（未鑑定）。 */
export function rollItem(depth: number, rng: Rng, opts: { boss?: boolean } = {}): Item {
  const avail = TEMPLATES.filter((t) => t.minDepth <= depth + (opts.boss ? 5 : 0));
  const src = avail.length ? avail : [TEMPLATES[0]];
  let t: Template;
  if (opts.boss) {
    const sorted = [...src].sort((a, b) => b.minDepth - a.minDepth);
    t = sorted[rng.int(Math.min(3, sorted.length))]; // 上位3種から
  } else {
    t = src[rng.int(src.length)];
  }
  const item = fromTemplate(t);
  if (t.oddity || rng.next() < 0.18) item.unidentified = true; // 異物 or 一定確率で未鑑定
  return item;
}

export const SLOT_LABEL: Record<ItemSlot, string> = { weapon: "武器", armor: "防具", relic: "遺物" };

// 消耗品（4-10G／持ち物システム Phase1）。装備とは別系統＝持ち物に入り、使うと消える。
// 効果：exposure＝深蝕を退ける（持続するので街でも有効）／healFrac＝最大HPの割合を回復（潜行中専用）。
export interface ConsumableDef {
  key: string; name: string; desc: string; price: number;
  use: { exposure?: number; healFrac?: number };
}
export const CONSUMABLES: ConsumableDef[] = [
  { key: "soothe", name: "鎮静の薬",   desc: "深蝕を 0.6 退ける（携行できる薬師）", price: 16, use: { exposure: -0.6 } },
  { key: "salve",  name: "治癒の膏薬", desc: "最大HPの半分を癒す（潜行中に）",     price: 12, use: { healFrac: 0.5 } },
];
export const consumableByKey = (key: string): ConsumableDef | undefined => CONSUMABLES.find((c) => c.key === key);

/** 効果の説明（鑑定済み前提）。 */
export function itemPower(it: Item): string {
  let s: string;
  if (it.slot === "weapon") s = `攻＋${it.dmg}`;
  else if (it.slot === "armor") s = `被ダメ−${it.reduce}`;
  else s = it.relic === "calm" ? "深蝕レート減" : it.relic === "reason" ? "理＋1" : "撃破XP増";
  if (it.exposurePerTurn) s += "・装備中わずかに深蝕＋";
  return s;
}

/** 一覧表示用ラベル（未鑑定は正体を伏せる）。 */
export function itemLabel(it: Item): string {
  return it.unidentified ? `見知らぬ${SLOT_LABEL[it.slot]}（未鑑定）` : `${it.name}（${itemPower(it)}）`;
}

/** 金貨での価値（4-10G 経済）。売却額＝この値。購入は店側で割増する。 */
export function itemValue(it: Item): number {
  let v: number;
  if (it.slot === "weapon") v = 6 + (it.dmg ?? 0) * 8;
  else if (it.slot === "armor") v = 6 + (it.reduce ?? 0) * 8;
  else v = 14; // 遺物
  if (it.exposurePerTurn) v += 10;          // 異物は世界唯一の輸出品＝高値（4-3③）
  if (it.unidentified) v = Math.round(v * 0.7); // 未鑑定は買い叩かれる
  return v;
}

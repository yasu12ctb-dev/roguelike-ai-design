// スロット充填と痕跡保証（prototype-spec.md §4.4）
// どれだけ変わり果てても origin の痕跡（名前/装備/口癖）が本文に必ず残る。

import type { ContentDb } from "./content.ts";
import { filterByTags, pickByTags } from "./content.ts";
import type { Fossil, SetPiece, VariationResult } from "./types.ts";
import type { Rng } from "./rng.ts";

interface SlotValues { [slot: string]: string | undefined; }

function slotsOf(text: string): string[] {
  return [...text.matchAll(/#([a-z_.]+)#/g)].map((m) => m[1]);
}

function fillSlots(text: string, values: SlotValues): string {
  return text.replace(/#([a-z_.]+)#/g, (_, key: string) => {
    const v = values[key];
    if (v === undefined) throw new Error(`unfilled slot: ${key}`);
    return v;
  });
}

/** 痕跡判定：origin の name / gear / catchphrase のいずれかを含むか（4-2 必須制約） */
export function hasOriginTrace(text: string, fossil: Fossil): boolean {
  const marks = [fossil.origin.name, ...fossil.origin.gearTags, fossil.origin.catchphrase].filter(
    (s): s is string => !!s,
  );
  return marks.some((m) => text.includes(m));
}

function originSlotValues(fossil: Fossil): SlotValues {
  return {
    origin_name: fossil.origin.name,
    origin_gear: fossil.origin.gearTags.join("の"),
    origin_catchphrase: fossil.origin.catchphrase,
    depth: `深度${fossil.laidDepth}`,
  };
}

/** 再発見テキストの生成。痕跡 ASSERT に通るまでフレームを替えて再試行する。 */
export function renderRediscovery(
  db: ContentDb, rng: Rng, fossil: Fossil, variation: VariationResult,
): string {
  const want = { tone: fossil.tonePole, stage: variation.stage };
  const frames = filterByTags(db, "rediscovery_frame", want);
  if (frames.length === 0) throw new Error(`no frame for ${JSON.stringify(want)}`);

  const origin = originSlotValues(fossil);
  // 必要スロットが埋められないフレーム（例: 口癖が無いのに #origin_catchphrase# を要求）を除外
  const usable = frames.filter((f) => slotsOf(f.text).every((s) => {
    if (s in origin) return origin[s] !== undefined;
    return true; // ghost/behavior/recognition は断片から充填できる
  }));
  const pool = usable.length > 0 ? usable : frames;

  // 痕跡 ASSERT：合格するまで最大 pool 数だけ試す（構造上ほぼ1回で通る）
  const tried = new Set<string>();
  while (tried.size < pool.length) {
    const frame = rng.pick(pool.filter((f) => !tried.has(f.id)));
    tried.add(frame.id);
    const values: SlotValues = { ...origin };
    for (const slot of slotsOf(frame.text)) {
      if (values[slot] !== undefined) continue;
      const fragment = pickByTags(db, rng, slotMap(slot), { tone: fossil.tonePole });
      values[slot] = fragment.text;
    }
    const text = fillSlots(frame.text, values);
    if (hasOriginTrace(text, fossil)) return text;
  }
  throw new Error(`trace assert failed for fossil ${fossil.id}`); // 起きたら内容データのバグ
}

function slotMap(slot: string): string {
  switch (slot) {
    case "ghost": return "ghost_noun";
    case "behavior": return "behavior";
    case "recognition": return "recognition";
    default: throw new Error(`unknown slot: ${slot}`);
  }
}

/** 山場：予約セットピース（4-9C）。条件を満たす型があればそれを使う。 */
export function renderSetPieceIfAny(
  db: ContentDb, fossil: Fossil, variation: VariationResult,
): string | null {
  if (variation.stage === "weathered") return null; // 山場は変質が進んだ相手のみ
  const sp = db.setpieces.find(
    (s: SetPiece) =>
      (s.prerequisites.tone === undefined || s.prerequisites.tone === fossil.tonePole) &&
      (s.prerequisites.minBond === undefined || fossil.bondAtDeath >= s.prerequisites.minBond),
  );
  if (!sp) return null;
  const values = originSlotValues(fossil);
  if (slotsOf(sp.frame).some((s) => values[s] === undefined)) return null;
  const text = fillSlots(sp.frame, values);
  return hasOriginTrace(text, fossil) ? text : null;
}

/** ストーリーレット本文の origin スロット充填（4-12。痕跡＝出自を必ず差し込む）。 */
export function fillStoryletText(fossil: Fossil, text: string): string {
  return fillSlots(text, originSlotValues(fossil));
}

/** 死の一手の地の文（finalAct タグで抽選） */
export function renderDeathLine(db: ContentDb, rng: Rng, finalAct: Fossil["death"]["finalAct"]): string {
  return pickByTags(db, rng, "death_line", { finalAct: finalAct.choice }).text;
}

/** 噂（街で聞く又聞き。痕跡スロットを差し込む） */
export function renderRumor(db: ContentDb, rng: Rng, fossil: Fossil): string {
  const pool = filterByTags(db, "rumor", {});
  const origin = originSlotValues(fossil);
  const usable = pool.filter((f) => slotsOf(f.text).every((s) => origin[s] !== undefined));
  const frame = rng.pick(usable.length > 0 ? usable : pool);
  return fillSlots(frame.text, origin);
}

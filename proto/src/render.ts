// スロット充填と痕跡保証（prototype-spec.md §4.4）
// どれだけ変わり果てても origin の痕跡（名前/装備/口癖）が本文に必ず残る。

import type { ContentDb } from "./content.ts";
import { filterByTags, pickByTags } from "./content.ts";
import type { Actor, Fossil, SetPiece, TonePole, TrackedEntity, VariationResult } from "./types.ts";
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

/** アクター記述子（化石 origin / 生者NPC）の origin スロット値。depth は化石のみ。 */
function actorSlotValues(actor: Actor, depth?: number): SlotValues {
  return {
    origin_name: actor.name,
    origin_gear: actor.gearTags.join("の"),
    origin_catchphrase: actor.catchphrase,
    origin_epithet: actor.epithet,
    depth: depth !== undefined ? `深度${depth}` : undefined,
  };
}
function originSlotValues(fossil: Fossil): SlotValues {
  return actorSlotValues(fossil.origin, fossil.laidDepth);
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

/** 山場：条件を満たす予約セットピースの定義を返す（4-9C／遭-④）。型で固有の決着を分岐するため。
 *  prereq（tone/minBond）一致かつ frame のスロットが全て充填可（口癖/異名を持たぬ化石は当該frameを除外）
 *  かつ痕跡を保つ候補を「全て」集め、その中から rng で1件選ぶ＝同型でも frame が多様化し、
 *  「最初の1件が充填不可だと山場が出ない」死蔵も解消する。 */
export function matchSetPiece(
  db: ContentDb, fossil: Fossil, variation: VariationResult, rng: Rng,
): SetPiece | null {
  if (variation.stage === "weathered") return null; // 山場は変質が進んだ相手のみ
  const values = originSlotValues(fossil);
  const cands = db.setpieces.filter((s: SetPiece) =>
    (s.prerequisites.tone === undefined || s.prerequisites.tone === fossil.tonePole) &&
    (s.prerequisites.minBond === undefined || fossil.bondAtDeath >= s.prerequisites.minBond) &&
    slotsOf(s.frame).every((sl) => values[sl] !== undefined) && // 充填できない frame（口癖無し化石等）は候補から外す
    hasOriginTrace(fillSlots(s.frame, values), fossil),
  );
  return cands.length ? rng.pick(cands) : null;
}

/** 山場：予約セットピース（4-9C）。条件を満たす型があればその地の文を使う。 */
export function renderSetPieceIfAny(
  db: ContentDb, fossil: Fossil, variation: VariationResult, rng: Rng,
): string | null {
  const sp = matchSetPiece(db, fossil, variation, rng);
  return sp ? fillSlots(sp.frame, originSlotValues(fossil)) : null;
}

/** ストーリーレット本文の origin スロット充填（4-12。痕跡＝出自を必ず差し込む）。 */
export function fillStoryletText(fossil: Fossil, text: string): string {
  return fillSlots(text, originSlotValues(fossil));
}

/** アクター記述子（化石/生者）にアンカーした本文充填（4-12(G)。街/依頼で使う。深度は任意）。 */
export function fillActorText(actor: Actor, text: string, depth?: number): string {
  return fillSlots(text, actorSlotValues(actor, depth));
}

/** ダンジョン環境イベント本文の充填（アクター無し。深度スロットのみ：4-12 F）。 */
export function fillDungeonText(depth: number, text: string): string {
  return text.replace(/#depth#/g, String(depth));
}

/** 死の一手の地の文（finalAct タグで抽選） */
export function renderDeathLine(db: ContentDb, rng: Rng, finalAct: Fossil["death"]["finalAct"]): string {
  return pickByTags(db, rng, "death_line", { finalAct: finalAct.choice }).text;
}

// ---------- 遭遇の常設動詞の締め（4-12B：鎮魂/継承/立ち去るで結果を分岐させ反復を避ける） ----------

type VerbLines = Record<TonePole, string[]>;

/** 鎮魂で和らぐ深蝕量（人間性の回復弁＝魔法が深蝕を燃やすことの対の極：4-12B）。最終バランスで調整。 */
export const REQUIEM_RELIEF = 0.12;

// 鎮魂：末路を閉じ、張りつめたものを解く。tone別に複数用意して毎回違う締めにする。
const REQUIEM_LINES: VerbLines = {
  loss: [
    "#origin_name# の強張りが、ようやくほどけていく。よく休め、と胸の内で告げた。",
    "祈りのあいだ、#origin_name# の輪郭がほんの少し和らいだ気がした。",
    "#origin_gear# を胸の上で組み直してやる。これでもう、誰も守らなくていい。",
  ],
  myth: [
    "#origin_name# の偉業に、静かに礼を捧げた。光が、満ち足りたように薄れていく。",
    "讃えるように頭を垂れると、#origin_gear# の輝きがやわらかく応えた。",
    "語り継ぐと約束した。#origin_name# の気配が、安堵して遠ざかる。",
  ],
  grudge: [
    "#origin_name# の怨みに、ただ詫びた。錆びた#origin_gear# から、わずかに力が抜ける。",
    "憎しみを否定せず、受け止めると告げた。#origin_name# の震えが、少しずつ収まっていく。",
    "「お前は、もう充分に戦った」。#origin_gear# の切先が、ゆっくりと下りた。",
  ],
};

// 立ち去る：放置＝最も濃く危険な種（4-2 怨念極）。未練を底に置き去りにする不穏さ。
const LEAVE_LINES: VerbLines = {
  loss: [
    "#origin_name# をそのままに、踵を返す。果たし損ねた何かが、背に張りついたままだ。",
    "見なかったことにして通り過ぎた。#origin_gear# の沈黙が、いつまでも追ってくる。",
    "今は、向き合えない。#origin_name# の未練を、深みに置き去りにした。",
  ],
  myth: [
    "偉大な#origin_name# を、あえて起こさずに去る。応えなかった背中は、なぜか重い。",
    "#origin_gear# の光を背に受けて進む。約束を欠いたことを、いつか悔いる気がした。",
    "今は受け取れない。#origin_name# の遺志は、まだ底で待ち続けるだろう。",
  ],
  grudge: [
    "#origin_name# の怨みに背を向けた。錆びた#origin_gear# が、確かにこちらの名を刻んだ。",
    "応えずに去る。だが#origin_name# は——必ず、もう一度お前の前に立つだろう。",
    "憎しみを放置した。深みへ下りるほど、その気配が濃く付きまとってくる。",
  ],
};

// 継承：力・遺志を継ぐ＝未完の目的を負う（4-11E 武器奪還／4-12B）。
const INHERIT_LINES: VerbLines = {
  loss: [
    "#origin_name# の#origin_gear# を受け取った。果たせなかった願いごと、引き受けると決めた。",
    "形見を抱く。#origin_name# が遺した宿題が、今日からお前のものだ。",
  ],
  myth: [
    "#origin_name# の#origin_gear# を継ぐ。その偉業の続きを、お前が書くことになる。",
    "遺志を受け取った。#origin_name# が果たせなかった一歩を、お前が踏み出す番だ。",
  ],
  grudge: [
    "#origin_name# の#origin_gear# を奪い返すように握った。その怨みごと、背負う覚悟だ。",
    "憎しみの遺物を継ぐ。#origin_name# が誰を追っていたか、いずれ突き止めねばならない。",
  ],
};

function pickLine(pool: VerbLines, fossil: Fossil, rng: Rng): string {
  return fillSlots(rng.pick(pool[fossil.tonePole]), originSlotValues(fossil));
}
/** 鎮魂の締め（tone別・反復回避）。 */
export const requiemLine = (fossil: Fossil, rng: Rng): string => pickLine(REQUIEM_LINES, fossil, rng);
/** 立ち去るの締め（tone別・放置の不穏さ）。 */
export const leaveLine = (fossil: Fossil, rng: Rng): string => pickLine(LEAVE_LINES, fossil, rng);
/** 継承の締め（tone別・未完の目的を負う）。 */
export const inheritLine = (fossil: Fossil, rng: Rng): string => pickLine(INHERIT_LINES, fossil, rng);

/** 噂（街で聞く又聞き。痕跡スロットを差し込む） */
export function renderRumor(db: ContentDb, rng: Rng, fossil: Fossil): string {
  const pool = filterByTags(db, "rumor", {});
  const origin = originSlotValues(fossil);
  const usable = pool.filter((f) => slotsOf(f.text).every((s) => origin[s] !== undefined));
  const frame = rng.pick(usable.length > 0 ? usable : pool);
  return fillSlots(frame.text, origin);
}

/** 運命の弧の伝聞（4-6C：酒場で聞く弧の現在段。化石を要さず tracked 自身にアンカー）。
 *  arc×beat の断片を優先し、無ければ arc のみ→全体→固定文へ縮退（決して throw しない）。
 *  fossil 非依存ゆえ seeded（「銀の三人」＝originRef 無し）にも使える＝最重要要件。 */
export function renderArcBeat(db: ContentDb, rng: Rng, t: TrackedEntity): string {
  let pool = filterByTags(db, "arc_beat", { arc: t.arcType, beat: t.beat });
  if (pool.length === 0) pool = filterByTags(db, "arc_beat", { arc: t.arcType });
  if (pool.length === 0) pool = filterByTags(db, "arc_beat", {});
  if (pool.length === 0) return `「${t.name}の名は、近頃とんと噂に上らないな」`;
  return fillSlots(rng.pick(pool).text, { tracked_name: t.name });
}

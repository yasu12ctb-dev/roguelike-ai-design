// 世界の生成・化石化・干渉・年代記・永続化（prototype-spec.md §2 / §5）

import type {
  Character, ChronicleEntry, DeathManner, FinalAct, Fossil, Lineage, World,
} from "./types.ts";
import { resolveTonePole } from "./variation.ts";
import { BASE_STATS } from "./progression.ts";

let idCounter = 0;
const newId = (prefix: string) => `${prefix}_${(++idCounter).toString(36)}`;

/** セーブ版数（v2=②ステ／v3=③ spells／v4=④ equipment／v6=歩ける街シーン。横断D）。 */
export const SAVE_VERSION = 6;

/** 旧セーブを現行スキーマへ補完（破壊しない）。
 *  欠落フィールドは版数に関わらず常に補う（版数判定だけに頼ると、追加フィールドの
 *  取りこぼしが起きる＝v2セーブに spells が無くフリーズした不具合の再発防止）。 */
export function migrateWorld(w: World): World {
  if (w.current) {
    const ch = w.current as Partial<Character> & Character;
    if (!ch.stats) ch.stats = { ...BASE_STATS };
    if (typeof ch.level !== "number") ch.level = 1;
    if (typeof ch.xp !== "number") ch.xp = 0;
    if (!Array.isArray(ch.spells)) ch.spells = [];
    if (!ch.equipment) ch.equipment = { weapon: null, armor: null, relic: null };
  }
  if (!Array.isArray(w.actors)) w.actors = []; // 生者NPC（4-12(G)）：欠落は常に補完
  if (!Array.isArray(w.flags)) w.flags = [];
  if (w.town) { // 歩ける街（4-4B）：旧セーブに欠落するサブシーン状態を補完
    if (w.town.scene !== "town" && w.town.scene !== "interior") w.town.scene = "town";
    if (w.town.interiorKind === undefined) w.town.interiorKind = null;
    // w.town.pos は未設定のまま＝描画側で town.json の start を既定にする
  }
  w.version = SAVE_VERSION;
  return w;
}

/** 初期史のシード（snapshot 4-1D：薄く仕込む） */
export function newWorld(seed: number): World {
  const world: World = {
    seed,
    version: SAVE_VERSION,
    generation: 1,
    current: null,
    fossils: [],
    tracked: [],
    chronicle: [],
    town: { witnessNpcId: "witness_yen", safety: 3, memorials: [], scene: "town", interiorKind: null },
    flags: [],
    actors: [],
  };
  // シード化石①：老兵の亡骸（喪失・浅層）
  world.fossils.push({
    id: newId("fossil"),
    kind: "explorer",
    origin: { name: "老兵ガルム", archetype: "veteran", gearTags: ["割れた円盾"], epithet: "城壁" },
    death: { manner: "peaceful", finalAct: { choice: "accept" }, depth: 6, generationCreated: 0 },
    exposureAtDeath: 0.2, bondAtDeath: 0, tonePole: "loss",
    interventions: [], lastTouchedGeneration: 0, laidDepth: 6,
  });
  // シード化石②：非業の探索者（怨念・中層）— 初回から「歪んだ過去」に出会わせる
  world.fossils.push({
    id: newId("fossil"),
    kind: "explorer",
    origin: { name: "踏破者レン", archetype: "delver", gearTags: ["錆びた長剣"], catchphrase: "……まだ、足りない" },
    death: { manner: "grievous", finalAct: { choice: "curse_dungeon" }, depth: 18, generationCreated: 0 },
    exposureAtDeath: 1.5, bondAtDeath: 0, tonePole: "grudge",
    interventions: [], lastTouchedGeneration: 0, laidDepth: 18,
  });
  // シード追跡対象：有名パーティー（運命の弧の最小形）
  world.tracked.push({
    id: newId("tracked"), name: "銀の三人", source: "seeded",
    arcType: "doom", beat: 0, lastObservedGeneration: 1,
  });
  chronicle(world, "legend", "迷宮が現れて久しい。街は今日も、潜る者たちの上前で栄えている。", []);
  return world;
}

export function createCharacter(world: World, name: string, archetype: string, lineage: Lineage): Character {
  const ch: Character = {
    id: newId("ch"), name, archetype, lineage,
    traits: [], exposure: 0, depth: 0, bonds: [], alive: true,
    stats: { ...BASE_STATS }, level: 1, xp: 0, spells: [],
    equipment: { weapon: null, armor: null, relic: null },
  };
  // 系譜（4-10D）：先代から因縁と薄い形質を継ぐ
  if (lineage.relation !== "none" && lineage.ancestorFossilId) {
    const anc = world.fossils.find((f) => f.id === lineage.ancestorFossilId);
    if (anc) {
      ch.bonds.push({ entityRef: anc.id, value: 2, unfinished: true }); // 先代の未完を継ぐ
      if (lineage.relation === "blood") ch.traits.push(`${anc.origin.name}の血`);
      if (lineage.relation === "pupil") ch.traits.push(`${anc.origin.name}の教え`);
    }
  }
  world.current = ch;
  chronicle(world, "birth", `${ch.name}（第${world.generation}世代）、迷宮へ降りた。`, [ch.id]);
  return ch;
}

/** 死→化石化→世代交代（§5 ステップ5-7） */
export function fossilizeCurrent(world: World, manner: DeathManner, finalAct: FinalAct): Fossil {
  const ch = world.current;
  if (!ch || !ch.alive) throw new Error("no living character");
  ch.alive = false;
  const bondTotal = ch.bonds.reduce((a, b) => a + b.value, 0);
  const fossil: Fossil = {
    id: newId("fossil"),
    kind: "character",
    origin: {
      name: ch.name, archetype: ch.archetype,
      // 死亡時に握っていた武器を刻む（4-11E：「○○を握った亡霊」。継承で奪還できる痕跡素材）。
      gearTags: [ch.equipment?.weapon?.name ?? defaultGearFor(ch.archetype)],
      catchphrase: finalAct.note,
    },
    death: { manner, finalAct, depth: ch.depth, generationCreated: world.generation },
    exposureAtDeath: ch.exposure,
    bondAtDeath: Math.min(5, 1 + bondTotal), // 自キャラはプレイヤー関与が最大
    tonePole: resolveTonePole(finalAct.choice, manner, bondTotal),
    interventions: [],
    lastTouchedGeneration: world.generation,
    laidDepth: ch.depth,
  };
  world.fossils.push(fossil);
  chronicle(world, "death",
    `${ch.name}、深度${ch.depth}で斃れる。（${finalActLabel(finalAct.choice)} → ${poleLabel(fossil.tonePole)}へ）`,
    [fossil.id]);
  world.generation += 1;
  world.current = null;
  return fossil;
}

/** 干渉（鎮魂/継承/供養）：変質クロックをリセットし、因縁を閉じる（4-1C / 4-2） */
export function intervene(world: World, fossilId: string, type: "requiem" | "inherit" | "memorial"): void {
  const fossil = world.fossils.find((f) => f.id === fossilId);
  if (!fossil) throw new Error("fossil not found");
  fossil.interventions.push({ type, generation: world.generation });
  fossil.lastTouchedGeneration = world.generation; // 時計のリセット
  // 継承＝未完の目的を負う／鎮魂・供養＝因縁を閉じる（4-12B）
  const opensObligation = type === "inherit";
  const ch = world.current;
  if (ch) {
    const bond = ch.bonds.find((b) => b.entityRef === fossilId);
    if (bond) bond.unfinished = opensObligation;
    else ch.bonds.push({ entityRef: fossilId, value: 1, unfinished: opensObligation });
  }
  const label = type === "requiem" ? "鎮魂した" : type === "inherit" ? "遺志を継いだ" : "供養した";
  const bondNote = opensObligation ? "（未完の目的を負った）" : "（因縁を閉じた）";
  chronicle(world, "intervention",
    `${world.current?.name ?? "誰か"}が${fossilOriginName(world, fossilId)}を${label}。${bondNote}`,
    [fossilId]);
}

export function recordRediscovery(world: World, fossilId: string): void {
  chronicle(world, "rediscovery",
    `${world.current?.name ?? "誰か"}が、${fossilOriginName(world, fossilId)}の成れの果てと出会った。`,
    [fossilId]);
  const ch = world.current;
  if (ch) {
    const bond = ch.bonds.find((b) => b.entityRef === fossilId);
    if (bond) bond.value += 1;
    else ch.bonds.push({ entityRef: fossilId, value: 1, unfinished: false });
  }
}

export function chronicle(world: World, kind: ChronicleEntry["kind"], text: string, refs: string[]): void {
  world.chronicle.push({ generation: world.generation, kind, text, refs });
}

// ---- 表示用ヘルパ ----
export function poleLabel(p: Fossil["tonePole"]): string {
  return p === "loss" ? "喪失" : p === "myth" ? "神話" : "怨念";
}
export function finalActLabel(c: FinalAct["choice"]): string {
  switch (c) {
    case "guard_relic": return "遺品を抱いて守った";
    case "curse_dungeon": return "迷宮を呪った";
    case "leave_will": return "遺言を遺した";
    case "accept": return "静かに受け入れた";
  }
}
function fossilOriginName(world: World, id: string): string {
  return world.fossils.find((f) => f.id === id)?.origin.name ?? "名も無き者";
}
function defaultGearFor(archetype: string): string {
  switch (archetype) {
    case "swordman": return "片刃の剣";
    case "scout": return "革張りの短弓";
    case "sage": return "綴じ紐の手帳";
    default: return "使い込まれた背嚢";
  }
}

// 世界の生成・化石化・干渉・年代記・永続化（prototype-spec.md §2 / §5）

import type {
  Actor, ArcEffect, ArcState, Character, ChronicleEntry, Companion, DeathManner, EchoAsh, FinalAct, Fossil, Lineage, SealKey, TrackedEntity, World,
} from "./types.ts";
import { SEAL_KEYS, SEAL_LABEL } from "./types.ts";
import { resolveTonePole } from "./variation.ts";
import { BASE_STATS, STASH_INHERIT, LOADOUT_CAP } from "./progression.ts";

let idCounter = 0;
const newId = (prefix: string) => `${prefix}_${(++idCounter).toString(36)}`;

/** セーブ版数（v2=②ステ／v3=③ spells／v4=④ equipment／v6=歩ける街シーン／v7=金貨／v8=依頼／v9=同行。横断D）。 */
export const SAVE_VERSION = 9;

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
    if (!Array.isArray(ch.loadout)) ch.loadout = ch.spells.slice(0, LOADOUT_CAP); // 構え（4-11F③）：旧セーブは習得順の先頭から補完
    else ch.loadout = ch.loadout.filter((k) => ch.spells.includes(k)).slice(0, LOADOUT_CAP); // 整合（未習得/超過を除去）
    if (!ch.equipment) ch.equipment = { weapon: null, armor: null, relic: null };
    if (typeof ch.gold !== "number") ch.gold = 0; // v7：金貨
    if (!Array.isArray(ch.gearBag)) ch.gearBag = []; // 持ち物 Phase4：拾った装備の袋（非破壊バックフィル）
  }
  if (!Array.isArray(w.actors)) w.actors = []; // 生者NPC（4-12(G)）：欠落は常に補完
  if (w.companion && typeof (w.companion as Partial<Companion>).grade !== "number") {
    (w.companion as Companion).grade = w.companion.actor?.grade ?? 0; // 4-4E：旧セーブの相棒に等級を補完（設定→なければアイアン）
  }
  if (w.companion && typeof (w.companion as Partial<Companion>).feats !== "number") {
    (w.companion as Companion).feats = 0; // 4-4E：偉業カウンタを補完（昇格の偉業ゲート）
  }
  if (!Array.isArray(w.flags)) w.flags = [];
  if (!Array.isArray(w.quests)) w.quests = []; // v8：依頼（回収業 4-10G）
  if (!Array.isArray(w.stash)) w.stash = [];       // 自宅の保管庫・消耗品（持ち物 Phase3）：欠落は空で補完
  if (!Array.isArray(w.stashGear)) w.stashGear = []; // 自宅の保管庫・装備：欠落は空で補完
  if (!Array.isArray(w.arcs)) w.arcs = [];         // 長尺アーク（4-12(I)）：欠落は空で補完
  if (!Array.isArray(w.tracked)) w.tracked = [];   // 追跡対象（4-6）：欠落は空で補完
  for (const t of w.tracked) {                     // 運命の弧の進行フィールド（M3 第一スライス）：欠落は0/未到達で補完
    if (typeof t.beat !== "number") t.beat = 0;
    if (typeof t.lastObservedGeneration !== "number") t.lastObservedGeneration = w.generation ?? 1;
    if (typeof t.drift !== "number") t.drift = 0;
  }
  if (typeof w.raidCooldown !== "number") w.raidCooldown = 0; // 街襲撃の冷却：欠落は0で補完
  if (typeof w.memorialCooldown !== "number") w.memorialCooldown = 0; // 追悼の日の冷却：欠落は0で補完
  if (typeof w.plagueCooldown !== "number") w.plagueCooldown = 0; // 疫病の冷却：欠落は0で補完
  if (typeof w.diveCount !== "number") w.diveCount = 0; // 潜行回数（再潜行farm防止のseed nonce）：欠落は0で補完
  if (!Array.isArray(w.echoes)) w.echoes = []; // 残響召喚の遺灰（4-10I）：欠落は空で補完
  if (!Array.isArray(w.seals)) w.seals = [];       // 奉献の試練・集めた印（4-13A）：欠落は空で補完
  if (typeof w.ascended !== "number") w.ascended = 0; // 奉献の試練・クリア回数（4-13D）
  if (!Array.isArray(w.bestiary)) w.bestiary = []; // 敵図鑑（遭遇種）：欠落は空で補完
  if (w.town) { // 歩ける街（4-4B）：旧セーブに欠落するサブシーン状態を補完
    if (!Array.isArray(w.town.memorials)) w.town.memorials = []; // 慰霊碑（4-6C）：供養した先人の名。欠落は空で補完
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
    quests: [],
    stash: [],
    stashGear: [],
    seals: [],
    ascended: 0,
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
    stats: { ...BASE_STATS }, level: 1, xp: 0, spells: [], loadout: [],
    equipment: { weapon: null, armor: null, relic: null, bag: null },
    gold: 0,
    inventory: [],
    gearBag: [],
  };
  // 系譜（4-10D）：先代から因縁と薄い形質を継ぐ
  if (lineage.relation !== "none" && lineage.ancestorFossilId) {
    const anc = world.fossils.find((f) => f.id === lineage.ancestorFossilId);
    if (anc) {
      ch.bonds.push({ entityRef: anc.id, value: 2, unfinished: true }); // 先代の未完を継ぐ
      if (lineage.relation === "blood") ch.traits.push(`${anc.origin.name}の血`);
      if (lineage.relation === "pupil") ch.traits.push(`${anc.origin.name}の教え`);
      // 先代の術の一部が初期値に滲む（4-11F②）。弟子は教えを多く継ぎ（3）、血筋は少し（2）。構えにも自動装填。
      const inheritN = lineage.relation === "pupil" ? 3 : 2;
      for (const key of (anc.spells ?? []).slice(0, inheritN)) {
        if (!ch.spells.includes(key)) { ch.spells.push(key); if (ch.loadout!.length < LOADOUT_CAP) ch.loadout!.push(key); }
      }
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
    spells: [...ch.spells], // 系譜継承（4-11F②）：覚えていた術を化石に遺す＝次代の血/弟子に滲む
  };
  world.fossils.push(fossil);
  chronicle(world, "death",
    `${ch.name}、深度${ch.depth}で斃れる。（${finalActLabel(finalAct.choice)} → ${poleLabel(fossil.tonePole)}へ）`,
    [fossil.id]);
  world.generation += 1;
  world.current = null;
  // 自宅の保管庫は世代を越えて残るが、遺せるのは消耗品・装備それぞれ STASH_INHERIT 枠まで（残りは歳月とともに失われる）。
  if (Array.isArray(world.stash) && world.stash.length > STASH_INHERIT) world.stash = world.stash.slice(0, STASH_INHERIT);
  if (Array.isArray(world.stashGear) && world.stashGear.length > STASH_INHERIT) world.stashGear = world.stashGear.slice(0, STASH_INHERIT);
  // 運命の弧（4-6）：世代がひとつビートを刻む＝目を離した隙に tracked の弧が進む。
  advanceArcs(world);
  return fossil;
}

/** 相棒の化石化（4-14C）：戦死した相棒を、その絆を刻んだ化石として世界に遺す。
 *  プレイヤー死とは別経路＝世代は進めず world.current も触らない。後世で亡霊/宿敵/伝説として再会する。 */
export function fossilizeCompanion(
  world: World, actor: Actor, opts: { depth: number; exposure: number; bond: number },
): Fossil {
  const manner: DeathManner = "grievous";
  const finalAct: FinalAct = { choice: "accept" };
  const fossil: Fossil = {
    id: newId("fossil"),
    kind: "character",
    origin: {
      name: actor.name, archetype: actor.archetype,
      gearTags: actor.gearTags.length ? actor.gearTags : [defaultGearFor(actor.archetype)],
      catchphrase: actor.catchphrase,
    },
    death: { manner, finalAct, depth: opts.depth, generationCreated: world.generation },
    exposureAtDeath: opts.exposure,
    bondAtDeath: Math.min(5, 1 + opts.bond), // 連れ歩いた相棒＝高関与
    tonePole: resolveTonePole(finalAct.choice, manner, opts.bond),
    interventions: [],
    lastTouchedGeneration: world.generation,
    laidDepth: opts.depth,
    wasCompanion: true,
  };
  world.fossils.push(fossil);
  chronicle(world, "death",
    `相棒 ${actor.name}、深度${opts.depth}で斃れる。その亡骸に、共に歩いた日々が刻まれた。`,
    [fossil.id]);
  return fossil;
}

/** 見捨て＝怨念を執筆（4-14C・B 救助の裏）：手負いを見殺しにすると、その冒険者は
 *  怨念極（grudge）の化石として遺り、後世で grudge_hunt の宿敵として確実に還る（「宿敵を自分で書く」）。
 *  manner=betrayed / curse_dungeon で tonePole は grudge 固定。bondAtDeath=3 で山場条件（minBond3）を満たす。 */
export function fossilizeAbandoned(
  world: World, actor: Actor, opts: { depth: number },
): Fossil {
  const manner: DeathManner = "betrayed";
  const finalAct: FinalAct = { choice: "curse_dungeon" };
  const fossil: Fossil = {
    id: newId("fossil"),
    kind: "character",
    origin: {
      name: actor.name, archetype: actor.archetype,
      gearTags: actor.gearTags.length ? actor.gearTags : [defaultGearFor(actor.archetype)],
      catchphrase: actor.catchphrase,
    },
    death: { manner, finalAct, depth: opts.depth, generationCreated: world.generation },
    exposureAtDeath: 1.4,                                  // 見捨てられた末の深蝕＝怨念へ
    bondAtDeath: 3,                                        // 裏切りの因縁＝山場（宿敵狩り）を確実に呼ぶ
    tonePole: resolveTonePole(finalAct.choice, manner, 0), // → grudge
    interventions: [],
    lastTouchedGeneration: world.generation,
    laidDepth: opts.depth,
    wasCompanion: true,
  };
  world.fossils.push(fossil);
  // 堕ちゆく弧（4-6D・fall の源）：見捨てられた相棒は、世代を越えて「堕ちていく」弧を辿る
  // ＝栄光の影→孤立→成れの果て、を又聞き（年代記/酒場の噂）で拾わせ、終端で宿敵として深みに巣食う。
  // 既存の grudge 化石を originRef に結ぶ＝終端で別途 mint しない（fossilizeTracked は originRef 有りで skip・
  // grudge_hunt にそのまま合流）。advanceArcs が世代交代ごとに fall ビートを1段刻む（1世代1ビート）。
  (world.tracked ??= []).push({
    id: `nemesis_${fossil.id}`, name: actor.name, source: "nemesis",
    arcType: "fall", beat: 0, lastObservedGeneration: world.generation, originRef: fossil.id,
  });
  chronicle(world, "death",
    `${actor.name}を深度${opts.depth}に見捨てた。その怨みは、いつか宿敵となって還るだろう。`,
    [fossil.id]);
  return fossil;
}

// ---------- 長尺アーク（4-12(I)：進行度クオリティで多段の弧を組む。世界スコープ） ----------
/** 進行中（未完）の弧を引く。done 済みや未開始は undefined 扱い。 */
export function getArc(world: World, key: string): ArcState | undefined {
  const a = (world.arcs ?? []).find((x) => x.key === key);
  return a && !a.done ? a : undefined;
}
/** 弧を開始/前進/分岐記録/完了する（Effect.arc から呼ぶ）。pick は上書きせず引き継ぐ。 */
export function setArc(world: World, e: ArcEffect): void {
  (world.arcs ??= []);
  const a = world.arcs.find((x) => x.key === e.key);
  if (a) {
    a.step = e.step;
    if (e.pick !== undefined) a.pick = e.pick;
    if (e.actorRef !== undefined) a.actorRef = e.actorRef; // 特定NPCに戻る弧のアンカー
    if (e.done) a.done = true;
  } else world.arcs.push({ key: e.key, step: e.step, pick: e.pick, actorRef: e.actorRef, done: e.done });
}

// ---------- 運命の弧（4-6B：tracked が世代をビートに辿る原型的軌道。M3 第一スライス） ----------
/** 弧の段数（一律3段＝終端）。後で arcType ごとに変えられる。 */
export const ARC_MAX_BEAT = 3;
/** 法則順守（4-2）：drift がこの値に達した tracked は、終端で破滅側へ歪んだ末路をたどる。 */
const ARC_DRIFT_WARP = 2;

/** 弧の段ごとの年代記行（伝聞＝又聞きで「目を離した隙に世界が動いた」を必ず拾わせる）。
 *  beat 1..3。warped は終端(beat3)の歪み分岐のみ差し替える。#name# に tracked.name を差す。 */
const ARC_BEAT_LINE: Record<TrackedEntity["arcType"], { normal: string[]; warped: string }> = {
  doom: {
    normal: [
      "#name#が、また深みへ降りていったらしい。何かに憑かれたように。",
      "#name#の様子がおかしいと、戻った者が囁く。あの目は、もう人のものじゃない。",
      "#name#は、ついに還らなかった。深みが、英雄をひとつ呑んだのだ。",
    ],
    warped: "#name#は、ついに還らなかった。深みが、英雄をひとつ呑んだのだ。",
  },
  retire: {
    normal: [
      "#name#が一線を退くそうだ。潮時を心得た、いい引き際だと皆が言う。",
      "#name#が街の後進を導いていると聞く。剣を置いた手が、今は若い者の肩にある。",
      "#name#の名は、もう伝説として語られる。生きてその声を聞ける者は、幸運だ。",
    ],
    warped: "#name#は引退できなかった。深みの誘いに抗えず、その姿は二度と街に戻らなかった。",
  },
  fall: {
    normal: [
      "#name#の名声は今が絶頂だ。だが、その慢心を危ぶむ声もある。",
      "#name#が仲間を失い、独りで深層に挑んでいるという。もう誰も止められない。",
      "#name#は変わり果てた。かつての英雄は今や、出会う者を災いと見なすらしい。",
    ],
    warped: "#name#は墜ちるのも早かった。怨嗟だけを残し、宿敵として深みに巣食っている。",
  },
  lore_drift: {
    normal: [
      "#name#の武勇伝、語る者によって少しずつ食い違ってきたな。",
      "#name#の逸話に、別の誰かの手柄が混じり始めている。もう誰も正せない。",
      "#name#という名は、もはや誰のものとも知れぬ。伝説だけが、独り歩きしている。",
    ],
    warped: "#name#の物語は完全に変質した。原型は失われ、別人の伝説とすり替わってしまった。",
  },
};

/** 弧を世代分だけ前進させる（fossilizeCurrent から世代交代のたびに呼ぶ）。
 *  「進んだことになる」を実際に beat へ反映し、節目で年代記に伝聞を1行刻む（lazy の解決＝観測点）。
 *  純ロジック（content/render 非依存）：豊かな酒場フレーバは render.ts renderArcBeat 側が担う。 */
export function advanceArcs(world: World): void {
  for (const t of world.tracked) {
    if (t.terminal) continue;                              // 終端済みは動かない
    if (world.generation <= t.lastObservedGeneration) continue; // この世代は反映済み（防御的）
    const gens = world.generation - t.lastObservedGeneration;   // 経過世代（通常1）
    t.lastObservedGeneration = world.generation;
    // 4-1 主クロック：放置（時間×深度）の連続積分で warp を進める（深いほど速い＝理が緩い）。
    if (t.originRef) {
      const f = world.fossils.find((x) => x.id === t.originRef);
      if (f) t.drift = Math.max(0, (t.drift ?? 0) + warpRate(f.laidDepth) * gens);
    }
    t.beat = Math.min(ARC_MAX_BEAT, (t.beat ?? 0) + 1);    // 1世代1ビート
    const table = ARC_BEAT_LINE[t.arcType];
    const warped = (t.drift ?? 0) >= ARC_DRIFT_WARP;
    let line: string;
    if (t.beat >= ARC_MAX_BEAT) {                          // 終端＝帰結を1度だけ刻む
      t.terminal = true;
      if (warped) t.pick = "warped";
      line = warped ? table.warped : table.normal[ARC_MAX_BEAT - 1];
      if (t.arcType === "doom") fossilizeTracked(world, t); // 成れの果ての化石を遺す（深層で再会＝噂で聞いた英雄との落差・4-6D）
    } else {
      line = table.normal[t.beat - 1] ?? table.normal[table.normal.length - 1];
    }
    const refs = t.originRef ? [t.id, t.originRef] : [t.id];
    chronicle(world, t.terminal ? "legend" : "rumor", line.replace(/#name#/g, t.name), refs);
  }
}

/** doom 終端の実体化（4-6D：破滅の弧の終端で「成れの果て」の化石が遺る＝既存パイプライン合流）。
 *  originRef を持たない tracked（seeded＝化石なし）に、深層で再会できる怨念極の化石を mint し逆参照を結ぶ。
 *  噂で「英雄」と聞いた相手を、迷宮で歪んだ化石として再発見する落差を生む（既存 rollEncounter / fossilScene に合流）。 */
function fossilizeTracked(world: World, t: TrackedEntity): void {
  if (t.originRef) return; // 既に化石を持つ（player_legend 等）＝二重生成しない
  const depth = ARC_DRIFT_DEPTH; // 深層（18）に眠る＝深く潜った者だけが「成れの果て」に出会う
  const fossil: Fossil = {
    id: newId("fossil"),
    kind: "explorer",
    origin: {
      name: t.name, archetype: "wanderer",
      gearTags: ["錆びついた誓いの徽章"],
      catchphrase: "……まだ、戻れない",
    },
    death: { manner: "grievous", finalAct: { choice: "curse_dungeon" }, depth, generationCreated: world.generation },
    exposureAtDeath: 1.6, bondAtDeath: 0, tonePole: "grudge",
    interventions: [], lastTouchedGeneration: world.generation, laidDepth: depth,
  };
  world.fossils.push(fossil);
  t.originRef = fossil.id;
}

/** 4-1 変質の時間軸＝「歪み = 深度 × 時間」の連続積分。
 *  ・主クロック（放置）＝世代交代ごとに warpRate(laidDepth)×経過世代 を累積（深いほど速い＝理が緩い）。
 *  ・関与の微加（ハイブリッド）＝深層の原型との再会で warp を僅かに進める。
 *  ・干渉（鎮魂/継承/供養）＝時計を巻き戻す＝warp を減算（4-1C「放置こそ変質を進め、干渉で止まる」）。
 *  warp（＝`drift` フィールド・連続値）が閾値に達すると終端が破滅側（warped）へ寄る。 */
const ARC_DRIFT_DEPTH = 18;        // 成れの果ての化石を眠らせる深度（fossilizeTracked 用）
const WARP_DEPTH_MIN = 12;         // これより浅い laidDepth は理が固く、放置でも歪まない
const WARP_RATE_DIV = 24;          // 深度→「世代あたり warp 速度」の除数（深いほど速い）
const WARP_RATE_CAP = 1.25;        // 世代あたり warp 速度の上限
const WARP_ENGAGE = 0.5;           // 非-干渉の再会で warp を微加（ハイブリッド：関与も深みを掻き乱す）
const WARP_INTERVENE_HEAL = 1.0;   // 干渉（鎮魂/継承/供養）で巻き戻す warp 量（4-1C）
/** 放置の連続積分レート（世代あたり）＝深いほど速い。WARP_DEPTH_MIN 以浅は 0。 */
function warpRate(depth: number): number {
  return Math.max(0, Math.min(WARP_RATE_CAP, (depth - WARP_DEPTH_MIN) / WARP_RATE_DIV));
}
/** 深層(laidDepth>=WARP_DEPTH_MIN)の原型化石を originRef に持つ未終端 tracked の warp を amount だけ動かす（0で床）。
 *  関与＝正（再会で微加）／干渉＝負（巻き戻し）。seeded は originRef を持たず影響を受けない。 */
export function accrueArcWarp(world: World, fossilId: string, amount: number): void {
  const fossil = world.fossils.find((f) => f.id === fossilId);
  if (!fossil || fossil.laidDepth < WARP_DEPTH_MIN) return;
  for (const t of world.tracked) {
    if (t.originRef === fossilId && !t.terminal) t.drift = Math.max(0, (t.drift ?? 0) + amount);
  }
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
  // 奉献の試練・印②：因縁（怨念極の化石）を鎮魂（4-13A）。鎮魂の全経路（慰霊堂/戦闘/遭遇）を捕捉。
  if (type === "requiem" && fossil.tonePole === "grudge") awardSeal(world, "requiem", [fossilId]);
  accrueArcWarp(world, fossilId, -WARP_INTERVENE_HEAL); // 4-1C：干渉＝時計を巻き戻す＝warp を減算（弧を守る）
}

// ---------- 残響召喚の遺灰（4-10I・snapshot 524：鎮魂＝種／Elden Ring 遺灰型） ----------

/** 残響の遺灰を展開するときの代償＝深蝕＋（乱用を抑える＝snapshot「稀・代償つき」）。 */
export const ECHO_DEPLOY_COST = 0.3;

/** 鎮魂による残響召喚の種付与（4-10I）。**必ず intervene(world, fossil.id, "requiem") の後に呼ぶ**
 *  （requiem が interventions に push 済み＝初回なら requiem は1件）。
 *  神話極の化石の初回鎮魂のみ「残響の遺灰」を1つ得る（farm 防止＝1化石1遺灰・世代越え再鎮魂で増えない）。
 *  威力は鎮魂時の深度をスナップショット。条件を満たさなければ何もせず null。 */
export function grantEchoOnRequiem(world: World, fossil: Fossil, depth: number): EchoAsh | null {
  const firstRequiem = fossil.interventions.filter((iv) => iv.type === "requiem").length === 1;
  if (fossil.tonePole !== "myth" || !firstRequiem) return null;
  const echoDmg = Math.max(5, Math.round(4 + depth * 0.7));
  const ash: EchoAsh = { fossilId: fossil.id, name: fossil.origin.name, dmg: echoDmg };
  (world.echoes ??= []).push(ash);
  return ash;
}

/** 残響の遺灰を1つ消費（4-10I）。index の遺灰を取り出し、展開の代償（深蝕＋ECHO_DEPLOY_COST）を ch に適用して返す。
 *  範囲外/空なら null（副作用なし）。盤面への召喚展開・音・手番消費は呼び出し側（web/main.ts deployEcho）が担う。 */
export function consumeEcho(world: World, ch: Character, index: number): EchoAsh | null {
  const echoes = world.echoes ?? [];
  if (index < 0 || index >= echoes.length) return null;
  const [ash] = echoes.splice(index, 1);
  ch.exposure += ECHO_DEPLOY_COST;
  return ash;
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
  accrueArcWarp(world, fossilId, WARP_ENGAGE); // ハイブリッド：深層の原型との再会も warp を微かに進める（4-6 法則順守）
}

export function chronicle(world: World, kind: ChronicleEntry["kind"], text: string, refs: string[]): void {
  world.chronicle.push({ generation: world.generation, kind, text, refs });
}

// ---- 奉献の試練：印（4-13A） ----
/** 印を1つ授与（冪等：既に持つ印は何もしない）。新規に得た時だけ true＋年代記に刻む。 */
export function awardSeal(world: World, key: SealKey, refs: string[] = []): boolean {
  if (!Array.isArray(world.seals)) world.seals = [];
  if (world.seals.includes(key)) return false;
  world.seals.push(key);
  const got = world.seals.length;
  chronicle(world, "legend",
    `${world.current?.name ?? "誰か"}が「${SEAL_LABEL[key]}」の印を得た。（奉献の試練 ${got}/${SEAL_KEYS.length}）`,
    refs);
  if (got === SEAL_KEYS.length) {
    chronicle(world, "legend",
      "五つの印が揃った。封じられた深淵帯への道が、街の門の奥に口を開ける。", []);
  }
  return true;
}
/** 印が5種揃い、深淵帯が解錠されているか。 */
export function abyssUnlocked(world: World): boolean {
  return (world.seals?.length ?? 0) >= SEAL_KEYS.length;
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

// 依頼（回収業 4-10G／4-12F quest）の純粋ロジック。ブラウザセーフ（DOM/fs 不使用）。
// 受注＝world.quests に積む／達成判定＝ダンジョン側フックから呼ぶ／報酬＝街で claim。

import type { World, Character, Quest } from "./types.ts";
import type { Rng } from "./rng.ts";
import { ABYSS_DEPTH } from "./progression.ts";

let qn = 0;
const qid = (): string => `q_${(++qn).toString(36)}`;

// 依頼テキストのデータ駆動化（2026-07-02）：content/quests.json の型別テンプレをスロット埋めで採用。
// web から opts.templates 経由で渡す（quests.ts は fs 非依存＝ブラウザセーフ維持）。未指定＝内蔵の既定文。
export interface QuestTemplate { title: string; desc: string; }
export type QuestTemplates = Record<string, QuestTemplate[]>;
// bounty 用の軽量モンスター記述子（dungeon.ts と疎結合＝web が MONSTER_KINDS から詰めて渡す）。
export interface MonsterLite { key: string; name: string; tier: number; minDepth: number; maxDepth?: number; }
export interface OfferOpts {
  source?: "guild" | "tavern"; templates?: QuestTemplates; monsters?: MonsterLite[];
  escortClient?: { name: string }; // 護衛依頼の依頼人（web が mintActor で用意。相棒雇用中は渡さない）
}

const ITEM_LABELS: Record<string, string> = { weapon: "武具（武器）", armor: "武具（防具）", relic: "遺物", bag: "鞄" };

function fillQuest(tmpl: QuestTemplate | undefined, fallback: QuestTemplate, slots: Record<string, string | number>): QuestTemplate {
  const src = tmpl ?? fallback;
  const sub = (s: string) => s.replace(/#(\w+)#/g, (_, k) => String(slots[k] ?? `#${k}#`));
  return { title: sub(src.title), desc: sub(src.desc) };
}
function pickTmpl(templates: QuestTemplates | undefined, kind: string, rng: Rng): QuestTemplate | undefined {
  const pool = templates?.[kind];
  return pool && pool.length ? rng.pick(pool) : undefined;
}

/** クエストID採番カウンタを、セーブ内の既存 `q_N` の最大値まで進める（migrateWorld から呼ぶ）。
 *  ★化石 id（newId）と同じ再読込衝突を防ぐ：qn はプロセスグローバルゆえ再読込で0に戻り、
 *  以後 qid() が生む `q_1..` が、セーブに残る現世代の受注中クエストと id 衝突する。
 *  すると claimQuest の `filter(x => x.id !== questId)` が同 id を巻き添え削除し、
 *  もう一方のクエストが報酬なしで消える／find が誤ったクエストの報酬を払う。
 *  ロード時に未使用 id を保証して衝突を根治（単一プロセスの新規生成では no-op）。 */
export function syncQuestCounter(world: World): void {
  let maxN = qn;
  for (const q of world.quests ?? []) {
    const m = /^q_([0-9a-z]+)$/.exec((q as { id?: unknown })?.id as string);
    if (!m) continue;
    const n = parseInt(m[1], 36);
    if (Number.isFinite(n) && n > maxN) maxN = n;
  }
  qn = maxN;
}

export function openQuests(world: World): Quest[] {
  return (world.quests ??= []);
}
export function activeQuests(world: World): Quest[] {
  return openQuests(world).filter((q) => q.status === "active");
}
export function doneQuests(world: World): Quest[] {
  return openQuests(world).filter((q) => q.status === "done");
}

/** ギルドの受注候補（未受注）。最大 limit 件。到達／回収に加え、opts 指定時は討伐/救助/納品も混ぜて多様化。
 *  ★opts 未指定（CLI/stress-multigens）＝従来と完全一致（到達＋回収のみ・同じ rng 消費）。新型は opts 有り時だけ。 */
export function generateOffers(world: World, ch: Character, rng: Rng, limit: number, opts?: OfferOpts): Quest[] {
  if (limit <= 0) return [];
  const offers: Quest[] = [];
  const held = openQuests(world);
  const src = opts?.source ?? "guild";
  const tmpl = opts?.templates;
  const informal = src === "tavern"; // 酒場の貼り紙＝人に接地した裏仕事のみ（到達/回収の公式調査はギルドの領分）
  // 到達：今のレベル(≈深度)より少し深い目標（4-4E スケール整合。街では ch.depth=0 になるため level 基準）。
  // すでにギルドの到達依頼を抱えていれば重ねて出さない（同じ/類似の到達依頼を二重受注できる不具合の修正）。
  const hasGuildDescend = held.some((q) => q.kind === "descend" && !q.patron);
  if (!hasGuildDescend && !informal) {
    const dDepth = Math.max(3, ch.level) + 2 + rng.int(3); // +2..+4
    const t = fillQuest(pickTmpl(tmpl, "descend", rng),
      { title: `深度${dDepth}へ到達`, desc: `回収業ギルドの調査依頼。深度${dDepth}まで潜って戻れ。` }, { depth: dDepth });
    offers.push({
      id: qid(), kind: "descend", source: src, targetDepth: dDepth,
      title: t.title, desc: t.desc,
      rewardGold: dDepth * 9, status: "active", issuedGeneration: world.generation,
    });
  }
  // 回収：まだ依頼対象でない既知の化石を一つ（高レベルで陳腐な浅層化石は避ける）
  const allReclaim = world.fossils.filter((f) => !held.some((q) => q.targetFossilId === f.id));
  const nearLevel = allReclaim.filter((f) => f.laidDepth >= ch.level - 6);
  const reclaimable = nearLevel.length ? nearLevel : allReclaim;
  if (reclaimable.length && !informal) {
    const f = rng.pick(reclaimable);
    const t = fillQuest(pickTmpl(tmpl, "reclaim", rng),
      { title: `${f.origin.name}の痕跡を回収`, desc: `深度${f.laidDepth}付近に眠る${f.origin.name}を見つけ出せ。` },
      { fossil: f.origin.name, depth: f.laidDepth });
    offers.push({
      id: qid(), kind: "reclaim", source: src, targetFossilId: f.id, targetDepth: f.laidDepth,
      title: t.title, desc: t.desc,
      rewardGold: f.laidDepth * 6 + 12, status: "active", issuedGeneration: world.generation,
    });
  }
  // ── 新型（討伐/納品/救助/護衛）は opts 有り時のみ＝web 専用。CLI/決定論テストは上の2型で完全一致 ──
  if (opts) {
    const extra: Quest[] = [];
    // 討伐（bounty）：異なるモンスター種を最大2件。既に抱えている種は除く。
    const heldBounty = new Set(held.filter((q) => q.kind === "bounty").map((q) => q.targetKind));
    const monPool = (opts.monsters ?? []).filter((m) => !heldBounty.has(m.key));
    for (let n = 0; n < 2 && monPool.length; n++) {
      const m = monPool.splice(rng.int(monPool.length), 1)[0];
      const need = 3 + rng.int(Math.max(1, Math.min(4, m.tier))); // 3..6（tier 比例）
      const t = fillQuest(pickTmpl(tmpl, "bounty", rng),
        { title: `${m.name}を${need}体討て`, desc: `深みに巣食う${m.name}を${need}体、討ち減らしてほしい。` },
        { monster: m.name, count: need, depth: m.minDepth });
      extra.push({
        id: qid(), kind: "bounty", source: src, targetKind: m.key, need, have: 0, targetDepth: m.minDepth,
        title: t.title, desc: t.desc,
        rewardGold: need * (m.tier * 3 + 4), status: "active", issuedGeneration: world.generation,
      });
    }
    // 納品（fetch）：指定スロットの武具/遺物を持ち帰る。1件まで。
    if (!held.some((q) => q.kind === "fetch")) {
      const slot = (["relic", "weapon", "armor"] as const)[rng.int(3)];
      const need = slot === "relic" ? 1 : 1 + rng.int(2); // 遺物1／武具1..2
      const label = ITEM_LABELS[slot];
      const reward = slot === "relic" ? ch.level * 3 + 30 : (ch.level * 2 + 12) * need;
      const t = fillQuest(pickTmpl(tmpl, "fetch", rng),
        { title: `${label}を納めよ`, desc: `深みで${label}を${need}点 見つけ、持ち帰って納品してくれ。` },
        { item: label, count: need, depth: Math.max(3, ch.level) });
      extra.push({
        id: qid(), kind: "fetch", source: src, targetKind: slot, need,
        title: t.title, desc: t.desc,
        rewardGold: reward, status: "active", issuedGeneration: world.generation,
      });
    }
    // 救助（rescue）：手負いの探索者を救い生還。1件まで（対象なし＝どのダイブでも達成しうる）。
    if (!held.some((q) => q.kind === "rescue")) {
      const t = fillQuest(pickTmpl(tmpl, "rescue", rng),
        { title: `手負いを連れ帰れ`, desc: `深みで動けずにいる冒険者がいる。救い出し、生きて連れ帰ってくれ。` },
        { depth: Math.max(3, ch.level) });
      extra.push({
        id: qid(), kind: "rescue", source: src,
        title: t.title, desc: t.desc,
        rewardGold: (ch.level + 6) * 8, status: "active", issuedGeneration: world.generation,
      });
    }
    // 護衛（escort）：依頼人を指定深度まで生かして連れる。1件まで・相棒枠が空いている時だけ（web が escortClient を渡す）。
    if (opts.escortClient && !held.some((q) => q.kind === "escort")) {
      const eDepth = Math.max(4, ch.level - 2) + rng.int(3); // 護衛しながら＝到達依頼より少し浅め
      const name = opts.escortClient.name;
      const t = fillQuest(pickTmpl(tmpl, "escort", rng),
        { title: `${name}を深度${eDepth}へ護れ`, desc: `${name}が深度${eDepth}へ用がある。無事に連れて行ってほしい。` },
        { actor: name, depth: eDepth });
      extra.push({
        id: qid(), kind: "escort", source: src, targetKind: name, targetDepth: eDepth,
        title: t.title, desc: t.desc,
        rewardGold: eDepth * 14, status: "active", issuedGeneration: world.generation, // 護衛リスク相応＝descend(×9)より厚め
      });
    }
    // 新型候補をシャッフルして残枠へ（毎回同じ顔ぶれ・同じ並びにならないように）。
    for (let i = extra.length - 1; i > 0; i--) { const j = rng.int(i + 1); [extra[i], extra[j]] = [extra[j], extra[i]]; }
    for (const q of extra) { if (offers.length >= limit) break; offers.push(q); }
  }
  return offers.slice(0, limit);
}

/** 護衛（escort）の到達判定（依頼人を連れて対象深度に入った時に web の enterFloor から呼ぶ）。 */
export function onEscortArrive(world: World, questId: string, depth: number): string[] {
  const logs: string[] = [];
  for (const q of activeQuests(world)) {
    if (q.kind !== "escort" || q.id !== questId) continue;
    if (q.targetDepth !== undefined && depth >= q.targetDepth) {
      q.status = "done";
      logs.push(`依頼達成：「${q.title}」── ${q.source === "tavern" ? "酒場" : "ギルド"}で報酬を受け取れる。`);
    }
  }
  return logs;
}

/** 護衛（escort）の失敗（依頼人の戦死/解散/見捨て）。依頼を取り下げ、失敗文を返す。 */
export function failEscortQuest(world: World, questId: string): string[] {
  const q = openQuests(world).find((x) => x.id === questId && x.kind === "escort");
  if (!q) return [];
  world.quests = openQuests(world).filter((x) => x.id !== questId);
  return [`依頼失敗：「${q.title}」── 依頼人を送り届けられなかった。`];
}

/** 貴族街の統治者からの大命（奉献後・4-14G 高難度版）。奉献済みでのみ供給＝**かなり高難度**。
 *  目標を深層/深度50超に置き（深淵帯ギア `abyssalScale` で激化）、名指しの的（討伐/深層化石回収）で歯応えを出す。
 *  報酬＝大金貨（**難度順 slay>reclaim>descend**・上限）＋実績厚め（claimQuest で questsDone+=2）＋稀に固有報酬（rewardRelic）。
 *  ※旧版は全型が上限700に張り付き＝難度差が金貨に出ず、素値では到達のみの descend が最難の slay を上回る逆転だった（v0.63.4 是正）。
 *  ギルド board／謁見の間で配信（claim は claimQuest 共用）。Lv45「原初の証」アークとは別軸。 */
const NOBLE_REWARD_CAP = 1500;
export function generateNobleOffers(world: World, ch: Character, rng: Rng, limit: number): Quest[] {
  if (limit <= 0) return [];
  const held = openQuests(world);
  if (held.some((q) => q.patron === "noble")) return []; // 同時は1件まで
  const relic = rng.next() < 0.33; // 稀に固有報酬（遺物＋称号）
  const cap = (g: number) => Math.min(NOBLE_REWARD_CAP, Math.round(g));
  const roll = rng.next();
  const offers: Quest[] = [];

  if (roll < 0.4) {
    // 討伐（slay）：深層のエリアボス（成れの果て）を討て。深度8の倍数＝56/64 にボスが湧く。
    const dDepth = rng.next() < 0.5 ? 56 : 64; // 深度50超＝深淵帯ギアで激化（到達は長大ダイブ＝最高難度）
    offers.push({
      id: qid(), kind: "slay", patron: "noble", targetDepth: dDepth, rewardRelic: relic,
      title: `統治者の極命：深度${dDepth}の《成れの果て》討伐`,
      desc: `統治者の極命。深度${dDepth}に巣食うエリアボス「成れの果て」を討ち果たせ。深淵の底は、もはや人の領分ではない。`,
      rewardGold: cap(dDepth * 22), status: "active", issuedGeneration: world.generation, // 最難（ボス撃破）＝最高報酬
    });
  } else if (roll < 0.75) {
    // 回収（reclaim）：最深の化石を名指しで回収＝到達＋遭遇の的。深い者を優先。
    const allReclaim = world.fossils.filter((f) => !held.some((q) => q.targetFossilId === f.id) && !f.retired);
    const deep = allReclaim.filter((f) => f.laidDepth >= 38); // 深淵帯の化石を優先
    const pool = deep.length ? deep : allReclaim;
    if (pool.length) {
      const f = pool.reduce((a, b) => (b.laidDepth > a.laidDepth ? b : a)); // 最深を名指し
      offers.push({
        id: qid(), kind: "reclaim", patron: "noble", targetFossilId: f.id, targetDepth: f.laidDepth, rewardRelic: relic,
        title: `統治者の極命：${f.origin.name}の遺物回収`,
        desc: `統治者は深度${f.laidDepth}に眠る${f.origin.name}の痕跡を欲している。深みへ下り、必ず持ち帰れ。`,
        rewardGold: cap((f.laidDepth * 8 + 20) * 2.4), status: "active", issuedGeneration: world.generation, // 中（深層化石回収）
      });
    }
  }
  if (!offers.length) {
    // 到達（descend・保険枠）：深度50超を目標に（深淵帯ギアで激化）。
    const dDepth = Math.min(58, Math.max(52, ch.level + 2));
    offers.push({
      id: qid(), kind: "descend", patron: "noble", targetDepth: dDepth, rewardRelic: relic,
      title: `統治者の極命：深度${dDepth}の踏破`,
      desc: `統治者の極命。深度${dDepth}まで至り、深淵の底の異変をその目で確かめて戻れ。`,
      rewardGold: cap(dDepth * 12), status: "active", issuedGeneration: world.generation, // 保険枠（到達のみ）＝控えめ
    });
  }
  return offers.slice(0, limit);
}

/** 受注（active として積む）。 */
export function acceptQuest(world: World, q: Quest): void {
  openQuests(world).push(q);
}

/** 到達系の達成判定（深度到達時に呼ぶ）。完了通知文を返す。 */
export function onReachDepth(world: World, depth: number): string[] {
  const logs: string[] = [];
  for (const q of activeQuests(world)) {
    if (q.kind === "descend" && q.targetDepth !== undefined && depth >= q.targetDepth) {
      q.status = "done";
      logs.push(`依頼達成：「${q.title}」── ギルドで報酬を受け取れる。`);
    }
  }
  return logs;
}

/** 討伐系の達成判定（エリアボスを撃破した時に呼ぶ・4-14G）。深度 ≥ 目標の slay 大命を done に。 */
export function onSlayBoss(world: World, depth: number): string[] {
  const logs: string[] = [];
  for (const q of activeQuests(world)) {
    if (q.kind === "slay" && q.targetDepth !== undefined && depth >= q.targetDepth) {
      q.status = "done";
      logs.push(`大命達成：「${q.title}」── 謁見の間で報酬を受け取れる。`);
    }
  }
  return logs;
}

/** 回収系の達成判定（対象化石を再発見した時に呼ぶ）。 */
export function onRediscoverFossil(world: World, fossilId: string): string[] {
  const logs: string[] = [];
  for (const q of activeQuests(world)) {
    if (q.kind === "reclaim" && q.targetFossilId === fossilId) {
      q.status = "done";
      logs.push(`依頼達成：「${q.title}」── ギルドで報酬を受け取れる。`);
    }
  }
  return logs;
}

/** 討伐（bounty）の進捗判定（対象種を撃破した時に web の rewardKill から呼ぶ）。need 到達で done。 */
export function onKillMonster(world: World, kindKey: string, _depth: number): string[] {
  const logs: string[] = [];
  for (const q of activeQuests(world)) {
    if (q.kind !== "bounty" || q.targetKind !== kindKey) continue;
    q.have = (q.have ?? 0) + 1;
    if (q.have >= (q.need ?? 1)) {
      q.status = "done";
      logs.push(`依頼達成：「${q.title}」── ${q.source === "tavern" ? "酒場" : "ギルド"}で報酬を受け取れる。`);
    }
  }
  return logs;
}

/** 救助（rescue）の達成判定（手負いを救い出した時に web の rescueScene から呼ぶ）。active な rescue を done に。 */
export function onRescueDelver(world: World): string[] {
  const logs: string[] = [];
  for (const q of activeQuests(world)) {
    if (q.kind !== "rescue") continue;
    q.status = "done";
    logs.push(`依頼達成：「${q.title}」── ${q.source === "tavern" ? "酒場" : "ギルド"}で報酬を受け取れる。`);
  }
  return logs;
}

/** 報酬受領（ギルド）。受領金貨を返す。claimed は一覧から除去。 */
export function claimQuest(world: World, ch: Character, questId: string): number {
  const q = openQuests(world).find((x) => x.id === questId);
  if (!q || q.status !== "done") return 0;
  ch.gold += q.rewardGold;
  world.quests = openQuests(world).filter((x) => x.id !== questId);
  // 4-4E 実績スコア：達成依頼の通算。貴族街の極命は厚め（+2＝家格/等級メタを押し上げる・4-14G）。
  world.questsDone = (world.questsDone ?? 0) + (q.patron === "noble" ? 2 : 1);
  return q.rewardGold;
}

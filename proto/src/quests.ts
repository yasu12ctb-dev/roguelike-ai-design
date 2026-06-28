// 依頼（回収業 4-10G／4-12F quest）の純粋ロジック。ブラウザセーフ（DOM/fs 不使用）。
// 受注＝world.quests に積む／達成判定＝ダンジョン側フックから呼ぶ／報酬＝街で claim。

import type { World, Character, Quest } from "./types.ts";
import type { Rng } from "./rng.ts";
import { ABYSS_DEPTH } from "./progression.ts";

let qn = 0;
const qid = (): string => `q_${(++qn).toString(36)}`;

export function openQuests(world: World): Quest[] {
  return (world.quests ??= []);
}
export function activeQuests(world: World): Quest[] {
  return openQuests(world).filter((q) => q.status === "active");
}
export function doneQuests(world: World): Quest[] {
  return openQuests(world).filter((q) => q.status === "done");
}

/** ギルドの受注候補（未受注）。最大 limit 件。到達＋回収を混ぜる。 */
export function generateOffers(world: World, ch: Character, rng: Rng, limit: number): Quest[] {
  if (limit <= 0) return [];
  const offers: Quest[] = [];
  const held = openQuests(world);
  // 到達：今のレベル(≈深度)より少し深い目標（4-4E スケール整合。街では ch.depth=0 になるため level 基準）。
  // すでにギルドの到達依頼を抱えていれば重ねて出さない（同じ/類似の到達依頼を二重受注できる不具合の修正）。
  const hasGuildDescend = held.some((q) => q.kind === "descend" && !q.patron);
  if (!hasGuildDescend) {
    const dDepth = Math.max(3, ch.level) + 2 + rng.int(3); // +2..+4
    offers.push({
      id: qid(), kind: "descend", targetDepth: dDepth,
      title: `深度${dDepth}へ到達`,
      desc: `回収業ギルドの調査依頼。深度${dDepth}まで潜って戻れ。`,
      rewardGold: dDepth * 9, status: "active", issuedGeneration: world.generation,
    });
  }
  // 回収：まだ依頼対象でない既知の化石を一つ（高レベルで陳腐な浅層化石は避ける）
  const allReclaim = world.fossils.filter((f) => !held.some((q) => q.targetFossilId === f.id));
  const nearLevel = allReclaim.filter((f) => f.laidDepth >= ch.level - 6);
  const reclaimable = nearLevel.length ? nearLevel : allReclaim;
  if (reclaimable.length) {
    const f = rng.pick(reclaimable);
    offers.push({
      id: qid(), kind: "reclaim", targetFossilId: f.id, targetDepth: f.laidDepth,
      title: `${f.origin.name}の痕跡を回収`,
      desc: `深度${f.laidDepth}付近に眠る${f.origin.name}を見つけ出せ。`,
      rewardGold: f.laidDepth * 6 + 12, status: "active", issuedGeneration: world.generation,
    });
  }
  return offers.slice(0, limit);
}

/** 貴族街の統治者からの大命（奉献後・4-14G 高難度版）。奉献済みでのみ供給＝**かなり高難度**。
 *  目標を深層/深度50超に置き（深淵帯ギア `abyssalScale` で激化）、名指しの的（討伐/深層化石回収）で歯応えを出す。
 *  報酬＝大金貨（×2.2・上限）＋実績厚め（claimQuest で questsDone+=2）＋稀に固有報酬（rewardRelic）。
 *  ギルド board／謁見の間で配信（claim は claimQuest 共用）。Lv45「原初の証」アークとは別軸。 */
const NOBLE_REWARD_CAP = 700;
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
      rewardGold: cap(dDepth * 14), status: "active", issuedGeneration: world.generation,
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
        rewardGold: cap((f.laidDepth * 8 + 20) * 2.2), status: "active", issuedGeneration: world.generation,
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
      rewardGold: cap(dDepth * 9 * 2.2), status: "active", issuedGeneration: world.generation,
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

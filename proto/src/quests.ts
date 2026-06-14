// 依頼（回収業 4-10G／4-12F quest）の純粋ロジック。ブラウザセーフ（DOM/fs 不使用）。
// 受注＝world.quests に積む／達成判定＝ダンジョン側フックから呼ぶ／報酬＝街で claim。

import type { World, Character, Quest } from "./types.ts";
import type { Rng } from "./rng.ts";

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
  // 到達：今より少し深い目標
  const dDepth = Math.max(3, ch.depth) + 2 + rng.int(3); // +2..+4
  offers.push({
    id: qid(), kind: "descend", targetDepth: dDepth,
    title: `深度${dDepth}へ到達`,
    desc: `回収業ギルドの調査依頼。深度${dDepth}まで潜って戻れ。`,
    rewardGold: dDepth * 9, status: "active", issuedGeneration: world.generation,
  });
  // 回収：まだ依頼対象でない既知の化石を一つ
  const reclaimable = world.fossils.filter((f) => !held.some((q) => q.targetFossilId === f.id));
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
  return q.rewardGold;
}

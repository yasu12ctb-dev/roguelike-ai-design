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

/** 貴族街の統治者からの大命（奉献後・4-13D Phase4）。奉献済みでのみ供給＝高報酬の到達/回収。
 *  ギルド board に相乗りで出す（claim 経路は claimQuest 共用）。Lv45「原初の証」アークとは別軸。 */
export function generateNobleOffers(world: World, ch: Character, rng: Rng, limit: number): Quest[] {
  if (limit <= 0) return [];
  const held = openQuests(world);
  if (held.some((q) => q.patron === "noble")) return []; // 同時は1件まで（受注/達成待ちがあれば供給しない）
  const offers: Quest[] = [];
  if (rng.next() < 0.5) {
    const dDepth = Math.max(5, ch.level) + 3 + rng.int(4); // 貴族大命＝現レベル(≈深度)よりやや深い（クリア後の高位依頼に整合）
    const flavor = rng.pick([
      `統治者の視察：深度${dDepth}の検分`, `王領の威信：深度${dDepth}の制圧`,
      `封蝕の調べ：深度${dDepth}の異変`, `貴族街からの大命：深度${dDepth}の調べ`,
    ]);
    offers.push({
      id: qid(), kind: "descend", patron: "noble", targetDepth: dDepth,
      title: flavor,
      desc: `封鎖区の統治者からの密命。深度${dDepth}まで至り、深みの異変を確かめて戻れ。`,
      rewardGold: Math.round(dDepth * 9 * 1.8), status: "active", issuedGeneration: world.generation,
    });
  } else {
    const allReclaim = world.fossils.filter((f) => !held.some((q) => q.targetFossilId === f.id));
    const nearLevel = allReclaim.filter((f) => f.laidDepth >= ch.level - 6);
    const reclaimable = nearLevel.length ? nearLevel : allReclaim;
    if (reclaimable.length) {
      const f = rng.pick(reclaimable);
      offers.push({
        id: qid(), kind: "reclaim", patron: "noble", targetFossilId: f.id, targetDepth: f.laidDepth,
        title: `貴族街からの大命：${f.origin.name}の遺物`,
        desc: `統治者は${f.origin.name}の痕跡を欲している。深度${f.laidDepth}付近で見つけ出せ。`,
        rewardGold: Math.round((f.laidDepth * 6 + 12) * 1.8), status: "active", issuedGeneration: world.generation,
      });
    }
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
  world.questsDone = (world.questsDone ?? 0) + 1; // 4-4E 実績スコア：達成依頼の通算
  return q.rewardGold;
}

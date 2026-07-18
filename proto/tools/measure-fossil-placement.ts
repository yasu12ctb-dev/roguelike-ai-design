// PR-1 実測（手動・CI 非同梱）：化石抽選と配置の距離ゲート整合の before/after。
//  旧＝rollEncounter(±14 まで) → 配置直前に |laidDepth−depth|≤4 で弾く（exclude に入れず再抽選し得る＝無駄撃ち）。
//  新＝rollEncounter(maxDist=4) → 配置可能候補だけを引く。
//  fossilTries は据置（現行式）。web enterFloor の配置ループを忠実に再現して計測する。
//  実行：node --experimental-strip-types tools/measure-fossil-placement.ts

import { newWorld, createCharacter, fossilizeCurrent } from "../src/world.ts";
import { genFloor, placeFossil } from "../src/dungeon.ts";
import { rollEncounter } from "../src/weights.ts";
import { makeRng } from "../src/rng.ts";
import type { Character, Fossil, World, Pos } from "../src/types.ts";

// 現行の fossilTries 式（main.ts enterFloor と一致・凪ボーナスは除く＝定常計測）。
function fossilTriesFor(floor: { w: number; h: number }, depth: number): number {
  return (depth >= 4 ? 2 : 1) + (depth >= 4 ? Math.min(2, Math.floor((floor.w * floor.h) / 3600)) : 0);
}

// 配置ループ 1 回分を回して「置けた数」を返す。maxDist=Infinity で旧・4 で新を再現。
function runPlacement(world: World, ch: Character, floor: ReturnType<typeof genFloor>, player: Pos, seed: number, maxDist: number): number {
  const rng = makeRng(seed);
  const exclude = new Set<string>();
  const tries = fossilTriesFor(floor, ch.depth);
  let placed = 0;
  for (let i = 0; i < tries; i++) {
    // 旧挙動の忠実再現：Infinity で引き、配置直前に距離で弾く（exclude に入れない）。
    // 新挙動：maxDist=4 で引く（距離チェックは候補側で済む）。
    const fossil = maxDist === Infinity
      ? rollEncounter(world, ch, rng, exclude)
      : rollEncounter(world, ch, rng, exclude, maxDist);
    if (!fossil) break;
    if (maxDist === Infinity) {
      if (Math.abs(fossil.laidDepth - ch.depth) <= 4 && placeFossil(floor, rng, player, fossil)) { exclude.add(fossil.id); placed++; }
    } else {
      if (placeFossil(floor, rng, player, fossil)) { exclude.add(fossil.id); placed++; }
    }
  }
  return placed;
}

// 抽選候補の「距離超過（配置不能）」重みシェア＝無駄撃ちの見積り（1 回抽選の期待値）。
function wastedWeightShare(world: World, ch: Character): number {
  // depthProximity>0（±14）の候補を対象に、|laidDepth−depth|>4 の候補が占める encounterWeight シェア。
  const cands = world.fossils.filter((f) => !f.retired && Math.abs(ch.depth - f.laidDepth) < 15);
  if (cands.length === 0) return 0;
  // encounterWeight は weights.ts 内部関数ゆえ、ここでは近似せず rollEncounter を多数回サンプルして測る。
  const rng = makeRng(0xC0FFEE);
  let outOfRange = 0, total = 0;
  for (let i = 0; i < 20000; i++) {
    const f = rollEncounter(world, ch, rng, new Set());
    if (!f) continue;
    total++;
    if (Math.abs(ch.depth - f.laidDepth) > 4) outOfRange++;
  }
  return total === 0 ? 0 : outOfRange / total;
}

function buildWorld(extraDeadDepths: number[]): World {
  const world = newWorld(12345);
  // 実プレイの蓄積を模す：自キャラの死体を数体、任意の深度に足す。
  for (const d of extraDeadDepths) {
    const ch = createCharacter(world, `亡者${d}`, "wanderer", { relation: "none" });
    ch.depth = d; ch.level = d;
    fossilizeCurrent(world, "grievous", { choice: "accept" });
    world.generation++;
  }
  return world;
}

function measure(label: string, world: World) {
  console.log(`\n=== ${label}（化石 ${world.fossils.length} 体・laidDepth: ${world.fossils.map((f) => f.laidDepth).sort((a, b) => a - b).join(",")}）===`);
  console.log("depth | tries | 無駄撃ち重み% | 旧・置けた/回 | 新・置けた/回 | 成功率 旧→新");
  const depths = [3, 6, 10, 15, 20, 25, 30, 35, 44];
  for (const depth of depths) {
    const ch = createCharacter(world, "計測者", "wanderer", { relation: "none" });
    ch.depth = depth; ch.level = depth;
    const waste = wastedWeightShare(world, ch);
    const floorProbe = genFloor(world, depth);
    const tries = fossilTriesFor(floorProbe, depth);
    const N = 400;
    let oldPlaced = 0, newPlaced = 0;
    for (let s = 0; s < N; s++) {
      const player: Pos = { x: floorProbe.stairsDown.x, y: floorProbe.stairsDown.y };
      const fOld = genFloor(world, depth); // 各試行で新規フロア（配置は破壊的ゆえ）
      const fNew = genFloor(world, depth);
      oldPlaced += runPlacement(world, ch, fOld, player, 1000 + s, Infinity);
      newPlaced += runPlacement(world, ch, fNew, player, 1000 + s, 4);
    }
    const oldAvg = oldPlaced / N, newAvg = newPlaced / N;
    const oldRate = oldAvg / tries, newRate = newAvg / tries;
    console.log(
      `${String(depth).padStart(5)} | ${String(tries).padStart(5)} | ${(waste * 100).toFixed(0).padStart(11)}% | ${oldAvg.toFixed(2).padStart(12)} | ${newAvg.toFixed(2).padStart(12)} | ${(oldRate * 100).toFixed(0)}%→${(newRate * 100).toFixed(0)}%`,
    );
  }
}

// A：シードのみ（新規ワールド＝序盤）
measure("シードのみ（12体）", buildWorld([]));
// B：中盤の蓄積（自キャラ死体を中〜深層に散らす）
measure("中盤の蓄積", buildWorld([10, 13, 18, 24, 29, 34]));

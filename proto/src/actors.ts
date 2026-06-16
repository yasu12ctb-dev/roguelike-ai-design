// アクター記述子（4-12(G)）：化石 origin を一般化し、生者NPCも同じ鋳造所機構で作る。
// 生者は lazy：遭遇時に mint し、選択の effects が参照した時だけ World へ永続化（4-12C/4-6）。

import type { ContentDb } from "./content.ts";
import { filterByTags, pickByTags } from "./content.ts";
import type { Actor, FragmentTags, LivingActor, World } from "./types.ts";
import type { Rng } from "./rng.ts";

/** 金属等級（4-4E）の素材key→index。設定ファイル(actor_grade)はこのkeyで等級を綴る。 */
const GRADE_INDEX: Record<string, number> = { iron: 0, bronze: 1, silver: 2, gold: 3, platinum: 4 };

/** 設定ファイル（actor_grade スロット）から初期等級を引く。未設定なら 0（アイアン＝新参）。
 *  断片の重み付け（下ほど多い行数）で 4-4E のピラミッドを procedural に再現する。 */
function pickGrade(db: ContentDb, rng: Rng, tags: FragmentTags): number {
  const pool = filterByTags(db, "actor_grade", tags);
  if (pool.length === 0) return 0;
  return GRADE_INDEX[rng.pick(pool).text] ?? 0;
}

/** 鋳造所断片からアクター記述子を生成（化石に origin を与えるのと同じ機構の procedural 版）。 */
export function mintActor(db: ContentDb, rng: Rng, tags: FragmentTags = {}): Actor {
  const archetype = pickByTags(db, rng, "actor_role", tags).text;   // 職分（表示用ラベル）
  const name = pickByTags(db, rng, "actor_name", tags).text;
  const gear = pickByTags(db, rng, "actor_gear", tags).text;
  const epithet = pickByTags(db, rng, "actor_epithet", tags).text;
  const grade = pickGrade(db, rng, tags);                           // 金属等級（4-4E）＝設定ファイル由来
  return { name, archetype, gearTags: [gear], epithet, alive: true, grade };
}

/** 街などで生者と出会う。既知の生者がいれば一定確率で再会（伏線の follow-up を可能に）、なければ新規 mint。 */
export function meetActor(world: World, db: ContentDb, rng: Rng): LivingActor {
  const known = world.actors ?? [];
  if (known.length > 0 && rng.next() < 0.5) return rng.pick(known);
  const id = `npc_${world.generation}_${Math.floor(rng.next() * 1e9).toString(36)}`;
  return { id, actor: mintActor(db, rng), metGeneration: world.generation };
}

/** 生者を永続化（lazy：effects が参照した時だけ呼ぶ。重複は無視）。 */
export function rememberActor(world: World, la: LivingActor): void {
  (world.actors ??= []);
  if (!world.actors.some((a) => a.id === la.id)) world.actors.push(la);
}

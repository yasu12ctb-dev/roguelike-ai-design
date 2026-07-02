// アクター記述子（4-12(G)）：化石 origin を一般化し、生者NPCも同じ鋳造所機構で作る。
// 生者は lazy：遭遇時に mint し、選択の effects が参照した時だけ World へ永続化（4-12C/4-6）。

import type { ContentDb } from "./content.ts";
import { filterByTags, pickByTags } from "./content.ts";
import type { Actor, FragmentTags, LivingActor, World } from "./types.ts";
import type { Rng } from "./rng.ts";
import { worldPlayerGrade } from "./companion.ts";

/** 金属等級（4-4E）の素材key→index。設定ファイル(actor_grade)はこのkeyで等級を綴る。 */
const GRADE_INDEX: Record<string, number> = { iron: 0, bronze: 1, silver: 2, gold: 3, platinum: 4 };

/** 設定ファイル（actor_grade スロット）から初期等級を引く。未設定なら 0（アイアン＝新参）。
 *  断片の重み付け（下ほど多い行数）で 4-4E のピラミッドを procedural に再現する。 */
function pickGrade(db: ContentDb, rng: Rng, tags: FragmentTags): number {
  const pool = filterByTags(db, "actor_grade", tags);
  if (pool.length === 0) return 0;
  return GRADE_INDEX[rng.pick(pool).text] ?? 0;
}

/** 既に化石になっている名前の集合＝生者の鋳造で避けるべき名前（「死者は生者として出さない」）。 */
export function fossilNames(world: World): Set<string> {
  return new Set((world.fossils ?? []).map((f) => f.origin.name));
}

/** 鋳造所断片からアクター記述子を生成（化石に origin を与えるのと同じ機構の procedural 版）。
 *  avoidNames＝避けるべき名前（既存の化石名）。名簿（pickRosterActor）と同じ「死者は生者として出さない」を
 *  無名NPCにも適用する（死んだセナが delver として再登場する辻褄崩れの防止・2026-07-02）。
 *  プールが全滅していたら再利用を許す（クラッシュしない保険＝多世代で名前を使い切った極端ケース）。
 *  未指定なら従来と完全一致（CLI/demo 後方互換・rng 消費数も同一）。 */
export function mintActor(db: ContentDb, rng: Rng, tags: FragmentTags = {}, avoidNames?: Set<string>): Actor {
  const archetype = pickByTags(db, rng, "actor_role", tags).text;   // 職分（表示用ラベル）
  let namePool = filterByTags(db, "actor_name", tags);
  if (avoidNames && avoidNames.size) {
    const alive = namePool.filter((f) => !avoidNames.has(f.text));
    if (alive.length) namePool = alive;
  }
  if (namePool.length === 0) throw new Error(`no fragment for actor_name ${JSON.stringify(tags)}`);
  const name = rng.pick(namePool).text;
  const gear = pickByTags(db, rng, "actor_gear", tags).text;
  const epithet = pickByTags(db, rng, "actor_epithet", tags).text;
  const grade = pickGrade(db, rng, tags);                           // 金属等級（4-4E）＝設定ファイル由来
  return { name, archetype, gearTags: [gear], epithet, alive: true, grade };
}

/** ★中核の名簿（4-14）から、まだ登場していない本人を1人 LivingActor で返す（無ければ null）。
 *  「登場済み」＝world.actors に id 登録済み／既に同名の化石になっている（死者は生者として出さない）。 */
export function pickRosterActor(world: World, db: ContentDb, rng: Rng): LivingActor | null {
  const roster = db.adventurers ?? [];
  if (roster.length === 0) return null;
  const metIds = new Set((world.actors ?? []).map((a) => a.id));
  const deadNames = new Set((world.fossils ?? []).map((f) => f.origin.name));
  // 等級ゲート（4-14）：等級 ≤ プレイヤー等級＋1 の名簿員のみ出会える＝「名を上げて初めて高位に会う」。
  // 一つ上の格（憧れの先達）には少し早く会える余白。死者/既登場は除外。
  const cap = worldPlayerGrade(world, world.current?.level ?? 1) + 1;
  const avail = roster.filter((r) => !metIds.has(r.id) && !deadNames.has(r.name) && (r.grade ?? 0) <= cap);
  if (avail.length === 0) return null;
  const r = rng.pick(avail);
  const actor: Actor = {
    name: r.name, archetype: r.archetype, gearTags: r.gearTags,
    catchphrase: r.catchphrase, epithet: r.epithet, grade: r.grade, alive: true,
  };
  return { id: r.id, actor, metGeneration: world.generation };
}

/** 名簿員を街で出す確率（4-14：本人として出会わせる）。0 で従来挙動と完全一致。 */
const ROSTER_MEET_CHANCE = 0.35;

/** 街などで生者と出会う。既知の生者がいれば一定確率で再会（伏線の follow-up を可能に）、
 *  次いで一定確率で★中核の本人（名簿）、いずれも無ければ新規 mint（無名の通行人）。 */
export function meetActor(world: World, db: ContentDb, rng: Rng): LivingActor {
  const known = world.actors ?? [];
  if (known.length > 0 && rng.next() < 0.5) return rng.pick(known);
  if (rng.next() < ROSTER_MEET_CHANCE) {
    const r = pickRosterActor(world, db, rng);
    if (r) return r;
  }
  const id = `npc_${world.generation}_${Math.floor(rng.next() * 1e9).toString(36)}`;
  return { id, actor: mintActor(db, rng, {}, fossilNames(world)), metGeneration: world.generation };
}

/** 生者を永続化（lazy：effects が参照した時だけ呼ぶ。重複は無視）。 */
export function rememberActor(world: World, la: LivingActor): void {
  (world.actors ??= []);
  if (!world.actors.some((a) => a.id === la.id)) world.actors.push(la);
}

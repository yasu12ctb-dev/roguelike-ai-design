// 鋳造所コンテンツ：タグ整合の抽選（環境非依存・純ロジック）
// ロードは環境ごとに行う：Node = content-node.ts / ブラウザ = JSON を bundler が同梱

import type { Fragment, FragmentTags, RosterActor, SetPiece, Storylet } from "./types.ts";
import type { Rng } from "./rng.ts";

export interface ContentDb {
  fragments: Fragment[];
  setpieces: SetPiece[];
  storylets: Storylet[];
  adventurers: RosterActor[];   // ★中核の名簿（4-14・冒険者B/C）。空でも可（既定[]）。
  /** context 別の索引（構築時に1回・元配列順を保持）。毎ターンの全件 filter を避ける（key = context ?? "encounter"）。 */
  byContext: Map<string, Storylet[]>;
}

/** storylets を context 別に振り分ける。元の配列順を保つため、選択（重み付き抽選）の結果は従来と完全一致。 */
function indexByContext(storylets: Storylet[]): Map<string, Storylet[]> {
  const m = new Map<string, Storylet[]>();
  for (const s of storylets) {
    const key = s.context ?? "encounter";
    let bucket = m.get(key);
    if (!bucket) { bucket = []; m.set(key, bucket); }
    bucket.push(s);
  }
  return m;
}

export function makeContentDb(
  fragmentsJson: { fragments: Fragment[] },
  setpiecesJson: { setpieces: SetPiece[] },
  storyletsJson?: { storylets: Storylet[] },
  adventurersJson?: { adventurers: RosterActor[] },
): ContentDb {
  const storylets = storyletsJson?.storylets ?? [];
  return {
    fragments: fragmentsJson.fragments,
    setpieces: setpiecesJson.setpieces,
    storylets,
    adventurers: adventurersJson?.adventurers ?? [],
    byContext: indexByContext(storylets),
  };
}

/** タグが要求に矛盾しない断片だけを返す（断片側にタグが無ければワイルドカード扱い） */
export function filterByTags(db: ContentDb, slotType: string, want: FragmentTags): Fragment[] {
  return db.fragments.filter((f) => {
    if (f.slotType !== slotType) return false;
    for (const key of Object.keys(want) as (keyof FragmentTags)[]) {
      const fv = f.tags[key];
      const wv = want[key];
      if (fv !== undefined && wv !== undefined && fv !== wv) return false;
    }
    return true;
  });
}

export function pickByTags(db: ContentDb, rng: Rng, slotType: string, want: FragmentTags): Fragment {
  const pool = filterByTags(db, slotType, want);
  if (pool.length === 0) throw new Error(`no fragment for ${slotType} ${JSON.stringify(want)}`);
  return rng.pick(pool);
}

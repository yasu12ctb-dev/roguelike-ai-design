// 鋳造所コンテンツのロードとタグ整合の抽選

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Fragment, FragmentTags, SetPiece } from "./types.ts";
import type { Rng } from "./rng.ts";

const here = dirname(fileURLToPath(import.meta.url));
const contentDir = join(here, "..", "content");

export interface ContentDb {
  fragments: Fragment[];
  setpieces: SetPiece[];
}

export function loadContent(): ContentDb {
  const frags = JSON.parse(readFileSync(join(contentDir, "fragments.json"), "utf-8"));
  const sps = JSON.parse(readFileSync(join(contentDir, "setpieces.json"), "utf-8"));
  return { fragments: frags.fragments, setpieces: sps.setpieces };
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

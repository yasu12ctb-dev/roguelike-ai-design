// 街データの Node 側ローダ（fs は本ファイルに隔離）。CLI / node テスト用。
// エンジン本体（townscene.ts）はブラウザセーフのまま保つ。

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { TownData } from "./townscene.ts";

const here = dirname(fileURLToPath(import.meta.url));

export function loadTownData(): TownData {
  const path = join(here, "..", "content", "town.json");
  return JSON.parse(readFileSync(path, "utf-8")) as TownData;
}

// Node 専用：content/*.json をファイルシステムから読む（demo.ts / cli.ts 用）

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { makeContentDb, type ContentDb } from "./content.ts";

const here = dirname(fileURLToPath(import.meta.url));
const contentDir = join(here, "..", "content");

export function loadContent(): ContentDb {
  const frags = JSON.parse(readFileSync(join(contentDir, "fragments.json"), "utf-8"));
  const sps = JSON.parse(readFileSync(join(contentDir, "setpieces.json"), "utf-8"));
  return makeContentDb(frags, sps);
}

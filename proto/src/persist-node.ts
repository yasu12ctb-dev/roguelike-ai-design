// Node 専用の永続化（demo.ts / cli.ts 用）。ブラウザは localStorage を使う（web/main.ts）。

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { World } from "./types.ts";

export function saveWorld(world: World, path: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(world, null, 2), "utf-8");
}

export function loadWorld(path: string): World {
  return JSON.parse(readFileSync(path, "utf-8")) as World;
}

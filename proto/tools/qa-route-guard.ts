// PR3「主経路ガード」構造QA（v0.152.0）。
//   実行: cd proto && node --experimental-strip-types tools/qa-route-guard.ts
//
// 目的＝dungeon.ts genFloor 末尾の「PR3｜主経路ガード」ブロック（全域散布枠の敵 2〜4体を
//   stairsUp→stairsDown の4近傍BFS最短路上へ再配置＝normal/hard の d≥10 限定・RNG非消費）が、
//   仕様どおりに動いているかを構造的に検査する（プレイ挙動でなく生成物そのものの assert）。
//
// 手法＝同一 world・同一 depth で genFloor を「既定」と「routeGuards:0（ガード無効）」の2通り生成し、
//   位置差分（diff）で再配置対象を特定する。routeGuards オプション自体は RNG を一切消費しないため
//   （PR3 コメント参照）、両呼び出しのタイル・階段・敵配列の順序/id は byte 同一になる（実測で裏取り済み＝
//   下記 "pre" カテゴリ）。
//
// ★重要な発見（このQAで判明・本ツールのみの知見＝engineは未変更）＝
//   ガード自身はRNGを消費しないが、ガードが「どのマスが敵で占有されているか」を書き換えるため、
//   それより後段（ボス/中ボス/宝箱/安息所/fodder/escort）の occupancy 依存な再試行ループ
//   （randomFloorAway/randomTileInRoom 等＝棄却のたび次候補を引き直す＝rng 消費数が受理/棄却パターンに
//   依存）が、既定 vs routeGuards:0 の間で「消費するRNG回数」自体がずれ、連鎖的に fodder/escort 等の
//   座標が（本来ガードと無関係に）ズレる＝生の配列diffには f{depth}_*／esc{depth}_* の“ノイズ”が混入する。
//   ★これは実プレイのRNG決定論には影響しない（実プレイは1回の genFloor 呼び出ししかしない＝2アーム比較は
//   本ツール専用の合成手法）。ガード対象は主配置ループの m{depth}_* に限られる（fodder/escort/boss は対象外）ので、
//   本ツールは「m{depth}_ プレフィックスの id」だけを診断対象にフィルタし、ノイズは cascade として別集計する。
//
// 検査するもの（本ツールは engine を一切書き換えない・読むだけ）：
//   (a) easy と d<10 は位置diff 0（ガード不発）
//   (b) normal/hard d≥10 の再配置数＝仕様値以下（min(仕様値,散布枠数)）・中央値が仕様どおり
//   (c) 再配置された敵は全て BFS 最短路タイル上にある（本ツールで独立に同一アルゴリズムを再実装して検証）
//   (d) 開始階段から経路5マス以内・下り階段から経路3マス以内に再配置敵 0
//   (e) 再配置敵同士の経路距離 ≥5
//   (f) 敵総数がアーム間で完全一致・重なり（同一マス2体）0・全敵が床タイル上
//   (g) monsterHardcap 超過 0
import { genFloor, monsterHardcap } from "../src/dungeon.ts";
import type { Floor, Pos } from "../src/dungeon.ts";
import { newWorld } from "../src/world.ts";
import { diffMods } from "../src/difficulty.ts";
import type { Difficulty } from "../src/difficulty.ts";

// ---------- 集計器 ----------
interface CatStat { pass: number; fail: number; }
const cats: Record<string, CatStat> = {};
const failMsgs: string[] = [];
function check(cat: string, name: string, cond: boolean, detail?: string) {
  const c = (cats[cat] ??= { pass: 0, fail: 0 });
  if (cond) { c.pass++; }
  else { c.fail++; failMsgs.push(`✗ [${cat}] ${name}${detail ? " — " + detail : ""}`); }
}

// ---------- テスト行列 ----------
const SEEDS: number[] = [];
for (let s = 1; s <= 24; s++) SEEDS.push(s * 733 + 11);
const DEPTHS = [5, 10, 15, 20, 25, 30, 40];
const DIFFS: Difficulty[] = ["easy", "normal", "hard"];

function makeWorld(diff: Difficulty, seed: number) {
  const w = newWorld((seed ^ 0xa17e05) >>> 0);
  w.difficulty = diff;
  w.diveCount = seed % 5;
  return w;
}

/** engine の opts?.routeGuards ?? (...) と同一の仕様式（外部から独立に再計算）。 */
function specRouteGuards(depth: number, diff: Difficulty): number {
  const notEasy = diff !== "easy";
  return !notEasy || depth < 10 ? 0 : depth < 20 ? 2 : depth < 30 ? 3 : 4;
}

/** 固定近傍順(上/右/下/左)の4近傍BFS最短路。dungeon.ts の PR3 ブロックと同一アルゴリズムを独立実装＝検証の裏取り。 */
function shortestRoute(f: Floor): Pos[] | null {
  const W = f.w, H = f.h;
  const prev = new Int32Array(W * H).fill(-1);
  const start = f.stairsUp.y * W + f.stairsUp.x, goal = f.stairsDown.y * W + f.stairsDown.x;
  const q = [start]; prev[start] = start;
  const DIRS = [[0, -1], [1, 0], [0, 1], [-1, 0]] as const;
  for (let h = 0; h < q.length && prev[goal] === -1; h++) {
    const cur = q[h], cx = cur % W, cy = (cur / W) | 0;
    for (const [dx, dy] of DIRS) {
      const nx = cx + dx, ny = cy + dy;
      if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
      const ni = ny * W + nx;
      if (prev[ni] !== -1 || f.tiles[ni] !== 1) continue;
      prev[ni] = cur; q.push(ni);
    }
  }
  if (prev[goal] === -1) return null;
  const route: Pos[] = [];
  for (let cur = goal; cur !== start; cur = prev[cur]) route.push({ x: cur % W, y: (cur / W) | 0 });
  route.push({ x: f.stairsUp.x, y: f.stairsUp.y });
  route.reverse();
  return route;
}

interface Moved { id: string; from: Pos; to: Pos; }
/** withGuard（既定）と noGuard（routeGuards:0）の敵配列を index 対応で突き合わせ、座標が動いたものを返す。
 *  id順序が食い違えば（＝RNG非消費という前提が崩れていれば）ok=false を返す。 */
function diffPositions(withGuard: Floor, noGuard: Floor): { ok: boolean; moved: Moved[] } {
  if (withGuard.monsters.length !== noGuard.monsters.length) return { ok: false, moved: [] };
  const moved: Moved[] = [];
  for (let i = 0; i < withGuard.monsters.length; i++) {
    const a = withGuard.monsters[i], b = noGuard.monsters[i];
    if (a.id !== b.id) return { ok: false, moved: [] };
    if (a.x !== b.x || a.y !== b.y) moved.push({ id: a.id, from: { x: b.x, y: b.y }, to: { x: a.x, y: a.y } });
  }
  return { ok: true, moved };
}

function tilesEqual(a: Floor, b: Floor): boolean {
  if (a.w !== b.w || a.h !== b.h || a.tiles.length !== b.tiles.length) return false;
  for (let i = 0; i < a.tiles.length; i++) if (a.tiles[i] !== b.tiles[i]) return false;
  return true;
}
const posEq = (a: Pos, b: Pos) => a.x === b.x && a.y === b.y;

function overlapsCount(f: Floor): number {
  let c = 0;
  for (let i = 0; i < f.monsters.length; i++)
    for (let j = i + 1; j < f.monsters.length; j++)
      if (f.monsters[i].x === f.monsters[j].x && f.monsters[i].y === f.monsters[j].y) c++;
  return c;
}
function offFloorCount(f: Floor): number {
  let c = 0;
  for (const m of f.monsters) if (f.tiles[m.y * f.w + m.x] !== 1) c++;
  return c;
}
function median(xs: number[]): number {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

// (b) 中央値集計用：depth×diff ごとの実測再配置数（m{depth}_ フィルタ後）
const movedCounts: Record<string, number[]> = {};
// 下段カスケード（fodder/escort等の occupancy 依存ドリフト）の観測用集計（診断のみ・pass/fail 対象外）
let cascadeTotal = 0, cascadeFloors = 0;

console.log("=== PR3「主経路ガード」構造QA（v0.152.0） ===");
console.log(`  ${SEEDS.length}seed × depth[${DEPTHS.join(",")}] × diff[${DIFFS.join(",")}]（既定 vs routeGuards:0 の位置diff検査）\n`);

for (const diff of DIFFS) {
  for (const depth of DEPTHS) {
    const target = specRouteGuards(depth, diff);
    for (const seed of SEEDS) {
      const w = makeWorld(diff, seed);
      const withGuard = genFloor(w, depth);
      const noGuard = genFloor(w, depth, { routeGuards: 0 });
      const tag = `${diff} d${depth} seed${seed}`;

      // 前提の裏取り＝RNG非消費ゆえ、マップ・階段・敵配列の順序/id は両アームで完全一致するはず。
      const tilesOk = tilesEqual(withGuard, noGuard);
      check("pre", `タイル同一 ${tag}`, tilesOk);
      check("pre", `階段位置同一 ${tag}`, posEq(withGuard.stairsUp, noGuard.stairsUp) && posEq(withGuard.stairsDown, noGuard.stairsDown));

      const { ok, moved } = diffPositions(withGuard, noGuard);
      check("pre", `敵配列id順序一致 ${tag}`, ok);

      // ガード対象は主配置ループの m{depth}_* のみ＝それ以外（f*/esc*/boss*/elite*）の位置diffは
      // occupancy 依存の下段カスケード（上記コメント参照）＝ガードの正誤とは無関係のノイズとして分離する。
      const mPrefix = `m${depth}_`;
      const guardMoved = moved.filter((mv) => mv.id.startsWith(mPrefix));
      const cascadeNoise = moved.length - guardMoved.length;
      if (cascadeNoise > 0) { cascadeTotal += cascadeNoise; cascadeFloors++; }

      if (target === 0) {
        // (a) easy と d<10 は位置diff 0（ガード不発）。routeGuardsが発火しない＝occupancyも変わらない＝
        //   カスケードも起きないはず＝生の moved.length で厳密に見る（フィルタ不要のはずだが念のため素通し）。
        check("a", `不発 ${tag}`, ok && moved.length === 0, `moved=${moved.length}`);
      } else {
        // (b) 再配置数 ≦ 仕様値（m{depth}_ フィルタ後＝ガード自身の再配置数のみを見る）
        check("b", `再配置数≦仕様 ${tag}`, ok && guardMoved.length <= target, `guardMoved=${guardMoved.length} spec=${target} (生moved=${moved.length}・cascade=${cascadeNoise})`);
        (movedCounts[`${diff}|${depth}`] ??= []).push(ok ? guardMoved.length : -1);

        const movedForCheck = guardMoved;
        if (ok && tilesOk && movedForCheck.length > 0) {
          const route = shortestRoute(withGuard);
          check("pre", `BFS到達 ${tag}`, route !== null);
          if (route) {
            check("pre", `route[0]=stairsUp ${tag}`, posEq(route[0], withGuard.stairsUp));
            check("pre", `route[末]=stairsDown ${tag}`, posEq(route[route.length - 1], withGuard.stairsDown));
            const routeIndex = new Map<string, number>();
            route.forEach((p, i) => routeIndex.set(`${p.x},${p.y}`, i));
            const lo = 5, hi = route.length - 1 - 3;
            const idxs: number[] = [];
            for (const mv of movedForCheck) {
              const key = `${mv.to.x},${mv.to.y}`;
              const idx = routeIndex.get(key);
              // (c) 再配置された敵は全て BFS 最短路タイル上にある
              check("c", `経路上 ${tag} id=${mv.id}`, idx !== undefined, `to=(${mv.to.x},${mv.to.y})`);
              if (idx === undefined) continue;
              idxs.push(idx);
              // (d) 開始階段から経路5マス以内・下り階段から経路3マス以内に再配置敵 0
              check("d", `階段近傍除外 ${tag} id=${mv.id}`, idx >= lo && idx <= hi, `idx=${idx} lo=${lo} hi=${hi}`);
            }
            // (e) 再配置敵同士の経路距離 ≥5
            for (let i = 0; i < idxs.length; i++)
              for (let j = i + 1; j < idxs.length; j++)
                check("e", `再配置間距離≥5 ${tag} (${idxs[i]},${idxs[j]})`, Math.abs(idxs[i] - idxs[j]) >= 5, `Δ=${Math.abs(idxs[i] - idxs[j])}`);
          }
        }
      }

      // (f) 敵総数がアーム間で完全一致・重なり0・全敵が床タイル上（両アームで検査＝ガード有無に依存しない不変条件）
      check("f", `総数一致 ${tag}`, withGuard.monsters.length === noGuard.monsters.length,
        `withGuard=${withGuard.monsters.length} noGuard=${noGuard.monsters.length}`);
      check("f", `重なり0(既定) ${tag}`, overlapsCount(withGuard) === 0, `n=${overlapsCount(withGuard)}`);
      check("f", `重なり0(routeGuards:0) ${tag}`, overlapsCount(noGuard) === 0, `n=${overlapsCount(noGuard)}`);
      check("f", `床タイル上(既定) ${tag}`, offFloorCount(withGuard) === 0, `n=${offFloorCount(withGuard)}`);
      check("f", `床タイル上(routeGuards:0) ${tag}`, offFloorCount(noGuard) === 0, `n=${offFloorCount(noGuard)}`);

      // (g) monsterHardcap 超過 0
      const mods = diffMods(diff);
      const cap = monsterHardcap(depth, mods);
      check("g", `hardcap以内(既定) ${tag}`, withGuard.monsters.length <= cap, `n=${withGuard.monsters.length} cap=${cap}`);
      check("g", `hardcap以内(routeGuards:0) ${tag}`, noGuard.monsters.length <= cap, `n=${noGuard.monsters.length} cap=${cap}`);
    }
  }
}

// ---------- (b) 中央値テーブル ----------
console.log("【(b) 再配置数の分布｜depth×diff（24seed）】 実測[min/中央値/max] vs 仕様値");
for (const diff of DIFFS) {
  if (diff === "easy") continue;
  for (const depth of DEPTHS) {
    const target = specRouteGuards(depth, diff);
    if (target === 0) continue;
    const xs = (movedCounts[`${diff}|${depth}`] ?? []).filter((n) => n >= 0);
    const mn = xs.length ? Math.min(...xs) : NaN, mx = xs.length ? Math.max(...xs) : NaN, md = median(xs);
    const medOk = md === target ? "OK" : "!!";
    check("b-median", `中央値一致 ${diff} d${depth}`, md === target, `median=${md} spec=${target}`);
    console.log(`  ${diff.padEnd(6)} d${String(depth).padStart(2)}  実測[${mn}/${md}/${mx}]  仕様=${target}  ${medOk}`);
  }
}

console.log(`\n【診断】下段カスケードノイズ（fodder/escort等の occupancy 依存ドリフト＝ガードの正誤とは無関係・pass/fail対象外）`);
console.log(`  観測フロア数=${cascadeFloors}／合計ノイズ件数=${cascadeTotal}（route guard 自体はRNG非消費だが、占有マスの変化が後段の再試行ループの受理/棄却パターンを連鎖的にずらす副作用。実プレイは genFloor を1回しか呼ばないため実害なし＝本ツールの2アーム比較特有の観測）`);

// ---------- 集計出力 ----------
console.log("\n【カテゴリ別 pass/fail】");
let totalPass = 0, totalFail = 0;
const order = ["pre", "a", "b", "b-median", "c", "d", "e", "f", "g"];
for (const k of order) {
  const c = cats[k]; if (!c) continue;
  totalPass += c.pass; totalFail += c.fail;
  console.log(`  ${k.padEnd(9)} pass=${c.pass}  fail=${c.fail}`);
}
console.log(`\n合計: pass=${totalPass}  fail=${totalFail}`);

if (failMsgs.length) {
  console.log(`\n【失敗一覧（先頭${Math.min(60, failMsgs.length)}件 / 全${failMsgs.length}件）】`);
  for (const m of failMsgs.slice(0, 60)) console.log(`  ${m}`);
}

console.log(totalFail === 0 ? "\n✅ qa-route-guard: 全assert pass" : `\n❌ qa-route-guard: ${totalFail}件 fail`);
process.exit(totalFail === 0 ? 0 : 1);

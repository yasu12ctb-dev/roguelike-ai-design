// QA専用スクリプト（ゲーム本体は変更しない）＝v0.151.0「部屋の広さ比例配置」(A) の裏取り。
// normal 新規ワールドで浅〜中層フロアを headless 生成し、部屋ごとの敵数が面積に相関しているか
// （相関係数）を確認する。easy は従来どおり全域散布のはず（比較対照として併記）。
// 実行: node --experimental-strip-types tools/qa-room-density.ts
import { newWorld } from "../src/world.ts";
import { genFloor } from "../src/dungeon.ts";

function pearson(xs: number[], ys: number[]): number {
  const n = xs.length;
  if (n < 2) return NaN;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let num = 0, dx2 = 0, dy2 = 0;
  for (let i = 0; i < n; i++) { const dx = xs[i] - mx, dy = ys[i] - my; num += dx * dy; dx2 += dx * dx; dy2 += dy * dy; }
  const den = Math.sqrt(dx2 * dy2);
  return den === 0 ? NaN : num / den;
}

// 深度が交絡する（深いほど部屋も広く敵も多い）ため、床ごと（同一フロア内）の
// 面積↔敵数の相関を出してから平均する＝depth confound を排除した「部屋比例配置」の裏取り。
// ★注記：一様な全域散布（easy）でも「部屋は通路よりタイル数が多い」ため area↔count は自然に正相関しうる。
// ROOM_BIAS の主眼は「通路を避けて部屋（面積比）に寄せる」ことなので、床内相関に加えて
// 「対象部屋（開始/下り除く）に落ちた敵の割合」＝通路へ漏れなかった比率も併せて見る。
function checkDiff(diff: "easy" | "normal" | "hard", depths: number[], seeds: number[]) {
  const perFloorR: number[] = [];
  let floors = 0, roomsTotal = 0, monInRoomsTotal = 0, monFloorTotal = 0;
  for (const seed of seeds) {
    for (const depth of depths) {
      const w = newWorld(seed);
      w.difficulty = diff;
      const floor = genFloor(w, depth);
      floors++;
      if (!floor.rooms || floor.rooms.length === 0) continue;
      const areas: number[] = [];
      const counts: number[] = [];
      monFloorTotal += floor.monsters.length;
      for (const r of floor.rooms) {
        const isStart = r.x <= floor.stairsUp.x && floor.stairsUp.x < r.x + r.w && r.y <= floor.stairsUp.y && floor.stairsUp.y < r.y + r.h;
        const isDown = r.x <= floor.stairsDown.x && floor.stairsDown.x < r.x + r.w && r.y <= floor.stairsDown.y && floor.stairsDown.y < r.y + r.h;
        if (isStart || isDown) continue;
        const area = r.w * r.h;
        const cnt = floor.monsters.filter((m) => m.x >= r.x && m.x < r.x + r.w && m.y >= r.y && m.y < r.y + r.h).length;
        areas.push(area);
        counts.push(cnt);
        roomsTotal++;
        monInRoomsTotal += cnt;
      }
      if (areas.length >= 3) {
        const r = pearson(areas, counts);
        if (!isNaN(r)) perFloorR.push(r);
      }
    }
  }
  const avg = perFloorR.length ? perFloorR.reduce((a, b) => a + b, 0) / perFloorR.length : NaN;
  const frac = monFloorTotal ? monInRoomsTotal / monFloorTotal : NaN;
  console.log(`  [${diff}] floors=${floors} rooms(除外後)=${roomsTotal} 敵(対象部屋内/フロア全体)=${monInRoomsTotal}/${monFloorTotal} 部屋内比率=${isNaN(frac) ? "N/A" : frac.toFixed(3)} 床内相関(平均, n=${perFloorR.length})=${isNaN(avg) ? "N/A" : avg.toFixed(3)}`);
  return { avg, frac };
}

console.log("== QA: 部屋の広さ比例配置（A）＝面積と敵数の相関＋通路を避けて部屋に寄る比率 ==");
const depths = [2, 4, 6, 8, 10, 14, 18];
const seeds = [1, 2, 3, 4, 5, 6, 7, 8];
const easy = checkDiff("easy", depths, seeds);
const normal = checkDiff("normal", depths, seeds);
const hard = checkDiff("hard", depths, seeds);

console.log("");
if (isNaN(normal.avg) || isNaN(hard.avg)) {
  console.log("⚠ normal/hard の相関係数が算出できません（部屋・敵データ不足）。");
  process.exit(1);
}
const fracOk = normal.frac > easy.frac && hard.frac > easy.frac;
const corrOk = normal.avg > 0.2 && hard.avg > 0.2;
if (fracOk && corrOk) {
  console.log(`✅ normal/hard は easy より部屋内比率が高く（easy=${easy.frac.toFixed(3)} < normal=${normal.frac.toFixed(3)}, hard=${hard.frac.toFixed(3)}）、床内の面積↔敵数相関も正（normal=${normal.avg.toFixed(3)}, hard=${hard.avg.toFixed(3)}）＝ROOM_BIAS（通路を避けて広い部屋に寄せる）が効いている。`);
} else {
  console.log(`⚠ 期待した傾向が出ていません（部屋内比率: easy=${easy.frac.toFixed(3)} normal=${normal.frac.toFixed(3)} hard=${hard.frac.toFixed(3)} / 床内相関: normal=${normal.avg.toFixed(3)} hard=${hard.avg.toFixed(3)}）。`);
}
console.log(`  参考：easy の床内相関=${isNaN(easy.avg) ? "N/A" : easy.avg.toFixed(3)}（全域散布でも部屋は通路よりタイル数が多いため正相関が出ること自体は自然＝比率の差の方が ROOM_BIAS の直接証拠）`);

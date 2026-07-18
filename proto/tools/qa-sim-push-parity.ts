// PR2「武器計測器の v0.155 追随」parity 検証（2026-07-18）。
//   実行：cd proto && node --experimental-strip-types tools/qa-sim-push-parity.ts
//
// 背景＝main.ts:5090 pushEnemy の clear（着地点が空き床）分岐は、v0.155.0 バグ2 修正で
//   「相対移動させた敵の“古い move 予告”を wait に潰す」1行を持つ（さもないと直後の resolveMonsters が
//   その stale な move を適用し、押し出した座標を上書きしてしまう＝薙刀の会心押し出し等の過小評価）。
//   tools/sim-weapons.ts の realPush へ同一の1行を同期済み（このQAの前段タスク）。
//   本ツールはその同期が「runtime(main.ts pushEnemy) と sim(realPush) の挙動一致」を実際に満たすことを、
//   sim 側のエンジン関数（resolveMonsters・monsterCanReach・canBurstReach＝main.ts と共有する純粋関数）を
//   直接叩いて確認する。武器の数値・定数（SPEAR_ADJ_MUL 等）はここでは一切参照しない＝押し出し機構のみが対象。
//
// 検証内容：
//   (a) 距離2直線で@へ接近する move 予告を持つ敵を realPush（@から離れる向き）→ intent が wait になり、
//       位置が距離3（@から離れる側へ1マス）へ動く。
//   (b) 対比＝v0.155 以前の pushEnemy clear 分岐（位置だけ動かし intent は据え置き）を本ファイル内で
//       忠実に再現した prefixPushSim で同じ盤面を押し出したあと resolveMonsters を回すと、stale な move 予告が
//       消化されて距離1（@隣接）へ引き戻される＝修正前の症状を sim 側でも再現できることを示す。
//       続けて実際の realPush（修正後）で同じ盤面を押し出し resolveMonsters を回すと、intent は wait ゆえ
//       resolveMonsters の move 分岐を通らず、距離3の押し出し位置が維持されることを確認する。
//   (c) attack 予告を持つ敵の押し出しキャンセル（main.ts PR#351 の射程再判定）＝realPush 末尾の
//       monsterCanReach 呼び出しが reach1/reach2 で正しく分岐することを確認する（reach1＝押し出しで射程外へ
//       出て intent が wait に潰れる／reach2＝直線上でまだ届く距離なら intent の attack が温存される）。
//
// ★編集許可の範囲を厳守＝本ファイルは新規（tools/qa-sim-push-parity.ts）。sim-weapons.ts は realPush の
//   export 追加のみ（武器数値は無改変＝git diff で裏取り済み）。ゲーム本体（src/**・web/**）は不読み込みのみ
//   （resolveMonsters/monsterCanReach/canBurstReach を import して呼ぶだけ＝一切変更しない）。
import { realPush } from "./sim-weapons.ts";
import { resolveMonsters, monsterCanReach, canBurstReach } from "../src/dungeon.ts";
import type { Floor, Monster, MonsterKind, Pos } from "../src/dungeon.ts";

// ── 最小の開けた床（9x9・外周だけ壁・内部 1..7 は全床）。sim-weapons.ts の floorFromFixture と同型の最小シェイプ。
function mkFloor(): Floor {
  const w = 9, h = 9;
  const tiles = new Array(w * h).fill(1);
  for (let x = 0; x < w; x++) { tiles[x] = 0; tiles[(h - 1) * w + x] = 0; }
  for (let y = 0; y < h; y++) { tiles[y * w] = 0; tiles[y * w + w - 1] = 0; }
  return { w, h, tiles, monsters: [], fossils: [], chests: [], shrines: [], returnDoor: null, depth: 0,
    explored: new Array(w * h).fill(true), stairsUp: { x: 4, y: 4 }, stairsDown: { x: 4, y: 4 } } as unknown as Floor;
}
const isFloor = (f: Floor, x: number, y: number) => x >= 0 && y >= 0 && x < f.w && y < f.h && f.tiles[y * f.w + x] === 1;

function mkKind(over: Partial<MonsterKind> = {}): MonsterKind {
  return { key: "qa", glyph: "q", name: "検査体", hp: 20, dmg: 3, minDepth: 1, erratic: 0, tier: 1, ...over } as MonsterKind;
}
function mkMon(id: string, x: number, y: number, over: Partial<Monster> = {}): Monster {
  return { id, kind: mkKind(over.kind as Partial<MonsterKind> | undefined), hp: 20, x, y, awake: true, intent: null, ...over } as Monster;
}

// ── (b) の対比専用＝v0.155 以前の pushEnemy clear 分岐を忠実再現（位置だけ動かし intent は据え置き）。
//    ★これは「修正前の症状」を示すための本ファイル内ローカル関数＝realPush 自体は書き換えていない。
function prefixPushSim(f: Floor, E: Monster, px: number, py: number): void {
  const dx = Math.sign(E.x - px), dy = Math.sign(E.y - py);
  const nx = E.x + dx, ny = E.y + dy;
  if (isFloor(f, nx, ny) && !f.monsters.some((m) => m !== E && m.hp > 0 && m.x === nx && m.y === ny) && !(nx === px && ny === py)) {
    E.x = nx; E.y = ny; // ★ここで intent を wait に潰さない＝旧挙動（stale move 予告がそのまま残る）
  }
}

const results: { name: string; pass: boolean; extra?: string }[] = [];
const ok = (name: string, cond: boolean, extra = "") => {
  results.push({ name, pass: cond, extra });
  console.log(`${cond ? "✅" : "❌"} ${name}${extra ? "  " + extra : ""}`);
};

const player: Pos = { x: 4, y: 4 };

// ============ (a) move 予告を持つ敵の押し出し＝intent が wait に潰れ、距離3へ着地する ============
{
  const f = mkFloor();
  // 距離2直線（@の北2マス）。spawn直後の queued move は「@へ1歩接近」＝(4,3) を想定（e2e-push-intent.mjs と同型）。
  const mon = mkMon("mA", 4, 2, { intent: { type: "move", x: 4, y: 3 } });
  f.monsters.push(mon);
  const preIntent = mon.intent?.type;
  realPush(f, mon, player.x, player.y); // dx=0, dy=sign(2-4)=-1 → (4,1)＝@から離れる向き＝距離3
  ok("(a) 前提＝押し出し前の queued intent は move", preIntent === "move", `intent=${preIntent}`);
  ok("(a) 押し出し後＝距離3(4,1)へ着地", mon.x === 4 && mon.y === 1, `pos=(${mon.x},${mon.y})`);
  ok("(a) 押し出し後＝intent が wait に潰れる", mon.intent?.type === "wait", `intent=${JSON.stringify(mon.intent)}`);
}

// ============ (b) 対比＝修正前(prefixPushSim)は resolveMonsters で距離1へ引き戻される／修正後(realPush)は距離3を維持 ============
{
  // 修正前の再現：位置は押し出すが intent(move,4,3) を据え置いたまま resolveMonsters に渡す。
  const fBefore = mkFloor();
  const monBefore = mkMon("mB1", 4, 2, { intent: { type: "move", x: 4, y: 3 } });
  fBefore.monsters.push(monBefore);
  prefixPushSim(fBefore, monBefore, player.x, player.y);
  const afterPushBefore = { x: monBefore.x, y: monBefore.y, intent: monBefore.intent };
  resolveMonsters(fBefore, player);
  ok("(b) 対比＝修正前(prefixPushSim)は押し出し直後は距離3", afterPushBefore.x === 4 && afterPushBefore.y === 1, `pos=(${afterPushBefore.x},${afterPushBefore.y})`);
  ok("(b) 対比＝修正前は resolveMonsters が stale move を適用し距離1(4,3)へ引き戻す＝症状再現",
    monBefore.x === 4 && monBefore.y === 3, `pos=(${monBefore.x},${monBefore.y})`);

  // 修正後：realPush（intent を wait に潰す）→ resolveMonsters は move 分岐を通らず位置は距離3のまま。
  const fAfter = mkFloor();
  const monAfter = mkMon("mB2", 4, 2, { intent: { type: "move", x: 4, y: 3 } });
  fAfter.monsters.push(monAfter);
  realPush(fAfter, monAfter, player.x, player.y);
  const afterPushAfter = { x: monAfter.x, y: monAfter.y, intent: monAfter.intent };
  resolveMonsters(fAfter, player);
  ok("(b) 修正後＝realPush 直後は距離3かつ intent=wait", afterPushAfter.x === 4 && afterPushAfter.y === 1 && afterPushAfter.intent?.type === "wait",
    `pos=(${afterPushAfter.x},${afterPushAfter.y}) intent=${JSON.stringify(afterPushAfter.intent)}`);
  ok("(b) 修正後＝resolveMonsters を通しても距離3(4,1)を維持（runtime と一致）",
    monAfter.x === 4 && monAfter.y === 1, `pos=(${monAfter.x},${monAfter.y})`);
}

// ============ (c) attack 予告の押し出しキャンセル＝射程再判定（PR#351） ============
{
  // reach1（通常近接）＝隣接(距離1)から押し出されて距離2になれば intent は wait に潰れる（射程外＝キャンセル）。
  const f = mkFloor();
  const mon = mkMon("mC1", 4, 3, { kind: mkKind({ reach: 1 }), intent: { type: "attack", x: player.x, y: player.y } });
  f.monsters.push(mon);
  realPush(f, mon, player.x, player.y); // dy=sign(3-4)=-1 → (4,2)＝距離2
  const stillReach1 = monsterCanReach(f, mon.x, mon.y, player.x, player.y, 1);
  ok("(c) reach1＝押し出し後は射程外(cheb2>1)", !stillReach1, `pos=(${mon.x},${mon.y})`);
  ok("(c) reach1＝intent が wait にキャンセルされる", mon.intent?.type === "wait", `intent=${JSON.stringify(mon.intent)}`);
}
{
  // reach2（長柄型）＝隣接(距離1)から押し出されて距離2になっても直線上ならまだ届く＝intent(attack) は温存される。
  const f = mkFloor();
  const mon = mkMon("mC2", 4, 3, { kind: mkKind({ reach: 2 }), intent: { type: "attack", x: player.x, y: player.y } });
  f.monsters.push(mon);
  realPush(f, mon, player.x, player.y); // → (4,2)＝距離2・直線
  const stillReach2 = monsterCanReach(f, mon.x, mon.y, player.x, player.y, 2);
  ok("(c) reach2＝押し出し後も射程内(cheb2<=2・直線)", stillReach2, `pos=(${mon.x},${mon.y})`);
  ok("(c) reach2＝intent(attack) が温存される（反撃を受ける）", mon.intent?.type === "attack" && mon.intent.x === player.x && mon.intent.y === player.y,
    `intent=${JSON.stringify(mon.intent)}`);
}
{
  // 参考＝burst（PR3）は canBurstReach（Chebyshev 1..BURST_RANGE(2)＋視線）で判定される別枠。
  // 距離1→距離2の押し出しでは依然として炸裂は届く（dist2 は無傷にならない＝仕様どおり）。
  const f = mkFloor();
  const mon = mkMon("mC3", 4, 3, { kind: mkKind({ ability: "burst" }), intent: { type: "attack", x: player.x, y: player.y } });
  f.monsters.push(mon);
  realPush(f, mon, player.x, player.y); // → (4,2)＝距離2
  const stillBurst = canBurstReach(f, mon.x, mon.y, player.x, player.y);
  ok("(c-参考) burst＝距離2でも炸裂は届く（canBurstReach true）", stillBurst, `pos=(${mon.x},${mon.y})`);
  ok("(c-参考) burst＝距離2では intent(attack) が温存される（無傷にならない＝仕様）", mon.intent?.type === "attack", `intent=${JSON.stringify(mon.intent)}`);
}
{
  // burst をさらに1マス押し出せる盤面（距離2→距離3）＝射程外になり intent は wait に潰れる。
  const f = mkFloor();
  const mon = mkMon("mC4", 4, 2, { kind: mkKind({ ability: "burst" }), intent: { type: "attack", x: player.x, y: player.y } });
  f.monsters.push(mon);
  realPush(f, mon, player.x, player.y); // dy=sign(2-4)=-1 → (4,1)＝距離3
  const stillBurst = canBurstReach(f, mon.x, mon.y, player.x, player.y);
  ok("(c-参考) burst＝距離3では canBurstReach false（射程外）", !stillBurst, `pos=(${mon.x},${mon.y})`);
  ok("(c-参考) burst＝距離3では intent が wait に潰れる", mon.intent?.type === "wait", `intent=${JSON.stringify(mon.intent)}`);
}

const failed = results.filter((r) => !r.pass);
console.log(`\n=== QA sim-push-parity（PR2）：${results.length - failed.length}/${results.length} pass ===`);
if (failed.length) { console.log("FAILED:", failed.map((f) => f.name).join(", ")); process.exit(1); }

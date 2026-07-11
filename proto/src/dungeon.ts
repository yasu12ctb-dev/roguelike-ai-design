// ダンジョン層：フロア生成・視界(FOV)・モンスター（UI非依存の純ロジック）
// フロアは world.seed × 世代 × 深度 から決定論的に生成される。

import { makeRng, type Rng } from "./rng.ts";
import type { World, Fossil, Actor } from "./types.ts";
import { diffMods, EASY_MODS, type DifficultyMods } from "./difficulty.ts";

// 表示ビューポート（DOMグリッド）のサイズ。マップ自体はこれより大きく、カメラが @ を追う。
export const VIEW_W = 21;
export const VIEW_H = 23;

export type Tile = 0 | 1; // 0=岩盤(壁) 1=床
export interface Pos { x: number; y: number; }

interface MonsterKind {
  key: string; glyph: string; name: string;
  hp: number; dmg: number; minDepth: number; erratic: number; // erratic=ランダム移動率
  tier: number; // 強さの段（1=雑魚 … 5=最危険）。記号=種類／色=tier で可視化（4-11F）。
  maxDepth?: number; // この深度を超えると出現しない（最弱種の深層フェードアウト：2026-06-23）。
  ability?: MonsterAbility; // 特殊能力（テレグラフ準拠・web限定＝planMonsters/resolveMonsters で実装。未指定＝素の近接）。
  reach?: number; // 攻撃射程（フェーズ2・2026-07-09）。未指定=1（隣接）。≥2＝直線の距離2から突く長柄型＝1マス押し出しても届く（押し出しの読み合い④）。
}
// モンスター特殊能力（4-11G・2026-06-23）：すべてテレグラフ準拠・決定論。素の dmg は据え置きテクスチャを足す方針。
//   ranged ＝射程から狙撃（接近で間合いを取り直す＝接近が弱点）／venom ＝命中でプレイヤーに毒（継続ダメ）／
//   leech  ＝命中ぶん自己回復（しぶとい）／breeder ＝たまに隣に弱い眷属を湧かす（数の圧・総数上限）。
//   reflect ＝近接で殴られると一部を反射（術/投擲を促す・深淵帯／PR2 2026-06-28）／
//   curse  ＝命中でプレイヤーの深蝕を上塗り（深淵帯の侵蝕・PR2）。reflect/curse は minDepth>50 限定＝golden(≤42)不変。
//   charge ＝直線上の間合い（距離2〜CHARGE_MAX）から「突進＋一撃」を予告→隣接まで一気に詰める（フェーズ1・2026-07-09）。
//           ＝槍のカイト（後退で間合いを保つ）を封じる“詰め手”。予告（テレグラフ）を見て直線から退けば空振り（見切り）だが、
//           突進側は着地点まで移動する＝距離は詰められる＝距離1で弱い槍を近距離戦に引きずり込む。
//   ───── 形つき予告の一般敵展開（PR1・2026-07-10・ユーザー承認）＝ボス限定だった「複数マスを覆う確定範囲」を一般敵へ。
//   単点予告（@の今いるマス）は1歩ずれれば全空振り＝逃げマスが常在するのが無被弾の根＝形つきで逃げマスを消す。全て 1手前テレグラフ・確定命中・予告マス全描画（4-11A 可読性契約）。
//   arc  ＝隣接時、@のマス＋左右±45度の前方弧3マスを薙ぐ（毎手・通常攻撃の形版）＝弧の外（斜め後ろ等）へ退けば空振り。
//   slam ＝@隣接で周囲8マス全部を叩きつける（CD 2＝叩き後2手は通常追跡＝この間に殴り込める）＝隣接張り付き（各個撃破）を罰す＝距離2へ離れよ。
//   beam ＝直線8方向・距離1〜BEAM_MAX に@が居るとき、敵の隣から@までの直線を撃ち抜く（CD 1＝1手おき）＝幅1通路の天敵（直線から外れられない）。接近されてもその場で撃つ（退避しない）。
//   ───── 回避不能の炸裂（burst・PR3・2026-07-11・ユーザー承認）＝arc/slam/beam は「1歩ずれれば逃げマスがある」dodge可能な形だが、burst は逃げマスを完全に消す。
//   burst ＝@が Chebyshev≤BURST_RANGE(2) かつ視線が通るとき、@の現在マスを中心とした3×3（本人＋周囲8マスの床）を予告→次手で炸裂（CD BURST_CD=3）。
//          3×3が全隣接を覆う＝1手でどこへ動いても範囲内＝移動では避けられない。解答は資源＝(a)炸裂前に倒す（1手猶予・低HP）／
//          (b)押し出しで詠唱者を dist>2 の外へ出す（pushEnemy が予告をキャンセル）／(c)ブリンク術で@自身が抜ける。★easy には出さない（normal/hard 限定＝golden 完全不変）。
export type MonsterAbility = "ranged" | "venom" | "leech" | "breeder" | "reflect" | "curse" | "charge" | "arc" | "slam" | "beam" | "burst";
export const RANGED_MAX = 4;        // 狙撃の最大射程（これ以遠は間合いを詰める）
export const CHARGE_MAX = 4;        // 突進の最大射程（直線でこの距離まで一気に詰める）
const CHARGE_CD = 3;                // 突進後のクールダウン（毎手 charge せず・間に通常追跡/攻撃を挟む）
export const BEAM_MAX = 3;          // ビーム（beam）の最大射程（直線でこの距離まで貫く）
const SLAM_CD = 2;                  // 叩きつけ（slam）後のクールダウン（2手は通常追跡＝殴り込む窓）
const BEAM_CD = 1;                  // ビーム（beam）のクールダウン（1手おき＝撃たれない手番に接近できる＝詰み回避）
export const BURST_RANGE = 2;       // 炸裂（burst・PR3）：@が Chebyshev この距離以内＋視線が通るとき 3×3 を予告する最大射程（＝距離1・2から回避不能の炸裂）
const BURST_CD = 3;                 // 炸裂（burst・PR3）のクールダウン（毎手 burst しない＝倒す/押し出す/離す猶予を挟む）。テスト調整候補
// 形つき敵（arc/slam/beam）の spawn 重み（PR1）。一様抽選だと pool の~10%＝薄く、最適プレイヤーは孤立した形つき敵を捌けてしまう。
// spawn 時のみ重み付けして密度を上げる＝形つきの予告が重なり「逃げマスが本当に消える」局面を作る。★総配置数は不変（composition をシフトするだけ＝
// 通常敵を形つき敵に置き換える＝終始シビアの総ダメージ収支は概ね中立・実際の被弾は上がる＝それが本 PR の狙い）。sim で d30 normal の無被弾を目標帯へ合わせ込む。
const SHAPED_ABILITIES = new Set<MonsterAbility>(["arc", "slam", "beam"]);
// burst（回避不能・PR3）は arc/slam/beam（dodge可能）よりはるかに罰が重い＝同じ重み4だと過剰（sim 実測で d30 normal 無被弾 22%・CLEAR 30%＝死の博打化）。
// 別枠の低い重みで積む＝「たまに混じる回避不能」に留める。normal/hard 限定（pool から easy は除外済み＝golden 不変）。sim で d30 normal 無被弾を目標帯（40〜55%）へ合わせ込む。
export const BURST_WEIGHT = 1;      // 爆ぜ胞子を spawn プールに何倍で積むか（normal/hard）。sim 実測で決定＝自然頻度(重み1)が最適＝
                                    // d30 normal traverse 無被弾 72%→43%（目標帯 40〜55%に着地）・CLEAR 57%→53%（≥45% 維持）／d25 無73%→48%・CL57%→42%（>40% の死の博打化を回避）。
                                    // 重み2以上は CLEAR を 40% 未満へ沈める（D25 で 35%＝死の博打化）ため 1 を採用。テスト調整候補。
export const SHAPED_WEIGHT = 4;     // 各形つき種を spawn プールに何倍で積むか。sim（tools/dodgefloor＝最適ダッジボット）実測で決定＝
                                    // d30 normal traverse 無被弾 93%(単点予告)→61%(重み4)＝逃げマスを消せた／d15 normal 88%(中盤は緩やか)／easy d30 69%(快適無双を過度に崩さない)／
                                    // CLEAR率は全深度 ≥45%。重み6+は normal を目標帯へさらに沈めるが easy と CLEAR を過度に削るため 4 を採用。テスト調整候補。
export const BREED_CHANCE = 0.16;   // breeder が1手に眷属を湧かす確率（クールダウン併用）
export const BREED_CD = 6;          // 眷属を湧かしたあとの待機手数
export const MONSTER_HARDCAP = 60;  // フロアの敵総数の上限（breeder の暴走防止）
// ───── 群れ増量（fodder・A｜v0.123.0・2026-07-05・ユーザー承認）─────
//   低tier雑魚（tier<=FODDER_MAX_TIER）を通常配置数×FODDER_MUL だけ追加＝「盤面に散った圧」を作る。
//   ①全難易度で増量（難易度ゲートにしない）／②増やすのは fodder のみ＝強敵の数・個体スケールは不変（脅威曲線を保つ）／
//   ③地形は既存の幅1 L字通路＋2マス岩間隔がチョーク＝同時隣接を1〜2に絞れる逃げ場を確保／
//   ④golden(genFloor) は意図的に再生成／⑤sim（tools/sim-combat.ts の floorRun）でHPコストが既存帯に収まることを実測。
//   深度1〜2は増やさない（序盤の手触り・チュートリアル性）。総数は MONSTER_HARDCAP を厳守。
//   FODDER_MUL は genFloor の opts.fodderMul で上書き可（sim の対照＝0／golden monsterAI の据置＝0）。
export const FODDER_MUL = 0.2;      // 通常配置数に対する追加割合（sim 指標D 実測で 0.5→0.2 に採用＝全深度×難易度でHPコスト+25%以内・テスト調整候補）。
                                     // ★PR2（v0.146.0）以降は easy 専用の既定値＝実際の割合は difficulty.ts の DifficultyMods.fodderMul（easy=この値のまま・normal/hard/death のみ増量）。
export const FODDER_MIN_DEPTH = 3;  // これ未満の深度は増量しない
const FODDER_MAX_TIER = 2;          // 追加するのは tier<=2 の低級種のみ（fodder＝低HP/低火力）
// ───── 部屋クラスタ配置（案C・v0.140.0・2026-07-08・ユーザー承認）─────
//   ★武器バリエーション（薙刀の弧の薙ぎ／剣の受け流し）は「複数体が同時に隣接する開所」でこそ輝く。
//   だが幅1通路のチョークが同時隣接を2〜3に固定するため、fodder を全域に散らすだけでは通路が渋滞するだけで
//   開所の同時遭遇は生まれない（Sonnet 定量検討＝真のレバーは“数”でなく“配置”）。そこで fodder 総数は変えず
//   （＝終始シビアの総ダメージ収支は不変）、その一部を「部屋の中心に固めて」配置する＝薙刀/パリィが活きる場面を狙って作る。
//   開始部屋・ボス/下り部屋は除外（開幕蒸発/階段前の理不尽を避ける）。総数は MONSTER_HARDCAP を厳守。
const FODDER_CLUSTER_FRAC = 0.6;    // fodder 総数のうちクラスタに回す割合（序盤・残りは全域に散布）＝配置の形だけ変える
const FODDER_CLUSTER_SIZE = 3;      // 序盤の1クラスタ最大 fodder 数（薙刀の薙ぎが丁度3マス＝3体クラスタが最適標的）
const FODDER_CLUSTER_RADIUS = 2;    // 部屋中心からこの範囲（Chebyshev）に固める
// ───── 中盤以降だけ“群れ”を効かせる深度スケール（v0.143.0・2026-07-09・ユーザー承認）─────
//   守勢の剣シムで判明＝1対1は全深度で解ける（面白さの核）／単体戦を脅かせるのは“数”だけ／群れは4〜5体で剣を崩す。
//   そこで序盤（d<MID）は今のまま（オンボーディング不変）、中盤以降だけクラスタを大きく・より固める＝
//   剣の1対1解法が通じにくい「4〜5体同時遭遇」を、難易度が本来効くべき帯にだけ作る。総 fodder 数は不変（塊を大きくする＝固めるだけ）。
//   ★easy は据え置き（「快適に無双」の位置づけ＝size3 のまま／sim 指標D で easy 中盤が過重になるのを回避）＝normal/hard 限定。
//   ★easy 据え置き＝golden(genFloor＝diffMods(undefined)=easy) も完全不変（scale=false で従来経路）。
const FODDER_CLUSTER_MID_DEPTH = 10;  // これ以上でクラスタを大きくし始める（d<10 は完全不変＝序盤の手触り）
const FODDER_CLUSTER_DEEP_DEPTH = 20; // これ以上で最大（5体）
// ───── クラスタ護衛（PR2・v0.146.0・2026-07-10・ユーザー承認）─────
//   fodder クラスタは「囲まれる状況」の器だが、幅1通路のチョークに逃げ込めば結局クラスタ全体が渋滞して脅威にならない。
//   そこでクラスタが成立した部屋ごとに、チョーク破りの能力（突進/形つき/長柄）を持つ護衛を1体増設し、
//   「chokeに引き込んでも追い詰められる／通路の先から薙がれる」状況を作る。normal/hard 限定（bigCluster ゲート内）＝
//   easy は escortPool を作らず rng も一切消費しない（golden 完全不変）。総数は MONSTER_HARDCAP を厳守（超えたら諦める）。
const CLUSTER_ESCORT_ABILITIES = new Set<MonsterAbility>(["charge", "arc", "slam", "beam", "burst"]);
/** クラスタ成立部屋1つあたりの護衛数（仕様どおり1体）。dodgefloor（最適ダッジ・ボット）実測でクラスタ内の
 *  護衛数を増やしても「経路上に現れる確率」自体は変わらない（クラスタは大マップの一部屋に限られるため）と
 *  判明＝護衛数を積む効果は下の scatterEscortCount（全域散布）に譲る。テスト調整候補。 */
function clusterEscortCount(depth: number): number {
  return 1;
}
/** 散布護衛数：クラスタは大マップのうちごく一部の部屋（決定論シャッフルの先頭数室）に限られ、
 *  @の最短経路（stairsUp→stairsDown）がそこを通らないことが多い（dodgefloor 実測で確認）＝
 *  クラスタ内護衛の数を増やしても「経路上に現れる確率」は変わらない。マップ全域に散る fodder 同様、
 *  護衛の一部も randomFloorAway で全域散布し、経路との交差率を上げる（PR2 sim実測で確定・テスト調整候補）。 */
function scatterEscortCount(depth: number): number {
  if (depth < FODDER_CLUSTER_MID_DEPTH) return 0;
  if (depth < FODDER_CLUSTER_DEEP_DEPTH) return 1;
  return 3;
}
/** クラスタ最大サイズ（scale=normal/hard のみ深度スケール）：序盤3（不変）→中盤4→深部5。easy は常に3。 */
function fodderClusterSize(depth: number, scale: boolean): number {
  if (!scale || depth < FODDER_CLUSTER_MID_DEPTH) return FODDER_CLUSTER_SIZE;
  if (depth < FODDER_CLUSTER_DEEP_DEPTH) return FODDER_CLUSTER_SIZE + 1;
  return FODDER_CLUSTER_SIZE + 2;
}
/** クラスタに回す割合（scale=normal/hard のみ深度スケール）：中盤以降ほど固める。序盤・easy は据え置き。総数は不変。 */
function fodderClusterFrac(depth: number, scale: boolean): number {
  if (!scale || depth < FODDER_CLUSTER_MID_DEPTH) return FODDER_CLUSTER_FRAC;
  if (depth < FODDER_CLUSTER_DEEP_DEPTH) return 0.75;
  return 0.85;
}
// エリアボスの戦術化（4-11G Phase 3・B・web限定／全て m.boss==="area" ゲート＝通常敵・golden 不変）。
//   ①溜め大技＝隣接時に「渾身の一撃」を予告（テレグラフ）→退けば空振り・受ければ BOSS_HEAVY_MULT 倍。CD 併用。
//   ②怒りフェーズ＝HP が BOSS_ENRAGE_AT 以下で一度きり覚醒＝攻撃 +BOSS_ENRAGE_DMG_FRAC・大技 CD 短縮。
//   ③眷属召喚＝覚醒後にときどき脆い眷属（breederMinion 流用・MONSTER_HARDCAP 管理）。
export const BOSS_HEAVY_CD = 4;          // 大技の間隔（隣接戦で N 手ごと）
export const BOSS_HEAVY_CD_ENRAGED = 2;  // 覚醒後は短縮
export const BOSS_HEAVY_MULT = 2;        // 大技の倍率
export const BOSS_HEAVY_GRACE = 2;       // 接敵直後の即・大技を避ける猶予
export const BOSS_ENRAGE_AT = 0.5;       // HP がこの割合以下で覚醒
const BOSS_ENRAGE_DMG_FRAC = 0.25;       // 覚醒の攻撃上乗せ
export const BOSS_SUMMON_CHANCE = 0.2;   // 覚醒中に眷属を呼ぶ確率（CD 併用）
export const BOSS_SUMMON_CD = 4;         // 召喚後の待機手数
const SPAWN_BASE: MonsterKind = { key: "spawn", glyph: "z", name: "蟲の眷属", hp: 2, dmg: 1, minDepth: 1, erratic: 0.3, tier: 1 };
/** breeder が産む弱い眷属（深度連動だが通常雑魚の 35%HP/50%dmg＝数で圧すが個は脆い）。 */
export const breederMinion = (depth: number, mods: DifficultyMods = EASY_MODS): MonsterKind => {
  const k = scaleKind(SPAWN_BASE, depth, mods);
  return { ...k, hp: Math.max(2, Math.round(k.hp * 0.35)), dmg: Math.max(1, Math.round(k.dmg * 0.5)) };
};
// 記号＝種類（小文字=並／大文字=強）、色＝tier。深いほど上位種が混じり緊張感が増す。
// 深度係数（scaleKind）が HP/dmg を底上げするので base は種の個性。深層（28/35/42）に上位種を追加（監査B1）。
export const MONSTER_KINDS: MonsterKind[] = [
  { key: "rat",    glyph: "r", name: "大鼠",     hp: 3,  dmg: 1, minDepth: 1,  erratic: 0.3,  tier: 1, maxDepth: 20 },
  { key: "beetle", glyph: "k", name: "鎧蟲",     hp: 8,  dmg: 1, minDepth: 1,  erratic: 0.1,  tier: 2, maxDepth: 48 }, // 硬い・低火力（一撃で倒せない壁）。深淵帯(>48)では退場＝雑魚を間引く
  { key: "bat",    glyph: "b", name: "洞蝙蝠",   hp: 2,  dmg: 1, minDepth: 2,  erratic: 0.6,  tier: 1, maxDepth: 24 },
  { key: "snake",  glyph: "s", name: "石蛇",     hp: 5,  dmg: 2, minDepth: 5,  erratic: 0.2,  tier: 2, maxDepth: 48 },
  { key: "ghoul",  glyph: "g", name: "屍喰らい", hp: 7,  dmg: 2, minDepth: 9,  erratic: 0.1,  tier: 3 },
  { key: "wisp",   glyph: "w", name: "迷い火",   hp: 4,  dmg: 3, minDepth: 13, erratic: 0.4,  tier: 3 },
  { key: "wraith", glyph: "W", name: "怨霊",     hp: 10, dmg: 3, minDepth: 16, erratic: 0.15, tier: 4 },
  { key: "ogre",   glyph: "O", name: "石鬼",     hp: 14, dmg: 4, minDepth: 22, erratic: 0.05, tier: 5 },
  // 特殊能力つき（4-11G・seed＝枠組みの実証。Phase 2 で各能力×深度帯を量産）。素の dmg は控えめ＝テクスチャ重視。
  { key: "spitter", glyph: "j", name: "吐酸蟲", hp: 5,  dmg: 2, minDepth: 7,  erratic: 0.2,  tier: 2, ability: "ranged" },  // 射程から酸を吐く（接近で間合いを取り直す）
  { key: "viper",   glyph: "v", name: "毒牙蛇", hp: 5,  dmg: 2, minDepth: 6,  erratic: 0.2,  tier: 2, ability: "venom" },   // 噛みつきで毒（継続ダメ）
  { key: "leecher", glyph: "l", name: "吸血蛭", hp: 9,  dmg: 2, minDepth: 11, erratic: 0.1,  tier: 3, ability: "leech" },   // 命中ぶん自己回復＝しぶとい
  { key: "brood",   glyph: "m", name: "孵化巣", hp: 12, dmg: 1, minDepth: 14, erratic: 0.05, tier: 3, ability: "breeder" }, // たまに眷属を湧かす（数の圧）
  { key: "troll",  glyph: "T", name: "蝕喰鬼",   hp: 20, dmg: 5, minDepth: 28, erratic: 0.05, tier: 5 }, // 深層の壁役（高HP）
  { key: "drake",  glyph: "D", name: "深淵竜",   hp: 24, dmg: 6, minDepth: 35, erratic: 0.1,  tier: 5 }, // 高火力
  { key: "horror", glyph: "Y", name: "虚無の貌", hp: 28, dmg: 7, minDepth: 42, erratic: 0.2,  tier: 5 }, // 最深・不規則で読みにくい
  // ───── Phase 2 量産（4-11G・能力×深度帯×テーマで分散。素の dmg は据え置き＝テクスチャ重視）─────
  // 近接の個性（速い/硬い/凶悍）＝能力種を薄める母数＋戦術の手触り。
  { key: "imp",     glyph: "i", name: "小鬼",     hp: 3,  dmg: 2, minDepth: 3,  erratic: 0.5,  tier: 1, maxDepth: 48 }, // 速いが脆い（早期の手触り）。深淵帯では退場
  { key: "crawler", glyph: "n", name: "這い虫",   hp: 4,  dmg: 2, minDepth: 5,  erratic: 0.3,  tier: 2, maxDepth: 48 },
  { key: "hound",   glyph: "h", name: "影狼",     hp: 6,  dmg: 3, minDepth: 10, erratic: 0.25, tier: 3 }, // 俊敏で詰めが速い
  { key: "brute",   glyph: "B", name: "鉄腕鬼",   hp: 16, dmg: 3, minDepth: 13, erratic: 0.05, tier: 4 }, // 硬い壁役
  { key: "reaver",  glyph: "e", name: "斬鬼",     hp: 10, dmg: 4, minDepth: 20, erratic: 0.2,  tier: 4 }, // 高火力近接
  { key: "charger", glyph: "d", name: "突貫獣",   hp: 8,  dmg: 3, minDepth: 7,  erratic: 0.05, tier: 3, ability: "charge" }, // 直線から突進＝カイト封じ（詰め手）
  { key: "lancer",  glyph: "K", name: "鉄蹄の兵", hp: 16, dmg: 5, minDepth: 24, erratic: 0.05, tier: 4, ability: "charge" }, // 深部の突進兵（硬く痛い詰め手）
  { key: "thruster",glyph: "p", name: "刺突鬼",   hp: 9,  dmg: 3, minDepth: 11, erratic: 0.1,  tier: 3, reach: 2 }, // 長柄＝射程2で突く。1マス押しても届く（押し出しの読み合い④）
  { key: "pikeman", glyph: "L", name: "長柄鬼",   hp: 18, dmg: 5, minDepth: 30, erratic: 0.05, tier: 4, reach: 2 }, // 深部の長柄＝射程2の壁
  { key: "golem",   glyph: "F", name: "石塊兵",   hp: 20, dmg: 4, minDepth: 24, erratic: 0.03, tier: 5 }, // 鈍重だが頑強
  { key: "gloom",   glyph: "G", name: "闇塊",     hp: 22, dmg: 5, minDepth: 27, erratic: 0.1,  tier: 5 },
  { key: "phantom", glyph: "P", name: "惑影",     hp: 18, dmg: 6, minDepth: 38, erratic: 0.4,  tier: 4 }, // 不規則で読みにくい
  { key: "colossus",glyph: "C", name: "巨躯",     hp: 30, dmg: 7, minDepth: 40, erratic: 0.03, tier: 5 }, // 最深の壁
  // 遠隔（ranged）：深度帯ごとに狙撃手を分散。
  { key: "archer",  glyph: "a", name: "骨射手",   hp: 8,  dmg: 3, minDepth: 18, erratic: 0.15, tier: 3, ability: "ranged" },
  { key: "seer",    glyph: "Q", name: "虚空の眼", hp: 16, dmg: 5, minDepth: 36, erratic: 0.15, tier: 4, ability: "ranged" }, // 深部の狙撃
  // 毒（venom）：中層胞子〜深層腐蝕。
  { key: "spore",   glyph: "c", name: "毒胞子",   hp: 9,  dmg: 2, minDepth: 16, erratic: 0.1,  tier: 3, ability: "venom" },
  { key: "slug",    glyph: "u", name: "腐蝕蛞蝓", hp: 18, dmg: 4, minDepth: 30, erratic: 0.1,  tier: 4, ability: "venom" },
  { key: "wailer",  glyph: "A", name: "哭き女",   hp: 16, dmg: 4, minDepth: 34, erratic: 0.2,  tier: 4, ability: "venom" }, // 深部の毒
  // 吸命（leech）／増殖（breeder）の深部版。
  { key: "drainer", glyph: "H", name: "喰命鬼",   hp: 18, dmg: 5, minDepth: 26, erratic: 0.1,  tier: 4, ability: "leech" },
  { key: "mother",  glyph: "M", name: "母胎",     hp: 24, dmg: 3, minDepth: 32, erratic: 0.05, tier: 4, ability: "breeder" }, // 深部の数の圧
  // ───── 形つき予告の一般敵（PR1・2026-07-10）＝複数マスを覆う確定範囲で「逃げマス」を消す。中盤〜深部に分散。─────
  { key: "whirl",   glyph: "X", name: "旋刃鬼",   hp: 10, dmg: 3, minDepth: 12, erratic: 0.1,  tier: 3, ability: "arc" },  // 隣接で前方弧3マスを薙ぐ＝弧の外へ退け
  { key: "quaker",  glyph: "N", name: "震地鬼",   hp: 20, dmg: 4, minDepth: 18, erratic: 0.03, tier: 4, ability: "slam" }, // 隣接で周囲8マスを叩く＝間合いを離せ（鈍重・高HP）
  { key: "piercer", glyph: "y", name: "射抜きの眼", hp: 13, dmg: 5, minDepth: 24, erratic: 0.1, tier: 4, ability: "beam" }, // 直線を撃ち抜く＝線から外れよ（通路の天敵）
  { key: "burster", glyph: "*", name: "爆ぜ胞子", hp: 16, dmg: 4, minDepth: 20, erratic: 0.1, tier: 4, ability: "burst" }, // 3×3を回避不能に炸裂＝倒す/押し出す/離すで凌ぐ（normal/hard 限定・easy 除外＝golden 不変）
  // ───── 深淵帯（深度50超）の専用種＝真のエンドゲーム（PR2・2026-06-28・abyssalScale と相乗）─────
  //   minDepth>50 ゆえ golden 指紋深度(≤42)のスポーンプールに入らない＝genFloor/monsterAI 不変（裏取り済み）。
  //   2つの新能力（reflect/curse）を投入し、深部が「数値スケールのみ」でなく挙動でも変わるようにする。
  { key: "voiddrake",  glyph: "Δ", name: "虚無竜",     hp: 34, dmg: 8, minDepth: 52, erratic: 0.1,  tier: 5 },                       // 素の壁・高火力
  { key: "thornward",  glyph: "Φ", name: "棘の番人",   hp: 32, dmg: 6, minDepth: 54, erratic: 0.05, tier: 5, ability: "reflect" },   // 近接を罰する（術/投擲を促す）
  { key: "defiler",    glyph: "Σ", name: "蝕みの影",   hp: 28, dmg: 6, minDepth: 56, erratic: 0.2,  tier: 5, ability: "curse" },     // 命中で深蝕を上塗り
  { key: "voideye",    glyph: "Ω", name: "虚無の瞳",   hp: 26, dmg: 7, minDepth: 60, erratic: 0.15, tier: 5, ability: "ranged" },    // 深淵の狙撃
  { key: "abyssmaw",   glyph: "Λ", name: "群肉の母胎", hp: 36, dmg: 5, minDepth: 64, erratic: 0.05, tier: 5, ability: "breeder" },   // 深淵の数の圧
  { key: "endbringer", glyph: "Ξ", name: "終焉の貌",   hp: 42, dmg: 9, minDepth: 70, erratic: 0.2,  tier: 5 },                       // 最深の壁・最高火力
];

// 深度係数（終始シビア・無限スケール 4-11F②）。種の堅さ（早期の差）に深度ぶんを上乗せ＝
// 深いほど堅く痛い。撃破XPは kind.hp 由来なので、スポーン時に深度ぶんを焼き込めば XP も深度連動する（Lv≈深度）。
export const depthHpBonus = (depth: number) => Math.round(depth * 1.6);
export const depthDmgBonus = (depth: number) => Math.round(depth * 0.18);
/** 深淵帯ギア（深度50超の急峻な逓増・4-14G 後続）。深度50以下は厳密に 1.0＝従来不変（golden 安全）。
 *  深度60→×1.5／70→×2.0／80→×2.5。線形ベース（depthHpBonus 等）に上乗せ＝「50より下は真のエンドゲーム」。
 *  K は HP/dmg 共通の初期値。数値はテストプレイ調整候補。 */
const ABYSSAL_K = 0.05;
export const abyssalScale = (depth: number) => depth <= 50 ? 1 : 1 + (depth - 50) * ABYSSAL_K;
/** その深度の「標準的な雑魚」HP（6+1.6d）＝ボス/エリート/追手の算出基準。 */
export const regularHpAt = (depth: number) => 6 + depthHpBonus(depth);
/** 種＋深度係数の実体（雑魚スポーンに使う。hp/dmg を深度ぶん底上げ＝撃破XP・被ダメも深度連動）。
 *  難易度（4-11H）は mods で乗数＋火力床を焼き込む。既定 easy＝×1.0/+0＝整数のまま＝従来値（golden 不変）。
 *  深度50超は abyssalScale で更に急峻に逓増（depth≤50 は ×1.0＝不変）。 */
export const scaleKind = (k: MonsterKind, depth: number, mods: DifficultyMods = EASY_MODS): MonsterKind =>
  ({ ...k,
     hp: Math.round((k.hp + depthHpBonus(depth)) * mods.enemyHp * abyssalScale(depth)),
     dmg: Math.round((k.dmg + depthDmgBonus(depth)) * mods.enemyDmg * abyssalScale(depth)) + mods.dmgFloor });

/** 敵の次手のテレグラフ（4-11A 読める盤面）。move=ここへ動く / attack=このマスを討つ */
export type MonsterIntent =
  | { type: "attack"; x: number; y: number; ranged?: boolean; heavy?: boolean; charge?: boolean; dest?: Pos; cells?: Pos[]; shape?: number } // ranged=遠隔の狙撃／heavy=ボスの渾身の一撃（B・テレグラフ・退けば空振り）／charge=突進（dest=着地点まで直線を詰めてから討つ）／cells=形つき確定範囲（D・area ボス／PR1 の一般敵 arc/slam/beam・全マス予告）／shape=形の種別（0直線/1扇/2薙ぎ・ボス大技のみ）
  | { type: "move"; x: number; y: number }
  | { type: "wait" };

export interface Monster extends Pos {
  id: string; kind: MonsterKind; hp: number; awake: boolean;
  intent: MonsterIntent | null;  // 次ターンに実行する予告（プレイヤーに見える）
  stunned?: number;              // >0 の間は行動不能（静止の眼：4-11F③）
  slowed?: number;               // >0 の間は1手おきにしか動けない（鈍り：4-11F③）
  fear?: number;                 // >0 の間は標的から逃げる（畏れ：4-11F③）
  confused?: number;             // >0 の間はランダム移動（惑乱：4-11F③）
  rooted?: number;               // >0 の間は移動不可（隣接なら攻撃は可）（縛鎖：4-11F③）
  weak?: number;                 // >0 の間は攻撃力減（蝕み：4-11F③）。減算量は WEAK_AMT
  poison?: number;               // >0 の間は毎手 poisonDmg を受ける（腐喰＝継続ダメ：4-11F③）
  poisonDmg?: number;            // 腐喰の1手あたりダメージ（詠唱時の理で決まる）
  boss?: "elite" | "area";       // 中ボス（奥の強敵）／エリアボス（節目の山場）：4-11F
  fossilId?: string;             // 出自の化石（敵性化した探索者）。⑤鎮め筋の対象（4-11D）
  breedCd?: number;              // breeder：眷属を湧かしたあとの待機手数（4-11G）
  chargeCd?: number;             // charge：突進後のクールダウン（毎手 charge しない）
  slamCd?: number;               // slam：叩きつけ後のクールダウン（PR1・毎手 slam しない＝殴り込む窓）
  beamCd?: number;               // beam：ビームのクールダウン（PR1・1手おき＝撃たれない手番に接近できる）
  burstCd?: number;              // burst：炸裂のクールダウン（PR3・毎手 burst しない＝倒す/押し出す猶予）
  enraged?: boolean;             // ボス（area）：HP 半減で覚醒済み（B・攻撃↑＋大技CD短縮）
  bigCd?: number;                // ボス（area）：渾身の一撃のクールダウン（B・溜め大技）
  bigShape?: number;             // ボス（area）：次の大技の形（D・0直線/1扇/2薙ぎを大技ごとに巡回）
  summonCd?: number;             // ボス（area）：覚醒後の眷属召喚クールダウン（B）
}
interface FossilEntity extends Pos {
  id: string; fossilId: string; resolved: boolean; // resolved=このフロアで対面済み
}
export interface Chest extends Pos {
  id: string; opened: boolean;   // 宝箱（開けると中身を抽選：4-12 chest）
  relic?: boolean;               // 聖遺物（奉献の試練・深淵帯の主が守る：4-13B）
}
// 回復ノード（深蝕リワーク v2）：踏むと一度だけ効く＝使うと消える。
//   rest  ＝安息所（深蝕を浄化）／spring＝回復の泉（HPを癒す）。
//   設置数は深さで調整（深いほど多い）。泉は深層で1階確定・浅中はランダム（genFloor）。
export type ShrineKind = "rest" | "spring";
export interface Shrine extends Pos {
  id: string; kind: ShrineKind; used: boolean;
}
// 同行（相棒）の盤上エンティティ（4-14C）。潜行中だけ生きる ephemeral。@に追従し隣接攻撃、テレグラフを出す。
export interface CompanionEntity extends Pos {
  hp: number; maxHp: number;
  intent: MonsterIntent | null;  // 次手の予告（モンスターと同じ語彙＝決定論・読める盤面）
  stunned?: number;
  erratic?: number;              // 連帯深蝕で生じる挙動のぶれ率（Phase B：奇癖→逸脱。0=正気）
  crisisShown?: boolean;         // 危険化（C）の決断を今のエピソードで提示済みか（Phase B）
  dmg?: number;                  // 攻撃力（4-4E：等級で変動。未設定なら COMPANION_DMG）
}
// フロアに横たわる手負いの冒険者（4-14C 入口B：救助＝相棒化／見捨て＝後世の宿敵）。
export interface DownedActor extends Pos {
  id: string; actor: Actor;
}

// 迷宮を同時に潜っている「生きた他の冒険者」（4-14・すれ違いの軽いイベント）。接触で会話＝一度きり。
export interface DelverActor extends Pos {
  id: string; actor: Actor;
}

export interface Floor {
  depth: number;
  w: number; h: number;          // マップ寸法（深度でスケール。ビューより大きい）
  tiles: Tile[];                 // w * h
  stairsUp: Pos; stairsDown: Pos;
  monsters: Monster[];
  fossils: FossilEntity[];
  chests: Chest[];
  shrines: Shrine[];             // 安息所/回復の泉（一度使用で消える：深蝕リワーク v2）
  returnDoor?: Pos | null;       // 帰還の扉（エリアボス撃破で出現＝潜行中の往復チェックポイント：v2）
  explored: boolean[];           // 既踏破（記憶表示用）
  downed?: DownedActor | null;   // 手負いの冒険者（任意。enterFloor が稀に配置：4-14C）
  delver?: DelverActor | null;   // 同時に潜る生者の冒険者（任意。enterFloor が時々配置：すれ違いの軽イベント）
  aurelSite?: { x: number; y: number; kind: "mark" | "laila" } | null; // メインの縦糸（4-15）：始祖の遺構「痕」／ライラ・境（web が章に応じて配置＝engine は触らない・golden 安全）
  hazards?: { x: number; y: number; kind: "fire" | "venom" | "crumble" | "miasma" | "frost"; cracked?: number; turns?: number }[]; // 地形ハザード（v0.128.0／v0.130.0 で frost・turns 追加）：web が enterFloor 初訪で seeded 配置＝engine 非使用＝golden 安全（aurelSite と同じパターン）。cracked＝崩れかけの床の崩落カウントダウン。frost＝術で敷く鈍化の霧。turns＝寿命（術で敷いた地形は毎手デクリメント→0 で消滅・自然配置は undefined＝恒久）。
  diff?: DifficultyMods;         // このフロアの難易度係数（genFloor で焼き込む。動的スポーン＝追手/眷属が読む）。未設定＝easy。
}

/** マップ座標 → tiles/explored の添字（フロアの幅で決まる） */
export const mapIdx = (f: Floor, x: number, y: number) => y * f.w + x;
export const inBounds = (f: Floor, x: number, y: number) => x >= 0 && y >= 0 && x < f.w && y < f.h;
export const tileAt = (f: Floor, x: number, y: number): Tile => (inBounds(f, x, y) ? f.tiles[mapIdx(f, x, y)] : 0);

// ---------- フロア生成（部屋＋L字通路。順次接続なので必ず連結） ----------
interface Room { x: number; y: number; w: number; h: number; }
const center = (r: Room): Pos => ({ x: r.x + (r.w >> 1), y: r.y + (r.h >> 1) });

export function genFloor(world: World, depth: number, opts?: { abyss?: boolean; fodderMul?: number; shapedWeight?: number; burstWeight?: number }): Floor {
  // seed に潜行回数(diveCount)を混ぜる＝同一世代でも潜行ごとに別ダンジョン（生還→再潜行での宝箱/XP farm を根絶）。
  const rng = makeRng((world.seed ^ (depth * 2654435761) ^ (world.generation * 97) ^ ((world.diveCount ?? 0) * 40503) ^ (opts?.abyss ? 0x5eed : 0)) >>> 0);
  const mods = diffMods(world.difficulty); // 難易度係数（4-11H）。easy＝×1.0＝従来値（golden 不変）。
  // マップ寸法：深いほど広い（毎回ランダムな形）。常に VIEW より大きく、カメラがスクロールする。
  // 旧 24+/28+（最大50×54）は手狭との FB を受け拡張（2026-06-17）。深度50で頭打ち＝最大 86×92（≒7,912・約2.9倍）。
  // 部屋数/敵数/宝箱は面積比で自動追従＝広いほど探索量が増え手応えになる（じっくり攻略）。
  // 深淵帯（帰還の試練）もフル寸法（深蝕リワーク v2＝累積は術使用のみ＝広さで死なないため縮小不要）。
  const W = 36 + Math.min(depth, 50);
  const H = 42 + Math.min(depth, 50);
  const tiles: Tile[] = new Array(W * H).fill(0);
  const gi = (x: number, y: number) => y * W + x;
  const rooms: Room[] = [];

  const carveRoom = (r: Room) => {
    for (let y = r.y; y < r.y + r.h; y++) for (let x = r.x; x < r.x + r.w; x++) tiles[gi(x, y)] = 1;
  };
  const carve = (x: number, y: number) => { tiles[gi(x, y)] = 1; };
  // 部屋同士に2マスの岩を残す＝部屋と通路が見分けられる（開放的すぎる大広間を防ぐ）。
  const overlaps = (a: Room) =>
    rooms.some((b) => a.x - 2 < b.x + b.w && b.x - 2 < a.x + a.w && a.y - 2 < b.y + b.h && b.y - 2 < a.y + a.h);
  const dist2 = (a: Room, b: Room) => {
    const ca = center(a), cb = center(b);
    return (ca.x - cb.x) ** 2 + (ca.y - cb.y) ** 2;
  };
  // L字の1マス幅通路で2部屋の中心を結ぶ
  const carveCorridor = (a: Room, b: Room) => {
    let { x: ax, y: ay } = center(a);
    const { x: bx, y: by } = center(b);
    if (rng.next() < 0.5) {
      for (; ax !== bx; ax += Math.sign(bx - ax)) carve(ax, ay);
      for (; ay !== by; ay += Math.sign(by - ay)) carve(ax, ay);
    } else {
      for (; ay !== by; ay += Math.sign(by - ay)) carve(ax, ay);
      for (; ax !== bx; ax += Math.sign(bx - ax)) carve(ax, ay);
    }
    carve(bx, by);
  };

  // 小部屋を多めに、稀に大広間を一つ二つ。面積に比例して多数置く（大部屋ばかりを脱却）。
  const targetRooms = Math.max(8, Math.round((W * H) / 72));
  for (let tries = 0; tries < targetRooms * 22 && rooms.length < targetRooms; tries++) {
    const big = rng.next() < 0.16;
    const w = big ? 6 + rng.int(5) : 3 + rng.int(3); // 大:6-10 / 小:3-5
    const h = big ? 5 + rng.int(3) : 3 + rng.int(2); // 大:5-7 / 小:3-4
    const x = 1 + rng.int(W - w - 2), y = 1 + rng.int(H - h - 2);
    const r = { x, y, w, h };
    if (!overlaps(r)) { rooms.push(r); carveRoom(r); }
  }

  // 接続：最近傍を順につないで全室連結（迷路的な木）。leaf＝行き止まりが自然に残る。
  const connected = new Set<number>([0]);
  while (connected.size < rooms.length) {
    let bestA = -1, bestB = -1, best = Infinity;
    for (let a = 0; a < rooms.length; a++) {
      if (!connected.has(a)) continue;
      for (let b = 0; b < rooms.length; b++) {
        if (connected.has(b)) continue;
        const d = dist2(rooms[a], rooms[b]);
        if (d < best) { best = d; bestA = a; bestB = b; }
      }
    }
    if (bestB < 0) break;
    carveCorridor(rooms[bestA], rooms[bestB]);
    connected.add(bestB);
  }
  // 一部にループを足す（回遊性。行き止まりは残しつつ一本道を崩す）。
  for (let i = 0; i < rooms.length; i++) {
    if (rng.next() >= 0.2) continue;
    let bj = -1, bd = Infinity;
    for (let j = 0; j < rooms.length; j++) {
      if (j === i) continue;
      const d = dist2(rooms[i], rooms[j]);
      if (d < bd) { bd = d; bj = j; }
    }
    if (bj >= 0) carveCorridor(rooms[i], rooms[bj]);
  }

  // 階段：上り＝最初の部屋、下り＝上りから最も遠い部屋（潜行が一筆書きにならない距離を確保）。
  const stairsUp = center(rooms[0]);
  let farIdx = rooms.length - 1, farD = -1;
  for (let i = 1; i < rooms.length; i++) {
    const d = dist2(rooms[0], rooms[i]);
    if (d > farD) { farD = d; farIdx = i; }
  }
  const stairsDown = center(rooms[farIdx]);

  const floor: Floor = {
    depth, w: W, h: H, tiles, stairsUp, stairsDown,
    monsters: [], fossils: [], chests: [], shrines: [], returnDoor: null,
    explored: new Array(W * H).fill(false),
    diff: mods, // 難易度係数を焼き込む（追手/眷属の動的スポーンが読む）
  };

  // ---------- モンスター配置（マップ面積＋深度でスケール。大マップでも密度を確保） ----------
  // ★burst（回避不能・PR3）は easy から完全除外＝easy の pool にそもそも入れない（elite 基/fodder/spawnPool の全経路で不在）。
  //   golden は difficulty 未設定＝easy 基準で走る＝burster を一切スポーンしない＝genFloor/monsterAI とも byte 完全一致（新種追加でも指紋不変）。
  const notEasy = (world.difficulty ?? "easy") !== "easy";
  const pool = MONSTER_KINDS.filter((k) => k.minDepth <= depth && (k.maxDepth === undefined || depth <= k.maxDepth) && (notEasy || k.ability !== "burst"));
  // 形つき敵（arc/slam/beam/burst）を重み付けした spawn プール（PR1/PR3）。総配置数（count）は不変＝通常敵を形つき敵に置き換えるだけ。
  // elite 基（最上位 tier 抽出）と fodder は素の pool を使う（下）＝影響を主 count ループに閉じる。
  // ★easy は重み1（自然頻度・arc/slam/beam は出るが薄い／burst は上の pool 除外で不在）＝「快適無双」据え置きの確立方針（v0.121/v0.143 と同じ easy 除外ゲート）＝golden（easy 基準）も重み経路を踏まない。
  const shapedWeight = Math.max(1, opts?.shapedWeight ?? (notEasy ? SHAPED_WEIGHT : 1));
  const spawnPool: MonsterKind[] = [];
  for (const k of pool) {
    // burst は別枠の低い重み（回避不能ゆえ抑えめ）／arc/slam/beam は shapedWeight（dodge可能ゆえ濃くしてよい）／その他は1。
    const w = k.ability === "burst" ? (notEasy ? (opts?.burstWeight ?? BURST_WEIGHT) : 1)
      : k.ability && SHAPED_ABILITIES.has(k.ability) ? shapedWeight : 1;
    for (let j = 0; j < w; j++) spawnPool.push(k);
  }
  const countCap = depth > 50 ? 42 + Math.min(18, depth - 50) : 42; // 深淵帯ギア：深度50超は包囲も増す（depth≤50＝42＝golden 不変）
  const count = Math.min(Math.round((W * H) / 120) + Math.floor(depth / 3), countCap); // 出現率・上限を拡張面積に追従（20→42→深部60）
  for (let i = 0; i < count; i++) {
    const kind = scaleKind(spawnPool[rng.int(spawnPool.length)], depth, mods); // 深度係数＋難易度を焼き込む（HP/dmg/XP連動）
    const p = randomFloorAway(floor, rng, stairsUp, 5);
    if (p) floor.monsters.push({ id: `m${depth}_${i}`, kind, hp: kind.hp, x: p.x, y: p.y, awake: false, intent: null });
  }

  // ---------- ボス配置（4-11F：エリアボス＝深度節目で下り階段を守る／中ボス＝奥の部屋の強敵） ----------
  if (depth >= 8 && depth % 8 === 0) {
    const { kind, fossilId } = makeAreaBoss(world, depth, rng);
    const bp = freeFloorNear(floor, stairsDown);
    if (bp) floor.monsters.push({ id: `boss${depth}`, kind, hp: kind.hp, x: bp.x, y: bp.y, awake: true, intent: null, boss: "area", fossilId });
  } else if (depth >= 5 && rng.next() < 0.3) {
    const base = scaleKind(pool.reduce((a, b) => (b.tier > a.tier ? b : a)), depth, mods); // 深度＋難易度スケール済みの最上位種
    const kind: MonsterKind = {
      ...base, key: `elite${depth}`, name: `手負いの${base.name}`,
      hp: Math.round(base.hp * 2), dmg: base.dmg + 1, tier: Math.min(5, base.tier + 1), // 雑魚と area ボスの中間
    };
    const p = randomFloorAway(floor, rng, stairsUp, 8);
    if (p) floor.monsters.push({ id: `elite${depth}`, kind, hp: kind.hp, x: p.x, y: p.y, awake: false, intent: null, boss: "elite" });
  }

  // ---------- 宝箱配置（深いほど少し増える。入口から離して＝奥/行き止まりに置く） ----------
  // 宝箱も面積に追従（拡張に合わせ増やす）。最小2＋深度の僅かな上乗せ。d1≈2-3 / d50≈7-8。
  const chestCount = Math.max(2, Math.round((W * H) / 1300)) + Math.min(depth >> 4, 2) + (rng.next() < 0.5 ? 1 : 0);
  for (let i = 0; i < chestCount; i++) {
    const p = randomFloorAway(floor, rng, stairsUp, 6);
    if (p) floor.chests.push({ id: `c${depth}_${i}`, x: p.x, y: p.y, opened: false });
  }

  // ---------- 回復ノード（安息所/回復の泉・深蝕リワーク v2）：一度使用で消える ----------
  // 設置数は深さで調整：泉は深層で1階確定・浅中はランダム／安息所は深いほど多い（深層の術使用＝
  // 蓄積が嵩むため浄化の機会を増やす）。深淵帯（試練）は泉1のみ＝聖遺物携行の緊張を保つため安息所は置かない。
  const deep = depth > 24, mid = depth > 8 && depth <= 24;
  const springCount = opts?.abyss ? 1 : deep ? 1 : mid ? (rng.next() < 0.5 ? 1 : 0) : (rng.next() < 0.3 ? 1 : 0);
  const restCount = opts?.abyss ? 0 : deep ? 1 + (rng.next() < 0.4 ? 1 : 0) : mid ? 1 : (rng.next() < 0.35 ? 1 : 0);
  const placeShrine = (kind: ShrineKind, i: number) => {
    for (let t = 0; t < 12; t++) {
      const p = randomFloorAway(floor, rng, stairsUp, 6);
      if (!p) return;
      if (floor.shrines.some((s) => s.x === p.x && s.y === p.y)) continue;
      floor.shrines.push({ id: `shr_${kind}_${depth}_${i}`, kind, x: p.x, y: p.y, used: false });
      return;
    }
  };
  for (let i = 0; i < springCount; i++) placeShrine("spring", i);
  for (let i = 0; i < restCount; i++) placeShrine("rest", i);

  // ---------- 深淵帯（奉献の試練・4-13B）：最奥の主が聖遺物を守る ----------
  if (opts?.abyss) {
    const { kind, fossilId } = makeAreaBoss(world, depth, rng);
    const lord: MonsterKind = {
      ...kind, key: `abyss${depth}`,
      name: fossilId ? kind.name.replace("成れの果て", "成れの果て――深淵の主") : "深淵の主",
      hp: Math.round(kind.hp * 1.4) + 40, dmg: kind.dmg + 2, tier: 5, // area ボス（既に深度スケール済）を更に増強
    };
    const bp = freeFloorNear(floor, stairsDown) ?? stairsDown;
    floor.monsters.push({ id: "abyss_lord", kind: lord, hp: lord.hp, x: bp.x, y: bp.y, awake: true, intent: null, boss: "area", fossilId });
    // 聖遺物：主のかたわら（下り階段側＝上り階段＝脱出路から最も遠い）
    const rp = freeFloorNear(floor, bp) ?? bp;
    floor.chests.push({ id: "relic", x: rp.x, y: rp.y, opened: false, relic: true });
  }

  // ---------- 群れ増量（fodder・A｜v0.123.0／部屋クラスタ配置 案C｜v0.140.0）：低tier雑魚を通常配置数×FODDER_MUL だけ末尾に追加 ----------
  //   末尾で rng を消費＝既存の敵/ボス/宝箱/回復ノードの配置は不変（genFloor 指紋の差分は fodder ぶんだけ＝意図的再生成）。
  //   ★総数は従来と同じ（配置の形だけ変える）＝一部を「部屋の中心」に固め（クラスタ）、残りは全域に散布。
  //   opts.fodderMul で上書き（sim 対照/golden monsterAI 据置＝0）。0 なら rng を一切消費せず従来と byte 一致。
  //   ★PR2（v0.146.0）：easy 未指定時は mods.fodderMul（=FODDER_MUL と同値・golden 不変）／normal/hard/death は難易度別に増量。
  const fodderMul = opts?.fodderMul ?? mods.fodderMul;
  if (depth >= FODDER_MIN_DEPTH && fodderMul > 0) {
    const fodderPool = pool.filter((k) => k.tier <= FODDER_MAX_TIER);
    if (fodderPool.length) {
      // cap＝この末尾ブロック（fodder＋護衛）が使える残り枠。fodder/escort 両方の push で必ず1ずつ減らす＝
      // 総数の絶対上限（MONSTER_HARDCAP）を両者合算で厳守（PR2：護衛を budget と別枠にしたことで超過しうる穴を防ぐ）。
      let cap = MONSTER_HARDCAP - floor.monsters.length;
      // クラスタ深度スケール（v0.143.0）はここで先に決める（easy 据え置き・normal/hard 限定＝golden 不変）。
      const bigCluster = (world.difficulty ?? "easy") !== "easy"; // easy 据え置き（快適無双／golden 不変）＝normal/hard 限定
      // 護衛の取り分を先に予約（PR2 sim実測で判明＝fodder が cap を使い切ると護衛（特に散布護衛）が入らず、
      // せっかくの「経路と交差しやすい」散布護衛が feature として機能しなくなる）。予約分は fodder budget に含めない。
      const escortReserveWanted = bigCluster ? clusterEscortCount(depth) * 2 + scatterEscortCount(depth) : 0; // クラスタ最大2部屋分＋散布ぶんを目安に予約
      const escortReserve = Math.min(cap, escortReserveWanted);
      cap -= escortReserve;
      let budget = Math.max(0, Math.min(Math.round(count * fodderMul), cap));
      cap += escortReserve; // fodder budget は予約分を除いた枠で確定済み＝ここで枠を戻して護衛に回す（fodder はこの後 budget を超えては置かない）
      let fi = 0;
      const placeFodderAt = (p: Pos | null): boolean => {
        if (!p || cap <= 0) return false;
        const kind = scaleKind(fodderPool[rng.int(fodderPool.length)], depth, mods); // 深度＋難易度を焼き込む（HP/dmg/XP連動）
        floor.monsters.push({ id: `f${depth}_${fi++}`, kind, hp: kind.hp, x: p.x, y: p.y, awake: false, intent: null });
        cap--;
        return true;
      };
      // クラスタ：開始部屋(0)・ボス/下り部屋(farIdx)を除く、塊が収まる広さ(≥12)の部屋を決定論シャッフルして中心に固める。
      // ★深度スケール（v0.143.0）：normal/hard は中盤以降クラスタを大きく（size 3→4→5）・より固める（frac 0.6→0.85）＝“数”のレバーを中盤だけ効かせる。序盤 d<10・easy は不変。
      const clusterSize = fodderClusterSize(depth, bigCluster);
      let clusterBudget = Math.round(budget * fodderClusterFrac(depth, bigCluster));
      const candRooms = rooms.filter((r, i) => i !== 0 && i !== farIdx && r.w * r.h >= 12);
      for (let a = candRooms.length - 1; a > 0; a--) { const b = rng.int(a + 1); const t = candRooms[a]; candRooms[a] = candRooms[b]; candRooms[b] = t; }
      // クラスタ護衛（PR2）：normal/hard のみ・この深度で出現可能なチョーク破り種（charge/arc/slam/beam/reach>=2）から抽選。
      // 候補が居ない浅い深度（護衛種の minDepth 未到達）では自然に見送られる＝easy と同じく rng を消費しない。
      const escortPool = bigCluster ? pool.filter((k) => (k.ability && CLUSTER_ESCORT_ABILITIES.has(k.ability)) || (k.reach ?? 1) >= 2) : [];
      let ei = 0;
      for (const rm of candRooms) {
        if (clusterBudget <= 0 || budget <= 0) break;
        const c = center(rm);
        let placed = 0;
        for (let dy = -FODDER_CLUSTER_RADIUS; dy <= FODDER_CLUSTER_RADIUS && placed < clusterSize && clusterBudget > 0; dy++) {
          for (let dx = -FODDER_CLUSTER_RADIUS; dx <= FODDER_CLUSTER_RADIUS && placed < clusterSize && clusterBudget > 0; dx++) {
            const x = c.x + dx, y = c.y + dy;
            if (tileAt(floor, x, y) !== 1) continue;
            if (floor.monsters.some((m) => m.x === x && m.y === y)) continue;
            if (Math.hypot(x - stairsUp.x, y - stairsUp.y) < 5) continue; // 開始からは離す
            if (placeFodderAt({ x, y })) { placed++; clusterBudget--; budget--; }
          }
        }
        if (placed > 0 && escortPool.length) {
          const escortCount = clusterEscortCount(depth);
          for (let ec = 0; ec < escortCount && cap > 0; ec++) {
            const ep = freeFloorNear(floor, c);
            if (!ep) break;
            const ek = scaleKind(escortPool[rng.int(escortPool.length)], depth, mods);
            floor.monsters.push({ id: `esc${depth}_${ei++}`, kind: ek, hp: ek.hp, x: ep.x, y: ep.y, awake: false, intent: null });
            cap--;
          }
        }
      }
      // 残りは従来どおり全域に散布（randomFloorAway＝マップ全域・開始から5マス以上）。
      while (budget > 0) { if (!placeFodderAt(randomFloorAway(floor, rng, stairsUp, 5))) break; budget--; }
      // 散布護衛（PR2）：クラスタに限らずマップ全域へ数体＝@の実際の経路と交差する確率を確保。
      if (escortPool.length) {
        const scatterCount = scatterEscortCount(depth);
        for (let ec = 0; ec < scatterCount && cap > 0; ec++) {
          const ep = randomFloorAway(floor, rng, stairsUp, 5);
          if (!ep) break;
          const ek = scaleKind(escortPool[rng.int(escortPool.length)], depth, mods);
          floor.monsters.push({ id: `esc${depth}_${ei++}`, kind: ek, hp: ek.hp, x: ep.x, y: ep.y, awake: false, intent: null });
          cap--;
        }
      }
    }
  }
  return floor;
}

/** 帰還の試練（4-13C）：聖遺物を奪った者を追う怨霊を1体、プレイヤー近くに湧かせる。 */
export function spawnPursuer(f: Floor, rng: Rng, player: Pos, depth: number, n: number): Monster | null {
  const p = randomFloorAway(f, rng, player, 4);
  if (!p) return null;
  const base = MONSTER_KINDS[MONSTER_KINDS.length - 1]; // 石鬼＝最上位
  const dm = f.diff ?? EASY_MODS; // フロアに焼き込まれた難易度（4-11H）
  const kind: MonsterKind = {
    ...base, key: `pursuer${depth}_${n}`, glyph: "W", name: "追い縋る怨霊",
    hp: Math.round(regularHpAt(depth) * 1.3 * dm.enemyHp * abyssalScale(depth)), dmg: Math.round((2 + depthDmgBonus(depth)) * dm.enemyDmg * abyssalScale(depth)) + dm.dmgFloor, erratic: 0.1, tier: 4,
  };
  const m: Monster = { id: `pursuer_${depth}_${n}`, kind, hp: kind.hp, x: p.x, y: p.y, awake: true, intent: null };
  f.monsters.push(m);
  return m;
}

/** エリアボスの出自＝「縁ある相手の成れの果て」へ寄せて抽選（4-6/⑤鎮め筋）。
 *  絆・未完の因縁・doom/fall 弧の終端・元相棒を加重し、見知らぬ他人（基礎重み1）も残す＝
 *  「知っていた者が深みに堕ちて怪物となり還る」情緒を発火させる（純粋・決定論）。 */
function pickBossSource(world: World, pool: Fossil[], rng: Rng): Fossil {
  const bonds = new Map((world.current?.bonds ?? []).map((b) => [b.entityRef, b]));
  const doom = new Set(
    (world.tracked ?? [])
      .filter((t) => (t.arcType === "doom" || t.arcType === "fall") && t.originRef)
      .map((t) => t.originRef as string),
  );
  const weights = pool.map((f) => {
    let w = 1;
    const b = bonds.get(f.id);
    if (b) { w += 5 + Math.max(0, b.value); if (b.unfinished) w += 5; } // 縁／未完の因縁
    if (doom.has(f.id)) w += 6;        // 堕ちゆく弧の終端＝成れの果てに相応しい
    if (f.wasCompanion) w += 4;        // かつての相棒
    return w;
  });
  let roll = rng.next() * weights.reduce((a, b) => a + b, 0);
  for (let i = 0; i < pool.length; i++) { roll -= weights[i]; if (roll < 0) return pool[i]; }
  return pool[pool.length - 1];
}

/** エリアボスの種別＋出自。可能なら過去の探索者化石の名を冠する（敵性化＝⑤鎮め筋の対象）。 */
function makeAreaBoss(world: World, depth: number, rng: Rng): { kind: MonsterKind; fossilId?: string } {
  const pool = world.fossils.filter((f) => (f.kind === "character" || f.kind === "explorer") && !f.retired); // 退隠した先代は生者＝「成れの果て」ボスにしない（4-14G）
  const src = pool.length ? pickBossSource(world, pool, rng) : null;
  const name = src ? `${src.origin.name}の成れの果て` : "深淵の主";
  const mods = diffMods(world.difficulty); // 難易度（4-11H）：ボスHP/火力にも係数を焼き込む。easy＝従来値。
  // エリアボス＝雑魚baseline×4+20・dmg＝雑魚+4（硬め維持＝止め/距離/弱体/回復/遠距離の駆け引き前提 4-11F）
  const kind: MonsterKind = {
    key: `boss${depth}`, glyph: "Ω", name,
    hp: Math.round((regularHpAt(depth) * 4 + 20) * mods.enemyHp * abyssalScale(depth)),
    dmg: Math.round((5 + depthDmgBonus(depth)) * mods.enemyDmg * abyssalScale(depth)) + mods.dmgFloor,
    minDepth: depth, erratic: 0.05, tier: 5,
  };
  return { kind, fossilId: src?.id };
}

/** p の近傍（外周をスパイラル）で空いた床タイルを探す。なければ null。 */
function freeFloorNear(f: Floor, p: Pos): Pos | null {
  for (let r = 1; r <= 5; r++) {
    for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
      if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
      const x = p.x + dx, y = p.y + dy;
      if (tileAt(f, x, y) !== 1) continue;
      if (f.monsters.some((m) => m.x === x && m.y === y)) continue;
      if ((x === f.stairsUp.x && y === f.stairsUp.y) || (x === f.stairsDown.x && y === f.stairsDown.y)) continue;
      return { x, y };
    }
  }
  return null;
}

/** from から minDist 以上離れた床タイルを返す */
export function randomFloorAway(f: Floor, rng: Rng, from: Pos, minDist: number): Pos | null {
  for (let tries = 0; tries < 80; tries++) {
    const x = 1 + rng.int(f.w - 2), y = 1 + rng.int(f.h - 2);
    if (tileAt(f, x, y) !== 1) continue;
    if (Math.hypot(x - from.x, y - from.y) < minDist) continue;
    if (f.monsters.some((m) => m.x === x && m.y === y)) continue;
    if (f.fossils.some((e) => e.x === x && e.y === y)) continue;
    if (f.chests.some((c) => c.x === x && c.y === y)) continue;
    if ((x === f.stairsUp.x && y === f.stairsUp.y) || (x === f.stairsDown.x && y === f.stairsDown.y)) continue;
    return { x, y };
  }
  return null;
}

/** 化石をフロアに実体として置く（再会重み 4-7 の結果を受け取る） */
export function placeFossil(f: Floor, rng: Rng, player: Pos, fossil: Fossil): boolean {
  const p = randomFloorAway(f, rng, player, 6);
  if (!p) return false;
  f.fossils.push({ id: `fe_${fossil.id}`, fossilId: fossil.id, resolved: false, x: p.x, y: p.y });
  return true;
}

// ---------- 視界（Bresenham LOS・半径制） ----------
export const FOV_RADIUS = 7;

function losClear(f: Floor, x0: number, y0: number, x1: number, y1: number): boolean {
  let dx = Math.abs(x1 - x0), dy = -Math.abs(y1 - y0);
  const sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
  let err = dx + dy, x = x0, y = y0;
  for (;;) {
    if (x === x1 && y === y1) return true;
    if (!(x === x0 && y === y0) && tileAt(f, x, y) === 0) return false; // 壁が遮る
    const e2 = 2 * err;
    if (e2 >= dy) { err += dy; x += sx; }
    if (e2 <= dx) { err += dx; y += sy; }
  }
}

/** 可視セル集合を返し、explored を更新する */
export function computeFov(f: Floor, p: Pos): Set<number> {
  const vis = new Set<number>();
  for (let y = Math.max(0, p.y - FOV_RADIUS); y <= Math.min(f.h - 1, p.y + FOV_RADIUS); y++) {
    for (let x = Math.max(0, p.x - FOV_RADIUS); x <= Math.min(f.w - 1, p.x + FOV_RADIUS); x++) {
      if (Math.hypot(x - p.x, y - p.y) > FOV_RADIUS + 0.5) continue;
      if (losClear(f, p.x, p.y, x, y)) {
        vis.add(mapIdx(f, x, y));
        f.explored[mapIdx(f, x, y)] = true;
      }
    }
  }
  return vis;
}

// ---------- 街防衛戦の戦場（街襲撃の盤上化・4-4B/4-12J）：迷宮ではない特設アリーナ ----------
//   迷宮の戦闘エンジン（planMonsters/resolveMonsters＋味方）をそのまま回すため Floor を手組みする。
//   広場＝開けた床／要所に瓦礫の遮蔽／上辺中央＝迷宮の口（敵の湧き口）／下辺＝自陣（@・味方・市民）。
//   pseudoDepth＝tier 由来の擬似深度（敵を深度スケールさせる）。web 限定の raid モードが使う。純粋・決定論。
export interface RaidField {
  floor: Floor;
  playerStart: Pos;
  allySpots: Pos[];   // 味方冒険者の初期配置（自陣＝プレイヤー周囲）
  civicSpots: Pos[];  // 逃げ遅れた市民の位置（大規模のみ）
  spawnZone: Pos[];   // 敵の湧き候補（上辺付近の床）
}
export function genRaidField(seed: number, scale: "small" | "medium" | "large", pseudoDepth: number): RaidField {
  const rng = makeRng((seed ^ 0x7a1d ^ (pseudoDepth * 2654435761)) >>> 0);
  const dim = scale === "large" ? { w: 35, h: 29 } : scale === "medium" ? { w: 27, h: 23 } : { w: 21, h: 19 };
  const W = dim.w, H = dim.h, cx = W >> 1;
  const tiles: Tile[] = new Array(W * H).fill(1);
  for (let x = 0; x < W; x++) { tiles[x] = 0; tiles[(H - 1) * W + x] = 0; }        // 上下の外壁
  for (let y = 0; y < H; y++) { tiles[y * W] = 0; tiles[y * W + (W - 1)] = 0; }    // 左右の外壁
  // 遮蔽（瓦礫/建物）：小ブロックを散らす。中央縦レーン・上辺の湧き口・下辺の自陣は空ける（敵が必ず来られる）。
  const blocks = scale === "large" ? 7 : scale === "medium" ? 5 : 3;
  for (let i = 0; i < blocks; i++) {
    const bw = 1 + rng.int(2), bh = 1 + rng.int(2);
    const bx = 3 + rng.int(Math.max(1, W - 6 - bw)), by = 5 + rng.int(Math.max(1, H - 11 - bh));
    for (let y = by; y < by + bh; y++) for (let x = bx; x < bx + bw; x++) {
      if (Math.abs(x - cx) <= 1) continue; // 中央レーンは塞がない
      if (x > 0 && y > 0 && x < W - 1 && y < H - 1) tiles[y * W + x] = 0;
    }
  }
  const f: Floor = {
    depth: pseudoDepth, w: W, h: H, tiles,
    stairsUp: { x: cx, y: H - 2 }, stairsDown: { x: cx, y: 1 },
    monsters: [], fossils: [], chests: [], shrines: [],
    explored: new Array(W * H).fill(true), // 戦場は全可視（街の出来事＝霧なし）
    downed: null, delver: null,
  };
  const playerStart: Pos = { x: cx, y: H - 3 };
  const allySpots = ([{ x: cx - 1, y: H - 3 }, { x: cx + 1, y: H - 3 }, { x: cx - 2, y: H - 4 }, { x: cx + 2, y: H - 4 }, { x: cx, y: H - 2 }] as Pos[])
    .filter((p) => tileAt(f, p.x, p.y) === 1);
  const civicSpots = ([{ x: 2, y: H - 2 }, { x: W - 3, y: H - 2 }, { x: 3, y: H - 3 }, { x: W - 4, y: H - 3 }] as Pos[])
    .filter((p) => tileAt(f, p.x, p.y) === 1);
  const spawnZone: Pos[] = [];
  for (let y = 1; y <= 3; y++) for (let x = 1; x < W - 1; x++) if (tileAt(f, x, y) === 1) spawnZone.push({ x, y });
  return { floor: f, playerStart, allySpots, civicSpots, spawnZone };
}

// ---------- モンスターのターン（テレグラフ＝予告 → 実行の2段：4-11A） ----------
interface MonsterHit { monster: Monster; dmg: number; target: "player" | "companion"; effect?: "poison" | "heavy" | "curse" | "charge"; tx?: number; ty?: number; } // tx/ty=被弾マス（街防衛戦で複数味方の誰が撃たれたかを web 側が特定するため。dive/golden では未使用）
interface Resolution { hits: MonsterHit[]; dodges: Monster[]; }
/** 相棒の一手の結果（プレイヤー手番末に解決）。 */
interface CompanionResolution { hit: Monster | null; dmg: number; }

// dmg は kind に深度係数を焼き込み済み（scaleKind / ボス・エリート・追手とも）。蝕み（weak）中は減算（下限1）。
export const WEAK_AMT = 4;
const monsterDmg = (m: Monster, _f: Floor) =>
  Math.max(1, m.kind.dmg
    + (m.enraged ? Math.max(1, Math.round(m.kind.dmg * BOSS_ENRAGE_DMG_FRAC)) : 0) // 覚醒ボス＝攻撃上乗せ（B）
    - (m.weak && m.weak > 0 ? WEAK_AMT : 0));
/** 相棒の攻撃力（等級なし時のフォールバック＝控えめの固定値。最終調整は横断E）。 */
export const COMPANION_DMG = 2;

/** 相棒の強さ＝金属等級（基礎）＋潜行深度（4-4E／2026-06-23 深部追従）。
 *  旧来は等級のみ（HP10-22/攻2-6）で深度50の敵（雑魚HP≈86・dmg≈10）に対し紙だった。
 *  深度係数を足し、深部でも壁役・削り役として成立させる（毎フロア再展開時に深度で再計算）。
 *  HP: 基礎(10-22)＋round(depth×1.2)／攻撃: 基礎(2-6)＋round(depth×0.15)。 */
export function companionMaxHp(grade: number, depth = 0): number {
  return 10 + Math.max(0, Math.min(5, grade)) * 3 + Math.round(depth * 1.2);
}
export function companionDmg(grade: number, depth = 0): number {
  return 2 + Math.max(0, Math.min(5, grade)) + Math.round(depth * 0.15);
}

/** 相棒の被ダメ軽減＝金属等級（基礎）＋潜行深度（v0.132.0・「すぐ死ぬ」是正）。
 *  プレイヤーは防具軽減を持つが相棒は生ダメージ丸受けだった（実効耐久が本体の約半分）。
 *  等級＋深度で緩くスケールし、被弾を max(1, dmg-reduce) にして実効耐久を約2倍へ（下限1＝無敵化しない）。 */
export function companionReduce(grade: number, depth = 0): number {
  return Math.round(depth * 0.12) + Math.max(0, Math.min(5, grade));
}

// 移動先が他者で塞がっているか（モンスター同士・化石・味方・手負いと重ならない）。
// friends＝味方エンティティ（相棒1体／街防衛戦の複数の冒険者）。空なら従来どおり（相棒なし＝golden 不変）。
const occupiedBy = (f: Floor, x: number, y: number, self: Monster | null, friends?: readonly Pos[] | null) =>
  f.monsters.some((m) => m !== self && m.hp > 0 && m.x === x && m.y === y) ||
  f.fossils.some((e) => e.x === x && e.y === y) ||
  (!!friends && friends.some((c) => c.x === x && c.y === y)) ||
  (!!f.downed && f.downed.x === x && f.downed.y === y) ||
  (!!f.delver && f.delver.x === x && f.delver.y === y);

// ボスの形つき確定範囲（D・area ボス限定・rng 非使用＝ボス位置×標的方向×形番号で決定論）。
//   全マスを1手前に橙で予告し、範囲に留まれば全弾ヒット・外なら確定安全＝「動けば無傷で捌ける」パズル。
const DIRS8: readonly [number, number][] = [[-1, -1], [0, -1], [1, -1], [-1, 0], [1, 0], [-1, 1], [0, 1], [1, 1]];
/** 主方向とその左右45°の3方向（扇の展開に使う）。 */
function frontDirs(dx: number, dy: number): [number, number][] {
  const order: [number, number][] = [[-1, -1], [0, -1], [1, -1], [1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0]];
  let i = order.findIndex((d) => d[0] === dx && d[1] === dy);
  if (i < 0) i = 0;
  return [order[(i + 7) % 8], order[i], order[(i + 1) % 8]];
}
/** area ボスの大技の形の全マス（床のみ）を返す。idx=0 直線3／1 扇（前方3方向×2）／2 薙ぎ（周囲8）。 */
function bossShapeCells(f: Floor, bx: number, by: number, tx: number, ty: number, idx: number): Pos[] {
  let dx = Math.sign(tx - bx), dy = Math.sign(ty - by);
  if (dx === 0 && dy === 0) dx = 1; // 標的が重なる異常時の保険
  const cells: Pos[] = [];
  const add = (x: number, y: number) => { if (tileAt(f, x, y) === 1) cells.push({ x, y }); };
  if (idx === 0) { for (let k = 1; k <= 3; k++) add(bx + dx * k, by + dy * k); } // 直線3マス
  else if (idx === 1) { for (const [ax, ay] of frontDirs(dx, dy)) { add(bx + ax, by + ay); add(bx + ax * 2, by + ay * 2); } } // 扇
  else { for (const [ax, ay] of DIRS8) add(bx + ax, by + ay); } // 薙ぎ（周囲8）
  return cells;
}

/** 旋刃鬼（arc・PR1）：隣接時、@方向の前方弧3マス（@のマス＋左右±45度・床のみ）。bossShapeCells の扇の距離1版。 */
function arcCells(f: Floor, mx: number, my: number, tx: number, ty: number): Pos[] {
  let dx = Math.sign(tx - mx), dy = Math.sign(ty - my);
  if (dx === 0 && dy === 0) dx = 1;
  const cells: Pos[] = [];
  for (const [ax, ay] of frontDirs(dx, dy)) { const x = mx + ax, y = my + ay; if (tileAt(f, x, y) === 1) cells.push({ x, y }); }
  return cells;
}
/** 震地鬼（slam・PR1）：周囲8マス（床のみ）を叩きつける。 */
function slamCells(f: Floor, mx: number, my: number): Pos[] {
  const cells: Pos[] = [];
  for (const [ax, ay] of DIRS8) { const x = mx + ax, y = my + ay; if (tileAt(f, x, y) === 1) cells.push({ x, y }); }
  return cells;
}
/** 射抜きの眼（beam・PR1）：8方向直線・距離1..BEAM_MAX に target が居て間の床が通るとき、敵の隣から target マスまでの直線（床のみ）を返す。届かなければ null。 */
function beamCells(f: Floor, mx: number, my: number, tx: number, ty: number): Pos[] | null {
  const dx = tx - mx, dy = ty - my, adx = Math.abs(dx), ady = Math.abs(dy);
  const cheb = Math.max(adx, ady);
  if (cheb < 1 || cheb > BEAM_MAX) return null;
  if (!(dx === 0 || dy === 0 || adx === ady)) return null; // 8方向直線のみ
  const sx = Math.sign(dx), sy = Math.sign(dy);
  const cells: Pos[] = [];
  let cx = mx, cy = my;
  for (let s = 1; s <= cheb; s++) { cx += sx; cy += sy; if (tileAt(f, cx, cy) !== 1) return null; cells.push({ x: cx, y: cy }); } // 壁で止まる＝@に届かない
  return cells;
}

/** 爆ぜ胞子（burst・PR3）：target を中心とした3×3（本人＋周囲8マス・床のみ）。全隣接を覆う＝1手でどこへ動いても範囲内＝回避不能。 */
function burstCells(f: Floor, tx: number, ty: number): Pos[] {
  const cells: Pos[] = [];
  for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { const x = tx + dx, y = ty + dy; if (tileAt(f, x, y) === 1) cells.push({ x, y }); }
  return cells;
}
/** 炸裂（burst・PR3）が (mx,my) から (tx,ty) に届くか＝Chebyshev 1..BURST_RANGE かつ視線が通る。
 *  planMonsters の予告条件／web の押し出しキャンセル判定で共用＝挙動を一元化（監視するのは「まだ 3×3 が @ を覆えるか」）。 */
export function canBurstReach(f: Floor, mx: number, my: number, tx: number, ty: number): boolean {
  const cheb = Math.max(Math.abs(mx - tx), Math.abs(my - ty));
  return cheb >= 1 && cheb <= BURST_RANGE && losClear(f, mx, my, tx, ty);
}

/** 敵の攻撃射程判定（フェーズ2）：(mx,my) から (tx,ty) を reach で討てるか。
 *  reach<=1＝隣接（8方向 Chebyshev≤1）。reach>=2＝8方向直線・距離1..reach・間の床が壁でない（頭越しに突ける）。
 *  planMonsters の遠間攻撃条件／web の押し出しキャンセル判定（③④）／突入ライン描画で共用＝挙動を一元化。 */
export function monsterCanReach(f: Floor, mx: number, my: number, tx: number, ty: number, reach: number): boolean {
  const dx = tx - mx, dy = ty - my, adx = Math.abs(dx), ady = Math.abs(dy);
  const cheb = Math.max(adx, ady);
  if (reach <= 1) return cheb <= 1;
  if (cheb < 1 || cheb > reach) return false;
  if (!(dx === 0 || dy === 0 || adx === ady)) return false; // 8方向直線のみ
  const sx = Math.sign(dx), sy = Math.sign(dy);
  let cx = mx, cy = my;
  for (let s = 1; s < cheb; s++) { cx += sx; cy += sy; if (tileAt(f, cx, cy) !== 1) return false; } // 間に壁があれば届かない（敵は貫通しない）
  return true;
}

/** 突進（charge）：m から target への 8方向直線上・距離 2..CHARGE_MAX で、間の床が全て空きなら target 手前（隣接）の着地点を返す。無ければ null。 */
function chargeDest(f: Floor, m: Monster, target: Pos, friends: readonly CompanionEntity[]): Pos | null {
  const dx = target.x - m.x, dy = target.y - m.y;
  const adx = Math.abs(dx), ady = Math.abs(dy);
  if (!(dx === 0 || dy === 0 || adx === ady)) return null; // 縦・横・斜めの直線のみ
  const dist = Math.max(adx, ady);
  if (dist < 2 || dist > CHARGE_MAX) return null;
  const sx = Math.sign(dx), sy = Math.sign(dy);
  let cx = m.x, cy = m.y;
  for (let step = 1; step < dist; step++) { // target 手前まで（target 自身＝プレイヤー位置は走査しない）
    cx += sx; cy += sy;
    if (tileAt(f, cx, cy) !== 1) return null;         // 壁で塞がれた直線は突進しない
    if (occupiedBy(f, cx, cy, m, friends)) return null; // 途中に他者が居れば突進しない
  }
  return { x: cx, y: cy }; // target の隣接（着地点）
}

/** 各モンスターの次手を決め、intent に予告として書く（プレイヤーが見て動ける）。
 *  覚醒判定もここで行う：新たに気づいた敵はまず予告し、実行は次ターン（理不尽な不意打ちを排す）。
 *  相棒がいる場合は @ と相棒のうち近い方を標的にする（4-14C）。 */
export function planMonsters(f: Floor, player: Pos, rng: Rng, companion?: CompanionEntity | null, allies?: readonly CompanionEntity[] | null): void {
  const comp = companion && companion.hp > 0 ? companion : null;
  // 味方の一覧（相棒＋街防衛戦の冒険者）。空なら従来どおり＝相棒なしと完全一致（golden 不変）。
  const friends: CompanionEntity[] = [...(comp ? [comp] : []), ...(allies ?? []).filter((a) => a.hp > 0)];
  const births: Pos[] = []; // breeder が産む眷属の位置（ループ後にまとめて追加＝反復中の配列変更を避ける）
  for (const m of f.monsters) {
    if (m.hp <= 0) { m.intent = null; continue; }
    if (m.weak && m.weak > 0) m.weak--; // 蝕み（攻撃減）の残り手数を消費
    if (m.stunned && m.stunned > 0) { m.stunned--; m.intent = { type: "wait" }; continue; } // 静止の眼
    if (m.slowed && m.slowed > 0) { m.slowed--; if (m.slowed % 2 === 1) { m.intent = { type: "wait" }; continue; } } // 鈍り＝1手おき
    const dPlayer = Math.hypot(m.x - player.x, m.y - player.y);
    // 最寄りの味方（複数の冒険者にも対応。味方なしなら nearAlly=null＝従来どおり）
    let nearAlly: CompanionEntity | null = null, dAlly = Infinity;
    for (const a of friends) { const da = Math.hypot(m.x - a.x, m.y - a.y); if (da < dAlly) { dAlly = da; nearAlly = a; } }
    // 覚醒：プレイヤー or 味方のいずれかを視認したら起きる
    if (!m.awake) {
      if (dPlayer <= FOV_RADIUS && losClear(f, m.x, m.y, player.x, player.y)) m.awake = true;
      else if (nearAlly && dAlly <= FOV_RADIUS && losClear(f, m.x, m.y, nearAlly.x, nearAlly.y)) m.awake = true;
    }
    if (!m.awake) { m.intent = null; continue; }

    if (m.boss === "area") { // ボスの戦術化（B）：覚醒判定・大技CD・眷属召喚。全て area ボス限定＝通常敵/golden 不変。
      if (!m.enraged && m.hp <= m.kind.hp * BOSS_ENRAGE_AT) m.enraged = true; // 怒りフェーズ＝HP 半減で覚醒（web が演出を出す）
      if (m.bigCd === undefined) m.bigCd = BOSS_HEAVY_GRACE; // 接敵直後の即・大技を避ける猶予
      else if (m.bigCd > 0) m.bigCd--;
      if (m.enraged) { // ③眷属召喚（覚醒後のみ・breederMinion 流用・総数上限）
        if (m.summonCd && m.summonCd > 0) m.summonCd--;
        else if (rng.next() < BOSS_SUMMON_CHANCE && f.monsters.length + births.length < MONSTER_HARDCAP) {
          let placed = false;
          for (let dy = -1; dy <= 1 && !placed; dy++) for (let dx = -1; dx <= 1 && !placed; dx++) {
            if (dx === 0 && dy === 0) continue;
            const cx = m.x + dx, cy = m.y + dy;
            if (tileAt(f, cx, cy) === 1 && !(cx === player.x && cy === player.y) && !occupiedBy(f, cx, cy, m, friends)) {
              births.push({ x: cx, y: cy }); m.summonCd = BOSS_SUMMON_CD; placed = true;
            }
          }
        }
      }
    }

    if (m.kind.ability === "breeder") { // 孵化（4-11G）：たまに隣の空き床へ弱い眷属（総数上限＋クールダウン）。湧いても自分は普通に行動する。
      if (m.breedCd && m.breedCd > 0) m.breedCd--;
      else if (rng.next() < BREED_CHANCE && f.monsters.length + births.length < MONSTER_HARDCAP) {
        let placed = false;
        for (let dy = -1; dy <= 1 && !placed; dy++) for (let dx = -1; dx <= 1 && !placed; dx++) {
          if (dx === 0 && dy === 0) continue;
          const cx = m.x + dx, cy = m.y + dy;
          if (tileAt(f, cx, cy) === 1 && !(cx === player.x && cy === player.y) && !occupiedBy(f, cx, cy, m, friends)) {
            births.push({ x: cx, y: cy }); m.breedCd = BREED_CD; placed = true;
          }
        }
      }
    }

    if (m.confused && m.confused > 0) { // 惑乱＝ランダムによろめく（標的を見失う）
      m.confused--;
      const cx = rng.int(3) - 1, cy = rng.int(3) - 1;
      const c = { x: m.x + cx, y: m.y + cy };
      m.intent = (tileAt(f, c.x, c.y) === 1 && !(c.x === player.x && c.y === player.y) && !occupiedBy(f, c.x, c.y, m, friends))
        ? { type: "move", x: c.x, y: c.y } : { type: "wait" };
      continue;
    }

    // 標的＝近い方（同距離はプレイヤー優先）
    const target = nearAlly && dAlly < dPlayer ? nearAlly : player;
    const d = nearAlly && dAlly < dPlayer ? dAlly : dPlayer;
    if (m.rooted && m.rooted > 0) { // 縛鎖＝その場に縫い止める（隣接なら討てるが動けない）
      m.rooted--;
      m.intent = d < 1.5 ? { type: "attack", x: target.x, y: target.y } : { type: "wait" };
      continue;
    }
    if (m.fear && m.fear > 0) { // 畏れ＝標的から逃げる（隣接でも攻撃しない）
      m.fear--;
      let fx = Math.sign(m.x - target.x), fy = Math.sign(m.y - target.y);
      if (fx === 0 && fy === 0) fx = 1;
      const flee: Pos[] = [{ x: m.x + fx, y: m.y + fy }, { x: m.x + fx, y: m.y }, { x: m.x, y: m.y + fy }];
      let dest: Pos | null = null;
      for (const c of flee) {
        if (tileAt(f, c.x, c.y) === 1 && !(c.x === player.x && c.y === player.y) && !occupiedBy(f, c.x, c.y, m, friends)) { dest = c; break; }
      }
      m.intent = dest ? { type: "move", x: dest.x, y: dest.y } : { type: "wait" };
      continue;
    }
    if (m.kind.ability === "ranged") { // 狙撃（4-11G）：射程内は動かず対象マスを予告／接近されたら間合いを取り直す＝接近が弱点
      if (d >= 1.5 && d <= RANGED_MAX && losClear(f, m.x, m.y, target.x, target.y)) {
        m.intent = { type: "attack", x: target.x, y: target.y, ranged: true };
        continue;
      }
      if (d < 1.5) { // 接近された＝一歩退く（退けなければ素手で噛む＝弱い）
        const bx = Math.sign(m.x - target.x) || 1, by = Math.sign(m.y - target.y);
        const back: Pos[] = [{ x: m.x + bx, y: m.y + by }, { x: m.x + bx, y: m.y }, { x: m.x, y: m.y + by }];
        let dest: Pos | null = null;
        for (const c of back) if (tileAt(f, c.x, c.y) === 1 && !(c.x === player.x && c.y === player.y) && !occupiedBy(f, c.x, c.y, m, friends)) { dest = c; break; }
        m.intent = dest ? { type: "move", x: dest.x, y: dest.y } : { type: "attack", x: target.x, y: target.y };
        continue;
      }
      // d > RANGED_MAX → 通常追跡で間合いを詰める（下へ落ちる）
    }
    if (m.kind.ability === "charge") { // 突進（フェーズ1）：直線の間合いから一気に詰める＝カイト封じ。CD 中や非直線・隣接では下の通常ロジックへ。
      if (m.chargeCd && m.chargeCd > 0) m.chargeCd--;
      else if (d >= 1.5) {
        const dest = chargeDest(f, m, target, friends);
        if (dest) {
          m.intent = { type: "attack", x: target.x, y: target.y, charge: true, dest };
          m.chargeCd = CHARGE_CD;
          continue;
        }
      }
    }
    if (m.kind.ability === "arc" && d < 1.5) { // 旋刃鬼（PR1）：隣接時、前方弧3マスを薙ぐ（毎手・CD なし＝通常攻撃の形版）。非隣接は下の通常追跡で詰める。
      m.intent = { type: "attack", x: target.x, y: target.y, cells: arcCells(f, m.x, m.y, target.x, target.y) };
      continue;
    }
    if (m.kind.ability === "slam") { // 震地鬼（PR1）：@隣接で周囲8マスを叩きつける。CD 中や非隣接は下へ落ちる＝通常追跡/単点攻撃（この間に殴り込める）。
      if (m.slamCd && m.slamCd > 0) m.slamCd--;
      else if (d < 1.5) {
        m.intent = { type: "attack", x: target.x, y: target.y, cells: slamCells(f, m.x, m.y) };
        m.slamCd = SLAM_CD;
        continue;
      }
    }
    if (m.kind.ability === "beam") { // 射抜きの眼（PR1）：直線1..BEAM_MAX に標的が居れば撃ち抜く。CD 中は下へ落ちる＝1手おきに接近／非直線なら通常追跡で線に乗せにいく。
      if (m.beamCd && m.beamCd > 0) m.beamCd--;
      else {
        const beam = beamCells(f, m.x, m.y, target.x, target.y);
        if (beam) { m.intent = { type: "attack", x: target.x, y: target.y, cells: beam }; m.beamCd = BEAM_CD; continue; }
      }
    }
    if (m.kind.ability === "burst") { // 爆ぜ胞子（PR3）：@が距離2以内＋視線が通れば 3×3 を回避不能に予告。CD 中や範囲外は下の通常追跡で詰める（＝離れても追ってくる）。
      if (m.burstCd && m.burstCd > 0) m.burstCd--;
      else if (canBurstReach(f, m.x, m.y, target.x, target.y)) {
        m.intent = { type: "attack", x: target.x, y: target.y, cells: burstCells(f, target.x, target.y) };
        m.burstCd = BURST_CD;
        continue;
      }
    }
    if ((m.kind.reach ?? 1) >= 2 && monsterCanReach(f, m.x, m.y, target.x, target.y, m.kind.reach!)) {
      // 長柄（フェーズ2）：直線の距離1..reach なら「その場から突く」と予告（隣接でなくても討てる）。届かない/非直線なら下の通常追跡で間合いを詰める。
      m.intent = { type: "attack", x: target.x, y: target.y };
      continue;
    }
    if (d < 1.5) { // 隣接 → 標的の現在マスを討つと予告（退けば空振り＝見切り）
      if (m.boss === "area" && (m.bigCd ?? 0) <= 0) { // ①溜め大技：渾身の一撃を予告（退けば空振り＝読み合い）。D＝形つき確定範囲へ発展
        const shape = (m.bigShape ?? 0) % 3; // 直線→扇→薙ぎを大技ごとに巡回
        m.bigShape = shape + 1;
        const cells = bossShapeCells(f, m.x, m.y, target.x, target.y, shape);
        m.intent = { type: "attack", x: target.x, y: target.y, heavy: true, cells, shape };
        m.bigCd = m.enraged ? BOSS_HEAVY_CD_ENRAGED : BOSS_HEAVY_CD;
        continue;
      }
      m.intent = { type: "attack", x: target.x, y: target.y };
      continue;
    }
    // 追跡。erratic 率でぶれるが、ぶれた結果も予告に出るので盤面は読める
    let dx = Math.sign(target.x - m.x), dy = Math.sign(target.y - m.y);
    if (rng.next() < m.kind.erratic) { dx = rng.int(3) - 1; dy = rng.int(3) - 1; }
    const cand: Pos[] = [
      { x: m.x + dx, y: m.y + dy },
      { x: m.x + dx, y: m.y },
      { x: m.x, y: m.y + dy },
    ];
    let dest: Pos | null = null;
    for (const c of cand) {
      if (tileAt(f, c.x, c.y) === 1 && !(c.x === player.x && c.y === player.y) && !occupiedBy(f, c.x, c.y, m, friends)) { dest = c; break; }
    }
    m.intent = dest ? { type: "move", x: dest.x, y: dest.y } : { type: "wait" };
  }
  for (const b of births) { // 孵化した眷属を盤上へ（この手は無防備に現れ、次手から行動＝テレグラフ）
    const k = breederMinion(f.depth, f.diff ?? EASY_MODS);
    f.monsters.push({ id: `spawn_${f.depth}_${f.monsters.length}`, kind: k, hp: k.hp, x: b.x, y: b.y, awake: true, intent: null });
  }
}

/** 予告した intent を実行する。攻撃は確定命中・確定ダメージ（miss無し）だが、
 *  予告マスから退いていれば空振り（見切り）＝負けは読み違えとして納得できる（4-11A）。
 *  攻撃の標的は予告マスに居る者＝@ なら player ヒット、相棒なら companion ヒット。 */
export function resolveMonsters(f: Floor, player: Pos, companion?: CompanionEntity | null, allies?: readonly CompanionEntity[] | null): Resolution {
  const comp = companion && companion.hp > 0 ? companion : null;
  const friends: CompanionEntity[] = [...(comp ? [comp] : []), ...(allies ?? []).filter((a) => a.hp > 0)];
  const hits: MonsterHit[] = [];
  const dodges: Monster[] = [];
  for (const m of f.monsters) {
    if (m.hp <= 0 || !m.intent) continue;
    if (m.intent.type === "attack") {
      const ix = m.intent.x, iy = m.intent.y; // 局所化（クロージャ内では m.intent の絞り込みが失われるため）
      // 突進（フェーズ1）：予告どおり直線を詰めて着地点へ（塞がれたら手前で止まる）。移動後に通常の命中判定＝退かれていれば空振り（見切り）。
      const charging = m.intent.charge === true;
      if (charging && m.intent.dest) {
        const sx = Math.sign(m.intent.dest.x - m.x), sy = Math.sign(m.intent.dest.y - m.y);
        while (!(m.x === m.intent.dest.x && m.y === m.intent.dest.y)) {
          const nx = m.x + sx, ny = m.y + sy;
          if (tileAt(f, nx, ny) !== 1 || (nx === player.x && ny === player.y) || occupiedBy(f, nx, ny, m, friends)) break;
          m.x = nx; m.y = ny;
        }
      }
      const cells = m.intent.cells; // D＝形つき確定範囲（area ボス限定・cells 有りのときだけ集合判定）。通常敵は undefined＝単点判定（golden 不変）。
      let onPlayer: boolean, onComp: boolean;
      if (cells) {
        onPlayer = cells.some((c) => c.x === player.x && c.y === player.y);
        onComp = !onPlayer && cells.some((c) => friends.some((fr) => fr.x === c.x && fr.y === c.y));
      } else {
        onPlayer = player.x === ix && player.y === iy;
        onComp = !onPlayer && friends.some((c) => c.x === ix && c.y === iy);
      }
      if (onPlayer || onComp) {
        const heavy = m.intent.heavy === true; // ①溜め大技（B）：渾身の一撃＝倍率
        const dmg = monsterDmg(m, f) * (heavy ? BOSS_HEAVY_MULT : 1);
        if (m.kind.ability === "leech") m.hp = Math.min(m.kind.hp, m.hp + dmg); // 吸命＝命中ぶん自己回復（しぶとい）
        // 被弾マス（街防衛戦が味方の誰を撃たれたか特定する用）。単点なら intent マス＝従来一致。
        // 形つき（D）で味方が撃たれた場合のみ、範囲内の実際の味方位置を返す。
        let tx = ix, ty = iy;
        if (cells && onComp) { const fr = friends.find((f2) => cells.some((c) => c.x === f2.x && c.y === f2.y)); if (fr) { tx = fr.x; ty = fr.y; } }
        else if (cells && onPlayer) { tx = player.x; ty = player.y; }
        const hit: MonsterHit = { monster: m, dmg, target: onPlayer ? "player" : "companion", tx, ty };
        if (heavy) hit.effect = "heavy"; // web 側の演出（強い被弾）
        else if (charging && onPlayer) hit.effect = "charge"; // 突進の一撃（web 側の演出・突き飛ばしはしない）
        else if (m.kind.ability === "venom" && onPlayer) hit.effect = "poison"; // 毒はプレイヤーのみ（相棒に毒tickの器が無い）
        else if (m.kind.ability === "curse" && onPlayer) hit.effect = "curse"; // 深蝕の上塗り（プレイヤーのみ・深淵帯 minDepth>50＝golden 不変）
        hits.push(hit);
      } else dodges.push(m); // 予告マスから退いた＝見切り
    } else if (m.intent.type === "move") {
      const { x, y } = m.intent;
      if (tileAt(f, x, y) === 1 && !(x === player.x && y === player.y) && !occupiedBy(f, x, y, m, friends)) { m.x = x; m.y = y; }
    }
    m.intent = null;
  }
  return { hits, dodges };
}

/** 相棒の次手を予告（@に追従し、隣接した覚醒敵を討つ）。
 *  通常は決定論で rng を消費しないが、連帯深蝕で erratic>0 になると rng でぶれる（Phase B・テレグラフされる）。 */
export function planCompanion(f: Floor, player: Pos, comp: CompanionEntity, rng?: Rng, blockers?: readonly Pos[]): void {
  if (comp.hp <= 0) { comp.intent = null; return; }
  if (comp.stunned && comp.stunned > 0) { comp.stunned--; comp.intent = { type: "wait" }; return; }
  const block = blockers ?? null; // 街防衛戦＝他の味方の位置（互いに重ならない）。dive は未指定＝従来どおり。
  // 連帯深蝕の逸脱：奇癖が出ると、追従も攻撃も投げ出して当て所なく彷徨う（読める＝テレグラフ）。
  if (rng && comp.erratic && comp.erratic > 0 && rng.next() < comp.erratic) {
    const dx = rng.int(3) - 1, dy = rng.int(3) - 1;
    const x = comp.x + dx, y = comp.y + dy;
    const ok = tileAt(f, x, y) === 1 && !(x === player.x && y === player.y) && !occupiedBy(f, x, y, null, block);
    comp.intent = ok ? { type: "move", x, y } : { type: "wait" };
    return;
  }
  // 隣接する生きた敵がいれば討つ（最も近い＝最小添字で安定選択）
  const foe = f.monsters.find((m) => m.hp > 0 && Math.max(Math.abs(m.x - comp.x), Math.abs(m.y - comp.y)) <= 1);
  if (foe) { comp.intent = { type: "attack", x: foe.x, y: foe.y }; return; }
  // 交戦支援＝挟撃志向（2026-07-04 テストプレイFB「相棒が回り込まない」）：@ が敵と交戦中（隣接）なら、
  // ただ後ろで待たず、その敵へ寄る。目標＝敵を挟んで @ の反対側（挟撃位置）を最優先、
  // 塞がっていれば敵に隣接する空き床のうち相棒から最も近いもの（安定順）。
  // @ 交戦中の敵は @ の隣＝ leash は自然に保たれる。erratic（連帯深蝕の逸脱）はこの段より先に判定済み＝不変。
  const engaged = f.monsters.find((m) => m.hp > 0 && Math.max(Math.abs(m.x - player.x), Math.abs(m.y - player.y)) <= 1);
  const goal: Pos | null = (() => {
    if (!engaged) return null;
    const free = (x: number, y: number) =>
      tileAt(f, x, y) === 1 && !(x === player.x && y === player.y) && !occupiedBy(f, x, y, null, block);
    const flank = { x: engaged.x * 2 - player.x, y: engaged.y * 2 - player.y }; // 敵を挟んで @ の反対側
    if (free(flank.x, flank.y)) return flank;
    let best: Pos | null = null, bestD = Infinity;
    for (let dy2 = -1; dy2 <= 1; dy2++) for (let dx2 = -1; dx2 <= 1; dx2++) {
      if (dx2 === 0 && dy2 === 0) continue;
      const x = engaged.x + dx2, y = engaged.y + dy2;
      if (!free(x, y)) continue;
      const d = Math.max(Math.abs(x - comp.x), Math.abs(y - comp.y));
      if (d < bestD) { bestD = d; best = { x, y }; }
    }
    return best;
  })();
  // 目標（挟撃位置 or @）へ一歩＝8方向から「目標に最も近づく空きマス」を選ぶ（決定論＝走査順で安定）。
  // 同距離の横滑りも許す＝@ の真後ろから回り込める（通路で詰まらない）。遠ざかる一歩は踏まない。
  const tgt = goal ?? player;
  const dt = Math.max(Math.abs(tgt.x - comp.x), Math.abs(tgt.y - comp.y));
  if (dt <= (goal ? 0 : 1)) { comp.intent = { type: "wait" }; return; } // 挟撃位置に到達済み or @ の隣＝待機
  let bestC: Pos | null = null, bestScore = Infinity;
  for (let ddy = -1; ddy <= 1; ddy++) for (let ddx = -1; ddx <= 1; ddx++) {
    if (ddx === 0 && ddy === 0) continue;
    const c = { x: comp.x + ddx, y: comp.y + ddy };
    const blocked = (c.x === player.x && c.y === player.y) || occupiedBy(f, c.x, c.y, null, block);
    if (tileAt(f, c.x, c.y) !== 1 || blocked) continue;
    const cheb = Math.max(Math.abs(tgt.x - c.x), Math.abs(tgt.y - c.y));
    if (cheb > dt) continue; // 遠ざかる一歩は踏まない（振動防止＝同距離までは許す）
    const score = cheb * 100 + Math.abs(tgt.x - c.x) + Math.abs(tgt.y - c.y); // 同着はマンハッタンで安定タイブレーク
    if (score < bestScore) { bestScore = score; bestC = c; }
  }
  comp.intent = bestC ? { type: "move", x: bestC.x, y: bestC.y } : { type: "wait" };
}

/** 相棒の予告を実行（攻撃＝予告マスの敵に確定ダメージ／移動＝空きへ一歩）。撃破した敵を返す。 */
export function resolveCompanion(f: Floor, player: Pos, comp: CompanionEntity, blockers?: readonly Pos[]): CompanionResolution {
  if (comp.hp <= 0 || !comp.intent) return { hit: null, dmg: 0 };
  let res: CompanionResolution = { hit: null, dmg: 0 };
  if (comp.intent.type === "attack") {
    const { x, y } = comp.intent;
    const m = f.monsters.find((mm) => mm.hp > 0 && mm.x === x && mm.y === y);
    const dmg = comp.dmg ?? COMPANION_DMG;
    if (m) { m.hp -= dmg; res = { hit: m, dmg }; }
  } else if (comp.intent.type === "move") {
    const { x, y } = comp.intent;
    if (tileAt(f, x, y) === 1 && !(x === player.x && y === player.y) && !occupiedBy(f, x, y, null, blockers ?? null)) { comp.x = x; comp.y = y; }
  }
  comp.intent = null;
  return res;
}

// ---------- 経路・到達判定（既踏破の床のみ。FOV と同じく純粋・DOMフリー：web の自動移動/照準が使う） ----------

/** from→to の最短経路（既踏破の床マスのみ・4近傍 BFS）。到達不能/未踏破/壁なら null。 */
export function bfsPath(f: Floor, from: Pos, to: Pos): Pos[] | null {
  const W = f.w, H = f.h;
  if (to.x < 0 || to.y < 0 || to.x >= W || to.y >= H) return null;
  if (!f.explored[mapIdx(f, to.x, to.y)] || f.tiles[mapIdx(f, to.x, to.y)] !== 1) return null;
  const prev = new Int32Array(W * H).fill(-1);
  const start = mapIdx(f, from.x, from.y);
  prev[start] = start;
  const q: Pos[] = [from];
  for (let head = 0; head < q.length; head++) {
    const c = q[head];
    if (c.x === to.x && c.y === to.y) break;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
      const nx = c.x + dx, ny = c.y + dy;
      if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
      const i = mapIdx(f, nx, ny);
      if (prev[i] !== -1 || !f.explored[i] || f.tiles[i] !== 1) continue;
      prev[i] = mapIdx(f, c.x, c.y);
      q.push({ x: nx, y: ny });
    }
  }
  const ti = mapIdx(f, to.x, to.y);
  if (prev[ti] === -1) return null;
  const path: Pos[] = [];
  for (let cur = ti; cur !== start; cur = prev[cur]) path.push({ x: cur % W, y: Math.floor(cur / W) });
  path.reverse();
  return path;
}

/** プレイヤーから到達できる既踏破の床マス集合（BFS フラッド）。最寄りスナップと到達判定に使う。 */
export function reachableSet(f: Floor, from: Pos): Set<number> {
  const W = f.w, H = f.h, seen = new Set<number>();
  const si = mapIdx(f, from.x, from.y); seen.add(si);
  const q: Pos[] = [from];
  for (let h = 0; h < q.length; h++) {
    const c = q[h];
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
      const nx = c.x + dx, ny = c.y + dy;
      if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
      const i = mapIdx(f, nx, ny);
      if (seen.has(i) || !f.explored[i] || f.tiles[i] !== 1) continue;
      seen.add(i); q.push({ x: nx, y: ny });
    }
  }
  return seen;
}

/** タップ座標に最も近い「到達可能な既踏破の床」マス（指のズレを吸収）。無ければ null。 */
export function nearestReachable(f: Floor, from: Pos, cx: number, cy: number): Pos | null {
  let best: Pos | null = null, bd = Infinity;
  for (const i of reachableSet(f, from)) {
    const x = i % f.w, y = Math.floor(i / f.w);
    if (x === from.x && y === from.y) continue;
    const d = (x - cx) * (x - cx) + (y - cy) * (y - cy);
    if (d < bd) { bd = d; best = { x, y }; }
  }
  return best;
}

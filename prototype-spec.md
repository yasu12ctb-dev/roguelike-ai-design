# AIローグライク プロトタイプ最小仕様（v0）

> 本書は `design-snapshot.md`（設計合意）を実装に落とす **プロトタイプ v0 の仕様**。
> 思想は snapshot を正とし、本書は「v0 で何をどう作るか」を定める。
> 目的＝**§5 の最小ループが情緒的に刺さるかの検証**。面白さの検証が最優先で、最適化・配布は後。

最終更新: 2026-06-12 ／ 対象: v0（最小ループ一周）

---

## 0. 前提（design-snapshot からの継承）

- **実行時LLMは使わない**（snapshot 4-9）。LLM は制作時の鋳造所のみ。v0 のエンジンは**完全オフライン・決定論的**（乱数はシード固定で再現可能）。
- **提示形態＝ターン制テキスト/ASCII**（snapshot 4-5）。
- 体験の核＝**モデルC（堆積する世界）**。深みは蓄積データと因果還流に宿る（snapshot §3）。

---

## 1. アーキテクチャ

**3つを明確に分離する。**

```
┌─ 鋳造所 (foundry) ─ 制作時・別ツール ────────────┐
│  LLM/人手で断片・文法・予約セットピースを生成     │
│  → content/*.json として書き出し（同梱データ）    │
└──────────────────────────────────────────────────┘
            │ ビルド時に取り込む（静的データ）
            ▼
┌─ エンジン (engine) ─ 実行時・純ロジック ─────────┐
│  TypeScript。UI非依存。入力=状態+コマンド+content │
│  出力=次状態+描画用テキスト。決定論的（seed固定） │
│  ・永続層（セーブ/ロード = JSON）                 │
│  ・変質計算 / トーン選択 / スロット充填 / 痕跡保証 │
└──────────────────────────────────────────────────┘
            │ 状態・テキストを渡す
            ▼
┌─ 表示 (presentation) ─ PWA シェル ───────────────┐
│  ターン制テキスト/ASCII。キー入力→コマンド        │
│  v0 は最小（HTML+canvas or DOM）。iOSは将来       │
└──────────────────────────────────────────────────┘
```

- **言語：** エンジン＋表示＝**TypeScript**、配布＝**PWA**。将来 iPhone は Capacitor 包装 or 移植（データモデルは言語中立JSONなので持ち運べる）。
- **見た目の方向＝「A 発光グリフ」（2026-06-13 実機モック比較で確定）：** 文字グリフを世界の実体としつつ、発光・色・松明の減光・化石の明滅で現代化する（Brogue 系統）。縦持ちを基本レイアウトとする。モック＝ `proto/web/mocks/`。ステータスバーに地図ボタン（踏破範囲の俯瞰）。
- **操作系＝8方向（2026-06-17 確定・PR #98／web）：** プレイヤーも敵・相棒と同じ**8方向**で動く（旧・直交4方向のみは非対称＝プレイヤーだけ斜め回避できず一方的に詰められるため是正）。エンジンは元々8方向で無改修。入力は `dirMove()` に集約。
  - **スワイプ**＝8方向移動（`octant()`＝45°セクタ・tan22.5°≈0.414 で斜め/直交を判定）。**タップ**＝待機（迷宮）／隣接マスへ一歩・斜め含む（街）。**図でタップ**＝そこまで自動移動。
  - **方向パッド（D-pad）＝既定オン・8方向（中央＝待機）。** `≡` メニューからオンオフ・**位置（右下/左下）**を選択し `localStorage` に記憶。body 直下配置で `mapWrap` のタッチ判定と非干渉。**※ 2026-06-13 に一度「D-pad廃止」と確定したが、8方向化に伴い任意表示のオプションとして復活（この項が最新の正）。**
  - **キーボード**：矢印＋WASD（直交）／viキー yubn（斜め）／numpad 1-9（8方向＋5＝待機）／`.`＝待機。
  - 設定（D-pad オンオフ・位置）は localStorage のみでセーブ非依存＝既存セーブ無影響。CLI/デモはテキストメニュー据え置き。
- **鋳造所：** 言語自由（v0 は手書きJSON＋少量のLLM呼び出しで可）。**エンジンは content/*.json しか知らない**（鋳造所の実装に依存しない）。
- **決定論：** 同じ seed＋同じ操作列＝同じ世界。デバッグ・検証・再現に必須。乱数は seeded PRNG を一本通す。

---

## 2. データモデル（永続層スキーマ）

セーブデータ＝1つの `World`（プレイヤーごとに独立した宇宙）。型は TS インターフェイスで示すが、永続化は JSON。

```ts
// ---- 世界（セーブの最上位） ----
interface World {
  seed: number;                 // 決定論の種
  generation: number;           // 現在の世代番号（化石化のたびに+1）
  current: Character | null;    // 操作中のキャラ（潜行中）
  fossils: Fossil[];            // 恒久史に昇格した記録
  tracked: TrackedEntity[];     // 追跡対象（運命の弧を持つ少数）
  chronicle: ChronicleEntry[];  // 年代記（4-10A）
  town: TownState;
}

// ---- 操作キャラ ----
interface Character {
  id: string;
  name: string;
  archetype: string;            // 鋳造所のタグ語彙と一致
  lineage: Lineage;             // 系譜（4-10D）
  traits: string[];
  exposure: number;             // 深蝕量（4-10C。旧称:被曝。コード識別子は exposure のまま） 0..∞、深層滞在で増加
  depth: number;                // 現在深度
  bonds: Bond[];                // 関与した相手への絆/因縁
  alive: boolean;
}

interface Lineage {
  relation: "blood" | "pupil" | "none";  // 先代との関係
  ancestorFossilId?: string;              // 継いだ化石
}

interface Bond {
  entityRef: string;            // FossilId or TrackedId or 一時NPCの種ID
  value: number;                // 関与度（深く長いほど大）
  unfinished: boolean;          // 未完の因縁フラグ（4-7 最重視因子）
}

// ---- 化石（恒久史の一件） ----
interface Fossil {
  id: string;
  kind: "character" | "explorer" | "relic";
  origin: {                     // 痕跡保持の素材。再発見時に必ず差し込む
    name: string;
    archetype: string;
    gearTags: string[];         // 例: ["長剣","錆"]
    catchphrase?: string;
    epithet?: string;
  };
  death: {
    manner: DeathManner;        // 死に様（極の決定に寄与）
    finalAct: FinalAct;         // 死の瞬間の一手（4-10B）
    depth: number;
    generationCreated: number;
  };
  exposureAtDeath: number;      // 生前の深蝕（初期変質強度に加算：4-10C）
  bondAtDeath: number;          // プレイヤーの関与度（濃さブースト）
  tonePole: TonePole;           // loss | myth | grudge（finalAct+manner から確定）
  interventions: Intervention[];// 鎮魂/継承/供養の履歴
  lastTouchedGeneration: number;// 変質クロックの起点（干渉でリセット：4-1C）
  laidDepth: number;            // 出やすい場所（≒death.depth、場所性：4-7D）
}

type DeathManner = "noble" | "grievous" | "betrayed" | "peaceful" | "anonymous";
type TonePole = "loss" | "myth" | "grudge";

interface FinalAct {            // 4-10B：死亡時にプレイヤーが選ぶ
  choice: "guard_relic" | "curse_dungeon" | "leave_will" | "accept" ;
  // guard_relic→myth寄り / curse_dungeon→grudge寄り / leave_will→継承の種 / accept→loss寄り
  note?: string;
}

interface Intervention { type: "requiem" | "inherit" | "memorial"; generation: number; }

// ---- 追跡対象（運命の弧） ----
interface TrackedEntity {
  id: string;
  name: string;
  source: "seeded" | "player_legend" | "nemesis";
  arcType: "retire" | "doom" | "fall" | "lore_drift";
  beat: number;                 // 弧の進行度（世代をビートに進む）
  lastObservedGeneration: number;
  originRef?: string;           // player_legend なら元の FossilId
}

// ---- 年代記（4-10A） ----
interface ChronicleEntry {
  generation: number;
  kind: "birth" | "death" | "rediscovery" | "intervention" | "legend" | "rumor";
  text: string;                 // エンジンが生成した一行（後で読み返せる）
  refs: string[];               // 関連 Fossil/Tracked id
}

interface TownState {
  witnessNpcId: string;         // 長命の証人（4-10F）
  safety: number;               // 英雄数＝街の安全度（4-4D・当面フレーバー）
  memorials: string[];          // 慰霊碑など見た目の差分（4-6C）
}
```

> **設計注：** スキーマは snapshot の各確定事項を直接反映している——深蝕（4-10C）／死の一手（4-10B）／系譜（4-10D）／干渉でクロックリセット（4-1C）／痕跡保持の origin（4-2）／場所性 laidDepth（4-7D）。

---

## 3. 鋳造所コンテンツ・スキーマ（content/*.json）

エンジンが読む静的データ。v0 は各カテゴリ**少量**でよい（検証目的）。

```ts
// 断片：スロットを持つ文法テキスト。タグで適合する組み合わせだけ許す
interface Fragment {
  id: string;
  slotType: FragmentSlot;       // この断片がどの穴を埋めるか
  tags: {
    tone?: TonePole;            // loss|myth|grudge
    stage?: VariationStage;     // weathered|twisting|alien
    depthBand?: "shallow" | "mid" | "deep";
    archetype?: string;
  };
  text: string;                 // 例: "#origin.gear# を握った#ghost# が #behavior#"
}

type FragmentSlot =
  | "rediscovery_frame"   // 再発見の地の文（最上位テンプレ）
  | "ghost_noun"          // 亡霊/異物/守護者…の呼称
  | "behavior"            // 徘徊/呟き/襲撃…
  | "recognition"         // プレイヤーへの反応
  | "epithet" | "rumor" | "gear_desc" | "death_line" | "exposure_quirk";

type VariationStage = "weathered" | "twisting" | "alien";

// ストーリーレット：世界状態で発火するイベント断片
interface Storylet {
  id: string;
  prerequisites: Prereq[];      // 深度/世代差/化石の有無/絆 など
  weight: number;               // 4-7 の重みに乗る基礎値
  frameFragmentId: string;      // 本文の文法
  effects: Effect[];            // 絆+ / 因縁解消 / 干渉可能化 など
}

// 予約セットピース（山場用の高品質手作り。4-9C）
interface SetPiece {
  id: string;
  type: "legend_return" | "grudge_hunt" | "inheritance" | "echo_summon";
  prerequisites: Prereq[];
  frame: string;                // 作家が書いた高品質文法。スロットは origin から充填
}
```

**v0 で用意する最小コンテンツ（例数）：**
- `rediscovery_frame` … トーン3極 × ステージ3 = 9 種
- `ghost_noun` / `behavior` / `recognition` … 各極あたり 3〜5
- `death_line`（finalAct 4種に対応）… 4〜8
- `exposure_quirk`（深蝕の奇癖）… 5〜8
- `SetPiece` … `legend_return` と `grudge_hunt` の2型を各1（手作り）
- 街の `rumor` … 6〜10

---

## 4. プロセダルエンジン（中核ロジック）

### 4.1 変質の計算（snapshot 4-1 / 4-2 / 4-10C を一式に）

再発見時（lazy）に呼ぶ。**※係数は全て調整前提の初期値。**

```
入力: fossil, world.generation
gens   = world.generation - fossil.lastTouchedGeneration   // 干渉でリセット済み起点
depthC = min(fossil.death.depth / 50, 1.0)                 // 深度係数 0..1
// 朽ち（時間のみ・浅くても進む）
decay     = clamp(gens * 0.15, 0, 1)
// 歪み（深度×時間 ＋ 生前深蝕の加算：4-10C）
distort   = clamp(depthC * gens * 0.20 + fossil.exposureAtDeath * 0.05, 0, 1)
// ステージ
stage = distort < 0.34 ? "weathered" : distort < 0.67 ? "twisting" : "alien"
// トーン極は死の一手＋死に様で確定済み（fossil.tonePole）
// 関与度ブースト：濃さ・名指し度（描画の強調に使う）
intensity = clamp(distort + fossil.bondAtDeath * 0.05, 0, 1.2)
```

- **朽ち vs 歪み：** 浅層は `distort≈0` のまま `decay` だけ進む＝「ただ朽ちて読める」。深層は `distort` が伸び「別物」へ。snapshot 4-2 の二系統を再現。
- トーン極は生成時に `finalAct + manner` から確定し保存（再発見ごとにブレない）。

### 4.2 死の一手 → トーン極（4-10B）

```
guard_relic  → myth   （守護者・聖遺物寄り）
curse_dungeon→ grudge （怨霊・敵性化寄り）
leave_will   → myth or loss（継承の種を残す。関与が濃ければ myth）
accept       → loss   （静かな喪失）
manner=betrayed/grievous は grudge へ引っ張る補正、noble は myth へ補正
```

### 4.3 深蝕の蓄積（4-10C）

```
毎ターン or 階層移動時: character.exposure += depthBand係数
  shallow:0  mid:+0.02  deep:+0.06   // 調整前提
深層滞在が長いほど蓄積。閾値超過で奇癖（exposure_quirk 断片を付与）
死亡時: fossil.exposureAtDeath = character.exposure
```

### 4.4 スロット充填と痕跡保証（4-2 必須制約）

```
renderRediscovery(fossil, stage):
  frame = pickByTags(rediscovery_frame, {tone:fossil.tonePole, stage})
  text  = fillSlots(frame, {
            ghost: pickByTags(ghost_noun, {tone, stage}),
            behavior: pickByTags(behavior, {tone, stage}),
            recognition: pickByTags(recognition, {tone}),
            "origin.gear": fossil.origin.gearTags へ言い換え,
            "origin.name": fossil.origin.name,
            "origin.catchphrase": fossil.origin.catchphrase
          })
  ASSERT: text が origin の痕跡（gear or name or catchphrase）を最低1つ含む
          含まなければ別 frame で再試行（破綻防止）
  return text
```

- **痕跡保証は ASSERT で機構化**：差し込み元が必ず本文に出る。出自不明のランダム文は出ない（snapshot 4-2／信頼の構造的担保）。

### 4.5 再会の重み（4-7）

```
weight(entity) = base
  + 3.0 * (bond.unfinished ? 1 : 0)        // 未完の因縁＝最重視
  + 1.0 * bondValue
  + 1.5 * depthProximity(currentDepth, entity.laidDepth)
  + 0.5 * (generation - lastObserved)       // 不在の長さ
クールダウン: 直近観測した相手は一定世代/階層は重み激減
保証: 高 bond/unfinished は一定回数内に必ず番が回る
```

---

## 5. 最小ループ仕様（v0 の一周）

snapshot §5：**潜行 → 深蝕 → 死（最後の一手）→ 化石化 → 世代交代（系譜選択）→ 再発見 → 干渉 → 年代記**。

各ステップの I/O と状態遷移：

| # | ステップ | 入力 | 状態変化 | 表示 |
|---|---------|------|---------|------|
| 1 | キャラ生成 | 系譜選択(4-10D) | `current` 生成、lineage 反映 | 作成画面 |
| 2 | 潜行 | 移動コマンド | `depth↑`、`exposure +=`(4.3) | マップ＋ステータス |
| 3 | 遭遇 | 重み抽選(4.5) | 化石/追跡対象を配置、bond 更新 | 再発見テキスト(4.4) |
| 4 | 干渉(任意) | 鎮魂/継承/供養 | fossil.lastTouched=gen、因縁解消 | 干渉結果＋年代記追記 |
| 5 | 死 | （HP0等）→ 最後の一手(4-10B) | finalAct 確定 | 死亡画面（選択肢4つ） |
| 6 | 化石化 | finalAct+manner | Fossil 生成（tonePole/exposureAtDeath/bond）、`generation++` | 墓碑＋年代記追記 |
| 7 | 世代交代 | → 2へ（系譜選択） | 新 `current` | — |
| 8 | 年代記閲覧(任意) | コマンド | なし（読むだけ） | 歴史一覧(4-10A) |

**画面スケッチ（ASCII・イメージ）：**

```
[潜行]                          深度 12  世代 3  深蝕 ▓▓░░░
##########################
#........@.......#........#     探索者 アリア(2代目)
#...####.........k.......#     HP 18/22  気力 安定
#...#  #....§....#........#
##########################     > 北へ進む  > 調べる  > 引き返す

[再発見：怨念極/別物]
淀んだ水辺に、錆びた長剣を握った亡霊が佇んでいる。
生前の口癖『……まだ、足りない』を絶え間なく呟いている。
お前を認めると、その名を呼んで襲いかかってきた。
  ── かつての探索者 X（深度40で非業の死）
> 戦う  > 鎮魂を試みる(継承可)  > 退く

[死：最後の一手]
アリア(2代目) は深度12 で力尽きた。
最後に、何を為す？
  1) 遺品を抱いて守る        3) 後継へ遺言を遺す
  2) 迷宮を呪う              4) 静かに受け入れる

[年代記]
世代1  生  カイ、迷宮へ降りた
世代1  死  カイ、深度8で斃れる ─ 迷宮を呪った（怨念へ）
世代2  再  カイの亡骸を、アリアが発見した
世代2  干  アリアがカイを鎮魂した（因縁を閉じた）
世代3  ...
```

---

## 6. v0 スコープ（含む / 含まない）

**含む（最小ループに必須）：**
- 永続層スキーマ／セーブ・ロード（JSON）
- 変質計算（4.1）・トーン極（4.2）・深蝕（4.3）・スロット充填と痕跡保証（4.4）
- 再会重み（4.5）の基本形
- 死の一手（4-10B）／系譜選択（4-10D）／年代記（4-10A）／長命の証人NPC（4-10F・最小：年代記の語り部）
- 鋳造所コンテンツ最小セット（§3）と SetPiece 2型

**含まない（v1 以降）：**
- 戦闘の作り込み（v0 は最小の HP 判定でよい）
- 街の経済・回収業（4-10G）・残響召喚（4-10I）・ペーシングディレクター（4-10H）
- 追跡対象の運命の弧フル実装（v0 は seeded 数体＋弧の最小ビート進行のみ）
- モデルD、配布・課金、最適化

---

## 7. 次の一手（実装着手の順）

1. **content/*.json の最小セット**を鋳造所で作る（手書き＋少量LLM）
2. **エンジンのコア**：型定義 → 変質計算 → スロット充填(痕跡ASSERT) → 永続化
3. **最小ループの結線**（§5 の 1〜8）を CLI で一周（PWA 化はその後）
4. **情緒検証**：一周遊んで「刺さるか」。刺されば設計の核は正しい

---

## 8. 戦闘設計の参照（snapshot 4-11）

戦闘は snapshot **4-11「読める盤面 × 深蝕との取引」** に従い段階実装する：
①テレグラフ＋決定論戦闘 → ②ステ4種（体/力/理/心）＋レベル選択成長（職業廃止） → ③深蝕魔法・スキル → ④装備（武器/防具/遺物・異物＝未鑑定）→ ⑤鎮め筋。
死亡時の装備は化石 origin.gearTags に刻む（装備＝痕跡素材）。各段階の詳細仕様は実装PRで確定する。

**①テレグラフ＋決定論戦闘（実装済み・PR #10）：** 敵の手番を「予告（plan）→実行（resolve）」の2段に分割（`dungeon.ts` の `planMonsters`/`resolveMonsters`）。通常攻撃は確定命中・確定ダメージ（miss無し）、攻撃は予告マスに確定するので退けば空振り＝見切り。Web の予告表示は刷新：**移動＝行き先マスの背景ハイライト／攻撃＝自分の @ が赤く明滅**（旧・枠/点は廃止）。

**②ステ4種＋撃破XPでレベル選択成長（実装済み）：** 派生値は `progression.ts`。`Character.stats{body,power,reason,heart}`（初期値2）＋`level`＋`xp`。**最大HP=6+体×3**（体2→12）／**近接ダメージ=力+1**（力2→3）／**心**は毎ターンの passive 深蝕に係数 `max(0.3,1−(心−2)×0.12)` を掛けて低減（イベント由来の深蝕には不適用）／**理**は③の素養として保持。敵撃破でXP（堅さぶん）、必要量 `6+lv×6`、昇級でステ1つを+1（術習得は③で追加）。職業（流儀）はUI撤去・`archetype="wanderer"` 据え置き。セーブ `version=2`＋`migrateWorld` で旧セーブを補完（横断D）。キャラシートは ≡ メニュー。CLI は抽象戦闘ゆえXPを潜行/被弾で代替付与。

**③深蝕魔法・スキル（第1弾・実装済み・Web）：** 燃料＝深蝕（`spells.ts`／`Character.spells: string[]`）。**歪撃**（最寄り可視敵を確定討伐・威力 `理×2+2`・深蝕+0.15）／**静止の眼**（可視敵を2手停止・`Monster.stunned`・深蝕+0.20）／**影渡り**（敵から最遠の可視床へ瞬間移動＝逃走・深蝕+0.12）。**習得**＝レベルアップ選択肢に「術を識る」（ステ+1と二者択一）。**詠唱**＝「術」ボタン→術一覧→自動対象で発動、`endTurn()` に合流（＝1手消費）。手動ターゲットは未実装（自動対象で状態を増やさない方針）。理崩し/反転は次バッチ。CLIはステ成長のみ（`spells` は空で保持）。**セーブ version=3**＝`migrateWorld` は版数に関わらず欠落フィールド（stats/level/xp/spells）を常に補完する（版数判定だけに頼ると v2 セーブで `spells` 未補完→`includes` 例外でフリーズした不具合を修正）。Web には未捕捉例外で入力ロックが残らないよう `error`/`unhandledrejection` のセーフティ網も追加。術には**専用SE＋エリア点滅エフェクト**（`#fx`）。**シートはデバウンス**（表示後300ms以内のクリック無効＝直前のタップが出たてのシートを貫通して誤選択するのを防ぐ）。ランダム環境音（水滴等）は不評につき停止（ROADMAP横断Gで再設計）。

---

## 9. 遭遇イベント／ストーリーレット駆動の参照（snapshot 4-12）

化石／追跡対象との遭遇を、平坦な「再発見テキスト＋固定3動詞」から **ストーリーレット駆動のイベントノード** へ昇格させる（snapshot **4-12**）。中核ループは三段：

1. **状況の抽選** … 化石の{極/変質段階/死の一手/origin} × プレイヤーの{絆・未完・深蝕・系譜・所持品・深度} を prereq に、重み付き（§4.5／4-7）で `Storylet` を選ぶ。
2. **文脈依存の動詞** … 常設：鎮魂／継承／立ち去る。状況で追加：調べる／捜索／依頼／戦う。
3. **effects の還流** … 選択が世界状態を書き換える（化石/追跡対象/依頼/宝・異物/深蝕/絆/年代記/次の伏線）。次のプレイの遭遇が変わる＝モデルC の駆動。

**屋台骨は §3 の既存スキーマ** … `Storylet { prerequisites, weight, frameFragmentId, effects }`／`SetPiece`／`Fragment`／`Effect`。v0 はスキーマのみで未結線だったものを、本ループの中核として正式採用する。実行時LLMゼロ（4-9）：多様性は「ストーリーレット × 蓄積状態」の組み合わせで出し、痕跡保証 ASSERT（§4.4）を通す。**`Effect` の語彙（型）と係数、新動詞の I/O は実装PR（遭-①〜④）で確定する。**

**実装状況（2026-06-13）：** 遭-①（〈調べる〉＋effects還流・PR #13）／遭-②（〈捜索〉＋伏線フラグ→後続 prereq・PR #15）まで結線済み。`Storylet` は `investigate`/`search` の動詞分岐、`Prereq` は `flag`/`notFlag`（化石スコープ）、`Effect` は `plant` を持つ。`World.flags` に伏線を永続。

**イベント拡充の土台（snapshot 4-12 (F)(G)(H)）：** イベントは**コンテキスト別に型を切る**（遭遇 encounter／ダンジョン dungeon／街 town／依頼 quest）。各コンテキストはアンカー（スロット源）と動詞集合が異なるため、無区別の1プールにはしない。「ランダムに近い」は**コンテキスト内の大量プール × アンカー × 蓄積状態**で出す。NPC は**化石 `origin` を一般化した「アクター記述子」**に統合し、生者NPC＝鋳造所断片でその記述子を埋める（化石/生者を問わず同じスロット機構）。実装順＝(H)：①化石遭遇の厚みづけ＋ダンジョン文脈（NPC不要）→ ②アクター記述子 → ③街/依頼/生者。`Storylet` への `context` 付与とアンカー抽象は拡充の実装PRで導入する。

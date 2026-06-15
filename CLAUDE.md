# CLAUDE.md — セッション引き継ぎ

このリポジトリは「堆積する世界」——NetHack系ローグライクの現代化（個人開発・設計＋プロトタイプ）。
新しいセッションは本ファイルと下記2文書を読めば、引き継ぎなしで作業を継続できる。

## 必読ドキュメント（この順で）

1. **`design-snapshot.md`** — 設計思想と確定事項のすべて（4-1〜4-12）。用語集あり。これが正。
2. **`prototype-spec.md`** — 実装仕様（アーキテクチャ・データモデル・見た目の方向A・操作系）。
3. **`proto/README.md`** — 実行方法・構成。
4. **`ROADMAP.md`** — v0→完成までのマイルストン（M0〜M5）・横断ワークストリーム・抜け漏れチェック・着手順。

## 進め方のルール（ユーザーとの合意事項）

- **対話は日本語。**
- **設計の変更は必ず：議論 → ユーザーの明示承認 → snapshot/spec へ反映。** 承認前にファイルを書かない。「続けて」「進めて」は議論の継続であって書き込み承認ではない（過去2回事故あり）。
- **開発フロー：** feature ブランチ → PR 作成 → **ユーザーがレビュー・マージ** → GitHub Pages 自動デプロイ。マージ報告を受けたら Actions の success を確認して報告する。
- 本体は https://yasu12ctb-dev.github.io/roguelike-ai-design/ に公開（モック比較は `/mocks/`）。

## 技術メモ

- Node 22。`cd proto && node --experimental-strip-types src/demo.ts`（決定論デモ＝CIスモークテスト）。
- `npm run build:web`（esbuild。依存は esbuild のみ）。CLI: `npm run cli`。
- エンジンはブラウザセーフ（fs依存は `*-node.ts` に隔離）。決定論：seed → mulberry32 一本。
- **実行時LLMは使わない**（snapshot 4-9）。LLMは制作時の素材生成（鋳造所）のみ。

## 現在地（2026-06-15・PR #1〜#69 マージ済み）

v0 公開済み＋以下まで実装・公開。**M0/M1 完了・M2 ほぼ完了**（進捗詳細は `ROADMAP.md`）。

- **戦闘①〜⑤ 完了**：テレグラフ決定論戦闘／ステ4種(体/力/理/心)＋レベル選択成長(職業廃止)／深蝕魔法(術)／装備(武器/防具/遺物・異物・死亡刻印→継承で奪還)／鎮め筋(討つ/鎮める)。敵ティア×色・中/エリアボスも実装。
- **遭-①〜④ 完了**：化石遭遇のストーリーレット化〈調べる/捜索〉＋effects還流＋伏線連鎖／常設動詞フル結線(鎮魂/継承/立ち去る)／**遭-③ 依頼経済**／**遭-④ 山場SetPiece**（legend_return/grudge_hunt の固有決着）。
- **アクター記述子（PR #42・4-12G）**：生者NPC＝化石 origin の一般化。
- **歩ける街（snapshot §4-4B・PR #47-49）**：固定マップ `content/town.json` を `@` で歩く（全面可視）／看板に入る→屋内に固定店主→会話／**街⇄迷宮の往復制**（門 `>`→潜行／生還・死→世代交代で街へ）／街路の群衆(一般人/商人/貴族/悪人/冒険者)／封鎖された貴族街(門番＝将来解禁フック)。既存の噂(酒場)/年代記(書記)/旅人(群衆)を結線。
- **依頼経済（金貨制・PR #50-52）**：`Character.gold`／拾得物の売却／武具屋で購入・薬師で深蝕治療／**依頼(Quest)** ＝ギルド受注(到達/回収)→ダンジョン達成→金貨報酬。
- **イベント拡充 第2弾（PR #53）**：街の群衆 storylet 3→18件。
- **奉献の試練（クリア／長期目標・snapshot 4-13・PR #65 ほか）**：5印→深淵帯→帰還の試練→クリア判定（設計確定2026-06-15）。
- **プレイFB対応（PR #66〜#69・2026-06-15／公開版の体感修正）：**
  - 拾った装備の換金是正（snapshot 4-10C Phase4）：その場売り廃止→`Character.gearBag`（袋・容量＝`gearCapacity`＝レベル＋鞄）に持ち帰り、**街の武具屋(×0.6)／迷宮の行商人(×0.45・`maybeMerchantEncounter`)** に売る。
  - 街バグ：群衆の移動が速すぎ＋隣接で立ち止まり／2度話すと別人化を `CrowdActor` の素性キャッシュで解消。
  - 単一ボタン文言の場面適合化（「うなずく」「席を立つ」の乱用を是正）。
  - **町骨格の改修（snapshot §4-4B(B-4)）**：ダンジョン門を最南端→中央広場(28,22)／個人宅を3×3に小型化し6→12軒／**武具屋に店主2人**（武器担当ヴァロ／防具担当ベルガ＝`rollItemOfSlot` で各スロット必ず陳列）／**店内に雰囲気アクター**（`Interior.actors`/`furniture`・ギルド/酒場/教団は内部拡張＋調度）。
  - NPC重複の解消（snapshot §4-4B(B-2)）：断片プール拡張（`actor_name` 6→36 ほか 6→21）＋`sceneActorKeys` で同一来訪内の重複を引き直し。
- 見た目＝方向A（発光グリフ）・縦持ち。街グリフ規約＝看板:漢字／群衆:ラテン(c/$/n/t/f)／景物:漢字。
- セーブ **version=8**（gold/quests/town-scene 含む。`world.ts migrateWorld` 非破壊バックフィル）。歩ける街は **web 限定**、CLI/デモはテキストメニュー据え置き。

## 次のタスク（M2 仕上げ → M3。詳細は `ROADMAP.md`）

M2 の機能系は一通り完成。残りは以下。**店の他動詞は設計判断を含むため、着手前に必ず方針確認すること**（上記ルール）。

1. **店・施設の他動詞の肉付け＝完了**：慰霊堂（鎮魂・供養）／教団（深蝕と恩恵）／道具屋＝消耗品（持ち物 Phase1-3）／**書記＝伝説化承認(4-4)・ギルド＝等級・英雄譜(4-4)＝実装済み**。**全店の主要動詞が結線済み（stub なし）。** 持ち物は3段階完了（snapshot 4-10C 末尾）：Phase1（消耗品＋容量＝レベル＋道具屋）・Phase2（鞄＝装備スロット `bag`・容量+）・Phase3（自宅＝武具庫：消耗品 `World.stash`＋装備 `World.stashGear`＝世代越え／`STASH_CAP=60`・継承 `STASH_INHERIT=4` 枠ずつ）。伝説化＝`legendApprove`（神話極 myth の旧キャラを `TrackedEntity(player_legend)` 昇格→後世 `legend_return` の祝福＋英雄譜）。
2. **クリア／長期目標＝「奉献の試練」（snapshot 4-13）＝★設計確定済み（2026-06-15）★**：①5印（エリアボス撃破/因縁鎮魂/山場決着/旧キャラ伝説化/高深度到達＝World 蓄積・世代越え）で深淵帯を解錠＋②帰還の試練（聖遺物を地上へ生還）。報酬＝奉納/佩用選択・印はリセットせず反復可（H&S 継続）。**実装は段階的**：Phase1 印の収集＋可視化／Phase2 深淵帯＋聖遺物／Phase3 帰還の試練＋クリア判定＋報酬／Phase4 メタ達成（街塗り替え）。再利用フック＝`rewardKill`/`intervene(requiem)`/`fossilScene`(山場)/`legendApprove`/`enterFloor`／`makeAreaBoss`。
3. **イベント拡充の継続**（横断A・節目ごと）：遭遇/ダンジョンの storylet 増量。「出来るだけ多く・ランダムに近い」がユーザー方針。
4. **M3＝世界の動態**：運命の弧(4-6)・街の差分(4-4/4-6C)・残響召喚(4-10I・echo_summon)・ペーシング(4-10H)。

**実装の要所（街/経済/依頼/山場）：**
- 街シーン：`src/townscene.ts`（純粋・ブラウザセーフ）＋`src/web/main.ts` の `drawTown/drawInterior/townAct/interiorAct/questBoard/talkKeeper/smithBuy/healerTreat/legendApprove/heroRoll/lineageScene/lineageBoon`。データ＝`content/town.json`（建物追加=配列1行／区画解禁=`guards[].locked` を外す）。伝説化＝`legendApprove`（神話極の旧キャラ→`world.tracked` player_legend）。
- 持ち物：`items.ts CONSUMABLES`／`progression.ts carryCapacity・STASH_CAP(60)/STASH_INHERIT(4)`／`types.ts InventorySlot・World.stash(消耗品)・World.stashGear(装備)`＋`web/main.ts` の `storeBuy/storeSell/storeManage`（道具屋）・`homeDeposit/homeWithdraw/homeView`（自宅＝武具庫＝`kind:"home"`／消耗品＋装備を世代越え保管・`fossilizeCurrent` で各4枠に切詰め・装備は引き出して即装備スワップ）・`bagBtn`（潜行中に使用＝一手消費）・`addConsumable/applyConsumable/consumeOne`。消耗品追加＝`CONSUMABLES` に1行。
- 依頼：`src/quests.ts`（純粋：`generateOffers/onReachDepth/onRediscoverFossil/claimQuest`）＋`World.quests`。達成フックは `enterFloor`(到達)・`fossilScene`(回収)。
- 山場：`src/render.ts matchSetPiece`（型を返す）＋`fossilScene` の山場動詞。

**設計的負債：** 職業選択(流儀)は撤去済み(archetype="wanderer"固定)。`renderRumor` 出力に「深度深度N」の重複表示（既存テンプレ起因・要修正候補）。武具屋の act2「先代の刻印武器について訊く」は未結線（stub＝"まだ整っていない"）。`web/main.ts` に既知の型エラー2件（`Floor|null` を `Floor` 引数に渡す箇所・実害なし）。`tsc` スモークは `content-node`/`persist-node` を除外して確認している。


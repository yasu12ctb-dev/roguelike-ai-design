# CLAUDE.md — セッション引き継ぎ

このリポジトリは「堆積する世界」——NetHack系ローグライクの現代化（個人開発・設計＋プロトタイプ）。
新しいセッションは本ファイルと下記2文書を読めば、引き継ぎなしで作業を継続できる。

## 必読ドキュメント（この順で）

1. **`design-snapshot.md`** — 設計思想と確定事項のすべて（4-1〜4-12）。用語集あり。これが正。
2. **`prototype-spec.md`** — 実装仕様（アーキテクチャ・データモデル・見た目の方向A・操作系）。
3. **`proto/README.md`** — 実行方法・構成。
4. **`ROADMAP.md`** — v0→完成までのマイルストン（M0〜M5）・横断ワークストリーム・抜け漏れチェック・着手順。
5. **`adventurers.md`**（設定資料）— 冒険者150余名の設定集。金属6等級（4-4E）・中核★50＋種100＋ミスリル。制作時の素材で、運命の弧（4-6）・メイン/サブ区分つき。

## 進め方のルール（ユーザーとの合意事項）

- **対話は日本語。**
- **設計の変更は必ず：議論 → ユーザーの明示承認 → snapshot/spec へ反映。** 承認前にファイルを書かない。「続けて」「進めて」は議論の継続であって書き込み承認ではない（過去2回事故あり）。
- **開発フロー：** feature ブランチ → PR 作成 → **ユーザーがレビュー・マージ** → GitHub Pages 自動デプロイ。マージ報告を受けたら Actions の success を確認して報告する。
  - **PR 作成は Claude の判断で行ってよい（2026-06-16 ユーザー承認）。** まとまった単位（機能・リファクタ）が完成したら、確認を待たずに PR を作成してよい。マージはユーザーが行う。
- 本体は https://yasu12ctb-dev.github.io/roguelike-ai-design/ に公開（モック比較は `/mocks/`）。

## 技術メモ

- Node 22。`cd proto && node --experimental-strip-types src/demo.ts`（決定論デモ＝CIスモークテスト）。
- `npm run build:web`（esbuild。依存は esbuild のみ）。CLI: `npm run cli`。
- エンジンはブラウザセーフ（fs依存は `*-node.ts` に隔離）。決定論：seed → mulberry32 一本。
- **実行時LLMは使わない**（snapshot 4-9）。LLMは制作時の素材生成（鋳造所）のみ。

## 現在地（2026-06-17・PR #1〜#96 マージ済み）

v0 公開済み＋以下まで実装・公開。**M0/M1 完了・M2 ほぼ完了**（進捗詳細は `ROADMAP.md`）。

- **戦闘①〜⑤ 完了**：テレグラフ決定論戦闘／ステ4種(体/力/理/心)＋レベル選択成長(職業廃止)／深蝕魔法(術)／装備(武器/防具/遺物・異物・死亡刻印→継承で奪還)／鎮め筋(討つ/鎮める)。敵ティア×色・中/エリアボスも実装。
- **遭-①〜④ 完了**：化石遭遇のストーリーレット化〈調べる/捜索〉＋effects還流＋伏線連鎖／常設動詞フル結線(鎮魂/継承/立ち去る)／**遭-③ 依頼経済**／**遭-④ 山場SetPiece**（legend_return/grudge_hunt の固有決着）。
- **アクター記述子（PR #42・4-12G）**：生者NPC＝化石 origin の一般化。
- **歩ける街（snapshot §4-4B・PR #47-49）**：固定マップ `content/town.json` を `@` で歩く（全面可視）／看板に入る→屋内に固定店主→会話／**街⇄迷宮の往復制**（門 `>`→潜行／生還・死→世代交代で街へ）／街路の群衆(一般人/商人/貴族/悪人/冒険者)／封鎖された貴族街(門番＝将来解禁フック)。既存の噂(酒場)/年代記(書記)/旅人(群衆)を結線。
- **依頼経済（金貨制・PR #50-52）**：`Character.gold`／拾得物の売却／武具屋で購入・薬師で深蝕治療／**依頼(Quest)** ＝ギルド受注(到達/回収)→ダンジョン達成→金貨報酬。
- **イベント拡充 第2弾（PR #53）**：街の群衆 storylet 3→18件。
- **奉献の試練（クリア／長期目標・snapshot 4-13・PR #65 ほか／Phase4＝PR #101）＝Phase1-4 完了**：5印→深淵帯→帰還の試練→クリア判定→**メタ達成（街の塗り替え）**。Phase4（web限定・PR #101）＝奉献の碑/像が建つ（`refreshAscendMonument`/`monumentScene`・`world.ascended` 連動で `townLoop` 注入）／貴族街が反応（軽量アーク `noble_ack`＝`talkGuard` 台詞＋街路 storylet `tw_noble_ack` 一度きり・**門は解禁せず** Lv45「原初の証」アーク `noble` と別軸両立）／統治者の大命（`Quest.patron:"noble"`＋`generateNobleOffers`＝奉献後のみ高報酬・ギルド board 相乗り・反復可）。
- **プレイFB対応（PR #66〜#69・2026-06-15／公開版の体感修正）：**
  - 拾った装備の換金是正（snapshot 4-10C Phase4）：その場売り廃止→`Character.gearBag`（袋・容量＝`gearCapacity`＝レベル＋鞄）に持ち帰り、**街の武具屋(×0.6)／迷宮の行商人(×0.45・`maybeMerchantEncounter`)** に売る。
  - 街バグ：群衆の移動が速すぎ＋隣接で立ち止まり／2度話すと別人化を `CrowdActor` の素性キャッシュで解消。
  - 単一ボタン文言の場面適合化（「うなずく」「席を立つ」の乱用を是正）。
  - **町骨格の改修（snapshot §4-4B(B-4)）**：ダンジョン門を最南端→中央広場(28,22)／個人宅を3×3に小型化し6→12軒／**武具屋に店主2人**（武器担当ヴァロ／防具担当ベルガ＝`rollItemOfSlot` で各スロット必ず陳列）／**店内に雰囲気アクター**（`Interior.actors`/`furniture`・ギルド/酒場/教団は内部拡張＋調度）。
  - NPC重複の解消（snapshot §4-4B(B-2)）：断片プール拡張（`actor_name` 6→36 ほか 6→21）＋`sceneActorKeys` で同一来訪内の重複を引き直し。
- **冒険者イベントと同行（snapshot 4-14・確定2026-06-15／PR #74-77・2026-06-16）：**
  - **ROADMAP 反映（PR #74）**：4-14（生者＝書きかけの化石／キャラ起点5類型／同行）と content 運用方針（3層・context必須・実装済み機構のテキストのみ）をロードマップ化。
  - **context 場所分けの「器」（PR #75）**：`StoryletContext` を6種化＝`encounter/dungeon/street/tavern/guild/shop`（＋別軸 `quest/chest`）。旧 `"town"`→`"street"`。`selectTownStorylet(...,contexts)` で現在地を渡す（`web/main.ts townContextsHere()`＝mode/interior.kind から導出）。CLI/demo は既定で従来どおり。
  - **場所別 storylet（PR #76）**：tavern5/guild4/shop4 件を投入（storylets 97→110）。「場所で別の顔」を実体化。
  - **同行 4-14C Phase A（PR #77・Web限定）**：1体限定のグリッド相棒＝青系 `@`。`dungeon.ts` の `CompanionEntity`/`DownedActor`＋`planCompanion`/`resolveCompanion`（@追従・隣接攻撃・テレグラフ・決定論）／`planMonsters`/`resolveMonsters` が相棒対応（標的＝近い方）。戦死＝その床に絆つき化石ドロップ（`world.ts fossilizeCompanion`）→後世で再会。勧誘の入口＝街「同行を頼む」＋フロアの手負い（`&`）を救助。二人で生還＝絆+1・街に残存（`World.companion`・世代越え）。**Phase B/C は未実装**（連帯深蝕→奇癖→C 討つ/鎮める・見捨て→怨念化・等級↑/系譜）。
- **終始シビア＋深蝕魔法の大改修（snapshot 4-11F②③／PR #90-96・2026-06-17・全てユーザー承認）：** このスレッドの主成果。
  - **難易度軸＝終始シビア（Lv≈深度）**：XP曲線 `xpToNext=round(8+4L+0.8L²)`（Lv50≈37.6k）／敵は深度係数で無限スケール（`scaleKind`＝雑魚HP=6+1.6d・dmg=1+0.18d／エリアボス=雑魚×4+20）／壁ビルド抑制 `maxHp=6+3·min(体,16)+max(0,体−16)`／深度定数 `DEPTH_SEAL_AT 40`・`ABYSS_DEPTH 50`。
  - **深蝕魔法＝ロードアウト制＋35種**（`spells.ts`・攻8/制6/移6/援8/識3/召4）：取得無制限＋**構え `Character.loadout`（上限`LOADOUT_CAP=10`）**＝戦闘で撃てるのは構えだけ・入替は街の ≡「術を構える」（安全地帯のみ）。習得＝**4Lv間隔（`LEARN_EVERY`）＋`SpellDef.minLevel` で高効果術を高レベルゲート**（深淵boon/教団は不問）。状態異常 `Monster.slowed/fear/confused/rooted/weak/poison`＋プレイヤーバフ計時 `armorBuffTurns/attackBuffTurns/hasteTurns/deathDoorTurns`＋召喚一時味方 `SummonEntity[]`/`shadowGuard`/解呪 `cleanseTurns`（全て `main.ts` ephemeral）。バフ残量は `stBuff` バー表示。実装の正＝`spells.ts SPELLS`＋`web/main.ts castSpell`（新術＝1行+1分岐）。**残り5種（凍霧/業火床=地形ハザード・腐喰は実装済・弾き=遠隔敵待ち・眩耀/不和=要再設計）は後続。**
  - **プレイFB対応**：鑑定店（奇物堂 `oddments`→`appraiseShop`＝拾った異物を料金で開示）／迷宮拡張（`36+min(d,50)×42+min(d,50)`＝最大86×92・深度50頭打ち・敵/宝箱/化石遭遇も面積追従）／**宝箱復活の修正**（`floorCache`＝潜行内の階を保持）。
  - **QA是正**：**再潜行farm根絶**（`World.diveCount` を `genFloor` seedに混ぜ潜行ごと別ダンジョン）／**撃破XP×0.55**（`XP_KILL_MUL`＝Lv≈深度維持）／**系譜の術継承**（`Fossil.spells`→`createCharacter` で弟子3/血筋2を初期習得＝4-11F②実装）／召喚は疾走中も稼働。
- 見た目＝方向A（発光グリフ）・縦持ち。街グリフ規約＝看板:漢字／群衆:ラテン(c/$/n/t/f)／景物:漢字。迷宮＝@:プレイヤー(金)／相棒:@(青)／召喚:`ψ/‡/Ψ`(菫)／敵:記号×色tier／手負い:`&`(琥珀)。
- **操作系＝8方向（PR #98・2026-06-17確定／spec §45）：** プレイヤーも敵・相棒と同じ8方向（旧4方向の非対称を是正・エンジン無改修）。入力＝`dirMove()` 集約／スワイプ8方向(`octant`)／キー＝矢印・WASD・viキー yubn・numpad1-9・`.`待機。**D-pad＝既定オン・8方向(中央=待機)・`≡`メニューでオンオフ＋位置(右下/左下)選択＝localStorage**（2026-06-13の「D-pad廃止」を反転）。web限定・CLI据え置き・既存セーブ無影響。
- セーブ **version=9**（gold/quests/town-scene/`World.companion` 含む＋任意追加 `Character.loadout`・`World.diveCount`・`Fossil.spells` は `world.ts migrateWorld` 非破壊バックフィル）。歩ける街・同行・魔法ロードアウトは **web 限定**、CLI/デモはテキストメニュー据え置き。

## 次のタスク（M2 仕上げ → M3。詳細は `ROADMAP.md`）

M2 の機能系は一通り完成。**次スレッドの推奨着手＝(あ)新ビルドのテストプレイ→追加FB対応、(い)次の本命＝同行 Phase B/C（4-14C・要方針確認）／イベント拡充／M3 世界の動態。** ※「奉献の試練」は **Phase1-4 完了**（現在地参照）。残りは以下。**設計判断を含む箇所は着手前に必ず方針確認すること**（上記ルール）。

> **直近スレッド（2026-06-17）の引き継ぎメモ：** 深蝕魔法ロードアウト35種＋終始シビア数値＋迷宮拡張＋FB/QA是正までが #96 で公開済み（現在地参照）。**未検証＝ユーザーの実機テストプレイがこれから**（迷宮3倍・術ゲート・鑑定・farm根絶・XP×0.55 の体感）。テストFBが来たら最優先で対応。バランス調整候補＝`XP_KILL_MUL(0.55)`／`LEARN_EVERY(4)`／敵上限(42)／`minLevel` 配分。

1. **店・施設の他動詞の肉付け＝完了**：慰霊堂（鎮魂・供養）／教団（深蝕と恩恵）／道具屋＝消耗品（持ち物 Phase1-3）／**書記＝伝説化承認(4-4)・ギルド＝等級・英雄譜(4-4)＝実装済み**。**全店の主要動詞が結線済み（stub なし）。** 持ち物は3段階完了（snapshot 4-10C 末尾）：Phase1（消耗品＋容量＝レベル＋道具屋）・Phase2（鞄＝装備スロット `bag`・容量+）・Phase3（自宅＝武具庫：消耗品 `World.stash`＋装備 `World.stashGear`＝世代越え／`STASH_CAP=60`・継承 `STASH_INHERIT=4` 枠ずつ）。伝説化＝`legendApprove`（神話極 myth の旧キャラを `TrackedEntity(player_legend)` 昇格→後世 `legend_return` の祝福＋英雄譜）。
2. **クリア／長期目標＝「奉献の試練」（snapshot 4-13）＝★Phase1-4 実装完了（PR #65 ほか／Phase4＝PR #101）★**：①5印（エリアボス撃破/因縁鎮魂/山場決着/旧キャラ伝説化/高深度到達＝World 蓄積・世代越え）で深淵帯を解錠＋②帰還の試練（聖遺物を地上へ生還）。報酬＝奉納/佩用選択・印はリセットせず反復可（H&S 継続）。**Phase1 印の収集＋可視化／Phase2 深淵帯＋聖遺物／Phase3 帰還の試練＋クリア判定＋報酬／Phase4 メタ達成（街塗り替え＝碑/像・貴族反応 `noble_ack`・統治者大命 `Quest.patron`）＝すべて実装済み。** 再利用フック＝`rewardKill`/`intervene(requiem)`/`fossilScene`(山場)/`legendApprove`/`enterFloor`／`makeAreaBoss`。残課題＝数値バランス（聖遺物の深蝕加算/追手頻度）はテストプレイFBで調整。
3. **イベント拡充の継続**（横断A・節目ごと）：遭遇/ダンジョンの storylet 増量。「出来るだけ多く・ランダムに近い」がユーザー方針。器ができたので場所別（street/tavern/guild/shop）も増量可。**＋深蝕魔法カタログの残り5種**（凍霧/業火床＝地形ハザードの器・弾き＝遠隔敵の実装後・眩耀/不和＝確定命中/敵AI再標的で要再設計。`spells.ts SPELLS`＋`castSpell` に追加）。
4. **同行 4-14C の継続（次の本命・Web限定）＝Phase A 実装済み（PR #77）：** 残りは **Phase B**（連帯深蝕 `world.companion.exposure`→奇癖/erratic→**C：生者の相棒を「討つ（慈悲）／鎮める（心）」決着**）と **Phase C**（救助の**見捨て→怨念化**で grudge_hunt の宿敵を自分で執筆・生還の**等級↑/系譜記憶**・相棒固有 storylet）。**C の決着UXは設計判断を含むため着手前に方針確認**（上記ルール）。Phase A の素地として連帯深蝕は毎手加算済み。
5. **M3＝世界の動態**：運命の弧(4-6)・街の差分(4-4/4-6C)・残響召喚(4-10I・echo_summon)・ペーシング(4-10H)。

**実装の要所（街/経済/依頼/山場）：**
- 街シーン：`src/townscene.ts`（純粋・ブラウザセーフ）＋`src/web/main.ts` の `drawTown/drawInterior/townAct/interiorAct/questBoard/talkKeeper/smithBuy/healerTreat/legendApprove/heroRoll/lineageScene/lineageBoon`。データ＝`content/town.json`（建物追加=配列1行／区画解禁=`guards[].locked` を外す）。伝説化＝`legendApprove`（神話極の旧キャラ→`world.tracked` player_legend）。
- 持ち物：`items.ts CONSUMABLES`／`progression.ts carryCapacity・STASH_CAP(60)/STASH_INHERIT(4)`／`types.ts InventorySlot・World.stash(消耗品)・World.stashGear(装備)`＋`web/main.ts` の `storeBuy/storeSell/storeManage`（道具屋）・`homeDeposit/homeWithdraw/homeView`（自宅＝武具庫＝`kind:"home"`／消耗品＋装備を世代越え保管・`fossilizeCurrent` で各4枠に切詰め・装備は引き出して即装備スワップ）・`bagBtn`（潜行中に使用＝一手消費）・`addConsumable/applyConsumable/consumeOne`。消耗品追加＝`CONSUMABLES` に1行。
- 依頼：`src/quests.ts`（純粋：`generateOffers/onReachDepth/onRediscoverFossil/claimQuest`）＋`World.quests`。達成フックは `enterFloor`(到達)・`fossilScene`(回収)。
- 山場：`src/render.ts matchSetPiece`（型を返す）＋`fossilScene` の山場動詞。
- 同行（4-14C）：`types.ts Companion`＋`World.companion`／`dungeon.ts CompanionEntity・DownedActor・Floor.downed・planCompanion/resolveCompanion・COMPANION_DMG`（純粋・決定論）／`world.ts fossilizeCompanion`（戦死＝化石化）＋`web/main.ts` の `companion`(盤上 ephemeral)・`spawnCompanionNear/companionDies/rescueScene/recruitCompanion/offerCompanion/townContextsHere`・`enterFloor`(展開＋手負い配置)・`endTurn`(相棒手番＝攻撃/被弾/連帯深蝕)・`moveOrInteract`(救助bump/相棒と位置入替)・`draw`(青@/手負い`&`/テレグラフ)。相棒不在時はエンジン挙動が従来と完全一致＝既存セーブ無影響。

- 深蝕魔法ロードアウト（4-11F③・web限定）：定義の正＝`spells.ts`（`SPELLS`＝key/name/school/cost/desc/minLevel・`warpDamage`）。`types.ts Character.loadout`／`progression.ts LOADOUT_CAP(10)`。`web/main.ts` の `activeLoadout/learnSpell`（習得＝図鑑＋空き構えに自動装填）・`castSpell`（全術の盤面効果＝新術はここに1分岐）・`manageLoadout`（≡「術を構える」＝街のみ）・`handleLevelUps`（ステ+1常時＋`LEARN_EVERY`間隔の任意習得・`minLevel`ゲート）・`endTurn`（バフ計時減算/毒tick/召喚手番）。状態異常＝`dungeon.ts` Monster の `slowed/fear/confused/rooted/weak/poison`＋`planMonsters` で消費。**新術追加＝`SPELLS`に1行＋`castSpell`に1分岐**で「術」ボタン・習得・構えに自動で乗る。
- 迷宮スケール（4-11F②）：`dungeon.ts genFloor`（W/H=36/42+min(depth,50)・`scaleKind`深度係数・`regularHpAt`・敵count上限42・宝箱/部屋は面積比）。seed に `world.diveCount` を混入＝潜行ごと別ダンジョン。`web/main.ts floorCache`＝潜行内の階保持（再訪で宝箱復活しない）。`progression.ts xpForKill`（`XP_KILL_MUL=0.55`）。系譜の術継承＝`world.ts createCharacter`（`Fossil.spells` から弟子3/血筋2）。

**設計的負債：** 職業選択(流儀)は撤去済み(archetype="wanderer"固定)。`renderRumor` 出力に「深度深度N」の重複表示（既存テンプレ起因・要修正候補）。武具屋の act2「先代の刻印武器について訊く」は未結線（stub＝"まだ整っていない"）。**奇物堂の act1「奇妙な異物を買う」・act2「品の曰くを聞く」は未結線（stub）／act0「未鑑定品を鑑定する」のみ結線。** `web/main.ts` に既知の型エラー2件（`Floor|null` を `Floor` 引数に渡す箇所・実害なし）。`tsc` スモークは `content-node`/`persist-node` を除外して確認している。**魔法・迷宮の数値はテストプレイ前＝要バランス検証**（`XP_KILL_MUL`/`LEARN_EVERY`/敵上限/`minLevel`）。


# RFC：最期の残響（Last Echo）

**status: P1 全4種 実装済み（P1-A 静穏・遺言＝v0.159.0／P1-B 守り手・呪詛＝v0.160.0）。P2-A 相棒/縁者の残響（v0.161.0）。P2-B tonePole 機械修飾（v0.162.0）。P2-C alien 変質の形状変化（v0.163.0）。P2-E 呪詛の霧の世代跨ぎ拡大（v0.165.0）。P2-D 山場連結＋deathManner 副次修飾（v0.166.0・2026-07-19 承認）。方向性承認＝2026-07-18。★RFC の P1＋P2-A〜E 全実装完了（残る任意拡張はシード化石の残響化 micro＝P2-A スコープ外）。**

**P2-D（v0.166.0・2026-07-19 承認・web 限定＝main.ts のみ・engine 非改変・content/types/event-check 非改変・新規保存状態ゼロ・golden 8/8 完全不変・SAVE_VERSION 据置）＝これまで別系統だった「山場（grudge_hunt/inheritance）」と「残響盤面（curse/guard）」を1つの弧に連結し、deathManner を flavor 第二軸に。** 核＝連結は全て `fossilScene` が既に持つ `computeEcho`＋`matchSetPiece` の結果を web 側で合成するだけ（matchSetPiece/setpieces.json/types/SETPIECE_HANDLED 不変）。**①grudge_hunt×curse を影の状態で3分岐**（`floor.echo` の実状態を読む・新規保存なし）＝**影生存**：詫びる＝`echoPurifyCurse`（src=echo の霧だけ消え自然霧残す・影還る・gold 放棄）＋setpiece 印／撥ねつける＝生存 shade のみ hp/dmg ×`ECHO_ENRAGE_MUL(1.15)`（対象1体・1回＝`FossilEntity.resolved` で担保・`Monster.enraged` 非流用）。**影先討ち（対決済）**：reconcile 選択肢・一般鎮魂を出さず認識のみ（requiem/浄化/回復/印なし）。**浄化済み**：認識のみ・二重処理なし。一般「鎮魂する」は grudge×curse 全3状態で非表示（詫びると requiem 重複を統合）。**②不可逆な交換を選択前に明示**（本文＋ラベル「詫びれば印・戦利品放棄／討てば戦利品・印なし」・実UI用語「印」「金貨/戦利品」）。**③inheritance×守り手の二重付与解消**＝`alreadyInherited` 時は固有2択を認識決着1本へ置換（二度目 intervene/装備/形質/深蝕−0.4/相棒feat を全停止・冪等な setpiece 印のみ・一般鎮魂は残置）。**④deathManner 副次修飾**＝5値（noble/grievous/betrayed/peaceful/anonymous）の第二形容を決定論表引き・RNG非消費で peek/認識句に重ねる（flavor のみ・相棒 betrayed 対面文とは重複させない）。原則＝loss 基準／grudge は険しく報われる方向のみ（易化なし）。検証＝`e2e-echo.mjs` 48/48（P2-D ㉓〜㉘＝詫びる浄化/影先討ち対決側/enrage 1回・保存再開後同値/inherit 二重付与なし/deathManner 5値/grudge_hunt×非curse 負テスト・実 Chromium）＋`npm run check`（golden 8/8 完全不変・echo-check・event-check）。数値/文言はテスト調整候補。

**P2-C（v0.163.0・2026-07-18 承認・web 限定＝main.ts のみ・engine 非改変・golden 8/8 完全不変・SAVE_VERSION 据置）＝これまで peek のフレーバー1行だけだった変質段階 `stage`（weathered/twisting/alien）を初めて盤面の「形」に。** 本作の核「放置すれば深層の残響ほど歪む（4-1C＝変質クロックは放置で進み・鎮魂/継承で巻き戻る）」を盤面へ。**alien のみ**が形を変える（weathered/twisting は不変）＝面影を失い別の異形に。4種＝**守り手**：番人が「歪んだ番人」に（erratic＋hp/dmg ×`ECHO_ALIEN_WARD_MUL(1.1)`・易化させない方向のみ）／**呪詛**：怨念の影が「歪影」に（erratic＋hp ×`ECHO_ALIEN_SHADE_MUL(1.1)`）／**静穏**：静かなマスが square→十字（対角は安らがない＝安らぎが形を失う＝「変質は恩恵半減」に整合）／**遺言**：判読不能に＋型は最弱形（先見）へ縮退（武器種の冴えは失われる）。★可読性＝peek は既に「もはや面影は薄い」と alien を予兆済み。★「じっくり攻略」は不罰（変質は世代を跨ぐ放置で進む・鎮魂/継承で巻き戻せる）。★P2-E（呪詛の霧拡大）とは分離（curse の alien は影の異形化で扱う）。★実装教訓＝守り手は `intervene(inherit)` がクロックを巻き戻すので alien 判定を intervene の前に取る。検証＝`e2e-echo.mjs` 31/31（P2-C 3項目＝歪影/歪んだ番人/静穏の十字化を実測）。数値/re-skin はテスト調整候補。

**P2-B（v0.162.0・2026-07-18 承認・web 限定＝main.ts のみ・engine 非改変・golden 8/8 完全不変・SAVE_VERSION 据置）＝これまでフレーバー（オーラ色＋peek）だけだった tonePole（loss/myth/grudge）を初めて盤面ルールに。** 原則＝**loss=基準（無修飾）／myth=プレイヤー側の恵み（敵を弱めない＝パワークリープ回避）／grudge=より険しく、より報われる（易化させず敵を強くする方向のみ・報酬も増やして収支中立〜損）**。マッピング（全て web 定数・テスト調整候補）＝**静穏**：grudge 半径 −1（`ECHO_CALM_RADIUS-1`・張り詰めた安らぎ）／myth 鎮魂の深蝕減 ×`ECHO_MYTH_REQUIEM_MUL(1.5)`。**遺言**：grudge 読むだけで深蝕 +`ECHO_GRUDGE_WILL_COST(0.05)`（濁りは +`ECHO_GRUDGE_MUD_COST(0.15)`）／myth は濁っていても代償なし（神話の遺志は澄む）／loss 基準（濁りのみ +0.1）。**守り手**：grudge 番人 hp/dmg ×`ECHO_GRUDGE_WARD_MUL(1.15)`。**呪詛**：grudge 怨念の影 hp ×1.15＋撃破 gold 係数 +`ECHO_GRUDGE_SHADE_BONUS(2)`（×6→×8）／myth 浄化時にプレイヤー深蝕 −`ECHO_MYTH_PURIFY_RELIEF(0.15)`。各効果は効果時に `fossil.tonePole` を読むだけ（cross-floor 状態を増やさない）。検証＝`e2e-echo.mjs` 28/28（P2-B 5項目＝静穏半径/影 hp/影報酬/浄化恵み/番人 hp を tone 別に実測）＋golden 8/8 完全不変。数値は全てテスト調整候補。

**P2-A（v0.161.0・2026-07-18 承認・web 限定＝main.ts のみ・engine 非改変・golden 8/8 完全不変・SAVE_VERSION 据置・migrate 不要）＝残響の対象を「自血統のみ」から「自血統＋死んだ相棒（wasCompanion）＋縁を結んだ生者NPC（wasAlly）」へ拡張。** 核＝選定ゲートを新述語 `isEchoFossil(f)=f.kind==="character"`（シード explorer は自然に除外・`isOwnLineFossil` は系譜/継承の別軸ゆえ不変）へ。選定は関数 `pickFloorEcho()` に抽出（enterFloor と E2E が同一実コードを通る）。`computeEcho` は純関数のまま（相棒/縁者化石も全経路で `finalAct.choice` を持つ＝相棒→accept／見捨て→curse_dungeon／縁者→tone依存で guard/curse/will）＝改修不要。**情緒**＝残響の主が相棒/縁者だと分かる認識句（`echoBondTag`/`echoBondNote`）を peek＋守り手の遺品取得＋呪詛の影撃破/浄化に前置（対面時 fossilScene の認識は既存）＝「共に歩いた相棒／見捨てた相棒（宿敵として還る）／縁を結んだ者」。dupe 防止（inherit 記録・遺品復元不能で不採択）は相棒/縁者にも一様に効く。1フロア1残響の枠は自血統と共有（最新世代優先）。検証＝`echo-check` 12/12＋`e2e-echo.mjs` 23/23（P2-A 6項目＝相棒/縁者/見捨てた相棒の採択・シード除外・認識句・例外0）。数値/情緒句はテスト調整候補。**★シード化石は P2-A の対象外（承認範囲は相棒/縁者）＝要れば別の micro-拡張。**
承認された推奨＝P1 は4種全部／遺言の一行入力あり（スキップ可・空なら定型文＝死亡フローに既存）／対象は自血統限定／数値は全てテスト調整候補。
`design-snapshot.md`（正典）への反映は実装 PR と同時＝P1-A 分は 4-11(A) に additive 反映済み（残響の器＋静穏/遺言）。P1-B マージ時に guard/curse を追記する。
分割方針（ユーザー承認 2026-07-18）＝**P1-A**＝computeEcho 核＋オーラ/peek 表示＋静穏(accept)＋遺言(leave_will)〔受動・低リスク・新敵なし〕／**P1-B**＝守り手(guard_relic＝眠り番人)＋呪詛(curse_dungeon＝蝕の霧＋怨念の影)〔新敵/ハザード・高リスク〕。

---

## 1. 目的

このゲームの最大の独自性＝「死んだキャラクターが化石・噂・系譜として世界に残り、後世がその物語へ介入する」を、**テキスト・継承値・遭遇イベント**の層から**盤面ルール**の層へ一段降ろす。

> 死に方・最後の一手・武器・深蝕・最期の選択が、後世の**局所的な戦闘条件**になる。
> プレイヤーは死ぬとき、無自覚にではなく**選んで**、未来の自分への戦術条件を書く。

NetHack の幽霊・死体回収の模倣ではない。あちらは「死んだ場所に脅威と回収物が残る」だけだが、本案は**死の瞬間の選択（FinalAct）が残るものの形そのものを決める**。

## 2. 設計の核＝新しい状態を保存しない

**残響は保存しない。既存 Fossil から決定論的に導出する純関数である。**

```
computeEcho(fossil, worldTime) -> Echo | null
```

- **形（4種）** ＝ `fossil.death.finalAct.choice`（既存 enum・実装済み・全化石が保持）
  - `guard_relic` → 守り手の残響
  - `curse_dungeon` → 呪詛の残響
  - `leave_will` → 遺言の残響
  - `accept` → 静穏の残響
- **色と文言** ＝ `fossil.tonePole`（loss／myth／grudge）
- **濁り** ＝ `fossil.exposureAtDeath`（牙の閾値 1.5 以上で残響が濁る＝恩恵に代償が付く）
- **風化** ＝ `computeVariation(fossil, worldTime)`（weathered／twisting／alien）＝既存の変質クロックがそのまま残響にも流れる
- **遺品・型の中身** ＝ `fossil.origin.gearTags`／`fossil.spells`／`fossil.death.finalAct.note`

**応答の永続化も新設しない**。残響への応答はすべて既存 `intervene(world, fossilId, "requiem"|"inherit"|"memorial")` の記録として残る（冪等判定も interventions 配列で行う）。

→ **SAVE_VERSION 据置・migrate 不要・旧セーブの過去の死にも遡って残響が生える**（＝これまでの全プレイが資産化する）。

## 3. 4つの残響（P1 仕様）

対象＝**自分の血統の化石のみ**（`isOwnLineFossil`＝相棒/縁者/シードは P2）。1フロア最大1残響（配置済み化石のうち自血統・最新世代優先の1体）。表示＝既存の化石グリフに tonePole 色の淡いオーラ（新グリフは増やさない）＋peek で「◯◯の残響：（1行）」＝可読性 4-11A 準拠。

### 3-1. 静穏の残響（accept＝静かに受け入れた者）

- 化石の周囲 Chebyshev≤2 が「静かなマス」＝滞在中、**装備由来の深蝕蓄積（exposurePerTurn 正分）が 0 に**（負にはしない＝相殺 farm 不可）。加えて経路湧き増援（spawnWanderer）はこの半径に湧かない。
- **HP回復は与えない**（泉/安息所の希少性と終始シビアを守る）。深蝕側にだけ効く。
- **聖遺物携行中（帰還の試練 4-13C）には効かない**＝クリア動線の緊張は不可侵。
- 鎮魂（requiem）すると一度だけ深蝕 −0.3（既存 guardian_boon と同型・冪等）。

### 3-2. 遺言の残響（leave_will＝遺言を残した者）

- 踏み込むと**先代の遺言が読める**。`finalAct.note` があれば**プレイヤー自身が書いた実文**が後世の盤面に現れる（＝未来への手紙）。無ければ定型文。
- 一度きりの恩恵＝**先代の最後の武器種に応じた「型」**（その潜行限り・1回きり）：
  - 剣 → 次の受け1回だけ完全無効化（旧仕様の一瞬の再現＝先代の腕前）
  - 槍 → 次の突き1回は距離1減衰なし
  - 薙刀 → 次の会心薙ぎの stagger +1手
  - その他/素手 → 先見1回（次階の気配）
- 消費記録＝memorial。`exposureAtDeath≥1.5` の先代の遺言は**歪む**＝恩恵に深蝕 +0.1 の代償。

### 3-3. 守り手の残響（guard_relic＝遺品を守った者）

- 化石の傍に**遺品マス**（先代の `gearTags` 由来の実物を `itemByName` で復元）＋**番人1体**（眠り・非敵対）が残る。
- 鎮魂してから取れば番人は静かに崩れる。**鎮魂せず奪えば番人が目覚める**（＝戦って奪う）。どちらでも取得は inherit 記録で**一度きり**。
- **重複防止**＝襲名（heir）等で既に相続された装備は残響化しない（gearTags と相続の突合）。

### 3-4. 呪詛の残響（curse_dungeon＝迷宮を呪った者）

- 化石の周囲に**蝕の霧（既存 miasma ハザード流用）**＋**怨念の影1体**（既存種の re-skin・敵性）。
- 高リスク高リターン＝影を討てば先代のレベル比例の戦利品。**鎮魂（requiem）すれば浄化**＝ハザード消滅＋既存の鎮魂報酬。放置すれば変質が進み範囲が広がる（上限あり）。
- 報酬は**死んだキャラの持ち物・レベル由来で固定**＝意図的な呪い死 farm は常に損（死で失うもの＞残響の報酬、を規律として保証）。

## 4. 態度＝既存3介入＋放置

| 態度 | 実装 | 結果 |
|---|---|---|
| 鎮魂 | intervene "requiem"（既存） | 残響を安らげる（浄化・静穏強化・番人休眠）＋変質クロックのリセット（既存挙動） |
| 継承 | intervene "inherit"（既存） | 遺品・恩恵を受け取る（一度きり） |
| 記憶 | intervene "memorial"（既存） | 遺言を読む・名を呼ぶ（半減の敬意＝既存の流儀） |
| 放置 | 何もしない | `computeVariation` が進む＝twisting で恩恵半減・alien で残響が反転しかける（静穏→不穏の兆し、遺言→判読困難）。**「手を掛ければ守れる・放置で歪む」（4-1C）が残響にも通る** |

## 5. 規律（守るべき原則との突合）

- **恒久強化ゼロ**＝全恩恵は「その潜行限り・1回きり」。パワークリープなし。
- **難易度不可侵**＝HP回復なし・敵の弱体なし・聖遺物動線に不干渉。呪詛はむしろ局所的に難度を足す。
- **過密ゼロ**＝1フロア最大1残響・自血統限定（P1）。世代を重ねても増えない（最新1体優先）。
- **可読性**＝オーラ＋peek で必ず予兆。理不尽な不意打ちなし。
- **farm 不可**＝全恩恵が intervene 記録で冪等・自傷死は常に損。
- **静けさ**＝新UI・新一覧・マーカーなし。既存の化石遭遇の上に1層乗るだけ。

## 6. 実装アーキテクチャ（承認後の話・参考）

- **web 限定・engine 非改変**：`computeEcho` は純関数（variation.ts の隣か web 側）。盤面配置は `enterFloor` 初訪＝`hazards`／`aurelSite` と同じ「engine 非使用」実績パターン＝**golden 8/8 byte 不変**。
- 番人・怨念の影＝web から floor.monsters へ push（raid/QA と同じ既存手法）。ハザード＝既存 `layHazardField` 流用。
- **決定論**＝配置は floorCache に乗る（潜行内で一意）。導出はシード非依存の純関数。
- **SAVE_VERSION 据置**・migrate 不要。
- **Swift 移植**＝純関数1個＋表示のミラーのみ。
- 規模感＝P1 は「地形ハザードの器（v0.128.0）」と同程度の1PR（web 中心・E2E 付き）。

## 7. 段階案

- **P1（最小）**：4種の骨格・tonePole は文言差のみ・変質は恩恵半減まで。
- **P2-A（実装済み・v0.161.0）**：相棒/縁者の残響（wasCompanion/wasAlly＝情緒最大）。選定ゲート拡張＋認識句のみ・golden 不変。
- **P2-B（実装済み・v0.162.0）**：tonePole の機械的修飾（loss=基準／myth=恵み／grudge=険しく報われる）。golden 不変。
- **P2-C（実装済み・v0.163.0）**：alien 変質の形状変化（放置で歪む・4-1C を盤面へ・4種：歪んだ番人/歪影/静穏の十字化/遺言の判読不能）。golden 不変。
- **P2-D〜E（未着手・各別承認）**：山場（grudge_hunt/legend_return）との連結・deathManner の副次修飾・「呪詛の放置で霧が広がる」。

## 8. 未決事項（承認時に決めたい）

1. **`finalAct.note` の入力経路**：死亡フローで現在プレイヤーが一行書けるか要確認。無ければ「遺言を残す」選択時に一行入力を足す（これ自体も要承認・スキップ可・空なら定型文）。
2. 数値初期値：静穏半径2・遺言の型の内容・呪詛の報酬係数・濁り閾値1.5（いずれもテスト調整候補として実装）。
3. 対象を自血統限定（P1）でよいか。
4. P1 に4種全部入れるか、まず2種（静穏・遺言＝実装最軽量）で体感を見るか。

## 9. 悪用シナリオ検討（詰め）

| シナリオ | 対策 |
|---|---|
| 静穏マス滞在で深蝕相殺 farm | 蓄積を0に留める（負にしない）・聖遺物中無効 |
| 遺品 dupe（相続と二重取り） | 相続済み装備は残響化しない＋inherit 記録で一度きり |
| 意図的な呪い死で深部に報酬築造 | 報酬＝死者の持ち物・レベル由来で固定＝死の損失が常に上回る |
| 型の取り置き（全化石を巡回して恩恵束ね） | 1フロア1残響＋恩恵は取得潜行限り＝スタック不可 |
| 残響目当ての浅層即死マラソン | 浅層死は laidDepth が浅い＝次代の主経路（深度進行）と交差しにくい＋恩恵が微小 |

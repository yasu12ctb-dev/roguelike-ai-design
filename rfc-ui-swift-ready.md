# RFC：UI Swift-ready（Swift 移植前の UI ブラッシュアップ）

**status: 提案（実装未着手・RFC のみ）。起点＝Obsidian 台帳 2026-07-19 18:50 [codex] のUI全体監査。方向性承認＝2026-07-26（ユーザーが2論点を推奨案で合意）。Codex 検収＋ユーザー承認後に実装範囲を確定する。**

**このRFCは実装しない。** 成果物は本文＋差分表（§7）＋画面状態fixture案（§6）＋段階導入案（§8）の4点。Codex が実差分・実コードで検収し、ユーザーが承認して初めて実装範囲を決める。

**不変の前提（CLAUDE.md より・厳守）＝雰囲気（静謐な写本・発光グリフ・縦持ち単手）・色役割（HP/深蝕/金/バフ/警告・敵tier色・術学派色＝正典）・ゲーム挙動は変えない。** 全面再設計はしない。通常テーマの盤面を一律に明るくしない（高コントラストは OS 設定連動の別トークンで別途対応・§5）。easy/golden 契約変更は事前承認。

**基本方針（2026-07-26 ユーザー合意）：**
- **①UI正典の一本化＝`prototype-spec.md` §10 を唯一のUI正典に一本化し、旧 `design-spec.md` はアーカイブ明記（削除せず値は歴史資料として残す）。**（§2）
- **②段階導入＝意味論的画面モデルは「型定義＋対応表」として本RFC/§10で仕様化し、Swift 実装時に初めてコード化する。web 参照版は原則触らず、回帰リスクの低い一部（設定の内部IDディスパッチ化など）だけ先行を検討する。**（§3・§8）

---

## 1. 背景と問題認識

Codex 18:50 監査は「静謐な写本・発光グリフ・縦持ち単手の骨格は維持推奨・全面再設計不要」としつつ、Swift 完全再実装（案B・4-9E）の前に整えるべき5点を挙げた。本RFCは実コードで裏取りしたうえで、各点を課題として整理する。

| # | Codex 指摘 | 実コードでの裏取り（v0.166.0 / main `c031d0f`） |
|---|---|---|
| ① | UI正典の二重化 | `design-spec.md` 冒頭「見た目の**正**」・中身は旧仕様（寒色 `--bg-app #0c0f14`・角丸10–12px・タイトル「灯火／堆積する世界」・ゲージ発光）。`prototype-spec.md` §10 も「UI の**正**」・現行「静謐な写本」（墨紙 `#0e0c09`・朱 `#c2452f`・角3px・平墨線ゲージ）。**両者が正を主張し矛盾。** |
| ② | 生HTML＋文字列ディスパッチ | `chooseGrid` は `cells:{html:string}[]`（生HTML文字列）を受け取る（main.ts:267）。`settingsSheet` は `c.includes("BGM音量")` 等**日本語表示文字列でルーティング**（main.ts:7997-8012）。表示と分岐が密結合＝Swift の宣言的UIへ機械的に移せない。 |
| ③ | Swiftネイティブ化の未整理 | タブは**アイコンのみ**（`#tabbar .tab svg` 27px・可視ラベルなし・index.html:391-400）。版数は HUD 右上（`#stVer`）。D-pad は3×3・aria-label有り。 |
| ④ | アクセシビリティ未仕様 | §10 に触覚（10.10④）・Dynamic Type 布石（10.10⑤）はあるが、**高コントラスト／Reduce Motion／VoiceOver の盤面表現は未仕様**。 |
| ⑤ | fixture 受理ゲート不足 | `visual-check.ts` は **480×900 固定・輝度分散中心・`npm run check` 非同梱**（package.json に無し）。実機は 375×812。移植の受理ゲートとして不足。 |

**課題の本質＝現行 web は「動く参照実装」として十分だが、(a) UIの正が2冊に割れ、(b) 画面の意味がコード（生HTML＋文字列分岐）に埋もれ、(c) Swift ネイティブ部品への対応表と受理ゲートが無い。** Swift 実装者（将来のClaude/人間）が「§10 を読んで SwiftUI に落とせば正しく再現できる」状態にするのが本RFCのゴール。

---

## 2. UI正典の一本化（指摘①）

### 2.1 方針（合意済み）
- **`prototype-spec.md` §10 を唯一のUI正典とする。**
- **`design-spec.md` は削除せず、冒頭に「アーカイブ（旧仕様・歴史資料）」明記を追記して「正」の主張を撤回する。** 旧・寒色テーマ／灯火タイトルは別テーマ復帰時の値として参照可能なため保全する（値の破棄はしない）。
- §10 に、design-spec.md にしか無く現行仕様として有用な記述（後述 2.3）を追補する。

### 2.2 二重正典の具体差分（design-spec.md ＝旧／§10 ＝現）

| 項目 | design-spec.md（旧・要撤回） | prototype-spec.md §10（現・正） |
|---|---|---|
| 位置づけ宣言 | 「見た目の**正**」「移植の正」 | 「UI の**正**」 |
| アプリ地色 | `--bg-app #0c0f14`（寒色） | `bg-app #0e0c09`（墨紙・暖） |
| パネル/シート | `#10141a` / `#14181f`（寒） | `bg-panel #14110c` / `bg-sheet #17130e`（暖） |
| アクセント | （明示なし・金発光中心） | **朱 `--acc #c2452f`＋金泥 `#c9a75a`** |
| 角丸 | 10–12px（`5.` ボタン共通） | 角を立てる（`--r-btn/--r-card 3px`・`--r-chip 2px`） |
| ゲージ | 6px 角丸・グラデ＋発光（`5.2`） | 平墨線 5px・角0・発光/グラデなし＋牙の朱目盛（10.2b） |
| タイトル | 変種A「灯火」・ゲーム名「堆積する世界」 | 「静謐な写本」・落款「蝕」（10.2b） |
| HP token 記述 | 朱グラデ fill | 正典色 `--c-hp` の平線 fill |

> **注：`design-spec.md §2.4〜2.8`（ステータス色・グリフ役割色・敵ティア色・術学派色）は §10 の「正典＝不変」ブロックと一致**（役割色は不変）。矛盾しているのは**サーフェス（背景）・罫線・角丸・ゲージ様式・タイトル・タイポの一部**＝「静謐な写本（v0.96.0）」で刷新されたクロム層のみ。

### 2.3 §10 へ追補すべき design-spec.md の有用記述（現行仕様として不足している箇所）
- **アニメーション keyframes の意味論**（`pulse` 1.4–2.8s＝呼吸／`danger` .55s／`monatk` .5s／`tele` .55s／`fxflash` .4–.55s＝§10.3 のテレグラフ記述を補完する形で1表に）。
- **タイポのサイズ基準表**（盤面HUD12／シート14.5／ログ15＝設定13/15/17／メタ11／版数10.5・ウェイト・行間）＝§10 は色トークン中心でサイズ表が薄い。
- これらは「現行実装から抽出した実値」で現仕様と一致するため、§10 へ移設して design-spec.md はアーカイブ化する（値の二重管理をやめる）。

### 2.4 成果（実装フェーズで行うこと・本RFCでは提案のみ）
1. `design-spec.md` 冒頭にアーカイブ宣言を追記（1コミット・doc のみ）。
2. §10 に 2.3 の2表を追補（doc のみ）。
3. 以後「UIの正は §10」で運用（CLAUDE.md 必読ドキュメント欄は既に §10 を正典と記載済み＝追加変更不要）。

---

## 3. 意味論的な画面モデル（指摘②）

### 3.1 現状の問題
- **`chooseGrid(cells:{html:string}[])`** ＝カード見た目を**生HTML文字列**で組み立てて渡す（呼び出し側が `<div class=...>` を文字列連結）。Swift には移せない（HTML パーサを持たない・宣言的UIと相性最悪）。
- **`settingsSheet`** ＝選択肢を日本語表示ラベル（状態込み。例 `🎵 BGM音量：中（小→中→大）`）で作り、結果を `c.includes("BGM音量")` で分岐（main.ts:7997-8012）。**表示文言を変えると分岐が壊れる**／ローカライズ・A11yラベルと分岐キーが同一物。

### 3.2 目標＝ID付きの意味論的画面モデル（型で持つ・描画から分離）
画面を「データ（項目の配列）」として宣言し、レンダラ（web は DOM／Swift は SwiftUI）が描く。**web・Swift 双方が同じモデル型をミラーする**のが移植容易性の核。以下は仕様としての型案（実装言語非依存・TS 表記）。

```ts
// 画面 = セクションの列。各セクションは行の列。
type Screen = { id: string; title: string; subtitle?: string; sections: Section[] };
type Section = { id: string; header?: string; rows: Row[] };

// 行の種類（意味論）。表示テキストと「何をするか(action id)」を分離する。
type Row =
  | { kind: "info";   id: string; label: string; value?: string; note?: string; emphasis?: "dim"|"strong" }  // kv/自由文（読み取り専用）
  | { kind: "action"; id: string; label: string; role?: Role; icon?: IconId; badge?: Badge }                   // 押すと action(id) を発火
  | { kind: "toggle"; id: string; label: string; on: boolean }                                                 // オン/オフ（設定）
  | { kind: "picker"; id: string; label: string; options: {id:string;label:string}[]; selected: string }       // 循環/選択（小中大 等）
  | { kind: "card";   id: string; title: string; sub?: string; glyph?: {char:string; cls:string}; badge?: Badge; role?: Role }; // 一覧カード→詳細

type Role = "primary" | "cancel" | "danger" | "normal";  // 既存 sheet のボタン役割と一致（10.1）
type Badge = { text: string; tone: "gold"|"acc"|"buff"|"warn"|"dim" };  // ✓受取可・◦受注中 等の状態章
type IconId = "help"|"save-export"|"save-import"|"reset"|...;  // §4 SF Symbols 対応表のキー
```

**要点：**
- **ルーティングは `id`（安定キー）で行う**＝表示ラベル `label` はローカライズ／A11y自由。`settingsSheet` の `includes` 分岐は `row.id`（`"bgm-volume"` 等）に置換される。
- **見た目は `kind`＋`role`＋`badge`＋`glyph.cls`（正典色クラス）で宣言**＝生HTML文字列が消える。web レンダラが `kind` を見て既存の `.selgrid`/`.b-primary` 等を組む。
- 既存の `sheet({sections})`（構造化リスト・info 行）は本モデルの `kind:"info"` に相当＝**すでに半分は意味論化されている**（10.1）。不足は `chooseGrid`（card）と `settingsSheet`（toggle/picker/action）。

### 3.3 現 web → モデルの対応（移植マッピング）

| 現 web 実装 | 現状 | 目標モデル | Swift 実装先 |
|---|---|---|---|
| `sheet({sections})` の kv 行 | 半意味論化済（`SheetSection{rows}`） | `Row.info` | `LabeledContent` / `Text` |
| `sheet` のボタン列（role 付） | `SheetOption{role}` 済 | `Row.action{role}` | `Button(role:)` |
| `chooseGrid(cells:{html})` | **生HTML** | `Row.card{glyph,badge,role}` | `List`＋`NavigationLink`（カード→詳細） |
| `settingsSheet` の toggle 項目 | ラベル文字列＋`includes`分岐 | `Row.toggle{id,on}` | `Toggle` in `Form` |
| `settingsSheet` の循環項目（小中大・位置） | ラベル＋`includes`分岐 | `Row.picker{id,options,selected}` | `Picker`（.menu/.segmented） |
| `settingsSheet` の action（書出/読込/やり直す） | ラベル＋`includes`分岐 | `Row.action{id,role}` | `Button(role:.destructive)` |

### 3.4 このRFCでの扱い（段階導入・§8 と連動）
- **モデル型（3.2）と対応表（3.3）を §10 に「Swift ミラー用の画面モデル仕様」として追補する（doc のみ）。**
- **web 参照版は原則リファクタしない**（挙動回帰リスクを避ける・合意②）。ただし §8 の「低リスク先行候補」として、**設定の内部IDディスパッチ化**（表示ラベルはそのまま、分岐だけ `row.id` 基準へ）は挙動を1bitも変えずに実施可能なため、先行の是非を別途判断する。

---

## 4. Swift ネイティブ化の具体（指摘③）

§10.9/10.10 の指針を、Codex 指摘に沿って具体化する（すべて §10.10 の「Swift 専用の上乗せ」欄に追補する提案）。

- **タブバー＝SF Symbol＋可視ラベル。** 現 web はアイコンのみ（術=菫/地図=青）。Swift は `TabView`（または下部バー）で SF Symbol（10.10③の対応表：術=`wand.and.stars`／地図=`map`／ステータス=`person.crop.circle`／設定=`slider.horizontal.3`／ハブ=`book.closed`）＋**短い可視ラベル**（VoiceOver・学習性のため）。ラベル文言は §9 保留。
- **設定＝`Form` + `Toggle`/`Picker`。** §3 のモデル `toggle`/`picker`/`action` を SwiftUI 標準部品へ 1:1。破壊的操作（世界をやり直す）は `Button(role:.destructive)`＋確認ダイアログ。
- **D-pad ヒット領域 ≥ 44pt。** 現 web の D-pad は視覚サイズ（大/中/小）と実ヒット領域が一致。Swift は **最小 44pt（Apple HIG）を保証**（視覚は小さくてもタップ領域を拡張＝`contentShape`）。待機（中央「待」）含む9マス全て。
- **版数を設定フッタへ。** 現 web は HUD 右上に常時表示（最新判定用）。Swift は HUD を情報密度優先で整理し、版数は**設定画面フッタ**（`APP_VERSION`＋build 日）へ移す。※「最新かの判定を右上版数で行う」CLAUDE.md 運用は web 固有（PWA キャッシュ粘着対策）＝Swift は App Store 配信で不要。

---

## 5. アクセシビリティ仕様（指摘④）

**原則：雰囲気を壊さず OS 設定に連動する。通常テーマの盤面を一律に明るくしない。**

- **Dynamic Type**：現 `logSize`（小/中/大）を型スケールトークンとして持ち、Swift は `.dynamicTypeSize` で OS 設定に追従（10.10⑤ 既記）。盤面グリフは等幅維持のため上限クランプ（レイアウト崩壊防止）＋シート/ログは全域追従。
- **高コントラスト**：`@media (prefers-contrast)` / Swift `.accessibilityShowButtonShapes`・`legibilityWeight` 連動の**別トークンセット**を用意（`--bg-*`/罫線/文字のコントラスト比を上げた派生）。**盤面の正典役割色（HP/深蝕/敵tier/術学派）は不変**＝背景・罫線・文字のコントラストのみ引き上げる。既定（雰囲気優先）と高コントラストの2系統をトークンで分岐。
- **Reduce Motion**：`prefers-reduced-motion` / Swift `.accessibilityReduceMotion` で pulse/danger/monatk/torchflick/abyssair/tileFx/FloatFx の**アニメを静止 or 最小化**（テレグラフの「来る」情報は色/枠の静的表現で担保＝ゲーム可読性を落とさない）。
- **VoiceOver（盤面の表現が核）**：
  - **盤面全体は「セル群」ではなく、要約された単一の accessibility 要素**にする（数十マスを個別読み上げさせない）。読み上げ例＝「深度12・中層。周囲に敵3体（うち攻撃予告1）。北に階段。HP 68%・深蝕 42%」。
  - **選択（調べる／照準）したマスは個別に説明**＝現 `#peek`（傷語・状態異常・能力ヒント・§10.3）を VoiceOver ラベルとして読む。移動は D-pad ボタン（既に aria-label 有り）。
  - シート/カード/設定は §3 モデルの `label`/`value`/`badge`/`role` を accessibility ラベル・trait（`.isButton`/`.isSelected`）へ機械変換。
  - 触覚（10.10④）は VoiceOver と併用（会心=heavy 等）。
- **このRFCでの扱い**：§10 に「10.11 アクセシビリティ」節を新設する提案（doc のみ）。実装は Swift フェーズ。web 参照版へ最小の布石（高コントラスト用の派生トークン定義・prefers-reduced-motion ガード）を入れるかは §8 で判断。

---

## 6. 受理ゲート＝画面状態 fixture（指摘⑤）

### 6.1 現状の不足
`visual-check.ts` は 480×900 固定・輝度分散（明度プロファイル）中心・`npm run check` 非同梱＝「画面が真っ黒に壊れていないか」は見るが、**移植の受理（Swift が §10 を正しく再現したか）には使えない**。

### 6.2 目標＝「画面状態 fixture」による回帰ゲート
**固定状態（seed・world・画面種を固定した決定論的スナップショット）**を列挙し、各 fixture で以下を検査する：

- **(a) スクリーンショット回帰**：実機相当 **375×812**（＋任意で 320×568 小型・430×932 大型）で撮影。ピクセル完全一致は脆いので、**構造ハッシュ or 差分閾値**（PIL で領域別明度・要素位置を実測＝CLAUDE.md の PIL 定量化方針を踏襲）。
- **(b) オーバーフロー検査**：本文/ボタン列/カードが**セーフエリア・画面外にはみ出ていない**（`scrollHeight>clientHeight` の想定範囲・末尾ボタン可視性）。長い化石名・最大ステ・満杯の荷物など**極端な状態**を fixture 化。
- **(c) アクセシビリティ回帰**：全 action/toggle/card 行が **ID を持ちラベルが空でない**（§3 モデルの整合）／タップ領域 ≥44pt／高コントラスト・Reduce Motion 適用時のスナップショット。

### 6.3 fixture の列挙（案・§7 の画面一覧と対応）
タイトル／街／屋内（店）／迷宮（浅・深・深淵＝松明帯3種）／地図（パン・全体図）／照準／HUD（バフ満杯・深蝕高・HP瀕死）／ステータス（`charScreen`）／装備・荷物（満杯）／術（構え・図鑑）／進行中（依頼/因縁/印）／設定（4グループ）／各遭遇オーバーレイ（化石/宝箱/ボス決着/レベルアップ/昇格）／死の選択。

### 6.4 実装形態の論点（§8・Codex 検収で確定）
- **どこで撮るか**：現 `visual-check.ts` を拡張して 375×812＋fixture 列挙にするか、新ツールにするか。
- **`npm run check` 同梱可否**：スクショ回帰は playwright 依存＝**CLAUDE.md 規約「playwright は package.json に入れない／CI に無い」に抵触**。⇒ 現実解＝**(c) の構造検査（ID/ラベル/オーバーフロー＝DOM から playwright 無しで検証できる部分）だけ `npm run check` 同梱**、(a) スクショは**ローカル専用の手動ゲート**（e2e-*.mjs と同じ扱い＝日本語パス対応済み）。この線引きが妥当か Codex 検収で確認。
- **Swift 側の対応**：同じ fixture 定義を Swift の XCUITest スナップショットでも使う（fixture= seed+画面種の宣言データ＝両実装が共有）。

---

## 7. 差分表（現 web 実装 → Swift ミラー目標）

| 画面/部品 | 現 web 実装 | Swift ミラー目標状態 | 依拠 |
|---|---|---|---|
| 画面遷移の記述 | 生HTML＋文字列 includes 分岐 | `Screen`/`Section`/`Row`（ID付きモデル・§3） | ② |
| タイトル | `#title` オーバーレイ・音声ゲート | `ZStack`（ビネット+題+メニュー）・autoplay ゲート不要 | ③ |
| HUD | 上部固定・版数右上・平墨線ゲージ | 情報密度整理・**版数は設定フッタ**・ゲージは自前バー（正典色） | ③ |
| タブバー | アイコンのみ SVG | **SF Symbol＋可視ラベル** | ③ |
| 盤面 | 等幅グリフ＋発光＋テレグラフ | 等幅テキスト/軽量描画＋`.shadow`・**VoiceOver=要約単一要素+選択マス説明** | ③④ |
| シート（sheet） | `sections`/role 済 | `List`/`Section`/`LabeledContent`/`Button(role:)` | ②③ |
| カード一覧（chooseGrid） | 生HTML | `List`＋`NavigationLink`（`Row.card`） | ② |
| 設定 | ラベル includes 分岐 | `Form`＋`Toggle`/`Picker`/`Button(role:)`（`Row.toggle/picker/action`） | ②③ |
| D-pad | 3×3・視覚サイズ=ヒット領域 | ヒット領域 **≥44pt** 保証（`contentShape`） | ③ |
| アイコン | 線画 SVG（`ICONS`） | SF Symbols（10.10③ 対応表） | ③ |
| 触覚 | no-op | `UIImpactFeedbackGenerator`（10.10④） | ③ |
| 文字サイズ | `logSize` 小中大 | Dynamic Type（`.dynamicTypeSize`） | ④ |
| 高コントラスト | なし | `prefers-contrast` 連動の別トークン（役割色不変） | ④ |
| Reduce Motion | なし | アニメ静止化（テレグラフは静的表現で担保） | ④ |
| 受理ゲート | visual-check 480×900・check外 | 画面状態 fixture（375×812・オーバーフロー・a11y・§6） | ⑤ |
| UI正典 | §10 と design-spec.md が二重 | §10 一本化・design-spec はアーカイブ | ① |

---

## 8. 段階導入案

**基本＝「仕様を先に固め、web は原則触らず、Swift 実装時にモデル化する」（合意②）。** リスク順に3層。

### Phase U0：正典・仕様の整備（doc のみ・回帰リスクゼロ・最優先）
1. `design-spec.md` アーカイブ宣言追記（§2.4-1）。
2. §10 に不足記述追補＝アニメ keyframes 表・タイポサイズ表（§2.3）。
3. §10 に「画面モデル仕様」（§3.2 型＋§3.3 対応表）追補。
4. §10 に「10.11 アクセシビリティ」新設（§5）＋「10.10」に SF Symbol タブ/D-pad 44pt/版数フッタ追補（§4）。
5. §10 に「10.12 画面状態 fixture」新設（§6）。
→ **すべて doc PR。ゲーム挙動・golden・版数に無関係。** Codex は doc の内部整合を検収。

### Phase U1：低リスクの web 先行（挙動不変・要個別承認）
- **設定の内部IDディスパッチ化**：`settingsSheet` の分岐を表示ラベル `includes` → 内部 `id` 基準へ（表示は1文字も変えない・挙動不変・§3.4）。移植容易性が上がり、将来の文言変更で分岐が壊れる負債も消える。**golden 非関与（web UI 層）・E2E で無回帰を裏取り。**
- **高コントラスト用の派生トークン定義＋`prefers-reduced-motion` ガード**（既定の見た目は不変＝OS 設定 ON 時のみ発火）。
- **画面状態 fixture の構造検査部（ID/ラベル/オーバーフロー）をツール化**（§6.4・スクショ抜きなら playwright 依存を最小化できる範囲で）。
→ 各項目は独立・個別にユーザー承認を取ってから着手。**chooseGrid の生HTML→cardモデル化は「大改修＝回帰リスク中」ゆえ Phase U1 に含めない**（Swift フェーズで実施 or 別途大きめ承認）。

### Phase U2：Swift 実装（M6・別フェーズ）
- §10（U0/U1 で整備済）を SwiftUI にミラー。画面モデル型を Swift struct として実装＝web の生HTML/文字列分岐を経由せず、宣言的UIへ直接。
- 画面状態 fixture を XCUITest スナップショットで共有。

---

## 9. スコープ外・保留

- **タブラベルの最終文言**（術/地図/ハブ/ステータス/設定の可視ラベル）＝Codex 18:50 保留事項。Phase U2 で確定。
- **探索中ログの折り畳み要否**＝Codex 保留事項。UI 情報設計の別論点として本RFCに含めない。
- **chooseGrid の web 側 card モデル化**＝回帰リスク中ゆえ Phase U1 除外（Swift フェーズ or 別承認）。
- **HUD の情報再設計・iPad 詳細HUDトグル**（10.10 上乗せ欄）＝Swift 専用の後工程。
- **雰囲気・色役割・ゲーム挙動・easy/golden 契約**＝不変（本RFCの対象外）。

---

## 10. 検収観点（Codex 向け）

1. **§2 一本化**：design-spec.md（旧）と §10（現）の差分表（2.2）に事実誤りがないか。§2.3 で §10 へ移すべき記述の選定が妥当か（役割色は既に一致・矛盾はクロム層のみ、の整理）。
2. **§3 モデル**：型案（3.2）と対応表（3.3）が現 `sheet`/`chooseGrid`/`settingsSheet` の実挙動を正しく抽象化しているか。ID ルーティング化で失われる機能がないか。
3. **§5 A11y**：VoiceOver「盤面=要約単一要素＋選択マス説明」で操作性が成立するか。高コントラストが「役割色不変・背景/罫線/文字のみ」で雰囲気を壊さない線引きとして妥当か。
4. **§6 fixture**：`npm run check` 同梱を「構造検査（ID/ラベル/オーバーフロー）だけ・スクショはローカル手動」に割る線引き（6.4）が、playwright 非同梱規約と両立し受理ゲートとして十分か。
5. **§8 段階導入**：Phase U0（doc のみ）→U1（低リスク web 先行・個別承認）→U2（Swift）の順と、chooseGrid card 化を U1 から外す判断が妥当か。

---

## 付録A：一本化後の正典所在（確定後の姿）
- **UI の正＝`prototype-spec.md` §10**（配色/様式/グリフ/HUD/操作/レイアウト/画面モデル/A11y/fixture/Swift指針）。
- **設計の正＝`design-snapshot.md`**（ゲーム設計・4-x）。
- **`design-spec.md`＝アーカイブ**（旧・寒色テーマ／灯火タイトルの歴史的実値・別テーマ復帰時のみ参照）。
- **セッション引き継ぎ＝`CLAUDE.md`**（既に §10 を UI 正典と記載済み）。

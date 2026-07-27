# RFC：UI Swift-ready（Swift 移植前の UI ブラッシュアップ）

**status: 改訂版 v3（実装未着手・RFC のみ・Codex 再検収待ち）。起点＝Obsidian 台帳 2026-07-19 18:50 [codex] のUI全体監査。方向性承認＝2026-07-26。v2＝00:51 [codex]／v3＝01:34 [codex] の修正必須を反映。Codex 再検収＋ユーザー承認後に実装範囲を確定する。**

**このRFCは実装しない。** 成果物は本文＋差分表（§7）＋画面状態fixture案（§6）＋段階導入案（§8）の4点。Codex が実差分・実コードで検収し、ユーザーが承認して初めて実装範囲を決める。

> **改訂履歴：**
> - **v3（2026-07-27・01:34 [codex] 修正必須4項）** ＝①§3 `Row` を現 `SheetRow` の表現力まで＝`info`（kv）と `text`（自由文）を別 variant にし双方 `tone?`／`SemTone` を §10.2 正典 token に 1:1 の完全集合（別名排除・単一の出所から機械生成）。②`Row.input` を `text`/`number` の判別 union にし実 5 経路（名前/最期の言葉/セーブ読込/テストLv/テスト深度）に訂正（「自由入力」「複数行」の誤りを是正）。③§6/§8 の fixture 循環を解消＝(1a) validator＋(1b) 実装済み subset conformance に分け全画面 conformance は Swift U2 へ。④§4/§5 の A11y＝D-pad「8方向＋待機」・VoiceOver 通知の coalesce/優先・高コントラストの対象別基準＋色以外の識別手段。
> - **v2（2026-07-27・00:51 [codex] 修正必須4項）** ＝§3 `Row.input`／`glyph.tone`・§5 高コントラスト訂正＋VoiceOver 3点・§6 fixture 3層＋platform 別画像・§8 U1 分割。
> - **v1（2026-07-26）** ＝初版（PR #390・main マージ済み）。

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
// ★現 SheetRow は「kv行 {label,value,note?,cls?}」と「自由文行 {text,dim?,cls?}」の2 variant（main.ts:180）。
//   これを info（kv）と text（本文）の別 variant で忠実に表す（Codex v3 修正必須1）。双方に意味色 tone? を持つ。
type Row =
  | { kind: "info"; id: string; label: string; value?: string; note?: string; tone?: SemTone } // kv 行（cls:"exp"|"warn" 等を tone で表す）
  | { kind: "text"; id: string; text: string; dim?: boolean; tone?: SemTone }                   // 自由文行（label を持たない＝info とは別 variant）
  | { kind: "action"; id: string; label: string; role?: Role; icon?: IconId; badge?: Badge }    // 押すと action(id) を発火
  | { kind: "toggle"; id: string; label: string; on: boolean }                                  // オン/オフ（設定）
  | { kind: "picker"; id: string; label: string; options: {id:string;label:string}[]; selected: string } // 循環/選択（小中大 等）
  | ({ kind: "input"; id: string; label: string; required?: boolean; placeholder?: string; value?: string } & InputKind) // 自由入力（判別 union）
  | { kind: "card"; id: string; title: string; sub?: string; glyph?: Glyph; badge?: Badge; role?: Role };  // 一覧カード→詳細

// 入力型の判別 union（Codex v3 修正必須2）＝矛盾状態（number なのに multiline 等）を構造検査で拒否できる形。
type InputKind =
  | { inputType: "text";   multiline?: boolean }                        // 名前・最期の言葉・セーブ貼付（現webは単行／multiline は Swift 改善案）
  | { inputType: "number"; min?: number; max?: number; step?: number }; // テスト用レベル/深度（multiline 不可）

type Role = "primary" | "cancel" | "danger" | "normal";  // 既存 sheet のボタン役割と一致（10.1）
type Badge = { text: string; tone: SemTone };  // ✓受取可・◦受注中 等の状態章
type Glyph = { char: string; tone: SemTone };  // グリフ 1字＋意味トーン（CSSクラス名でなく意味キー）
// 意味トーン（SemTone）＝§10.2「正典＝不変」の各トークンに 1:1 対応する完全 ID 集合。
// ★列挙の単一の出所は §10.2 のトークン表。下記は「その表から機械生成する」ことの見本＝正典 token 名にそのまま揃える
//   （"ally"/"enemy-tN"/"school-X" のような曖昧な別名は使わない＝Codex v3 修正必須1）。過不足があれば §10.2 の表が正。
type SemTone =
  // 状態（§10.2 ステータス色）：cls:"exp"|"warn" 等はここへ
  | "hp"|"exp"|"gold"|"buff"|"warn"
  // 文字強調（§10.2 文字トークン・自由文/kv の淡強）
  | "dim"|"strong"|"meta"|"acc"
  // グリフ役割（§10.2/design-spec §2.5）
  | "player"|"companion"|"companion-erratic"|"delver"|"downed"|"summon"|"stairs"|"wall"|"floor"
  // 敵ティア（§10.2）
  | "mon-t1"|"mon-t2"|"mon-t3"|"mon-t4"|"mon-t5"|"elite"|"boss"
  // 物・ノード（§10.2）
  | "fossil"|"fossil-quiet"|"chest"|"chest-open"|"spring"|"rest"|"door"
  // 術学派（§10.2）
  | "atk"|"ctl"|"mov"|"sup"|"lore"|"sum"
  // 残響の極（echo tonePole・オーラ色）
  | "loss"|"myth"|"grudge";
type IconId = "help"|"save-export"|"save-import"|"reset"|...;  // §4 SF Symbols 対応表のキー
```

**要点：**
- **ルーティングは `id`（安定キー）で行う**＝表示ラベル `label` はローカライズ／A11y自由。`settingsSheet` の `includes` 分岐は `row.id`（`"bgm-volume"` 等）に置換される。
- **`info`（kv）と `text`（自由文）を別 variant にする（Codex v3 修正必須1）**＝現 `SheetRow`（main.ts:180）は `{label,value,note?,cls?}` と `{text,dim?,cls?}` の2種で、後者は `label` を持たない。単一 `info`（label 必須）では自由文行を表せない。**両 variant に意味色 `tone?`**（実コードの `cls:"exp"`〔深蝕値〕`cls:"warn"`〔聖遺物等〕を失わない）。
- **`SemTone` は正典 token へ 1:1 の完全集合**（Codex v3 修正必須1）＝列挙の出所は §10.2 のトークン表**一箇所**にし、そこから機械生成する（型に曖昧な別名を混ぜない・§10.2 が正）。`cls` の生 CSS クラス名は持たせない。web は `tone`→`.g-mon-t3`/`.c-exp` 等、Swift は `tone`→`Color`。
- **`kind:"input"` は判別 union（Codex v3 修正必須2）**＝実使用は**5経路のみ＝①名前（`text`）②最期の言葉（`text`・任意）③セーブ読込の貼付（`text`・現 web は単行／複数行は Swift 改善案として区別）④テスト用レベル（`number` 1–60）⑤テスト用深度（`number` 1–ABYSS）**（main.ts:3532/7826/7941/8080/8084）。「依頼等の自由入力」は**存在しない**（v2 の誤りを訂正）。`text` のみ `multiline` を許し、`number` は `min/max/step` を持ち `multiline` 不可＝**矛盾状態を型（構造検査）で拒否**。Swift ＝ `TextField`／`TextEditor`／`.keyboardType(.numberPad)`。
- 既存の `sheet({sections})`（構造化リスト）は本モデルの `info`/`text` に相当＝**すでに半分は意味論化されている**（10.1）。不足は `chooseGrid`（card）・`settingsSheet`（toggle/picker/action）・`input`。

### 3.3 現 web → モデルの対応（移植マッピング）

| 現 web 実装 | 現状 | 目標モデル | Swift 実装先 |
|---|---|---|---|
| `SheetRow` kv 行 `{label,value,note?,cls?}` | 半意味論化済（`SheetSection{rows}`） | `Row.info{tone?}` | `LabeledContent` |
| `SheetRow` 自由文行 `{text,dim?,cls?}` | 半意味論化済（別 variant） | `Row.text{dim?,tone?}` | `Text` |
| `sheet` のボタン列（role 付） | `SheetOption{role}` 済 | `Row.action{role}` | `Button(role:)` |
| `chooseGrid(cells:{html})` | **生HTML** | `Row.card{glyph,badge,role}` | `List`＋`NavigationLink`（カード→詳細） |
| `sheet({input})` の入力（名前/最期の言葉/セーブ貼付/テストLv/テスト深度） | 単一 `sheetInput` を用途ごと使い回し | `Row.input`（`text`＋`number` 判別 union） | `TextField`（number=`.numberPad`） |
| `settingsSheet` の toggle 項目 | ラベル文字列＋`includes`分岐 | `Row.toggle{id,on}` | `Toggle` in `Form` |
| `settingsSheet` の循環項目（小中大・位置） | ラベル＋`includes`分岐 | `Row.picker{id,options,selected}` | `Picker`（.menu/.segmented） |
| `settingsSheet` の action（書出/読込/やり直す） | ラベル＋`includes`分岐 | `Row.action{id,role}` | `Button(role:.destructive)` |

**★設定項目の網羅（Codex 修正必須1）：** モデル化する `settingsSheet` の全項目は、§10.7 の記載に加え**現実装にある「🥾 踏み込みボタン表示」「🛡 受け流しボタン表示（剣）」トグル**（main.ts:7985-7986）も含む。§10 追補時（Phase U0）に §10.7 の設定一覧へこの2項目を補う（現状の §10.7 が実装より1〜2項目古い）。

### 3.4 このRFCでの扱い（段階導入・§8 と連動）
- **モデル型（3.2）と対応表（3.3）を §10 に「Swift ミラー用の画面モデル仕様」として追補する（doc のみ）。**
- **web 参照版は原則リファクタしない**（挙動回帰リスクを避ける・合意②）。ただし §8 の「低リスク先行候補」として、**設定の内部IDディスパッチ化**（表示ラベルはそのまま、分岐だけ `row.id` 基準へ）は挙動を1bitも変えずに実施可能なため、先行の是非を別途判断する。

---

## 4. Swift ネイティブ化の具体（指摘③）

§10.9/10.10 の指針を、Codex 指摘に沿って具体化する（すべて §10.10 の「Swift 専用の上乗せ」欄に追補する提案）。

- **タブバー＝SF Symbol＋可視ラベル。** 現 web はアイコンのみ（術=菫/地図=青）。Swift は `TabView`（または下部バー）で SF Symbol（10.10③の対応表：術=`wand.and.stars`／地図=`map`／ステータス=`person.crop.circle`／設定=`slider.horizontal.3`／ハブ=`book.closed`）＋**短い可視ラベル**（VoiceOver・学習性のため）。ラベル文言は §9 保留。
- **設定＝`Form` + `Toggle`/`Picker`。** §3 のモデル `toggle`/`picker`/`action` を SwiftUI 標準部品へ 1:1。破壊的操作（世界をやり直す）は `Button(role:.destructive)`＋確認ダイアログ。
- **D-pad ヒット領域 ≥ 44pt。** 現 web の D-pad は視覚サイズ（大/中/小）と実ヒット領域が一致。Swift は **最小 44pt（Apple HIG）を保証**（視覚は小さくてもタップ領域を拡張＝`contentShape`）。**8方向＋中央の待機（3×3 の全9ボタン）**すべて。
- **版数を設定フッタへ。** 現 web は HUD 右上に常時表示（最新判定用）。Swift は HUD を情報密度優先で整理し、版数は**設定画面フッタ**（`APP_VERSION`＋build 日）へ移す。※「最新かの判定を右上版数で行う」CLAUDE.md 運用は web 固有（PWA キャッシュ粘着対策）＝Swift は App Store 配信で不要。

---

## 5. アクセシビリティ仕様（指摘④）

**原則：雰囲気を壊さず OS 設定に連動する。通常テーマの盤面を一律に明るくしない。**

- **Dynamic Type**：現 `logSize`（小/中/大）を型スケールトークンとして持ち、Swift は `.dynamicTypeSize` で OS 設定に追従（10.10⑤ 既記）。盤面グリフは等幅維持のため上限クランプ（レイアウト崩壊防止）＋シート/ログは全域追従。
- **高コントラスト（Codex 修正必須2＝不変にするのは RGB値でなく「役割・識別関係」）**：`@media (prefers-contrast)` / Swift `.accessibilityShowButtonShapes`・`legibilityWeight` 連動の**別トークンセット**を用意。**不変に保つのは「色の役割の対応（自分=金系・深蝕=菫系・敵tierの段・術学派の別）と、互いに識別可能であること」であって、各役割色の RGB 値そのものではない。** 背景・罫線を変えた結果コントラスト比を満たさなくなるなら、**役割色の明度/彩度を調整してよい**（例＝暗背景で紫のt5が沈むなら明度を上げる。ただし「t5＝最危険・脈動」の意味と他tierとの相対関係は保つ）。**コントラスト基準は対象別（Codex v3 修正必須4）＝通常文字 4.5:1／大文字・主要な非テキストUI（ゲージ・アイコン・枠）3:1（WCAG AA）**。既定（雰囲気優先）と高コントラストの2系統をトークンで分岐。**通常テーマの盤面を一律に明るくはしない**（高コントラストは OS 設定 ON 時のみ）。
- **色を唯一の識別手段にしない（Codex v3 修正必須4）**：敵tier・術学派・状態は**色＋別の手掛かり**で二重符号化する＝敵は記号（グリフ字形）が種別を担い色が tier（既存）／状態異常・バフはピルの**ラベル文字＋アイコン**（色のみに依存しない）／テレグラフは**枠・形＋点滅**（色に加え）。色覚特性・高コントラスト時も情報が落ちない。
- **Reduce Motion**：`prefers-reduced-motion` / Swift `.accessibilityReduceMotion` で pulse/danger/monatk/torchflick/abyssair/tileFx/FloatFx の**アニメを静止 or 最小化**（テレグラフの「来る」情報は色/枠の静的表現で担保＝ゲーム可読性を落とさない）。
- **VoiceOver（盤面の表現が核・Codex 修正必須2＝要約＋結果通知＋フォーカス管理の3点で仕様化）**：
  - **(a) 静的な読み上げ＝盤面全体は「セル群」ではなく、要約された単一の accessibility 要素**にする（数十マスを個別読み上げさせない）。読み上げ例＝「深度12・中層。周囲に敵3体（うち攻撃予告1）。北に階段。HP 68%・深蝕 42%」。
  - **(b) 選択マスの説明**＝現 `#peek`（傷語・状態異常・能力ヒント・§10.3）を、調べる／照準で選んだマスの accessibility 説明として読む。
  - **(c) アクション結果の能動通知（単一要素化だけでは自動読上げされない）**＝1手ごとの結果を **accessibility announcement**（Swift `AccessibilityNotification.Announcement` / ARIA live region 相当）で能動的に読ませる。何を・いつ＝**移動（進んだ方向＋新たに視界に入った脅威）／攻撃（対象＋与ダメor撃破）／被弾（被ダメ＋残HP）／見切り・撃破・拒否（不可操作の理由）／深度移動・レベルアップ・遭遇発生**。ログ（`#log`）の1行が出る点＝通知点と一致させる（FloatFx/sfx と同じトリガ）。冗長にならないよう「盤面要約の全文再読」ではなく差分（起きたこと）を短く。**連続手番で queue を詰まらせない（Codex v3 修正必須4）＝同種通知は coalesce／重複抑制（例：連続移動は最新1件に畳む）、被弾・操作拒否・深度移動・レベルアップ等の重要通知は優先度を上げて割り込ませる**（Swift は `.high` priority／古い低優先アナウンスは破棄）。
  - **(d) フォーカス管理**＝VoiceOver カーソルを **盤面（要約要素）↔ D-pad（8方向＋待機の全ボタン・既に aria-label 有り）↔ シート（開いたら先頭へ移動・閉じたら元の位置へ戻す）** の間で明示制御する。シート表示中は背後の盤面を `accessibilityHidden`。照準モードは D-pad 微調整と「移動/やめる」にフォーカスを保つ。
  - シート/カード/設定は §3 モデルの `label`/`value`/`badge`/`role` を accessibility ラベル・trait（`.isButton`/`.isSelected`）へ機械変換。
  - 触覚（10.10④）は VoiceOver と併用（会心=heavy 等）。
- **このRFCでの扱い**：§10 に「10.11 アクセシビリティ」節を新設する提案（doc のみ）。実装は Swift フェーズ。web 参照版へ最小の布石（高コントラスト用の派生トークン定義・prefers-reduced-motion ガード）を入れるかは §8 で判断。

---

## 6. 受理ゲート＝画面状態 fixture（指摘⑤）

### 6.1 現状の不足
`visual-check.ts` は 480×900 固定・輝度分散（明度プロファイル）中心・`npm run check` 非同梱＝「画面が真っ黒に壊れていないか」は見るが、**移植の受理（Swift が §10 を正しく再現したか）には使えない**。

### 6.2 目標＝「画面状態 fixture」による回帰ゲート
**固定状態（seed・world・画面種を固定した決定論的スナップショット）**を列挙する。**共有するのは画像でなく「seed＋画面状態＋意味論的な期待値（§3 モデルの中身）」**（Codex 修正必須3）。検査は「検証手段の要否」で3層に分ける：

| 検査 | 内容 | 検証手段 | `npm run check` 同梱 |
|---|---|---|---|
| **(1a) schema/fixture validator** | fixture 定義自体が妥当か＝各 `Screen`/`Row` が **ID を持つ・必須欄が揃う・`tone`/`role`/`inputType` が既知値・矛盾なし**（例 number+multiline を拒否）。**実装不要＝定義データを検査するだけ** | 純データ検査（レイアウトエンジン不要） | **○ 同梱可**（playwright 不要） |
| **(1b) conformance（実装済み subset のみ）** | ある画面のモデル adapter が出力した `Screen` が、その画面の fixture 期待値と一致するか＝**モデル adapter を実装した画面だけが対象** | 各 platform で「モデルを出す→期待値照合」 | **○ 同梱可（対象＝実装済み画面のみ）** |
| **(2) レイアウト（overflow / safe-area / 44pt ヒット領域）** | 本文/ボタン/カードが画面外・セーフエリアにはみ出ない／タップ領域 ≥44pt | **レイアウトエンジン必須**＝web はブラウザ E2E（playwright）、Swift は XCUITest/UI test | **× 非同梱**（web=ローカル手動 e2e、Swift=XCUITest） |
| **(3) 画像回帰** | 見た目の退行（PIL で領域別明度・要素位置） | ブラウザ/シミュレータで撮影 | **× 非同梱・platform 別 baseline**（下記） |

- **循環の解消（Codex v3 修正必須3）**＝**「移植受理ゲートの本体」は実装のない (1a) 単独ではなく、〈共有 fixture schema〔=(1a)〕＋各 platform の conformance test〔=(1b)〕〉である。** RFC の大方針「web は原則モデル化しない・chooseGrid モデル化も U1 外」と両立させるため、**(1b) の対象は "モデル adapter を実装した画面だけ"** とする。
  - **web**：現状 Screen モデルを出さない。U1a（設定の ID ディスパッチ化）等で **adapter を実装した画面だけ (1b) の対象**に順次入る（全画面 conformance は求めない）。
  - **Swift（U2）**：全画面がモデルから描かれるため、そこで**全画面 conformance を有効化**する＝ここが移植受理の本丸。
  - **(1a) は今すぐ整備できる**（定義データの validator＝実装非依存）＝これが U1c の中身（§8）。
- **(2)(3) はレイアウトエンジンが要る**ため CI 非同梱＝web はブラウザ E2E（`e2e-*.mjs` と同じローカル手動・playwright は package.json 非同梱の規約維持）、Swift は XCUITest。
- **画像は web と Swift で直接同一比較しない**（別レンダラゆえ必ずズレる）。**画像 baseline は platform 別に持つ**。両者が共有するのは fixture 定義（seed＋画面状態＋意味論的期待値）だけ。

### 6.3 fixture の列挙（案・§7 の画面一覧と対応）
- **画面**：タイトル／街／屋内（店）／迷宮（浅・深・深淵＝松明帯3種）／地図（パン・全体図）／照準／HUD（バフ満杯・深蝕高・HP瀕死）／ステータス（`charScreen`）／装備・荷物（満杯）／術（構え・図鑑）／進行中（依頼/因縁/印）／設定（4グループ）／各遭遇オーバーレイ（化石/宝箱/ボス決着/レベルアップ/昇格）／死の選択／**入力系（名前入力・最期の言葉・セーブ貼付）**。
- **必須の寸法・条件（Codex 修正必須3）**：375×812（実機基準）**に加え、最小対応幅（例 320pt／SE 第1世代相当）と Accessibility Dynamic Type（最大サイズ）を必須 fixture にする**（レイアウト崩壊が最も出やすい2条件）。＋高コントラスト・Reduce Motion 適用時。極端な状態（長い化石名・最大ステ・満杯の荷物）も。

### 6.4 実装形態の論点（§8・Codex 検収で確定）
- **どこで撮るか**：現 `visual-check.ts`（480×900）を拡張して 375×812＋最小幅＋Dynamic Type＋fixture 列挙にするか、新ツールにするか。
- **同梱の線引き（6.2 の表どおり）**：(1a) validator＋(1b) 実装済み画面の conformance だけ `npm run check` 同梱、(2)(3) はローカル/XCUITest。
- **Swift 側の対応（U2）**：同じ fixture 定義（seed＋画面状態＋意味論的期待値）を Swift の XCUITest でも使い、**全画面の (1b) conformance を有効化**（移植受理の本丸）。画像 baseline のみ platform 別。

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
3. §10 に「画面モデル仕様」（§3.2 型〔`Row.input`／`tone` 含む〕＋§3.3 対応表）追補＋**§10.7 設定一覧に「踏み込みボタン表示」「受け流しボタン表示」を補う**（§3.3）。
4. §10 に「10.11 アクセシビリティ」新設（§5＝高コントラストの識別関係論・VoiceOver 3点）＋「10.10」に SF Symbol タブ/D-pad 44pt/版数フッタ追補（§4）。
5. §10 に「10.12 画面状態 fixture」新設（§6＝(1a) validator／(1b) 実装済み subset conformance／(2)レイアウト／(3)画像の層・画像は platform 別）。
→ **すべて doc PR。ゲーム挙動・golden・版数に無関係。** Codex は doc の内部整合を検収。

### Phase U1：低リスクの web 先行（挙動不変・**3つの別承認単位に分ける**・Codex 修正必須4）
性質が異なるため一括承認にせず、**独立に承認・独立に着手**する：

- **U1a｜設定の内部IDディスパッチ化**（＝挙動不変の負債解消）：`settingsSheet` の分岐を表示ラベル `includes` → 内部 `id` 基準へ（表示は1文字も変えない・挙動不変・§3.4）。将来の文言変更で分岐が壊れる負債が消える。**golden 非関与（web UI 層）・E2E で無回帰を裏取り。** ← 最も安全。
- **U1b｜高コントラスト用の派生トークン定義＋`prefers-reduced-motion` ガード**（＝**OS 設定 ON 時の表示変更**を伴う＝U1a とは性質が違う）：既定の見た目は不変だが、OS 設定 ON 時に新しい見た目が出る＝実挙動の追加。役割色の明度/彩度調整（§5）の妥当性込みで承認。
- **U1c｜fixture 基盤（Codex v3 修正必須3 で範囲を限定）**（＝**テスト基盤の変更**＝これも別性質）：**(1a) schema/fixture validator（実装非依存＝今すぐ整備可）** を作り、**(1b) conformance は "モデル adapter を実装した画面だけ"** を対象に `npm run check` へ同梱。**全画面 conformance を U1c で求めない**（現 web は Screen モデルを出さないため＝全画面は Swift U2 で有効化）。(2)(3) はローカル/XCUITest ゆえ本 U1c の範囲外。

→ **chooseGrid の生HTML→cardモデル化は「大改修＝回帰リスク中」ゆえ Phase U1 に含めない**（Swift フェーズで実施 or 別途大きめ承認）。したがって U1 完了時点で (1b) conformance の対象になる web 画面は「U1a 等で adapter 化した設定シート程度」に留まる＝これは想定どおり（受理の本丸は U2）。

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

## 10. 検収観点（Codex 向け・改訂版 v3）

**v3 は 2026-07-27 01:34 [codex] の修正必須4項を反映済み**（v2 の 00:51 4項＝反映確認済み）。再検収は主に v3 反映の妥当性を見る。

1. **§3 モデル（v3 修正1・2）**：現 `SheetRow` の2 variant を `info`（kv）／`text`（自由文）に忠実分割し双方 `tone?` を持たせた点／`cls:"exp"|"warn"` を失わないか。`SemTone` を §10.2 の正典 token に 1:1（別名排除・単一の出所から機械生成）とした点。`Row.input` を `text`（multiline 可）／`number`（min/max/step・multiline 不可）の判別 union にし、実 5 経路（名前/最期の言葉/セーブ読込/テストLv/テスト深度＝「自由入力」「複数行」の誤りを訂正）に一致させ矛盾を構造検査で拒否できるか。
2. **§5 A11y（v3 修正4）**：D-pad「8方向＋待機」表記／VoiceOver 通知の coalesce・重複抑制・優先通知（被弾/拒否/深度移動）／高コントラストの対象別基準（通常文字 4.5:1・大文字/非テキスト UI 3:1）＋色を唯一の識別手段にしない（記号/ラベル/形の併用）が妥当か。
3. **§6・§8 fixture 循環（v3 修正3）**：受理を (1a) validator〔実装非依存・今すぐ可〕＋(1b) conformance〔adapter 実装済み画面だけ〕に分け、全画面 conformance を Swift U2 に置き、「移植受理の本体＝共有 schema＋各 platform conformance」とした整理で循環（web 未モデル化なのに全画面検査を主張）が解けているか。
4. **§8 段階導入（v2 修正4・据置）**：U1a/U1b/U1c の別承認単位、U0→U1a/b/c→U2 の順、chooseGrid card 化を U1 外とする判断。
5. **§2 一本化（据置）**：design-spec.md（旧）と §10（現）の差分表（2.2）に事実誤りがないか。§2.3 の §10 追補選定が妥当か。

---

## 付録A：一本化後の正典所在（確定後の姿）
- **UI の正＝`prototype-spec.md` §10**（配色/様式/グリフ/HUD/操作/レイアウト/画面モデル/A11y/fixture/Swift指針）。
- **設計の正＝`design-snapshot.md`**（ゲーム設計・4-x）。
- **`design-spec.md`＝アーカイブ**（旧・寒色テーマ／灯火タイトルの歴史的実値・別テーマ復帰時のみ参照）。
- **セッション引き継ぎ＝`CLAUDE.md`**（既に §10 を UI 正典と記載済み）。

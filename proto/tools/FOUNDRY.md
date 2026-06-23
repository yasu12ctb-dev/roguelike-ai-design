# 鋳造所（道2）── storylet 量産パイプライン（試作仕様）

snapshot **4-9（実行時LLMゼロ・制作時の鋳造所で量産）/ 4-12** の量産側。
「プレイヤーごとに違う体験」を桁違いに増やすため、**制作時に大量の storylet を生成**し、
**エンジン整合の受理ゲートを通った物だけ**を `content/storylets.json` に取り込む。

> 研究の裏づけ：LLM は言語的に流暢でも**構造的に無効な出力を出しがち**で、エンジンへ素通しできない。
> 対策は **schema-governed generation ＋ engine-aligned admission（検証/正規化/修復ループ）**。
> ([Schema-Governed LLM Pipeline](https://www.mdpi.com/2079-8954/14/2/175) ／ [PCG with LLMs](https://www.emergentmind.com/topics/procedural-content-generation-with-llms) ／ [PCG in Games Survey](https://arxiv.org/pdf/2410.15644))

## パイプライン（4段）
1. **生成（制作時LLM：Fable5/Opus）** … 下記スキーマに従い、context・テーマ・蓄積ゲートを指定して storylet を JSON で生成。
2. **受理ゲート（`tools/validate-content.mjs`）** … エンジンのスキーマで厳密検証。**不合格は取り込まない**（CIにも常駐）。
3. **正規化/修復** … ゲートのエラーを潰す（id重複・不正スロット・不明キー・負weight・不明item等）。LLMに再生成させるか手修正。
4. **取り込み** … 既存を無改変で末尾追記（差分を局所化）。決定論デモ＋受理ゲートが緑であること。

## スキーマ（生成プロンプトに必ず埋める制約）
- **context**：`encounter / dungeon / street / tavern / guild / shop / quest / chest / delver`。省略=encounter。
  - `delver`＝迷宮ですれ違う生者の冒険者（4-14・軽い会話・勧誘なし）。スロットは街と同じ生者slot。
- **本文の形**：
  - encounter＝`investigate` と/or `search`（各 `{text, effects}`）。化石スロット可。
  - dungeon／街(street/tavern/guild/shop/quest)＝`text` ＋ `choices[]`（各 `{label, text?, effects[]}`）。
  - chest＝`result`（`{text, effects}`）。
- **スロット（context別に充填可能なものだけ）**：
  - dungeon／chest＝`#depth#` のみ。
  - encounter＝`#origin_name# #origin_gear# #origin_epithet# #origin_catchphrase#(要 hasCatchphrase) #depth#`。
  - 街・delver＝`#origin_name# #origin_gear# #origin_epithet#`（`#origin_catchphrase#` は mint 生者に無いので不可）。
- **prerequisites（蓄積ゲート＝多様性の源）**：`tone(loss/myth/grudge) stage(weathered/twisting/alien) finalAct kind(character/explorer/relic) minBond minExposure minLevel minDepth maxDepth unfinished hasCatchphrase depthBand(shallow/mid/deep/abyss) flag notFlag arc arcStep arcPick arcActor actorId notArc`。
  - `depthBand`＝**shallow(≤8)/mid(9-24)/deep(25-37)/abyss(38+)**（2026-06-23 4分割・dungeon/chest の発火帯フィルタ）。`minDepth/maxDepth` は帯より細かい下限/上限（dungeon/chest）。`actorId` は名簿アンカー（街 context のみ・adventurers.json に在ること）。
- **effects（報酬＝金/物/絆もここ）**：`bond exposure trait chronicle plant gold item arc{key,step,pick?,done?,anchor?} closeUnfinished`。
  - `item` の許可キーは **items.ts の `CONSUMABLES` から動的取得**＝現在 `soothe/salve/salve2/soothe2/soothe3`（上位品は店頭/ドロップが `minLevel` ゲートだが effect 付与は帯不問。深部 storylet で渡すのが妥当）。
- **weight**：正の数（抽選の重み）。**id**：全体で一意。

## 量産の「多様性」設計（研究の grammar/quality 指針）
- **軸を変えて散らす**：context × 蓄積状態 × アクター記述子（約33万通り）× 長さ（短い情景〜長尺アーク）。
- **長尺は進行度クオリティ**（`arc`/`arcStep`）で多段化。**特定NPCに戻る**弧は `anchor`＋`arcActor`。
- **報酬を必ずセット**（金/物/絆/評判形質）。**同種の反復を避ける**（受理ゲートに将来「近似重複」検出を足す余地）。

## 使い方
```sh
cd proto
node tools/validate-content.mjs   # 受理ゲート（CI にも常駐）
```
- バッチ追加は **既存を無改変で末尾追記** → 受理ゲート → `npm run demo`／`build:web` 緑を確認 → PR。
- 生成テンプレ（context別の作例＋制約）は本書のスキーマ節をそのままプロンプトに使う。

## 今後の拡張（試作→本番）
- ✅ **近似重複検出**（字面・context バケツ内の文字bigram Jaccard・閾値0.50・warn）＝`validate-content.mjs` に実装済（2026-06-23・M4着手）。本文が酷似するペアを警告＝量産の反復を抑止。
- 受理ゲートに **スロット網羅チェック**・**fragments/setpieces 検証**を追加（残）。
- 生成側を **構造化出力（JSON Schema/grammar decoding）** で固め、修復ループを自動化。
- 量産の実施は **ユーザー合意のうえ**、context・テーマ単位でバッチ生成→受理ゲート→レビュー。

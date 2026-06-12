# proto — 最小ループ プロトタイプ v0

`prototype-spec.md` の実装。**実行時LLMゼロ・完全オフライン・決定論（seed固定）**。

## 実行

```sh
cd proto
# 対話型CLI（自分で遊ぶ。情緒検証の本番）
node --experimental-strip-types src/cli.ts            # 前回のセーブから再開
node --experimental-strip-types src/cli.ts --new      # 新しい世界で始める
node --experimental-strip-types src/cli.ts --new --seed 42   # seed指定

# 台本デモ（決定論の検証用。seed固定で毎回同じ世界）
node --experimental-strip-types src/demo.ts
```

### CLI の遊び方
- **街**：迷宮へ潜る／酒場で噂を聞く／年代記を読む／セーブして終える
- **迷宮**：さらに潜る（被曝が蓄積・深いほど危険）／探索する（化石との遭遇判定）／地上へ戻る
- **化石と遭遇したら**：鎮魂する（変質の時計を巻き戻す）／遺品を継ぐ／立ち去る
- **死んだら**：最後の一手を選ぶ（→ 化石の極が決まる）→ 次の世代へ（先代の血縁/弟子/無関係を選択）
- セーブは `save/world.json` に自動。終了してもあなたの世界は堆積し続ける

## 構成

```
content/   鋳造所コンテンツ（手書きの最小セット。将来はLLM鋳造所で増産）
  fragments.json   断片（再発見フレーム/亡霊呼称/挙動/死の一手/奇癖/噂）
  setpieces.json   山場の予約セットピース（legend_return / grudge_hunt）
src/
  types.ts       永続層スキーマ（spec §2）
  rng.ts         決定論的乱数（mulberry32）
  content.ts     コンテンツのロードとタグ整合抽選
  variation.ts   変質計算（朽ち/歪み）・トーン極・被曝（spec §4.1-4.3）
  render.ts      スロット充填＋痕跡保証ASSERT（spec §4.4）
  weights.ts     再会の重み付け（spec §4.5）
  world.ts       世界生成・化石化・干渉・年代記・セーブ/ロード
  demo.ts        最小ループを seed 固定で一周するデモ（spec §5）
save/            セーブデータ（git管理外）
```

## デモが実証していること

- 最小ループ一周：潜行→被曝→遭遇→死（最後の一手）→化石化→世代交代（系譜）→噂→再発見→干渉→年代記
- **痕跡保証**：どの再発見テキストにも出自（名前/装備/口癖）が必ず残る
- **干渉の意味**：鎮魂した化石は朽ちるだけ、放置した化石は異形化が進む（4-1C の時計リセット）
- **死の一手→極**：「迷宮を呪う」と怨念極の化石になる（4-10B）
- 永続化：セーブ→ロードの完全往復

# 画面状態 fixture（UI・Phase U1c）

`prototype-spec.md` **§10.12（画面状態 fixture）／§10.1b（意味論的スクリーンモデル）／§10.2e（前景意味トークン ID の正典）** に基づく **移植契約の宣言データ**。検査は `proto/tools/ui-fixture-check.ts`（`npm run check` 同梱）。

---

## ★現在の到達点（誤認防止・必読）

- **web の正式な `(1b) Screen conformance` は「0 画面・未実装」。** 現 production（`src/web/main.ts`）は §10.1b の `Screen` を出す adapter を持たない（`settings-items.ts` の出力は `SettingRow { id, label, header? }` のみ）。**Screen adapter の導入は別承認**であり、その時に初めて正式な (1b) を有効化する。
- **ここにある3つの fixture は U1c の基盤（(1a) validator）＋設定 subset の互換性検査であって、§10.12 の「移植受理ゲート完了」ではない。** 未達＝全画面の網羅／375×812・最小対応幅・Accessibility Dynamic Type などの寸法条件／高コントラスト・Reduce Motion／レイアウト (2) と画像 (3) の層。
- web 側が現在照合しているのは **`webProjectionProfile: "settings-row-v1"`＝`row.id` / `row.label` / `row.header` / `row.order` の4欄だけ**。**`Screen.id` は照合に含めない**（production が出していないため。tool 側で補うと検査側の捏造になる）。`kind` / `tone` / `role` / `icon` / `options` 等は **§10 由来の将来値**で、**web では未検証**（Swift U2 で全欄 conformance を有効化する）。

---

## 正典と生成元

- **正典＝`prototype-spec.md` §10。** fixture は §10 を写した宣言データであり、**production を実行して生成しない**（`buildSettingLabels()` / `SETTING_DEFS` を入力にしない）。
- **ラベルの出所＝U1a の凍結 oracle `proto/tools/fixtures/settings-oracle.json`**（基準 commit `6a537d197d23865f578832ba56e88a753dc38825`／v0.166.0 の legacy 表示から採取した**独立期待値**）。各 fixture の `derivedFrom` にこの由来を記録し、**validator が「fixture のラベル == oracle」を毎回機械照合**する（＝production からのコピーを構造的に排除）。
- **生成器は置かない**（直積が無く手書きで足りるため）。fixture は人が編集し、validator が正しさを担保する。

## ★上書き禁止の規律

**compatibility が落ちたときに fixture を production に合わせて書き換えてはならない。** それをすると検査が無意味になる。fixture の変更が許されるのは **§10（正典）の変更とセットのとき**だけ。

## ファイル構成

| ファイル | 内容 |
|---|---|
| `settings/default.json` | 代表状態1（既定値） |
| `settings/cycle-a.json` | 代表状態2 |
| `settings/cycle-b.json` | 代表状態3 |

**3 fixture で 11 入力の全値を通す**（3値入力 `bgmVol`/`sfxVol`/`dpadPos`/`dpadSize`/`logSize` は3値すべて、2値入力 `muted`/`bgmOn`/`dpadOn`/`autorun`/`lunge`/`guard` は両値）。被覆は validator が検査する。

## fixture の形

```jsonc
{
  "schemaVersion": 1,                     // 既知版のみ（現在は 1）
  "fixtureId": "settings/default",        // 一意
  "screenId": "settings",                 // expected.id と一致必須（fixture 内部整合）
  "derivedFrom": {
    "spec": "prototype-spec.md §10.1b/§10.2e",
    "oracle": "tools/fixtures/settings-oracle.json@6a537d1…"   // base commit を含む固定形式
  },
  "webProjectionProfile": "settings-row-v1",  // 検査4欄は validator 側の固定表が正
  "state": { /* 11 入力の具体値（欠落・値域外は fail） */ },
  "expected": { "id": "settings", "title": "設定", "sections": [ /* §10.1b の Screen */ ] }
}
```

## 検査（`tools/ui-fixture-check.ts`）

- **(1a) closed schema validator**＝未知 field／型違い／非有限数（NaN・Infinity＝object を直接渡す経路でも拒否）／`Section` を跨ぐ `Row.id` 重複／`Section.id` 重複／`picker` の option id 重複・`selected` が options 外／`input` の判別 union（`number`+`multiline` 不可・`text` に `min/max/step` 不可・`min>max`・`step<=0`）／`schemaVersion` 欠落・未知版／`screenId !== expected.id`／`kind`・`role`・`tone`・`icon` が runtime 定数集合に無い。
- **(B) settings compatibility**＝production `buildSettingLabels(state)` を `settings-row-v1` で射影して照合。**header は「グループ先頭行にだけ付く」**という production の意味論に合わせる。
- **(C) doc 突合**＝`prototype-spec.md` の **§10.2e の見出し範囲だけ**を読み、**SemTone 46件／IconId 10件／重複0／`screen-model.ts` の runtime 定数と完全一致**。色 hex は読まない。
- **(D) 状態被覆**／**(E) oracle 独立照合**（上記）。
- **(F) self-test（変異試験）**＝**28 の拒否枝＋正常系1 を毎回 in-memory で自動実行**（口頭・一時編集に頼らない）。

## Swift（U2）への引き渡し

- 本ディレクトリの JSON をそのまま Swift のテストリソースへ bundle する（enum は文字列・素直に `Codable`）。
- **Swift 側で初めて「正式な (1b) Screen conformance（全欄）」を実装**する。`webProjectionProfile` が「web は行の4欄だけを見ている」ことを明示するので、**移植時にどこが未検証かが一目で分かる**。
- **画像 baseline は共有しない**（別レンダラゆえ platform 別・§10.12）。

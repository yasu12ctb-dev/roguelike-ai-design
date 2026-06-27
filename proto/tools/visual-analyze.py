#!/usr/bin/env python3
# G: スクリーンショットの PIL ピクセル解析。visual-check.ts から呼ばれる。
# 検出：①空/破綻描画（単色占有率が極端）②主要帯（上HUD/中グリッド/下タブ）の無内容
#       ③下部セーフエリアの取りこぼし（最下帯に内容が無い＝バー未到達）。
import sys, json
import numpy as np
from PIL import Image

FAIL = 0
def fail(msg):
    global FAIL; FAIL += 1; print("  ❌ " + msg)
def okmsg(msg): print("  ✅ " + msg)

def analyze(path):
    name = path.split("/")[-1]
    img = Image.open(path).convert("RGB")
    a = np.asarray(img)
    H, W, _ = a.shape
    # 単色占有率（最頻色の割合）：破綻/空描画の検出
    flat = a.reshape(-1, 3)
    # 量子化して最頻色
    q = (flat // 16).astype(np.int32)
    keys = q[:, 0] * 4096 + q[:, 1] * 64 + q[:, 2]
    vals, counts = np.unique(keys, return_counts=True)
    top_frac = counts.max() / keys.shape[0]
    # 帯ごとの「内容量」＝行方向の輝度分散（テキスト/グリフがあれば分散が立つ）
    gray = a.mean(axis=2)
    def band_var(y0, y1):
        b = gray[int(y0):int(y1)]
        return float(b.std())
    top = band_var(0, H * 0.10)        # 上部ステータス
    mid = band_var(H * 0.18, H * 0.70)  # グリッド/ログ
    bottom = band_var(H * 0.92, H)      # 最下帯（タブバー/D-pad＝セーフエリア）
    info = {"name": name, "WxH": f"{W}x{H}", "top_frac": round(float(top_frac), 3),
            "var_top": round(top, 1), "var_mid": round(mid, 1), "var_bottom": round(bottom, 1)}
    print(f"  [{name}] 単色率={info['top_frac']} 分散 上={info['var_top']} 中={info['var_mid']} 下={info['var_bottom']}")
    # 判定
    if top_frac > 0.985:
        fail(f"{name}: 画面の {top_frac*100:.1f}% が単色＝空/破綻描画の疑い")
    if mid < 2.0:
        fail(f"{name}: 中央帯（グリッド/本文）に内容が無い（分散 {mid:.1f}）＝描画されていない疑い")
    # タイトル画面以外は下部にUI（タブバー/操作系）があるはず
    if not name.startswith("01_title") and not name.startswith("04_abyss") and bottom < 1.0:
        fail(f"{name}: 最下帯に内容が無い（分散 {bottom:.1f}）＝タブバー/操作系が最下端に届いていない疑い")
    return info

print("== visual-analyze（PIL）==")
infos = [analyze(p) for p in sys.argv[1:]]
print(f"\n=== visual 解析完了：{len(infos)} 枚 / {FAIL} fail ===")
if FAIL == 0:
    okmsg("空/破綻描画・主要帯の無内容・最下帯の取りこぼし、いずれも検出なし")
sys.exit(1 if FAIL else 0)

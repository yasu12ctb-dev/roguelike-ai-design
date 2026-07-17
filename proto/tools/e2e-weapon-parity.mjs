// 実ブラウザ E2E（外部レビュー PR2/5・武器比較 parity）：外部の戦闘シム（tools/sim-weapons.ts）の挙動が
//   本体（web/main.ts）と一致することを実測 assert する。__hazTest フック（"sekitsui.dbg"="1"）で盤面を制御し
//   決定論的に検証。ローカル専用（CI外・playwright は package.json に入れない規約）。
//
// MECH-1 薙刀の会心成立：距離2バーの中央に敵がいて初めて crit が成立し、押し出し+stunned が生存肩にも波及する。
//   中央が不在（肩だけ）だと meleeWithPositioning が一切呼ばれない＝crit は絶対に立たず、counterTurns も消費されない。
// MECH-2 剣の受け消費順：h.effect==="heavy"（area ボスの渾身の一撃）は guardArmed を消費しない。res.hits の配列順で
//   最初の「非heavy・隣接」1撃だけが半減され、以降の非heavy・隣接は満額。遠隔・非隣接は最初から guard 判定の対象外。
// MECH-3 踏み込み後位置：撃破→敵のいた元マスへ。生存かつ背後が空→背後へ。背後が塞がり→その場（攻撃はする）。
//   lunge 中は crit が強制 false＝counterTurns は「自然減衰(-1)」のみで、会心消費(→0)にはならない／押し出しも起きない。
import { chromium } from "playwright";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { join, extname } from "node:path";

const WEB_DIR = new URL("../web/", import.meta.url).pathname;
const PORT = 41890 + Math.floor(Math.random() * 900);
const EXEC = "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
const MIME = { ".html": "text/html", ".js": "text/javascript", ".json": "application/json", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png", ".webmanifest": "application/manifest+json" };

const server = createServer(async (req, res) => {
  try {
    const url = (req.url || "/").split("?")[0];
    const file = url === "/" ? "index.html" : url;
    const body = await readFile(join(WEB_DIR, file));
    res.writeHead(200, { "Content-Type": MIME[extname(file)] || "text/html" });
    res.end(body);
  } catch { res.writeHead(404); res.end("nf"); }
});
await new Promise((r) => server.listen(PORT, r));

const results = [];
const ok = (name, cond, extra = "") => { results.push({ name, pass: !!cond, extra }); console.log(`${cond ? "✅" : "❌"} ${name}${extra ? "  " + extra : ""}`); };

const browser = await chromium.launch({ headless: true, executablePath: EXEC, args: ["--no-sandbox"] });
const ctx = await browser.newContext({ viewport: { width: 480, height: 900 }, serviceWorkers: "block" });
const page = await ctx.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push("pageerror: " + (e.message || e)));
page.on("console", (m) => { if (m.type() === "error") errors.push("console.error: " + m.text()); });

const url = `http://localhost:${PORT}/`;
await page.goto(url, { waitUntil: "domcontentloaded" });
await page.evaluate(() => { try { localStorage.clear(); localStorage.setItem("sekitsui.dbg", "1"); } catch {} });
await page.goto(url, { waitUntil: "domcontentloaded" });
await page.waitForTimeout(400);

// タイトル→新しい物語→（難易度=easy）→名前→intro を消化して「潜行(dive)」まで進める（既存 E2E と同一手法）。
async function reachTownThenDive() {
  for (let i = 0; i < 80; i++) {
    const st = await page.evaluate(() => ({
      title: !!document.querySelector("#title")?.classList.contains("show"),
      titleBtns: [...document.querySelectorAll("#titleMenu button")].map((b) => (b.textContent || "").trim()),
      shown: !!document.querySelector("#overlay")?.classList.contains("show"),
      hasInput: !!document.querySelector("#sheetInputRow")?.classList.contains("show"),
      meta: document.querySelector("#sheetMeta")?.textContent || "",
      btns: [...document.querySelectorAll("#sheetButtons button")].map((b) => (b.textContent || "").trim()),
      mode: (window).__hazTest?.state?.().mode ?? null,
      hasChar: (window).__hazTest ? true : false,
    }));
    if (st.mode === "dive") return true;
    if (!st.shown && !st.title && (st.mode === "town" || st.mode === "interior")) {
      const ok2 = await page.evaluate(() => (window).__hazTest?.forceDive?.());
      if (ok2) { await page.waitForTimeout(300); const m = await page.evaluate(() => (window).__hazTest?.state?.().mode); if (m === "dive") return true; }
    }
    if (st.title) {
      const idx = Math.max(0, st.titleBtns.findIndex((t) => /物語|続き|はじま|触れて/.test(t)));
      await page.locator("#titleMenu button").nth(idx).click({ timeout: 3000 }).catch(() => {});
      await page.waitForTimeout(120); continue;
    }
    if (st.shown) {
      if (st.hasInput) await page.fill("#sheetInput", "検証者").catch(() => {});
      if (/難易度/.test(st.meta)) { const di = st.btns.findIndex((t) => /やさし|easy|安|快適/i.test(t)); await page.locator("#sheetButtons button").nth(di >= 0 ? di : 0).click().catch(() => {}); await page.waitForTimeout(120); continue; }
      await page.locator("#sheetButtons button").nth(0).click().catch(() => {});
      await page.waitForTimeout(120); continue;
    }
    await page.waitForTimeout(80);
  }
  return false;
}
const inDive = await reachTownThenDive();
ok("潜行(dive)へ到達", inDive);

// ══════════════════════════ MECH-1：薙刀の会心成立 ══════════════════════════
// 「上」入力＝bump(0,-1) 基準の距離2バー座標（薙刀 v0.150.0 の geometry・既存 e2e-guard-stagger.mjs と同一）。
const NAG_OPEN = [[0, -1], [0, -2], [1, -2], [-1, -2], [0, -3], [2, -3], [-2, -3], [1, 0], [-1, 0], [0, 1]];

// ★注記（発見した交絡要因・実装バグ疑い）：距離2の敵は隣接ではないため spawn 直後の queued intent は通常
//   「move」（プレイヤーへの接近）になる。この stale な move intent は、押し出し(pushEnemy)の“後”に resolveMonsters が
//   無条件解決してしまい、押し出しで移動した座標をさらに上書きする（実測で確認＝中央は高確率で「押し出し先」でなく
//   「元位置へ1歩接近した位置」に着地する＝push が意図せず無効化される）。これは薙刀固有の押し出し検証とは別軸の
//   「push直後にstale move intentが解決されるとpushを上書きしうる」という一般的な交絡＝本体側の実装バグ疑い（詳細は最終報告）。
//   このテストでは検証対象（押し出し+stunnedがcritでのみ起こるか）を交絡から隔離するため、bump直前に
//   clearIntent で queued intent を null 化する（押し出し結果そのものは書き換えない・観測を汚さないための最小処置）。
// (a) 中央+肩がすべて在る状態で会心＝中央・生存肩とも押し出し(座標が距離2→距離3へ移動)＋体勢崩し(stunned>=1)、counterTurns は消費(→0)。
const m1a = await page.evaluate(async (open) => {
  const t = (window).__hazTest;
  t.giveWeapon("大薙刀");
  t.clearMons();
  for (const [dx, dy] of open) t.setTile(dx, dy, 1);
  t.setHp(80);
  t.spawnMon(0, -2, 60);  // 中央
  t.spawnMon(1, -2, 60);  // 肩・右
  t.spawnMon(-1, -2, 60); // 肩・左
  t.clearIntent(0, -2); t.clearIntent(1, -2); t.clearIntent(-1, -2); // stale move intent の交絡を隔離
  t.setCounter(2);
  await new Promise((r) => { t.bump(0, -1); setTimeout(r, 240); });
  return {
    counterAfter: t.state().counterTurns,
    centerOld: t.monAt(0, -2), centerNew: t.monAt(0, -3),
    rightOld: t.monAt(1, -2), rightNew: t.monAt(2, -3),
    leftOld: t.monAt(-1, -2), leftNew: t.monAt(-2, -3),
  };
}, NAG_OPEN);
// 体勢崩し(stagger)の観測は intent==="wait" を見る（既存 e2e-guard-stagger.mjs と同じ流儀）。
//   monAt の生の stunned カウンタは「押し出し直後の endTurn 内で次ターン分の planMonsters がもう1回走り、
//   NAGINATA_STAGGER(=1) を毎回1ずつ減算する」ため、この観測タイミングでは既に 0 に戻っている（tick 済み＝仕様どおり）。
//   減算の“結果”である intent="wait" のほうが安定した signal。
ok("MECH-1a 中央が距離2→距離3へ押し出された", m1a.centerOld === null && !!m1a.centerNew, JSON.stringify(m1a));
ok("MECH-1a 中央がstunned(体勢崩し＝次手intent=wait)", m1a.centerNew?.intent === "wait", JSON.stringify(m1a.centerNew));
ok("MECH-1a 右肩が押し出された+stunned(intent=wait)", m1a.rightOld === null && !!m1a.rightNew && m1a.rightNew?.intent === "wait", JSON.stringify(m1a));
ok("MECH-1a 左肩が押し出された+stunned(intent=wait)", m1a.leftOld === null && !!m1a.leftNew && m1a.leftNew?.intent === "wait", JSON.stringify(m1a));
ok("MECH-1a counterTurns は会心で消費される(→0)", m1a.counterAfter === 0, `counter=${m1a.counterAfter}`);

// ★参考（交絡そのものの実測記録・pass/failには数えない）：clearIntent を使わず、spawn直後の自然な queued intent の
//   ままだと何が起こるかを実測で残す（MECH-1a と同一の盤面・唯一の差は clearIntent の有無）。
const m1aRaw = await page.evaluate(async (open) => {
  const t = (window).__hazTest;
  t.giveWeapon("大薙刀");
  t.clearMons();
  for (const [dx, dy] of open) t.setTile(dx, dy, 1);
  t.setHp(80);
  t.spawnMon(0, -2, 60);
  t.spawnMon(1, -2, 60);
  t.spawnMon(-1, -2, 60);
  t.setCounter(2);
  await new Promise((r) => { t.bump(0, -1); setTimeout(r, 240); });
  return { centerNew: t.monAt(0, -3), centerAtOneStepCloser: t.monAt(0, -1) };
}, NAG_OPEN);
console.log(`ℹ️  参考記録（交絡の実測・pass/fail対象外）: clearIntentなしの中央＝押し出し先(0,-3)にいるか=${!!m1aRaw.centerNew}／1歩接近した位置(0,-1)にいるか=${!!m1aRaw.centerAtOneStepCloser}（後者がtrueなら「stale move intentがpushを上書きする」交絡の再現）`);

// (b) 中央に敵を置かず肩だけ＝crit は絶対に成立しない（meleeWithPositioning が呼ばれない）＝押し出し/stunned なし、
//     counterTurns は「自然減衰(-1)」のみ（会心消費で→0にはならない）。外部シムがここで stagger/push を出すのはバグ。
const m1b = await page.evaluate(async (open) => {
  const t = (window).__hazTest;
  t.giveWeapon("大薙刀");
  t.clearMons();
  for (const [dx, dy] of open) t.setTile(dx, dy, 1);
  t.setHp(80);
  t.spawnMon(1, -2, 60);  // 肩・右のみ
  t.spawnMon(-1, -2, 60); // 肩・左のみ（中央(0,-2)は意図的に空席）
  t.clearIntent(1, -2); t.clearIntent(-1, -2); // 通常の追跡AIによる移動と「押し出し」を混同しないよう隔離
  t.setCounter(2);
  const rightBefore = t.monAt(1, -2), leftBefore = t.monAt(-1, -2);
  await new Promise((r) => { t.bump(0, -1); setTimeout(r, 240); });
  return {
    counterAfter: t.state().counterTurns,
    rightBefore, leftBefore,
    rightAfter: t.monAt(1, -2), leftAfter: t.monAt(-1, -2),
  };
}, NAG_OPEN);
ok("MECH-1b 中央不在＝右肩は位置不変(押し出しなし)", !!m1b.rightAfter && m1b.rightAfter.hp < m1b.rightBefore.hp, JSON.stringify(m1b));
ok("MECH-1b 中央不在＝右肩はstunnedしない(生カウンタ0・次手intentもwaitでない)", (m1b.rightAfter?.stunned ?? 0) === 0 && m1b.rightAfter?.intent !== "wait", JSON.stringify(m1b.rightAfter));
ok("MECH-1b 中央不在＝左肩は位置不変(押し出しなし)かつstunnedしない(次手intentもwaitでない)", !!m1b.leftAfter && m1b.leftAfter.hp < m1b.leftBefore.hp && (m1b.leftAfter?.stunned ?? 0) === 0 && m1b.leftAfter?.intent !== "wait", JSON.stringify(m1b));
ok("MECH-1b 中央不在＝counterTurnsは会心消費されない(自然減衰-1のみ＝2→1)", m1b.counterAfter === 1, `counter=${m1b.counterAfter}（会心消費なら0になっているはず）`);

// ══════════════════════════ MECH-2：剣の受け消費順 ══════════════════════════
// (a)+(b) heavy は guard を消費しない（res.hits で最初に来ても素通り）→ その後の最初の非heavy・隣接1撃だけ半減 →
//     2体目以降の非heavy・隣接は満額。革鎧(reduce=1固定・procなし)＋戦鎚(剣クラス・procなし)＋easy(chipFrac=0)で
//     ダメージ式を完全予測可能にする：非heavy dmg = max(1, kind.dmg-1)／heavy dmg = max(1, kind.dmg*2-1、guardなし)。
const m2ab = await page.evaluate(async () => {
  const t = (window).__hazTest;
  t.giveWeapon("戦鎚");       // 剣クラス（reach1・非薙ぎ・procなし）
  t.giveArmor("革鎧", 1);     // reduce=1固定・procなし
  t.setDifficulty("easy");    // chipFrac=0（比例チップの影響を排除）
  t.clearMons();
  for (const [dx, dy] of [[0, 1], [1, 0], [-1, 0]]) t.setTile(dx, dy, 1);
  t.setHp(300);
  t.spawnDmg(0, 1, "rat", 6, 30);   // index0＝南。後で forceHeavy で heavy 化。素dmg=6→heavy: 6*2-1=11
  t.spawnDmg(1, 0, "rat", 4, 30);   // index1＝東。非heavy・隣接の1体目＝guardで半減：ceil((4-1)/2)=2
  t.spawnDmg(-1, 0, "rat", 5, 30);  // index2＝西。非heavy・隣接の2体目＝guard消費済で満額：5-1=4
  t.forceHeavy(0, 1); // ★heavy 化は全スポーン後（planMonsters の再計画で通常attackへ巻き戻されないよう最後に）
  t.armGuard();
  const before = t.getHp();
  await new Promise((r) => { t.step(); setTimeout(r, 240); });
  return { before, after: t.getHp(), loss: before - t.getHp() };
});
ok("MECH-2ab heavy→非heavy1体目(半減)→非heavy2体目(満額)＝合計17（11+2+4）", m2ab.loss === 17, `loss=${m2ab.loss}（内訳: heavy=11 + guarded=2 + full=4 を期待。guardがheavyに消費されるバグなら 11+11+4=26 や 11+4+4=19 等になる）`);

// (c) 遠隔・非隣接は guard 判定の対象外（距離>1）＝guard を消費しない。同一ターンに隣接の非heavy攻撃を混在させ、
//     遠隔が満額・隣接がguardで半減されることを見て「guardが遠隔で先食いされていない」ことを確認する。
const m2c = await page.evaluate(async () => {
  const t = (window).__hazTest;
  t.giveWeapon("戦鎚");
  t.giveArmor("革鎧", 1);
  t.setDifficulty("easy");
  t.clearMons();
  for (const [dx, dy] of [[0, -1], [0, -2], [0, -3], [1, 0]]) t.setTile(dx, dy, 1);
  t.setHp(300);
  t.spawnRanged(0, -3, 30); // index0＝距離3の遠隔攻撃（吐酸蟲・dmg=2）。満額: max(1,2-1)=1
  t.spawnDmg(1, 0, "rat", 5, 30); // index1＝隣接の非heavy。guardで半減: ceil((5-1)/2)=2
  t.armGuard();
  const before = t.getHp();
  await new Promise((r) => { t.step(); setTimeout(r, 240); });
  return { before, after: t.getHp(), loss: before - t.getHp() };
});
ok("MECH-2c 遠隔(満額1)＋隣接1体目(guardで半減2)＝合計3（遠隔がguardを先食いしていない）", m2c.loss === 3, `loss=${m2c.loss}（遠隔がguardを誤って消費するバグなら 1+4=5 になる）`);

// ══════════════════════════ MECH-3：踏み込み後位置 ══════════════════════════
async function shiftDir(page, key) {
  await page.keyboard.down("Shift");
  await page.keyboard.press(key);
  await page.keyboard.up("Shift");
}

// (a) 敵撃破＝そのマスへ貫き抜ける。
const m3a = await page.evaluate(async () => {
  const t = (window).__hazTest;
  t.giveWeapon("戦鎚");
  t.clearMons();
  t.setTile(0, 1, 1);
  t.setHp(200);
  t.spawnDmg(0, 1, "rat", 3, 1); // hp1＝一撃で死ぬ
  return { before: t.playerAt() };
});
await shiftDir(page, "ArrowDown"); // Shift+↓＝その一撃だけ踏み込み（lungeOnceRequest）
await page.waitForTimeout(240);
const m3aAfter = await page.evaluate(() => (window).__hazTest.playerAt());
ok("MECH-3a 敵撃破＝元の敵マスへ移動", m3aAfter.x === m3a.before.x && m3aAfter.y === m3a.before.y + 1, JSON.stringify({ before: m3a.before, after: m3aAfter }));

// (b) 敵生存＋背後が空＝背後のマスへ貫き抜ける。
const m3b = await page.evaluate(async () => {
  const t = (window).__hazTest;
  t.giveWeapon("戦鎚");
  t.clearMons();
  t.setTile(0, 1, 1); t.setTile(0, 2, 1); // 隣接＋背後を開ける
  t.setHp(200);
  t.spawnDmg(0, 1, "rat", 3, 60); // 高HP＝一撃では死なない
  return { before: t.playerAt() };
});
await shiftDir(page, "ArrowDown");
await page.waitForTimeout(240);
const m3bAfter = await page.evaluate(() => (window).__hazTest.playerAt());
ok("MECH-3b 敵生存+背後が空＝背後のマスへ移動", m3bAfter.x === m3b.before.x && m3bAfter.y === m3b.before.y + 2, JSON.stringify({ before: m3b.before, after: m3bAfter }));

// (c) 敵生存＋背後が壁＝その場（攻撃はする＝敵HPは減る）。
const m3c = await page.evaluate(async () => {
  const t = (window).__hazTest;
  t.giveWeapon("戦鎚");
  t.clearMons();
  t.setTile(0, 1, 1); t.setTile(0, 2, 0); // 隣接のみ開け、背後は明示的に壁
  t.setHp(200);
  const monBefore = (() => { t.spawnDmg(0, 1, "rat", 3, 60); return t.monAt(0, 1); })();
  return { before: t.playerAt(), monBefore };
});
await shiftDir(page, "ArrowDown");
await page.waitForTimeout(240);
const m3cAfter = await page.evaluate(() => ({ player: (window).__hazTest.playerAt(), mon: (window).__hazTest.monAt(0, 1) }));
ok("MECH-3c 背後塞がり＝その場に留まる", m3cAfter.player.x === m3c.before.x && m3cAfter.player.y === m3c.before.y, JSON.stringify({ before: m3c.before, after: m3cAfter.player }));
ok("MECH-3c ただし攻撃自体は成立(敵HPが減る)", !!m3cAfter.mon && m3cAfter.mon.hp < m3c.monBefore.hp, JSON.stringify({ before: m3c.monBefore, after: m3cAfter.mon }));

// (d) lunge中は会心が乗らない＝counterTurnsは自然減衰(-1)のみ・押し出しも起きない（敵は元の位置のまま）。
// ★注記（発見した交絡・テスト設計上の教訓＝本体側の挙動ではない）：最初「生存+背後が空」の構成（MECH-3bと同型）で
//   組んだところ counterTurns が「2のまま」になり一見バグに見えた。実際は二重の交絡＝
//   ①lungeThrough で player 自身が (0,2) へ移動するため、事前に置いた敵の queued attack intent（player の“元”座標を
//     狙っていた）が的外れになり「見切り(dodge)」として処理される→見切り成功は counterTurns を COUNTER_WINDOW(=2) に
//     "再びセット"する専用ロジック（見切り→反撃の好機、C/D の通常仕様）が別途走り、たまたま元の2と同値になって
//     「消費されていない」ように見えるだけで、実際は「自然減衰(-1)」ではなく「見切りによる再セット」だった。
//   ②monAt はプレイヤー相対座標なので、player 移動後に同じ相対オフセットで問い合わせると絶対マスがズレる。
//   このテストで検証したいのは「lunge が meleeWithPositioning の crit を強制falseにする」ことだけなので、
//   MECH-3c と同型（生存・背後は壁で塞がる＝player は動かない）にして、上記の交絡（player 移動→見切り誤検出）を
//   構造的に避ける。この場合、敵の攻撃意図は player の元の（＝不動の）座標を正しく狙って命中し、見切りは発生しない。
const m3d = await page.evaluate(async () => {
  const t = (window).__hazTest;
  t.giveWeapon("戦鎚");
  t.clearMons();
  t.setTile(0, 1, 1); t.setTile(0, 2, 0); // 隣接のみ開け、背後は壁＝player は動かない（MECH-3cと同型）
  t.setHp(200);
  t.spawnDmg(0, 1, "rat", 3, 60); // 高HP＝生存
  t.setCounter(2);
  const monBefore = t.monAt(0, 1);
  return { counterBefore: t.state().counterTurns, monBefore, playerBefore: t.playerAt() };
});
await shiftDir(page, "ArrowDown");
await page.waitForTimeout(240);
const m3dAfter = await page.evaluate(() => ({
  counter: (window).__hazTest.state().counterTurns,
  player: (window).__hazTest.playerAt(),
  mon: (window).__hazTest.monAt(0, 1), // player は動かない前提＝相対(0,1)がそのまま元の敵位置
}));
ok("MECH-3d lunge中は押し出しが発生しない(敵は元位置(0,1)のまま)", m3dAfter.player.x === m3d.playerBefore.x && m3dAfter.player.y === m3d.playerBefore.y && !!m3dAfter.mon, JSON.stringify({ before: m3d, after: m3dAfter }));
ok("MECH-3d lunge中はcounterTurnsが会心消費されない(自然減衰-1のみ＝2→1・見切り再セットの交絡なし)", m3dAfter.counter === 1, `counter=${m3dAfter.counter}（会心が乗るバグなら0になる）`);

ok("例外・console.error ゼロ", errors.length === 0, errors.slice(0, 5).join(" | "));

await browser.close();
server.close();

const failed = results.filter((r) => !r.pass);
console.log(`\n=== E2E 武器 parity（MECH-1/2/3）：${results.length - failed.length}/${results.length} pass ===`);
if (failed.length) { console.log("FAILED:", failed.map((f) => f.name).join(", ")); process.exit(1); }

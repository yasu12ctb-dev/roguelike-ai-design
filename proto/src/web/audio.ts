// プロシージャル・サウンド（Web Audio・素材ファイル不要）。SFX＋間欠的な環境音＋ミュート。
// 持続ドローン（ブーンという不快音）は廃止。代わりに「たまに鳴る」水滴・遠い風・軋みで気配を出す。
// ブラウザ専用・実行時LLMゼロと整合。AudioContext はユーザー操作で resume（iOS対応）。

let ctx: AudioContext | null = null;
let master: GainNode | null = null;     // ミュート反映
let muted = false;
let started = false;

let ambOn = false;
let ambDepth = 1;
let ambTimer: ReturnType<typeof setTimeout> | null = null;

const MUTE_KEY = "sekitsui.muted";

export function isMuted(): boolean { return muted; }

export function loadMutePref(): void {
  try { muted = localStorage.getItem(MUTE_KEY) === "1"; } catch { /* ignore */ }
}

/** 最初のユーザー操作で呼ぶ：AudioContext を作って resume する。 */
export function ensureAudio(): void {
  if (started) { if (ctx && ctx.state === "suspended") void ctx.resume(); if (ambOn) scheduleAmbient(); kickBgm(); return; }
  try {
    const AC = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    if (!AC) return;
    ctx = new AC();
    master = ctx.createGain();
    master.gain.value = muted ? 0 : 1;
    master.connect(ctx.destination);
    started = true;
    void ctx.resume();
    if (ambOn) scheduleAmbient();
    kickBgm(); // AudioContext が出来た瞬間に、待たせていた場面 BGM を始める（iOS 対応）
  } catch { /* 音が出せない環境は無音で続行 */ }
}

export function setMuted(b: boolean): void {
  muted = b;
  try { localStorage.setItem(MUTE_KEY, b ? "1" : "0"); } catch { /* ignore */ }
  if (master && ctx) master.gain.setTargetAtTime(b ? 0 : 1, ctx.currentTime, 0.02);
}

/** 環境音の ON/OFF と深度（深いほど頻繁・低い）。潜行中ON・街/死でOFF。 */
export function setAmbient(on: boolean, depth = 1): void {
  ambOn = on;
  ambDepth = depth;
  if (on) scheduleAmbient();
  else if (ambTimer !== null) { clearTimeout(ambTimer); ambTimer = null; }
}

// ランダム環境音（水滴等）は「ポポンと謎の音が鳴って不快」との指摘で停止中。
// 環境音／BGM は ROADMAP 横断G で再設計予定。setAmbient API は据え置き（呼び出し側そのまま）。
const AMBIENT_ONESHOTS = false;

function scheduleAmbient(): void {
  if (ambTimer !== null) { clearTimeout(ambTimer); ambTimer = null; }
  if (!AMBIENT_ONESHOTS || !ambOn || !started) return;
  // 深いほど間隔が縮む（浅:5〜11秒 → 深:2.5〜6秒）
  const base = Math.max(2.5, 8 - ambDepth * 0.16);
  const delay = base * (0.7 + Math.random() * 0.9) * 1000;
  ambTimer = setTimeout(() => {
    if (ambOn && !muted && ctx) playAmbientOne();
    scheduleAmbient();
  }, delay);
}

function playAmbientOne(): void {
  const r = Math.random();
  if (r < 0.5) ambDrip();
  else if (r < 0.82) ambWind();
  else ambCreak();
}

function ambDrip(): void { // 水滴（深いほど低く）
  const f = Math.max(300, 780 - ambDepth * 11) + Math.random() * 120;
  tone(f, 0.22, "sine", 0.06, f * 0.6);
  setTimeout(() => tone(f * 0.98, 0.18, "sine", 0.03, f * 0.55), 130); // 微かな反響
}

function ambWind(): void { // 遠い風（ノイズの吹き上がり）
  if (!ctx || !master) return;
  const dur = 1.3 + Math.random() * 1.4;
  const n = Math.floor(ctx.sampleRate * dur);
  const buf = ctx.createBuffer(1, n, ctx.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < n; i++) d[i] = Math.random() * 2 - 1;
  const src = ctx.createBufferSource(); src.buffer = buf;
  const lp = ctx.createBiquadFilter(); lp.type = "lowpass"; lp.frequency.value = 280 + Math.random() * 220;
  const g = ctx.createGain();
  const t = ctx.currentTime;
  g.gain.setValueAtTime(0.0001, t);
  g.gain.linearRampToValueAtTime(0.05, t + dur * 0.4);
  g.gain.linearRampToValueAtTime(0.0001, t + dur);
  src.connect(lp); lp.connect(g); g.connect(master);
  src.start(); src.stop(t + dur + 0.05);
}

function ambCreak(): void { // 軋み（低い唸り）
  const f = Math.max(48, 92 - ambDepth);
  tone(f, 0.7, "sawtooth", 0.04, f * 1.5);
}

function env(g: GainNode, peak: number, dur: number): void {
  if (!ctx) return;
  const t = ctx.currentTime;
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(peak, t + 0.008);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
}

function tone(freq: number, dur: number, type: OscillatorType, peak: number, slideTo?: number): void {
  if (!ctx || !master) return;
  const o = ctx.createOscillator(); o.type = type; o.frequency.value = freq;
  if (slideTo) o.frequency.exponentialRampToValueAtTime(Math.max(1, slideTo), ctx.currentTime + dur);
  const g = ctx.createGain(); env(g, peak, dur);
  o.connect(g); g.connect(master);
  o.start(); o.stop(ctx.currentTime + dur + 0.03);
}

function noise(dur: number, peak: number, filterFreq: number): void {
  if (!ctx || !master) return;
  const n = Math.floor(ctx.sampleRate * dur);
  const buf = ctx.createBuffer(1, n, ctx.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < n; i++) d[i] = Math.random() * 2 - 1;
  const src = ctx.createBufferSource(); src.buffer = buf;
  const bp = ctx.createBiquadFilter(); bp.type = "bandpass"; bp.frequency.value = filterFreq;
  const g = ctx.createGain(); env(g, peak, dur);
  src.connect(bp); bp.connect(g); g.connect(master);
  src.start(); src.stop(ctx.currentTime + dur + 0.03);
}

export type Sfx =
  | "move" | "hit" | "hurt" | "open" | "chest" | "stairs" | "death" | "intervene"
  | "spell_warp" | "spell_still" | "spell_blink";

/** 短い合成効果音。ミュート中・未初期化なら無音。音量は控えめドローン廃止に合わせて上げてある。 */
export function sfx(kind: Sfx): void {
  if (!ctx || muted) return;
  switch (kind) {
    case "move": tone(150, 0.05, "triangle", 0.06); break;
    // 攻撃した＝高く鋭い一撃（こちらが討つ）。被弾＝低く重い衝撃（こちらが討たれる）。聞き分け重視で音域を離す。
    case "hit": noise(0.05, 0.16, 2600); tone(660, 0.07, "square", 0.12, 300); break;
    case "hurt": noise(0.1, 0.18, 480); tone(135, 0.26, "sawtooth", 0.27, 56); break;
    case "open": tone(420, 0.13, "sine", 0.14); break;
    case "chest": tone(523, 0.13, "sine", 0.15); setTimeout(() => tone(784, 0.18, "sine", 0.12), 95); break;
    case "stairs": tone(300, 0.24, "sine", 0.15, 150); break;
    case "death": tone(120, 0.9, "sine", 0.24, 55); break;
    case "intervene": tone(660, 0.45, "sine", 0.15); break;
    // 深蝕魔法（4-11F③）。歪撃＝歪んだ鋭い炸裂／静止＝昇る冷たいシマー／影渡り＝抜ける疾走音。
    case "spell_warp": tone(880, 0.22, "sawtooth", 0.2, 120); noise(0.12, 0.14, 1800); break;
    case "spell_still": tone(320, 0.45, "sine", 0.16, 1500); setTimeout(() => tone(1500, 0.3, "sine", 0.08), 120); break;
    case "spell_blink": noise(0.26, 0.16, 900); tone(500, 0.18, "sine", 0.12, 1300); break;
  }
}

// ============================================================================
// BGM（場面別の持続音楽。プロシージャル・サンプル不要・ROADMAP 横断G の再設計）
// 他ゲーム（ダークアンビエント/ダンジョン crawler）のリサーチ準拠：深いドローン＋
// 最小限の旋律＋合成コンボリューション・リバーブ（減衰ノイズのインパルス）で余韻を作る。
// 割り当て：街=⑤灰の街／迷宮=②冷たい石の広間（深度連動）／深淵・山場=③沈淵（深度連動）／
//          タイトル・死=④追憶（短調の旋律）。①悼みのドローンは予備（未割当）。
// ============================================================================
export type BgmScene = "title" | "town" | "dungeon" | "abyss" | "death";

const BGM_KEY = "sekitsui.bgm";
const BGMVOL_KEY = "sekitsui.bgmvol";
let bgmEnabled = true;
let bgmVol = 0.6;
let bgmGain: GainNode | null = null;     // BGM 専用のボリューム（master の下＝mute と二段）
let reverb: ConvolverNode | null = null;
let dryBus: GainNode | null = null;      // 原音バス
let wetBus: GainNode | null = null;      // 残響センド
let curScene: BgmScene | null = null;
let curDepth = 1;
let curTrack: Track | null = null;
let desiredScene: BgmScene | null = null; // AudioContext 起動前に要求された場面を覚えておく
let desiredDepth = 1;

interface Track { stop(): void; setDepth(d: number): void; }

export function isBgmOn(): boolean { return bgmEnabled; }
export function bgmVolume(): number { return bgmVol; }

export function loadBgmPref(): void {
  try {
    const e = localStorage.getItem(BGM_KEY); if (e !== null) bgmEnabled = e !== "0";
    const v = localStorage.getItem(BGMVOL_KEY); if (v !== null) { const n = parseFloat(v); if (!Number.isNaN(n)) bgmVol = Math.max(0, Math.min(1, n)); }
  } catch { /* ignore */ }
}

export function setBgmEnabled(b: boolean): void {
  bgmEnabled = b;
  try { localStorage.setItem(BGM_KEY, b ? "1" : "0"); } catch { /* ignore */ }
  if (bgmGain && ctx) bgmGain.gain.setTargetAtTime(b ? bgmVol : 0, ctx.currentTime, 0.1);
  if (!b) stopBgm();
  else if (desiredScene) startScene(desiredScene, desiredDepth);
}

export function setBgmVolume(v: number): void {
  bgmVol = Math.max(0, Math.min(1, v));
  try { localStorage.setItem(BGMVOL_KEY, String(bgmVol)); } catch { /* ignore */ }
  if (bgmGain && ctx) bgmGain.gain.setTargetAtTime(bgmEnabled ? bgmVol : 0, ctx.currentTime, 0.1);
}

/** 場面 BGM を設定（同じ場面なら何もしない／深度連動の迷宮系は深度のみ更新）。
 *  AudioContext 未起動なら要求だけ覚え、最初の操作で ensureAudio→kickBgm が始める。 */
export function setBgm(scene: BgmScene, depth = 1): void {
  desiredScene = scene; desiredDepth = depth;
  if (!bgmEnabled || !ctx || !started) return;
  startScene(scene, depth);
}

/** 潜行が一段深まった等で深度だけ更新（迷宮=②／深淵=③の音色が暗く低くなる）。 */
export function setBgmDepth(depth: number): void {
  desiredDepth = depth;
  curDepth = depth;
  if (curTrack && (curScene === "dungeon" || curScene === "abyss")) curTrack.setDepth(depth);
}

function kickBgm(): void {
  if (!ctx || !started) return;
  if (bgmEnabled && desiredScene && !curTrack) startScene(desiredScene, desiredDepth);
}

function stopBgm(): void {
  if (curTrack) { try { curTrack.stop(); } catch { /* ignore */ } curTrack = null; }
  curScene = null;
}

function startScene(scene: BgmScene, depth: number): void {
  if (!ctx) return;
  ensureBgmBus();
  curDepth = depth;
  if (curScene === scene) { if (curTrack) curTrack.setDepth(depth); return; }
  if (curTrack) { try { curTrack.stop(); } catch { /* ignore */ } curTrack = null; } // 旧トラックは自前で長フェードアウト＝自然なクロスフェード
  curScene = scene;
  curTrack = makeTrack(scene);
}

function ensureBgmBus(): void {
  if (bgmGain || !ctx || !master) return;
  bgmGain = ctx.createGain(); bgmGain.gain.value = bgmEnabled ? bgmVol : 0; bgmGain.connect(master);
  reverb = ctx.createConvolver(); reverb.buffer = makeImpulse(3.6, 2.6);
  const ret = ctx.createGain(); ret.gain.value = 0.9; reverb.connect(ret); ret.connect(bgmGain);
  dryBus = ctx.createGain(); dryBus.gain.value = 0.65; dryBus.connect(bgmGain);
  wetBus = ctx.createGain(); wetBus.gain.value = 1.0; wetBus.connect(reverb);
}

// 減衰ホワイトノイズの合成インパルス＝サンプル無しのリバーブ（Web Audio 定番）。
function makeImpulse(dur: number, decay: number): AudioBuffer {
  const rate = ctx!.sampleRate, len = Math.floor(rate * dur);
  const buf = ctx!.createBuffer(2, len, rate);
  for (let c = 0; c < 2; c++) {
    const d = buf.getChannelData(c);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, decay);
  }
  return buf;
}

const bm = (m: number) => 440 * Math.pow(2, (m - 69) / 12); // MIDI ノート番号→Hz
const Tn = () => ctx!.currentTime;
const bgPick = <T,>(a: T[]): T => a[Math.floor(Math.random() * a.length)];
const NAT_MINOR = [0, 2, 3, 5, 7, 8, 10];
const PENT_MINOR = [0, 3, 5, 7, 10];

// 出力を原音/残響の両バスへ（wet=残響量）。
function route(node: AudioNode, wet: number): void {
  node.connect(dryBus!);
  const w = ctx!.createGain(); w.gain.value = wet; node.connect(w); w.connect(wetBus!);
}

interface PadOpts { wave: OscillatorType; detune: number; amp: number; lpf: number; lfoRate: number; spread: number; wet: number; depthReact?: boolean; }
interface Pad { setChord(notes: number[], ramp: number): void; stop(): void; }

// 持続パッド：和音を周波数ランプで推移＋呼吸LFO＋デチューン重ね＋ステレオ拡げ。
function padChord(initNotes: number[], o: PadOpts): Pad {
  const lp = ctx!.createBiquadFilter(); lp.type = "lowpass"; lp.frequency.value = o.lpf; lp.Q.value = 0.3;
  const out = ctx!.createGain(); out.gain.value = 0.0001;
  lp.connect(out); route(out, o.wet);
  const baseLpf = o.lpf;
  const voices = initNotes.map((m, idx) => {
    const pan = ctx!.createStereoPanner();
    pan.pan.value = (initNotes.length > 1 ? (idx / (initNotes.length - 1)) * 2 - 1 : 0) * o.spread;
    pan.connect(lp);
    const all: OscillatorNode[] = [], carriers: OscillatorNode[] = [];
    for (let k = 0; k < 2; k++) {
      const osc = ctx!.createOscillator(); osc.type = o.wave; osc.frequency.value = bm(m); osc.detune.value = k ? o.detune : -o.detune;
      const vg = ctx!.createGain(); vg.gain.value = o.amp;
      const lfo = ctx!.createOscillator(); lfo.type = "sine"; lfo.frequency.value = o.lfoRate * (0.7 + Math.random() * 0.6);
      const lg = ctx!.createGain(); lg.gain.value = o.amp * 0.42; lfo.connect(lg); lg.connect(vg.gain);
      osc.connect(vg); vg.connect(pan); osc.start(); lfo.start(Tn() + Math.random() * 2.5);
      all.push(osc, lfo); carriers.push(osc);
    }
    return { all, carriers };
  });
  out.gain.setValueAtTime(0.0001, Tn());
  out.gain.linearRampToValueAtTime(1, Tn() + 4.2); // 長フェードイン
  function setChord(notes: number[], ramp: number): void {
    const tr = o.depthReact ? -Math.floor(curDepth / 5) : 0;
    voices.forEach((v, i) => {
      const m = notes[i % notes.length] + tr;
      v.carriers.forEach((osc) => osc.frequency.exponentialRampToValueAtTime(Math.max(20, bm(m)), Tn() + ramp));
    });
    if (o.depthReact) lp.frequency.exponentialRampToValueAtTime(Math.max(120, baseLpf * (1 - 0.55 * curDepth / 50)), Tn() + ramp);
  }
  function stop(): void {
    out.gain.cancelScheduledValues(Tn()); out.gain.setValueAtTime(out.gain.value, Tn());
    out.gain.linearRampToValueAtTime(0.0001, Tn() + 2.2);
    const s = Tn() + 2.4;
    voices.forEach((v) => v.all.forEach((n) => { try { n.stop(s); } catch { /* ignore */ } }));
  }
  return { setChord, stop };
}

// 柔らかい単音（鐘/旋律）：長アタック/減衰＝クリックなし。オクターブ上の倍音で質感。
function bnote(m: number, attack: number, hold: number, release: number, peak: number, type: OscillatorType, wet: number): void {
  const o = ctx!.createOscillator(); o.type = type; o.frequency.value = bm(m);
  const o2 = ctx!.createOscillator(); o2.type = "sine"; o2.frequency.value = bm(m + 12);
  const g = ctx!.createGain(); g.gain.value = 0.0001;
  const g2 = ctx!.createGain(); g2.gain.value = 0.0001;
  o.connect(g); o2.connect(g2); route(g, wet); route(g2, Math.min(1, wet + 0.2));
  const t = Tn();
  g.gain.linearRampToValueAtTime(peak, t + attack);
  g.gain.setValueAtTime(peak, t + attack + hold);
  g.gain.exponentialRampToValueAtTime(0.0001, t + attack + hold + release);
  g2.gain.linearRampToValueAtTime(peak * 0.28, t + attack);
  g2.gain.exponentialRampToValueAtTime(0.0001, t + attack + hold + release * 0.7);
  const end = t + attack + hold + release + 0.1;
  o.start(t); o2.start(t); o.stop(end); o2.stop(end);
}

// ゆっくりしたエア（フィルタノイズの吹き上がり）。動きの層。
function airLayer(filterFreq: number, peak: number, rate: number): { stop(): void } {
  const len = Math.floor(ctx!.sampleRate * 4);
  const buf = ctx!.createBuffer(1, len, ctx!.sampleRate);
  const d = buf.getChannelData(0); for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
  const src = ctx!.createBufferSource(); src.buffer = buf; src.loop = true;
  const bp = ctx!.createBiquadFilter(); bp.type = "bandpass"; bp.frequency.value = filterFreq; bp.Q.value = 0.8;
  const g = ctx!.createGain(); g.gain.value = 0.0001;
  const lfo = ctx!.createOscillator(); lfo.frequency.value = rate;
  const lg = ctx!.createGain(); lg.gain.value = peak; lfo.connect(lg); lg.connect(g.gain);
  src.connect(bp); bp.connect(g); route(g, 1.0); src.start(); lfo.start();
  return { stop() { const s = Tn() + 1.6; g.gain.setTargetAtTime(0.0001, Tn(), 0.5); try { src.stop(s); lfo.stop(s); } catch { /* ignore */ } } };
}

// ---- 場面トラック（mock の候補②③④⑤を移植）----
function makeTrack(scene: BgmScene): Track {
  const timers: ReturnType<typeof setInterval>[] = [];
  const every = (ms: number, fn: () => void) => { timers.push(setInterval(() => { if (!muted) fn(); }, ms)); };
  const clearAll = () => timers.forEach((t) => clearInterval(t));

  if (scene === "town") { // ⑤灰の街：暖かいが仄かに哀しいパッド＋優しい単音
    const pad = padChord([50, 53, 57, 60], { wave: "triangle", detune: 6, amp: 0.03, lpf: 1500, lfoRate: 0.055, spread: 0.6, wet: 0.75 });
    const chords = [[50, 53, 57, 60], [46, 50, 53, 57], [48, 52, 55, 59]]; // Dm9 / Bbmaj7 / Cadd9
    let i = 0; every(15000, () => { i = (i + 1) % chords.length; pad.setChord(chords[i], 9); });
    every(5200, () => bnote(62 + bgPick(PENT_MINOR), 0.6, 0.2, 2.4, 0.035, "sine", 0.7));
    return { stop() { clearAll(); pad.stop(); }, setDepth() { /* noop */ } };
  }
  if (scene === "dungeon") { // ②冷たい石の広間：疎な空虚5度＋遠い鐘・深度連動
    const pad = padChord([38, 45, 50], { wave: "sine", detune: 6, amp: 0.04, lpf: 650, lfoRate: 0.045, spread: 0.7, wet: 1.0, depthReact: true });
    const chords = [[38, 45, 50], [36, 43, 48], [40, 47, 52]];
    let i = 0; every(19000, () => { i = (i + 1) % chords.length; pad.setChord(chords[i], 10); });
    every(7000, () => bnote(57 + bgPick(PENT_MINOR) + 12 * bgPick([0, 1]) - Math.floor(curDepth / 5), 1.8, 0.4, 6.0, 0.05, "sine", 1.0));
    return { stop() { clearAll(); pad.stop(); }, setDepth() { pad.setChord(chords[i], 2); } };
  }
  if (scene === "abyss") { // ③沈淵：最低域サブ＋不協和クラスタ・深度連動
    const pad = padChord([26, 38, 39, 44], { wave: "sine", detune: 4, amp: 0.05, lpf: 380, lfoRate: 0.035, spread: 0.5, wet: 0.85, depthReact: true });
    const air = airLayer(90, 0.03, 0.025);
    const chords = [[26, 38, 39, 44], [26, 37, 39, 44], [24, 36, 37, 43]]; // 短2度/三全音の緊張
    let i = 0; every(21000, () => { i = (i + 1) % chords.length; pad.setChord(chords[i], 12); });
    return { stop() { clearAll(); pad.stop(); air.stop(); }, setDepth() { pad.setChord(chords[i], 2); } };
  }
  // "title" / "death" → ④追憶：薄いパッド上を、孤独な短調の旋律がゆっくり巡る
  const pad = padChord([45, 52, 57], { wave: "triangle", detune: 5, amp: 0.022, lpf: 1200, lfoRate: 0.05, spread: 0.5, wet: 0.9 });
  let last = 0;
  every(2600, () => {
    last = Math.max(0, Math.min(NAT_MINOR.length - 1 + 7, last + bgPick([-2, -1, 0, 1, 2])));
    const deg = NAT_MINOR[last % NAT_MINOR.length] + 12 * Math.floor(last / NAT_MINOR.length);
    bnote(57 + deg, 0.04, 0.1, 2.8, 0.06, "triangle", 0.8);
  });
  return { stop() { clearAll(); pad.stop(); }, setDepth() { /* noop */ } };
}

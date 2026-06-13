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
  if (started) { if (ctx && ctx.state === "suspended") void ctx.resume(); if (ambOn) scheduleAmbient(); return; }
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

function scheduleAmbient(): void {
  if (ambTimer !== null) { clearTimeout(ambTimer); ambTimer = null; }
  if (!ambOn || !started) return;
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

export type Sfx = "move" | "hit" | "hurt" | "open" | "chest" | "stairs" | "death" | "intervene";

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
  }
}

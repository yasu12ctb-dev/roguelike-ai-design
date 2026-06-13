// プロシージャル・サウンド（Web Audio・素材ファイル不要）。SFX＋低い環境ドローン＋ミュート。
// ブラウザ専用・オフライン買い切りと整合（実行時LLMゼロ）。AudioContext はユーザー操作で resume（iOS対応）。

let ctx: AudioContext | null = null;
let master: GainNode | null = null;     // ミュート反映
let ambGain: GainNode | null = null;    // 環境音の音量
const ambOsc: OscillatorNode[] = [];
let muted = false;
let started = false;

const MUTE_KEY = "sekitsui.muted";

export function isMuted(): boolean { return muted; }

export function loadMutePref(): void {
  try { muted = localStorage.getItem(MUTE_KEY) === "1"; } catch { /* ignore */ }
}

/** 最初のユーザー操作で呼ぶ：AudioContext を作って resume し、環境ドローンを用意する。 */
export function ensureAudio(): void {
  if (started) { if (ctx && ctx.state === "suspended") void ctx.resume(); return; }
  try {
    const AC = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    if (!AC) return;
    ctx = new AC();
    master = ctx.createGain();
    master.gain.value = muted ? 0 : 1;
    master.connect(ctx.destination);
    // 環境ドローン：低い2基＋ローパス＋ゆっくりした息づかい（LFO）
    ambGain = ctx.createGain();
    ambGain.gain.value = 0; // dive で上げる
    const lp = ctx.createBiquadFilter();
    lp.type = "lowpass"; lp.frequency.value = 320;
    ambGain.connect(lp); lp.connect(master);
    for (const f of [55, 55.4]) {
      const o = ctx.createOscillator();
      o.type = "sine"; o.frequency.value = f;
      o.connect(ambGain); o.start();
      ambOsc.push(o);
    }
    const lfo = ctx.createOscillator(); lfo.frequency.value = 0.07;
    const lfoG = ctx.createGain(); lfoG.gain.value = 0.012;
    lfo.connect(lfoG); lfoG.connect(ambGain.gain); lfo.start();
    started = true;
    void ctx.resume();
  } catch { /* 音が出せない環境は無音で続行 */ }
}

export function setMuted(b: boolean): void {
  muted = b;
  try { localStorage.setItem(MUTE_KEY, b ? "1" : "0"); } catch { /* ignore */ }
  if (master && ctx) master.gain.setTargetAtTime(b ? 0 : 1, ctx.currentTime, 0.02);
}

/** 環境ドローンの ON/OFF と深度反映（深いほど低く）。 */
export function setAmbient(on: boolean, depth = 1): void {
  if (!ctx || !ambGain) return;
  const base = Math.max(34, 55 - depth * 0.6);
  for (let i = 0; i < ambOsc.length; i++) ambOsc[i].frequency.setTargetAtTime(base + i * 0.45, ctx.currentTime, 0.5);
  ambGain.gain.setTargetAtTime(on ? 0.05 : 0, ctx.currentTime, 0.6);
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

/** 短い合成効果音。ミュート中・未初期化なら無音。 */
export function sfx(kind: Sfx): void {
  if (!ctx || muted) return;
  switch (kind) {
    case "move": tone(150, 0.045, "triangle", 0.03); break;
    case "hit": noise(0.08, 0.10, 1300); tone(200, 0.09, "square", 0.05, 110); break;
    case "hurt": tone(180, 0.18, "sawtooth", 0.10, 80); break;
    case "open": tone(420, 0.12, "sine", 0.05); break;
    case "chest": tone(523, 0.12, "sine", 0.06); setTimeout(() => tone(784, 0.16, "sine", 0.05), 90); break;
    case "stairs": tone(300, 0.22, "sine", 0.06, 150); break;
    case "death": tone(120, 0.8, "sine", 0.10, 55); break;
    case "intervene": tone(660, 0.4, "sine", 0.06); break;
  }
}

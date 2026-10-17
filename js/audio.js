/**
 * motion-wave-dj · 音频引擎（任务 2 / Taylor）
 * ============================================================
 * 纯 Web Audio 程序化合成，零外部素材。
 *
 * 信号链：  [乐器 voice] → master GainNode(0.5) → DynamicsCompressor(轻压缩防爆音) → destination
 *
 * 音序器采用 "A Tale of Two Clocks" lookahead 调度模式：
 *   - setInterval(25ms) 仅做检查器，不发声；
 *   - 提前 0.1s 按 audioContext.currentTime 精确排程音符；
 *   - 严禁在 rAF 里现算现响（rAF 抖动会毁掉节奏）。
 *
 * 对外契约（game.js 按此调用）：
 *   new AudioEngine()          构造时不创建 AudioContext
 *   init()                     惰性创建 AudioContext + master GainNode + 轻压缩
 *   resume()                   必须在用户手势回调内调用
 *   setVolume(v)               0..1
 *   playKick / playSnare / playHat / playBass / playPiano / playGuitar
 *   playChord / playCymbal     t 一律为 ctx.currentTime 体系的绝对时间
 *   startTrack(style, bpm, {onBeat})   启动程序生成背景曲，返回 {style,bpm}
 *   stopTrack() / getUserTrackInfo() / loadUserFile(file)
 *   noteToFreq('A4')           音名 → 频率，供创作模式映射音阶
 *
 * 二期扩展（Taylor）——新音色（t 一律为 ctx.currentTime 体系绝对时间）：
 *   play808(t, pitch=1)        808 风格长滑 Kick（sine 180→40Hz + tanh 软削波）
 *   playClap(t)                电鼓 Clap（3 连 10ms 噪声脉冲 + bandpass 1200Hz）
 *   playSupersaw(freq,t,dur)   EDM 主音（7 osc ±25 cents 扇形 saw + lowpass + ADSR）
 *   playBell(freq,t,dur)       FM 铃音（频比 3.5 + index 包络）
 *   playPluck(freq,t,dur)      短促弹拨（saw + 快 lowpass 包络）
 *   playRiser(t,dur=2)         上扬过渡（噪声扫频 + 双 saw 上滑 + 渐强）
 *   playImpact(t)              重锤下行（sub 80→30Hz + 噪声爆发 + 卷积混响尾）
 *   playVocalChop(freq,t,dur)  人声切片（双 detune saw → 双 formant bandpass）
 *   startSong(song,{onBeat,onNote})  播放 js/tracks.js 曲库整曲，曲尾自动停止；
 *                                    onNote 提前 ≥2s 通知（下落音符飞行窗口），
 *                                    onBeat 提前 0.5s 通知；发声仍 0.1s 精确排程
 *   getUserTrackInfo() 增补 songId / songName 字段
 */

/* ============================ 音名工具 ============================ */

const NOTE_SEMITONES = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

/**
 * 音名 → 频率(Hz)。
 * 支持 'A4' / 'C3' / 'F#4' / 'Bb2'（含 ♯♭ 记号）；传入数字则视为频率原样返回。
 * 解析失败时回退 440Hz（A4）。
 */
export function noteToFreq(note) {
  if (typeof note === 'number' && isFinite(note)) return note;
  const m = /^([A-Ga-g])([#b♯♭]?)(-?\d+)$/.exec(String(note).trim());
  if (!m) return 440;
  let semi = NOTE_SEMITONES[m[1].toUpperCase()];
  if (m[2] === '#' || m[2] === '♯') semi += 1;
  if (m[2] === 'b' || m[2] === '♭') semi -= 1;
  const midi = (parseInt(m[3], 10) + 1) * 12 + semi;
  return 440 * Math.pow(2, (midi - 69) / 12);
}

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/** 和弦质缀 → 半音结构表（parseChord 用） */
const CHORD_SHAPES = [
  ['maj', [0, 4, 7]], ['m', [0, 3, 7]], ['7', [0, 4, 7, 10]],
  ['maj7', [0, 4, 7, 11]], ['m7', [0, 3, 7, 10]], ['dim', [0, 3, 6]],
  ['aug', [0, 4, 8]], ['sus4', [0, 5, 7]], ['sus2', [0, 2, 7]],
  ['add9', [0, 4, 7, 14]], ['m7b5', [0, 3, 6, 10]], ['6', [0, 4, 7, 9]],
];

/**
 * 和弦名 → 频率数组（铺底用）。
 * 支持 'C' / 'Am' / 'F#m7' / 'Bb' 等写法，未知质缀按大三和弦处理；解析失败返回 []。
 * 铺底音区固定从 C3(midi 48) 起堆叠，避免与 lead 打架。
 */
export function parseChord(name) {
  const m = /^([A-Ga-g])([#b♯♭]?)(.*)$/.exec(String(name).trim());
  if (!m) return [];
  let semi = NOTE_SEMITONES[m[1].toUpperCase()];
  if (m[2] === '#' || m[2] === '♯') semi += 1;
  if (m[2] === 'b' || m[2] === '♭') semi -= 1;
  const shape = CHORD_SHAPES.find((s) => s[0] === m[3]) || CHORD_SHAPES[0];
  const rootMidi = 48 + semi;
  return shape[1].map((iv) => 440 * Math.pow(2, (rootMidi + iv - 69) / 12));
}

/** 和声走向（相对 A2 的半音偏移）：Am → F → C → G，每小节切换，避免背景曲单调 */
const CHORD_PROG = [0, -4, 3, -2];
const ROOT_A2 = 110; // A2 = 110Hz，bass 根音基准

/* ============================ 音频引擎 ============================ */

export class AudioEngine {
  constructor() {
    this.ctx = null;          // 惰性创建：构造函数绝不 new AudioContext
    this.master = null;       // 总音量
    this.compressor = null;   // 轻压缩防爆音
    this._volume = 0.5;
    this._noiseBuffer = null; // 白噪声 buffer，init 时预生成一次
    this._active = new Set(); // 已排程的发声源（stopTrack 时安全停止）

    // 音序器状态
    this._track = {
      running: false,
      mode: 'synth',          // 'synth' 程序生成 | 'file' 用户本地音频循环
      style: null,
      bpm: 120,
      stepDur: 0.125,         // 一个 16 分音符时长(秒)
      step: 0,                // 小节内 16 分步进 0..15
      beatIndex: 0,           // 全局拍计数（跨小节连续递增）
      barIndex: 0,
      nextStepTime: 0,
      timer: null,
      onBeat: null,
      userBuffer: null,       // loadUserFile 解码结果
      userSource: null,       // 循环播放中的用户音频源
      // song 模式（startSong）专用状态
      song: null,             // 当前曲库曲目（js/tracks.js 数据）
      onNote: null,           // lead 音符调度回调
      totalBars: 0,           // 曲目总小节数
      leadIndex: null,        // Map<bar, Note[]> 按 bar 预索引的旋律事件（发声用）
      fxIndex: null,          // Map<bar, Fx[]>   按 bar 预索引的特效事件
      // 通知/发声解耦：独立通知游标（onNote 提前 2.5s、onBeat 提前 0.5s）
      noteQueue: null,        // 全曲 lead 通知队列（audioTime 升序，与发声时刻同源）
      notePtr: 0,             // onNote 通知游标（单调前进，每音符只通知一次）
      beatQueue: null,        // 全曲拍点通知队列
      beatPtr: 0,             // onBeat 通知游标
      SCHEDULE_AHEAD: 0.1,    // 提前排程量 100ms
      SCHEDULE_TICK: 25,      // 检查器周期 25ms
    };
    this._satCurve = null;    // tanh 软削波曲线（play808 用），init 时生成
    this._impulse = null;     // 程序生成混响 IR（playImpact 用），惰性生成
  }

  /* ------------------------ 生命周期 ------------------------ */

  /** 惰性创建 AudioContext + master GainNode(0.5) + 轻压缩 DynamicsCompressor */
  init() {
    if (this.ctx) return this.ctx;
    const AC =
      (typeof window !== 'undefined') &&
      (window.AudioContext || window.webkitAudioContext);
    if (!AC) throw new Error('当前环境不支持 Web Audio API');
    this.ctx = new AC();

    // master 音量 → 轻压缩 → 输出（压缩在 master 之后，整条总线防爆音）
    this.master = this.ctx.createGain();
    this.master.gain.value = this._volume;
    this.compressor = this.ctx.createDynamicsCompressor();
    this.compressor.threshold.value = -14; // 轻压缩：只兜底峰值
    this.compressor.knee.value = 24;
    this.compressor.ratio.value = 5;
    this.compressor.attack.value = 0.003;
    this.compressor.release.value = 0.25;
    this.master.connect(this.compressor);
    this.compressor.connect(this.ctx.destination);

    // 预生成 2s 白噪声（snare/hat/cymbal/guitar 激励共用，满足 cymbal 1.2s 衰减）
    this._noiseBuffer = this._makeNoiseBuffer(2);
    this._satCurve = this._makeSatCurve();
    return this.ctx;
  }

  /** 必须在用户手势回调（点击/按键）内调用，恢复被浏览器自动挂起的 ctx */
  async resume() {
    if (!this.ctx) this.init();
    if (this.ctx.state === 'suspended') {
      try {
        await this.ctx.resume();
      } catch (e) {
        /* 保持静默：调用方负责保证手势语境 */
      }
    }
    return this.ctx.state;
  }

  setVolume(v) {
    this._volume = clamp(Number(v) || 0, 0, 1);
    if (this.master && this.ctx) {
      this.master.gain.setTargetAtTime(this._volume, this.ctx.currentTime, 0.02);
    }
  }

  /* ------------------------ 通用小工具 ------------------------ */

  /** 未 init 时所有 play* 静默忽略（不自动创建 AudioContext） */
  _ready() {
    return !!this.ctx;
  }

  /** 把调度时间规整到不早于当前时刻（排到过去的音符立即响，避免负延迟报错） */
  _t(t) {
    return Math.max(Number(t) || 0, this.ctx.currentTime);
  }

  /** tanh 软削波曲线：轻微 saturation，让 808 低频更「糊脸」不刺耳 */
  _makeSatCurve() {
    const n = 1024;
    const curve = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const x = (i / (n - 1)) * 2 - 1;
      curve[i] = Math.tanh(2.2 * x);
    }
    return curve;
  }

  /** 程序生成混响脉冲响应（立体声指数衰减白噪声），playImpact 尾音用 */
  _makeImpulse(seconds = 1.8, decay = 3.2) {
    const rate = this.ctx.sampleRate;
    const len = Math.max(1, Math.floor(rate * seconds));
    const buf = this.ctx.createBuffer(2, len, rate);
    for (let ch = 0; ch < 2; ch++) {
      const d = buf.getChannelData(ch);
      for (let i = 0; i < len; i++) {
        d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, decay);
      }
    }
    return buf;
  }

  _makeNoiseBuffer(seconds) {
    const len = Math.max(1, Math.floor(this.ctx.sampleRate * seconds));
    const buf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
    return buf;
  }

  /**
   * 注册发声源：onended 后从活跃表移除并断开整条节点链（防泄漏）。
   * stopTrack 时对未发声/发声中的源统一 stop。
   */
  _own(sources, nodes) {
    const cleanup = () => {
      sources.forEach((s) => this._active.delete(s));
      nodes.forEach((n) => {
        try { n.disconnect(); } catch (e) { /* 幂等断开 */ }
      });
    };
    sources.forEach((s) => {
      this._active.add(s);
      s.onended = cleanup;
    });
  }

  /** 连线 source → chain... → master，并交给 _own 托管 */
  _pipe(source, ...chain) {
    let prev = source;
    for (const n of chain) {
      prev.connect(n);
      prev = n;
    }
    prev.connect(this.master);
    this._own([source], [source, ...chain]);
  }

  /**
   * 通用 ADSR 包络（指数曲线，听感自然）。
   * sustain 为峰值比例；返回包络总时长 relEnd，供 osc.stop 使用。
   */
  _adsr(param, t, dur, { peak, attack, decay, sustain, release }) {
    const sustainLevel = peak * sustain;
    const relStart = Math.max(attack + decay, dur * 0.6);
    const relEnd = Math.max(relStart + release * 0.5, dur);
    param.setValueAtTime(0.0001, t);
    param.exponentialRampToValueAtTime(peak, t + attack);
    param.exponentialRampToValueAtTime(sustainLevel, t + attack + decay);
    param.setValueAtTime(sustainLevel, t + relStart);
    param.exponentialRampToValueAtTime(0.0001, t + relEnd);
    return relEnd;
  }

  /* ------------------------ 打击乐组 ------------------------ */

  /** Kick：sine 150→50Hz 下滑 + ~0.25s 指数衰减 */
  playKick(t) {
    if (!this._ready()) return;
    t = this._t(t);
    const osc = this.ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(150, t);
    osc.frequency.exponentialRampToValueAtTime(50, t + 0.12);
    const gain = this.ctx.createGain();
    gain.gain.setValueAtTime(1.0, t);
    gain.gain.exponentialRampToValueAtTime(0.001, t + 0.25);
    this._pipe(osc, gain);
    osc.start(t);
    osc.stop(t + 0.28);
  }

  /** Snare：白噪声 highpass 1800Hz + triangle ~180Hz 体腔短衰减 */
  playSnare(t) {
    if (!this._ready()) return;
    t = this._t(t);
    // 噪声层
    const noise = this.ctx.createBufferSource();
    noise.buffer = this._noiseBuffer;
    const hp = this.ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 1800;
    const nGain = this.ctx.createGain();
    nGain.gain.setValueAtTime(0.7, t);
    nGain.gain.exponentialRampToValueAtTime(0.001, t + 0.18);
    this._pipe(noise, hp, nGain);
    noise.start(t);
    noise.stop(t + 0.2);
    // 体腔层（triangle 下滑增加厚度）
    const osc = this.ctx.createOscillator();
    osc.type = 'triangle';
    osc.frequency.setValueAtTime(185, t);
    osc.frequency.exponentialRampToValueAtTime(120, t + 0.1);
    const oGain = this.ctx.createGain();
    oGain.gain.setValueAtTime(0.45, t);
    oGain.gain.exponentialRampToValueAtTime(0.001, t + 0.12);
    this._pipe(osc, oGain);
    osc.start(t);
    osc.stop(t + 0.14);
  }

  /** Hi-hat：噪声 highpass 7000Hz；closed ~0.05s / open ~0.3s */
  playHat(t, open = false) {
    if (!this._ready()) return;
    t = this._t(t);
    const dur = open ? 0.3 : 0.05;
    const noise = this.ctx.createBufferSource();
    noise.buffer = this._noiseBuffer;
    const hp = this.ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 7000;
    const gain = this.ctx.createGain();
    gain.gain.setValueAtTime(open ? 0.35 : 0.28, t);
    gain.gain.exponentialRampToValueAtTime(0.001, t + dur);
    this._pipe(noise, hp, gain);
    noise.start(t);
    noise.stop(t + dur + 0.02);
  }

  /** Cymbal：open hat 变体，highpass 6000Hz 长衰减 ~1.2s，叠 bandpass 金属感 */
  playCymbal(t) {
    if (!this._ready()) return;
    t = this._t(t);
    // 主体：噪声 highpass 6000
    const noise = this.ctx.createBufferSource();
    noise.buffer = this._noiseBuffer;
    const hp = this.ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 6000;
    const gain = this.ctx.createGain();
    gain.gain.setValueAtTime(0.45, t);
    gain.gain.exponentialRampToValueAtTime(0.001, t + 1.2);
    this._pipe(noise, hp, gain);
    noise.start(t);
    noise.stop(t + 1.25);
    // 点缀：bandpass 9kHz 短一层，增加"金属碎响"质感
    const noise2 = this.ctx.createBufferSource();
    noise2.buffer = this._noiseBuffer;
    const bp = this.ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 9000;
    bp.Q.value = 0.8;
    const g2 = this.ctx.createGain();
    g2.gain.setValueAtTime(0.2, t);
    g2.gain.exponentialRampToValueAtTime(0.001, t + 0.9);
    this._pipe(noise2, bp, g2);
    noise2.start(t);
    noise2.stop(t + 0.95);
  }

  /* ------------------------ 音高乐器组 ------------------------ */

  /** Bass：sawtooth + lowpass cutoff 包络 800→120Hz + ADSR */
  playBass(freq, t, dur = 0.25) {
    if (!this._ready()) return;
    t = this._t(t);
    dur = clamp(Number(dur) || 0.25, 0.05, 2);
    const osc = this.ctx.createOscillator();
    osc.type = 'sawtooth';
    osc.frequency.value = Math.max(20, Number(freq) || 55);
    const lp = this.ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.Q.value = 8; // 适度共鸣，音头更"咬合"
    lp.frequency.setValueAtTime(800, t);
    lp.frequency.exponentialRampToValueAtTime(120, t + Math.max(0.03, Math.min(dur * 0.8, 0.3)));
    const gain = this.ctx.createGain();
    const relEnd = this._adsr(gain.gain, t, dur, {
      peak: 0.65, attack: 0.01, decay: 0.08, sustain: 0.7, release: 0.1,
    });
    this._pipe(osc, lp, gain);
    osc.start(t);
    osc.stop(t + relEnd + 0.05);
  }

  /** Piano 内部发声体（playChord 复用，level 分摊多音音量防糊） */
  _playPianoVoice(freq, t, dur, level) {
    const ctx = this.ctx;
    freq = clamp(Number(freq) || 440, 30, 8000);
    const gain = ctx.createGain();
    const relEnd = this._adsr(gain.gain, t, dur, {
      peak: level, attack: 0.01, decay: 0.12, sustain: 0.3, release: 0.3,
    });
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = Math.min(freq * 6, 9000); // 柔化高次谐波
    lp.Q.value = 0.7;
    // 2 个 detune 振荡器 + 1 个高八度泛音点缀
    const specs = [
      { type: 'triangle', f: freq, detune: -5, g: 0.55 },
      { type: 'sawtooth', f: freq, detune: 5, g: 0.3 },
      { type: 'triangle', f: freq * 2, detune: 0, g: 0.18 },
    ];
    const oscs = [];
    const nodes = [gain, lp];
    for (const s of specs) {
      const o = ctx.createOscillator();
      o.type = s.type;
      o.frequency.value = s.f;
      o.detune.value = s.detune;
      const og = ctx.createGain();
      og.gain.value = s.g;
      o.connect(og);
      og.connect(lp);
      oscs.push(o);
      nodes.push(o, og);
    }
    lp.connect(gain);
    gain.connect(this.master);
    this._own(oscs, nodes);
    for (const o of oscs) {
      o.start(t);
      o.stop(t + relEnd + 0.05);
    }
  }

  /** Piano：2-3 个 detune triangle/saw + ADSR(0.01/0.12/0.3/0.3) + lowpass 柔化 */
  playPiano(freq, t, dur = 0.5) {
    if (!this._ready()) return;
    t = this._t(t);
    dur = clamp(Number(dur) || 0.5, 0.05, 4);
    this._playPianoVoice(freq, t, dur, 0.5);
  }

  /** Chord：多音同时（复用 piano voice，逐音分摊音量） */
  playChord(freqs, t, dur = 1.0) {
    if (!this._ready() || !Array.isArray(freqs) || freqs.length === 0) return;
    t = this._t(t);
    dur = clamp(Number(dur) || 1.0, 0.05, 4);
    const level = clamp(1.6 / freqs.length, 0.25, 0.5);
    for (const f of freqs) this._playPianoVoice(f, t, dur, level);
  }

  /**
   * Guitar：Karplus-Strong 物理建模。
   * 短噪声激励 → DelayNode(1/freq) ← 低通阻尼 ← 反馈 gain 0.96（闭环）。
   * 环无 source 可挂 onended，用输出包络 2s 兜底衰减 + 定时断开防泄漏。
   */
  playGuitar(freq, t) {
    if (!this._ready()) return;
    t = this._t(t);
    freq = clamp(Number(freq) || 220, 40, 2000);
    const ctx = this.ctx;
    const period = 1 / freq;

    // 激励：约一个周期的噪声突发
    const exciter = ctx.createBufferSource();
    exciter.buffer = this._noiseBuffer;
    const burst = ctx.createGain();
    burst.gain.setValueAtTime(0.9, t);
    burst.gain.setValueAtTime(0.0, t + Math.max(period, 0.002));

    // 反馈环
    const delay = ctx.createDelay(1.0);
    delay.delayTime.value = period;
    const damp = ctx.createBiquadFilter(); // 环内低通 = 高频逐步衰减，模拟琴弦阻尼
    damp.type = 'lowpass';
    damp.frequency.value = clamp(freq * 9, 800, 6500);
    const feedback = ctx.createGain();
    feedback.gain.value = 0.96;

    const out = ctx.createGain();
    out.gain.setValueAtTime(0.8, t);
    out.gain.setValueAtTime(0.8, t + 1.2);
    out.gain.exponentialRampToValueAtTime(0.0001, t + 2.0); // 兜底，环永不炸

    exciter.connect(burst);
    burst.connect(delay);
    delay.connect(damp);
    damp.connect(feedback);
    feedback.connect(delay);
    delay.connect(out);
    out.connect(this.master);

    exciter.start(t);
    exciter.stop(t + Math.max(period, 0.002) + 0.005);
    this._active.add(exciter);
    exciter.onended = () => this._active.delete(exciter);

    // 反馈环不会自然结束：2.1s 后（out 已归零）定时断开全部环节点
    const ms = Math.max(0, (t - ctx.currentTime + 2.1) * 1000);
    setTimeout(() => {
      [burst, delay, damp, feedback, out].forEach((n) => {
        try { n.disconnect(); } catch (e) { /* 幂等 */ }
      });
    }, ms);
  }

  /* ------------------------ 二期扩展音色组 ------------------------ */

  /**
   * 808 风格长滑 Kick：sine 从 pitch*180Hz 快滑到 pitch*40Hz，
   * 衰减 ~0.5s，经 tanh WaveShaper 软削波增加厚度。pitch 缩放整体音高。
   */
  play808(t, pitch = 1) {
    if (!this._ready()) return;
    t = this._t(t);
    pitch = clamp(Number(pitch) || 1, 0.25, 4);
    const osc = this.ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(180 * pitch, t);
    osc.frequency.exponentialRampToValueAtTime(40 * pitch, t + 0.09);
    const shaper = this.ctx.createWaveShaper();
    if (!this._satCurve) this._satCurve = this._makeSatCurve();
    shaper.curve = this._satCurve;
    const gain = this.ctx.createGain();
    gain.gain.setValueAtTime(1.0, t);
    gain.gain.exponentialRampToValueAtTime(0.001, t + 0.5);
    this._pipe(osc, shaper, gain);
    osc.start(t);
    osc.stop(t + 0.55);
  }

  /**
   * 电鼓 Clap：同一噪声源经 bandpass(~1200Hz)，包络做 3 个 10ms 间隔
   * 预脉冲 + 1 个主衰减，模拟多手掌错位拍击。
   */
  playClap(t) {
    if (!this._ready()) return;
    t = this._t(t);
    const noise = this.ctx.createBufferSource();
    noise.buffer = this._noiseBuffer;
    const bp = this.ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 1200;
    bp.Q.value = 1.1;
    const gain = this.ctx.createGain();
    const g = gain.gain;
    g.setValueAtTime(0.0001, t);
    g.setValueAtTime(0.75, t);
    g.exponentialRampToValueAtTime(0.18, t + 0.009);
    g.setValueAtTime(0.75, t + 0.01);
    g.exponentialRampToValueAtTime(0.18, t + 0.019);
    g.setValueAtTime(0.75, t + 0.02);
    g.exponentialRampToValueAtTime(0.2, t + 0.029);
    g.setValueAtTime(0.85, t + 0.03);
    g.exponentialRampToValueAtTime(0.001, t + 0.24);
    this._pipe(noise, bp, gain);
    noise.start(t);
    noise.stop(t + 0.27);
  }

  /**
   * Supersaw：7 个 sawtooth 以 ±25 cents 扇形展开（0 居中，两侧等比对称），
   * 汇入 lowpass 后由 ADSR 控制总包络。EDM 主音色。
   */
  playSupersaw(freq, t, dur = 0.5) {
    if (!this._ready()) return;
    t = this._t(t);
    freq = clamp(Number(freq) || 440, 40, 6000);
    dur = clamp(Number(dur) || 0.5, 0.05, 4);
    const ctx = this.ctx;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = clamp(freq * 5, 900, 9500);
    lp.Q.value = 0.8;
    const gain = ctx.createGain();
    const relEnd = this._adsr(gain.gain, t, dur, {
      peak: 0.34, attack: 0.012, decay: 0.09, sustain: 0.72, release: 0.14,
    });
    const DETUNES = [-25, -16.7, -8.3, 0, 8.3, 16.7, 25];
    const oscs = [];
    const nodes = [lp, gain];
    for (const d of DETUNES) {
      const o = ctx.createOscillator();
      o.type = 'sawtooth';
      o.frequency.value = freq;
      o.detune.value = d;
      const og = ctx.createGain();
      og.gain.value = 0.12;
      o.connect(og);
      og.connect(lp);
      oscs.push(o);
      nodes.push(o, og);
    }
    lp.connect(gain);
    gain.connect(this.master);
    this._own(oscs, nodes);
    for (const o of oscs) {
      o.start(t);
      o.stop(t + relEnd + 0.05);
    }
  }

  /**
   * FM 铃音：carrier(sine) 被 modulator(sine, 频比 3.5) 调频，
   * modulation index 随时间指数衰减（亮→净），清脆梦幻。
   */
  playBell(freq, t, dur = 0.9) {
    if (!this._ready()) return;
    t = this._t(t);
    freq = clamp(Number(freq) || 880, 100, 8000);
    dur = clamp(Number(dur) || 0.9, 0.1, 3);
    const ctx = this.ctx;
    const carrier = ctx.createOscillator();
    carrier.type = 'sine';
    carrier.frequency.value = freq;
    const mod = ctx.createOscillator();
    mod.type = 'sine';
    mod.frequency.value = freq * 3.5;
    const modGain = ctx.createGain();
    modGain.gain.setValueAtTime(freq * 2.4, t);
    modGain.gain.exponentialRampToValueAtTime(freq * 0.05, t + Math.max(0.08, dur * 0.75));
    const gain = ctx.createGain();
    const relEnd = this._adsr(gain.gain, t, dur, {
      peak: 0.42, attack: 0.004, decay: Math.max(0.12, dur * 0.55), sustain: 0.12, release: 0.35,
    });
    mod.connect(modGain);
    modGain.connect(carrier.frequency);
    this._pipe(carrier, gain);
    this._own([mod], [mod, modGain]);
    mod.start(t);
    mod.stop(t + relEnd + 0.05);
    carrier.start(t);
    carrier.stop(t + relEnd + 0.05);
  }

  /**
   * Pluck：saw + lowpass 包络（cutoff 从 freq*9 快落到 freq*1.2）+
   * 快衰减增益包络，短促弹拨，适合琶音 / Chiptune 近似方波主音。
   */
  playPluck(freq, t, dur = 0.25) {
    if (!this._ready()) return;
    t = this._t(t);
    freq = clamp(Number(freq) || 440, 40, 8000);
    dur = clamp(Number(dur) || 0.25, 0.05, 1.5);
    const osc = this.ctx.createOscillator();
    osc.type = 'sawtooth';
    osc.frequency.value = freq;
    const lp = this.ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.Q.value = 4;
    lp.frequency.setValueAtTime(clamp(freq * 9, 700, 12000), t);
    lp.frequency.exponentialRampToValueAtTime(Math.max(freq * 1.2, 180), t + Math.max(0.05, dur * 0.7));
    const gain = this.ctx.createGain();
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(0.5, t + 0.004);
    gain.gain.exponentialRampToValueAtTime(0.001, t + Math.max(0.1, dur));
    this._pipe(osc, lp, gain);
    osc.start(t);
    osc.stop(t + Math.max(0.1, dur) + 0.06);
  }

  /**
   * Riser：噪声 bandpass 扫频(300→6500Hz) + 双 detune saw 上滑(110→880Hz)，
   * 双层同时渐强，用于乐段过渡，结尾交由 impact 收爆。
   */
  playRiser(t, dur = 2) {
    if (!this._ready()) return;
    t = this._t(t);
    dur = clamp(Number(dur) || 2, 0.5, 4);
    const ctx = this.ctx;
    const end = t + dur;
    // 噪声层
    const noise = ctx.createBufferSource();
    noise.buffer = this._noiseBuffer;
    noise.loop = true; // dur 可达 4s，超出 2s buffer 需循环
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.Q.value = 1.4;
    bp.frequency.setValueAtTime(300, t);
    bp.frequency.exponentialRampToValueAtTime(6500, end);
    const nGain = ctx.createGain();
    nGain.gain.setValueAtTime(0.05, t);
    nGain.gain.exponentialRampToValueAtTime(0.3, end);
    this._pipe(noise, bp, nGain);
    noise.start(t);
    noise.stop(end + 0.05);
    // 锯齿层
    const sGain = ctx.createGain();
    sGain.gain.setValueAtTime(0.04, t);
    sGain.gain.exponentialRampToValueAtTime(0.16, end);
    const oscs = [];
    const nodes = [sGain];
    for (const d of [-9, 9]) {
      const o = ctx.createOscillator();
      o.type = 'sawtooth';
      o.frequency.setValueAtTime(110, t);
      o.frequency.exponentialRampToValueAtTime(880, end);
      o.detune.value = d;
      const og = ctx.createGain();
      og.gain.value = 0.5;
      o.connect(og);
      og.connect(sGain);
      oscs.push(o);
      nodes.push(o, og);
    }
    sGain.connect(this.master);
    this._own(oscs, nodes);
    for (const o of oscs) {
      o.start(t);
      o.stop(end + 0.05);
    }
  }

  /**
   * Impact：重锤下行三层叠加 ——
   * 1) sub sine 80→30Hz 长衰减；2) 噪声 lowpass 爆发（2400→220Hz）；
   * 3) 噪声经程序生成卷积混响的 1.9s 衰减尾音。用于段落起点。
   */
  playImpact(t) {
    if (!this._ready()) return;
    t = this._t(t);
    const ctx = this.ctx;
    // sub 下行
    const sub = ctx.createOscillator();
    sub.type = 'sine';
    sub.frequency.setValueAtTime(80, t);
    sub.frequency.exponentialRampToValueAtTime(30, t + 0.45);
    const subG = ctx.createGain();
    subG.gain.setValueAtTime(0.9, t);
    subG.gain.exponentialRampToValueAtTime(0.001, t + 1.3);
    this._pipe(sub, subG);
    sub.start(t);
    sub.stop(t + 1.35);
    // 噪声爆点
    const noise = ctx.createBufferSource();
    noise.buffer = this._noiseBuffer;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.setValueAtTime(2400, t);
    lp.frequency.exponentialRampToValueAtTime(220, t + 0.5);
    const nG = ctx.createGain();
    nG.gain.setValueAtTime(0.7, t);
    nG.gain.exponentialRampToValueAtTime(0.001, t + 0.55);
    this._pipe(noise, lp, nG);
    noise.start(t);
    noise.stop(t + 0.6);
    // 混响尾
    if (!this._impulse) this._impulse = this._makeImpulse();
    const tail = ctx.createBufferSource();
    tail.buffer = this._noiseBuffer;
    tail.loop = true;
    const tailG = ctx.createGain();
    tailG.gain.setValueAtTime(0.25, t);
    tailG.gain.exponentialRampToValueAtTime(0.001, t + 1.9);
    const verb = ctx.createConvolver();
    verb.buffer = this._impulse;
    const vlp = ctx.createBiquadFilter();
    vlp.type = 'lowpass';
    vlp.frequency.value = 1500;
    this._pipe(tail, tailG, verb, vlp);
    tail.start(t);
    tail.stop(t + 2.0);
  }

  /**
   * Vocal Chop：双 detune(±8 cents) saw 并联进两个 formant bandpass
   * (~800Hz / ~1200Hz) 模拟元音共振峰，短包络，有趣的「人声切片」感。
   */
  playVocalChop(freq, t, dur = 0.3) {
    if (!this._ready()) return;
    t = this._t(t);
    freq = clamp(Number(freq) || 440, 80, 3000);
    dur = clamp(Number(dur) || 0.3, 0.05, 1);
    const ctx = this.ctx;
    const sum = ctx.createGain();
    sum.gain.value = 1;
    const FORMANTS = [
      { f: 800, q: 6, g: 0.6 },
      { f: 1200, q: 6, g: 0.45 },
    ];
    const oscs = [];
    const nodes = [sum];
    for (const d of [-8, 8]) {
      const o = ctx.createOscillator();
      o.type = 'sawtooth';
      o.frequency.value = freq;
      o.detune.value = d;
      oscs.push(o);
    }
    for (const fm of FORMANTS) {
      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.value = fm.f;
      bp.Q.value = fm.q;
      const bg = ctx.createGain();
      bg.gain.value = fm.g;
      nodes.push(bp, bg);
      for (const o of oscs) o.connect(bp);
      bp.connect(bg);
      bg.connect(sum);
    }
    const gain = ctx.createGain();
    const relEnd = this._adsr(gain.gain, t, dur, {
      peak: 0.55, attack: 0.012, decay: 0.06, sustain: 0.55, release: 0.09,
    });
    sum.connect(gain);
    gain.connect(this.master);
    this._own(oscs, [...nodes, ...oscs, gain]);
    for (const o of oscs) {
      o.start(t);
      o.stop(t + relEnd + 0.05);
    }
  }

  /* ------------------------ 音序器（A Tale of Two Clocks） ------------------------ */

  /**
   * 启动程序生成背景曲。
   * @param {string} style  'house' | 'edm' | 'funk'
   * @param {number} bpm    90..140，默认 120
   * @param {{onBeat?:Function}} opts  onBeat(beatIndex, barIndex, scheduledAudioTime)
   *        —— 每拍回调一次，audioTime 为该拍精确的 AudioContext 时刻，
   *           视觉层拿它与 ctx.currentTime 比较即可在到点瞬间打拍。
   * @returns {{style:string, bpm:number}} 当前曲目信息
   */
  startTrack(style = 'house', bpm = 120, opts = {}) {
    if (!this.ctx) this.init();
    this.stopTrack(); // 防重复启动叠加
    const track = this._track;

    track.style = typeof style === 'string' ? style : 'house';
    track.bpm = clamp(Math.round(Number(bpm) || 120), 90, 140);
    track.stepDur = Math.max((60 / track.bpm) / 4, 0.05); // 防御：stepDur 恒 > 0
    track.step = 0;
    track.beatIndex = 0;
    track.barIndex = 0;
    track.onBeat = typeof (opts && opts.onBeat) === 'function' ? opts.onBeat : null;
    track.mode = track.userBuffer ? 'file' : 'synth';

    // 用户文件模式：AudioBufferSourceNode 循环播放，onBeat 仍按 bpm 估算发出
    if (track.mode === 'file') {
      const src = this.ctx.createBufferSource();
      src.buffer = track.userBuffer;
      src.loop = true;
      src.connect(this.master);
      src.start(this.ctx.currentTime + 0.05);
      track.userSource = src;
    }

    track.nextStepTime = this.ctx.currentTime + 0.06; // 起播留一点缓冲
    track.running = true;
    track.timer = setInterval(() => this._scheduler(), track.SCHEDULE_TICK);
    this._scheduler(); // 立即调度第一小批
    return { style: track.style, bpm: track.bpm };
  }

  /**
   * 播放 js/tracks.js 曲库整曲（startTrack 互斥，启动前先停另一个）。
   * 沿用同一套 lookahead 调度器：drum pattern 每 16 步循环，
   * bass 按小节（或 4 小节变体）循环，lead/fx 按 bar 预索引后逐 step 命中；
   * 调度到 lengthBeats 曲尾自动停止（已排程尾音自然衰减，不硬切）。
   *
   * 通知与发声解耦：发声仍走 0.1s lookahead 精确排程；onNote/onBeat 走独立
   * 通知游标（notePtr/beatPtr），每次调度 tick 把 audioTime ≤ now+2.5s 的 lead
   * 事件依次触发 onNote（下落音符有 ≥2s 飞行窗口）、audioTime ≤ now+0.5s 的
   * 拍点触发 onBeat；指针单调前进，每事件只通知一次；曲尾自然停止前通知已全部
   * 发完；stopTrack/_finishSong 清理游标，重开不重复通知。
   *
   * @param {object} song  曲库曲目（见 js/tracks.js 契约）
   * @param {{onBeat?:Function, onNote?:Function}} opts
   *        onBeat(beatIndex, barIndex, audioTime)  每拍回调，提前 ~0.5s；
   *        onNote({audioTime, lane, freq, dur, wave}) lead 通知，提前 ≥2s
   *        （audioTime 为精确 AudioContext 时刻 = 发声时刻，供 game.js 生成下落音符）。
   * @returns {{running,style,bpm,songId,songName}}
   */
  startSong(song, opts = {}) {
    if (!this.ctx) this.init();
    if (!song || !Array.isArray(song.lead)) {
      throw new Error('startSong: 无效的曲目数据（缺少 lead 数组）');
    }
    this.stopTrack(); // 与 startTrack 互斥
    const track = this._track;

    track.mode = 'song';
    track.song = song;
    track.style = String(song.style || 'song');
    track.bpm = clamp(Math.round(Number(song.bpm) || 120), 50, 200);
    track.stepDur = Math.max((60 / track.bpm) / 4, 0.05);
    track.totalBars = Math.max(1, Math.ceil((Number(song.lengthBeats) || 64) / 4));
    track.step = 0;
    track.beatIndex = 0;
    track.barIndex = 0;
    track.onBeat = typeof (opts && opts.onBeat) === 'function' ? opts.onBeat : null;
    track.onNote = typeof (opts && opts.onNote) === 'function' ? opts.onNote : null;
    track.leadIndex = this._indexBy(song.lead, 'bar');
    track.fxIndex = this._indexBy(song.fx || [], 'bar');

    track.nextStepTime = this.ctx.currentTime + 0.06;
    // 通知队列与发声时间轴同源：audioTime = startAudio + stepIdx * stepDur，
    // 保证 onNote.audioTime 与发声 audioTime 完全一致（game.js 的 hitTime 依据）
    const startAudio = track.nextStepTime;
    track.noteQueue = this._buildNoteQueue(song, startAudio, track.totalBars, track.stepDur);
    track.beatQueue = this._buildBeatQueue(track.totalBars, startAudio, track.stepDur);
    track.notePtr = 0;
    track.beatPtr = 0;
    track.running = true;
    track.timer = setInterval(() => this._scheduler(), track.SCHEDULE_TICK);
    this._scheduler();
    return this.getUserTrackInfo();
  }

  /** 构建全曲 lead 通知队列：audioTime 与发声排程同源，升序供游标单调扫描 */
  _buildNoteQueue(song, startAudio, totalBars, stepDur) {
    const beatDur = stepDur * 4;
    const queue = [];
    for (const ev of song.lead) {
      if (!ev || typeof ev !== 'object') continue;
      const bar = Number(ev.bar);
      const step = Number(ev.step);
      if (!(bar >= 0 && bar < totalBars && step >= 0 && step <= 15)) continue;
      queue.push({
        audioTime: startAudio + (bar * 16 + step) * stepDur,
        lane: Number(ev.lane) | 0,
        freq: noteToFreq(ev.note),
        dur: clamp((Number(ev.dur) || 1) * beatDur, 0.05, 4),
        wave: typeof ev.wave === 'string' ? ev.wave : 'supersaw',
      });
    }
    queue.sort((a, b) => a.audioTime - b.audioTime);
    return queue;
  }

  /** 构建全曲拍点通知队列（每小节 4 拍，beatIndex 全曲连续递增，天然有序） */
  _buildBeatQueue(totalBars, startAudio, stepDur) {
    const queue = [];
    for (let bar = 0; bar < totalBars; bar++) {
      for (let b = 0; b < 4; b++) {
        queue.push({
          audioTime: startAudio + (bar * 16 + b * 4) * stepDur,
          beatIndex: bar * 4 + b,
          barIndex: bar,
        });
      }
    }
    return queue;
  }

  /**
   * 通知 tick（仅 song 模式）：推进独立通知游标，与发声调度解耦。
   * onNote 视界 now+2.5s（下落音符 travel=min(2.0, hitTime-收到时刻) ≥ 2s）；
   * onBeat 视界 now+0.5s（视觉脉冲容错）。指针单调前进 → 无重复通知；
   * startSong 首次 _scheduler() 即调本方法 → 开局 0~2.5s 窗口内的音符不迟到。
   */
  _notifyTick() {
    const track = this._track;
    if (!track.running || track.mode !== 'song' || !this.ctx) return;
    const now = this.ctx.currentTime;
    if (track.onNote && track.noteQueue) {
      const horizon = now + 2.5;
      while (track.notePtr < track.noteQueue.length && track.noteQueue[track.notePtr].audioTime <= horizon) {
        const ev = track.noteQueue[track.notePtr++];
        track.onNote({ audioTime: ev.audioTime, lane: ev.lane, freq: ev.freq, dur: ev.dur, wave: ev.wave });
      }
    }
    if (track.onBeat && track.beatQueue) {
      const horizon = now + 0.5;
      while (track.beatPtr < track.beatQueue.length && track.beatQueue[track.beatPtr].audioTime <= horizon) {
        const b = track.beatQueue[track.beatPtr++];
        track.onBeat(b.beatIndex, b.barIndex, b.audioTime);
      }
    }
  }

  /** 按 key 把事件数组预索引成 Map<keyValue, events[]>，避免每步全表扫描 */
  _indexBy(events, key) {
    const map = new Map();
    for (const ev of events) {
      if (!ev || typeof ev !== 'object') continue;
      const k = Number(ev[key]);
      if (!Number.isFinite(k)) continue;
      if (!map.has(k)) map.set(k, []);
      map.get(k).push(ev);
    }
    return map;
  }

  /** 曲尾自然收尾：停调度器与回调，但不硬切已排程的尾音（混响/铃音自然衰减） */
  _finishSong() {
    const track = this._track;
    track.running = false;
    track.mode = 'synth';
    if (track.timer) {
      clearInterval(track.timer);
      track.timer = null;
    }
    track.song = null;
    track.onBeat = null;
    track.onNote = null;
    track.leadIndex = null;
    track.fxIndex = null;
    track.noteQueue = null;
    track.notePtr = 0;
    track.beatQueue = null;
    track.beatPtr = 0;
  }

  /** lead.wave → 对应合成音色（默认 supersaw） */
  _playLeadWave(wave, freq, t, dur) {
    switch (wave) {
      case 'bell': this.playBell(freq, t, dur); break;
      case 'pluck': this.playPluck(freq, t, dur); break;
      case 'vocal': this.playVocalChop(freq, t, dur); break;
      case 'supersaw':
      default: this.playSupersaw(freq, t, dur); break;
    }
  }

  /** 低音量铺底：复用 piano voice，每音 level 压到 ~0.12，只填和声空间 */
  _playPad(t, dur, freqs) {
    for (const f of freqs) this._playPianoVoice(f, t, dur, 0.12);
  }

  /** 停止音序器：清 interval、断用户音频源、安全停止已排程未发声节点 */
  stopTrack() {
    const track = this._track;
    track.running = false;
    track.mode = 'synth';
    track.song = null;
    track.onNote = null;
    track.leadIndex = null;
    track.fxIndex = null;
    track.noteQueue = null;
    track.notePtr = 0;
    track.beatQueue = null;
    track.beatPtr = 0;
    if (track.timer) {
      clearInterval(track.timer);
      track.timer = null;
    }
    track.onBeat = null;
    if (track.userSource) {
      try { track.userSource.stop(); } catch (e) { /* 已停止则忽略 */ }
      try { track.userSource.disconnect(); } catch (e) { /* 幂等 */ }
      track.userSource = null;
    }
    // 已排程但尚未发声/发声中的源统一安全停止（onended 会自动清理节点链）
    this._active.forEach((src) => {
      try { src.stop(0); } catch (e) { /* 已结束的源抛 InvalidStateError，忽略 */ }
    });
    this._active.clear();
  }

  /** @returns {{running:boolean, style:string|null, bpm:number, songId:string|null, songName:string|null}} */
  getUserTrackInfo() {
    const t = this._track;
    const info = {
      running: t.running,
      style: t.style,
      bpm: t.bpm,
      songId: null,
      songName: null,
    };
    if (t.mode === 'song' && t.song) {
      info.songId = t.song.id || null;
      info.songName = t.song.name || null;
    }
    return info;
  }

  /** 检查器：25ms 一次，把未来 0.1s 内的步进全部精确排程 */
  _scheduler() {
    const track = this._track;
    if (!track.running || !this.ctx) return;
    this._notifyTick(); // 通知与发声解耦：每 tick 先推进通知游标（含 startSong 首调，开局音符不迟到）
    while (track.nextStepTime < this.ctx.currentTime + track.SCHEDULE_AHEAD) {
      // song 模式：最后一小节的 step 15 排完后（barIndex 推到曲尾）自动收尾
      if (track.mode === 'song' && track.barIndex >= track.totalBars) {
        this._finishSong();
        return;
      }
      this._scheduleStep(track.step, track.nextStepTime);
      track.nextStepTime += track.stepDur;
      track.step = (track.step + 1) % 16;
      if (track.step === 0) track.barIndex++;
    }
  }

  /**
   * 单步排程（发声）：file 模式只排节拍；song 模式按曲库数据排乐器；
   * synth 模式按风格排乐器。song 模式的 onBeat/onNote 已由通知游标
   * （_notifyTick）提前发出，此处不再发，避免重复通知。
   */
  _scheduleStep(step, time) {
    const track = this._track;
    if (track.mode === 'song') {
      this._scheduleSongStep(step, time);
    } else if (track.mode !== 'file') {
      switch (track.style) {
        case 'edm': this._patternEdm(step, time, track.barIndex); break;
        case 'funk': this._patternFunk(step, time, track.barIndex); break;
        case 'house':
        default: this._patternHouse(step, time, track.barIndex); break;
      }
    }
    if (track.mode !== 'song' && step % 4 === 0 && track.onBeat) {
      track.onBeat(track.beatIndex, track.barIndex, time);
      track.beatIndex++;
    }
  }

  /**
   * song 模式单步排程（16 步/小节，drum pattern 循环）：
   * drum 各轨道按 pattern 命中；bass 支持平铺或 4 小节变体数组，
   * bassVoice='808' 时用 play808（pitch=freq/40）；
   * chordProg 每小节一个和弦在 step0 铺底（音量低）；
   * lead/fx 按 bar 预索引命中，lead 同时发 onNote 回调。
   */
  _scheduleSongStep(step, time) {
    const track = this._track;
    const song = track.song;
    const bar = track.barIndex;
    const beatDur = track.stepDur * 4;

    // ---- 鼓组（16 步 pattern 循环） ----
    const drum = song.drum || {};
    if (Array.isArray(drum.kick) && drum.kick.includes(step)) this.playKick(time);
    if (Array.isArray(drum.snare) && drum.snare.includes(step)) this.playSnare(time);
    if (Array.isArray(drum.hatC) && drum.hatC.includes(step)) this.playHat(time, false);
    if (Array.isArray(drum.hatO) && drum.hatO.includes(step)) this.playHat(time, true);
    if (Array.isArray(drum.clap) && drum.clap.includes(step)) this.playClap(time);

    // ---- Bass（平铺数组每小节循环，或 4 小节变体数组） ----
    const bassPat = Array.isArray(song.bass) && Array.isArray(song.bass[0])
      ? song.bass[bar % song.bass.length]
      : song.bass;
    if (Array.isArray(bassPat)) {
      for (const ev of bassPat) {
        if (!ev || ev.step !== step) continue;
        const freq = noteToFreq(ev.note);
        if (song.bassVoice === '808') {
          this.play808(time, freq / 40);
        } else {
          this.playBass(freq, time, clamp((Number(ev.dur) || 0.5) * beatDur, 0.05, 2));
        }
      }
    }

    // ---- 和弦铺底（step0 每小节一次，音量低） ----
    if (step === 0 && Array.isArray(song.chordProg) && song.chordProg.length) {
      const freqs = parseChord(song.chordProg[bar % song.chordProg.length]);
      if (freqs.length) this._playPad(time, beatDur * 3.8, freqs);
    }

    // ---- Lead 旋律（预索引后按 step 命中；onNote 通知已由游标提前 2.5s 发出） ----
    const leadEvents = track.leadIndex && track.leadIndex.get(bar);
    if (leadEvents) {
      for (const ev of leadEvents) {
        if (ev.step !== step) continue;
        const freq = noteToFreq(ev.note);
        const dur = clamp((Number(ev.dur) || 1) * beatDur, 0.05, 4);
        const wave = typeof ev.wave === 'string' ? ev.wave : 'supersaw';
        this._playLeadWave(wave, freq, time, dur);
      }
    }

    // ---- 段落特效 ----
    const fxEvents = track.fxIndex && track.fxIndex.get(bar);
    if (fxEvents) {
      for (const ev of fxEvents) {
        if (!ev || ev.step !== step) continue;
        if (ev.type === 'riser') this.playRiser(time, Number(ev.dur) || 2);
        else if (ev.type === 'impact') this.playImpact(time);
      }
    }
  }

  _rootOf(bar) {
    return ROOT_A2 * Math.pow(2, CHORD_PROG[((bar % 4) + 4) % 4] / 12);
  }

  /**
   * house：四四拍 kick(0/4/8/12) + offbeat open hat(2/6/10/14) + bass 8 分。
   * 润色：16 分轻 closed hat 补律动、2/4 拍 clap 位 snare、bass 第 6 个八分换五度。
   */
  _patternHouse(step, time, bar) {
    const root = this._rootOf(bar);
    const stepDur = this._track.stepDur;
    if (step % 4 === 0) this.playKick(time);
    if (step % 4 === 2) this.playHat(time, true);
    else if (step % 2 === 1) this.playHat(time, false);
    if (step === 4 || step === 12) this.playSnare(time);
    if (step % 2 === 0) {
      const freq = step === 10 ? root * Math.pow(2, 7 / 12) : root; // 五度点缀
      this.playBass(freq, time, stepDur * 1.8);
    }
  }

  /**
   * edm：kick 四拍(0/4/8/12) + snare 2/4(4/12) + hat 16 分(反拍 open) + 上行 lead 琶音。
   * 琶音：A 小调三和弦上行 8 音循环 [A C E A C E A C]，随和弦进行整体移调。
   */
  _patternEdm(step, time, bar) {
    const prog = CHORD_PROG[((bar % 4) + 4) % 4];
    if (step % 4 === 0) this.playKick(time);
    if (step === 4 || step === 12) this.playSnare(time);
    this.playHat(time, step % 4 === 2);
    const ARP = [0, 3, 7, 12, 15, 19, 24, 27]; // A C E A C E A C（半音）
    const freq = 220 * Math.pow(2, (ARP[step % 8] + prog) / 12);
    this.playPiano(freq, time, 0.14);
  }

  /**
   * funk：syncopated kick(0/3/6/10) + snare backbeat(4/12) + hat 16 分(14 位 open) + 切分 bass。
   * bass 与 kick 错位呼应：0 根音 / 3 根音 / 6 八度 / 10 五度 / 13 根音（短促）
   */
  _patternFunk(step, time, bar) {
    const root = this._rootOf(bar);
    if (step === 0 || step === 3 || step === 6 || step === 10) this.playKick(time);
    if (step === 4 || step === 12) this.playSnare(time);
    this.playHat(time, step === 14);
    const BASS = { 0: 0, 3: 0, 6: 12, 10: 7, 13: 0 }; // 步进 → 相对根音半音
    if (Object.prototype.hasOwnProperty.call(BASS, step)) {
      this.playBass(root * Math.pow(2, BASS[step] / 12), time, 0.18);
    }
  }

  /* ------------------------ 用户本地音频（可选增强） ------------------------ */

  /**
   * 加载用户本地音频文件为背景曲（解码为 AudioBuffer，startTrack 时循环播放）。
   * 加载成功后 startTrack 自动切换为 file 模式：不再排程序乐器，
   * 但仍按传入 bpm 估算节拍发出 onBeat，保证 3D 舞台视觉同步不断。
   * @returns {Promise<{name:string, duration:number, sampleRate:number}>}
   */
  async loadUserFile(file) {
    if (!file) throw new Error('未提供音频文件');
    if (!this.ctx) this.init();
    const arrayBuf = await file.arrayBuffer();
    const audioBuf = await new Promise((resolve, reject) => {
      // 同时兼容回调式与 Promise 式 decodeAudioData 实现
      const p = this.ctx.decodeAudioData(arrayBuf, resolve, reject);
      if (p && typeof p.then === 'function') p.then(resolve, reject);
    });
    this._track.userBuffer = audioBuf;
    this._track.mode = 'file';
    return {
      name: file.name || 'user-audio',
      duration: audioBuf.duration,
      sampleRate: audioBuf.sampleRate,
    };
  }
}

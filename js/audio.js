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
      SCHEDULE_AHEAD: 0.1,    // 提前排程量 100ms
      SCHEDULE_TICK: 25,      // 检查器周期 25ms
    };
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

  /** 停止音序器：清 interval、断用户音频源、安全停止已排程未发声节点 */
  stopTrack() {
    const track = this._track;
    track.running = false;
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

  /** @returns {{running:boolean, style:string|null, bpm:number}} */
  getUserTrackInfo() {
    const t = this._track;
    return { running: t.running, style: t.style, bpm: t.bpm };
  }

  /** 检查器：25ms 一次，把未来 0.1s 内的步进全部精确排程 */
  _scheduler() {
    const track = this._track;
    if (!track.running || !this.ctx) return;
    while (track.nextStepTime < this.ctx.currentTime + track.SCHEDULE_AHEAD) {
      this._scheduleStep(track.step, track.nextStepTime);
      track.nextStepTime += track.stepDur;
      track.step = (track.step + 1) % 16;
      if (track.step === 0) track.barIndex++;
    }
  }

  /** 单步排程：file 模式只发 onBeat；synth 模式按风格排乐器并同拍发 onBeat */
  _scheduleStep(step, time) {
    const track = this._track;
    if (track.mode !== 'file') {
      switch (track.style) {
        case 'edm': this._patternEdm(step, time, track.barIndex); break;
        case 'funk': this._patternFunk(step, time, track.barIndex); break;
        case 'house':
        default: this._patternHouse(step, time, track.barIndex); break;
      }
    }
    if (step % 4 === 0 && track.onBeat) {
      track.onBeat(track.beatIndex, track.barIndex, time);
      track.beatIndex++;
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

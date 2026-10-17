/**
 * motion-wave-dj · 内置曲库（任务 6 / Taylor）
 * ============================================================
 * 纯数据模块（无 Web Audio / 无外部依赖），供 audio.js 的 startSong()
 * 播放，game.js 通过 onNote 回调消费 lead 事件生成下落音符。
 *
 * 曲目数据契约（与 Jay 约定，严格遵守）：
 * {
 *   id, name, style, bpm, key, difficulty(1=简单|2=普通|3=困难),
 *   lengthBeats,               // 总拍数（4/4 拍），totalBars = lengthBeats / 4
 *   chordProg: ['Am', ...],    // 每小节一个和弦，startSong 按 bar 取模循环铺底
 *   drum: { kick, snare, hatC, hatO, clap },  // 各为小节内 16 步位数组（相对每小节循环）
 *   bass: [ {step,note,dur}, ... ]            // 平铺写法：每小节循环
 *       | [ [..], [..], [..], [..] ]          // 4 小节变体写法：按 bar % 4 循环
 *   bassVoice: 'bass'|'808',   // 可选，默认 'bass'；'808' 用 play808（Trap 长滑重低音）
 *   lead: [ {bar, step, note, lane, dur, wave} ], // 全曲旋律事件；bar 0 起，step 0-15
 *   fx:   [ {bar, type:'riser'|'impact', step, dur?} ],
 * }
 *
 * 单位约定：
 *   dur 一律以「拍」为单位（1 = 四分音符，0.5 = 八分，0.25 = 十六分）；
 *   lane 0-3 为下落音符轨道，由 assignLanes() 按全曲音高自动分配
 *   （低→0 高→3，同 bar+step 双押强制分叉到不同 lane）；
 *   wave ∈ 'supersaw'|'bell'|'pluck'|'vocal'（缺省 supersaw）。
 */

/* ============================ 内部工具（纯数据，无依赖） ============================ */

const NOTE_SEMI = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

/** 音名 → MIDI 号（'A4'→69，'C#3'→49，'Bb2'→46）；解析失败回退 69 */
function noteMidi(note) {
  const m = /^([A-Ga-g])([#b♯♭]?)(-?\d+)$/.exec(String(note).trim());
  if (!m) return 69;
  let semi = NOTE_SEMI[m[1].toUpperCase()];
  if (m[2] === '#' || m[2] === '♯') semi += 1;
  if (m[2] === 'b' || m[2] === '♭') semi -= 1;
  return (parseInt(m[3], 10) + 1) * 12 + semi;
}

/** phrase 快捷构造：一小节旋律片段（wave 音色 + notes: [step, note, dur] 元组数组） */
const ph = (wave, notes) => ({ wave, notes });

/** 将 phrase 模板按 bar % phrases.length 平铺成全曲 lead 事件（bar 0..totalBars-1） */
function expandLead(phrases, totalBars) {
  const lead = [];
  for (let bar = 0; bar < totalBars; bar++) {
    const p = phrases[bar % phrases.length];
    for (const [step, note, dur] of p.notes) {
      lead.push({ bar, step, note, dur, wave: p.wave });
    }
  }
  return lead;
}

/**
 * 按全曲音高四等分自动分配 lane（0=最低音 → 3=最高音）。
 * 同 bar+step 的双押音符保证 lane 互不相同（高音向右避让，右满向左回退）。
 * 生成逻辑确定可复现：同一份数据输入永远得到同一份 lane 输出。
 */
function assignLanes(lead) {
  if (!Array.isArray(lead) || lead.length === 0) return lead;
  let lo = Infinity;
  let hi = -Infinity;
  for (const e of lead) {
    const m = noteMidi(e.note);
    e._m = m;
    if (m < lo) lo = m;
    if (m > hi) hi = m;
  }
  const span = Math.max(1, hi - lo);
  const groups = new Map();
  for (const e of lead) {
    const k = e.bar * 16 + e.step; // step 为 0-15 整数，key 唯一
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(e);
  }
  for (const g of groups.values()) {
    if (g.length > 1) g.sort((a, b) => a._m - b._m);
    const used = new Set();
    for (const e of g) {
      let lane = Math.min(3, Math.floor(((e._m - lo) / (span + 1)) * 4));
      while (used.has(lane) && lane < 3) lane++;
      while (used.has(lane) && lane > 0) lane--;
      used.add(lane);
      e.lane = lane;
    }
  }
  for (const e of lead) delete e._m;
  return lead;
}

/**
 * 段落特效线（全曲统一规则，确定性）：
 * bar0 段首 impact；每 8 小节的末小节（bar%8==7）铺 1 小节 riser；
 * 每 16 小节段首补 impact。riser 时长 = 1 小节秒数（capped 4s，playRiser 上限）。
 */
function fxLine(totalBars, bpm) {
  const barSec = Math.min((60 / bpm) * 4, 4);
  const fx = [{ bar: 0, type: 'impact', step: 0 }];
  for (let bar = 7; bar < totalBars - 1; bar += 8) {
    fx.push({ bar, type: 'riser', step: 0, dur: barSec });
  }
  for (let bar = 16; bar < totalBars; bar += 16) {
    fx.push({ bar, type: 'impact', step: 0 });
  }
  return fx;
}

/* ============================ 内置曲库（8 首） ============================ */

export const SONGS = [
  /* ---- 01 · 霓虹之夜（EDM 大调燃曲，四踩 + offbeat bass，难度 2） ---- */
  {
    id: 'neon-nights',
    name: '霓虹之夜',
    style: 'edm',
    bpm: 128,
    key: 'Am',
    difficulty: 2,
    lengthBeats: 256, // 64 小节 ≈ 120s
    chordProg: ['Am', 'F', 'C', 'G'],
    drum: {
      kick: [0, 4, 8, 12],
      snare: [],
      hatC: [1, 3, 5, 7, 9, 11, 13, 15],
      hatO: [2, 6, 10, 14],
      clap: [4, 12],
    },
    bass: [
      [{ step: 2, note: 'A1', dur: 0.45 }, { step: 6, note: 'A1', dur: 0.45 }, { step: 10, note: 'A1', dur: 0.45 }, { step: 14, note: 'A1', dur: 0.45 }],
      [{ step: 2, note: 'F1', dur: 0.45 }, { step: 6, note: 'F1', dur: 0.45 }, { step: 10, note: 'F1', dur: 0.45 }, { step: 14, note: 'F1', dur: 0.45 }],
      [{ step: 2, note: 'C2', dur: 0.45 }, { step: 6, note: 'C2', dur: 0.45 }, { step: 10, note: 'C2', dur: 0.45 }, { step: 14, note: 'C2', dur: 0.45 }],
      [{ step: 2, note: 'G1', dur: 0.45 }, { step: 6, note: 'G1', dur: 0.45 }, { step: 10, note: 'G1', dur: 0.45 }, { step: 14, note: 'G1', dur: 0.45 }],
    ],
    lead: assignLanes(expandLead([
      // A 段：每拍 1 音 + 句尾 2 拍长音呼吸
      ph('supersaw', [[0, 'A4', 1], [2, 'C5', 1], [4, 'E5', 1.5], [8, 'D5', 1], [12, 'B4', 2]]),
      ph('supersaw', [[0, 'C5', 1], [2, 'A4', 1], [4, 'C5', 2], [8, 'A4', 1], [12, 'G4', 2]]),
      ph('supersaw', [[0, 'E5', 1], [2, 'G5', 1], [4, 'E5', 1], [8, 'D5', 1], [12, 'C5', 2]]),
      ph('supersaw', [[0, 'D5', 1], [2, 'B4', 1], [4, 'G4', 1], [8, 'B4', 1], [12, 'D5', 2]]),
      // B 段：八分流动，情绪抬升
      ph('supersaw', [[0, 'A4', 0.5], [1, 'C5', 0.5], [2, 'E5', 1], [4, 'D5', 1], [6, 'C5', 1], [12, 'A4', 2]]),
      ph('supersaw', [[0, 'F4', 0.5], [1, 'A4', 0.5], [2, 'C5', 1], [4, 'A4', 1], [6, 'G4', 1], [12, 'F4', 2]]),
      ph('supersaw', [[0, 'E4', 0.5], [1, 'G4', 0.5], [2, 'C5', 1], [4, 'G4', 1], [6, 'E5', 1], [12, 'C5', 2]]),
      ph('supersaw', [[0, 'D5', 0.5], [1, 'B4', 0.5], [2, 'G4', 1], [4, 'B4', 1], [6, 'D5', 1], [12, 'B4', 2]]),
    ], 64)),
    fx: fxLine(64, 128),
  },

  /* ---- 02 · 棱镜之心（Future Bass，140BPM 明亮大调，16 分 + 双押，难度 3） ---- */
  {
    id: 'prism-heart',
    name: '棱镜之心',
    style: 'future-bass',
    bpm: 140,
    key: 'C',
    difficulty: 3,
    lengthBeats: 224, // 56 小节 ≈ 96s
    chordProg: ['C', 'G', 'Am', 'F'],
    drum: {
      kick: [0, 8],
      snare: [],
      hatC: [2, 6, 10, 14],
      hatO: [14],
      clap: [4, 12],
    },
    bass: [
      [{ step: 0, note: 'C2', dur: 0.5 }, { step: 4, note: 'C2', dur: 0.5 }, { step: 8, note: 'C2', dur: 0.5 }, { step: 12, note: 'C2', dur: 0.5 }],
      [{ step: 0, note: 'G1', dur: 0.5 }, { step: 4, note: 'G1', dur: 0.5 }, { step: 8, note: 'G1', dur: 0.5 }, { step: 12, note: 'G1', dur: 0.5 }],
      [{ step: 0, note: 'A1', dur: 0.5 }, { step: 4, note: 'A1', dur: 0.5 }, { step: 8, note: 'A1', dur: 0.5 }, { step: 12, note: 'A1', dur: 0.5 }],
      [{ step: 0, note: 'F1', dur: 0.5 }, { step: 4, note: 'F1', dur: 0.5 }, { step: 8, note: 'F1', dur: 0.5 }, { step: 12, note: 'F1', dur: 0.5 }],
    ],
    lead: assignLanes(expandLead([
      // A 段：supersaw 密集主音，16 分经过音 + 同 step 双押
      ph('supersaw', [[0, 'E5', 0.5], [2, 'G5', 0.5], [4, 'C6', 0.5], [6, 'G5', 0.5], [8, 'E5', 0.25], [9, 'G5', 0.25], [10, 'C6', 0.5], [12, 'C6', 0.5], [12, 'E6', 0.5], [14, 'G5', 0.5]]),
      ph('supersaw', [[0, 'D5', 0.5], [2, 'G5', 0.5], [4, 'B5', 0.5], [6, 'G5', 0.5], [8, 'D5', 0.5], [12, 'B4', 0.5], [14, 'D5', 0.5]]),
      ph('supersaw', [[0, 'A4', 0.5], [2, 'C5', 0.5], [4, 'E5', 0.5], [6, 'A5', 0.5], [8, 'E5', 0.5], [12, 'C5', 0.5], [14, 'E5', 0.5]]),
      ph('supersaw', [[0, 'F4', 0.5], [2, 'A4', 0.5], [4, 'C5', 0.5], [6, 'F5', 0.5], [8, 'C5', 0.5], [10, 'A4', 0.5], [12, 'C5', 0.5], [12, 'F5', 0.5], [14, 'A4', 0.5]]),
      // B 段：bell 梦幻变奏，句尾长音呼吸
      ph('bell', [[0, 'G5', 0.5], [2, 'E5', 0.5], [4, 'C5', 1], [8, 'D5', 0.5], [10, 'E5', 0.5], [12, 'G5', 1.5]]),
      ph('bell', [[0, 'D5', 0.5], [2, 'B4', 0.5], [4, 'G4', 1], [8, 'A4', 0.5], [10, 'B4', 0.5], [12, 'D5', 1.5]]),
      ph('bell', [[0, 'C5', 0.5], [2, 'E5', 0.5], [4, 'A5', 1], [8, 'G5', 0.5], [10, 'E5', 0.5], [12, 'C5', 1.5]]),
      ph('bell', [[0, 'A4', 0.5], [2, 'C5', 0.5], [4, 'F5', 1], [8, 'E5', 0.5], [10, 'C5', 0.5], [12, 'A4', 1.5]]),
    ], 56)),
    fx: fxLine(56, 140),
  },

  /* ---- 03 · 磁带日落（Synthwave 复古，100BPM 长音 + 琶音，难度 2） ---- */
  {
    id: 'tape-sunset',
    name: '磁带日落',
    style: 'synthwave',
    bpm: 100,
    key: 'F#m',
    difficulty: 2,
    lengthBeats: 224, // 56 小节 ≈ 134s
    chordProg: ['F#m', 'D', 'A', 'E'],
    drum: {
      kick: [0, 4, 8, 12],
      snare: [4, 12],
      hatC: [2, 6, 10, 14],
      hatO: [],
      clap: [],
    },
    bass: [
      [{ step: 0, note: 'F#1', dur: 0.4 }, { step: 2, note: 'F#1', dur: 0.4 }, { step: 4, note: 'F#1', dur: 0.4 }, { step: 6, note: 'F#1', dur: 0.4 }, { step: 8, note: 'F#1', dur: 0.4 }, { step: 10, note: 'F#1', dur: 0.4 }, { step: 12, note: 'F#1', dur: 0.4 }, { step: 14, note: 'F#1', dur: 0.4 }],
      [{ step: 0, note: 'D1', dur: 0.4 }, { step: 2, note: 'D1', dur: 0.4 }, { step: 4, note: 'D1', dur: 0.4 }, { step: 6, note: 'D1', dur: 0.4 }, { step: 8, note: 'D1', dur: 0.4 }, { step: 10, note: 'D1', dur: 0.4 }, { step: 12, note: 'D1', dur: 0.4 }, { step: 14, note: 'D1', dur: 0.4 }],
      [{ step: 0, note: 'A1', dur: 0.4 }, { step: 2, note: 'A1', dur: 0.4 }, { step: 4, note: 'A1', dur: 0.4 }, { step: 6, note: 'A1', dur: 0.4 }, { step: 8, note: 'A1', dur: 0.4 }, { step: 10, note: 'A1', dur: 0.4 }, { step: 12, note: 'A1', dur: 0.4 }, { step: 14, note: 'A1', dur: 0.4 }],
      [{ step: 0, note: 'E1', dur: 0.4 }, { step: 2, note: 'E1', dur: 0.4 }, { step: 4, note: 'E1', dur: 0.4 }, { step: 6, note: 'E1', dur: 0.4 }, { step: 8, note: 'E1', dur: 0.4 }, { step: 10, note: 'E1', dur: 0.4 }, { step: 12, note: 'E1', dur: 0.4 }, { step: 14, note: 'E1', dur: 0.4 }],
    ],
    lead: assignLanes(expandLead([
      // A 段：bell 长音，复古慢镜头感
      ph('bell', [[0, 'C#5', 1], [4, 'A4', 1], [8, 'F#4', 2], [12, 'E5', 1]]),
      ph('bell', [[0, 'D5', 1], [4, 'A4', 1], [8, 'F#4', 2], [12, 'A4', 1]]),
      ph('bell', [[0, 'C#5', 1], [4, 'E5', 1], [8, 'A5', 2], [12, 'E5', 1]]),
      ph('bell', [[0, 'B4', 1], [4, 'G#4', 1], [8, 'E4', 2], [12, 'B4', 1]]),
      // B 段：pluck 八分琶音，霓虹流动感
      ph('pluck', [[0, 'F#4', 0.5], [2, 'A4', 0.5], [4, 'C#5', 0.5], [6, 'A4', 0.5], [8, 'F#4', 0.5], [10, 'A4', 0.5], [12, 'C#5', 0.5], [14, 'E5', 0.5]]),
      ph('pluck', [[0, 'D4', 0.5], [2, 'F#4', 0.5], [4, 'A4', 0.5], [6, 'F#4', 0.5], [8, 'D4', 0.5], [10, 'F#4', 0.5], [12, 'A4', 0.5], [14, 'D5', 0.5]]),
      ph('pluck', [[0, 'A4', 0.5], [2, 'C#5', 0.5], [4, 'E5', 0.5], [6, 'C#5', 0.5], [8, 'A4', 0.5], [10, 'C#5', 0.5], [12, 'E5', 0.5], [14, 'A5', 0.5]]),
      ph('pluck', [[0, 'E4', 0.5], [2, 'G#4', 0.5], [4, 'B4', 0.5], [6, 'G#4', 0.5], [8, 'E4', 0.5], [10, 'G#4', 0.5], [12, 'B4', 0.5], [14, 'E5', 0.5]]),
    ], 56)),
    fx: fxLine(56, 100),
  },

  /* ---- 04 · 盛夏天台（House 律动，124BPM 悠闲人声切片，难度 1） ---- */
  {
    id: 'rooftop-summer',
    name: '盛夏天台',
    style: 'house',
    bpm: 124,
    key: 'Dm',
    difficulty: 1,
    lengthBeats: 216, // 54 小节 ≈ 105s
    chordProg: ['Dm', 'Bb', 'F', 'C'],
    drum: {
      kick: [0, 4, 8, 12],
      snare: [],
      hatC: [0, 1, 3, 4, 5, 7, 8, 9, 11, 12, 13, 15],
      hatO: [2, 6, 10, 14],
      clap: [4, 12],
    },
    bass: [
      [{ step: 2, note: 'D1', dur: 0.5 }, { step: 6, note: 'D1', dur: 0.5 }, { step: 10, note: 'D1', dur: 0.5 }, { step: 14, note: 'D1', dur: 0.5 }],
      [{ step: 2, note: 'Bb0', dur: 0.5 }, { step: 6, note: 'Bb0', dur: 0.5 }, { step: 10, note: 'Bb0', dur: 0.5 }, { step: 14, note: 'Bb0', dur: 0.5 }],
      [{ step: 2, note: 'F1', dur: 0.5 }, { step: 6, note: 'F1', dur: 0.5 }, { step: 10, note: 'F1', dur: 0.5 }, { step: 14, note: 'F1', dur: 0.5 }],
      [{ step: 2, note: 'C2', dur: 0.5 }, { step: 6, note: 'C2', dur: 0.5 }, { step: 10, note: 'C2', dur: 0.5 }, { step: 14, note: 'C2', dur: 0.5 }],
    ],
    lead: assignLanes(expandLead([
      // A 段：每 2 拍 1 音长音（难度 1 稀疏规则），pluck 轻快
      ph('pluck', [[0, 'F4', 3], [8, 'A4', 3]]),
      ph('pluck', [[0, 'D5', 3], [8, 'F4', 3]]),
      ph('pluck', [[0, 'C5', 3], [8, 'A4', 3]]),
      ph('pluck', [[0, 'G4', 3], [8, 'E5', 4]]),
      // B 段：vocal chop 每拍 1 音，天台哼唱感
      ph('vocal', [[0, 'D5', 1], [4, 'F5', 1], [8, 'A5', 1], [12, 'F5', 2]]),
      ph('vocal', [[0, 'F5', 1], [4, 'D5', 1], [8, 'Bb4', 1], [12, 'D5', 2]]),
      ph('vocal', [[0, 'A4', 1], [4, 'C5', 1], [8, 'F5', 1], [12, 'C5', 2]]),
      ph('vocal', [[0, 'G4', 1], [4, 'Bb4', 1], [8, 'C5', 1], [12, 'E5', 2]]),
    ], 54)),
    fx: fxLine(54, 124),
  },

  /* ---- 05 · 山水浮灯（国风电子，110BPM C 宫五声音阶 C D E G A，难度 2） ---- */
  {
    id: 'ink-lantern',
    name: '山水浮灯',
    style: 'guofeng',
    bpm: 110,
    key: 'C-gong', // C 宫五声调式（旋律只用 C D E G A 五音）
    difficulty: 2,
    lengthBeats: 224, // 56 小节 ≈ 122s
    chordProg: ['C', 'Am', 'F', 'G'],
    drum: {
      kick: [0, 4, 8, 12],
      snare: [4, 12],
      hatC: [2, 6, 10, 14],
      hatO: [14],
      clap: [],
    },
    bass: [
      [{ step: 0, note: 'C2', dur: 1.5 }, { step: 10, note: 'C2', dur: 0.5 }],
      [{ step: 0, note: 'A1', dur: 1.5 }, { step: 10, note: 'A1', dur: 0.5 }],
      [{ step: 0, note: 'F1', dur: 1.5 }, { step: 10, note: 'F1', dur: 0.5 }],
      [{ step: 0, note: 'G1', dur: 1.5 }, { step: 10, note: 'G1', dur: 0.5 }],
    ],
    lead: assignLanes(expandLead([
      // A 段：pluck 古筝感五声旋律，句尾长音
      ph('pluck', [[0, 'E5', 1], [2, 'G5', 1], [4, 'A5', 2], [8, 'G5', 1], [10, 'E5', 1], [12, 'D5', 2]]),
      ph('pluck', [[0, 'C5', 1], [2, 'D5', 1], [4, 'E5', 2], [8, 'A4', 1], [10, 'C5', 1], [12, 'D5', 2]]),
      ph('pluck', [[0, 'A4', 1], [2, 'C5', 1], [4, 'D5', 2], [8, 'C5', 1], [10, 'A4', 1], [12, 'G4', 2]]),
      ph('pluck', [[0, 'D5', 1], [2, 'E5', 1], [4, 'G5', 2], [8, 'E5', 1], [10, 'D5', 1], [12, 'E5', 2]]),
      // B 段：bell 高音区流水，浮灯意象
      ph('bell', [[0, 'C6', 0.5], [2, 'A5', 0.5], [4, 'G5', 1], [6, 'E5', 0.5], [8, 'G5', 1], [12, 'C6', 2]]),
      ph('bell', [[0, 'A5', 0.5], [2, 'E5', 0.5], [4, 'C5', 1], [6, 'D5', 0.5], [8, 'E5', 1], [12, 'A5', 2]]),
      ph('bell', [[0, 'D5', 0.5], [2, 'C5', 0.5], [4, 'A4', 1], [6, 'G4', 0.5], [8, 'A4', 1], [12, 'D5', 2]]),
      ph('bell', [[0, 'G5', 0.5], [2, 'E5', 0.5], [4, 'D5', 1], [6, 'E5', 0.5], [8, 'G5', 1], [12, 'E5', 2]]),
    ], 56)),
    fx: fxLine(56, 110),
  },

  /* ---- 06 · 像素远征（Chiptune 8bit，140BPM 快速琶音，pluck 近似方波，难度 3） ---- */
  {
    id: 'pixel-quest',
    name: '像素远征',
    style: 'chiptune',
    bpm: 140,
    key: 'Em',
    difficulty: 3,
    lengthBeats: 224, // 56 小节 ≈ 96s
    chordProg: ['Em', 'C', 'G', 'D'],
    drum: {
      kick: [0, 8, 10],
      snare: [4, 12],
      hatC: [0, 2, 4, 6, 8, 10, 12, 14],
      hatO: [],
      clap: [],
    },
    bass: [
      [{ step: 0, note: 'E2', dur: 0.45 }, { step: 2, note: 'E2', dur: 0.45 }, { step: 4, note: 'E2', dur: 0.45 }, { step: 6, note: 'E2', dur: 0.45 }, { step: 8, note: 'E2', dur: 0.45 }, { step: 10, note: 'E2', dur: 0.45 }, { step: 12, note: 'E2', dur: 0.45 }, { step: 14, note: 'E2', dur: 0.45 }],
      [{ step: 0, note: 'C2', dur: 0.45 }, { step: 2, note: 'C2', dur: 0.45 }, { step: 4, note: 'C2', dur: 0.45 }, { step: 6, note: 'C2', dur: 0.45 }, { step: 8, note: 'C2', dur: 0.45 }, { step: 10, note: 'C2', dur: 0.45 }, { step: 12, note: 'C2', dur: 0.45 }, { step: 14, note: 'C2', dur: 0.45 }],
      [{ step: 0, note: 'G1', dur: 0.45 }, { step: 2, note: 'G1', dur: 0.45 }, { step: 4, note: 'G1', dur: 0.45 }, { step: 6, note: 'G1', dur: 0.45 }, { step: 8, note: 'G1', dur: 0.45 }, { step: 10, note: 'G1', dur: 0.45 }, { step: 12, note: 'G1', dur: 0.45 }, { step: 14, note: 'G1', dur: 0.45 }],
      [{ step: 0, note: 'D2', dur: 0.45 }, { step: 2, note: 'D2', dur: 0.45 }, { step: 4, note: 'D2', dur: 0.45 }, { step: 6, note: 'D2', dur: 0.45 }, { step: 8, note: 'D2', dur: 0.45 }, { step: 10, note: 'D2', dur: 0.45 }, { step: 12, note: 'D2', dur: 0.45 }, { step: 14, note: 'D2', dur: 0.45 }],
    ],
    lead: assignLanes(expandLead([
      // A 段：pluck 快速琶音（近似方波），16 分经过音 + 双押
      ph('pluck', [[0, 'E5', 0.5], [2, 'G5', 0.5], [4, 'B5', 0.5], [5, 'G5', 0.5], [8, 'E5', 0.5], [10, 'G5', 0.5], [12, 'B5', 0.5], [14, 'E5', 0.5]]),
      ph('pluck', [[0, 'C5', 0.5], [2, 'E5', 0.5], [4, 'G5', 0.5], [5, 'E5', 0.5], [8, 'C5', 0.5], [10, 'E5', 0.5], [12, 'G5', 0.5], [14, 'C6', 0.5]]),
      ph('pluck', [[0, 'B4', 0.5], [2, 'D5', 0.5], [4, 'G5', 0.5], [5, 'D5', 0.5], [8, 'G4', 0.5], [10, 'B4', 0.5], [12, 'D5', 0.5], [14, 'G5', 0.5]]),
      ph('pluck', [[0, 'A4', 0.5], [2, 'D5', 0.5], [4, 'F#5', 0.5], [5, 'D5', 0.25], [6, 'A4', 0.25], [8, 'F#4', 0.5], [10, 'A4', 0.5], [12, 'D5', 0.5], [12, 'F#5', 0.5]]),
      // B 段：句尾长音呼吸，过关旋律感
      ph('pluck', [[0, 'E6', 0.5], [2, 'B5', 0.5], [4, 'G5', 1], [8, 'E5', 0.5], [10, 'G5', 0.5], [12, 'B5', 2]]),
      ph('pluck', [[0, 'G5', 0.5], [2, 'E5', 0.5], [4, 'C5', 1], [8, 'E5', 0.5], [10, 'G5', 0.5], [12, 'C6', 2]]),
      ph('pluck', [[0, 'D5', 0.5], [2, 'G5', 0.5], [4, 'B5', 1], [8, 'G5', 0.5], [10, 'D5', 0.5], [12, 'B4', 2]]),
      ph('pluck', [[0, 'F#5', 0.5], [2, 'A5', 0.5], [4, 'D6', 1], [8, 'A5', 0.5], [10, 'F#5', 0.5], [12, 'D5', 2]]),
    ], 56)),
    fx: fxLine(56, 140),
  },

  /* ---- 07 · 极光长夜（Trance 长旋律，138BPM supersaw 和声双押，难度 3） ---- */
  {
    id: 'aurora-night',
    name: '极光长夜',
    style: 'trance',
    bpm: 138,
    key: 'Bm',
    difficulty: 3,
    lengthBeats: 224, // 56 小节 ≈ 97s
    chordProg: ['Bm', 'G', 'D', 'A'],
    drum: {
      kick: [0, 4, 8, 12],
      snare: [],
      hatC: [1, 3, 5, 7, 9, 11, 13, 15],
      hatO: [2, 6, 10, 14],
      clap: [4, 12],
    },
    bass: [
      [{ step: 2, note: 'B1', dur: 0.5 }, { step: 6, note: 'B1', dur: 0.5 }, { step: 10, note: 'B1', dur: 0.5 }, { step: 14, note: 'B1', dur: 0.5 }],
      [{ step: 2, note: 'G1', dur: 0.5 }, { step: 6, note: 'G1', dur: 0.5 }, { step: 10, note: 'G1', dur: 0.5 }, { step: 14, note: 'G1', dur: 0.5 }],
      [{ step: 2, note: 'D2', dur: 0.5 }, { step: 6, note: 'D2', dur: 0.5 }, { step: 10, note: 'D2', dur: 0.5 }, { step: 14, note: 'D2', dur: 0.5 }],
      [{ step: 2, note: 'A1', dur: 0.5 }, { step: 6, note: 'A1', dur: 0.5 }, { step: 10, note: 'A1', dur: 0.5 }, { step: 14, note: 'A1', dur: 0.5 }],
    ],
    lead: assignLanes(expandLead([
      // A 段：supersaw 长旋律句，句尾 2 拍长音
      ph('supersaw', [[0, 'F#5', 1], [2, 'D5', 1], [4, 'B4', 2], [8, 'C#5', 1], [10, 'D5', 1], [12, 'F#5', 2]]),
      ph('supersaw', [[0, 'G5', 1], [2, 'D5', 1], [4, 'B4', 2], [8, 'D5', 1], [10, 'F#5', 1], [12, 'G5', 2]]),
      ph('supersaw', [[0, 'F#5', 1], [2, 'A5', 1], [4, 'D6', 2], [8, 'A5', 1], [10, 'F#5', 1], [12, 'D5', 2]]),
      ph('supersaw', [[0, 'E5', 1], [2, 'C#5', 1], [4, 'A4', 2], [8, 'E5', 1], [10, 'F#5', 1], [12, 'E5', 2]]),
      // B 段：step0 和声双押（根音+五音分双 lane），极光铺展
      ph('supersaw', [[0, 'B5', 1], [0, 'F#5', 1], [2, 'D5', 1], [4, 'F#5', 2], [8, 'D5', 1], [10, 'B4', 1], [12, 'C#5', 1], [14, 'D5', 1]]),
      ph('supersaw', [[0, 'B5', 1], [0, 'G5', 1], [2, 'D5', 1], [4, 'G5', 2], [8, 'B4', 1], [10, 'D5', 1], [12, 'G5', 2]]),
      ph('supersaw', [[0, 'A5', 1], [0, 'F#5', 1], [2, 'D5', 1], [4, 'A4', 2], [8, 'F#5', 1], [10, 'A5', 1], [12, 'D6', 2]]),
      ph('supersaw', [[0, 'C#6', 1], [0, 'E5', 1], [2, 'A5', 1], [4, 'E5', 2], [8, 'C#5', 1], [10, 'E5', 1], [12, 'A5', 2]]),
    ], 56)),
    fx: fxLine(56, 138),
  },

  /* ---- 08 · 午夜霓虹雨（Trap，72BPM half-time，808 重低音，难度 2） ---- */
  {
    id: 'midnight-drizzle',
    name: '午夜霓虹雨',
    style: 'trap',
    bpm: 72,
    key: 'Dm',
    difficulty: 2,
    lengthBeats: 168, // 42 小节 ≈ 140s
    chordProg: ['Dm', 'Bb', 'F', 'C'],
    drum: {
      kick: [0, 10], // half-time：1 拍 + 3.5 拍切分
      snare: [8],    // half-time 军鼓落在第 3 拍
      hatC: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15], // 16 分连打
      hatO: [14],
      clap: [],
    },
    bassVoice: '808', // 808 长滑重低音（freq/40 → play808 pitch）
    bass: [
      [{ step: 0, note: 'D1', dur: 2 }, { step: 10, note: 'D1', dur: 1.5 }],
      [{ step: 0, note: 'Bb1', dur: 2 }, { step: 10, note: 'Bb1', dur: 1.5 }],
      [{ step: 0, note: 'F1', dur: 2 }, { step: 10, note: 'F1', dur: 1.5 }],
      [{ step: 0, note: 'C2', dur: 2 }, { step: 10, note: 'C2', dur: 1.5 }],
    ],
    lead: assignLanes(expandLead([
      // A 段：bell 雨夜冷色长音
      ph('bell', [[0, 'D5', 1.5], [4, 'A4', 1], [8, 'F4', 1], [12, 'E4', 2]]),
      ph('bell', [[0, 'D5', 1.5], [4, 'F5', 1], [8, 'A4', 1], [12, 'C5', 2]]),
      ph('bell', [[0, 'F4', 1.5], [4, 'D5', 1], [8, 'Bb4', 1], [12, 'D5', 2]]),
      ph('bell', [[0, 'E5', 1.5], [4, 'G4', 1], [8, 'C5', 1], [12, 'D5', 2]]),
      // B 段：vocal chop 湿润切片
      ph('vocal', [[0, 'D5', 1], [4, 'A5', 1], [8, 'F5', 1], [12, 'E5', 2]]),
      ph('vocal', [[0, 'F5', 1], [4, 'D5', 1], [8, 'A4', 1], [12, 'C5', 2]]),
      ph('vocal', [[0, 'Bb4', 1], [4, 'D5', 1], [8, 'F5', 1], [12, 'D5', 2]]),
      ph('vocal', [[0, 'C5', 1], [4, 'E5', 1], [8, 'G5', 1], [12, 'E5', 2]]),
    ], 42)),
    fx: fxLine(42, 72),
  },
];

/* ============================ 查询接口 ============================ */

/** 按 id 查曲子，未命中返回 null */
export function getSongById(id) {
  if (typeof id !== 'string') return null;
  return SONGS.find((s) => s.id === id) || null;
}

/** 按难度升序的曲库副本（同难度按 BPM 升序），不改动原数组 */
export function songsByDifficulty() {
  return [...SONGS].sort((a, b) => a.difficulty - b.difficulty || a.bpm - b.bpm);
}

/* =====================================================================
 * MOTION WAVE DJ · 主控制器（js/game.js）—— 任务 4 · Jay
 * ---------------------------------------------------------------------
 * 职责：
 *   - 游戏状态机：MENU → PICKING(DJ 选曲 / 创作选乐器) → GUIDE(每模式首次) → PLAYING → RESULT(仅 DJ) → MENU
 *   - 三模式玩法编排：DJ 节奏（QQ 炫舞式下落音符判定）/
 *     乐器创作（选乐器 + 身体演奏 + 录制回放）/ 自由舞台（无评分畅玩）
 *   - 渲染循环（dt + 节拍脉冲）、键盘降级、调试面板刷新、ESC 回菜单
 * 依赖契约（与队友模块逐一对齐）：
 *   ui.js      initUI/showLoading/hideLoading/setHud/showJudge/drawSkeletons/
 *              setCamMode/showGuide/hideGuide/setGuideDismissed/toggleDebug/
 *              showSongPicker/hideSongPicker/showInstrumentPicker/hideInstrumentPicker
 *   pose.js    initPose({videoEl,numPoses,onResults,onStatus}) / armRaised / isSquat
 *   audio.js   AudioEngine（init/resume/playKick 等 play 方法/startSong/stopTrack/
 *              getUserTrackInfo） / noteToFreq
 *   tracks.js  SONGS/getSongById/songsByDifficulty（曲库，Taylor 提供，仅 import 使用）
 *   stage3d.js Stage3D(init/resize/render/setPose/flash/spawnBurst/setNotes/noteHit/
 *              clearNotes/setMode/setPlayers/getStats)
 * 已知陷阱规避：
 *   - AudioContext 在用户手势回调（菜单点击）内 init+resume
 *   - 节拍脉冲用渲染循环比对 audioTime 驱动（过期拍立即补触发，不用 setTimeout）
 *   - 全部用户可见文案为中文，不使用 emoji
 * ===================================================================== */

import {
  initUI, showLoading, hideLoading, setHud, showJudge, drawSkeletons,
  setCamMode, showGuide, hideGuide, setGuideDismissed, toggleDebug,
  showSongPicker, hideSongPicker, showInstrumentPicker, hideInstrumentPicker
} from './ui.js';
import { initPose, armRaised, isSquat } from './pose.js';
import { AudioEngine, noteToFreq } from './audio.js';
import { songsByDifficulty } from './tracks.js';
import { Stage3D } from './stage3d.js';

/* ============================== 常量配置 ============================== */

/* —— QQ 炫舞式下落音符（DJ 模式） —— */
const NOTE_TRAVEL = 2.0;         // 音符飞行时长（秒）：出生点 → 判定线
const WIN_PERFECT = 0.12;        // PERFECT ±120ms = 300 分
const WIN_GREAT = 0.22;          // GREAT ±220ms = 200 分
const WIN_GOOD = 0.32;           // GOOD ±320ms = 100 分（早按侧；晚按侧受 MISS_GRACE 截断）
const MISS_GRACE = 0.25;         // 音符越过判定线 0.25s 仍未判 → MISS（断连击）
const SCORE_BASE = { perfect: 300, great: 200, good: 100 };
const JUDGE_LABEL = { perfect: 'PERFECT', great: 'GREAT', good: 'GOOD', miss: 'MISS' };
const JUDGE_COLOR = { perfect: '#ffd700', great: '#7cffb2', good: '#00e5ff', miss: '#ff5470' };
const GRADE_RANK = { perfect: 0, great: 1, good: 2, miss: 3 };
const CLEAR_WINDOW = 2.0;        // 清屏技：清除未来 2 秒内未判音符
const CLEAR_CD = 5.0;            // 清屏技冷却（秒）
const FB_BPM = 120;              // 音频不可用兜底：本地节奏 BPM
const FB_LEN = 60;               // 兜底曲长（秒）
/* 动作 → 音符 lane 映射（左臂=lane1 左，右臂=lane2 右，双手=lane0+lane3 双押） */
const ACT_LANES = { left: [1], right: [2], both: [0, 3] };

const ARM_CD_DJ = 300;           // DJ / 自由模式举手冷却（毫秒，保持式）
const ARM_CD_CREATE = 200;       // 创作模式挥臂冷却（毫秒/侧）
const GTR_CD = 150;              // 吉他下压防抖（毫秒）
const SQUAT_FRAMES = 3;          // 下蹲需连续确认帧数
const SQUAT_CD = 800;            // 下蹲冷却（毫秒）
const BOTH_CD = 500;             // 双手同举冷却（毫秒）
const REC_SECONDS = 8;           // 创作模式录制时长（秒）
const BEST_KEY = 'mwdj_best_v1'; // 历史最高分 localStorage 键

const PENTA = ['C4', 'D4', 'E4', 'G4', 'A4', 'C5', 'D5', 'E5'];   // C 大调五声 8 音
const GTR_NOTES = ['E2', 'A2', 'D3', 'G3', 'B3', 'E4'];           // 吉他扫弦音域（低→高）
const CHORDS = [                                                   // 下蹲和弦轮换 C-F-G-Am
  ['C3', 'E3', 'G3'], ['F3', 'A3', 'C4'], ['G3', 'B3', 'D4'], ['A3', 'C4', 'E4']
];

/* —— 创作模式乐器包（6 个）：手势映射规则不变，音色随包切换 ——
 * 包方法约定：scale(音阶序号, t) 左臂挥动 / strum(音域序号, t) 右手扫弦 /
 * chord(轮换序号, t) 下蹲 / egg(t) 双手同举彩蛋；
 * jam 的 kind 映射：'piano'→scale 'guitar'→strum 'chord'→chord 'cymbal'→egg，
 * 录制回放复用同一映射，音色自动跟随回放时所选包 */
const INSTRUMENT_KEY = 'mwdj_instrument_v1';   // 上次所选乐器 localStorage 键

/* 和弦进行取音：order 为包特有轮换顺序（八音盒 Am-F-C-G），默认 C-F-G-Am */
function chordNotesAt(ci, order) {
  const idx = order ? order[ci % order.length] : (ci % CHORDS.length);
  return CHORDS[idx] || CHORDS[0];
}

const INSTRUMENTS = [
  {
    id: 'piano', name: '梦幻钢琴', desc: '柔和钢琴音阶 · 吉他琶音扫弦 · 铃音彩蛋',
    scale(i, t) {
      audio.playPiano(noteToFreq(PENTA[clamp(i, 0, PENTA.length - 1)]), t, 0.5);
    },
    strum(i, t) {   // 吉他自下而上 3 音快速琶音
      const s = clamp(i, 0, GTR_NOTES.length - 3);
      for (let k = 0; k < 3; k++) audio.playGuitar(noteToFreq(GTR_NOTES[s + k]), t + k * 0.025);
    },
    chord(ci, t) {  // playChord 复用钢琴音色作底
      audio.playChord(chordNotesAt(ci, this.chordOrder).map(noteToFreq), t, 1.0);
    },
    egg(t) { audio.playBell(noteToFreq('A5'), t, 1.2); },
  },
  {
    id: 'guitar', name: '电吉他', desc: '拨弦音阶 · 密集强扫 · 上扬音效彩蛋',
    scale(i, t) {
      audio.playGuitar(noteToFreq(PENTA[clamp(i, 0, PENTA.length - 1)]), t);
    },
    strum(i, t) {   // 连续 5 音快速 strum，力度更足
      const s = clamp(i, 0, GTR_NOTES.length - 5);
      for (let k = 0; k < 5; k++) audio.playGuitar(noteToFreq(GTR_NOTES[s + k]), t + k * 0.018);
    },
    chord(ci, t) {  // 3 音拨弦叠低音量和弦铺底（playChord 多音自分摊音量）
      const ch = chordNotesAt(ci, this.chordOrder);
      for (let k = 0; k < ch.length; k++) audio.playGuitar(noteToFreq(ch[k]), t + k * 0.03);
      audio.playChord(ch.map(noteToFreq), t + 0.05, 0.9);
    },
    egg(t) { audio.playRiser(t, 0.5); },   // 短上扬
  },
  {
    id: 'organ', name: '双排键', desc: '风琴感和弦声 · 大叠音和弦 · 镲片彩蛋',
    scale(i, t) {   // 短 dur + lowpass（playSupersaw 内建）= 风琴感
      audio.playSupersaw(noteToFreq(PENTA[clamp(i, 0, PENTA.length - 1)]), t, 0.3);
    },
    strum(i, t) {
      const s = clamp(i, 0, GTR_NOTES.length - 3);
      for (let k = 0; k < 3; k++) audio.playSupersaw(noteToFreq(GTR_NOTES[s + k]), t + k * 0.035, 0.25);
    },
    chord(ci, t) {  // 3 度堆叠 + 高八度大叠音
      const ch = chordNotesAt(ci, this.chordOrder).map(noteToFreq);
      audio.playChord(ch.concat(ch.map((f) => f * 2)), t, 1.2);
    },
    egg(t) { audio.playCymbal(t); },
  },
  {
    id: 'synth', name: '电子合成器', desc: '超锯齿主音 · 拨弦三连扫 · 重锤彩蛋',
    scale(i, t) {
      audio.playSupersaw(noteToFreq(PENTA[clamp(i, 0, PENTA.length - 1)]), t, 0.5);
    },
    strum(i, t) {   // playPluck 快速 3 连
      const s = clamp(i, 0, GTR_NOTES.length - 3);
      for (let k = 0; k < 3; k++) audio.playPluck(noteToFreq(GTR_NOTES[s + k]), t + k * 0.028, 0.18);
    },
    chord(ci, t) {  // 长音叠
      const ch = chordNotesAt(ci, this.chordOrder);
      for (const n of ch) audio.playSupersaw(noteToFreq(n), t, 1.2);
    },
    egg(t) { audio.playImpact(t); },
  },
  {
    id: 'musicbox', name: '八音盒', desc: '清脆铃音 · 双音轻扫 · 分解和弦 · 高八度彩蛋',
    chordOrder: [3, 1, 0, 2],   // 特有进行：Am-F-C-G 轮换
    scale(i, t) {
      audio.playBell(noteToFreq(PENTA[clamp(i, 0, PENTA.length - 1)]), t, 0.7);
    },
    strum(i, t) {   // 双音轻扫
      const s = clamp(i, 0, GTR_NOTES.length - 2);
      audio.playBell(noteToFreq(GTR_NOTES[s]), t, 0.5);
      audio.playBell(noteToFreq(GTR_NOTES[s + 1]), t + 0.02, 0.5);
    },
    chord(ci, t) {  // 3 音分解：30ms 间隔琶音
      const ch = chordNotesAt(ci, this.chordOrder);
      ch.forEach((n, k) => audio.playBell(noteToFreq(n), t + k * 0.03, 0.9));
    },
    egg(t) { audio.playBell(noteToFreq('E6'), t, 1.5); },   // 音阶顶音高八度
  },
  {
    id: 'chip', name: '8bit 芯片', desc: '芯片弹拨音 · 16 分快扫 · 同时和弦 · 808 彩蛋',
    scale(i, t) {
      audio.playPluck(noteToFreq(PENTA[clamp(i, 0, PENTA.length - 1)]), t, 0.18);
    },
    strum(i, t) {   // 4 连 16 分密度快扫
      const s = clamp(i, 0, GTR_NOTES.length - 4);
      for (let k = 0; k < 4; k++) audio.playPluck(noteToFreq(GTR_NOTES[s + k]), t + k * 0.07, 0.12);
    },
    chord(ci, t) {  // 3 音同时
      const ch = chordNotesAt(ci, this.chordOrder);
      for (const n of ch) audio.playPluck(noteToFreq(n), t, 0.4);
    },
    egg(t) { audio.play808(t, 1.5); },
  },
];

/* 上次所选乐器持久化：存包 id（包顺序调整不失效）；读写全程 try/catch（隐私模式容错） */
function loadInstrumentId() {
  try {
    const id = localStorage.getItem(INSTRUMENT_KEY);
    if (id && INSTRUMENTS.some((p) => p.id === id)) return id;
  } catch (e) { /* 忽略 */ }
  return INSTRUMENTS[0].id;
}

function saveInstrumentId(id) {
  try { localStorage.setItem(INSTRUMENT_KEY, String(id)); } catch (e) { /* 忽略 */ }
}

const CHEERS = ['太棒了！', '保持节奏！', '就是这个感觉！', '跟着灯光摇摆！', '你是最棒的！', '节奏不能停！'];
const MODE_LABEL = { rhythm: 'DJ 节奏', instrument: '乐器创作', free: '自由舞台' };
/* ui 菜单 mode → stage3d 氛围配色 mode */
const STAGE_MODE = { rhythm: 'dj', instrument: 'create', free: 'free' };

/* 结算评级（按本曲满分估算比例：S≥55% / A≥40% / B≥25%，其余 C） */
const GRADE_COLOR = { S: '#ffd700', A: '#00e5ff', B: '#7b2bff', C: '#8a86a3' };

/* ============================== 全局状态 ============================== */

const S = {
  state: 'MENU',          // MENU | GUIDE | PLAYING | RESULT
  mode: 'rhythm',         // rhythm | instrument | free（ui 菜单语义）
  players: 1,             // 1 | 2
  hasCamera: false,
};

const audio = new AudioEngine();
const stage = new Stage3D();
const guideSeen = { rhythm: false, instrument: false, free: false };

let poseCtl = null;       // initPose 返回的控制器（stop/fps/numPoses）
let poseNumPoses = 0;     // 当前感知实例的人数档位（不匹配需重建）
let latestPersons = [];   // 最近一帧姿态（onResults 异步写入，渲染循环消费）
let poseFps = 0;

let pendingBeats = [];    // 待到点的拍 audioTime 队列（升序，onBeat 提前 ~0.1s 排入）
let pulse = 0;            // 节拍脉冲 0..1：拍到点置 1，每帧 *0.85 衰减
let lastDebugTs = 0;
let lastTrackInfo = '';
let lastFrameTs = 0;

/* 每玩家动作检测状态（保持式冷却 / 下蹲连击帧 / 右腕上帧 y） */
function mkMotion() {
  return {
    lastL: 0, lastR: 0, lastBoth: 0, lastSquat: 0, lastGtr: 0,
    squatRun: 0, prevRWristY: null,
  };
}
const motion = [mkMotion(), mkMotion()];

/* DJ 模式状态（QQ 炫舞式下落音符） */
const dj = {
  song: null,             // 当前曲目（tracks.js 数据）
  notes: [],              // 飞行中 / 淡出中的音符
  noteSeq: 0,             // 音符 uid 自增（stage3d mesh 池绑定键）
  maxPossible: 0,         // 满分估算：Σ 每音符 300 × 加成上界 1.5
  scores: [0, 0],
  combos: [0, 0],
  maxCombos: [0, 0],
  clearAt: [0, 0],        // 清屏技上次触发时刻（noteClock 秒，按玩家独立冷却）
  startAt: 0,             // 开局时刻（noteClock：AudioContext 优先，兜底 performance.now）
  audioOk: false,         // startSong 是否成功（失败切换本地兜底节奏流）
  fbNext: 0,              // 兜底流下一音符 hitTime（noteClock 秒）
  fbStep: 0,              // 兜底流步进游标
  songEndAt: 0,           // 曲目停止时刻（结算确认 / 强制结算安全网）
  ended: false,           // 是否已触发结算
};

/* 创作模式状态 */
let instrumentIdx = 0;   // 当前乐器包下标（INSTRUMENTS，选乐器面板确定，默认梦幻钢琴）
const create = {
  chordIdx: 0,            // C-F-G-Am 轮换游标
  recording: false,
  recStart: 0,
  recEvents: [],          // [{ dt, kind, data }]
  recEndTimer: 0,
  recTimers: [],          // 回放 setTimeout 队列（可叠加）
};

/* 自由模式状态 */
const freeState = { cheerIdx: 0 };

/* ============================== 小工具 ============================== */

function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }
function audioTimeNow() { return audio.ctx ? audio.ctx.currentTime : 0; }

/* 音符判定专用时钟：AudioContext.currentTime（与 startSong 调度的 audioTime 同源）；
 * 音频不可用时兜底 performance.now，保证键盘路径可玩（勿混用两种时钟） */
function noteClock() {
  return audio.ctx ? audio.ctx.currentTime : performance.now() / 1000;
}

/* 连击加成：≥10 ×1.2，≥30 ×1.5 */
function comboMult(combo) {
  return combo >= 30 ? 1.5 : combo >= 10 ? 1.2 : 1;
}

/* 手腕归一化 y（0 顶 1 底）→ 音高序号：手越高音越高 */
function wristToPentaIdx(y) {
  const t = clamp((0.75 - y) / 0.55, 0, 1);   // y=0.75 垂手 → 最低音，y=0.20 举过头 → 最高音
  return Math.round(t * (PENTA.length - 1));
}
function wristToGtrIdx(y) {
  const t = clamp((0.80 - y) / 0.55, 0, 1);
  return Math.round(t * (GTR_NOTES.length - 1));
}

/* ============================== 通用反馈 ============================== */

/* 打击视觉：灯光爆闪 + 粒子爆发 */
function laneFx(lane) {
  stage.flash(lane);
  stage.spawnBurst(lane);
}

/* 打击音效：左=底鼓 右=军鼓 双=镲 蹲=低音炮（立即响） */
function laneSound(lane) {
  const t = audioTimeNow();
  if (lane === 'left') audio.playKick(t);
  else if (lane === 'right') audio.playSnare(t);
  else if (lane === 'both') audio.playCymbal(t);
  else audio.playBass(55, t, 0.3);
}

/* ============================== 姿态动作检测 ============================== */

/* onResults 异步回调：更新骨架数据 + 保持式动作检测（冷却 / 消抖） */
function onPoseResults(res) {
  latestPersons = (res && res.persons) || [];
  poseFps = (res && res.fps) || 0;
  if (S.state !== 'PLAYING') return;   // 菜单 / 结算时不检测动作（骨架照常驱动舞台人偶）

  const now = performance.now();
  const armCd = S.mode === 'instrument' ? ARM_CD_CREATE : ARM_CD_DJ;
  const n = Math.min(latestPersons.length, S.players);

  for (let i = 0; i < n; i++) {
    const lm = latestPersons[i] && latestPersons[i].landmarks;
    if (!lm) continue;
    const m = motion[i];
    const upL = armRaised(lm, 'left');
    const upR = armRaised(lm, 'right');

    /* 双手同举优先于单侧（both）；触发时同步冷却两侧防连发 */
    if (upL && upR) {
      if (now - m.lastBoth >= BOTH_CD) {
        m.lastBoth = now; m.lastL = now; m.lastR = now;
        handleAction(i, 'both', lm);
      }
    } else if (upL && now - m.lastL >= armCd) {
      m.lastL = now;
      handleAction(i, 'left', lm);
    } else if (upR && now - m.lastR >= armCd) {
      m.lastR = now;
      handleAction(i, 'right', lm);
    }

    /* 创作模式：右手快速下压（手腕 y 单帧下移 > 0.07）→ 吉他扫弦 */
    if (S.mode === 'instrument' && now - m.lastGtr >= GTR_CD) {
      const rw = lm[16];
      if (rw && rw.v >= 0.1) {
        if (m.prevRWristY != null && rw.y - m.prevRWristY > 0.07) {
          m.lastGtr = now;
          jam('guitar', wristToGtrIdx(rw.y));
        }
        m.prevRWristY = rw.y;
      } else {
        m.prevRWristY = null;
      }
    }

    /* 下蹲：连续 3 帧确认 + 800ms 冷却 */
    if (isSquat(lm)) {
      m.squatRun++;
      if (m.squatRun >= SQUAT_FRAMES && now - m.lastSquat >= SQUAT_CD) {
        m.lastSquat = now;
        m.squatRun = 0;
        handleAction(i, 'squat', lm);
      }
    } else {
      m.squatRun = 0;
    }
  }
}

/* 动作统一入口（姿态触发）：按当前模式分发 */
function handleAction(pi, lane, lm) {
  if (S.state !== 'PLAYING') return;
  if (S.mode === 'rhythm') {
    laneFx(lane);        // 动作本身的灯光反馈（命中音符另有 noteHit 爆闪）
    laneSound(lane);     // 空按也有打击音（自由打拍感），命中音由曲目本身承担
    djJudgeAction(pi, lane);
  } else if (S.mode === 'instrument') {
    createAction(pi, lane, lm);
  } else {
    freeAction(pi, lane);
  }
}

/* ============================== DJ 节奏模式 ============================== */

function startDJ(song) {
  pendingBeats = [];
  pulse = 0;
  dj.notes = [];
  dj.noteSeq = 0;
  dj.maxPossible = 0;
  dj.scores = [0, 0];
  dj.combos = [0, 0];
  dj.maxCombos = [0, 0];
  dj.clearAt = [0, 0];
  dj.startAt = 0;
  dj.fbNext = 0;
  dj.fbStep = 0;
  dj.songEndAt = 0;
  dj.ended = false;
  if (song) dj.song = song;
  stage.clearNotes();

  let ok = true;
  try {
    audio.startSong(dj.song, { onBeat: onDJBeat, onNote: onDJNote });
  } catch (err) {
    ok = false;
    console.warn('[game] startSong 失败，切换本地兜底节奏：', err);
  }
  dj.audioOk = ok;
  dj.startAt = noteClock();
  if (!ok) {
    dj.fbNext = dj.startAt + 1.0;   // 兜底流 1 秒后开跑
  }

  const diff = Math.min(3, Math.max(1, (dj.song && dj.song.difficulty) || 1));
  setHud({
    p1Score: 0, p1Combo: 0,
    p2Score: S.players === 2 ? 0 : null, p2Combo: S.players === 2 ? 0 : undefined,
    trackInfo: ((dj.song && dj.song.name) || 'UNTITLED') + ' · ' + ((dj.song && dj.song.bpm) || '--')
      + ' BPM · ' + '★'.repeat(diff) + (ok ? '' : ' · 无音频兜底'),
  });
  showJudge('接住下落音符：左 / 右 / 双手 · 下蹲清屏！', '#00e5ff');
}

/* 每拍回调（音频调度线程提前 ~0.1s 触发）：只驱动视觉节拍脉冲，判定由音符负责 */
function onDJBeat(beatIndex, barIndex, audioTime) {
  if (S.state !== 'PLAYING' || S.mode !== 'rhythm') return;
  pendingBeats.push(audioTime);
}

/* startSong 提前排程回调：收到即生成音符开始飞行。
 * 飞行进度由 hitTime 计算，与回调到达时刻无关；飞行时长取
 * min(NOTE_TRAVEL, hitTime - 收到时刻)：Taylor 提前量不足 2s 时
 * 音画仍同步（飞行变短），提前 ≥2.2s 时完整 2 秒飞行 */
function onDJNote(n) {
  if (S.state !== 'PLAYING' || S.mode !== 'rhythm') return;
  if (!n || !isFinite(n.audioTime)) return;
  const lane = Math.min(3, Math.max(0, Math.round(Number(n.lane) || 0)));
  const travel = Math.min(NOTE_TRAVEL, Math.max(0.12, Number(n.audioTime) - noteClock()));
  dj.notes.push({
    uid: ++dj.noteSeq,
    lane,
    hitTime: Number(n.audioTime),
    travel,
    dur: Math.max(0, Number(n.dur) || 0),
    judged: [false, false],   // 双人独立判定标记
    grade: [null, null],      // 每玩家 grade（miss 亦记，用于视觉态）
    doneAt: null,             // 全员判定时刻（淡出删除计时用）
  });
  dj.maxPossible += SCORE_BASE.perfect * 1.5;   // 满分估算：按加成上界累计
}

/* 玩家动作 → 判定分发（姿态与键盘共用）。action: 'left'|'right'|'both'|'squat'。
 * 空按（无音符在窗口）不惩罚：findHittable 找不到就不做任何事 */
function djJudgeAction(pi, action) {
  if (S.state !== 'PLAYING' || S.mode !== 'rhythm') return;
  if (action === 'squat') { djClearSkill(pi); return; }
  const now = noteClock();
  const lanes = ACT_LANES[action] || [];
  for (const ln of lanes) {
    const note = findHittable(pi, ln, now);
    if (!note) continue;
    const grade = gradeForDiff(Math.abs(now - note.hitTime));
    applyGrade(pi, note, grade);
    stage.noteHit(note.lane, grade);
    showJudge((S.players === 2 ? 'P' + (pi + 1) + ' ' : '') + JUDGE_LABEL[grade], JUDGE_COLOR[grade]);
  }
}

/* 在判定窗口内找玩家 pi 未判定、lane 匹配、离 hitTime 最近的音符；无则返回 null。
 * 早按 ≤ WIN_GOOD（0.32s）；晚按 ≤ MISS_GRACE（0.25s，与 MISS 补记时刻一致，
 * 因此不存在“已判 MISS 后还能 GOOD”的矛盾区 */
function findHittable(pi, lane, now) {
  let best = null, bestDiff = Infinity;
  for (const n of dj.notes) {
    if (n.judged[pi] || n.lane !== lane) continue;
    const diff = now - n.hitTime;
    if (diff < -WIN_GOOD || diff > MISS_GRACE) continue;
    const ad = Math.abs(diff);
    if (ad < bestDiff) { bestDiff = ad; best = n; }
  }
  return best;
}

function gradeForDiff(ad) {
  return ad <= WIN_PERFECT ? 'perfect' : ad <= WIN_GREAT ? 'great' : 'good';
}

/* 计分 + 连击推进（判定文案 / 视觉反馈由调用方负责） */
function applyGrade(pi, note, grade) {
  note.judged[pi] = true;
  note.grade[pi] = grade;
  const combo = ++dj.combos[pi];
  dj.maxCombos[pi] = Math.max(dj.maxCombos[pi], combo);
  dj.scores[pi] += Math.round(SCORE_BASE[grade] * comboMult(combo));
  updateScoresHud();
}

/* 清屏技（下蹲 / L）：清除未来 2 秒内该玩家所有未判音符记 GREAT，冷却 5 秒。
 * 没清到任何音符时不消耗冷却（等同普通动作，不惩罚） */
function djClearSkill(pi) {
  const now = noteClock();
  if (now - dj.clearAt[pi] < CLEAR_CD) return;
  let cleared = 0;
  for (const n of dj.notes) {
    if (n.judged[pi]) continue;
    if (n.hitTime < now || n.hitTime > now + CLEAR_WINDOW) continue;
    applyGrade(pi, n, 'great');
    stage.noteHit(n.lane, 'great');
    cleared++;
  }
  if (!cleared) return;
  dj.clearAt[pi] = now;
  stage.flash('squat');
  stage.spawnBurst('squat');
  showJudge((S.players === 2 ? 'P' + (pi + 1) + ' ' : '') + '清屏技 ×' + cleared + '！', '#ffcf5c');
}

function updateScoresHud() {
  setHud({
    p1Score: dj.scores[0], p1Combo: dj.combos[0],
    p2Score: S.players === 2 ? dj.scores[1] : undefined,
    p2Combo: S.players === 2 ? dj.combos[1] : undefined,
  });
}

/* DJ 逐帧：MISS 补记 / 兜底音符流 / 音符视觉喂数 / 结算检测 */
function djTick() {
  const now = noteClock();

  /* 1. MISS 补记：越过判定线 0.25s 仍未判 → 断连击（晚按侧窗口已截断，无矛盾区） */
  let missAny = false;
  for (const n of dj.notes) {
    if (now <= n.hitTime + MISS_GRACE) continue;
    for (let pi = 0; pi < S.players; pi++) {
      if (!n.judged[pi]) {
        n.judged[pi] = true;
        n.grade[pi] = 'miss';
        dj.combos[pi] = 0;
        missAny = true;
      }
    }
  }
  if (missAny) showJudge('MISS', JUDGE_COLOR.miss);

  /* 2. 音频不可用兜底：本地假时钟均匀生成四 lane 音符流，键盘路径照常可玩
   * （提前 NOTE_TRAVEL+0.2s 生成，兜底音符也享完整 2 秒飞行） */
  if (!dj.audioOk && dj.fbNext > 0) {
    while (dj.fbNext < now + NOTE_TRAVEL + 0.2 && dj.fbNext - dj.startAt <= FB_LEN) {
      dj.notes.push({
        uid: ++dj.noteSeq,
        lane: dj.fbStep % 4,
        hitTime: dj.fbNext,
        travel: NOTE_TRAVEL,
        dur: 0,
        judged: [false, false],
        grade: [null, null],
        doneAt: null,
      });
      dj.maxPossible += SCORE_BASE.perfect * 1.5;
      dj.fbNext += 60 / FB_BPM;   // 四分音符一颗
      dj.fbStep++;
    }
  }

  /* 3. 音符视觉：算好进度/状态喂给 3D 舞台（p=1 到判定线，判定后冻结在 1） */
  stage.setNotes(now, dj.notes.map((n) => {
    const done = n.judged[0] && (S.players === 1 || n.judged[1]);
    let state = 'fly', grade = null;
    if (done) {
      for (let pi = 0; pi < S.players; pi++) {
        const g = n.grade[pi];
        if (g && g !== 'miss' && (!grade || GRADE_RANK[g] < GRADE_RANK[grade])) grade = g;
      }
      state = grade ? 'hit' : 'miss';   // 全 miss → 灰淡；有命中 → 按最好 grade 爆裂
    }
    return {
      uid: n.uid, lane: n.lane, dur: n.dur, state, grade,
      p: done ? 1 : clamp(1 - (n.hitTime - now) / (n.travel || NOTE_TRAVEL), 0, 1.15),
    };
  }));

  /* 4. 清理已完成淡出的音符（判定完成后 0.35s 从数组移除，淡出动画由 stage3d 接管） */
  for (let i = dj.notes.length - 1; i >= 0; i--) {
    const n = dj.notes[i];
    if (!(n.judged[0] && (S.players === 1 || n.judged[1]))) continue;
    if (n.doneAt == null) n.doneAt = now;
    else if (now - n.doneAt > 0.35) dj.notes.splice(i, 1);
  }

  /* 5. 结算：曲目播完（startSong 曲尾自动停 → running=false；ESC 的 stopTrack 会先
   *    把状态切离 PLAYING，不会走到这里）且全部音符判定完毕 → 结算屏。
   *    安全网：曲停 5 秒仍未清完（异常中断）强制结算 */
  if (dj.startAt > 0 && !dj.ended) {
    const songDone = dj.audioOk
      ? (!audio.getUserTrackInfo().running && now - dj.startAt > 1.5)
      : (now - dj.startAt > FB_LEN + 1.0);
    if (songDone) {
      if (!dj.songEndAt) dj.songEndAt = now;
      if (dj.notes.length === 0 || now - dj.songEndAt > 5) {
        endDJ();
        return;
      }
    }
  }
}

function endDJ() {
  dj.ended = true;
  audio.stopTrack();
  dj.notes = [];
  stage.clearNotes();
  S.state = 'RESULT';
  showResult();
}

/* ============================== 结算屏（动态注入，不改 style.css） ============================== */

let resultEl = null;

/* 评级：按本曲满分估算比例（S≥55% / A≥40% / B≥25%，其余 C） */
function gradeOf(score) {
  const full = Math.max(1, dj.maxPossible);
  const r = score / full;
  return r >= 0.55 ? 'S' : r >= 0.40 ? 'A' : r >= 0.25 ? 'B' : 'C';
}

function ensureResultStyle() {
  if (document.getElementById('mwdjResultStyle')) return;
  const st = document.createElement('style');
  st.id = 'mwdjResultStyle';
  st.textContent = [
    '#mwdjResult{position:fixed;inset:0;z-index:55;display:flex;align-items:center;justify-content:center;',
    'background:rgba(3,0,10,.78);backdrop-filter:blur(8px)}',
    '.r-card{width:min(560px,92vw);padding:32px 30px 26px;border-radius:24px;text-align:center;',
    'background:linear-gradient(180deg,rgba(16,8,38,.97),rgba(8,3,22,.97));',
    'border:1.5px solid rgba(0,229,255,.4);',
    'box-shadow:0 0 30px rgba(0,229,255,.18),0 0 70px rgba(255,43,214,.12),0 30px 80px rgba(0,0,0,.6);',
    'animation:rIn .28s cubic-bezier(.2,1.3,.4,1)}',
    '@keyframes rIn{from{transform:scale(.88);opacity:0}to{transform:scale(1);opacity:1}}',
    '.r-title{font-size:1.6rem;font-weight:900;letter-spacing:.3em;text-indent:.3em;margin-bottom:20px;',
    'background:linear-gradient(92deg,#00e5ff,#ff2bd6);-webkit-background-clip:text;background-clip:text;color:transparent}',
    '.r-row{display:flex;align-items:center;gap:14px;padding:12px 16px;margin-bottom:10px;border-radius:14px;',
    'background:rgba(255,255,255,.045);border:1px solid rgba(123,43,255,.28)}',
    '.r-p1{border-color:rgba(0,229,255,.4)}',
    '.r-p2{border-color:rgba(255,43,214,.4)}',
    '.r-who{font-size:1.05rem;font-weight:800;letter-spacing:.1em;color:#f4f1ff}',
    '.r-p1 .r-who{color:#00e5ff}',
    '.r-p2 .r-who{color:#ff2bd6}',
    '.r-grade{font-family:"Segoe UI","Arial Black",Impact,sans-serif;font-size:2.2rem;font-weight:900;',
    'line-height:1;margin-left:auto}',
    '.r-score{font-size:1.15rem;font-weight:800;color:#f4f1ff;white-space:nowrap}',
    '.r-combo{font-size:.85rem;font-weight:700;color:rgba(233,226,255,.72);white-space:nowrap}',
    '.r-best{margin:8px 0 18px;font-size:1rem;letter-spacing:.08em;color:rgba(233,226,255,.72)}',
    '.r-new{margin-left:10px;color:#ffc93c;font-weight:900;text-shadow:0 0 10px rgba(255,201,60,.5)}',
    '.r-btns{display:flex;gap:12px}',
    '.r-btn{flex:1;padding:14px 0;border:none;border-radius:14px;font-family:inherit;font-size:1.08rem;',
    'font-weight:900;letter-spacing:.16em;text-indent:.16em;cursor:pointer;',
    'transition:filter .15s ease,transform .1s ease}',
    '.r-again{color:#04121a;background:linear-gradient(92deg,#00e5ff,#7df0ff 60%,#ff2bd6 130%);',
    'box-shadow:0 0 20px rgba(0,229,255,.4)}',
    '.r-menu{color:#f4f1ff;background:rgba(255,255,255,.08);border:1px solid rgba(255,255,255,.25)}',
    '.r-btn:hover{filter:brightness(1.12)}',
    '.r-btn:active{transform:scale(.97)}'
  ].join('');
  document.head.appendChild(st);
}

/* 历史最高分（按曲子分档）：mwdj_best_v1 = { [songId]: {score, combo, grade} }。
 * 旧格式（纯数字/解析失败）直接重置；读写全程 try/catch（隐私模式可能抛错） */
function loadBestMap() {
  try {
    const raw = localStorage.getItem(BEST_KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
    if (raw != null) localStorage.removeItem(BEST_KEY);   // 旧数字格式：重置
  } catch (e) { /* 忽略 */ }
  return {};
}

function showResult() {
  ensureResultStyle();
  hideResult();

  /* 本曲最高分：双人取两人较高者入库 */
  const songId = (dj.song && dj.song.id) || 'unknown';
  const top = Math.max(dj.scores[0], S.players === 2 ? dj.scores[1] : 0);
  const topPi = (S.players === 2 && dj.scores[1] > dj.scores[0]) ? 1 : 0;
  const bestMap = loadBestMap();
  const prev = bestMap[songId] || null;
  const prevBest = prev ? (prev.score || 0) : 0;
  const isNew = top > prevBest;
  if (isNew) {
    bestMap[songId] = { score: top, combo: dj.maxCombos[topPi], grade: gradeOf(top) };
    try { localStorage.setItem(BEST_KEY, JSON.stringify(bestMap)); } catch (e) { /* 忽略 */ }
  }
  const best = Math.max(prevBest, top);

  const rowHtml = (pi) => {
    const score = dj.scores[pi];
    const g = gradeOf(score);
    return '<div class="r-row r-p' + (pi + 1) + '">' +
      '<span class="r-who">玩家 ' + (pi + 1) + '</span>' +
      '<span class="r-score">' + score + ' 分</span>' +
      '<span class="r-combo">最高连击 ×' + dj.maxCombos[pi] + '</span>' +
      '<span class="r-grade" style="color:' + GRADE_COLOR[g] + '">' + g + '</span>' +
      '</div>';
  };

  const el = document.createElement('div');
  el.id = 'mwdjResult';
  el.innerHTML =
    '<div class="r-card">' +
      '<h2 class="r-title">本局结算</h2>' +
      rowHtml(0) +
      (S.players === 2 ? rowHtml(1) : '') +
      '<p class="r-best">本曲最高 ' + best + ' 分' + (isNew ? '<b class="r-new">新纪录！</b>' : '') + '</p>' +
      '<div class="r-btns">' +
        '<button class="r-btn r-again" type="button">再来一局</button>' +
        '<button class="r-btn r-menu" type="button">返回菜单</button>' +
      '</div>' +
    '</div>';
  document.body.appendChild(el);
  resultEl = el;
  el.querySelector('.r-again').addEventListener('click', () => {
    hideResult();
    S.state = 'PLAYING';
    startDJ(dj.song);   // 同曲重开
  });
  el.querySelector('.r-menu').addEventListener('click', backToMenu);
}

function hideResult() {
  if (resultEl) {
    resultEl.remove();
    resultEl = null;
  }
}

/* ============================== 乐器创作模式 ============================== */

function startCreate() {
  const pack = INSTRUMENTS[instrumentIdx] || INSTRUMENTS[0];
  lastTrackInfo = '';
  setHud({
    p1Score: 0, p1Combo: 0,
    p2Score: S.players === 2 ? 0 : null, p2Combo: S.players === 2 ? 0 : undefined,
    trackInfo: pack.name + ' · LIVE JAM',
  });
  showJudge('左臂音阶 · 右手扫弦 · 下蹲和弦 · 双手彩蛋', '#ffcf5c');
}

/* 创作模式姿态动作分发 */
function createAction(pi, lane, lm) {
  if (lane === 'left') {
    /* 左臂高度映射 C 大调五声音阶（音色随当前乐器包，冷却 200ms/侧） */
    const lw = lm && lm[15];
    const y = lw && lw.v >= 0.1 ? lw.y : 0.5;
    jam('piano', wristToPentaIdx(y));
  } else if (lane === 'both') {
    /* 双手同举：彩蛋音 + 灯光爆闪 */
    jam('cymbal', -1);
  } else if (lane === 'squat') {
    /* 下蹲：和弦按蹲的次数轮换（进行随乐器包）+ 底鼓 */
    const ci = create.chordIdx;
    create.chordIdx = (create.chordIdx + 1) % CHORDS.length;
    jam('chord', ci);
  }
  /* lane === 'right'：右手高举保持不发声（吉他由"快速下压"事件触发） */
}

/* 创作模式统一发声入口：按当前乐器包发声 + 视觉 + 录制记录。
 * kind → 包方法映射：'piano'→scale / 'guitar'→strum / 'chord'→chord / 'cymbal'→egg；
 * 录制流只记 kind/data，回放（jamSound）自动套用回放时所选包的音色 */
function jam(kind, data) {
  if (S.state !== 'PLAYING' || S.mode !== 'instrument') return;
  jamSound(kind, data);
  jamFx(kind);
  if (create.recording) {
    create.recEvents.push({
      dt: (performance.now() - create.recStart) / 1000,
      kind, data,
    });
  }
}

function jamSound(kind, data) {
  const pack = INSTRUMENTS[instrumentIdx] || INSTRUMENTS[0];
  const t = audioTimeNow();
  if (kind === 'piano') {
    pack.scale(Number(data) || 0, t);      // 音阶（五声音阶 8 音序号）
  } else if (kind === 'guitar') {
    pack.strum(Number(data) || 0, t);      // 扫弦（吉他音域序号）
  } else if (kind === 'chord') {
    pack.chord(Number(data) || 0, t);      // 和弦（轮换序号，进行随乐器包）
    audio.playKick(t);                     // 叠一脚底鼓（各包一致）
  } else {
    pack.egg(t);                           // 双手同举彩蛋音
  }
}

function jamFx(kind) {
  if (kind === 'piano') { stage.flash('left'); stage.spawnBurst('left'); }
  else if (kind === 'guitar') { stage.flash('right'); stage.spawnBurst('right'); }
  else if (kind === 'chord') { stage.flash('squat'); stage.spawnBurst('squat'); }
  else { stage.flash('both'); stage.spawnBurst('both'); }
}

/* 录制 / 回放：R 开启 8 秒录制（仅 recEvents 为空时）；录制中再按 R 立即结束并回放；
 * 录制自然结束后（已有内容且未在录）再按 R 回放而非覆盖新录制；
 * 事件流只记 kind/data，回放音色跟随回放时所选乐器包 */
function toggleRecord() {
  if (S.state !== 'PLAYING' || S.mode !== 'instrument') return;
  if (create.recording) {
    stopRecording();
    playRecording();
  } else if (create.recEvents.length) {
    playRecording();          // 已有录制内容：R = 回放
  } else {
    startRecording();         // 无录制内容：R = 开启录制
  }
}

function startRecording() {
  create.recording = true;
  create.recStart = performance.now();
  create.recEvents = [];
  clearTimeout(create.recEndTimer);
  create.recEndTimer = setTimeout(() => {
    if (create.recording) {
      create.recording = false;
      showJudge('录制结束 · 按 R 回放', '#00e5ff');
    }
  }, REC_SECONDS * 1000);
  showJudge('开始录制（8 秒）', '#ff2bd6');
}

function stopRecording() {
  create.recording = false;
  clearTimeout(create.recEndTimer);
}

function playRecording() {
  if (!create.recEvents.length) {
    showJudge('还没有录制内容 · 按 R 开始录制', '#ffcf5c');
    return;
  }
  const evs = create.recEvents.slice();
  evs.forEach((ev) => {
    create.recTimers.push(setTimeout(() => {
      jamSound(ev.kind, ev.data);
      jamFx(ev.kind);
    }, Math.max(0, ev.dt * 1000)));
  });
  showJudge('回放中（' + evs.length + ' 个动作）', '#00e5ff');
}

function clearJamTimers() {
  create.recTimers.forEach(clearTimeout);
  create.recTimers = [];
  clearTimeout(create.recEndTimer);
  create.recording = false;
}

/* 创作模式逐帧：HUD 提示录制状态（仅在文本变化时写 DOM） */
function createTick() {
  const nm = (INSTRUMENTS[instrumentIdx] || INSTRUMENTS[0]).name;
  let info;
  if (create.recording) {
    info = nm + ' · LIVE JAM · 录制中 ' + ((performance.now() - create.recStart) / 1000).toFixed(1) + 's';
  } else if (create.recEvents.length) {
    info = nm + ' · LIVE JAM · 已录 ' + create.recEvents.length + ' 个动作（R 回放）';
  } else {
    info = nm + ' · LIVE JAM · 身体即乐器';
  }
  if (info !== lastTrackInfo) {
    lastTrackInfo = info;
    setHud({ trackInfo: info });
  }
}

/* ============================== 自由舞台模式 ============================== */

function startFree() {
  freeState.cheerIdx = 0;
  pendingBeats = [];
  pulse = 0;
  try {
    audio.startTrack('house', 110, {
      onBeat: (bi, bar, at) => { pendingBeats.push(at); },
    });
  } catch (err) {
    console.warn('[game] 自由模式音序器启动失败：', err);
  }
  setHud({
    p1Score: 0, p1Combo: 0,
    p2Score: S.players === 2 ? 0 : null, p2Combo: S.players === 2 ? 0 : undefined,
    trackInfo: 'FREE STAGE · 110 BPM',
  });
  showJudge('想怎么动就怎么动！', '#7cffb2');
}

/* 动作宽容：任何有效动作即触发音效 + 灯光 + 鼓励语，不计分 */
function freeAction(pi, lane) {
  laneFx(lane);
  laneSound(lane);
  showJudge(CHEERS[freeState.cheerIdx % CHEERS.length], '#7cffb2');
  freeState.cheerIdx++;
}

/* ============================== 模式总控与状态机 ============================== */

/* initUI 回调：处在菜单点击（用户手势）上下文中 */
function onModeStart(mode, players) {
  S.mode = mode;
  S.players = players;
  /* AudioContext 必须在用户手势回调内 init+resume */
  try {
    audio.init();
    audio.resume();
  } catch (err) {
    console.warn('[game] 音频初始化失败：', err);
    showJudge('音频不可用：' + ((err && err.message) || err), '#ff2bd6');
  }
  /* DJ 模式：先进选曲面板（曲库按难度排序），选中后再引导/开局；ESC/返回回菜单 */
  if (mode === 'rhythm') {
    S.state = 'PICKING';
    showSongPicker(songsByDifficulty(), {
      onPick: (song) => {
        hideSongPicker();
        dj.song = song;
        if (!guideSeen.rhythm) {
          guideSeen.rhythm = true;
          S.state = 'GUIDE';
          showGuide();
          setGuideDismissed(() => beginMode('rhythm', players));
        } else {
          beginMode('rhythm', players);
        }
      },
      onBack: () => { hideSongPicker(); backToMenu(); },
    });
    return;
  }
  /* 创作模式：先进乐器选择面板（上次选择默认高亮），选中后引导/开局；ESC/返回回菜单 */
  if (mode === 'instrument') {
    S.state = 'PICKING';
    showInstrumentPicker(INSTRUMENTS, loadInstrumentId(), {
      onPick: (pack) => {
        hideInstrumentPicker();
        instrumentIdx = Math.max(0, INSTRUMENTS.indexOf(pack));
        saveInstrumentId(pack.id);
        if (!guideSeen.instrument) {
          guideSeen.instrument = true;
          S.state = 'GUIDE';
          showGuide();
          setGuideDismissed(() => beginMode('instrument', players));
        } else {
          beginMode('instrument', players);
        }
      },
      onBack: () => { hideInstrumentPicker(); backToMenu(); },
    });
    return;
  }
  /* 引导弹窗：每种模式仅首次 */
  if (!guideSeen[mode]) {
    guideSeen[mode] = true;
    S.state = 'GUIDE';
    showGuide();
    setGuideDismissed(() => beginMode(mode, players));
  } else {
    beginMode(mode, players);
  }
}

async function beginMode(mode, players) {
  S.state = 'PLAYING';

  /* 感知层：已初始化且人数档位匹配则复用；失败不阻塞，可玩键盘模式 */
  let camOk = false;
  if (poseCtl && poseNumPoses === players) {
    camOk = true;
  } else {
    showLoading('正在启动摄像头…');
    try {
      if (poseCtl) {
        poseCtl.stop();
        poseCtl = null;
        poseNumPoses = 0;
      }
      const ctl = await initPose({
        videoEl: document.getElementById('camVideo'),
        numPoses: players,
        onResults: onPoseResults,
        onStatus: onPoseStatus,
      });
      /* 打断复查：加载窗口（可 10 秒+）内 ESC 回菜单后，async 续体不得继续开播 */
      if (S.state !== 'PLAYING' || S.mode !== mode) {
        ctl.stop();
        hideLoading();
        return;
      }
      poseCtl = ctl;
      poseNumPoses = players;
      camOk = true;
    } catch (err) {
      /* 失败路径同样复查：权限弹窗挂起期间也可能 ESC，失败后不得继续开播 */
      if (S.state !== 'PLAYING' || S.mode !== mode) {
        hideLoading();
        return;
      }
      camOk = false;
      poseCtl = null;
      poseNumPoses = 0;
      console.warn('[game] 感知层不可用，切换键盘模式：', err);
    }
  }
  S.hasCamera = camOk;
  setCamMode(camOk);   // 无摄像头：隐藏画中画 + 显示键盘降级按钮

  /* 舞台氛围与人数（ui 菜单 mode → stage3d 配色 mode） */
  stage.setMode(STAGE_MODE[mode] || 'dj');
  stage.setPlayers(players);

  /* 重置动作检测状态 */
  motion[0] = mkMotion();
  motion[1] = mkMotion();

  if (mode === 'rhythm') startDJ(dj.song);
  else if (mode === 'instrument') startCreate();
  else startFree();

  hideLoading();
  if (!camOk) showJudge('摄像头不可用 · 键盘 J / K / L / I 照样玩', '#ff2bd6');
}

/* 感知层状态上报：降级提示给用户，错误只落控制台（失败已由 beginMode 兜底） */
function onPoseStatus(st) {
  if (!st) return;
  if (st.type === 'fallback') {
    showJudge('GPU 不可用，已降级 CPU 推理', '#ffcf5c');
  } else if (st.type === 'error') {
    console.warn('[game] 感知层错误：', st.message);
  }
}

/* ESC / 结算屏「返回菜单」：回菜单（stopTrack、隐藏 HUD、恢复菜单层） */
function backToMenu() {
  audio.stopTrack();
  hideGuide();
  hideResult();
  hideSongPicker();         // 选曲面板可能开着（ESC / 面板返回按钮）
  hideInstrumentPicker();   // 乐器选择面板同理
  hideLoading();   // 加载期间 ESC：遮罩可能仍显示，回菜单必须收起
  clearJamTimers();
  dj.notes = [];
  dj.ended = false;
  stage.clearNotes();
  pendingBeats = [];
  pulse = 0;
  S.state = 'MENU';
  const hud = document.getElementById('hudTop');
  if (hud) hud.classList.add('hidden');
  const menu = document.getElementById('menuOverlay');
  if (menu) {
    menu.classList.remove('gone');
    menu.classList.add('ready');
  }
}

/* ============================== 键盘 / 触屏降级 ============================== */

document.addEventListener('keydown', (e) => {
  if (e.repeat) return;
  if (e.code === 'Escape') { backToMenu(); return; }
  if (e.code === 'KeyR' && S.state === 'PLAYING' && S.mode === 'instrument') {
    toggleRecord();
    return;
  }
  if (S.state !== 'PLAYING') return;

  /* 创作模式键盘：J=音阶 K=扫弦 L=和弦 I=彩蛋（均走当前乐器包音色） */
  if (S.mode === 'instrument') {
    const kb = { KeyJ: 'piano', KeyK: 'guitar', KeyL: 'chord', KeyI: 'cymbal' }[e.code];
    if (!kb) return;
    if (kb === 'piano') {
      jam('piano', Math.floor(Math.random() * PENTA.length));
    } else if (kb === 'guitar') {
      jam('guitar', Math.floor(Math.random() * GTR_NOTES.length));
    } else if (kb === 'chord') {
      const ci = create.chordIdx;
      create.chordIdx = (create.chordIdx + 1) % CHORDS.length;
      jam('chord', ci);
    } else {
      jam('cymbal', -1);
    }
    return;
  }

  /* DJ / 自由模式键盘：J=左 K=右 L=蹲(清屏技) I=双手（键盘无法区分玩家，双人时判定双方） */
  const action = { KeyJ: 'left', KeyK: 'right', KeyL: 'squat', KeyI: 'both' }[e.code];
  if (!action) return;
  if (S.mode === 'rhythm') {
    laneFx(action);
    laneSound(action);
    djJudgeAction(0, action);
    if (S.players === 2) djJudgeAction(1, action);
  } else {
    freeAction(0, action);
  }
});

/* ============================== 渲染循环 ============================== */

function loop(now) {
  requestAnimationFrame(loop);

  /* dt：秒，夹取防切后台炸帧 */
  let dt = (now - lastFrameTs) / 1000;
  lastFrameTs = now;
  if (!isFinite(dt) || dt <= 0) dt = 0.016;
  if (dt > 0.1) dt = 0.1;

  /* 节拍脉冲：渲染循环比对 audioTime，到点（含已过期的排队拍）置 1 */
  if (audio.ctx) {
    const t = audio.ctx.currentTime;
    while (pendingBeats.length && pendingBeats[0] <= t) {
      pendingBeats.shift();
      pulse = 1;
    }
  }
  pulse *= 0.85;
  if (pulse < 0.01) pulse = 0;

  /* 姿态 → 3D 骨架人偶 + 画中画骨架叠加 */
  stage.setPose(latestPersons);
  drawSkeletons(latestPersons);

  stage.render(dt, pulse);

  /* 模式级逐帧逻辑 */
  if (S.state === 'PLAYING') {
    if (S.mode === 'rhythm') djTick();
    else if (S.mode === 'instrument') createTick();
  }

  /* 调试面板：每 500ms 刷新（toggleDebug(extra) 仅刷内容，不改变开关状态） */
  if (now - lastDebugTs >= 500) {
    lastDebugTs = now;
    const st = stage.getStats();
    toggleDebug({
      fps: poseFps + '/' + st.fps,
      persons: latestPersons.length,
      mode: MODE_LABEL[S.mode] + ' · ' + S.state,
    });
  }
}

/* ============================== 启动 ============================== */

async function boot() {
  showLoading('正在搭建夜店舞台…');
  initUI({ onModeStart });

  try {
    await stage.init(document.getElementById('gameCanvas'));
  } catch (err) {
    console.error('[game] 3D 舞台初始化失败：', err);
    showLoading('3D 舞台初始化失败：' + ((err && err.message) || err));
    return;
  }

  window.addEventListener('resize', () => stage.resize());
  lastFrameTs = performance.now();
  requestAnimationFrame(loop);   // 菜单背后即有缓慢律动的舞台背景
  hideLoading();
  console.log('[motion-wave-dj] 主控制器就绪');
}

boot();

/* =====================================================================
 * MOTION WAVE DJ · 主控制器（js/game.js）—— 任务 4 · Jay
 * ---------------------------------------------------------------------
 * 职责：
 *   - 游戏状态机：MENU → GUIDE(每模式首次) → PLAYING → RESULT(仅 DJ) → MENU
 *   - 三模式玩法编排：DJ 节奏（节拍对齐判定）/ 乐器创作（身体即乐器 + 录制回放）
 *     / 自由舞台（无评分畅玩）
 *   - 渲染循环（dt + 节拍脉冲）、键盘降级、调试面板刷新、ESC 回菜单
 * 依赖契约（与队友模块逐一对齐）：
 *   ui.js      initUI/showLoading/hideLoading/setHud/showJudge/drawSkeletons/
 *              setCamMode/showGuide/hideGuide/setGuideDismissed/toggleDebug
 *   pose.js    initPose({videoEl,numPoses,onResults,onStatus}) / armRaised / isSquat
 *   audio.js   AudioEngine（init/resume/playKick 等全部 play 方法/startTrack/stopTrack） / noteToFreq
 *   stage3d.js Stage3D(init/resize/render/setPose/flash/spawnBurst/
 *              setMode/setPlayers/getStats)
 * 已知陷阱规避：
 *   - AudioContext 在用户手势回调（菜单点击）内 init+resume
 *   - 节拍脉冲用渲染循环比对 audioTime 驱动（过期拍立即补触发，不用 setTimeout）
 *   - 全部用户可见文案为中文，不使用 emoji
 * ===================================================================== */

import {
  initUI, showLoading, hideLoading, setHud, showJudge, drawSkeletons,
  setCamMode, showGuide, hideGuide, setGuideDismissed, toggleDebug
} from './ui.js';
import { initPose, armRaised, isSquat } from './pose.js';
import { AudioEngine, noteToFreq } from './audio.js';
import { Stage3D } from './stage3d.js';

/* ============================== 常量配置 ============================== */

const DJ_DURATION = 90;          // DJ 模式曲目时长（秒）
const PERFECT_WIN = 0.15;        // PERFECT 判定窗口（秒）
const GOOD_WIN = 0.30;           // GOOD 判定窗口（秒）
const ARM_CD_DJ = 300;           // DJ / 自由模式举手冷却（毫秒，保持式）
const ARM_CD_CREATE = 200;       // 创作模式挥臂冷却（毫秒/侧）
const GTR_CD = 150;              // 吉他下压防抖（毫秒）
const SQUAT_FRAMES = 3;          // 下蹲需连续确认帧数
const SQUAT_CD = 800;            // 下蹲冷却（毫秒）
const BOTH_CD = 500;             // 双手同举冷却（毫秒）
const REC_SECONDS = 8;           // 创作模式录制时长（秒）
const BEST_KEY = 'mwdj_best_v1'; // 历史最高分 localStorage 键

const STYLES = ['house', 'edm', 'funk'];               // 曲风轮换
/* 拍目标动作轮换（8 拍一循环，下蹲每 8 拍出现一次防过劳） */
const TARGET_SEQ = ['left', 'right', 'left', 'both', 'right', 'left', 'both', 'squat'];
const TARGET_LABEL = { left: '左臂高举', right: '右臂高举', both: '双手高举', squat: '下蹲' };

const PENTA = ['C4', 'D4', 'E4', 'G4', 'A4', 'C5', 'D5', 'E5'];   // C 大调五声 8 音
const GTR_NOTES = ['E2', 'A2', 'D3', 'G3', 'B3', 'E4'];           // 吉他扫弦音域（低→高）
const CHORDS = [                                                   // 下蹲和弦轮换 C-F-G-Am
  ['C3', 'E3', 'G3'], ['F3', 'A3', 'C4'], ['G3', 'B3', 'D4'], ['A3', 'C4', 'E4']
];

const CHEERS = ['太棒了！', '保持节奏！', '就是这个感觉！', '跟着灯光摇摆！', '你是最棒的！', '节奏不能停！'];
const MODE_LABEL = { rhythm: 'DJ 节奏', instrument: '乐器创作', free: '自由舞台' };
/* ui 菜单 mode → stage3d 氛围配色 mode */
const STAGE_MODE = { rhythm: 'dj', instrument: 'create', free: 'free' };

/* 评级阈值参考：90 秒约 180 拍，全 PERFECT 满分约 26500，
 * S≈60% 满打 / A≈40% / B≈20%，其余 C */
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

/* DJ 模式状态 */
const dj = {
  target: null,           // { lane, audioTime, judged:[bool, bool] } —— 判定标记按玩家独立
  scores: [0, 0],
  combos: [0, 0],
  maxCombos: [0, 0],
  startAt: 0,             // 曲目起始（AudioContext 时钟，优先）
  wallStart: 0,           // 曲目起始（performance.now 兜底，音频不可用时用）
  styleIdx: 0,            // 曲风轮换游标
  retryAt: 0,             // 续播重试冷却时间戳（performance.now，startTrack 报错时限流）
};

/* 创作模式状态 */
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
    laneFx(lane);
    laneSound(lane);
    djJudge(pi, lane);
  } else if (S.mode === 'instrument') {
    createAction(pi, lane, lm);
  } else {
    freeAction(pi, lane);
  }
}

/* ============================== DJ 节奏模式 ============================== */

function startDJ() {
  pendingBeats = [];
  pulse = 0;
  dj.scores = [0, 0];
  dj.combos = [0, 0];
  dj.maxCombos = [0, 0];
  dj.target = null;
  dj.startAt = 0;
  dj.wallStart = performance.now();
  dj.retryAt = 0;

  const style = STYLES[dj.styleIdx % STYLES.length];   // 曲风轮换
  dj.styleIdx = (dj.styleIdx + 1) % STYLES.length;
  const bpm = 112 + Math.floor(Math.random() * 17);    // 112..128

  let trackOk = true;
  try {
    audio.startTrack(style, bpm, { onBeat: onDJBeat });
    dj.startAt = audio.ctx.currentTime;
  } catch (err) {
    trackOk = false;
    console.warn('[game] 音序器启动失败：', err);
  }

  setHud({
    p1Score: 0, p1Combo: 0,
    p2Score: S.players === 2 ? 0 : null, p2Combo: S.players === 2 ? 0 : undefined,
    trackInfo: style.toUpperCase() + ' · ' + bpm + ' BPM' + (trackOk ? '' : ' · 无音频'),
  });
  showJudge('跟拍开打：左臂 / 右臂 / 双手 / 下蹲！', '#00e5ff');
}

/* 每拍回调（音频调度线程提前 ~0.1s 触发）：排入视觉脉冲 + 生成判定目标 */
function onDJBeat(beatIndex, barIndex, audioTime) {
  if (S.state !== 'PLAYING' || S.mode !== 'rhythm') return;
  pendingBeats.push(audioTime);
  const lane = TARGET_SEQ[beatIndex % TARGET_SEQ.length];
  /* 旧拍补记 MISS：新 target 替换前，未判定玩家直接断连击
   *（128BPM 时 djTick 的过期窗口仅约 69ms，低帧率下渲染帧可能来不及记） */
  const old = dj.target;
  if (old) {
    let missAny = false;
    for (let pi = 0; pi < S.players; pi++) {
      if (!old.judged[pi]) {
        old.judged[pi] = true;
        dj.combos[pi] = 0;
        missAny = true;
      }
    }
    if (missAny) showJudge('MISS', '#ff5470');
  }
  dj.target = { lane, audioTime, judged: [false, false] };
  showJudge(TARGET_LABEL[lane], '#ffd166');   // 目标提示（提前显示正好预备）
}

/* 纯判定（不含视觉/音效反馈，供姿态与键盘双路复用） */
function djJudge(pi, lane) {
  const tgt = dj.target;
  if (!tgt || tgt.judged[pi] || tgt.lane !== lane) return;
  const diff = Math.abs(audioTimeNow() - tgt.audioTime);
  let base = 0, label = '', color = '#ffffff';
  if (diff <= PERFECT_WIN) { base = 100; label = 'PERFECT'; color = '#ffd700'; }
  else if (diff <= GOOD_WIN) { base = 50; label = 'GOOD'; color = '#00e5ff'; }
  if (!base) return;   // 窗口外动作：不奖不罚，等窗口结束统一记 MISS
  tgt.judged[pi] = true;
  const combo = ++dj.combos[pi];
  dj.maxCombos[pi] = Math.max(dj.maxCombos[pi], combo);
  dj.scores[pi] += Math.round(base * (combo >= 10 ? 1.5 : 1));   // 连击 ≥10 得分 ×1.5
  showJudge((S.players === 2 ? 'P' + (pi + 1) + ' ' : '') + label, color);
  updateScoresHud();
}

function updateScoresHud() {
  setHud({
    p1Score: dj.scores[0], p1Combo: dj.combos[0],
    p2Score: S.players === 2 ? dj.scores[1] : undefined,
    p2Combo: S.players === 2 ? dj.combos[1] : undefined,
  });
}

/* DJ 逐帧逻辑：窗口过期的拍记 MISS 断连击；曲目满 90 秒进结算 */
function djTick() {
  const tgt = dj.target;
  if (tgt) {
    const t = audioTimeNow();
    let missAny = false;
    for (let pi = 0; pi < S.players; pi++) {
      if (!tgt.judged[pi] && t > tgt.audioTime + GOOD_WIN) {
        tgt.judged[pi] = true;
        dj.combos[pi] = 0;
        missAny = true;
      }
    }
    if (missAny) showJudge('MISS', '#ff5470');
  }
  if (audio.ctx && dj.startAt > 0) {
    if (audio.ctx.currentTime - dj.startAt >= DJ_DURATION) {
      endDJ();
      return;
    }
    /* 曲目中断自愈：背景曲意外停止（音序器 running=false）且未到结算点时，
     * 自动换下一风格续播，保证判定目标持续生成直到 90 秒结算。
     * startTrack 内部会先 stopTrack 防叠加，且不重置 ctx.currentTime，
     * 结算时钟 dj.startAt 不受影响（90 秒结算逻辑保持不变）。 */
    const info = audio.getUserTrackInfo();
    if (!info.running && performance.now() >= dj.retryAt) {
      dj.retryAt = performance.now() + 1000;   // 启动报错时 1s 冷却，防每帧重试刷屏
      try {
        const style = STYLES[dj.styleIdx % STYLES.length];
        dj.styleIdx = (dj.styleIdx + 1) % STYLES.length;
        const bpm = 112 + Math.floor(Math.random() * 17);   // 续播 BPM 微调 112..128
        const trk = audio.startTrack(style, bpm, { onBeat: onDJBeat });
        setHud({ trackInfo: trk.style.toUpperCase() + ' · ' + trk.bpm + ' BPM · 续播' });
        showJudge('下一首：' + trk.style.toUpperCase() + ' ' + trk.bpm + ' BPM', '#ffd166');
      } catch (err) {
        console.warn('[game] DJ 续播失败：', err);
      }
    }
  } else if (performance.now() - dj.wallStart >= DJ_DURATION * 1000) {
    endDJ();
  }
}

function endDJ() {
  audio.stopTrack();
  dj.target = null;
  S.state = 'RESULT';
  showResult();
}

/* ============================== 结算屏（动态注入，不改 style.css） ============================== */

let resultEl = null;

function gradeOf(score) {
  return score >= 16000 ? 'S' : score >= 10500 ? 'A' : score >= 5000 ? 'B' : 'C';
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

function showResult() {
  ensureResultStyle();
  hideResult();

  /* 最高分：双人取两人较高者；读写 localStorage 全程 try/catch（隐私模式可能抛错） */
  const top = Math.max(dj.scores[0], dj.scores[1]);
  let prevBest = 0;
  try { prevBest = Number(localStorage.getItem(BEST_KEY)) || 0; } catch (e) { /* 忽略 */ }
  const isNew = top > prevBest;
  if (isNew) {
    try { localStorage.setItem(BEST_KEY, String(top)); } catch (e) { /* 忽略 */ }
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
      '<p class="r-best">历史最高分 ' + best + (isNew ? '<b class="r-new">新纪录！</b>' : '') + '</p>' +
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
    startDJ();
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
  lastTrackInfo = '';
  setHud({
    p1Score: 0, p1Combo: 0,
    p2Score: S.players === 2 ? 0 : null, p2Combo: S.players === 2 ? 0 : undefined,
    trackInfo: 'LIVE JAM · 身体即乐器',
  });
  showJudge('左臂弹琴 · 右手扫弦 · 下蹲和弦 · 双手举镲', '#ffcf5c');
}

/* 创作模式姿态动作分发 */
function createAction(pi, lane, lm) {
  if (lane === 'left') {
    /* 左臂高度映射 C 大调五声音阶（挥臂即弹琴，冷却 200ms/侧） */
    const lw = lm && lm[15];
    const y = lw && lw.v >= 0.1 ? lw.y : 0.5;
    jam('piano', wristToPentaIdx(y));
  } else if (lane === 'both') {
    /* 双手同举：镲片 + 灯光爆闪 */
    jam('cymbal', -1);
  } else if (lane === 'squat') {
    /* 下蹲：和弦 C-F-G-Am 按蹲的次数轮换 + 底鼓 */
    const ci = create.chordIdx;
    create.chordIdx = (create.chordIdx + 1) % CHORDS.length;
    jam('chord', ci);
  }
  /* lane === 'right'：右手高举保持不发声（吉他由"快速下压"事件触发） */
}

/* 创作模式统一发声入口：发声 + 视觉 + 录制记录 */
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
  const t = audioTimeNow();
  if (kind === 'piano') {
    audio.playPiano(noteToFreq(PENTA[data] || 'C4'), t, 0.5);
  } else if (kind === 'guitar') {
    audio.playGuitar(noteToFreq(GTR_NOTES[data] || 'A2'), t);
  } else if (kind === 'chord') {
    const ch = CHORDS[data] || CHORDS[0];
    audio.playChord(ch.map(noteToFreq), t, 1.0);
    audio.playKick(t);
  } else {
    audio.playCymbal(t);
  }
}

function jamFx(kind) {
  if (kind === 'piano') { stage.flash('left'); stage.spawnBurst('left'); }
  else if (kind === 'guitar') { stage.flash('right'); stage.spawnBurst('right'); }
  else if (kind === 'chord') { stage.flash('squat'); stage.spawnBurst('squat'); }
  else { stage.flash('both'); stage.spawnBurst('both'); }
}

/* 录制 / 回放：R 开始 8 秒录制；再按 R 立即结束并回放；回放可叠加 */
function toggleRecord() {
  if (S.state !== 'PLAYING' || S.mode !== 'instrument') return;
  if (create.recording) {
    stopRecording();
    playRecording();
  } else {
    startRecording();
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
  let info;
  if (create.recording) {
    info = 'LIVE JAM · 录制中 ' + ((performance.now() - create.recStart) / 1000).toFixed(1) + 's';
  } else if (create.recEvents.length) {
    info = 'LIVE JAM · 已录 ' + create.recEvents.length + ' 个动作（R 回放）';
  } else {
    info = 'LIVE JAM · 身体即乐器';
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

  if (mode === 'rhythm') startDJ();
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
  hideLoading();   // 加载期间 ESC：遮罩可能仍显示，回菜单必须收起
  clearJamTimers();
  dj.target = null;
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

  /* 创作模式键盘：J=钢琴随机音 K=吉他 L=和弦 I=镲 */
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

  /* DJ / 自由模式键盘：J=左 K=右 L=蹲 I=双手（键盘无法区分玩家，双人时判定双方） */
  const lane = { KeyJ: 'left', KeyK: 'right', KeyL: 'squat', KeyI: 'both' }[e.code];
  if (!lane) return;
  if (S.mode === 'rhythm') {
    laneFx(lane);
    laneSound(lane);
    djJudge(0, lane);
    if (S.players === 2) djJudge(1, lane);
  } else {
    freeAction(0, lane);
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

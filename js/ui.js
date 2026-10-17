/* =====================================================================
 * MOTION WAVE DJ · UI 层（js/ui.js）
 * ---------------------------------------------------------------------
 * 职责：菜单渲染 / HUD 更新 / 中央判定 / 画中画骨架绘制 / 键盘降级 /
 *       动作引导 / 选择面板（DJ 选曲 · 创作选乐器）/ 调试面板 / 加载遮罩。
 * 不依赖 game.js / stage3d.js / audio.js —— 纯 UI 能力，由入口或 game.js 调度。
 * ===================================================================== */

import { POSE_CONN } from './pose.js';

/* ---------------- 玩家配色（骨架 / HUD 一致） ---------------- */
const P_COLORS = ['#00e5ff', '#ff2bd6'];   // P1 青 / P2 品红

/* ---------------- DOM 缓存 ---------------- */
const dom = {};
function cacheDom() {
  [
    'menuOverlay', 'loadingMask', 'loadingText',
    'hudTop', 'p1Area', 'p1Score', 'p1Combo', 'p2Area', 'p2Score', 'p2Combo', 'trackInfo',
    'centerMsg', 'camBox', 'camVideo', 'skelCanvas', 'pipTag',
    'touchPad', 'guideModal', 'guideOkBtn', 'debugPanel'
  ].forEach((id) => { dom[id] = document.getElementById(id); });
}

let initialized = false;
let onModeStartCb = null;
let guideDismissedCb = null;
let curPlayers = 1;
let judgeTimer = 0;
let debugVisible = false;
const debugData = { fps: 0, persons: 0, mode: '--' };

/* =====================================================================
 * 菜单（霓虹夜店风：深色底 + 渐变霓虹标题 + 大按钮，老人小孩都好点）
 * ===================================================================== */
function renderMenu() {
  const box = dom.menuOverlay;
  if (!box) return;
  box.innerHTML = `
    <div class="menu-inner">
      <div class="menu-eyebrow">BODY · BEAT · BASS</div>
      <h1 class="menu-title"><span>MOTION</span><span>WAVE</span><span>DJ</span></h1>
      <p class="menu-sub">体感 DJ 节奏游戏 —— 用身体打节拍，灯光为你而闪</p>

      <div class="menu-switch" role="radiogroup" aria-label="选择玩家人数">
        <button class="sw-btn on" data-players="1" type="button">👤 单人</button>
        <button class="sw-btn" data-players="2" type="button">👥 双人</button>
      </div>

      <div class="mode-cards">
        <button class="mode-card mc-rhythm" data-mode="rhythm" type="button">
          <span class="mode-icon">🎛️</span>
          <span class="mode-name">DJ 节奏模式</span>
          <span class="mode-desc">接住下落音符，冲击连击高分</span>
        </button>
        <button class="mode-card mc-instrument" data-mode="instrument" type="button">
          <span class="mode-icon">🎹</span>
          <span class="mode-name">乐器创作模式</span>
          <span class="mode-desc">挥手成音，肢体演奏你的旋律</span>
        </button>
        <button class="mode-card mc-free" data-mode="free" type="button">
          <span class="mode-icon">🌈</span>
          <span class="mode-name">自由舞台模式</span>
          <span class="mode-desc">无评分畅玩，灯光随动作起舞</span>
        </button>
      </div>

      <p class="menu-hint">需要摄像头权限 · 没有摄像头也能用键盘 J / K / L / I 开玩</p>
    </div>`;
  box.classList.add('ready');

  /* 单人 / 双人切换 */
  box.querySelectorAll('.sw-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      curPlayers = Number(btn.dataset.players) || 1;
      box.querySelectorAll('.sw-btn').forEach((b) => b.classList.toggle('on', b === btn));
    });
  });
  /* 模式卡点击 → 隐藏菜单并回调 */
  box.querySelectorAll('.mode-card').forEach((card) => {
    card.addEventListener('click', () => {
      box.classList.remove('ready');
      box.classList.add('gone');
      if (typeof onModeStartCb === 'function') {
        onModeStartCb(card.dataset.mode, curPlayers);
      }
    });
  });
}

/* =====================================================================
 * 加载遮罩
 * ===================================================================== */
export function showLoading(text) {
  if (!dom.loadingMask) return;
  dom.loadingMask.hidden = false;
  if (text && dom.loadingText) dom.loadingText.textContent = text;
}

export function hideLoading() {
  if (dom.loadingMask) dom.loadingMask.hidden = true;
}

/* =====================================================================
 * HUD
 * ===================================================================== */
export function setHud({ p1Score, p1Combo, p2Score, p2Combo, trackInfo } = {}) {
  if (!dom.hudTop) return;
  dom.hudTop.classList.remove('hidden');   // 首次设置分数即视为进入游戏
  if (p1Score !== undefined && dom.p1Score) dom.p1Score.textContent = p1Score;
  if (p1Combo !== undefined && dom.p1Combo) dom.p1Combo.textContent = 'COMBO ×' + p1Combo;
  if (p2Score === null && dom.p2Area) {
    dom.p2Area.hidden = true;              // 显式传 null = 隐藏玩家 2（单人）
  } else if (p2Score !== undefined && dom.p2Area) {
    dom.p2Area.hidden = false;
    if (dom.p2Score) dom.p2Score.textContent = p2Score;
  }
  if (p2Combo !== undefined && dom.p2Combo) dom.p2Combo.textContent = 'COMBO ×' + p2Combo;
  if (trackInfo !== undefined && dom.trackInfo) dom.trackInfo.textContent = trackInfo;
}

/* =====================================================================
 * 中央判定提示：弹出 + 自动淡出
 * ===================================================================== */
export function showJudge(text, color) {
  const el = dom.centerMsg;
  if (!el) return;
  el.textContent = text;
  el.style.color = color || '#ffffff';
  el.classList.remove('show');
  void el.offsetWidth;                     // 强制重排以重触发 CSS 动画
  el.classList.add('show');
  clearTimeout(judgeTimer);
  judgeTimer = setTimeout(() => el.classList.remove('show'), 1100);
}

/* =====================================================================
 * 画中画骨架绘制（镜像坐标已由 pose.js 翻转，此处直接绘制即对齐）
 * ===================================================================== */
function drawOneSkeleton(ctx, lm, w, h, color) {
  ctx.save();
  ctx.lineWidth = 2.5;
  ctx.strokeStyle = color;
  ctx.shadowColor = color;
  ctx.shadowBlur = 7;
  POSE_CONN.forEach(([a, b]) => {
    const pa = lm[a], pb = lm[b];
    if (!pa || !pb || pa.v < 0.1 || pb.v < 0.1) return;   // 单点过滤阈值 0.1
    ctx.beginPath();
    ctx.moveTo(pa.x * w, pa.y * h);
    ctx.lineTo(pb.x * w, pb.y * h);
    ctx.stroke();
  });
  ctx.fillStyle = '#ffffff';
  for (let i = 0; i < lm.length; i++) {
    const p = lm[i];
    if (p.v < 0.1) continue;
    ctx.beginPath();
    ctx.arc(p.x * w, p.y * h, i < 11 ? 1.6 : 2.4, 0, 7);  // 头部点略小
    ctx.fill();
  }
  ctx.restore();
}

export function drawSkeletons(persons) {
  const skel = dom.skelCanvas;
  if (!skel) return;
  const ctx = skel.getContext('2d');

  /* 画布分辨率跟随视频宽高比（固定宽 320，PiP 显示足够且省绘制） */
  const video = dom.camVideo;
  const vw = (video && video.videoWidth) || 640;
  const vh = (video && video.videoHeight) || 480;
  const w = 320;
  const h = Math.max(120, Math.round((320 * vh) / vw));
  if (skel.width !== w) skel.width = w;
  if (skel.height !== h) skel.height = h;

  ctx.clearRect(0, 0, w, h);
  if (!persons || !persons.length) return;
  persons.slice(0, 2).forEach((p, i) => {
    if (p && p.landmarks) drawOneSkeleton(ctx, p.landmarks, w, h, P_COLORS[i]);
  });
}

/* =====================================================================
 * 画中画 / 键盘降级
 * ===================================================================== */
export function setCamMode(hasCamera) {
  if (dom.camBox) dom.camBox.hidden = !hasCamera;    // 无摄像头：隐藏画中画
  if (dom.touchPad) dom.touchPad.hidden = !!hasCamera; // 同时显示键盘降级按钮
  /* pipTag 显隐由 CSS（.collapsed .pip-tag）独立管理，此处不再写 hidden */
}

export function togglePiP() {
  if (!dom.camBox) return;
  dom.camBox.classList.toggle('collapsed');          // 收起 / 展开由 CSS 过渡
}

/* =====================================================================
 * 动作引导弹窗
 * ===================================================================== */
export function showGuide() {
  if (!dom.guideModal) return;
  dom.guideModal.hidden = false;
}

export function hideGuide() {
  if (dom.guideModal) dom.guideModal.hidden = true;
}

export function setGuideDismissed(cb) {
  guideDismissedCb = typeof cb === 'function' ? cb : null;
}

/* =====================================================================
 * 调试面板（按 D 开关；toggleDebug(extra) 仅刷新内容不改变开关状态）
 * ===================================================================== */
function renderDebug() {
  const p = dom.debugPanel;
  if (!p || !debugVisible) return;
  const s1 = dom.p1Score ? dom.p1Score.textContent : '-';
  const s2 = dom.p2Score && !dom.p2Area.hidden ? dom.p2Score.textContent : '-';
  p.textContent =
    'fps: ' + (debugData.fps || 0) +
    '\n人数: ' + (debugData.persons || 0) +
    '\n模式: ' + (debugData.mode || '--') +
    '\nP1 分数: ' + s1 +
    '\nP2 分数: ' + s2;
}

export function toggleDebug(extra) {
  if (extra) {
    Object.assign(debugData, extra);
    renderDebug();
    return;
  }
  debugVisible = !debugVisible;
  if (dom.debugPanel) dom.debugPanel.hidden = !debugVisible;
  if (debugVisible) renderDebug();
}

/* =====================================================================
 * 选择面板（DJ 选曲 / 创作选乐器）：动态注入样式与 DOM，风格与结算卡一致。
 * 不依赖 tracks.js / game.js —— 数据由 game.js 整理后作为参数传入；
 * 同一时刻只存在一个面板（选曲与选乐器互斥），隐藏接口均可安全重复调用
 * ===================================================================== */
let pickerEl = null;

function ensurePickerStyle() {
  if (document.getElementById('mwdjPickerStyle')) return;
  const st = document.createElement('style');
  st.id = 'mwdjPickerStyle';
  st.textContent = [
    '#songPicker,#instrumentPicker{position:fixed;inset:0;z-index:58;display:flex;align-items:center;justify-content:center;',
    'background:rgba(3,0,10,.78);backdrop-filter:blur(8px)}',
    '.sp-card{width:min(640px,92vw);max-height:90vh;overflow-y:auto;padding:30px 26px 22px;border-radius:24px;',
    'background:linear-gradient(180deg,rgba(16,8,38,.97),rgba(8,3,22,.97));',
    'border:1.5px solid rgba(0,229,255,.4);',
    'box-shadow:0 0 30px rgba(0,229,255,.18),0 0 70px rgba(255,43,214,.12),0 30px 80px rgba(0,0,0,.6);',
    'animation:spIn .28s cubic-bezier(.2,1.3,.4,1)}',
    '@keyframes spIn{from{transform:scale(.9);opacity:0}to{transform:scale(1);opacity:1}}',
    '.sp-title{font-size:1.5rem;font-weight:900;letter-spacing:.3em;text-indent:.3em;text-align:center;margin-bottom:8px;',
    'background:linear-gradient(92deg,#00e5ff,#ff2bd6);-webkit-background-clip:text;background-clip:text;color:transparent}',
    '.sp-sub{text-align:center;font-size:.9rem;letter-spacing:.1em;color:rgba(233,226,255,.6);margin-bottom:18px}',
    '.sp-list{margin-bottom:16px}',
    '.sp-row{display:flex;align-items:center;gap:14px;width:100%;padding:13px 16px;margin-bottom:10px;',
    'border-radius:14px;text-align:left;cursor:pointer;font-family:inherit;color:#f4f1ff;',
    'background:rgba(255,255,255,.045);border:1px solid rgba(123,43,255,.28);',
    'transition:border-color .15s ease,box-shadow .15s ease,transform .1s ease}',
    '.sp-row:hover,.sp-row:focus-visible{border-color:rgba(0,229,255,.6);',
    'box-shadow:0 0 18px rgba(0,229,255,.25);transform:translateY(-2px);outline:none}',
    '.sp-row:active{transform:scale(.98)}',
    '.sp-row.cur{border-color:rgba(255,201,60,.7);box-shadow:0 0 16px rgba(255,201,60,.25)}',
    '.sp-row.cur::after{content:"使用中";font-size:.72rem;font-weight:800;color:#ffc93c;',
    'letter-spacing:.12em;white-space:nowrap}',
    '.sp-main{flex:1;min-width:0;display:flex;flex-direction:column;gap:5px;align-items:flex-start}',
    '.sp-name{max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;',
    'font-size:1.08rem;font-weight:800;letter-spacing:.04em}',
    '.sp-style{font-size:.78rem;font-weight:700;letter-spacing:.14em;color:#00e5ff;text-transform:uppercase;',
    'border:1px solid rgba(0,229,255,.4);border-radius:999px;padding:2px 10px}',
    '.sp-desc{max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;',
    'font-size:.8rem;font-weight:600;color:rgba(233,226,255,.58);letter-spacing:.02em}',
    '.sp-bpm{font-family:"Segoe UI","Arial Black",Impact,sans-serif;font-size:.92rem;font-weight:700;',
    'color:rgba(233,226,255,.72);white-space:nowrap}',
    '.sp-stars{color:#ffc93c;font-size:1.02rem;letter-spacing:.1em;text-shadow:0 0 10px rgba(255,201,60,.45)}',
    '.sp-len{font-size:.85rem;color:rgba(233,226,255,.55);white-space:nowrap}',
    '.sp-empty{text-align:center;padding:20px 0;color:rgba(233,226,255,.55);letter-spacing:.1em}',
    '.sp-back{width:100%;padding:14px 0;border:none;border-radius:14px;font-family:inherit;font-size:1.05rem;',
    'font-weight:900;letter-spacing:.16em;text-indent:.16em;cursor:pointer;color:#f4f1ff;',
    'background:rgba(255,255,255,.08);border:1px solid rgba(255,255,255,.25);transition:filter .15s ease}',
    '.sp-back:hover{filter:brightness(1.15)}',
    '.sp-back:active{transform:scale(.98)}',
    '@media (max-width:640px){.sp-card{padding:20px 14px 16px}.sp-row{padding:11px 12px}.sp-bpm{display:none}}'
  ].join('');
  document.head.appendChild(st);
}

/* 曲名等字段经 HTML 转义后再插入（曲库数据来自代码，防一手不必须但更稳） */
function _esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

/* 公共面板骨架：overlay + 标题/副标题 + 行列表 + 返回按钮。
 * rowsHtml 由调用方拼好，onRow(行下标) / onBack 由调用方实现业务 */
function _renderPicker(id, title, sub, rowsHtml, { onRow, onBack, emptyText } = {}) {
  ensurePickerStyle();
  hidePicker();
  const el = document.createElement('div');
  el.id = id;
  el.innerHTML =
    '<div class="sp-card">' +
      '<h2 class="sp-title">' + _esc(title) + '</h2>' +
      '<p class="sp-sub">' + _esc(sub) + '</p>' +
      '<div class="sp-list">' + (rowsHtml || '<p class="sp-empty">' + _esc(emptyText || '暂无可选项') + '</p>') + '</div>' +
      '<button class="sp-back" type="button">返回</button>' +
    '</div>';
  document.body.appendChild(el);
  pickerEl = el;
  el.querySelectorAll('.sp-row').forEach((btn) => {
    btn.addEventListener('click', () => {
      if (typeof onRow === 'function') onRow(Number(btn.dataset.i));
    });
  });
  const back = el.querySelector('.sp-back');
  if (back) {
    back.addEventListener('click', () => {
      if (typeof onBack === 'function') onBack();
    });
  }
}

/* 销毁当前面板（选曲 / 选乐器共用） */
function hidePicker() {
  if (pickerEl) {
    pickerEl.remove();
    pickerEl = null;
  }
}

/**
 * 显示选曲面板。
 * @param {Array} songs 已按难度排序的曲库（每首 { id, name, style, bpm, difficulty, lengthBeats }）
 * @param {{onPick?:Function, onBack?:Function}} cb 选中 / 返回回调
 */
export function showSongPicker(songs, { onPick, onBack } = {}) {
  const list = Array.isArray(songs) ? songs : [];
  const rows = list.map((s, i) => {
    const diff = Math.min(3, Math.max(1, (s && s.difficulty) || 1));
    const sec = Math.round(((s && s.lengthBeats) || 0) / Math.max(1, (s && s.bpm) || 120) * 60);
    const mm = Math.floor(sec / 60);
    const ss = String(sec % 60).padStart(2, '0');
    return '<button class="sp-row" type="button" data-i="' + i + '">' +
      '<span class="sp-main"><span class="sp-name">' + _esc(s.name) + '</span>' +
      '<span class="sp-style">' + _esc(s.style || '') + '</span></span>' +
      '<span class="sp-bpm">' + ((s && s.bpm) || '--') + ' BPM</span>' +
      '<span class="sp-stars">' + '★'.repeat(diff) + '</span>' +
      '<span class="sp-len">' + mm + ':' + ss + '</span>' +
      '</button>';
  }).join('');
  _renderPicker('songPicker', '选择曲目', '接住下落音符 · 下蹲触发清屏技', rows, {
    emptyText: '曲库为空',
    onRow: (i) => { const s = list[i]; if (s && typeof onPick === 'function') onPick(s); },
    onBack: () => { if (typeof onBack === 'function') onBack(); },
  });
}

/** 隐藏并销毁选曲面板 */
export function hideSongPicker() {
  hidePicker();
}

/**
 * 显示乐器选择面板（创作模式）：上次选择的包默认高亮。
 * @param {Array} packs 乐器包列表（每包 { id, name, desc }，发声逻辑在 game.js）
 * @param {string} lastId 上次选择的包 id（匹配行加 .cur 高亮，显示“使用中”角标）
 * @param {{onPick?:Function, onBack?:Function}} cb 选中 / 返回回调
 */
export function showInstrumentPicker(packs, lastId, { onPick, onBack } = {}) {
  const list = Array.isArray(packs) ? packs : [];
  const rows = list.map((p, i) => {
    const cur = p && p.id === lastId ? ' cur' : '';
    return '<button class="sp-row' + cur + '" type="button" data-i="' + i + '">' +
      '<span class="sp-main"><span class="sp-name">' + _esc(p.name) + '</span>' +
      '<span class="sp-desc">' + _esc(p.desc || '') + '</span></span>' +
      '</button>';
  }).join('');
  _renderPicker('instrumentPicker', '选择乐器', '选一个乐器，用身体演奏', rows, {
    emptyText: '乐器库为空',
    onRow: (i) => { const p = list[i]; if (p && typeof onPick === 'function') onPick(p); },
    onBack: () => { if (typeof onBack === 'function') onBack(); },
  });
}

/** 隐藏并销毁乐器选择面板 */
export function hideInstrumentPicker() {
  hidePicker();
}

/* =====================================================================
 * 初始化
 * ===================================================================== */
export function initUI({ onModeStart } = {}) {
  cacheDom();
  if (initialized) return;
  initialized = true;
  onModeStartCb = typeof onModeStart === 'function' ? onModeStart : null;

  renderMenu();

  /* 画中画：点击收起 / 展开 */
  if (dom.camBox) dom.camBox.addEventListener('click', () => togglePiP());

  /* 键盘降级按钮：点按等效按下 J / K / L / I（派生 KeyboardEvent，game.js 统一监听 document keydown） */
  if (dom.touchPad) {
    dom.touchPad.querySelectorAll('.pad-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        const code = btn.dataset.key || 'KeyJ';
        document.dispatchEvent(new KeyboardEvent('keydown', {
          code,
          key: code.replace('Key', '').toLowerCase(),
          bubbles: true
        }));
      });
    });
  }

  /* 引导弹窗「开始」按钮 */
  if (dom.guideOkBtn) {
    dom.guideOkBtn.addEventListener('click', () => {
      hideGuide();
      if (guideDismissedCb) guideDismissedCb();
    });
  }

  /* D 键：开关调试面板 */
  document.addEventListener('keydown', (e) => {
    if (e.code === 'KeyD' && !e.repeat) toggleDebug();
  });
}

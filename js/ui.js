/* =====================================================================
 * MOTION WAVE DJ · UI 层（js/ui.js）
 * ---------------------------------------------------------------------
 * 职责：菜单渲染 / HUD 更新 / 中央判定 / 画中画骨架绘制 / 键盘降级 /
 *       动作引导 / 调试面板 / 加载遮罩。
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
          <span class="mode-desc">跟拍挥手打点，冲击连击高分</span>
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
  if (dom.pipTag && dom.camBox) dom.pipTag.hidden = dom.camBox.classList.contains('collapsed');
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

  /* 键盘降级按钮：点按等效按下 J / K / L（派生 KeyboardEvent，game.js 统一监听 document keydown） */
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

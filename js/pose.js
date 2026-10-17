/* =====================================================================
 * MOTION WAVE DJ · 人体感知层（js/pose.js）
 * ---------------------------------------------------------------------
 * 基于 MediaPipe Tasks-Vision PoseLandmarker（lite / VIDEO 模式）：
 *  - 动态 import() 加载 tasks-vision（顶层零静态 import，全部可被 try/catch 保护）
 *  - GPU 优先，异常自动降级 CPU；失败的 promise 不缓存，允许重试
 *  - rAF 自驱喂帧（不依赖 camera_utils），DETECT_GAP 节流（单人 ~35fps，双人 ~25fps）
 *  - 归一化输出：x 已镜像翻转（x' = 1 - x），可直接叠加绘制在 CSS scaleX(-1) 的视频上
 *  - persons 按画面 x 从左到右排序：玩家 1 = 画面左，玩家 2 = 画面右
 * ===================================================================== */

const TASKS_VISION_URL = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.1.1/vision_bundle.mjs';
const WASM_ROOT = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.1.1/wasm';
const MODEL_URL = 'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task';

/* 33 点连线（完整版）：头部 / 肩线 / 手臂 / 躯干 / 腿 / 脚。
 * 供 ui.js drawSkeletons 绘制使用 */
export const POSE_CONN = [
  [0, 1], [0, 2], [1, 2], [1, 3], [2, 4],          // 头：鼻-眼-耳
  [0, 5], [0, 6], [5, 6],                          // 鼻-肩 + 肩线
  [5, 7], [7, 9], [6, 8], [8, 10], [9, 10],        // 手臂 + 腕线
  [5, 11], [6, 12], [11, 12],                      // 躯干上段
  [11, 13], [13, 15], [12, 14], [14, 16],          // 上臂-前臂（躯干侧）
  [15, 17], [15, 19], [17, 19],                    // 左手：腕-指根-指尖
  [16, 18], [16, 20], [18, 20],                    // 右手
  [11, 23], [12, 24], [23, 24],                    // 躯干下段 + 髋线
  [23, 25], [25, 27], [24, 26], [26, 28],          // 腿
  [27, 29], [27, 31], [29, 31],                    // 左脚：踝-脚跟-脚尖
  [28, 30], [28, 32], [30, 32]                     // 右脚
];

/* 常用关键点索引（BlazePose 33 点） */
const LM = {
  NOSE: 0,
  L_SHOULDER: 11, R_SHOULDER: 12,
  L_WRIST: 15, R_WRIST: 16,
  L_HIP: 23, R_HIP: 24,
  L_KNEE: 25, R_KNEE: 26
};

/* 单点可见度过滤阈值：lite 模型 visibility 不可靠，只用来排除真正出画外的点 */
const V_MIN = 0.1;

/* ---------------- 模块级状态（引擎/摄像头单例，重复 initPose 复用） ---------------- */
let landmarker = null;          // 已就绪的 PoseLandmarker 实例
let enginePoses = 0;            // 该实例创建时的 numPoses（不匹配需重建）
let landmarkerPromise = null;   // 创建中的 promise（失败不缓存，允许重试）
let stream = null;              // 已获取的摄像头 MediaStream
let rafId = 0;                  // 推理循环句柄
let lastDetectTs = 0;           // 上次推理时间戳（detectForVideo 要求严格递增）
let fpsCnt = 0, fpsT = 0, curFps = 0;

/* ---------------- 摄像头 ---------------- */

/* 错误分类：把 getUserMedia 的原始错误翻译成用户能看懂的中文 */
function classifyCamError(err) {
  const e = new Error(err && err.message ? err.message : String(err));
  e.name = (err && err.name) || 'CameraError';
  switch (e.name) {
    case 'NotAllowedError':
    case 'PermissionDeniedError':
      e.friendly = '摄像头权限被拒绝：请在浏览器地址栏允许摄像头后重试';
      break;
    case 'NotFoundError':
    case 'DevicesNotFoundError':
      e.friendly = '未检测到摄像头设备：请接入摄像头，或改用键盘 J / K / L 模式';
      break;
    case 'NotReadableError':
    case 'TrackStartError':
      e.friendly = '摄像头被其他程序占用：请关闭其他正在使用摄像头的应用后重试';
      break;
    case 'OverconstrainedError':
      e.friendly = '摄像头参数不受支持：请尝试更换摄像头设备';
      break;
    default:
      e.friendly = '摄像头启动失败：' + e.message;
  }
  return e;
}

function attachStream(videoEl) {
  if (videoEl.srcObject !== stream) {
    videoEl.srcObject = stream;
    videoEl.play().catch(() => { /* autoplay 失败不影响： muted+playsinline 通常可自动播放 */ });
  }
}

async function ensureCamera(videoEl) {
  if (stream) { attachStream(videoEl); return stream; }

  /* file:// 下浏览器直接禁用 getUserMedia：提前拦截并给出可操作的提示 */
  if (!window.isSecureContext) {
    const e = new Error('Insecure context: camera is disabled on file://');
    e.name = 'InsecureContextError';
    e.friendly = '当前页面通过 file:// 打开，浏览器已禁用摄像头：请通过 http(s) 访问（如 python -m http.server 8091）';
    throw e;
  }
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    const e = new Error('getUserMedia is not available');
    e.name = 'UnsupportedBrowserError';
    e.friendly = '当前浏览器不支持摄像头采集：请改用 Chrome / Edge 等现代浏览器，或使用键盘 J / K / L 模式';
    throw e;
  }

  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: 'user' },
      audio: false
    });
  } catch (err) {
    throw classifyCamError(err);
  }
  attachStream(videoEl);
  return stream;
}

/* ---------------- 模型引擎 ---------------- */

function detectGapMs(numPoses) {
  /* 节流上限：单人 ~35fps（28ms），双人加大到 ~25fps（40ms）防止低端机过载 */
  return numPoses >= 2 ? 40 : 28;
}

async function ensureLandmarker(numPoses, onFallback) {
  /* 已有实例且人数档位匹配 → 直接复用 */
  if (landmarker && enginePoses === numPoses) return landmarker;

  /* 人数档位变化：关闭旧实例重建（numPoses 是创建期参数，无法运行时改） */
  if (landmarker && enginePoses !== numPoses) {
    try { landmarker.close(); } catch (e) { /* 忽略关闭异常 */ }
    landmarker = null;
    enginePoses = 0;
  }

  if (landmarkerPromise) {
    await landmarkerPromise;
    if (landmarker && enginePoses === numPoses) return landmarker;
  }

  landmarkerPromise = (async () => {
    const vision = await import(TASKS_VISION_URL);   // 动态 import：可被 try/catch 保护
    const files = await vision.FilesetResolver.forVisionTasks(WASM_ROOT);
    const mk = (delegate) => vision.PoseLandmarker.createFromOptions(files, {
      baseOptions: { modelAssetPath: MODEL_URL, delegate },
      runningMode: 'VIDEO',
      numPoses,
      minPoseDetectionConfidence: 0.4,
      minPosePresenceConfidence: 0.4,
      minTrackingConfidence: 0.4
    });
    let engine;
    try {
      engine = await mk('GPU');
    } catch (gpuErr) {
      engine = await mk('CPU');   // GPU 不可用（驱动/显存/WebGL 受限）→ CPU 兜底
      if (onFallback) {
        onFallback('GPU 初始化失败，已降级 CPU 推理：' + ((gpuErr && gpuErr.message) || gpuErr));
      }
    }
    landmarker = engine;
    enginePoses = numPoses;
    return engine;
  })();

  /* 失败的 promise 不缓存：下次调用 initPose 可重试（网络抖动/显存临时不足） */
  landmarkerPromise.catch(() => {
    landmarkerPromise = null;
    landmarker = null;
    enginePoses = 0;
  });

  return landmarkerPromise;
}

/* ---------------- 结果归一化 ---------------- */

function shoulderX(lm) {
  const a = lm[LM.L_SHOULDER], b = lm[LM.R_SHOULDER];
  if (a && b && a.v >= V_MIN && b.v >= V_MIN) return (a.x + b.x) / 2;
  return lm[LM.NOSE] ? lm[LM.NOSE].x : 0;
}

/* MediaPipe 原始结果 → 契约结构 [{landmarks, world}]，x 镜像、按画面从左到右排序 */
function toPersons(result) {
  const raws = result && result.landmarks;
  if (!raws || !raws.length) return [];
  const worlds = result.worldLandmarks || [];

  const persons = raws.map((raw, i) => {
    const lm = raw.map((p) => {
      const v = p.visibility != null ? p.visibility : 1;
      /* x 镜像翻转（x' = 1 - x）：与 CSS scaleX(-1) 的画中画视频逐像素对齐，
       * 同时保证"画面左侧的手臂"语义与玩家直觉一致 */
      return { x: 1 - p.x, y: p.y, z: p.z || 0, v };
    });
    /* 关键陷阱：lite 模型在 VIDEO 模式下 visibility 可能全为 0，
     * 但"检出了 landmarks"本身就意味着有人 —— 整体回退为 1。
     * 严禁在调用侧用 visibility>0.4 过滤整人，否则骨架/判定全灭 */
    if (lm.every((p) => p.v <= 0.05)) lm.forEach((p) => { p.v = 1; });

    /* world 坐标（米制）x 同步取反，保持与镜像画面一致的"镜像世界"语义 */
    const w = worlds[i];
    return {
      landmarks: lm,
      world: w ? w.map((p) => ({ x: -(p.x || 0), y: p.y || 0, z: p.z || 0 })) : null
    };
  });

  /* 玩家排序：按肩中点 x 从左到右（玩家 1 = 画面左，玩家 2 = 画面右） */
  persons.sort((a, b) => shoulderX(a.landmarks) - shoulderX(b.landmarks));
  return persons;
}

/* ---------------- 推理循环 ---------------- */

function stopLoop() {
  if (rafId) { cancelAnimationFrame(rafId); rafId = 0; }
}

function startLoop(videoEl, engine, numPoses, onResults) {
  stopLoop();
  const gap = detectGapMs(numPoses);
  const step = () => {
    rafId = requestAnimationFrame(step);
    if (!engine || videoEl.readyState < 2 || !videoEl.videoWidth) return;

    const ts = performance.now();
    if (ts - lastDetectTs < gap) return;             // DETECT_GAP 节流
    /* detectForVideo 要求时间戳严格递增，防御性保证 */
    const detectTs = ts <= lastDetectTs ? lastDetectTs + 1 : ts;
    lastDetectTs = detectTs;

    let result;
    try {
      result = engine.detectForVideo(videoEl, detectTs);
    } catch (e) {
      console.warn('[pose] 单帧推理异常（已跳过该帧）：', e);
      return;                                        // 单帧失败不中断循环
    }

    const persons = toPersons(result);

    /* fps 统计：每秒结算一次滑动计数 */
    fpsCnt++;
    if (ts - fpsT >= 1000) {
      curFps = Math.round((fpsCnt * 1000) / (ts - fpsT));
      fpsCnt = 0;
      fpsT = ts;
    }

    if (onResults) {
      try {
        onResults({ persons, fps: curFps, ts: detectTs });
      } catch (cbErr) {
        console.warn('[pose] onResults 回调异常：', cbErr);
      }
    }
  };
  step();
}

/* =====================================================================
 * 对外主入口
 * ===================================================================== */
export async function initPose({ videoEl, numPoses = 2, onResults, onStatus } = {}) {
  const status = typeof onStatus === 'function' ? onStatus : () => {};

  if (!videoEl || !(videoEl instanceof HTMLVideoElement)) {
    const e = new Error('initPose: videoEl must be an HTMLVideoElement');
    e.friendly = '感知层配置错误：缺少视频元素';
    throw e;
  }

  /* 1) 摄像头 */
  try {
    await ensureCamera(videoEl);
  } catch (err) {
    status({ type: 'error', message: err.friendly || err.message });
    throw err;
  }
  status({ type: 'ok', message: '摄像头就绪（' + (stream && stream.getVideoTracks()[0]
    && stream.getVideoTracks()[0].label || '默认设备') + '）' });

  /* 2) 姿态模型（GPU→CPU 降级在 ensureLandmarker 内完成并经 onFallback 上报） */
  try {
    await ensureLandmarker(numPoses, (msg) => status({ type: 'fallback', message: msg }));
  } catch (err) {
    status({ type: 'error', message: '姿态模型加载失败：' + ((err && err.message) || err) + '（首次需联网约 5MB，请检查网络后重试）' });
    throw err;
  }
  status({ type: 'ok', message: '感知层就绪 · ' + numPoses + ' 人模式' });

  /* 3) 启动 rAF 推理循环 */
  startLoop(videoEl, landmarker, numPoses, onResults);

  /* 返回控制器：game.js 可 stop() 暂停推理、读 fps */
  return {
    stop() { stopLoop(); },
    get fps() { return curFps; },
    get numPoses() { return numPoses; }
  };
}

/* =====================================================================
 * 动作判定辅助（供 game.js 使用）
 * ===================================================================== */

/* 举手判定：手腕 y 高于同侧肩即视为举起。
 * side 取 'left' / 'right'，为【画面语义】（镜像后）：left = 画面左侧手臂
 * （生理左臂，landmark 15/11）——照镜子时举起自己的左手，像就在画面左侧。
 * 阈值 0.05：手腕需高过肩约一掌以上，避免"手放在脸旁"误触；
 * 关键点 v<0.1 视为不可信，直接返回 false。 */
export function armRaised(landmarks, side) {
  if (!landmarks) return false;
  const isLeft = side === 'left';
  const wrist = landmarks[isLeft ? LM.L_WRIST : LM.R_WRIST];
  const shoulder = landmarks[isLeft ? LM.L_SHOULDER : LM.R_SHOULDER];
  if (!wrist || !shoulder || wrist.v < V_MIN || shoulder.v < V_MIN) return false;
  return wrist.y < shoulder.y - 0.05;   // y 轴向下为正，越小越高
}

/* 下蹲判定（低音炮）：髋-膝垂直间距明显压缩。
 * BlazePose y 向下为正：站立时膝在髋下方，kneeY - hipY ≈ 0.10~0.25（归一化），
 * 下蹲后髋膝间距压缩，kneeY - hipY 趋近 0 甚至为负（膝高过髋）。
 * 主阈值 0.06 为经验值；辅以 hipY > 0.5 排除"半身出画"等异常姿态。
 * 粗判定：game.js 侧建议再做保持帧数（如连续 2~3 帧）消抖。 */
export function isSquat(landmarks) {
  if (!landmarks) return false;
  const lh = landmarks[LM.L_HIP], rh = landmarks[LM.R_HIP];
  const lk = landmarks[LM.L_KNEE], rk = landmarks[LM.R_KNEE];
  if (!lh || !rh || !lk || !rk) return false;
  if ([lh, rh, lk, rk].some((p) => p.v < V_MIN)) return false;
  const hipY = (lh.y + rh.y) / 2;
  const kneeY = (lk.y + rk.y) / 2;
  return (kneeY - hipY) < 0.06 && hipY > 0.5;
}

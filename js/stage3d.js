/**
 * ============================================================================
 * motion-wave-dj · 任务 3 —— 3D 舞台模块 Stage3D（作者：Felix）
 * ============================================================================
 * QQ 炫舞风格夜店舞台：全程序化生成，零外部素材（贴图/模型均由代码生成）。
 *
 * 场景构成：
 *   1. 发光地砖阵列  12×12 InstancedMesh，节拍波纹扩散 + 打击脉冲，随 setMode 换色
 *   2. 背景巨型 LED 屏  CanvasTexture 每帧动画（滚动霓虹字/波形/频谱柱/点阵）
 *   3. 摇头灯阵列  8 台 SpotLight（仅 2 台开投影省性能）+ 锥形光束随节拍扫摆
 *   4. 镭射光束  6 条 additive 发光柱旋转扫射，flash 时变色提亮
 *   5. 粒子系统  环境彩带 800 粒（飘落+节拍上抛）+ 打击爆发粒子池 320 粒
 *   6. 镜面地板  metalness=1 + RoomEnvironment IBL 反射（性能优先，不用 Reflector）
 *   7. 骨架人偶  33 关节 + 36 骨骼 InstancedMesh，P1 青 #00e5ff / P2 品红 #ff2bd6，
 *                姿态 lerp 0.3（按 dt 校正）平滑，无人自动淡出
 *   8. DJ 台 + 桁架  box/圆柱组合装饰，转盘随节拍旋转
 *
 * 依赖（index.html importmap，契约固定）：
 *   three / three/addons/postprocessing/{EffectComposer,RenderPass,
 *   UnrealBloomPass,OutputPass} / three/addons/environments/RoomEnvironment
 *
 * 已知陷阱规避（务必保持）：
 *   - 不调用 BufferGeometry.getSize()（该方法不存在，属 Box3）；
 *     本模块所有几何尺寸均为已知常量，无需从 geometry 反查
 *   - 顶层 ESM import 无法 try/catch：addon 必须用精确官方路径静态导入，
 *     路径错一个字符整页 ESM 求值中断；仅 composer 的"初始化逻辑"用
 *     try/catch 降级（失败时 composer=null，render 直接 renderer.render）
 *   - 所有动画基于 dt（帧率无关），姿态插值系数按 dt 校正（60fps 基准 = 0.3）
 *   - 性能自适应：平均 FPS<30 持续 2 秒自动逐级降级（阴影→粒子/LED→bloom）
 * ============================================================================
 */

import * as THREE from 'three';
// —— 顶层静态 import：以下 addon 路径必须逐字符精确，否则整页不执行 ——
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';

/* ============================== 常量配置 ============================== */

// 场景配色主题：hueA/hueB 为两极色相（0~1，HSL）
const MODE_PALETTES = {
  dj:     { hueA: 0.75, hueB: 0.52 },  // dj：紫 + 青
  create: { hueA: 0.10, hueB: 0.55 },  // create：金橙 + 青点缀
  free:   { hueA: 0.00, hueB: 0.33 },  // free：彩虹循环（每帧推进色相）
};

// MediaPipe Pose 33 点骨骼连接表（内置，零外部依赖；与 pose.js 点序一致）
const POSE_BONES = [
  [0, 1], [1, 2], [2, 3], [3, 7], [0, 4], [4, 5], [5, 6], [6, 8], [9, 10],
  [11, 12], [11, 13], [13, 15], [15, 17], [15, 19], [15, 21], [17, 19],
  [12, 14], [14, 16], [16, 18], [18, 20], [16, 22], [20, 22],
  [11, 23], [12, 24], [23, 24],
  [23, 25], [24, 26], [25, 27], [26, 28],
  [27, 29], [28, 30], [29, 31], [30, 32], [27, 31], [28, 32],
];

const TILE_GRID = 12;       // 发光地砖阵列 12×12
const TILE_CELL = 0.8;      // 单格边长（米）
const CONFETTI_N = 800;     // 环境彩带粒子数
const BURST_N = 320;        // 打击爆发粒子池容量
const BURST_PER_HIT = 72;   // 每次打击喷发粒子数
const PLAYER_HIP_Y = 0.95;  // 人偶髋部离地高度（米，world 以髋部为原点）
const DOLL_LERP = 0.3;      // 姿态平滑系数（60fps 帧基准，契约规定）
const HEAD_BASE_I = 240;    // 摇头灯基础强度（three r155+ 物理光照单位 candela）

/* 工具：Color 线性值 → canvas 用 sRGB CSS 颜色串（three r152+ 颜色管理） */
function _css(c, a) {
  const r = Math.round(Math.pow(Math.min(Math.max(c.r, 0), 1), 0.4545) * 255);
  const g = Math.round(Math.pow(Math.min(Math.max(c.g, 0), 1), 0.4545) * 255);
  const b = Math.round(Math.pow(Math.min(Math.max(c.b, 0), 1), 0.4545) * 255);
  return a != null ? `rgba(${r},${g},${b},${a})` : `rgb(${r},${g},${b})`;
}

/* ============================== 3D 舞台 ============================== */

export class Stage3D {
  constructor() {
    this._ready = false;
    this._time = 0;           // 舞台内部累计时间（秒）
    this._beat = 0;           // 当前节拍脉冲 0..1（game.js 由音频 onBeat 驱动）
    this._mode = 'dj';        // 场景氛围模式 'dj'|'create'|'free'
    this._players = 1;        // 玩家数 1|2

    // 性能自适应状态
    this._fpsEMA = 60;        // FPS 指数滑动平均
    this._lowTimer = 0;       // 低 FPS 持续时长
    this._degradeLevel = 0;   // 降级级别 0~3（单向，不回升）
    this._frameCount = 0;

    // 打击反馈状态
    this._flashPower = 0;     // 打击能量 0..1（指数衰减）
    this._flashLane = 'both';
    this._laserHueShift = 0;  // 镭射换色累积偏移

    // 主题色板当前值（每帧朝目标色相插值）
    this._hueA = MODE_PALETTES.dj.hueA;
    this._hueB = MODE_PALETTES.dj.hueB;
    this._colorA = new THREE.Color();
    this._colorB = new THREE.Color();

    // 复用临时对象，避免每帧分配触发 GC
    this._m4 = new THREE.Matrix4();
    this._q = new THREE.Quaternion();
    this._v1 = new THREE.Vector3();
    this._v2 = new THREE.Vector3();
    this._v3 = new THREE.Vector3();
    this._up = new THREE.Vector3(0, 1, 0); // 骨骼对齐基准轴（常量；setFromUnitVectors 只读入参，不复用 _c1）
    this._c1 = new THREE.Color();
    this._c2 = new THREE.Color();
  }

  /* ------------------------------------------------------------ 初始化 */
  async init(canvas) {
    if (this._ready) return;
    if (!canvas) throw new Error('[Stage3D] init(canvas) 需要传入画布元素');

    // —— 渲染器（写实感配置，契约指定） ——
    this._renderer = new THREE.WebGLRenderer({
      canvas, antialias: true, powerPreference: 'high-performance',
    });
    this._renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this._renderer.setSize(window.innerWidth, window.innerHeight);
    this._renderer.shadowMap.enabled = true;
    this._renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this._renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this._renderer.toneMappingExposure = 1.05;
    this._renderer.outputColorSpace = THREE.SRGBColorSpace;

    // —— 场景与相机 ——
    this._scene = new THREE.Scene();
    this._scene.background = new THREE.Color(0x05020c);
    this._scene.fog = new THREE.FogExp2(0x070312, 0.024); // 指数雾营造纵深
    this._camera = new THREE.PerspectiveCamera(
      55, window.innerWidth / Math.max(1, window.innerHeight), 0.1, 120
    );
    this._camera.position.set(0, 3.2, 8.6);
    this._camera.lookAt(0, 1.5, 0);

    // —— IBL 环境反射：PMREMGenerator + RoomEnvironment（程序化室内环境） ——
    const pmrem = new THREE.PMREMGenerator(this._renderer);
    this._scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    pmrem.dispose();

    this._buildLights();
    this._buildFloor();
    this._buildLED();
    this._buildTruss();
    this._buildMovingHeads();
    this._buildLasers();
    this._buildParticles();
    this._buildDolls();
    this._buildDJBooth();

    this._initComposer();
    this.resize();
    this._ready = true;
  }

  /* 后处理：EffectComposer + Bloom + OutputPass；初始化逻辑 try/catch 降级 */
  _initComposer() {
    try {
      const w = window.innerWidth, h = Math.max(1, window.innerHeight);
      this._composer = new EffectComposer(this._renderer);
      this._composer.addPass(new RenderPass(this._scene, this._camera));
      this._bloom = new UnrealBloomPass(new THREE.Vector2(w, h), 0.55, 0.6, 0.82);
      this._composer.addPass(this._bloom);
      this._composer.addPass(new OutputPass());
    } catch (err) {
      console.warn('[Stage3D] 后处理初始化失败，降级为 renderer 直渲：', err);
      this._composer = null;
      this._bloom = null;
    }
  }

  /* ------------------------------------------------------------ 灯光 */
  _buildLights() {
    const s = this._scene;
    // 主定向光（暖白顶光，唯一的全局阴影来源之一）
    this._dirLight = new THREE.DirectionalLight(0xfff2e0, 2.6);
    this._dirLight.position.set(6, 10, 7);
    this._dirLight.castShadow = true;
    this._dirLight.shadow.mapSize.set(1024, 1024);
    const sc = this._dirLight.shadow.camera;
    sc.left = -9; sc.right = 9; sc.top = 9; sc.bottom = -9;
    sc.near = 1; sc.far = 40;
    this._dirLight.shadow.bias = -0.0006;
    s.add(this._dirLight);
    // 半球环境辅助（暗紫天光 + 深色地面反弹，保持夜店暗场基调）
    s.add(new THREE.HemisphereLight(0x5547a8, 0x0d0512, 0.38));
  }

  /* ------------------------------------------------- 地板 / 地砖 / 墙体 */
  _buildFloor() {
    const s = this._scene;
    // 镜面主地板：metalness=1 + low roughness + IBL 反射模拟镜面（不用 Reflector）
    const floor = new THREE.Mesh(
      new THREE.PlaneGeometry(30, 30),
      new THREE.MeshStandardMaterial({
        color: 0x17131f, metalness: 1, roughness: 0.16, envMapIntensity: 0.9,
      })
    );
    floor.rotation.x = -Math.PI / 2;
    floor.receiveShadow = true;
    s.add(floor);

    // 发光地砖阵列：InstancedMesh + instanceColor（Float32 支持 HDR>1，配合 bloom 发光）
    const n = TILE_GRID * TILE_GRID;
    const tiles = new THREE.InstancedMesh(
      new THREE.BoxGeometry(TILE_CELL * 0.86, 0.05, TILE_CELL * 0.86),
      new THREE.MeshBasicMaterial({ color: 0xffffff }), // 颜色全由 instanceColor 提供
      n
    );
    tiles.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    const m = this._m4, half = (TILE_GRID - 1) / 2;
    for (let r = 0; r < TILE_GRID; r++) {
      for (let c = 0; c < TILE_GRID; c++) {
        m.makeTranslation((c - half) * TILE_CELL, 0.028, (r - half) * TILE_CELL + 0.8);
        tiles.setMatrixAt(r * TILE_GRID + c, m);
        tiles.setColorAt(r * TILE_GRID + c, this._c1.setRGB(0.15, 0.15, 0.15));
      }
    }
    tiles.instanceColor.setUsage(THREE.DynamicDrawUsage);
    tiles.frustumCulled = false;
    this._tiles = tiles;
    s.add(tiles);

    // 包围墙体（低成本封闭空间，暗色低反光）
    const wallMat = new THREE.MeshStandardMaterial({
      color: 0x120b1e, roughness: 0.85, metalness: 0.1,
    });
    const wl = new THREE.Mesh(new THREE.PlaneGeometry(26, 10), wallMat);
    wl.position.set(-10.5, 5, -1); wl.rotation.y = Math.PI / 2; s.add(wl);
    const wr = wl.clone();
    wr.position.x = 10.5; wr.rotation.y = -Math.PI / 2; s.add(wr);
    const wb = new THREE.Mesh(
      new THREE.PlaneGeometry(23, 12),
      new THREE.MeshStandardMaterial({ color: 0x0b0616, roughness: 0.9 })
    );
    wb.position.set(0, 6, -8.6); s.add(wb);
  }

  /* ------------------------------------------------------- 背景巨型 LED 屏 */
  _buildLED() {
    // CanvasTexture 每帧程序化动画：滚动霓虹大字 + 波形 + 频谱柱 + LED 点阵
    const cv = document.createElement('canvas');
    cv.width = 512; cv.height = 256;
    this._ledCanvas = cv;
    this._ledCtx = cv.getContext('2d');
    const tex = new THREE.CanvasTexture(cv);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 4;
    this._ledTex = tex;

    const mesh = new THREE.Mesh(
      new THREE.PlaneGeometry(15, 7.5),
      new THREE.MeshBasicMaterial({ map: tex, fog: false }) // fog=false 保持屏面鲜艳
    );
    mesh.position.set(0, 4.4, -7.5);
    this._scene.add(mesh);

    // 屏幕背板边框
    const back = new THREE.Mesh(
      new THREE.PlaneGeometry(15.7, 8.15),
      new THREE.MeshStandardMaterial({ color: 0x0a0713, roughness: 0.6, metalness: 0.5 })
    );
    back.position.set(0, 4.4, -7.56);
    this._scene.add(back);
  }

  /* ------------------------------------------------------------- 桁架 */
  _buildTruss() {
    const mat = new THREE.MeshStandardMaterial({
      color: 0x1a1626, roughness: 0.45, metalness: 0.85,
    });
    const beam = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.08, 11, 8), mat);
    beam.rotation.z = Math.PI / 2;
    beam.position.set(0, 6.1, -4.4);
    beam.castShadow = true;
    this._scene.add(beam);
    for (const x of [-5.4, 5.4]) {
      const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.12, 6.1, 8), mat);
      pole.position.set(x, 3.05, -4.4);
      pole.castShadow = true;
      this._scene.add(pole);
    }
  }

  /* ------------------------------------------------------ 摇头灯阵列 ×8 */
  _buildMovingHeads() {
    this._heads = [];
    const bodyGeo = new THREE.BoxGeometry(0.34, 0.42, 0.34);
    const bodyMat = new THREE.MeshStandardMaterial({
      color: 0x05060a, roughness: 0.35, metalness: 0.8,
    });
    // 光束锥：高度 1，尖部平移到原点、沿 -Y 展开，渲染时按目标距离缩放
    const coneGeo = new THREE.ConeGeometry(0.9, 1, 16, 1, true);
    coneGeo.translate(0, -0.5, 0);
    for (let i = 0; i < 8; i++) {
      const x = i - 3.5;
      const group = new THREE.Group();
      group.position.set(x, 5.82, -4.4);
      const body = new THREE.Mesh(bodyGeo, bodyMat);
      body.castShadow = true;
      group.add(body);
      // 灯头透镜（发光小球，颜色随灯色/打击更新）
      const lensMat = new THREE.MeshBasicMaterial({ color: 0xffffff });
      const lens = new THREE.Mesh(new THREE.SphereGeometry(0.09, 10, 8), lensMat);
      lens.position.set(0, -0.24, 0);
      group.add(lens);
      // 可见光束（additive 半透明，不写深度，fog=false 防雾灰化）
      const cone = new THREE.Mesh(coneGeo, new THREE.MeshBasicMaterial({
        color: 0xffffff, transparent: true, opacity: 0.08,
        blending: THREE.AdditiveBlending, depthWrite: false,
        side: THREE.DoubleSide, fog: false,
      }));
      group.add(cone);
      // SpotLight：物理光照单位（decay=2）；仅左右各 1 台开投影省性能
      const spot = new THREE.SpotLight(0x88ccff, HEAD_BASE_I, 30, 0.36, 0.55, 2);
      spot.position.set(x, 5.82, -4.4);
      if (i === 0 || i === 7) {
        spot.castShadow = true;
        spot.shadow.mapSize.set(1024, 1024);
        spot.shadow.bias = -0.0005;
        spot.shadow.camera.far = 30;
      }
      const target = new THREE.Object3D();
      target.position.set(x, 0, 0.6);
      this._scene.add(target);
      spot.target = target;
      this._scene.add(spot);
      this._scene.add(group);
      this._heads.push({ spot, target, cone, lensMat, baseX: x, phase: i * 0.7, left: x < 0 });
    }
  }

  /* ------------------------------------------------------- 镭射光束 ×6 */
  _buildLasers() {
    this._lasers = [];
    const geo = new THREE.CylinderGeometry(0.022, 0.022, 1, 6);
    geo.translate(0, 0.5, 0); // 起点在原点，沿 +Y 延伸，渲染时用 rotation 扫射
    for (let i = 0; i < 6; i++) {
      const mat = new THREE.MeshBasicMaterial({
        color: 0xff2bd6, transparent: true, opacity: 0.3,
        blending: THREE.AdditiveBlending, depthWrite: false, fog: false,
      });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.position.set(-3.75 + i * 1.5, 5.95, -4.3);
      mesh.frustumCulled = false;
      this._scene.add(mesh);
      this._lasers.push({ mesh, mat, phase: i * 1.05, speed: 0.8 + (i % 3) * 0.23 });
    }
  }

  /* ------------------------------------------- 粒子系统：彩带 + 爆发池 */
  _buildParticles() {
    // —— 环境彩带：800 粒缓慢飘落，节拍上抛 ——
    const n = CONFETTI_N;
    this._confN = n;
    const pos = new Float32Array(n * 3), col = new Float32Array(n * 3);
    this._confVel = new Float32Array(n);   // 垂直下落速度
    this._confPhase = new Float32Array(n); // 水平摆动相位
    for (let i = 0; i < n; i++) {
      pos[i * 3] = (Math.random() - 0.5) * 12;
      pos[i * 3 + 1] = Math.random() * 7;
      pos[i * 3 + 2] = (Math.random() - 0.5) * 9;
      this._confVel[i] = 0.25 + Math.random() * 0.5;
      this._confPhase[i] = Math.random() * Math.PI * 2;
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    this._confGeo = g; this._confPos = pos; this._confCol = col;
    this._confetti = new THREE.Points(g, new THREE.PointsMaterial({
      size: 0.07, vertexColors: true, transparent: true, opacity: 0.95,
      blending: THREE.AdditiveBlending, depthWrite: false, sizeAttenuation: true,
    }));
    this._confetti.frustumCulled = false;
    this._scene.add(this._confetti);
    this._refreshConfettiColors();

    // —— 打击爆发粒子池：循环复用，HDR 颜色随寿命衰减（additive 黑=不可见） ——
    const bn = BURST_N;
    const bpos = new Float32Array(bn * 3), bcol = new Float32Array(bn * 3);
    this._burstVel = new Float32Array(bn * 3);
    this._burstLife = new Float32Array(bn);
    this._burstMaxLife = new Float32Array(bn);
    this._burstBase = new Float32Array(bn * 3); // 基色 HDR（衰减系数乘它）
    this._burstCursor = 0;
    const bg = new THREE.BufferGeometry();
    bg.setAttribute('position', new THREE.BufferAttribute(bpos, 3));
    bg.setAttribute('color', new THREE.BufferAttribute(bcol, 3));
    this._burstGeo = bg; this._burstPos = bpos; this._burstCol = bcol;
    this._burst = new THREE.Points(bg, new THREE.PointsMaterial({
      size: 0.1, vertexColors: true, transparent: true,
      blending: THREE.AdditiveBlending, depthWrite: false,
    }));
    this._burst.frustumCulled = false;
    this._scene.add(this._burst);
  }

  /* 按当前模式重算彩带颜色（free=全彩虹，其余为主题两色间分布） */
  _refreshConfettiColors() {
    const free = this._mode === 'free';
    const c = this._c1, col = this._confCol;
    for (let i = 0; i < this._confN; i++) {
      if (free) c.setHSL((i / this._confN) % 1, 0.95, 0.6);
      else c.setHSL(this._lerpHue(this._hueA, this._hueB, Math.random()), 0.95, 0.62);
      const k = 0.7 + Math.random() * 1.4; // HDR：部分粒子越过 bloom 阈值
      col[i * 3] = c.r * k; col[i * 3 + 1] = c.g * k; col[i * 3 + 2] = c.b * k;
    }
    this._confGeo.attributes.color.needsUpdate = true;
  }

  /* -------------------------------------------------- 玩家骨架人偶 ×2 */
  _buildDolls() {
    this._dolls = [];
    const specs = [
      { color: 0x00e5ff },  // P1 青
      { color: 0xff2bd6 },  // P2 品红
    ];
    const jointGeo = new THREE.SphereGeometry(0.035, 10, 8);
    const boneGeo = new THREE.CylinderGeometry(0.016, 0.016, 1, 6); // 单位高，scale.y=骨长
    for (let p = 0; p < 2; p++) {
      const group = new THREE.Group();
      group.position.set(0, PLAYER_HIP_Y, 0.8); // world 以髋部为原点，y 抬到髋高
      // HDR 发光色（>1 触发 bloom）；骨色略暗分层
      const jointMat = new THREE.MeshBasicMaterial({
        color: new THREE.Color(specs[p].color).multiplyScalar(2.1),
        transparent: true, opacity: 0,
      });
      const boneMat = new THREE.MeshBasicMaterial({
        color: new THREE.Color(specs[p].color).multiplyScalar(1.15),
        transparent: true, opacity: 0,
      });
      const joints = new THREE.InstancedMesh(jointGeo, jointMat, 33);
      const bones = new THREE.InstancedMesh(boneGeo, boneMat, POSE_BONES.length);
      joints.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      bones.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      joints.frustumCulled = false;
      bones.frustumCulled = false;
      group.add(joints); group.add(bones);
      // 站位光圈（呼吸 + 节拍放大）
      const ringMat = new THREE.MeshBasicMaterial({
        color: specs[p].color, transparent: true, opacity: 0,
        blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
      });
      const ring = new THREE.Mesh(new THREE.RingGeometry(0.5, 0.62, 40), ringMat);
      ring.rotation.x = -Math.PI / 2;
      ring.position.y = -PLAYER_HIP_Y + 0.06;
      group.add(ring);
      this._scene.add(group);
      const cur = [], tgt = [];
      for (let i = 0; i < 33; i++) { cur.push(new THREE.Vector3()); tgt.push(new THREE.Vector3()); }
      this._dolls.push({
        group, joints, bones, jointMat, boneMat, ring, ringMat,
        cur, tgt, conf: new Float32Array(33), presence: 0, lastSeen: -10,
      });
    }
  }

  /* ------------------------------------------------------ DJ 台 + 装饰 */
  _buildDJBooth() {
    const g = new THREE.Group();
    const dark = new THREE.MeshStandardMaterial({
      color: 0x0c0a14, roughness: 0.4, metalness: 0.7,
    });
    const body = new THREE.Mesh(new THREE.BoxGeometry(3.4, 1.05, 1.25), dark);
    body.position.y = 0.55; body.castShadow = true; g.add(body);
    const top = new THREE.Mesh(
      new THREE.BoxGeometry(3.6, 0.08, 1.45),
      new THREE.MeshStandardMaterial({ color: 0x15111f, roughness: 0.25, metalness: 0.85 })
    );
    top.position.y = 1.12; top.castShadow = true; g.add(top);
    // 打碟转盘 ×2（随节拍旋转）
    const ttGeo = new THREE.CylinderGeometry(0.33, 0.33, 0.05, 24);
    const ttMat = new THREE.MeshStandardMaterial({ color: 0x08080c, roughness: 0.3, metalness: 0.6 });
    const pinMat = new THREE.MeshStandardMaterial({ color: 0xd8d8e8, metalness: 1, roughness: 0.2 });
    this._turntables = [];
    for (const x of [-0.95, 0.95]) {
      const tt = new THREE.Mesh(ttGeo, ttMat);
      tt.position.set(x, 1.19, 0.15); g.add(tt);
      this._turntables.push(tt);
      const pin = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.04, 0.07, 12), pinMat);
      pin.position.set(x, 1.21, 0.15); g.add(pin);
    }
    // 调音台（装饰）
    const mixer = new THREE.Mesh(
      new THREE.BoxGeometry(1.0, 0.06, 0.5),
      new THREE.MeshStandardMaterial({ color: 0x1a1526, roughness: 0.35, metalness: 0.5 })
    );
    mixer.position.set(0, 1.19, 0.15); g.add(mixer);
    // 正面发光条（颜色随主题 + 节拍 + 打击更新）
    this._djStripMat = new THREE.MeshBasicMaterial({ color: 0x00e5ff });
    for (const [w, y] of [[3.2, 0.78], [3.2, 0.42]]) {
      const strip = new THREE.Mesh(new THREE.BoxGeometry(w, y === 0.78 ? 0.09 : 0.03, 0.03), this._djStripMat);
      strip.position.set(0, y, 0.64); g.add(strip);
    }
    g.position.set(0, 0, -4.6);
    this._scene.add(g);
  }

  /* ============================ 对外契约 ============================ */

  /** 窗口尺寸变化（game.js 绑定 resize 事件） */
  resize() {
    if (!this._ready) return;
    const w = window.innerWidth, h = Math.max(1, window.innerHeight);
    if (w < 1) return;
    this._camera.aspect = w / h;
    this._camera.updateProjectionMatrix();
    this._renderer.setSize(w, h);
    if (this._composer) this._composer.setSize(w, h);
  }

  /**
   * 每帧渲染（game.js 的 rAF 循环调用）
   * @param {number} dt 帧间隔秒
   * @param {number} beatPulse 0..1 节拍脉冲（音频 onBeat 驱动）
   */
  render(dt, beatPulse) {
    if (!this._ready) return;
    // dt 防御：非法值兜底 + 夹取（防切后台回来后物理/动画炸帧）
    dt = (typeof dt === 'number' && isFinite(dt) && dt > 0) ? dt : 0.016;
    dt = Math.min(dt, 0.1);
    this._beat = Math.min(Math.max(Number(beatPulse) || 0, 0), 1);
    this._time += dt;
    const t = this._time, beat = this._beat;

    // 打击能量指数衰减（帧率无关）
    this._flashPower *= Math.exp(-dt * 3.6);

    this._updatePalette(dt);
    this._updateFloorTiles(t, beat);
    this._updateLED(t, beat);
    this._updateMovingHeads(t, beat);
    this._updateLasers(t, beat);
    this._updateConfetti(dt, t, beat);
    this._updateBurst(dt);
    this._updateDolls(dt, t);
    this._updateDJ(t, dt, beat);

    // 相机呼吸微动（廉价高级感）
    this._camera.position.y = 3.2 + Math.sin(t * 0.5) * 0.09;
    this._camera.lookAt(0, 1.5, 0);

    if (this._composer) this._composer.render(dt);
    else this._renderer.render(this._scene, this._camera); // 后处理失败降级直渲

    this._updatePerf(dt);
  }

  /**
   * 喂入姿态数据（来自 pose.js），驱动骨架人偶
   * @param {Array} persons [{landmarks, world}]，x 已镜像；P1=画面左
   */
  setPose(persons) {
    if (!this._ready || !Array.isArray(persons)) return;
    for (let p = 0; p < 2; p++) {
      const person = persons[p];
      if (!person) continue; // 无数据的人偶由 render 中超时逻辑淡出
      const d = this._dolls[p];
      d.lastSeen = this._time;
      const world = person.world, lm = person.landmarks;
      for (let i = 0; i < 33; i++) {
        const w = world ? world[i] : null;
        if (w && isFinite(w.x) && isFinite(w.y) && isFinite(w.z)) {
          // 置信度：world 未带 visibility（pose.js 只映射 xyz），回退到 landmarks
          const vis = (lm && lm[i] && typeof lm[i].visibility === 'number')
            ? lm[i].visibility : 1;
          if (vis < 0.25) { d.conf[i] = Math.max(0, d.conf[i] - 0.25); continue; } // 低置信度冻结该点
          // world 为米制、髋部原点：y 向下→向上取负，z 越小越近相机→镜像到 three +z 朝相机
          d.tgt[i].set(w.x, -w.y, -w.z);
          d.conf[i] = vis;
        } else if (lm && lm[i] && isFinite(lm[i].x)) {
          // 退化路径：无 world 时用归一化屏幕坐标粗略映射到人偶局部空间
          const l = lm[i];
          const vis = (typeof l.visibility === 'number') ? l.visibility : 1;
          if (vis >= 0.25) {
            d.tgt[i].set((l.x - 0.5) * 1.6, (0.5 - l.y) * 1.9, -(l.z || 0) * 1.2);
            d.conf[i] = vis;
          } else d.conf[i] = Math.max(0, d.conf[i] - 0.25);
        }
      }
    }
  }

  /**
   * 打击反馈：灯光爆闪 + 镭射变色 + 地砖脉冲
   * @param {string} lane 'left'|'right'|'both'|'squat'
   */
  flash(lane) {
    if (!this._ready) return;
    this._flashLane = (lane === 'left' || lane === 'right' || lane === 'squat') ? lane : 'both';
    this._flashPower = 1;
    this._laserHueShift = (this._laserHueShift + 0.147) % 1; // 每次打击镭射换色
  }

  /** 打击点粒子爆发 */
  spawnBurst(lane) {
    if (!this._ready) return;
    const spots = {
      left: [-2.3, 1.5, 1.6], right: [2.3, 1.5, 1.6],
      both: [0, 2.1, 1.6], squat: [0, 0.35, 1.2],
    };
    const s = spots[lane] || spots.both;
    const count = this._degradeLevel >= 2 ? Math.floor(BURST_PER_HIT / 2) : BURST_PER_HIT;
    const cA = this._colorA, cB = this._colorB;
    for (let j = 0; j < count; j++) {
      const i = this._burstCursor;
      this._burstCursor = (this._burstCursor + 1) % BURST_N;
      this._burstPos[i * 3] = s[0];
      this._burstPos[i * 3 + 1] = s[1];
      this._burstPos[i * 3 + 2] = s[2];
      // 半球随机喷发（squat 全力向上）
      const th = Math.random() * Math.PI * 2, sp = 2.2 + Math.random() * 3.6;
      const up = lane === 'squat' ? 2.5 : 1.2;
      this._burstVel[i * 3] = Math.cos(th) * sp * 0.6;
      this._burstVel[i * 3 + 1] = up * Math.sqrt(Math.random()) + Math.random() * 1.5;
      this._burstVel[i * 3 + 2] = Math.sin(th) * sp * 0.6;
      const ml = 0.7 + Math.random() * 0.6;
      this._burstLife[i] = ml; this._burstMaxLife[i] = ml;
      // 基色：主题两色随机 + HDR 亮度
      const c = Math.random() < 0.5 ? cA : cB, k = 1.6 + Math.random() * 1.4;
      this._burstBase[i * 3] = c.r * k;
      this._burstBase[i * 3 + 1] = c.g * k;
      this._burstBase[i * 3 + 2] = c.b * k;
      this._burstCol[i * 3] = this._burstBase[i * 3];
      this._burstCol[i * 3 + 1] = this._burstBase[i * 3 + 1];
      this._burstCol[i * 3 + 2] = this._burstBase[i * 3 + 2];
    }
    this._burstGeo.attributes.position.needsUpdate = true;
    this._burstGeo.attributes.color.needsUpdate = true;
  }

  /** 切换场景氛围配色：'dj'|'create'|'free' */
  setMode(mode) {
    if (!MODE_PALETTES[mode]) mode = 'dj';
    if (mode === this._mode) return;
    this._mode = mode;
    this._refreshConfettiColors();
  }

  /** 设置玩家数：1 或 2（切换人偶站位） */
  setPlayers(n) {
    this._players = n === 2 ? 2 : 1;
    if (!this._ready) return;
    const xs = this._players === 2 ? [-0.95, 0.95] : [0, 0];
    this._dolls[0].group.position.x = xs[0];
    this._dolls[1].group.position.x = xs[1];
    if (this._players === 1) this._dolls[1].lastSeen = -10; // P2 淡出
  }

  /** 调试统计：{fps, drawCalls} */
  getStats() {
    return {
      fps: Math.round(this._fpsEMA),
      drawCalls: this._ready ? this._renderer.info.render.calls : 0,
    };
  }

  /* ============================ 逐帧更新 ============================ */

  /** 主题色板插值（free 模式色相随时间循环 → 彩虹） */
  _updatePalette(dt) {
    const P = MODE_PALETTES[this._mode] || MODE_PALETTES.dj;
    let ta = P.hueA, tb = P.hueB;
    if (this._mode === 'free') { ta = (this._time * 0.055) % 1; tb = (ta + 0.35) % 1; }
    const k = 1 - Math.exp(-dt * 2.5); // 帧率无关的过渡速度
    this._hueA = this._lerpHue(this._hueA, ta, k);
    this._hueB = this._lerpHue(this._hueB, tb, k);
    this._colorA.setHSL(this._hueA, 0.95, 0.58);
    this._colorB.setHSL(this._hueB, 0.95, 0.58);
  }

  /** 发光地砖：双波纹（涟漪扩散）+ 节拍中心脉冲 + 打击全亮 */
  _updateFloorTiles(t, beat) {
    const tiles = this._tiles, c = this._c2;
    const fp = this._flashPower, ca = this._colorA, cb = this._colorB;
    const half = (TILE_GRID - 1) / 2;
    for (let r = 0; r < TILE_GRID; r++) {
      for (let col = 0; col < TILE_GRID; col++) {
        const x = (col - half) * TILE_CELL, z = (r - half) * TILE_CELL + 0.8;
        const dist = Math.sqrt(x * x + z * z);
        const ripple = Math.max(0, Math.sin(dist * 1.5 - t * 3.4));       // 向外扩散的涟漪
        const pulse = beat * Math.exp(-dist * 0.28);                      // 节拍自中心衰减
        const f = 0.16 + ripple * 0.34 + pulse * 1.1 + fp * 0.5;          // 亮度包络
        const mixK = 0.5 + 0.5 * Math.sin(dist * 0.6 - t * 1.3);          // 双色混合
        c.copy(ca).lerp(cb, mixK).multiplyScalar(f);
        tiles.setColorAt(r * TILE_GRID + col, c);
      }
    }
    tiles.instanceColor.needsUpdate = true;
  }

  /** LED 屏：滚动霓虹字 + 频谱柱 + 波形 + 点阵 + 打击白闪（降级 L2 隔帧） */
  _updateLED(t, beat) {
    if (this._degradeLevel >= 2 && (this._frameCount & 1)) return;
    const ctx = this._ledCtx, W = 512, H = 256;
    const cA = this._colorA, cB = this._colorB, fp = this._flashPower;
    ctx.fillStyle = '#050310';
    ctx.fillRect(0, 0, W, H);
    // 频谱柱（伪随机高度 × 节拍）
    const bars = 36, bw = W / bars;
    for (let i = 0; i < bars; i++) {
      const nv = Math.sin(i * 12.9898 + t * 4.1) * 43758.5453;
      const rnd = nv - Math.floor(nv);
      const hgt = (0.12 + 0.5 * rnd + 0.55 * beat) * H * 0.42;
      ctx.fillStyle = _css(cA, 0.55 + 0.4 * rnd);
      ctx.fillRect(i * bw + 2, H - hgt, bw - 4, hgt);
    }
    // 中部波形线（振幅随节拍）
    ctx.strokeStyle = _css(cB);
    ctx.lineWidth = 3;
    ctx.beginPath();
    for (let x = 0; x <= W; x += 8) {
      const y = H * 0.46 + Math.sin(x * 0.045 + t * 5) * H * 0.09 * (0.5 + beat * 1.6)
        + Math.sin(x * 0.011 - t * 2.2) * H * 0.05;
      if (x === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.stroke();
    // 滚动霓虹大字（双份拼接无缝循环）
    const word = 'MOTION WAVE DJ   ★   ';
    ctx.font = 'bold 88px "Arial Black", Arial, sans-serif';
    const wordW = ctx.measureText(word).width;
    const off = -((t * 110) % wordW);
    ctx.fillStyle = '#ffffff';
    ctx.shadowColor = _css(cA, 0.9);
    ctx.shadowBlur = 22;
    for (let x = off - wordW; x < W + wordW; x += wordW) ctx.fillText(word, x, H * 0.75);
    ctx.shadowBlur = 0;
    // LED 点阵网格
    ctx.fillStyle = 'rgba(0,0,0,0.35)';
    for (let y = 0; y < H; y += 6) ctx.fillRect(0, y, W, 1);
    for (let x = 0; x < W; x += 6) ctx.fillRect(x, 0, 1, H);
    // 打击白闪
    if (fp > 0.02) {
      ctx.fillStyle = `rgba(255,255,255,${Math.min(0.55, fp * 0.55)})`;
      ctx.fillRect(0, 0, W, H);
    }
    this._ledTex.needsUpdate = true;
  }

  /** 摇头灯：节拍扫摆 + flash 白化爆闪（left/right/both/squat 分组） */
  _updateMovingHeads(t, beat) {
    const fp = this._flashPower, lane = this._flashLane;
    const ca = this._colorA, cb = this._colorB, white = this._c1.setRGB(1, 1, 1);
    const dir = this._v1, down = this._v2;
    for (let i = 0; i < this._heads.length; i++) {
      const h = this._heads[i];
      // 光斑扫摆（节拍轻微加速）
      h.target.position.x = h.baseX + Math.sin(t * (0.8 + 0.15 * beat) + h.phase) * 2.3;
      h.target.position.z = 0.6 + Math.cos(t * 0.62 + h.phase * 1.4) * 1.7;
      // 光锥对齐灯→目标方向，长度=距离
      dir.copy(h.target.position).sub(h.spot.position);
      const len = dir.length();
      dir.normalize();
      down.set(0, -1, 0);
      h.cone.quaternion.setFromUnitVectors(down, dir);
      h.cone.scale.set(1, len, 1);
      // flash 分组归属：squat/both 全闪，left 左 4 台，right 右 4 台
      const active = lane === 'both' || lane === 'squat'
        || (lane === 'left' && h.left) || (lane === 'right' && !h.left);
      const fm = active ? fp : 0;
      // 颜色：主题交替，打击白化；强度随节拍呼吸
      h.spot.color.copy(i % 2 === 0 ? ca : cb).lerp(white, Math.min(1, fm * 1.6));
      h.spot.intensity = HEAD_BASE_I * (0.55 + 0.45 * beat) * (1 + 3.4 * fm);
      h.cone.material.color.copy(h.spot.color);
      h.cone.material.opacity = 0.045 + 0.11 * beat + 0.22 * fm;
      h.lensMat.color.copy(h.spot.color).multiplyScalar(1 + 3 * fm + 1.2 * beat);
    }
  }

  /** 镭射：扫射摆动 + flash 变色提亮 */
  _updateLasers(t, beat) {
    const fp = this._flashPower;
    const hb = this._hueB, ha = (this._hueA + this._laserHueShift) % 1;
    const hue = this._lerpHue(hb, ha, Math.min(1, fp * 1.8)); // 打击时滑向换色色相
    for (const L of this._lasers) {
      L.mesh.rotation.z = Math.sin(t * L.speed + L.phase) * 0.6;        // 左右扫
      L.mesh.rotation.x = 2.25 + Math.sin(t * L.speed * 1.35 + L.phase * 2.1) * 0.3; // 前倾
      L.mat.color.setHSL(hue, 1, 0.55).multiplyScalar(1.6 + 2.4 * fp);
      L.mat.opacity = 0.15 + 0.2 * beat + 0.45 * fp;
    }
  }

  /** 环境彩带：下落 + 水平摆动 + 节拍上抛，落底回顶 */
  _updateConfetti(dt, t, beat) {
    const pos = this._confPos, vel = this._confVel, ph = this._confPhase;
    const lift = beat * 2.6;
    for (let i = 0; i < this._confN; i++) {
      let y = pos[i * 3 + 1] - vel[i] * dt + lift * dt * (0.5 + 0.5 * Math.sin(ph[i] + t * 2));
      pos[i * 3] += Math.sin(t * 0.8 + ph[i]) * 0.12 * dt;
      pos[i * 3 + 2] += Math.cos(t * 0.6 + ph[i] * 1.3) * 0.1 * dt;
      if (y < 0.05) { // 回收重生
        y = 6.5 + Math.random() * 1.5;
        pos[i * 3] = (Math.random() - 0.5) * 12;
        pos[i * 3 + 2] = (Math.random() - 0.5) * 9;
      }
      pos[i * 3 + 1] = y;
    }
    this._confGeo.attributes.position.needsUpdate = true;
  }

  /** 爆发粒子：重力 + 地面反弹 + 颜色平方衰减（additive 黑=消失） */
  _updateBurst(dt) {
    const pos = this._burstPos, col = this._burstCol, vel = this._burstVel;
    const life = this._burstLife, maxL = this._burstMaxLife, base = this._burstBase;
    for (let i = 0; i < BURST_N; i++) {
      if (life[i] <= 0) continue;
      life[i] -= dt;
      vel[i * 3 + 1] -= 7.5 * dt; // 重力
      pos[i * 3] += vel[i * 3] * dt;
      pos[i * 3 + 1] += vel[i * 3 + 1] * dt;
      pos[i * 3 + 2] += vel[i * 3 + 2] * dt;
      if (pos[i * 3 + 1] < 0.03) { // 地面反弹
        pos[i * 3 + 1] = 0.03;
        vel[i * 3 + 1] *= -0.4; vel[i * 3] *= 0.7; vel[i * 3 + 2] *= 0.7;
      }
      if (life[i] <= 0) { col[i * 3] = col[i * 3 + 1] = col[i * 3 + 2] = 0; continue; }
      const k = life[i] / maxL[i], kk = k * k; // 平方衰减更闪
      col[i * 3] = base[i * 3] * kk;
      col[i * 3 + 1] = base[i * 3 + 1] * kk;
      col[i * 3 + 2] = base[i * 3 + 2] * kk;
    }
    this._burstGeo.attributes.position.needsUpdate = true;
    this._burstGeo.attributes.color.needsUpdate = true;
  }

  /** 人偶：出场/淡出 + 姿态 lerp 0.3（dt 校正）+ 置信度缩放 + 站位光圈呼吸 */
  _updateDolls(dt, t) {
    const k = 1 - Math.pow(1 - DOLL_LERP, dt * 60); // 帧率无关，60fps 时 = 0.3
    const m = this._m4, q = this._q, scl = this._v2;
    // up 必须是 Vector3：_c1 是 THREE.Color，误用会导致 setFromUnitVectors 每帧
    // 抛 "vFrom.dot is not a function"，render 当帧中断（3D 冻结 + djTick 被跳过）
    const seg = this._v1, mid = this._v3, up = this._up;
    for (let p = 0; p < 2; p++) {
      const d = this._dolls[p];
      // 出场：0.6s 内有数据且被激活 → 渐显，否则淡出
      const target = ((t - d.lastSeen) < 0.6 && p < this._players) ? 1 : 0;
      d.presence += (target - d.presence) * (1 - Math.exp(-dt * 6));
      const vis = d.presence;
      d.jointMat.opacity = vis;
      d.boneMat.opacity = vis * 0.9;
      d.ringMat.opacity = vis * 0.5;
      d.group.visible = vis > 0.02; // 不可见时跳过 draw
      if (!d.group.visible) continue;
      // 首次出现直接贴合姿态（避免从原点飞入）
      const snap = vis < 0.05;
      for (let i = 0; i < 33; i++) {
        if (snap) d.cur[i].copy(d.tgt[i]);
        else d.cur[i].lerp(d.tgt[i], k);
        const jr = 0.3 + 0.7 * d.conf[i]; // 低置信度关节缩小
        scl.set(jr, jr, jr);
        m.compose(d.cur[i], q.identity(), scl);
        d.joints.setMatrixAt(i, m);
      }
      d.joints.instanceMatrix.needsUpdate = true;
      // 骨骼：中点定位 + 对齐方向 + scale.y=长度；两端置信度过低则隐藏
      for (let b = 0; b < POSE_BONES.length; b++) {
        const a = POSE_BONES[b][0], bb = POSE_BONES[b][1];
        seg.copy(d.cur[bb]).sub(d.cur[a]);
        const len = seg.length();
        const conf = (d.conf[a] + d.conf[bb]) * 0.5;
        if (len < 1e-4 || conf < 0.18) {
          m.makeScale(0, 0, 0);
          d.bones.setMatrixAt(b, m);
          continue;
        }
        seg.normalize();
        q.setFromUnitVectors(up, seg);
        mid.copy(d.cur[a]).add(d.cur[bb]).multiplyScalar(0.5);
        scl.set(1, len, 1);
        m.compose(mid, q, scl);
        d.bones.setMatrixAt(b, m);
      }
      d.bones.instanceMatrix.needsUpdate = true;
      // 站位光圈呼吸 + 节拍放大
      const rs = 1 + Math.sin(t * 2.2 + p) * 0.06 + this._beat * 0.12;
      d.ring.scale.set(rs, rs, 1);
    }
  }

  /** DJ 台：转盘随节拍旋转 + 正面发光条随主题/节拍/打击变色 */
  _updateDJ(t, dt, beat) {
    for (const tt of this._turntables) tt.rotation.y += dt * (1.2 + beat * 6);
    this._djStripMat.color.copy(this._colorA)
      .multiplyScalar(1.2 + 2.2 * beat + 2.5 * this._flashPower);
  }

  /* ========================== 性能自适应降级 ========================== */

  /** FPS 统计：指数滑动平均；<30 持续 2 秒触发一级降级（单向） */
  _updatePerf(dt) {
    this._frameCount++;
    this._fpsEMA += (1 / dt - this._fpsEMA) * 0.06;
    if (this._fpsEMA < 30) {
      this._lowTimer += dt;
      if (this._lowTimer > 2) { this._degrade(); this._lowTimer = 0; }
    } else this._lowTimer = 0;
  }

  /** 逐级降级：L1 关阴影 → L2 粒子减半+LED 隔帧 → L3 关 bloom */
  _degrade() {
    this._degradeLevel = Math.min(this._degradeLevel + 1, 3);
    const L = this._degradeLevel;
    if (L === 1) {
      // 关全部阴影（一次 shader 重编译，之后阴影 pass 整个跳过）
      this._dirLight.castShadow = false;
      for (const h of this._heads) h.spot.castShadow = false;
    } else if (L === 2) {
      // 粒子减半 + LED 屏隔帧刷新（_updateLED 内部判断 _frameCount 奇偶）
      this._confGeo.setDrawRange(0, Math.floor(this._confN / 2));
    } else if (L === 3) {
      // bloom 降级：跳过泛光 pass，OutputPass 仍保证 ACES+sRGB 正确输出
      if (this._bloom) this._bloom.enabled = false;
    }
    console.info(`[Stage3D] 性能自适应降级 → L${L}（阴影/粒子/bloom 阶梯）`);
  }

  /* 色相短弧插值（处理 0↔1 环绕） */
  _lerpHue(a, b, t) {
    let d = b - a;
    if (d > 0.5) d -= 1; else if (d < -0.5) d += 1;
    return ((a + d * t) % 1 + 1) % 1;
  }
}
/**
 * 数据流位置：编排层，也是唯一把各模块串起来的地方。
 *
 *   摄像头 → video → scheduler.update(video, ts, w, h)
 *                       ├─ handTracker.detect() → bus("hands:raw")
 *                       ├─ [stride 命中] poseTracker.detect() → bus("pose:raw")
 *                       └─ [stride 命中且有人] computeRelation() → bus("hand:relation")
 *                    → FrameResult → handOverlay / poseOverlay / panel
 *
 * emit 全部发生在 scheduler 内；这里只负责生命周期（权限、初始化、主循环、绘制、错误提示）。
 * 不实现任何识别算法，也不判断 poseFresh 决定是否绘制。
 */

import { DebugPanel } from "./debug/panel";
import { GestureEngine } from "./gestures/engine";
import { Overlay } from "./render/overlay";
import { PoseOverlay } from "./render/poseOverlay";
import type { Handedness } from "./vision/landmarks";
import { HandTracker } from "./vision/handTracker";
import { PoseTracker } from "./vision/poseTracker";
import { TrackerScheduler, type FrameResult } from "./vision/scheduler";

function mustGetElement<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`页面缺少 #${id} 元素`);
  return element as T;
}

const video = mustGetElement<HTMLVideoElement>("video");
const handCanvas = mustGetElement<HTMLCanvasElement>("handOverlay");
const poseCanvas = mustGetElement<HTMLCanvasElement>("poseOverlay");
const panelRoot = mustGetElement<HTMLElement>("panel");
const statusEl = mustGetElement<HTMLElement>("status");
const noticeEl = mustGetElement<HTMLElement>("notice");
const toggleHands = mustGetElement<HTMLInputElement>("toggleHands");
const togglePose = mustGetElement<HTMLInputElement>("togglePose");
const errorBox = mustGetElement<HTMLElement>("error");
const errorTitle = mustGetElement<HTMLElement>("errorTitle");
const errorDetail = mustGetElement<HTMLElement>("errorDetail");

const handTracker = new HandTracker((message) => {
  console.warn("[main] 手部推理不可用：", message);
  showNotice("手部识别不可用（运行时推理失败）。全身功能继续运行。");
});
const poseTracker = new PoseTracker();
const scheduler = new TrackerScheduler(handTracker, poseTracker);
const engine = new GestureEngine();
const panel = new DebugPanel(panelRoot);

let handOverlay: Overlay | null = null;
let poseOverlay: PoseOverlay | null = null;
let lastResult: FrameResult | null = null;
let stream: MediaStream | null = null;
let running = false;
let lastFrameTime = 0;
let lastWidth = 0;
let lastHeight = 0;
let fps = 0;

/** 判断系统里是否存在视频输入设备（用于区分「权限被拒」与「压根没有摄像头」）。 */
async function hasVideoInput(): Promise<boolean> {
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    return devices.some((device) => device.kind === "videoinput");
  } catch {
    // 枚举失败时不做额外断言，按“有设备但被拒绝”处理。
    return true;
  }
}

/** 把 getUserMedia 的异常翻译成用户能照做的提示。 */
async function describeCameraError(error: unknown): Promise<string> {
  if (error instanceof DOMException) {
    switch (error.name) {
      case "NotAllowedError":
      case "SecurityError": {
        const hasCamera = await hasVideoInput();
        if (!hasCamera) {
          return "没有找到可用的摄像头设备。请连接摄像头后刷新页面。";
        }
        return "摄像头权限被拒绝。请点击地址栏左侧的站点图标，把摄像头改为“允许”，然后刷新页面。";
      }
      case "NotFoundError":
      case "OverconstrainedError":
        return "没有找到可用的摄像头设备。请连接摄像头后刷新页面。";
      case "NotReadableError":
        return "摄像头被其他程序占用，或系统拒绝访问。请关闭正在使用摄像头的应用后重试。";
      default:
        return `${error.name}: ${error.message}`;
    }
  }
  return error instanceof Error ? error.message : String(error);
}

function showError(title: string, detail: string): void {
  running = false;
  statusEl.textContent = "启动失败";
  statusEl.dataset["state"] = "error";
  errorTitle.textContent = title;
  errorDetail.textContent = detail;
  errorBox.classList.remove("hidden");
  stream?.getTracks().forEach((track) => track.stop());
}

/** 非致命提示：单侧识别不可用时使用，不打断主循环。 */
function showNotice(message: string): void {
  noticeEl.textContent = message;
  noticeEl.hidden = false;
}

/**
 * 唯一计算画布像素尺寸的地方。
 * 先手部层、后姿态层；尺寸非正时直接返回。
 */
function syncCanvasSizes(): void {
  const width = video.videoWidth;
  const height = video.videoHeight;
  if (!(width > 0) || !(height > 0)) return;
  handOverlay?.resize(width, height);
  poseOverlay?.resize(width, height);
}

async function startCamera(): Promise<MediaStream> {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error("当前浏览器不支持 getUserMedia。请使用最新版 Chrome / Edge / Safari。");
  }
  // 摄像头只在安全上下文可用：localhost 或 https。
  if (!window.isSecureContext) {
    throw new Error("摄像头要求安全上下文。请通过 http://localhost 或 https 访问本页面。");
  }
  return navigator.mediaDevices.getUserMedia({
    audio: false,
    video: {
      facingMode: "user",
      width: { ideal: 1280 },
      height: { ideal: 720 },
      frameRate: { ideal: 30 },
    },
  });
}

type VideoWithFrameCallback = HTMLVideoElement & {
  requestVideoFrameCallback?: (callback: (now: number) => void) => number;
};

const videoWithFrameCallback = video as VideoWithFrameCallback;
const canUseVideoFrameCallback = typeof videoWithFrameCallback.requestVideoFrameCallback === "function";

function scheduleNextFrame(): void {
  if (!running) return;
  if (canUseVideoFrameCallback) {
    videoWithFrameCallback.requestVideoFrameCallback?.(onFrame);
  } else {
    requestAnimationFrame(onFrame);
  }
}

function onFrame(now: number): void {
  if (!running) return;

  if (lastFrameTime !== 0) {
    const delta = now - lastFrameTime;
    if (delta > 0) {
      const instant = 1000 / delta;
      fps = fps === 0 ? instant : fps * 0.9 + instant * 0.1;
    }
  }
  lastFrameTime = now;

  // 尺寸变化时重算两块画布；syncCanvasSizes 是唯一的尺寸计算入口。
  const width = video.videoWidth;
  const height = video.videoHeight;
  if (width > 0 && height > 0 && (width !== lastWidth || height !== lastHeight)) {
    lastWidth = width;
    lastHeight = height;
    syncCanvasSizes();
  }

  // scheduler 内部完成两个 tracker 的调度与全部 emit。
  const result = scheduler.update(video, now, width, height);
  lastResult = result;

  // 手势引擎沿用原有喂法与事件语义。
  // engine.update([]) 只清空内部状态，不会 emit "gesture"，因此无需额外拦截。
  engine.update(result.hands);
  const labels = engine.current();

  drawFrame(result, labels);

  panel.update(
    result.hands,
    labels,
    {
      fps,
      backend: `hand ${handTracker.currentBackend ?? "—"} · pose ${poseTracker.currentBackend}`,
      ready: handTracker.ready,
    },
    { hands: toggleHands.checked, pose: togglePose.checked },
    now,
  );

  scheduleNextFrame();
}

/**
 * 只负责按 FrameResult 绘制；开关只影响绘制，不影响推理。
 * 手部关闭时用空数组触发清空，不新增 Overlay 接口。
 */
function drawFrame(result: FrameResult, labels: ReadonlyMap<Handedness, string>): void {
  if (handOverlay) {
    if (toggleHands.checked) {
      handOverlay.draw(result.hands, labels);
    } else {
      handOverlay.draw([], labels);
    }
  }

  poseOverlay?.draw(result.pose, {
    visible: togglePose.checked && result.poseAgeMs !== Number.POSITIVE_INFINITY,
  });
}

async function start(): Promise<void> {
  statusEl.textContent = "等待摄像头授权…";

  try {
    stream = await startCamera();
  } catch (error) {
    showError("无法访问摄像头", await describeCameraError(error));
    return;
  }

  video.srcObject = stream;
  try {
    await video.play();
  } catch (error) {
    showError("画面无法播放", error instanceof Error ? error.message : String(error));
    return;
  }

  handOverlay = new Overlay(handCanvas);
  poseOverlay = new PoseOverlay(poseCanvas);
  syncCanvasSizes();
  statusEl.textContent = "加载识别模型…";

  // 两次 init 串行、各自 try/catch，互不短路。
  let handReady = false;
  try {
    await handTracker.init();
    handReady = true;
  } catch (error) {
    console.error("[main] 手部识别模型初始化失败", error);
    // 依赖：HandTracker.detect() 在未初始化时返回 []（不抛错），主循环可以继续。
  }

  let poseReady = false;
  try {
    await poseTracker.init();
    poseReady = true;
  } catch (error) {
    console.error("[main] 全身识别模型初始化失败", error);
    // 彻底关闭姿态链路：scheduler 不再推理、不再 emit pose:raw / hand:relation。
    scheduler.disablePose();
  }

  // 两者都失败才是致命错误。
  if (!handReady && !poseReady) {
    showError(
      "识别模型初始化失败",
      "手部与全身模型均未能加载。请确认 public/models 与 public/mediapipe/wasm 下的文件完整，且通过 npm run dev 访问。",
    );
    return;
  }

  if (!handReady) {
    showNotice("手部识别不可用：摄像头画面与全身骨架仍可用。");
  } else if (!poseReady) {
    showNotice("全身识别不可用，手部功能不受影响。");
  }

  console.info(
    `[dualskeleton] 就绪：hand ${handTracker.currentBackend ?? "unknown"} / pose ${poseTracker.currentBackend}；` +
      "模型输入为未镜像原始帧，两块画布与视频共用同一坐标系。",
  );

  statusEl.textContent = `识别中 · hand ${handTracker.currentBackend ?? "—"} / pose ${poseTracker.currentBackend}`;
  statusEl.dataset["state"] = "running";
  running = true;
  scheduleNextFrame();
}

/** 开关切换后立即重绘一次，不必等下一帧推理。 */
function redrawNow(): void {
  if (!lastResult) return;
  drawFrame(lastResult, engine.current());
}

video.addEventListener("loadedmetadata", syncCanvasSizes);
window.addEventListener("resize", syncCanvasSizes);
window.addEventListener("pagehide", () => {
  running = false;
  stream?.getTracks().forEach((track) => track.stop());
});

toggleHands.addEventListener("change", redrawNow);
// 姿态开关同时控制推理：关闭即停止姿态推理，重开后在下一个姿态帧恢复。
togglePose.addEventListener("change", () => {
  scheduler.setPoseEnabled(togglePose.checked);
  redrawNow();
});

void start();

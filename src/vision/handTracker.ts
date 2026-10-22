/**
 * 数据流位置：推理层。把摄像头帧变成结构化的 DetectedHand[]。
 *
 * 上游：main.ts 的主循环（requestVideoFrameCallback 给的时间戳 + <video> 元素）。
 * 下游：main.ts 拿到数组后 emit "hands:raw"，并交给 gestures/engine.ts。
 *
 * 本文件对外只暴露 init() 与 detect()。所有 MediaPipe 细节（资源路径、delegate 回退、
 * 时间戳约束、平滑）都封在内部，业务侧不需要关心。
 */

import {
  FilesetResolver,
  HandLandmarker,
  type HandLandmarkerResult,
} from "@mediapipe/tasks-vision";

import {
  HANDEDNESS_SWAP,
  LandmarkSmoother,
  type DetectedHand,
  type Handedness,
  type Pt,
} from "./landmarks";

/** 实际生效的推理后端。GPU 不可用时自动回落 CPU。 */
export type TrackerBackend = "GPU" | "CPU";

/** 模型与 wasm 全部自托管；BASE_URL 让项目部署到子路径时也能正确解析。 */
const WASM_DIR = `${import.meta.env.BASE_URL}mediapipe/wasm`;
const MODEL_URL = `${import.meta.env.BASE_URL}models/hand_landmarker.task`;

/** 连续多少帧推理失败后判定为不可用并上报（30fps 下约 1 秒）。 */
const FATAL_FAILURE_FRAMES = 30;
/** 运行期告警的抽样间隔，避免每帧刷屏。 */
const WARN_EVERY_FRAMES = 30;

function toPt(p: { x: number; y: number; z: number }): Pt {
  return { x: p.x, y: p.y, z: p.z };
}

function normalizeHandedness(label: string | undefined): Handedness {
  const anatomical: Handedness = label === "Left" ? "Left" : "Right";
  if (!HANDEDNESS_SWAP) return anatomical;
  return anatomical === "Left" ? "Right" : "Left";
}

export class HandTracker {
  private landmarker: HandLandmarker | null = null;
  private backend: TrackerBackend | null = null;
  private fileset: Awaited<ReturnType<typeof FilesetResolver.forVisionTasks>> | null = null;
  /** 运行期 GPU 失败只允许触发一次 CPU 回退，避免抖动时反复重建。 */
  private fallbackStarted = false;

  /** 每只手的平滑历史，按左右手分别缓存。 */
  private readonly smoother = new LandmarkSmoother();

  /** 上一次成功推理的视频时间（秒），用于跳过重复帧。 */
  private lastVideoTime = -1;
  /** 上一次送进模型的毫秒时间戳，保证严格单调递增。 */
  private lastTimestamp = 0;
  /** 同一帧被重复回调时，直接复用上次结果，避免重复推理与二次平滑。 */
  private lastHands: DetectedHand[] = [];
  /** 连续推理失败帧数。 */
  private consecutiveFailures = 0;
  private fatalReported = false;

  /**
   * @param onFatal 两种后端都不可用时的回调；由调用方负责提示用户，避免页面停留在“看似在跑”的状态。
   */
  constructor(private readonly onFatal: (message: string) => void = () => {}) {}

  /** 是否完成初始化。 */
  get ready(): boolean {
    return this.landmarker !== null;
  }

  /** 当前后端；初始化完成前为 null。 */
  get currentBackend(): TrackerBackend | null {
    return this.backend;
  }

  /**
   * 初始化 wasm 运行时与模型。
   * GPU delegate 失败会 console.warn 并自动回退 CPU；两者都失败才抛错，由调用方显示错误提示。
   */
  async init(): Promise<void> {
    this.fileset = await FilesetResolver.forVisionTasks(WASM_DIR);

    try {
      this.landmarker = await this.create("GPU");
      this.backend = "GPU";
    } catch (gpuError) {
      console.warn(
        "[handTracker] GPU delegate 初始化失败，正在回退到 CPU（WASM SIMD）。识别仍可用，但帧率会下降。",
        gpuError,
      );
      this.landmarker = await this.create("CPU");
      this.backend = "CPU";
    }
  }

  private create(delegate: TrackerBackend): Promise<HandLandmarker> {
    const fileset = this.fileset;
    if (!fileset) return Promise.reject(new Error("wasm 运行时尚未初始化"));
    return HandLandmarker.createFromOptions(fileset, {
      baseOptions: {
        modelAssetPath: MODEL_URL,
        delegate,
      },
      runningMode: "VIDEO",
      numHands: 2,
      minHandDetectionConfidence: 0.5,
      minHandPresenceConfidence: 0.5,
      minTrackingConfidence: 0.5,
    });
  }

  /**
   * 某些环境（例如无 WebGL 的机器）会让 createFromOptions 成功、却在首次推理时抛错。
   * 这种失败发生在 init() 之后，因此必须在 detect() 的异常路径里再回退一次。
   */
  private triggerCpuFallback(error: unknown): void {
    if (this.backend !== "GPU" || this.fallbackStarted) return;
    this.fallbackStarted = true;
    this.landmarker = null;
    // 后端切换期间画面可能移动，丢弃旧的平滑历史与结果，避免恢复后出现跳变。
    this.smoother.reset();
    this.lastHands = [];
    this.consecutiveFailures = 0;
    console.warn(
      "[handTracker] GPU 推理运行时报错，正在切换到 CPU（WASM SIMD）。识别会短暂中断。",
      error,
    );

    void (async () => {
      try {
        this.landmarker = await this.create("CPU");
        this.backend = "CPU";
        console.info("[handTracker] 已切换到 CPU 后端。");
      } catch (fallbackError) {
        console.error("[handTracker] CPU 回退同样失败，识别不可用。", fallbackError);
        this.reportFatal("GPU 与 CPU 后端都无法运行。请确认浏览器已启用硬件加速 / WebGL 后刷新页面。");
      }
    })();
  }

  /** 只在第一次触发，避免每帧重复弹错。 */
  private reportFatal(message: string): void {
    if (this.fatalReported) return;
    this.fatalReported = true;
    this.landmarker = null;
    this.onFatal(message);
  }

  /**
   * 对当前视频帧做一次检测。
   *
   * @param video 已开始播放的 <video>
   * @param timestampMs 来自 requestVideoFrameCallback / requestAnimationFrame 的单调时间戳
   */
  detect(video: HTMLVideoElement, timestampMs: number): DetectedHand[] {
    const landmarker = this.landmarker;
    if (!landmarker) return [];
    if (video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) return [];
    if (video.videoWidth === 0 || video.videoHeight === 0) return [];

    // 同一视频帧不重复推理（rAF 回退时可能一帧回调多次）。
    if (video.currentTime === this.lastVideoTime) return this.lastHands;
    this.lastVideoTime = video.currentTime;

    // 运行时要求时间戳严格单调递增，重复或倒退一律修正为上一帧 +1ms。
    let timestamp = Number.isFinite(timestampMs) ? Math.round(timestampMs) : this.lastTimestamp + 1;
    if (timestamp <= this.lastTimestamp) timestamp = this.lastTimestamp + 1;
    this.lastTimestamp = timestamp;

    let result: HandLandmarkerResult;
    try {
      result = landmarker.detectForVideo(video, timestamp);
    } catch (error) {
      this.consecutiveFailures += 1;
      if (this.backend === "GPU" && !this.fallbackStarted) {
        // GPU 后端首次失败：切换到 CPU。
        this.triggerCpuFallback(error);
      } else if (this.consecutiveFailures >= FATAL_FAILURE_FRAMES) {
        this.reportFatal("推理持续失败，识别已停止。请确认浏览器支持 WebGL 后刷新页面。");
      } else if (this.consecutiveFailures % WARN_EVERY_FRAMES === 1) {
        console.warn("[handTracker] 本帧推理失败，已跳过。", error);
      }
      return [];
    }

    this.consecutiveFailures = 0;

    const hands: DetectedHand[] = [];
    const seen = new Set<Handedness>();

    for (let i = 0; i < result.landmarks.length; i += 1) {
      const rawLandmarks = result.landmarks[i];
      if (!rawLandmarks) continue;

      const category = result.handednesses[i]?.[0];
      const handedness = normalizeHandedness(category?.categoryName);
      seen.add(handedness);

      // 同一帧出现两只同标签的手属于异常，保留置信度更高的一只。
      if (hands.some((h) => h.handedness === handedness)) continue;

      const world = result.worldLandmarks[i] ?? [];
      hands.push({
        handedness,
        score: category?.score ?? 0,
        lm: this.smoother.update(handedness, rawLandmarks.map(toPt)),
        world: world.map(toPt),
      });
    }

    // 手离开画面时丢弃该手的平滑历史与缓存，避免重新入画时出现“幽灵”位置。
    this.smoother.retain(seen);
    this.lastHands = hands;
    return hands;
  }
}

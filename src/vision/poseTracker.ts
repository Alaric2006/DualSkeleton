/**
 * 数据流位置：姿态推理层，与 vision/handTracker.ts 完全并列。
 *
 * 上游：main.ts / vision/scheduler.ts 每帧传入 <video> 与统一时间戳。
 * 下游：scheduler 拿到 DetectedPose 后 emit "pose:raw"，并在同一帧驱动 relation 计算。
 *
 * 本文件只负责「视频帧 → DetectedPose」：不做平滑、不做几何计算、不做坐标换算、
 * 不读写 DOM、不发事件。所有策略（stride、降频、关系推导）都在 scheduler / relation 层。
 *
 * 配置依据：D1（lite 模型、numPoses=1、outputSegmentationMasks=false）、D6（GPU 优先、CPU 回退）。
 * 运行期 GPU→CPU 回退已实现但未验证，阶段 3 真机复测时补验证。
 */

import {
  FilesetResolver,
  PoseLandmarker,
  type PoseLandmarkerResult,
} from "@mediapipe/tasks-vision";

import { POSE_LANDMARK_COUNT, type DetectedPose } from "./poseLandmarks";
import type { Pt } from "./landmarks";

/** 实际生效的推理后端；未初始化时为 "none"。 */
type PoseTrackerBackend = "GPU" | "CPU" | "none";

/**
 * 全部配置集中于此，禁止在实现里散落魔法值。
 * 来源：D1。delegate 为初始后端，失败时回退 fallbackDelegate。
 */
const POSE_TRACKER_CONFIG = {
  runningMode: "VIDEO",
  numPoses: 1,
  outputSegmentationMasks: false,
  delegate: "GPU",
  fallbackDelegate: "CPU",
} as const;

/** 模型与 wasm 自托管；BASE_URL 支持部署到子路径。 */
const WASM_DIR = `${import.meta.env.BASE_URL}mediapipe/wasm`;
const MODEL_URL = `${import.meta.env.BASE_URL}models/pose_landmarker_lite.task`;

type WasmFileset = Awaited<ReturnType<typeof FilesetResolver.forVisionTasks>>;

function toPt(p: { x: number; y: number; z: number }): Pt {
  return { x: p.x, y: p.y, z: p.z };
}

/**
 * score 的口径：MediaPipe PoseLandmarkerResult 不提供检测分数（本地 d.ts 已核对），
 * 这里取 33 点 visibility 的均值作为「可见度分数」，并夹到 0..1。
 * 该口径未在 Fact Sheet 中定义，已在阶段 3 报告中标注待确认。
 */
function meanVisibility(points: readonly { visibility?: number }[]): number {
  let sum = 0;
  let count = 0;
  for (const point of points) {
    const value = point.visibility;
    if (typeof value === "number" && Number.isFinite(value)) {
      sum += value;
      count += 1;
    }
  }
  if (count === 0) return 0;
  return Math.min(1, Math.max(0, sum / count));
}

export class PoseTracker {
  private landmarker: PoseLandmarker | null = null;
  private backend: PoseTrackerBackend = "none";
  /** 缓存 wasm 运行时，供运行期 CPU 回退时重建模型。 */
  private fileset: WasmFileset | null = null;
  /** 运行期 GPU 失败只允许触发一次 CPU 回退。 */
  private fallbackStarted = false;
  /** 连续推理失败帧数，仅用于告警抽样。 */
  private consecutiveFailures = 0;

  /** 上一次成功推理的视频时间（秒），用于跳过重复帧。 */
  private lastVideoTime = -1;
  /** 上一次送进模型的毫秒时间戳，保证严格单调递增。 */
  private lastTimestamp = 0;
  /** 同一帧被重复调用时复用上次结果，避免重复推理。 */
  private lastPose: DetectedPose | null = null;

  /** 是否完成初始化。 */
  get ready(): boolean {
    return this.landmarker !== null;
  }

  /** 当前后端：初始化前为 "none"，GPU 失败回退后为 "CPU"。 */
  get currentBackend(): PoseTrackerBackend {
    return this.backend;
  }

  /**
   * 初始化 wasm 运行时与姿态模型。
   * GPU 初始化失败会 console.warn 并回退 CPU；两者都失败时抛错，由调用方决定如何提示。
   */
  async init(): Promise<void> {
    if (this.landmarker) return;

    this.fileset = await FilesetResolver.forVisionTasks(WASM_DIR);

    try {
      this.landmarker = await this.create(POSE_TRACKER_CONFIG.delegate);
      this.backend = POSE_TRACKER_CONFIG.delegate;
    } catch (gpuError) {
      console.warn(
        "[poseTracker] GPU delegate 初始化失败，正在回退到 CPU（WASM SIMD）。全身识别仍可用，但帧率会下降。",
        gpuError,
      );
      this.landmarker = await this.create(POSE_TRACKER_CONFIG.fallbackDelegate);
      this.backend = POSE_TRACKER_CONFIG.fallbackDelegate;
    }
  }

  /**
   * 对当前视频帧做一次姿态检测。
   * 返回 null 表示：未初始化、无可用帧、同一帧重复调用且上次无人、未检测到人、
   * 或关键点数量不等于 33（不截断、不补零）。
   */
  detect(video: HTMLVideoElement, timestampMs: number): DetectedPose | null {
    const landmarker = this.landmarker;
    if (!landmarker) return null;
    if (video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) return null;
    if (video.videoWidth === 0 || video.videoHeight === 0) return null;

    // 同一视频帧不重复推理；直接复用上一帧结果（可能是 null）。
    if (video.currentTime === this.lastVideoTime) return this.lastPose;
    this.lastVideoTime = video.currentTime;

    // 运行时要求时间戳严格单调递增，重复或倒退一律修正为上一帧 +1ms。
    let timestamp = Number.isFinite(timestampMs)
      ? Math.round(timestampMs)
      : this.lastTimestamp + 1;
    if (timestamp <= this.lastTimestamp) timestamp = this.lastTimestamp + 1;
    this.lastTimestamp = timestamp;

    let result: PoseLandmarkerResult;
    try {
      result = landmarker.detectForVideo(video, timestamp);
    } catch (error) {
      this.consecutiveFailures += 1;
      if (this.backend === "GPU" && !this.fallbackStarted) {
        // GPU 初始化成功但运行时报错（无 WebGL 等环境）：切换一次 CPU。
        this.triggerCpuFallback(error);
      } else if (this.consecutiveFailures === 1 || this.consecutiveFailures % 30 === 0) {
        // 抽样告警，避免每帧刷屏。
        console.warn("[poseTracker] 本帧推理失败，已跳过。", error);
      }
      return null;
    }

    this.consecutiveFailures = 0;

    const landmarks = result.landmarks[0];
    const world = result.worldLandmarks[0];

    // 无人：返回 null，不返回空对象。
    if (!landmarks || !world) {
      this.lastPose = null;
      return null;
    }

    // 输出契约：必须恰好 33 点；不足或超出都丢弃本帧，不截断、不补零。
    if (landmarks.length !== POSE_LANDMARK_COUNT || world.length !== POSE_LANDMARK_COUNT) {
      console.warn(
        `[poseTracker] 关键点数量异常（landmarks ${landmarks.length} / world ${world.length}，期望 ${POSE_LANDMARK_COUNT}），本帧忽略。`,
      );
      this.lastPose = null;
      return null;
    }

    const pose: DetectedPose = {
      score: meanVisibility(landmarks),
      lm: landmarks.map(toPt),
      world: world.map(toPt),
    };
    this.lastPose = pose;
    return pose;
  }

  /** 释放模型与缓存；释放后 ready 为 false、currentBackend 为 "none"。 */
  close(): void {
    this.landmarker?.close();
    this.landmarker = null;
    this.backend = "none";
    this.fileset = null;
    this.fallbackStarted = false;
    this.consecutiveFailures = 0;
    this.lastVideoTime = -1;
    this.lastPose = null;
  }

  /**
   * 运行期 GPU 失败的回退：重建一份 CPU 模型。
   * 只触发一次，避免抖动时反复重建。
   */
  private triggerCpuFallback(error: unknown): void {
    if (this.backend !== "GPU" || this.fallbackStarted) return;
    this.fallbackStarted = true;
    this.landmarker = null;
    this.lastPose = null;
    this.consecutiveFailures = 0;
    console.warn(
      "[poseTracker] GPU 推理运行时报错，正在切换到 CPU（WASM SIMD）。姿态识别会短暂中断。",
      error,
    );

    void (async () => {
      try {
        this.landmarker = await this.create(POSE_TRACKER_CONFIG.fallbackDelegate);
        this.backend = POSE_TRACKER_CONFIG.fallbackDelegate;
        console.info("[poseTracker] 已切换到 CPU 后端。");
      } catch (fallbackError) {
        console.error("[poseTracker] CPU 回退同样失败，姿态识别不可用。", fallbackError);
        this.backend = "none";
      }
    })();
  }

  private create(delegate: "GPU" | "CPU"): Promise<PoseLandmarker> {
    const fileset = this.fileset;
    if (!fileset) return Promise.reject(new Error("wasm 运行时尚未初始化"));
    return PoseLandmarker.createFromOptions(fileset, {
      baseOptions: {
        modelAssetPath: MODEL_URL,
        delegate,
      },
      runningMode: POSE_TRACKER_CONFIG.runningMode,
      numPoses: POSE_TRACKER_CONFIG.numPoses,
      outputSegmentationMasks: POSE_TRACKER_CONFIG.outputSegmentationMasks,
    });
  }
}

/**
 * 数据流位置：编排层，夹在 main 与两个 tracker 之间。
 *
 *   main.update(video, ts, width, height)
 *     → scheduler.update()
 *         → handTracker.detect()  → emit "hands:raw"（每帧）
 *         → [stride 命中] poseTracker.detect() → emit "pose:raw"（仅推理帧）
 *         → [stride 命中 且有人] computeRelation() → 逐条 emit "hand:relation"
 *     → 返回 FrameResult（main 只负责按它绘制）
 *
 * 本文件不做绘制、不读写 DOM、不做几何计算（relation.ts 已负责）。
 *
 * 尺寸来源：width / height 由 main.ts 的 syncCanvasSizes 计算后传入；
 * scheduler 不读取 video.videoWidth / videoHeight。
 */

import { bus } from "../core/bus";
import { computeRelation } from "./relation";
import type { DetectedHand } from "./landmarks";
import type { DetectedPose } from "./poseLandmarks";
import type { HandTracker } from "./handTracker";
import type { PoseTracker } from "./poseTracker";

/** 一帧的调度结果，供 main 绘制与面板展示。 */
export interface FrameResult {
  hands: DetectedHand[];
  /** 姿态结果：推理帧为本次结果（可能 null），非推理帧为上一次结果（供绘制）。 */
  pose: DetectedPose | null;
  /** 本帧是否真正执行了姿态推理。 */
  poseFresh: boolean;
  /** 距上一次姿态推理的毫秒数；从未推理过为 Infinity（绘制层遇到 Infinity 应跳过姿态层）。 */
  poseAgeMs: number;
}

/**
 * 全部调度参数集中于此，禁止在实现里散落字面量。
 * 依据：D5（调度与 emit 语义）、D6（降级策略与实测阈值）。
 */
const SCHEDULER_CONFIG = {
  /** 初始 stride（D6：p50 +17.0% / p95 +16.7%，两口径均在 20% 内）。 */
  initialStride: 3,
  /** 手部耗时滚动窗口长度。 */
  handWindow: 60,
  /** 整体 fps 滚动窗口长度。 */
  fpsWindow: 60,
  /** 自适应判定最小间隔，避免每帧重算。 */
  adaptIntervalMs: 250,
  /** 过载：手部 p50 高于此值。 */
  overloadP50Ms: 20,
  /** 轻载：手部 p50 低于此值。 */
  lightP50Ms: 14,
  /** 允许 stride=2 的手部 p50 上限。 */
  fastP50Ms: 12,
  /** 允许 stride=2 的整体 fps 下限。 */
  fastFps: 50,
  /** 判定「整体帧率不足」的 fps 上限。 */
  lowFps: 20,
  /** 过载持续时长后升档。 */
  overloadHoldMs: 1000,
  /** 轻载持续时长后降档。 */
  lightHoldMs: 3000,
  /** 快档条件持续时长后回落 2。 */
  fastHoldMs: 3000,
  /** 低帧率持续时长后停止姿态推理。 */
  lowFpsHoldMs: 1000,
  /** stride 上限。 */
  maxStride: 6,
  /** stride 下限（不含特批的 2）。 */
  minStride: 3,
} as const;

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const lower = sorted[mid - 1];
  const upper = sorted[mid];
  if (sorted.length % 2 === 1 || lower === undefined || upper === undefined) {
    return upper ?? lower ?? 0;
  }
  return (lower + upper) / 2;
}

export class TrackerScheduler {
  private stride: number = SCHEDULER_CONFIG.initialStride;
  private poseEnabled = true;
  private adaptReason = "";

  /** 手部推理耗时（毫秒）滚动窗口。 */
  private readonly handCosts: number[] = [];
  /** 每帧 update 的起始时刻，用于整体 fps。 */
  private readonly frameTimes: number[] = [];

  private frameIndex = 0;
  private lastAdaptCheck = 0;
  private overloadSince: number | null = null;
  private lightSince: number | null = null;
  private fastSince: number | null = null;
  private lowFpsSince: number | null = null;
  private poseDisabledWarned = false;

  /** 上一次姿态推理结果（供非推理帧绘制）。 */
  private lastPose: DetectedPose | null = null;
  /** 上一次姿态推理完成的时刻；null 表示从未推理。 */
  private lastPoseAt: number | null = null;

  constructor(
    private readonly handTracker: HandTracker,
    private readonly poseTracker: PoseTracker,
  ) {}

  /** 当前姿态推理间隔（每 N 帧一次）。 */
  get currentStride(): number {
    return this.stride;
  }

  /** 姿态推理是否仍然启用（stride=6 且 fps 仍不足时会关闭）。 */
  get currentPoseEnabled(): boolean {
    return this.poseEnabled;
  }

  /** 最近一次自适应判定的变更原因；该次判定无变更时为空字符串。 */
  get lastAdaptReason(): string {
    return this.adaptReason;
  }

  /**
   * 执行一帧调度。
   * 同一次调用内，手部与姿态共用同一个 ts；各自的去重逻辑保持不变。
   *
   * @param width  视频帧宽（像素），由 main.ts 的 syncCanvasSizes 提供
   * @param height 视频帧高（像素），由 main.ts 的 syncCanvasSizes 提供
   */
  update(
    video: HTMLVideoElement,
    ts: number,
    width: number,
    height: number,
  ): FrameResult {
    const frameStart = performance.now();

    // 1. 手部：每帧执行，并广播原始数据。
    const hands = this.handTracker.detect(video, ts);
    this.pushHandCost(performance.now() - frameStart);
    this.pushFrameTime(frameStart);
    bus.emit("hands:raw", hands);

    // 2. 姿态：仅在 stride 命中的帧执行（第 3、6、9… 帧）。
    this.frameIndex += 1;
    const isPoseFrame = this.poseEnabled && this.frameIndex % this.stride === 0;

    let pose = this.lastPose;
    let poseFresh = false;

    if (isPoseFrame) {
      const fresh = this.poseTracker.detect(video, ts);
      this.lastPoseAt = performance.now();
      this.lastPose = fresh;
      pose = fresh;
      poseFresh = true;

      // 推理帧：有人发对象，无人发 null；非推理帧不发。
      bus.emit("pose:raw", fresh);

      if (fresh) {
        const relations = computeRelation(fresh, hands, width, height);
        for (const relation of relations) {
          bus.emit("hand:relation", relation);
        }
      }
    }

    // 3. 性能自适应（只影响后续帧）。
    this.maybeAdapt(performance.now());

    return {
      hands,
      pose,
      poseFresh,
      poseAgeMs:
        this.lastPoseAt === null
          ? Number.POSITIVE_INFINITY
          : performance.now() - this.lastPoseAt,
    };
  }

  /** 清空滚动窗口、恢复初始 stride 与姿态推理，并丢弃缓存的姿态结果。 */
  reset(): void {
    this.handCosts.length = 0;
    this.frameTimes.length = 0;
    this.stride = SCHEDULER_CONFIG.initialStride;
    this.poseEnabled = true;
    this.adaptReason = "";
    this.frameIndex = 0;
    this.lastAdaptCheck = 0;
    this.overloadSince = null;
    this.lightSince = null;
    this.fastSince = null;
    this.lowFpsSince = null;
    this.poseDisabledWarned = false;
    this.lastPose = null;
    this.lastPoseAt = null;
  }

  /**
   * 控制姿态推理开关（“全身骨架”开关使用）。
   * 关闭时立即清空缓存姿态，poseAgeMs 回到 Infinity；重开后在下一个姿态帧恢复。
   * 不触碰 stride 状态机，也不影响手部链路。
   */
  setPoseEnabled(enabled: boolean): void {
    this.poseEnabled = enabled;
    if (!enabled) {
      this.lastPose = null;
      this.lastPoseAt = null;
    }
  }

  /**
   * 关闭姿态推理（姿态模型初始化失败时由 main 调用）。
   * 关闭后不再调用 poseTracker.detect，也不再 emit pose:raw / hand:relation。
   */
  disablePose(): void {
    this.setPoseEnabled(false);
  }

  private pushHandCost(cost: number): void {
    this.handCosts.push(cost);
    if (this.handCosts.length > SCHEDULER_CONFIG.handWindow) {
      this.handCosts.shift();
    }
  }

  private pushFrameTime(time: number): void {
    this.frameTimes.push(time);
    if (this.frameTimes.length > SCHEDULER_CONFIG.fpsWindow) {
      this.frameTimes.shift();
    }
  }

  private currentFps(): number {
    if (this.frameTimes.length < 2) return 0;
    const first = this.frameTimes[0];
    const last = this.frameTimes[this.frameTimes.length - 1];
    if (first === undefined || last === undefined) return 0;
    const span = last - first;
    if (span <= 0) return 0;
    return ((this.frameTimes.length - 1) * 1000) / span;
  }

  /**
   * 自适应：只看手部推理耗时的滚动 p50 与整体 fps，不看姿态耗时。
   * 所有阈值与持续时长来自 SCHEDULER_CONFIG。
   */
  private maybeAdapt(now: number): void {
    if (now - this.lastAdaptCheck < SCHEDULER_CONFIG.adaptIntervalMs) return;
    this.lastAdaptCheck = now;

    // 每次判定先清空原因；本判定有变更时再写入。
    this.adaptReason = "";

    // 窗口未满不做判定，避免开局抖动决定档位。
    if (this.handCosts.length < SCHEDULER_CONFIG.handWindow) {
      this.clearHolds();
      return;
    }

    const p50 = median(this.handCosts);
    const fps = this.currentFps();

    // 1) 兜底：stride 已到上限且整体帧率仍不足 → 停姿态、保手部。
    if (this.stride >= SCHEDULER_CONFIG.maxStride && fps < SCHEDULER_CONFIG.lowFps) {
      this.lowFpsSince ??= now;
      if (
        this.poseEnabled &&
        now - this.lowFpsSince >= SCHEDULER_CONFIG.lowFpsHoldMs
      ) {
        this.poseEnabled = false;
        this.lastPose = null;
        this.lastPoseAt = null;
        this.adaptReason =
          `stride=${SCHEDULER_CONFIG.maxStride} 时整体 fps ${fps.toFixed(1)} < ${SCHEDULER_CONFIG.lowFps}` +
          ` 持续 ${SCHEDULER_CONFIG.lowFpsHoldMs}ms，已停止姿态推理以保手部`;
        if (!this.poseDisabledWarned) {
          this.poseDisabledWarned = true;
          console.warn(
            `[scheduler] ${this.adaptReason}。手部识别继续运行。`,
          );
        }
      }
      return;
    }
    this.lowFpsSince = null;

    if (!this.poseEnabled) return;

    // 2) 特批快档：p50 < 12ms 且整体 fps > 50，持续 3s 才允许 stride=2。
    if (p50 < SCHEDULER_CONFIG.fastP50Ms && fps > SCHEDULER_CONFIG.fastFps) {
      this.fastSince ??= now;
      if (
        now - this.fastSince >= SCHEDULER_CONFIG.fastHoldMs &&
        this.stride > 2
      ) {
        this.stride = 2;
        this.adaptReason =
          `手部 p50 ${p50.toFixed(1)}ms < ${SCHEDULER_CONFIG.fastP50Ms} 且 fps ${fps.toFixed(1)}` +
          ` > ${SCHEDULER_CONFIG.fastFps} 持续 ${SCHEDULER_CONFIG.fastHoldMs}ms，stride 降为 2`;
      }
      return;
    }
    this.fastSince = null;

    // 3) 过载升档：3→4→6。
    if (p50 > SCHEDULER_CONFIG.overloadP50Ms) {
      this.overloadSince ??= now;
      if (
        now - this.overloadSince >= SCHEDULER_CONFIG.overloadHoldMs &&
        this.stride < SCHEDULER_CONFIG.maxStride
      ) {
        this.stride = this.stride === 3 ? 4 : SCHEDULER_CONFIG.maxStride;
        this.adaptReason =
          `手部 p50 ${p50.toFixed(1)}ms > ${SCHEDULER_CONFIG.overloadP50Ms}` +
          ` 持续 ${SCHEDULER_CONFIG.overloadHoldMs}ms，stride 升为 ${this.stride}`;
        // 下一次升档需要重新累计 1s。
        this.overloadSince = now;
      }
      return;
    }
    this.overloadSince = null;

    // 4) 轻载降档：6→4→3，下限 3。
    if (p50 < SCHEDULER_CONFIG.lightP50Ms) {
      this.lightSince ??= now;
      if (
        now - this.lightSince >= SCHEDULER_CONFIG.lightHoldMs &&
        this.stride > SCHEDULER_CONFIG.minStride
      ) {
        this.stride =
          this.stride === SCHEDULER_CONFIG.maxStride ? 4 : SCHEDULER_CONFIG.minStride;
        this.adaptReason =
          `手部 p50 ${p50.toFixed(1)}ms < ${SCHEDULER_CONFIG.lightP50Ms}` +
          ` 持续 ${SCHEDULER_CONFIG.lightHoldMs}ms，stride 降为 ${this.stride}`;
        this.lightSince = now;
      }
      return;
    }
    this.lightSince = null;
  }

  private clearHolds(): void {
    this.overloadSince = null;
    this.lightSince = null;
    this.fastSince = null;
    this.lowFpsSince = null;
  }
}

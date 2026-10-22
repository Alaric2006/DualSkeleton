/**
 * 数据流位置：可观测性层。把每一帧的识别结果变成人能读的结构化状态。
 *
 * 上游：main.ts 传入 hands / 当前手势标签 / 运行状态；姿态数据通过 bus 的 "pose:raw" 订阅获得。
 * 下游：DOM（手部区块 + 独立姿态区块 + 开关状态）+ console（节流日志）。不参与识别，也不发事件。
 *
 * 面板刷新限制在 ~10fps，避免每帧重排拖慢主循环；console 每 500ms 一条，方便回看。
 */

import { bus } from "../core/bus";
import {
  FINGER_NAMES,
  palmCenter,
  type DetectedHand,
  type Handedness,
} from "../vision/landmarks";
import { POSE_LM, type DetectedPose } from "../vision/poseLandmarks";
import { getFingerState } from "../gestures/fingers";

export interface PanelStatus {
  fps: number;
  backend: string;
  ready: boolean;
}

const PANEL_RENDER_INTERVAL_MS = 100;
const CONSOLE_INTERVAL_MS = 500;
/** 超过该时长没有新的 pose:raw，就认为姿态已关闭或无人，不再展示旧坐标。 */
const POSE_STALE_MS = 2000;

function mark(extended: boolean): string {
  return extended ? "✓" : "✗";
}

function formatHand(hand: DetectedHand, gesture: string | undefined): string {
  const fingers = getFingerState(hand);
  const palm = palmCenter(hand.lm);
  const fingerLine = FINGER_NAMES.map(
    (name) => `${name.slice(0, 1).toUpperCase()}${mark(fingers[name])}`,
  ).join(" ");

  return [
    `[${hand.handedness}]  score ${hand.score.toFixed(2)}  gesture ${gesture ?? "—"}`,
    `  fingers  ${fingerLine}`,
    `  palm     (${palm.x.toFixed(2)}, ${palm.y.toFixed(2)}, ${palm.z.toFixed(2)})`,
  ].join("\n");
}

function formatPoint(point: { x: number; y: number; z: number } | undefined): string {
  if (!point) return "—";
  return `(${point.x.toFixed(2)}, ${point.y.toFixed(2)}, ${point.z.toFixed(2)})`;
}

/** 姿态区块：只展示最近一次 pose:raw 的结构化摘要，不判断新鲜度。 */
function formatPose(pose: DetectedPose | null, lastAt: number, now: number): string {
  // 姿态关闭或长时间无数据时，不继续展示过期坐标。
  if (lastAt === 0 || now - lastAt > POSE_STALE_MS) {
    return "姿态已关闭或无数据";
  }

  const age = `${Math.round(now - lastAt)}ms`;
  if (!pose) {
    return ["pose    none", `  last event  ${age}`].join("\n");
  }

  return [
    `pose    score ${pose.score.toFixed(2)}  points ${pose.lm.length}`,
    `  nose        ${formatPoint(pose.lm[POSE_LM.NOSE])}`,
    `  shoulders   L${formatPoint(pose.lm[POSE_LM.LEFT_SHOULDER])} R${formatPoint(
      pose.lm[POSE_LM.RIGHT_SHOULDER],
    )}`,
    `  wrists      L${formatPoint(pose.lm[POSE_LM.LEFT_WRIST])} R${formatPoint(
      pose.lm[POSE_LM.RIGHT_WRIST],
    )}`,
    `  hips        L${formatPoint(pose.lm[POSE_LM.LEFT_HIP])} R${formatPoint(
      pose.lm[POSE_LM.RIGHT_HIP],
    )}`,
    `  last event  ${age}`,
  ].join("\n");
}

export class DebugPanel {
  private readonly pre: HTMLPreElement;
  private readonly posePre: HTMLPreElement;
  private readonly switchEl: HTMLDivElement;
  private readonly statusEl: HTMLSpanElement;
  private lastRender = 0;
  private lastConsole = 0;
  private lastPose: DetectedPose | null = null;
  private lastPoseAt = 0;

  constructor(root: HTMLElement) {
    root.replaceChildren();

    const head = document.createElement("div");
    head.className = "panel-head";
    const title = document.createElement("span");
    title.textContent = "STATE";
    this.statusEl = document.createElement("span");
    this.statusEl.className = "panel-status";
    this.statusEl.textContent = "starting…";
    head.append(title, this.statusEl);

    this.pre = document.createElement("pre");
    this.pre.className = "panel-body";
    this.pre.textContent = "尚未开始识别";

    // —— 姿态区块：独立 DOM 节点，不复用手部容器 ——
    const poseBlock = document.createElement("div");
    poseBlock.className = "panel-pose-block";
    poseBlock.style.marginTop = "10px";
    poseBlock.style.paddingTop = "10px";
    poseBlock.style.borderTop = "1px solid var(--line)";

    const poseTitle = document.createElement("div");
    poseTitle.className = "panel-pose-title";
    poseTitle.textContent = "POSE";
    poseTitle.style.fontSize = "11px";
    poseTitle.style.letterSpacing = "0.12em";
    poseTitle.style.color = "var(--muted)";
    poseTitle.style.marginBottom = "6px";

    this.posePre = document.createElement("pre");
    this.posePre.className = "panel-pose";
    this.posePre.style.margin = "0";
    this.posePre.style.fontSize = "12px";
    this.posePre.style.lineHeight = "1.65";
    this.posePre.style.whiteSpace = "pre-wrap";
    this.posePre.style.color = "#cfd6e0";
    this.posePre.textContent = "尚未收到姿态数据";

    poseBlock.append(poseTitle, this.posePre);

    // —— 开关状态：独立节点，读取 index.html 的两个 checkbox ——
    this.switchEl = document.createElement("div");
    this.switchEl.className = "panel-switches";
    this.switchEl.style.marginTop = "10px";
    this.switchEl.style.paddingTop = "10px";
    this.switchEl.style.borderTop = "1px solid var(--line)";
    this.switchEl.style.fontSize = "11px";
    this.switchEl.style.color = "var(--muted)";

    root.append(head, this.pre, poseBlock, this.switchEl);

    // 姿态数据由 scheduler 发出；面板只保存最近一次，用于展示。
    bus.on("pose:raw", (pose) => {
      this.lastPose = pose;
      this.lastPoseAt = performance.now();
    });
  }

  update(
    hands: readonly DetectedHand[],
    labels: ReadonlyMap<Handedness, string>,
    status: PanelStatus,
    toggles: { hands: boolean; pose: boolean },
    now: number,
  ): void {
    if (now - this.lastRender >= PANEL_RENDER_INTERVAL_MS) {
      this.lastRender = now;
      this.statusEl.textContent = `${status.ready ? status.backend : "not ready"} · ${status.fps.toFixed(
        0,
      )} fps`;
      this.pre.textContent =
        hands.length === 0
          ? "没有检测到手\n把手放进画面并保持光照充足"
          : hands
              .map((hand) => formatHand(hand, labels.get(hand.handedness)))
              .join("\n\n");

      // 姿态与开关状态使用各自的独立节点，不触碰手部区块。
      this.posePre.textContent = formatPose(this.lastPose, this.lastPoseAt, now);
      this.switchEl.textContent = `骨架显示：手部 ${toggles.hands ? "开" : "关"} · 全身 ${
        toggles.pose ? "开" : "关"
      }`;
    }

    if (now - this.lastConsole >= CONSOLE_INTERVAL_MS) {
      this.lastConsole = now;
      console.debug("[dualskeleton]", {
        backend: status.backend,
        fps: Number(status.fps.toFixed(1)),
        hands: hands.map((hand) => ({
          hand: hand.handedness,
          score: Number(hand.score.toFixed(3)),
          fingers: getFingerState(hand),
          gesture: labels.get(hand.handedness) ?? null,
          palm: palmCenter(hand.lm),
        })),
        pose: this.lastPose
          ? {
              score: Number(this.lastPose.score.toFixed(3)),
              points: this.lastPose.lm.length,
              ageMs: this.lastPoseAt === 0 ? null : Math.round(now - this.lastPoseAt),
            }
          : null,
      });
    }
  }
}

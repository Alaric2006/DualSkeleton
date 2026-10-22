/**
 * 数据流位置：姿态显示层，与 render/overlay.ts 并列。
 *
 * 上游：main.ts 每帧把 FrameResult.pose 传进来（推理帧为本次结果，非推理帧为上一次结果）。
 * 下游：无（只写 canvas 像素）。
 *
 * G2 约束（必须保留）：姿态模型的 17–22 点（左右小指 / 食指 / 拇指）**不得**作为手部关键点使用；
 * 本层只做姿态可视化，不向手部链路提供任何关键点。
 *
 * 本层只按传入的 pose 绘制：不判断新鲜度、不读 video、不做平滑、不做几何计算、不发事件、
 * 不做 DPR 处理（DPR 与尺寸同步由 main.ts 统一负责）。
 *
 * 尺寸约定：所有坐标一律「0..1 归一化 × canvas 宽高」，与手部层使用同一尺寸基准。
 */

import {
  POSE_CONNECTIONS,
  POSE_LANDMARK_COUNT,
  posePt,
  type DetectedPose,
} from "../vision/poseLandmarks";

/**
 * 姿态骨架的全部视觉参数集中于此（D7）。
 * 低饱和琥珀、比手部更细的线、整体约 0.55 透明度；不涉及手部配色。
 */
const POSE_STYLE = {
  /** 琥珀色 RGB（#f59e0b 的低饱和版本）。 */
  rgb: [245, 158, 11] as const,
  /** 整体透明度。 */
  alpha: 0.55,
  /** 线宽 = 画布宽度 × 该比例，且不小于 minLineWidth。 */
  lineWidthRatio: 1 / 700,
  minLineWidth: 1.5,
  /** 关键点半径 = 画布宽度 × 该比例，且不小于 minPointRadius。 */
  pointRadiusRatio: 1 / 640,
  minPointRadius: 2.5,
} as const;

export class PoseOverlay {
  private readonly ctx: CanvasRenderingContext2D;

  constructor(private readonly canvas: HTMLCanvasElement) {
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("无法创建 Canvas 2D 上下文");
    this.ctx = ctx;
  }

  /** 设置画布像素尺寸；尺寸由 main.ts 的 syncCanvasSizes 传入。 */
  resize(width: number, height: number): void {
    if (this.canvas.width !== width) this.canvas.width = width;
    if (this.canvas.height !== height) this.canvas.height = height;
  }

  /**
   * 绘制姿态骨架。
   * pose 为 null、visible=false、或关键点数量不等于 33 时，清空画布后返回，不抛错。
   */
  draw(pose: DetectedPose | null, options?: { visible?: boolean }): void {
    const visible = options?.visible ?? true;
    const { width, height } = this.canvas;

    // 三种早退都先清空，避免上一帧残留。
    if (!visible || !pose || pose.lm.length !== POSE_LANDMARK_COUNT) {
      this.ctx.clearRect(0, 0, width, height);
      return;
    }
    if (width === 0 || height === 0) {
      this.ctx.clearRect(0, 0, width, height);
      return;
    }

    const ctx = this.ctx;
    const [r, g, b] = POSE_STYLE.rgb;
    const color = `rgba(${r}, ${g}, ${b}, ${POSE_STYLE.alpha})`;
    const lineWidth = Math.max(
      POSE_STYLE.minLineWidth,
      width * POSE_STYLE.lineWidthRatio,
    );
    const pointRadius = Math.max(
      POSE_STYLE.minPointRadius,
      width * POSE_STYLE.pointRadiusRatio,
    );

    ctx.clearRect(0, 0, width, height);

    // 骨架连线（35 条）。
    ctx.strokeStyle = color;
    ctx.lineWidth = lineWidth;
    ctx.lineCap = "round";
    ctx.beginPath();
    for (const [from, to] of POSE_CONNECTIONS) {
      const a = posePt(pose.lm, from);
      const b2 = posePt(pose.lm, to);
      ctx.moveTo(a.x * width, a.y * height);
      ctx.lineTo(b2.x * width, b2.y * height);
    }
    ctx.stroke();

    // 关键点。
    ctx.fillStyle = color;
    for (const point of pose.lm) {
      ctx.beginPath();
      ctx.arc(point.x * width, point.y * height, pointRadius, 0, Math.PI * 2);
      ctx.fill();
    }
  }
}

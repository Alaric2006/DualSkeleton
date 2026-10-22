/**
 * 数据流位置：手部显示层。把关键点画到叠加在 <video> 上的 canvas。
 *
 * 上游：main.ts 每帧传入 DetectedHand[] 与 engine 当前已确立的手势名。
 * 下游：无（只写像素）。
 *
 * 坐标与尺寸：
 *   - 所有坐标一律「0..1 归一化 × canvas 宽高」；
 *   - 本层不读 video，也不读取 videoWidth / videoHeight；
 *   - 尺寸由 main.ts 的 syncCanvasSizes 统一计算后调用 resize(width, height) 传入。
 *
 * 镜像约定（与 vision/landmarks.ts 的 HANDEDNESS_SWAP 配套）：
 *   - 推理使用的是未镜像的原始帧，所以 handedness 是真实解剖手；
 *   - <video> 按摄像头原始画面显示，canvas 也用同一坐标系逐像素对齐，**不做任何水平翻转**；
 *   - 若将来想要自拍镜像效果，必须同时对 #video 与 canvas 应用镜像。
 */

import {
  HAND_CONNECTIONS,
  LANDMARK_COUNT,
  pt,
  type DetectedHand,
  type Handedness,
} from "../vision/landmarks";

const HAND_COLORS: Record<Handedness, string> = {
  Left: "#4ade80",
  Right: "#38bdf8",
};

export class Overlay {
  private readonly ctx: CanvasRenderingContext2D;

  constructor(private readonly canvas: HTMLCanvasElement) {
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("无法创建 Canvas 2D 上下文");
    this.ctx = ctx;
  }

  /** 设置画布像素尺寸；由 main.ts 的 syncCanvasSizes 统一提供。 */
  resize(width: number, height: number): void {
    if (this.canvas.width !== width) this.canvas.width = width;
    if (this.canvas.height !== height) this.canvas.height = height;
  }

  draw(hands: readonly DetectedHand[], labels: ReadonlyMap<Handedness, string>): void {
    // 第一行先清空：空数组等价于清空画布。
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);

    const width = this.canvas.width;
    const height = this.canvas.height;
    if (width === 0 || height === 0) return;

    const ctx = this.ctx;
    const lineWidth = Math.max(2, width / 420);
    const dotRadius = Math.max(3, width / 320);

    for (const hand of hands) {
      if (hand.lm.length !== LANDMARK_COUNT) continue;
      const color = HAND_COLORS[hand.handedness];

      // —— 骨架与关键点：与 <video> 同一坐标系，逐像素对齐 ——
      ctx.save();

      ctx.strokeStyle = color;
      ctx.lineWidth = lineWidth;
      ctx.lineCap = "round";
      ctx.beginPath();
      for (const [from, to] of HAND_CONNECTIONS) {
        const a = pt(hand.lm, from);
        const b = pt(hand.lm, to);
        ctx.moveTo(a.x * width, a.y * height);
        ctx.lineTo(b.x * width, b.y * height);
      }
      ctx.stroke();

      ctx.fillStyle = color;
      for (const p of hand.lm) {
        ctx.beginPath();
        ctx.arc(p.x * width, p.y * height, dotRadius, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.restore();

      // —— 文字标签：与骨架同一坐标系 ——
      const label = labels.get(hand.handedness) ?? "—";
      const wrist = pt(hand.lm, 0);
      const textX = wrist.x * width;
      const textY = Math.min(height - 12, Math.max(24, wrist.y * height + 56));
      this.drawLabel(ctx, `${hand.handedness} · ${label}`, textX, textY, color, width);
    }
  }

  private drawLabel(
    ctx: CanvasRenderingContext2D,
    text: string,
    x: number,
    y: number,
    color: string,
    canvasWidth: number,
  ): void {
    const fontSize = Math.max(14, Math.round(canvasWidth / 46));
    ctx.font = `600 ${fontSize}px ui-monospace, SFMono-Regular, Menlo, monospace`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";

    const paddingX = fontSize * 0.5;
    const paddingY = fontSize * 0.28;
    const metrics = ctx.measureText(text);
    const boxWidth = metrics.width + paddingX * 2;
    const boxHeight = fontSize + paddingY * 2;

    // 手靠近画面左右边缘时，把标签夹回可视区域，避免半个字被裁掉。
    const clampedX = Math.min(
      canvasWidth - boxWidth / 2 - 4,
      Math.max(boxWidth / 2 + 4, x),
    );

    ctx.fillStyle = "rgba(8, 10, 14, 0.72)";
    ctx.beginPath();
    ctx.roundRect(
      clampedX - boxWidth / 2,
      y - boxHeight / 2,
      boxWidth,
      boxHeight,
      boxHeight / 2,
    );
    ctx.fill();

    ctx.fillStyle = color;
    ctx.fillText(text, clampedX, y);
  }
}

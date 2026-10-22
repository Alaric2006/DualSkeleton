/**
 * 数据流位置：整个项目的最底层「唯一事实来源」。
 *
 * 上游：@mediapipe/tasks-vision 每帧输出 21 个手部关键点（归一化图像坐标 + 米制世界坐标）。
 * 下游：
 *   - vision/handTracker.ts  使用本文件的类型与平滑器，把推理结果转成 DetectedHand[]
 *   - gestures/fingers.ts    使用本文件的索引常量与夹角工具做伸展判定
 *   - gestures/engine.ts     使用 palmCenter() 计算掌心坐标
 *   - render/overlay.ts      使用 HAND_CONNECTIONS 绘制骨架
 *
 * 约定：这是项目中唯一允许出现关键点数字索引的文件。其余文件一律引用 LM / FINGER_JOINTS。
 *       如需改关键点定义，只改这里。
 */

/** 单个关键点。x/y 为归一化图像坐标（0..1，原点在左上角），z 为相对腕部的深度（越小越靠近镜头）。 */
export type Pt = { x: number; y: number; z: number };

/** 解剖学意义上的左右手。 */
export type Handedness = "Left" | "Right";

export type FingerName = "thumb" | "index" | "middle" | "ring" | "pinky";

/** true = 该手指处于伸展状态。 */
export type FingerState = Record<FingerName, boolean>;

/** 单手一帧的完整观测结果。 */
export interface DetectedHand {
  /** 解剖学左右手，不由屏幕位置推断。 */
  handedness: Handedness;
  /** MediaPipe 对该手左右判定的置信度（0..1）。 */
  score: number;
  /** 21 个归一化图像坐标关键点，已做指数平滑。 */
  lm: Pt[];
  /** 21 个米制世界坐标关键点，未平滑。 */
  world: Pt[];
}

/** 每手关键点数量。 */
export const LANDMARK_COUNT = 21;

/**
 * MediaPipe HandLandmarker 的 21 点索引。
 *
 * 0            腕部 wrist
 * 1..4         拇指  CMC / MCP / IP  / TIP
 * 5..8         食指  MCP / PIP / DIP / TIP
 * 9..12        中指  MCP / PIP / DIP / TIP
 * 13..16       无名指 MCP / PIP / DIP / TIP
 * 17..20       小指  MCP / PIP / DIP / TIP
 */
export const LM = {
  WRIST: 0,

  THUMB_CMC: 1,
  THUMB_MCP: 2,
  THUMB_IP: 3,
  THUMB_TIP: 4,

  INDEX_MCP: 5,
  INDEX_PIP: 6,
  INDEX_DIP: 7,
  INDEX_TIP: 8,

  MIDDLE_MCP: 9,
  MIDDLE_PIP: 10,
  MIDDLE_DIP: 11,
  MIDDLE_TIP: 12,

  RING_MCP: 13,
  RING_PIP: 14,
  RING_DIP: 15,
  RING_TIP: 16,

  PINKY_MCP: 17,
  PINKY_PIP: 18,
  PINKY_DIP: 19,
  PINKY_TIP: 20,
} as const;

/**
 * 每根手指用于「伸展角度」判定的三个关节 [近端, 中间, 远端]。
 * 角度在中间关节处测量：近端-中间-远端 的夹角越接近 180° 越直。
 * 拇指用 CMC-MCP-TIP，因为拇指没有 PIP/DIP。
 */
export const FINGER_JOINTS: Record<FingerName, readonly [number, number, number]> = {
  thumb: [LM.THUMB_CMC, LM.THUMB_MCP, LM.THUMB_TIP],
  index: [LM.INDEX_MCP, LM.INDEX_PIP, LM.INDEX_TIP],
  middle: [LM.MIDDLE_MCP, LM.MIDDLE_PIP, LM.MIDDLE_TIP],
  ring: [LM.RING_MCP, LM.RING_PIP, LM.RING_TIP],
  pinky: [LM.PINKY_MCP, LM.PINKY_PIP, LM.PINKY_TIP],
};

/** 五根手指的固定顺序，用于遍历与调试输出。 */
export const FINGER_NAMES: readonly FingerName[] = ["thumb", "index", "middle", "ring", "pinky"];

/** 手掌骨架连线（MediaPipe 标准拓扑，共 21 条）。 */
export const HAND_CONNECTIONS: ReadonlyArray<readonly [number, number]> = [
  // 指节链
  [LM.WRIST, LM.THUMB_CMC],
  [LM.THUMB_CMC, LM.THUMB_MCP],
  [LM.THUMB_MCP, LM.THUMB_IP],
  [LM.THUMB_IP, LM.THUMB_TIP],

  [LM.WRIST, LM.INDEX_MCP],
  [LM.INDEX_MCP, LM.INDEX_PIP],
  [LM.INDEX_PIP, LM.INDEX_DIP],
  [LM.INDEX_DIP, LM.INDEX_TIP],

  [LM.WRIST, LM.MIDDLE_MCP],
  [LM.MIDDLE_MCP, LM.MIDDLE_PIP],
  [LM.MIDDLE_PIP, LM.MIDDLE_DIP],
  [LM.MIDDLE_DIP, LM.MIDDLE_TIP],

  [LM.WRIST, LM.RING_MCP],
  [LM.RING_MCP, LM.RING_PIP],
  [LM.RING_PIP, LM.RING_DIP],
  [LM.RING_DIP, LM.RING_TIP],

  [LM.WRIST, LM.PINKY_MCP],
  [LM.PINKY_MCP, LM.PINKY_PIP],
  [LM.PINKY_PIP, LM.PINKY_DIP],
  [LM.PINKY_DIP, LM.PINKY_TIP],

  // 掌骨横线
  [LM.INDEX_MCP, LM.MIDDLE_MCP],
  [LM.MIDDLE_MCP, LM.RING_MCP],
  [LM.RING_MCP, LM.PINKY_MCP],
];

/**
 * 左右手标签是否需要翻转。
 *
 * 本项目的约定（README 中同步说明）：
 *   1. 送入模型的始终是「未镜像」的原始摄像头帧；
 *   2. 只在 canvas 显示层做 scaleX(-1) 镜像（自拍视角）；
 *   3. 因此 DetectedHand.handedness 恒表示真实解剖手，屏幕左右与标签相反属于正常现象。
 *
 * MediaPipe 旧版 Hands 文档称其左右判定「假设输入图像已镜像」，Tasks API 文档未再提。
 * 若在你的设备上实测发现标签与真实手相反，把这里改成 true 即可全局纠正，无需改其他文件。
 */
export const HANDEDNESS_SWAP = false;

/** 读取指定索引的关键点；缺失时抛出可定位的错误，避免 undefined 静默传播。 */
export function pt(lm: readonly Pt[], index: number): Pt {
  const p = lm[index];
  if (!p) {
    throw new Error(`关键点缺失：索引 ${index}（当前点数 ${lm.length}）`);
  }
  return p;
}

/** 二维欧氏距离（忽略 z，避免深度噪声影响比例判定）。 */
export function dist2(a: Pt, b: Pt): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/** 以 b 为顶点，计算 a-b-c 的夹角（单位：度，范围 0..180）。 */
export function angleAt(a: Pt, b: Pt, c: Pt): number {
  const abx = a.x - b.x;
  const aby = a.y - b.y;
  const cbx = c.x - b.x;
  const cby = c.y - b.y;
  const mag = Math.hypot(abx, aby) * Math.hypot(cbx, cby);
  if (mag === 0) return 0;
  const cos = Math.min(1, Math.max(-1, (abx * cbx + aby * cby) / mag));
  return (Math.acos(cos) * 180) / Math.PI;
}

/** 指数平滑：out = alpha * next + (1 - alpha) * prev。alpha 越大越跟手，越小越稳。 */
export function smooth(prev: Pt, next: Pt, alpha: number): Pt {
  const beta = 1 - alpha;
  return {
    x: prev.x * beta + next.x * alpha,
    y: prev.y * beta + next.y * alpha,
    z: prev.z * beta + next.z * alpha,
  };
}

/** 默认平滑系数。0.6 ≈ 约 2 帧的等效时间常数，兼顾跟手与抗抖。 */
export const DEFAULT_SMOOTH_ALPHA = 0.6;

/**
 * 按「左右手」分别缓存上一帧关键点的平滑器。
 *
 * 为什么按 handedness 而不是按数组下标缓存：MediaPipe 输出的手部数组顺序不保证稳定，
 * 用下标会把左手的历史套到右手上，产生抖动或“瞬移”。
 */
export class LandmarkSmoother {
  private readonly cache = new Map<Handedness, Pt[]>();
  private readonly alpha: number;

  constructor(alpha: number = DEFAULT_SMOOTH_ALPHA) {
    this.alpha = alpha;
  }

  /** 输入本帧原始关键点，返回平滑后的副本；首帧直接拷贝。 */
  update(hand: Handedness, lm: readonly Pt[]): Pt[] {
    if (lm.length !== LANDMARK_COUNT) {
      throw new Error(`关键点数量异常：期望 ${LANDMARK_COUNT}，实际 ${lm.length}`);
    }
    const prev = this.cache.get(hand);
    const next: Pt[] = prev
      ? lm.map((p, i) => smooth(prev[i] ?? p, p, this.alpha))
      : lm.map((p) => ({ x: p.x, y: p.y, z: p.z }));
    this.cache.set(hand, next);
    return next;
  }

  /** 只保留仍在本帧出现的手，消失的手立刻丢弃历史，防止重新入画时从旧位置“滑”过来。 */
  retain(hands: ReadonlySet<Handedness>): void {
    for (const key of [...this.cache.keys()]) {
      if (!hands.has(key)) this.cache.delete(key);
    }
  }

  reset(): void {
    this.cache.clear();
  }
}

/** 五个掌心参考点：腕部 + 四指根部。 */
const PALM_POINTS: readonly number[] = [
  LM.WRIST,
  LM.INDEX_MCP,
  LM.MIDDLE_MCP,
  LM.RING_MCP,
  LM.PINKY_MCP,
];

/** 掌心坐标 = 腕部与四个掌指关节的质心（归一化图像坐标）。 */
export function palmCenter(lm: readonly Pt[]): Pt {
  let x = 0;
  let y = 0;
  let z = 0;
  for (const index of PALM_POINTS) {
    const p = pt(lm, index);
    x += p.x;
    y += p.y;
    z += p.z;
  }
  const n = PALM_POINTS.length;
  return { x: x / n, y: y / n, z: z / n };
}

/** 掌长（腕部 → 中指根部），用于把像素距离归一化成与距离无关的比例。 */
export function palmSize(lm: readonly Pt[]): number {
  return Math.max(dist2(pt(lm, LM.WRIST), pt(lm, LM.MIDDLE_MCP)), 1e-6);
}

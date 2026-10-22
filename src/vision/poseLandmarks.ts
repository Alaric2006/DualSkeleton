/**
 * 数据流位置：姿态链路的最底层，与 vision/landmarks.ts 并列。
 *
 * 上游：@mediapipe/tasks-vision 的 PoseLandmarker 输出（每帧 33 点）。
 * 下游：
 *   - vision/poseTracker.ts  使用本文件的类型与点数校验，产出 DetectedPose
 *   - vision/relation.ts     使用 POSE_LM 索引计算肩宽、身体中心、高度分区
 *   - render/poseOverlay.ts  使用 POSE_CONNECTIONS 绘制骨架
 *
 * 约束（G2，必须保留）：
 *   姿态模型的 17–22 点（左右小指 / 食指 / 拇指）**不得**作为手部关键点使用。
 *   它们是粗粒度点，分辨率与稳定性都低于专用手部模型。
 *   本项目手部关键点的唯一来源是 HandLandmarker（21 点，见 landmarks.ts）。
 *
 * 本文件只放常量、拓扑与类型；所有几何计算（腕匹配、side、heightZone、distance）
 * 一律留在 vision/relation.ts，避免常量文件承担算法职责。
 */

import type { Pt } from "./landmarks";

/**
 * 单手一帧的姿态观测结果。
 * lm 为归一化图像坐标（0..1，左上原点），world 为米制（原点≈两髋中点）。
 */
export interface DetectedPose {
  score: number;
  lm: Pt[];
  world: Pt[];
}

/** 每帧姿态关键点数量。 */
export const POSE_LANDMARK_COUNT = 33;

/**
 * MediaPipe PoseLandmarker 的 33 点索引（BlazePose GHUM 拓扑）。
 *
 * 0            鼻
 * 1..3         左眼 内 / 眼 / 外        4..6   右眼 内 / 眼 / 外
 * 7            左耳                     8      右耳
 * 9            左嘴角                   10     右嘴角
 * 11 / 12      左肩 / 右肩
 * 13 / 14      左肘 / 右肘
 * 15 / 16      左腕 / 右腕
 * 17 / 18      左小指 / 右小指
 * 19 / 20      左食指 / 右食指
 * 21 / 22      左拇指 / 右拇指
 * 23 / 24      左髋 / 右髋
 * 25 / 26      左膝 / 右膝
 * 27 / 28      左踝 / 右踝
 * 29 / 30      左脚跟 / 右脚跟
 * 31 / 32      左脚尖 / 右脚尖
 *
 * 其中 17–22 只允许用于姿态自身的可视化，禁止作为手部关键点（见文件顶部 G2）。
 */
export const POSE_LM = {
  NOSE: 0,

  LEFT_EYE_INNER: 1,
  LEFT_EYE: 2,
  LEFT_EYE_OUTER: 3,
  RIGHT_EYE_INNER: 4,
  RIGHT_EYE: 5,
  RIGHT_EYE_OUTER: 6,

  LEFT_EAR: 7,
  RIGHT_EAR: 8,

  MOUTH_LEFT: 9,
  MOUTH_RIGHT: 10,

  LEFT_SHOULDER: 11,
  RIGHT_SHOULDER: 12,
  LEFT_ELBOW: 13,
  RIGHT_ELBOW: 14,
  LEFT_WRIST: 15,
  RIGHT_WRIST: 16,

  LEFT_PINKY: 17,
  RIGHT_PINKY: 18,
  LEFT_INDEX: 19,
  RIGHT_INDEX: 20,
  LEFT_THUMB: 21,
  RIGHT_THUMB: 22,

  LEFT_HIP: 23,
  RIGHT_HIP: 24,
  LEFT_KNEE: 25,
  RIGHT_KNEE: 26,
  LEFT_ANKLE: 27,
  RIGHT_ANKLE: 28,
  LEFT_HEEL: 29,
  RIGHT_HEEL: 30,
  LEFT_FOOT_INDEX: 31,
  RIGHT_FOOT_INDEX: 32,
} as const;

/** 姿态骨架连线（MediaPipe 标准拓扑，共 35 条）。 */
export const POSE_CONNECTIONS: ReadonlyArray<readonly [number, number]> = [
  // 面部：左 / 右
  [POSE_LM.NOSE, POSE_LM.LEFT_EYE_INNER],
  [POSE_LM.LEFT_EYE_INNER, POSE_LM.LEFT_EYE],
  [POSE_LM.LEFT_EYE, POSE_LM.LEFT_EYE_OUTER],
  [POSE_LM.LEFT_EYE_OUTER, POSE_LM.LEFT_EAR],

  [POSE_LM.NOSE, POSE_LM.RIGHT_EYE_INNER],
  [POSE_LM.RIGHT_EYE_INNER, POSE_LM.RIGHT_EYE],
  [POSE_LM.RIGHT_EYE, POSE_LM.RIGHT_EYE_OUTER],
  [POSE_LM.RIGHT_EYE_OUTER, POSE_LM.RIGHT_EAR],

  // 嘴
  [POSE_LM.MOUTH_LEFT, POSE_LM.MOUTH_RIGHT],

  // 躯干与左臂
  [POSE_LM.LEFT_SHOULDER, POSE_LM.RIGHT_SHOULDER],
  [POSE_LM.LEFT_SHOULDER, POSE_LM.LEFT_ELBOW],
  [POSE_LM.LEFT_ELBOW, POSE_LM.LEFT_WRIST],
  [POSE_LM.LEFT_WRIST, POSE_LM.LEFT_PINKY],
  [POSE_LM.LEFT_WRIST, POSE_LM.LEFT_INDEX],
  [POSE_LM.LEFT_WRIST, POSE_LM.LEFT_THUMB],
  [POSE_LM.LEFT_PINKY, POSE_LM.LEFT_INDEX],

  // 右臂
  [POSE_LM.RIGHT_SHOULDER, POSE_LM.RIGHT_ELBOW],
  [POSE_LM.RIGHT_ELBOW, POSE_LM.RIGHT_WRIST],
  [POSE_LM.RIGHT_WRIST, POSE_LM.RIGHT_PINKY],
  [POSE_LM.RIGHT_WRIST, POSE_LM.RIGHT_INDEX],
  [POSE_LM.RIGHT_WRIST, POSE_LM.RIGHT_THUMB],
  [POSE_LM.RIGHT_PINKY, POSE_LM.RIGHT_INDEX],

  // 髋
  [POSE_LM.LEFT_SHOULDER, POSE_LM.LEFT_HIP],
  [POSE_LM.RIGHT_SHOULDER, POSE_LM.RIGHT_HIP],
  [POSE_LM.LEFT_HIP, POSE_LM.RIGHT_HIP],

  // 腿
  [POSE_LM.LEFT_HIP, POSE_LM.LEFT_KNEE],
  [POSE_LM.RIGHT_HIP, POSE_LM.RIGHT_KNEE],
  [POSE_LM.LEFT_KNEE, POSE_LM.LEFT_ANKLE],
  [POSE_LM.RIGHT_KNEE, POSE_LM.RIGHT_ANKLE],

  // 脚
  [POSE_LM.LEFT_ANKLE, POSE_LM.LEFT_HEEL],
  [POSE_LM.RIGHT_ANKLE, POSE_LM.RIGHT_HEEL],
  [POSE_LM.LEFT_HEEL, POSE_LM.LEFT_FOOT_INDEX],
  [POSE_LM.RIGHT_HEEL, POSE_LM.RIGHT_FOOT_INDEX],
  [POSE_LM.LEFT_ANKLE, POSE_LM.LEFT_FOOT_INDEX],
  [POSE_LM.RIGHT_ANKLE, POSE_LM.RIGHT_FOOT_INDEX],
];

/** 读取指定索引的姿态关键点；缺失时抛出可定位的错误。 */
export function posePt(lm: readonly Pt[], index: number): Pt {
  const p = lm[index];
  if (!p) {
    throw new Error(`姿态关键点缺失：索引 ${index}（当前点数 ${lm.length}）`);
  }
  return p;
}

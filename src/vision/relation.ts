/**
 * 数据流位置：姿态与手部之间的派生层，被 vision/scheduler.ts 在「姿态推理帧」调用。
 *
 * 上游：同一帧的 DetectedPose（至多一人）+ DetectedHand[]（至多两只，numHands=2）。
 * 下游：scheduler 把返回的每一条 HandRelation 以 "hand:relation" 事件发出。
 *
 * 本文件是纯函数：不读 DOM、不读 video、不发事件、不缓存任何状态。
 *
 * 顺序写死（D5 / 阶段 2 第 2 节），禁止调换：
 *   前置检查 → 肩宽（像素）→ 腕匹配 → 匹配成功后才取掌心 → side / heightZone / distance。
 * 先算 side 再匹配会把路人甲的手按主角的身体位置输出，属于必须避免的错误。
 */

import { palmCenter, type DetectedHand } from "./landmarks";
import { POSE_LM, posePt, type DetectedPose } from "./poseLandmarks";

/** 单只手相对姿态主体的空间关系。 */
export interface HandRelation {
  hand: "Left" | "Right";
  side: "left" | "right" | "front";
  heightZone: "head" | "torso" | "below";
  /** 掌心到两肩中点的距离，以肩宽为单位，无量纲。 */
  distance: number;
}

/**
 * 全部阈值集中于此（阶段 2 第 2 节）。
 * 0.6 为新增扩展初始值，阶段 3 实测回填；0.5 与 0.001 同理。
 */
export const RELATION_CONFIG = {
  matchThresholdShoulderWidth: 0.6,
  frontHalfWidthShoulderWidth: 0.5,
  minShoulderWidthRatio: 0.001,
} as const;

/**
 * 计算手部相对姿态主体的空间关系。
 *
 * @param pose   同一帧的姿态结果；为 null 时返回空数组
 * @param hands  同一帧的手部结果
 * @param width  视频帧宽（像素），用于把归一化坐标换算成各向同性距离
 * @param height 视频帧高（像素）
 */
export function computeRelation(
  pose: DetectedPose | null,
  hands: DetectedHand[],
  width: number,
  height: number,
): HandRelation[] {
  // 1. 前置：没有姿态或没有手，直接返回。
  if (!pose || hands.length === 0) return [];
  if (!(width > 0) || !(height > 0)) return [];

  // 2. 肩宽：姿态 11/12，按像素计算，避免归一化坐标的各向异性。
  const leftShoulder = posePt(pose.lm, POSE_LM.LEFT_SHOULDER);
  const rightShoulder = posePt(pose.lm, POSE_LM.RIGHT_SHOULDER);
  const shoulderWidth = Math.hypot(
    (leftShoulder.x - rightShoulder.x) * width,
    (leftShoulder.y - rightShoulder.y) * height,
  );

  // 肩宽过小（侧身、遮挡、退化）时整帧放弃，不逐只手打补丁。
  if (shoulderWidth < RELATION_CONFIG.minShoulderWidthRatio * width) return [];

  const centerX = (leftShoulder.x + rightShoulder.x) / 2;
  const centerY = (leftShoulder.y + rightShoulder.y) / 2;
  const noseY = posePt(pose.lm, POSE_LM.NOSE).y;
  const hipY =
    (posePt(pose.lm, POSE_LM.LEFT_HIP).y + posePt(pose.lm, POSE_LM.RIGHT_HIP).y) / 2;

  const poseLeftWrist = posePt(pose.lm, POSE_LM.LEFT_WRIST);
  const poseRightWrist = posePt(pose.lm, POSE_LM.RIGHT_WRIST);

  const relations: HandRelation[] = [];

  for (const hand of hands) {
    // 3. 腕匹配：手部 lm[0] 到姿态 15/16 的像素距离除以肩宽，取较小者。
    const wrist = hand.lm[0];
    if (!wrist) continue;

    const toLeftWrist =
      Math.hypot(
        (wrist.x - poseLeftWrist.x) * width,
        (wrist.y - poseLeftWrist.y) * height,
      ) / shoulderWidth;
    const toRightWrist =
      Math.hypot(
        (wrist.x - poseRightWrist.x) * width,
        (wrist.y - poseRightWrist.y) * height,
      ) / shoulderWidth;

    const matchDistance = Math.min(toLeftWrist, toRightWrist);
    if (matchDistance > RELATION_CONFIG.matchThresholdShoulderWidth) continue;

    // 4. 只有匹配成功，才读取掌心并参与后续计算。
    const palm = palmCenter(hand.lm);
    const dx = (palm.x - centerX) * width;
    const dy = (palm.y - centerY) * height;

    // 5. side：以两肩中点为界；正面朝镜头时图像左侧 = 被摄者右侧（D8）。
    let side: HandRelation["side"];
    if (Math.abs(dx) < RELATION_CONFIG.frontHalfWidthShoulderWidth * shoulderWidth) {
      side = "front";
    } else {
      side = palm.x < centerX ? "right" : "left";
    }

    // 6. heightZone：鼻以上为 head，髋以下为 below，其余为 torso。
    let heightZone: HandRelation["heightZone"];
    if (palm.y < noseY) {
      heightZone = "head";
    } else if (palm.y > hipY) {
      heightZone = "below";
    } else {
      heightZone = "torso";
    }

    // 7. distance：掌心到两肩中点的像素距离，除以肩宽。
    relations.push({
      hand: hand.handedness,
      side,
      heightZone,
      distance: Number((Math.hypot(dx, dy) / shoulderWidth).toFixed(3)),
    });
  }

  return relations;
}

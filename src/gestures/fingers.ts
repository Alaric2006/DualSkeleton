/**
 * 数据流位置：几何判定层。把一只手的关键点折算成「五根手指是否伸展」。
 *
 * 上游：vision/handTracker.ts 输出的 DetectedHand（已平滑的归一化关键点）。
 * 下游：gestures/engine.ts 用 FingerState + pinchRatio 分类手势；debug/panel.ts 直接展示。
 *
 * 判据刻意避开「指尖 y < PIP y」这种依赖手部朝向的写法：
 * 手一歪或旋转 90°，y 方向比较就会失效。这里统一用关节夹角，与画面朝向无关。
 */

import {
  FINGER_JOINTS,
  LM,
  angleAt,
  dist2,
  palmSize,
  pt,
  type DetectedHand,
  type FingerState,
  type Pt,
} from "../vision/landmarks";

/**
 * 全部手势阈值集中在此，便于用真实摄像头标定。
 * 角度单位为度；距离均为「除以掌长」后的无量纲比例，因此与用户离镜头远近无关。
 */
export const FINGER_CONFIG = {
  /** 四指（食/中/无名/小指）伸展阈值：MCP-PIP-TIP 夹角大于它算伸展。 */
  extendAngleDeg: 155,
  /** 拇指伸展阈值：CMC-MCP-TIP 夹角大于它算伸展。 */
  thumbExtendAngleDeg: 145,
  /** 拇指伸展的附加条件：指尖必须离食指根部足够远，否则视为收拢在掌心。 */
  thumbAwayRatio: 0.45,
  /** 捏合判定：拇指尖与食指尖的归一化距离小于它算捏合。 */
  pinchRatio: 0.35,
  /**
   * 捏合的附加条件：食指不能是完全蜷进掌心的状态。
   * 握拳时拇指尖常贴在食指近端，仅看距离会误判成捏合；真实捏合时食指至少保留一定张开度。
   */
  pinchMinIndexAngleDeg: 90,
} as const;

function angleFor(lm: readonly Pt[], finger: keyof typeof FINGER_JOINTS): number {
  const [a, b, c] = FINGER_JOINTS[finger];
  return angleAt(pt(lm, a), pt(lm, b), pt(lm, c));
}

function isFingerExtended(lm: readonly Pt[], finger: keyof typeof FINGER_JOINTS): boolean {
  return angleFor(lm, finger) > FINGER_CONFIG.extendAngleDeg;
}

/**
 * 拇指不能只看夹角：拇指横向张开时夹角很大，但平贴在掌心时夹角也不小。
 * 因此叠加「指尖到食指根部的归一化距离」这一条件。
 */
function isThumbExtended(lm: readonly Pt[], palm: number): boolean {
  const angle = angleFor(lm, "thumb");
  const away = dist2(pt(lm, LM.THUMB_TIP), pt(lm, LM.INDEX_MCP)) / palm;
  return angle > FINGER_CONFIG.thumbExtendAngleDeg && away > FINGER_CONFIG.thumbAwayRatio;
}

/** 拇指尖-食指尖的归一化距离。越小越接近捏合。 */
export function pinchDistanceRatio(hand: DetectedHand): number {
  const palm = palmSize(hand.lm);
  return dist2(pt(hand.lm, LM.THUMB_TIP), pt(hand.lm, LM.INDEX_TIP)) / palm;
}

/**
 * 捏合：指尖足够近，且食指没有完全蜷进掌心。
 * 第二个条件是为了把「握拳时拇指贴在食指上」排除掉。
 */
export function isPinch(hand: DetectedHand): boolean {
  return (
    pinchDistanceRatio(hand) < FINGER_CONFIG.pinchRatio &&
    angleFor(hand.lm, "index") > FINGER_CONFIG.pinchMinIndexAngleDeg
  );
}

/** 单手 → 五指示伸展状态。 */
export function getFingerState(hand: DetectedHand): FingerState {
  const palm = palmSize(hand.lm);
  return {
    thumb: isThumbExtended(hand.lm, palm),
    index: isFingerExtended(hand.lm, "index"),
    middle: isFingerExtended(hand.lm, "middle"),
    ring: isFingerExtended(hand.lm, "ring"),
    pinky: isFingerExtended(hand.lm, "pinky"),
  };
}

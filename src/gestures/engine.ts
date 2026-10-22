/**
 * 数据流位置：手势决策层。把「每帧的手指状态」收敛成「稳定的手势名」，并对外发事件。
 *
 * 上游：main.ts 每帧调用 update(hands)；handTracker 已经把关键点平滑过。
 * 下游：core/bus 的 "gesture" 事件（订阅方：debug/panel，后续可接音频/MIDI/动画）。
 *
 * 防抖的意义：手的瞬时抖动会让手指伸展状态在边界来回跳变，直接发事件会导致下游频繁触发。
 * 这里要求同一个候选手势连续 N 帧一致，才认为它成立。
 */

import { bus } from "../core/bus";
import {
  palmCenter,
  type DetectedHand,
  type FingerState,
  type Handedness,
} from "../vision/landmarks";
import { getFingerState, isPinch } from "./fingers";

export type GestureName = "fist" | "open_palm" | "pinch" | "point" | "peace" | "unknown";

/** 连续多少帧一致才 emit。约 5 帧 ≈ 30fps 下 170ms。 */
export const GESTURE_DEBOUNCE_FRAMES = 5;

interface HandState {
  candidate: GestureName;
  frames: number;
  /** 上一次已经对外发出的手势；为 null 表示还没发过。 */
  emitted: GestureName | null;
}

/**
 * 分类顺序即优先级：
 *   1. 四指全伸 → open_palm（张开手掌时拇指与食指距离必然大于捏合阈值，先判不会误伤）
 *   2. 拇指食指相捏 → pinch（捏合时食指可能弯曲，因此必须排在 point/fist 之前；
 *      判定里已排除“握拳时拇指贴在食指近端”的伪捏合）
 *   3. 仅食指 → point
 *   4. 食指+中指 → peace
 *   5. 四指全弯 → fist（忽略拇指，握拳时拇指位置个体差异大）
 *   6. 其余（如三指、食指+无名指）→ unknown
 */
function classify(fingers: FingerState, pinch: boolean): GestureName {
  const extended = [fingers.index, fingers.middle, fingers.ring, fingers.pinky].filter(Boolean)
    .length;

  if (extended === 4) return "open_palm";
  if (pinch) return "pinch";
  if (extended === 0) return "fist";
  if (fingers.index && !fingers.middle && !fingers.ring && !fingers.pinky) return "point";
  if (fingers.index && fingers.middle && !fingers.ring && !fingers.pinky) return "peace";
  return "unknown";
}

export class GestureEngine {
  private readonly states = new Map<Handedness, HandState>();

  /** 处理一帧检测结果；手消失时清空该手的状态，避免后续出现幽灵触发。 */
  update(hands: readonly DetectedHand[]): void {
    const seen = new Set<Handedness>();

    for (const hand of hands) {
      seen.add(hand.handedness);
      this.updateOne(hand);
    }

    for (const key of [...this.states.keys()]) {
      if (!seen.has(key)) this.states.delete(key);
    }
  }

  /** 当前每只手已确立的手势（供渲染层显示；不含尚未稳定的 candidates）。 */
  current(): Map<Handedness, GestureName> {
    const out = new Map<Handedness, GestureName>();
    for (const [hand, state] of this.states) {
      if (state.emitted) out.set(hand, state.emitted);
    }
    return out;
  }

  private updateOne(hand: DetectedHand): void {
    const fingers = getFingerState(hand);
    const gesture = classify(fingers, isPinch(hand));

    let state = this.states.get(hand.handedness);
    if (!state) {
      state = { candidate: gesture, frames: 0, emitted: null };
      this.states.set(hand.handedness, state);
    }

    if (state.candidate === gesture) {
      state.frames += 1;
    } else {
      state.candidate = gesture;
      state.frames = 1;
    }

    if (state.frames >= GESTURE_DEBOUNCE_FRAMES && state.emitted !== gesture) {
      state.emitted = gesture;
      bus.emit("gesture", {
        hand: hand.handedness,
        name: gesture,
        fingers,
        palm: palmCenter(hand.lm),
      });
    }
  }
}

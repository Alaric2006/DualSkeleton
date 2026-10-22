/**
 * 数据流位置：全局事件中枢。
 *
 * 上游：main.ts 每帧把 tracker 的结果 emit 成 "hands:raw"；gestures/engine.ts 在手势稳定后 emit "gesture"。
 * 下游：debug/panel.ts（现状）。后续接音频、MIDI、动画时，只需新增订阅者，不必改动识别链路。
 *
 * 约定：负载是「某一帧的快照」，订阅者请勿缓存并修改其中的数组/对象。
 */

import type { DetectedHand, FingerState, Handedness, Pt } from "../vision/landmarks";
import type { DetectedPose } from "../vision/poseLandmarks";
import type { HandRelation } from "../vision/relation";

/**
 * "gesture" 负载。
 * name 故意声明为 string（而不是引擎内部的联合类型），这样后续新增手势不会破坏已有订阅方。
 */
export interface GestureEventPayload {
  hand: Handedness;
  name: string;
  fingers: FingerState;
  palm: Pt;
}

/** 事件名 → 负载类型。新增事件在这里加一行，on/off/emit 自动获得类型检查。 */
export interface EventMap {
  "hands:raw": DetectedHand[];
  gesture: GestureEventPayload;
  "pose:raw": DetectedPose | null;
  "hand:relation": HandRelation;
}

type Handler<K extends keyof EventMap> = (payload: EventMap[K]) => void;

export class EventBus {
  private readonly handlers = new Map<keyof EventMap, Set<(payload: never) => void>>();

  on<K extends keyof EventMap>(type: K, handler: Handler<K>): void {
    let set = this.handlers.get(type);
    if (!set) {
      set = new Set();
      this.handlers.set(type, set);
    }
    set.add(handler as unknown as (payload: never) => void);
  }

  off<K extends keyof EventMap>(type: K, handler: Handler<K>): void {
    this.handlers.get(type)?.delete(handler as unknown as (payload: never) => void);
  }

  emit<K extends keyof EventMap>(type: K, payload: EventMap[K]): void {
    const set = this.handlers.get(type);
    if (!set) return;
    // 先拷贝再遍历：允许订阅者在回调里 off 自己，而不影响本次派发。
    for (const handler of [...set]) {
      (handler as unknown as Handler<K>)(payload);
    }
  }
}

/** 全局单例。业务侧 import 这一个对象即可订阅，无需层层传参。 */
export const bus = new EventBus();

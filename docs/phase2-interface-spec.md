# 阶段 2 说明（第 3 节：新增文件清单与职责）

> 本文件承接阶段 2 说明的第 3 节，按 2026-10-22 裁决修订。阶段 2 的其余章节未落盘，不在本文件范围内。
>
> 本文件只承接阶段 2 第 3 节；其余各节见对话记录中的阶段 2 说明，或由 `fact-sheet.md` / `phase1-mapping.md` 覆盖。

| 文件 | 对外导出 | 数据流位置 | 依赖 |
| --- | --- | --- | --- |
| `vision/poseLandmarks.ts` | `POSE_LANDMARK_COUNT`、`POSE_LM`、`POSE_CONNECTIONS`、`posePt()`、`interface DetectedPose` | 姿态链路最底层，与 `landmarks.ts` 并列；顶部写明 G2 | 仅 `type Pt`（来自 `landmarks.ts`） |
| `vision/poseTracker.ts` | `class PoseTracker`：`init()`、`detect(video, ts): DetectedPose \| null`、`ready`、`currentBackend`、`close()` | 推理层，与 `handTracker` 并列 | `@mediapipe/tasks-vision`、`poseLandmarks`、`landmarks`（类型） |
| `vision/relation.ts` | `computeRelation(pose, hands, width, height): HandRelation[]`、`RELATION_CONFIG`、`interface HandRelation` | 纯函数几何层，被 scheduler 调用 | `landmarks`、`poseLandmarks` |
| `vision/scheduler.ts` | `class TrackerScheduler`：`update(video, ts, width, height): FrameResult`、`currentStride`、`currentPoseEnabled`、`lastAdaptReason`、`reset()`、`setPoseEnabled(enabled)`、`disablePose()`；`interface FrameResult` | 编排层，位于 main 与两个 tracker 之间 | `handTracker`、`poseTracker`、`relation`、`bus` |
| `render/poseOverlay.ts` | `class PoseOverlay`：`resize(w, h)`、`draw(pose, options?)` | 显示层，位于 `overlay.ts` 下方（z 序） | `poseLandmarks` |

## 调度契约（修订）

```ts
update(
  video: HTMLVideoElement,
  ts: number,
  width: number,
  height: number,
): FrameResult;

export interface FrameResult {
  hands: DetectedHand[];
  pose: DetectedPose | null;
  poseFresh: boolean;
  poseAgeMs: number;
}
```

- `width` / `height` 由 `main.ts` 的 `syncCanvasSizes` 计算后传入；**scheduler 不读取 `video.videoWidth` / `video.videoHeight`**。
- `FrameResult` 中的姿态与关系结果依赖这两个入参计算，scheduler 自身不推导视频尺寸。
- 姿态帧判定：**第 3 / 6 / 9… 次 `update`** 执行姿态推理（`frameIndex % stride === 0`），stride 变化后按新值取模。
- `poseAgeMs`：距上一次姿态推理完成的毫秒数；**从未推理过为 `Infinity`**。绘制层遇到 `Infinity` 时不绘制姿态层。
- `pose:raw` 与 `hand:relation` 由 scheduler 在 `update()` 内直接 emit；非推理帧不发，且 `poseFresh` 必须为 `false`。

## 页面结构约定（index.html）

- `.stage` 内 DOM 顺序固定为 `video → poseOverlay → handOverlay → #error`。禁用 z-index，层叠只由 DOM 顺序决定；video 保持正常文档流，由它撑出 `.stage` 的真实宽高比。
- 两块 canvas 均设 `pointer-events: none`；所有交互元素（两个开关、`#notice`、`#panel`）都放在 `.stage` 外部。

## 第 6 节（初始化顺序与失败隔离）修订

- 姿态模型初始化失败时，`main` 调用 `scheduler.disablePose()`；此后 scheduler 不再执行姿态推理，也不再 emit `pose:raw` / `hand:relation`，不会出现“姿态帧发 null”的中间语义。
- 手部模型初始化失败时，`HandTracker.detect()` 在未初始化状态下返回 `[]`（不抛错），主循环继续；`engine.update([])` 只清空内部状态、不 emit `gesture`。



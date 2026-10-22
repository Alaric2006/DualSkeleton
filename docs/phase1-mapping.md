# 阶段 1 映射表

本文件只引用 `docs/fact-sheet.md` 的编号，不引用对话记录。阶段 3 重建 README 时整表内嵌。

## 表 1：手部识别相关改动

| # | 文件 | 改动 | 依据 | 为什么必须改 | 对外接口影响 |
| --- | --- | --- | --- | --- | --- |
| 1 | `src/render/overlay.ts` | 按原接口重建 | R1 | 手部骨架渲染层需要恢复；新增姿态层要求两块 canvas 共用同一尺寸基准，重建时保持手部层职责单一，由主循环统一调用两层的 `resize()` | 公开成员保持 `constructor(video, canvas)`、`resize()`、`draw(hands, labels)`；行为满足原验收标准（骨架贴合、标签可读、随视频尺寸、无人时不残留） |
| 2 | `src/vision/handTracker.ts` | 零改动 | R1 | 无 | 无 |
| 3 | `src/gestures/fingers.ts` | 零改动 | R1 | 无 | 无 |
| 4 | `src/gestures/engine.ts` | 零改动 | R1 | 无 | 无 |
| 5 | `src/vision/landmarks.ts` | 零改动 | R1 | 无（手部常量只许追加；本次连追加都不需要） | 无 |
| 6 | `src/core/bus.ts` | 仅追加 `EventMap` 键 | R1 / D5 | 新增 `pose:raw`、`hand:relation` 需要类型入口；既有键与分发逻辑不动 | 既有键类型与 `on/off/emit` 不变；仅追加两个键 |

> 除上表第 1 行外，本阶段不存在需要改动的手部文件。若实现中发现必须改，先停下列出理由申请，不直接改。

## 表 2：全身识别新增决策

| 决策 | 依据（Fact Sheet 编号） | 是否偏离逆向 | 备注 |
| --- | --- | --- | --- |
| **D1** 双模型：HandLandmarker + PoseLandmarker(lite)；不用 Holistic；`numPoses: 1`、`outputSegmentationMasks: false`；多人取最显著者；`hands:raw` 仍按 `numHands: 2` 发最多两只手，主体限制只作用于 `hand:relation` | G1、G3.3、B2；模型体积见 D1 本体 | 是（姿态部分无逆向依据；手部部分不偏离 B2） | Holistic 会替换手部链路，禁用 |
| **D2** 不级联，两个模型各自对整帧推理 | B5、D1、D5 | 是 | 手部任务内部已含掌部检测阶段；级联会把姿态延迟串到手部 |
| **D3** `vision/poseLandmarks.ts` 独立命名空间：33 点、35 条连接、`POSE_LM`/`POSE_CONNECTIONS`/`POSE_LANDMARK_COUNT`/`posePt()`；顶部写 G2 | G2、B6 | 是 | 手部模块不得 import 姿态模块，避免污染 |
| **D4** 坐标统一：同帧 `lm` 直接可比；距离换算像素或按宽高比校正；禁止跨模型相减 `world`；跨模型距离用肩宽归一化 | B7、D1 | 是 | `world` 原点不同（手部≈手部几何中心，姿态≈两髋中点） |
| **D5** 单 rVFC、统一时间戳、同帧先手后姿态、姿态 stride；`pose:raw` 与 `hand:relation` 仅在姿态推理帧 emit；relation 只用同帧手部结果；手腕匹配阈值 0.6×肩宽，阈值内取最近 | G3.2、G3.3、D1 | 是 | 0.6×肩宽为初始值，阶段 3 实测回填；未匹配的手不参与 relation |
| **D6** 初始 stride=3；自适应只看手部推理滚动 p50（高于 20ms 持续 1s 升档；低于 14ms 持续 3s 降档，下限 3；仅当 p50 低于 12ms 且整体 fps 高于 50 持续 3s 才允许 2）；stride=6 仍不足 20fps 则停姿态保手部 | G3.1、D1；**p50** 手部 16.8 / 姿态 8.6 / 合计 24.7 ms；**p95** 手部 34.2 / 姿态 17.3 / 合计 49.8 ms；N=2 p50 +25.6%（超 20% 上限），N=3 p50 +17.0%、p95 +16.7% | 是 | 判定不看整体 fps：有人无手时手部仅约 4.4ms，会被误判为有余量 |
| **D7** 独立 `poseOverlay` canvas，与手部 canvas 同尺寸同盒；姿态在下、手部在上；低饱和琥珀色细线。全身骨架开关同时控制姿态推理与绘制（关闭即停止推理、清空 `lastPose`、不发 `pose:raw` / `hand:relation`）；手部骨架开关只控制绘制 | E7、D5、D6 | 是（目标站为镜像渲染，本项目不镜像） | 两者不对称属有意设计，不得为“一致性”统一 |
| **D8** `Left`/`Right` 恒指解剖学左右；姿态 33 点用其 left/right 命名；手部沿用 `categoryName`；`side` 以两肩中点为界、正面朝镜头时 `palm.x < center.x` 记为 `right`；横向偏差小于 0.5×肩宽为 `front`；高度按鼻/肩/髋分区 | B6、G2 | 是 | 几何与手部标签冲突时只在面板标注，不自动改写 |

### 非逆向来源（新增扩展）分表

（空）本阶段 D1–D8 均能引用 Fact Sheet 编号，无引用不到的决策。

## 承诺清单

- [x] `gesture` 事件签名不变 —— 验证方式：人工核对语义基线（见下两条）。
- [x] `EventMap` 既有键 `hands:raw` / `gesture` 的类型不变 —— 验证方式：人工核对语义基线。
- [x] `on` / `off` / `emit` 实现不变 —— 验证方式：人工核对语义基线。
  > `bus.ts` 曾因备份丢失被整文件重写，字节级一致性无法证明；已逐行核对代码与类型，无语义变化，差异在注释/空行。
- [x] `DetectedHand` 类型不变 —— 证据：`vision/landmarks.ts` 零改动（表 1 第 5 行）。
- [x] `landmarks.ts` 手部常量索引只许追加、不许改 —— 本次零改动，连追加都没有。
- [x] 原有全部验收标准仍通过 —— 真机 2026-10-22 全部通过：骨架贴合、双手、relation、两个开关、断网、手/人离开清空、`tsc`/`build`。
- [x] `hands:raw` 仍按 `numHands=2` 输出，主体限制只作用于 `hand:relation` —— 依据 D1。
- [x] `pose:raw` 与 `hand:relation` 只在姿态推理帧 emit —— 依据 D5。
- [ ] 手部帧率降幅 ≤20%（p50/p95 双口径）—— 真机 fps 无变化（30fps 垂直同步封顶），但 p50/p95 数值未单独采集；300 帧真机基准仍待执行。

### 阶段 3 待办

**已完成（真机验收，2026-10-22）**

- [x] 真机验收 7 项全部通过：骨架贴合、双手同时出现、relation 的 side/heightZone、两个开关、断网、手离开清空、人离开清空。
- [x] 方案 A 验证：关闭“全身骨架”后 `[pose]` 彻底停止，重开后在下一个姿态帧恢复。
- [x] D6 真机对照：硬件 GPU 下双模型未触达瓶颈，rVFC 稳定 30fps；关闭姿态推理后 fps 无变化。

**仍未闭环**

- [ ] `poseTracker` 运行期 GPU→CPU 回退的真实 GPU 故障验证（此前仅注入验证）。
- [ ] `bus.ts` 字节级基线无法证明（追加已完成、仅 4 行新增且语义已核对；差异仅可能在注释/空行）。
- [ ] 300 帧真机基准的 p50/p95 数值采集，用于替代 D6 中的 headless 绝对值。



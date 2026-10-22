# DualSkeleton · 浏览器端手部 + 全身双识别底座

纯前端的双模型识别底座：手部 21 点 + 全身 33 点，只做识别与可视化，不含任何业务逻辑（不接音频、不做合成、不做 MIDI）。业务侧通过事件总线订阅即可。

- 运行时：`@mediapipe/tasks-vision@0.10.14`（HandLandmarker + PoseLandmarker lite）
- 渲染：原生 Canvas 2D，无 UI 框架、无 three.js
- 架构：纯前端、零后端、资源完全自托管、断网可运行

---

## 1. 项目简介

本项目在「手部识别」的基础上增加了「全身姿态识别」，两者是相互独立的两条链路，只在同一帧的调度与空间关系计算处汇合：

- **手部链路**：21 个关键点、五指示伸展状态、防抖后的手势名（fist / open_palm / pinch / point / peace / unknown）。
- **全身链路**：33 个关键点、骨架绘制、手相对身体的空间关系（左/右侧、高度区域、距离）。

技术边界：

- 纯前端，无后端、无数据库、无登录；
- 模型、wasm、字体、样式全部位于 `public/` 与项目内，运行时不请求任何外部域名；
- 断开外网后，只要本机服务可访问，功能完整（模型与 wasm 由本地 HTTP 提供）。

---

## 2. 快速开始

### 安装与运行

```bash
npm install
npm run dev
```

打开终端输出的地址（默认 `http://localhost:5173`），允许摄像头即可看到两套骨架与右侧调试面板。

### 摄像头与安全上下文

浏览器只在**安全上下文**下允许 `getUserMedia`：

- `http://localhost`（含 `127.0.0.1`）可用；
- 局域网 IP 以 `http://192.168.x.x` 访问会被浏览器直接拒绝，需要配置 https；
- 部署到线上时必须使用 https。

### 生产构建

```bash
npm run build     # 先 tsc --noEmit，再 vite build
npm run preview   # 本地预览 dist
```

静态服务器必须为 `.wasm` 返回 `application/wasm`，否则实例化失败。

### 自托管资源

| 文件 | 用途 | 大小 |
| --- | --- | --- |
| `public/models/hand_landmarker.task` | 手部模型（float16 v1） | 7,819,105 B |
| `public/models/pose_landmarker_lite.task` | 姿态模型（lite float16） | 5,777,746 B |
| `public/mediapipe/wasm/vision_wasm_internal.{js,wasm}` | SIMD 推理运行时 | 209,826 / 9,423,986 B |
| `public/mediapipe/wasm/vision_wasm_nosimd_internal.{js,wasm}` | 非 SIMD 回退 | 209,735 / 9,294,247 B |

---

## 3. 核心约束与事实摘要

### 3.1 必须遵守的约束

- **G2**：手部关键点的唯一来源是 `HandLandmarker`（21 点）。姿态模型的 **17–22 点**（左右小指/食指/拇指）**禁止**作为手部关键点使用。
- **R1**：手部链路零重构——`handTracker.ts`、`fingers.ts`、`engine.ts`、`landmarks.ts` 四个文件不得改行为；`bus.ts` 仅允许向 `EventMap` 追加键，禁止改既有键类型与 `on/off/emit` 实现；`overlay.ts` 按原对外接口重建。
- **R2**：本 README 内嵌 Fact Sheet 编号与阶段 1 映射结论，作为项目内唯一事实来源；结论不得脱离编号单独存在。
- **左右语义**：`Left` / `Right` 恒指**被摄者解剖学左右**，与屏幕位置无关。本项目按未镜像原始帧显示，因此画面左侧出现的手通常是用户的右手，标签显示 `Right` 属正常。
- **尺寸所有权**：画布像素尺寸只由 `main.ts` 的 `syncCanvasSizes()` 计算，先手部层、后姿态层；两个渲染层自身不读 `video` 尺寸。

### 3.2 Fact Sheet 核心结论（编号见 `docs/fact-sheet.md`）

- **A1–A6**：目标站入口是 Next.js 展示页，乐器在 iframe 内的 Vite SPA；单 bundle 389,395 B；纯前端；无 sourcemap；依赖 tasks-vision 0.10.14 与 Tone.js 15.1.22；原站资源走 jsDelivr 与 Google Storage，本项目改为自托管。
- **B1–B7**：`HandLandmarker`、`runningMode: "VIDEO"`、`numHands: 2`、GPU；置信度用库默认 0.5；模型 float16 v1；手掌检测 192×192、关键点模型 224×224；21 点索引固定；`landmarks` 为归一化坐标，`world` 为米制。
- **C1–C12**：原站用手指尖 y < PIP y 判伸展；拇指按压用 `lm[4].x` 与 `lm[3].x`；大小调用 `lm[9].x` 与 `lm[0].x`；级数/性质按伸展数；音高升降阈值 0.5/0.8；弯音阈值 0.12；手势稳定 100 ms、消失保持 50 ms；12 调 × 7 级和弦表；半音偏移 `{1:0,2:2,3:4,4:5,5:7,6:9,7:-1}`；七和弦按 maj7/dom7/dim7/dim5 拼装；`369.99/392/415.3` Hz 先除以 2。
- **E1–E7**：低通 1200 Hz / Q 0.7 的音频链；五种音色（triangle / sawtooth / square / strings / horns）；采样 C3–G5、release 1 s；单手模式音量固定 0.2；教程 7 步；原站在 canvas 内同时镜像画面与关键点。
- **F1–F3**：原站使用 Microsoft Clarity 自定义事件与外层 Vercel Analytics，无其他第三方请求。
- **G1–G3.3**：目标站**未使用姿态模型**（唯一 `.task` 是手部模型）；G2 约束成立；G3.1 两个 task 各持一份 wasm 与图形上下文（内存增量未实测）；G3.2 姿态选型/调度无逆向依据；G3.3 多人策略无逆向依据。

### 3.3 阶段 1 表 1：手部识别改动

| 文件 | 改动 | 依据 |
| --- | --- | --- |
| `render/overlay.ts` | 按原接口重建（`constructor(canvas)`、`resize(w,h)`、`draw` 签名不变） | R1 |
| `vision/handTracker.ts` | 零改动 | R1 |
| `gestures/fingers.ts` | 零改动 | R1 |
| `gestures/engine.ts` | 零改动 | R1 |
| `vision/landmarks.ts` | 零改动（手部常量只许追加） | R1 |
| `core/bus.ts` | 仅向 `EventMap` 追加 `pose:raw`、`hand:relation` | R1 / D5 |

### 3.4 阶段 1 表 2：全身识别决策（D1–D8）

- **D1**：双模型（HandLandmarker + PoseLandmarker lite），不用 Holistic；`numPoses: 1`、`outputSegmentationMasks: false`；多人取最显著者；`hands:raw` 仍按 `numHands: 2` 发最多两只手。
- **D2**：不级联，两个模型各自对整帧推理。
- **D3**：姿态常量独立成 `poseLandmarks.ts`（33 点、35 连接）；手部模块不得 import 姿态模块。
- **D4**：同帧 `lm` 可直接比较；距离换算像素或按宽高比校正；禁止跨模型相减 `world`；跨模型距离用肩宽归一化。
- **D5**：单 rVFC、统一时间戳、同帧先手后姿态、姿态 stride；`pose:raw` 与 `hand:relation` 仅在姿态推理帧 emit；relation 只用同帧手部结果，手腕匹配阈值 0.6×肩宽。
- **D6**：初始 stride=3；自适应只看手部推理滚动 p50（高于 20 ms/1 s 升档，低于 14 ms/3 s 降档，下限 3；仅当 p50 < 12 ms 且整体 fps > 50/3 s 才允许 2）；stride=6 仍不足 20 fps 则停姿态保手部。基准：p50 手部 16.8 / 姿态 8.6 / 合计 24.7 ms；p95 34.2 / 17.3 / 49.8 ms；N=2 时 p50 +25.6%（超限），N=3 时 p50 +17.0%、p95 +16.7%。
- **D7**：独立 `poseOverlay` canvas，姿态在下、手部在上；**全身骨架开关同时控制姿态推理与绘制**（关闭即停止推理、清空 `lastPose`、不发 `pose:raw` / `hand:relation`），**手部骨架开关只控制绘制**；两者不对称属有意设计。
- **D8**：`Left`/`Right` 恒指解剖学左右；`side` 以两肩中点为界，正面朝镜头时 `palm.x < center.x` 记为 `right`；横向偏差 < 0.5×肩宽为 `front`；高度按鼻/肩/髋分区。

---

## 4. 事件与 API 指南

事件总线是全局单例，业务代码直接 import：

```ts
import { bus } from "./core/bus";
```

### hands:raw —— 每帧原始手部数据

```ts
import type { DetectedHand } from "./vision/landmarks";

bus.on("hands:raw", (hands: DetectedHand[]) => {
  for (const hand of hands) {
    // hand.handedness: "Left" | "Right"（解剖学左右）
    // hand.score: 置信度
    // hand.lm[21] / hand.world[21]
  }
});
```

### gesture —— 防抖后的手势名

```ts
bus.on("gesture", ({ hand, name, fingers, palm }) => {
  // name: "fist" | "open_palm" | "pinch" | "point" | "peace" | "unknown"
  // fingers: { thumb, index, middle, ring, pinky } 布尔
  // palm: 掌心归一化坐标
  if (hand === "Right" && name === "pinch") {
    // 触发你的业务
  }
});
```

手势需连续 5 帧一致才 emit；同一手势不会每帧重复发。

### pose:raw —— 仅姿态推理帧

```ts
import type { DetectedPose } from "./vision/poseLandmarks";

bus.on("pose:raw", (pose: DetectedPose | null) => {
  if (!pose) return;          // 推理帧但画面中无人
  // pose.score：33 点 visibility 均值（与手部 score 口径不同，禁止混用）
  // pose.lm[33] / pose.world[33]
});
```

**不是每帧都有**：初始 stride=3，只在第 3/6/9… 次 update 发出；非推理帧完全不发。关闭“全身骨架”开关后，姿态推理停止，此事件不再发出。

### hand:relation —— 仅姿态推理帧且匹配成功

```ts
bus.on("hand:relation", ({ hand, side, heightZone, distance }) => {
  // hand: "Left" | "Right"
  // side: "left" | "right" | "front"
  // heightZone: "head" | "torso" | "below"
  // distance: 掌心到两肩中点的距离，单位为肩宽
});
```

只在姿态推理帧、且该手腕与姿态主体手腕的归一化距离 ≤ 0.6×肩宽时发出；未匹配的手只存在于 `hands:raw`，不产生 relation。关闭“全身骨架”后同样停止。

### 时机汇总

| 事件 | 频率 |
| --- | --- |
| `hands:raw` | 每帧 |
| `gesture` | 手势稳定变化时（5 帧防抖） |
| `pose:raw` | 仅姿态推理帧（stride=3 起） |
| `hand:relation` | 仅姿态推理帧且匹配成功 |

---

## 5. 扩展指南：如何新增一个手势

以 `gun`（拇指 + 食指伸展）为例：

1. **在 `src/gestures/fingers.ts` 定义判据**
   - 阈值统一放在 `FINGER_CONFIG`；
   - 指节角度用 `FINGER_JOINTS` 与 `angleAt`，不要写死数字索引；
   - 如需新手指组合，可在 `getFingerState` 之上新增纯函数。

2. **在 `src/gestures/engine.ts` 注册手势**
   - 向 `GestureName` 联合类型加 `"gun"`；
   - 在 `classify()` 中加入分支，注意优先级顺序（`open_palm` → `pinch` → `point` → `peace` → `fist` → `unknown`）：

```ts
if (fingers.thumb && fingers.index && !fingers.middle && !fingers.ring && !fingers.pinky) {
  return "gun";
}
```

   - 防抖帧数由 `GESTURE_DEBOUNCE_FRAMES`（默认 5）控制；
   - 无需改 `main.ts` / `overlay.ts` / `panel.ts`，它们只消费字符串。

3. **验证**：保持手势 ≥5 帧，控制台应出现一次 `gesture` 事件；松手后状态清空。

---

## 6. 内部数据流

```text
摄像头 → video → scheduler.update(video, ts, w, h)
                   ├─ handTracker.detect() → bus("hands:raw")
                   ├─ [stride 命中] poseTracker.detect() → bus("pose:raw")
                   └─ [stride 命中且有人] computeRelation() → bus("hand:relation")
                → FrameResult → handOverlay / poseOverlay / panel
```

- `main.ts` 只负责生命周期与按 `FrameResult` 绘制；所有 emit 都在 scheduler 内完成。
- 尺寸由 `syncCanvasSizes()` 统一计算并传给两层 `resize()`。
- 手部与姿态共用同一个时间戳；各 tracker 内部保证时间戳严格单调并做重复帧去重。

---

## 7. 验收与已知待办

### 7.1 真机验收清单（2026-10-22 全部通过）

1. **骨架贴合**：骨架与画面中手部像素位置重合；标签为解剖学左右，画面左侧的手显示 `Right` 属正常。
2. **双手同时出现**：面板出现 `[Left]` 与 `[Right]` 两段，手势分别正确。
3. **relation**：举过头顶 → `head`；与肩同高 → `torso`；低于髋 → `below`；胸前 → `front`。
4. **两个开关**：手部开关只控制绘制；全身开关同时控制推理与绘制（关闭后 `[pose]` 停止）。
5. **断网**：断开外网、保留本机服务后可正常启动与识别，无外部请求。
6. **手离开清空**：骨架与标签消失，面板显示“没有检测到手”。
7. **人离开清空**：姿态骨架消失，2 秒后面板显示“姿态已关闭或无数据”。

### 7.2 仍未闭环

- [ ] `poseTracker` 运行期 GPU→CPU 回退的真实 GPU 故障验证（此前仅做注入验证）。
- [ ] `bus.ts` 字节级基线无法证明（追加已完成、仅 4 行新增且语义已核对；差异仅可能在注释/空行）。
- [ ] 300 帧真机基准的 p50/p95 数值采集，用于替代 D6 中的 headless 绝对值。

> 事实与决策编号见 `docs/fact-sheet.md`；映射表见 `docs/phase1-mapping.md`。本 README 与两者冲突时，以带编号的文档为准。
>
> 第三方组件与许可声明见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

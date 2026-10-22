# DualSkeleton

**Browser-side Hand + Body Landmark Recognition Base** — 21 hand landmarks + 33 pose landmarks, built on MediaPipe Tasks Vision.

Pure front-end. No backend. Fully self-hosted assets. Runs offline.

> The Chinese `README.md` is the canonical document (see rule R2); this file is a faithful English mirror.

## Status

- Real-device acceptance: **passed** (2026-10-22)
- `npx tsc --noEmit`: **0 errors**
- `npm run build`: **0 errors, 0 warnings**

---

## 1. Overview

DualSkeleton is a recognition-only foundation. It deliberately contains no business logic — no audio, no synthesis, no MIDI, no application state.

Two independent pipelines share one video frame:

| Pipeline | Model | Output |
| --- | --- | --- |
| Hand | `HandLandmarker` (float16 v1) | 21 landmarks per hand, finger states, debounced gesture name |
| Body | `PoseLandmarker` (lite float16) | 33 landmarks, skeleton, hand-to-body relation |

They meet only at two points: the per-frame scheduler, and the spatial-relation calculation.

Runtime: `@mediapipe/tasks-vision@0.10.14`. Rendering: native Canvas 2D (no UI framework, no three.js).

---

## 2. Quick start

```bash
npm install
npm run dev
```

Open the printed URL (default `http://localhost:5173`) and allow camera access.

Camera requires a **secure context**:

- `http://localhost` (including `127.0.0.1`) works;
- LAN access over plain `http://192.168.x.x` is rejected by the browser — use https;
- Production deployments must use https.

Build:

```bash
npm run build     # tsc --noEmit, then vite build
npm run preview   # preview dist locally
```

Static servers must serve `.wasm` as `application/wasm`.

### Self-hosted assets

| File | Purpose | Size |
| --- | --- | --- |
| `public/models/hand_landmarker.task` | Hand model (float16 v1) | 7,819,105 B |
| `public/models/pose_landmarker_lite.task` | Pose model (lite float16) | 5,777,746 B |
| `public/mediapipe/wasm/vision_wasm_internal.{js,wasm}` | SIMD runtime | 209,826 / 9,423,986 B |
| `public/mediapipe/wasm/vision_wasm_nosimd_internal.{js,wasm}` | Non-SIMD fallback | 209,735 / 9,294,247 B |

No runtime request ever leaves the origin.

---

## 3. Architecture constraints

- **G2 — single source for hand landmarks.** Hands are always produced by `HandLandmarker` (21 points). Pose landmarks **17–22** (left/right pinky, index, thumb) are coarse and **must never** be used as hand landmarks.
- **R1 — zero refactor of the hand pipeline.** `handTracker.ts`, `fingers.ts`, `engine.ts`, `landmarks.ts` keep their behavior unchanged. `bus.ts` may only **append** keys to `EventMap`; existing key types and the `on/off/emit` implementation are frozen. `overlay.ts` is rebuilt against its original public interface.
- **R2 — the documentation is the source of truth.** `README.md` embeds the Fact Sheet IDs and the Phase 1 mapping tables; conclusions are never stated without their IDs.
- **Handedness is anatomical, not screen-relative.** `Left` / `Right` always refer to the subject's real hands. The preview is unmirrored (raw camera frames), so a hand on the left side of the screen is usually the user's right hand and is labelled `Right` — this is expected.
- **Canvas size has one owner.** Only `main.ts` → `syncCanvasSizes()` computes pixel dimensions; it calls the hand layer first, then the pose layer. Renderers never read `video.videoWidth/videoHeight`.

---

## 4. Fact Sheet summary (IDs kept)

- **A1–A6** — The reference site is a Next.js page embedding a Vite SPA; single bundle 389,395 B; pure front-end; no source map; deps `tasks-vision 0.10.14` + `Tone.js 15.1.22`; assets served from jsDelivr / Google Storage. This project self-hosts everything.
- **B1–B7** — `HandLandmarker`, `runningMode: "VIDEO"`, `numHands: 2`, GPU; library-default confidences 0.5; float16 model; palm detector 192×192, landmark model 224×224; fixed 21-point indexing; normalized `lm` + metric `world`.
- **C1–C12** — Reference-site gesture rules: `tip.y < pip.y`; thumb press via `lm[4].x` vs `lm[3].x`; major/minor via `lm[9].x` vs `lm[0].x`; degrees/quality by extended-finger counts; pitch-shift thresholds 0.5/0.8; tilt threshold 0.12; 100 ms stabilisation + 50 ms hold; 12-key × 7-degree chord table; semitone offsets `{1:0,2:2,3:4,4:5,5:7,6:9,7:-1}`; seventh-chord voicings; `369.99/392/415.3 Hz` halved.
- **E1–E7** — Low-pass 1200 Hz / Q 0.7 audio chain; five timbres; C3–G5 samples with 1 s release; one-hand mode at fixed volume 0.2; 7-step tutorial; mirrored rendering handled inside the canvas.
- **F1–F3** — Microsoft Clarity custom events plus Vercel Analytics on the wrapper page; no other third parties.
- **G1–G3.3** — The reference site **never used a pose model** (its only `.task` is the hand model); G2 holds; G3.1 each task holds its own wasm instance and graphics context (memory delta unmeasured); G3.2 pose selection/scheduling has no reverse-engineered basis; G3.3 multi-person policy has none either.

---

## 5. Phase 1 mapping

### 5.1 Hand-side changes

| File | Change | Basis |
| --- | --- | --- |
| `render/overlay.ts` | Rebuilt against the original interface (`constructor(canvas)`, `resize(w,h)`, unchanged `draw`) | R1 |
| `vision/handTracker.ts` | No change | R1 |
| `gestures/fingers.ts` | No change | R1 |
| `gestures/engine.ts` | No change | R1 |
| `vision/landmarks.ts` | No change (append-only) | R1 |
| `core/bus.ts` | Appended `pose:raw` and `hand:relation` to `EventMap` | R1 / D5 |

### 5.2 Pose-side decisions (D1–D8)

- **D1** — Two models (`HandLandmarker` + `PoseLandmarker` lite); no `HolisticLandmarker`; `numPoses: 1`; `outputSegmentationMasks: false`; most salient person wins; `hands:raw` still emits up to two hands.
- **D2** — No cascade; each model runs on the full frame.
- **D3** — Pose constants isolated in `poseLandmarks.ts` (33 points, 35 connections); hand modules never import pose modules.
- **D4** — Same-frame `lm` is directly comparable; distances are converted to pixels or aspect-corrected; never subtract `world` across models; cross-model distances are normalised by shoulder width.
- **D5** — One rVFC loop, one timestamp, hand first then pose, pose on a stride; `pose:raw` and `hand:relation` only on pose frames; relation uses the same frame's hands; wrist match threshold 0.6 × shoulder width.
- **D6** — Initial stride 3; adaptation watches only the rolling p50 of hand inference time (raise above 20 ms for 1 s, lower below 14 ms for 3 s, floor 3; stride 2 only when p50 < 12 ms and overall fps > 50 for 3 s); at stride 6 with fps still below 20, pose inference stops to protect the hand pipeline. Baseline: p50 hand 16.8 / pose 8.6 / combined 24.7 ms; p95 34.2 / 17.3 / 49.8 ms; stride 2 would add 25.6 % (over budget), stride 3 adds 17.0 % (p50) and 16.7 % (p95).
- **D7** — Separate `poseOverlay` canvas below the hand canvas. The **body toggle controls both pose inference and drawing** (off stops inference, clears `lastPose`, emits neither `pose:raw` nor `hand:relation`). The **hand toggle only controls drawing**. The asymmetry is deliberate.
- **D8** — `Left`/`Right` are anatomical; `side` is measured from the shoulder midpoint (`palm.x < center.x` → `right` when facing the camera); `|dx| < 0.5 × shoulder width` → `front`; height zones use nose / shoulders / hips.

---

## 6. Events and API

The bus is a singleton:

```ts
import { bus } from "./core/bus";
```

### `hands:raw` — every frame

```ts
import type { DetectedHand } from "./vision/landmarks";

bus.on("hands:raw", (hands: DetectedHand[]) => {
  for (const hand of hands) {
    // hand.handedness: "Left" | "Right" (anatomical)
    // hand.score, hand.lm[21], hand.world[21]
  }
});
```

### `gesture` — debounced gesture name

```ts
bus.on("gesture", ({ hand, name, fingers, palm }) => {
  // name: "fist" | "open_palm" | "pinch" | "point" | "peace" | "unknown"
  // fingers: { thumb, index, middle, ring, pinky } — booleans
  // palm: normalised palm centre
  if (hand === "Right" && name === "pinch") {
    // your logic
  }
});
```

Emitted only after the same classification holds for 5 consecutive frames; it does not repeat every frame.

### `pose:raw` — pose frames only

```ts
import type { DetectedPose } from "./vision/poseLandmarks";

bus.on("pose:raw", (pose: DetectedPose | null) => {
  if (!pose) return; // pose frame, but no person
  // pose.score: mean visibility of the 33 points (not the same metric as hand score)
  // pose.lm[33], pose.world[33]
});
```

Not emitted every frame: with the initial stride 3 it fires on updates 3, 6, 9, … . Turning the body toggle off stops pose inference and therefore this event.

### `hand:relation` — pose frames with a matched hand

```ts
bus.on("hand:relation", ({ hand, side, heightZone, distance }) => {
  // hand: "Left" | "Right"
  // side: "left" | "right" | "front"
  // heightZone: "head" | "torso" | "below"
  // distance: palm-to-shoulder-midpoint distance, in shoulder widths
});
```

Emitted only on pose frames, and only when a hand wrist is within 0.6 × shoulder width of a pose wrist. Unmatched hands remain in `hands:raw` and produce no relation. Turning the body toggle off stops this event too.

### Timing

| Event | Frequency |
| --- | --- |
| `hands:raw` | every frame |
| `gesture` | on stable change (5-frame debounce) |
| `pose:raw` | pose frames only (stride 3 by default) |
| `hand:relation` | pose frames only, matched hands only |

---

## 7. Adding a gesture

Example: `gun` (thumb + index extended).

1. **`src/gestures/fingers.ts`** — put thresholds in `FINGER_CONFIG`; use `FINGER_JOINTS` + `angleAt`; never hard-code landmark indices. Add a pure helper if a new finger combination is needed.
2. **`src/gestures/engine.ts`** — add `"gun"` to the `GestureName` union and a branch in `classify()` (mind the precedence: `open_palm` → `pinch` → `point` → `peace` → `fist` → `unknown`):

```ts
if (fingers.thumb && fingers.index && !fingers.middle && !fingers.ring && !fingers.pinky) {
  return "gun";
}
```

The debounce is `GESTURE_DEBOUNCE_FRAMES` (5). No changes are needed in `main.ts`, `overlay.ts` or `panel.ts` — they only consume strings.

Verify by holding the gesture for at least 5 frames: exactly one `gesture` event should appear, and the state clears when the hand leaves.

---

## 8. Data flow

```text
camera → video → scheduler.update(video, ts, w, h)
                    ├─ handTracker.detect() → bus("hands:raw")
                    ├─ [stride hit] poseTracker.detect() → bus("pose:raw")
                    └─ [stride hit && person] computeRelation() → bus("hand:relation")
                 → FrameResult → handOverlay / poseOverlay / panel
```

- `main.ts` owns the lifecycle and draws from `FrameResult`; all emits happen inside the scheduler.
- `syncCanvasSizes()` is the only place that computes canvas dimensions.
- Both trackers share one timestamp; each tracker enforces strict monotonicity and de-duplicates identical video frames.

---

## 9. Acceptance and open items

### Real-device checklist (all passed on 2026-10-22)

1. **Skeleton alignment** — skeletons coincide with the hand's pixel position; labels are anatomical.
2. **Two hands** — panel shows both `[Left]` and `[Right]`, with correct gestures.
3. **Relation** — above the nose → `head`; shoulder height → `torso`; below hips → `below`; in front of the chest → `front`.
4. **Toggles** — hand toggle affects drawing only; body toggle controls inference and drawing (`[pose]` stops when off).
5. **Offline** — works with external network disabled and the local server running; no external requests.
6. **Hand leaves** — skeleton and label disappear; panel shows "没有检测到手".
7. **Person leaves** — pose skeleton disappears; after 2 s the panel shows "姿态已关闭或无数据".

### Still open

- [ ] Real GPU-fault verification of `poseTracker`'s runtime GPU→CPU fallback (injection-tested only).
- [ ] Byte-level baseline of `bus.ts` cannot be proven (append completed, only 4 added lines, semantics verified; differences could only be comments/blank lines).
- [ ] 300-frame real-device p50/p95 capture to replace the headless absolute numbers in D6.

---

## 10. Documentation map

- `docs/fact-sheet.md` — canonical facts (A1–G3.3), decisions (D1–D8), rules (R1–R2), D6 benchmark.
- `docs/phase1-mapping.md` — Phase 1 Table 1 / Table 2, commitments, Phase 3 todos.
- `README.md` — canonical Chinese README (authoritative when this translation disagrees).

> Third-party components and licenses: see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

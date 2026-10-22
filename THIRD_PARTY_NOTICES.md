# Third-Party Notices

This project redistributes the following third-party components.
They are **not** covered by this project's own license (see `LICENSE`).

## Google MediaPipe

- Component: `@mediapipe/tasks-vision`
- Version: 0.10.14
- License: Apache License 2.0
- Upstream: <https://github.com/google-ai-edge/mediapipe>
- Model source: <https://storage.googleapis.com/mediapipe-models/>
- Modifications: none — all files below are redistributed unmodified.

Files redistributed in this repository:

| File | Description |
| --- | --- |
| `public/mediapipe/wasm/vision_wasm_internal.js` | SIMD wasm loader |
| `public/mediapipe/wasm/vision_wasm_internal.wasm` | SIMD runtime |
| `public/mediapipe/wasm/vision_wasm_nosimd_internal.js` | non-SIMD loader |
| `public/mediapipe/wasm/vision_wasm_nosimd_internal.wasm` | non-SIMD runtime |
| `public/models/hand_landmarker.task` | hand_landmarker float16 v1 |
| `public/models/pose_landmarker_lite.task` | pose_landmarker_lite float16 v1 |

The full Apache License 2.0 text is included at [`LICENSES/Apache-2.0.txt`](LICENSES/Apache-2.0.txt).

## Build-time dependencies (not redistributed)

| Package | License |
| --- | --- |
| `vite` | MIT |
| `typescript` | Apache-2.0 |

These are development-only and are excluded from the repository via `.gitignore`
(`node_modules/` is not committed).

## Trademarks

MediaPipe is a trademark of Google LLC. This project is not affiliated with,
sponsored by, or endorsed by Google.

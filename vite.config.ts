import { defineConfig } from "vite";

// 纯前端、零外部运行时依赖。模型与 wasm 全部位于 public/，由 Vite 原样拷贝。
export default defineConfig({
  server: {
    // 摄像头需要安全上下文：localhost 满足要求；局域网调试请自行配置 https。
    host: true,
  },
});

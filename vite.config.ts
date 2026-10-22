import { defineConfig } from "vite";

const REPO_NAME = "DualSkeleton";

// GitHub Actions 构建时使用项目页子路径；本地 dev / preview 仍使用根路径。
const isGitHubActions = Boolean(
  (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env
    ?.GITHUB_ACTIONS,
);

// 纯前端、零外部运行时依赖。模型与 wasm 全部位于 public/，由 Vite 原样拷贝。
export default defineConfig({
  base: isGitHubActions ? `/${REPO_NAME}/` : "/",
  server: {
    // 摄像头需要安全上下文：localhost 满足要求；局域网调试请自行配置 https。
    host: true,
  },
});

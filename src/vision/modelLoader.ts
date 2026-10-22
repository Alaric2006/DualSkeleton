/**
 * 数据流位置：推理层的公共前置步骤，被 handTracker / poseTracker 共用。
 *
 * 为什么不直接把 URL 交给 MediaPipe：
 * MediaPipe 内部自行下载模型，进度不可见，在移动端网络或 WebKit 上卡住时
 * 页面只能停在「加载模型…」。这里改为显式下载并回调进度，再用 modelAssetBuffer
 * 交给 MediaPipe，整个过程可观测、可超时。
 */

export type DownloadProgress = (loadedBytes: number, totalBytes: number) => void;

/** 多久收不到任何数据就判定为下载停滞。 */
const STALL_TIMEOUT_MS = 20000;

/**
 * 给任意 Promise 加超时；用于 MediaPipe 在 WebKit 上既不 resolve 也不 reject 的情况。
 */
export function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/**
 * 下载模型并返回完整字节。
 * @param url 模型地址（自托管，随 BASE_URL 解析）
 * @param onProgress 每次收到数据块时回调；totalBytes 为 0 表示服务端未给出长度
 */
export async function downloadModel(
  url: string,
  onProgress?: DownloadProgress,
): Promise<Uint8Array> {
  const controller = new AbortController();
  let stallTimer: ReturnType<typeof setTimeout> | undefined;

  // 每次收到数据就重置计时；长时间零字节说明连接已经死掉，主动中断。
  const armStallTimer = (): void => {
    if (stallTimer !== undefined) clearTimeout(stallTimer);
    stallTimer = setTimeout(() => controller.abort(), STALL_TIMEOUT_MS);
  };

  try {
    armStallTimer();
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) {
      throw new Error(`模型下载失败：HTTP ${response.status}`);
    }

    const totalBytes = Number(response.headers.get("content-length") ?? 0);

    if (!response.body) {
      armStallTimer();
      const buffer = new Uint8Array(await response.arrayBuffer());
      onProgress?.(buffer.byteLength, buffer.byteLength);
      return buffer;
    }

    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let received = 0;

    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      armStallTimer();
      if (!value) continue;
      chunks.push(value);
      received += value.byteLength;
      onProgress?.(received, totalBytes);
    }

    const bytes = new Uint8Array(received);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return bytes;
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error(`模型下载停滞：${STALL_TIMEOUT_MS / 1000} 秒内没有收到数据`);
    }
    throw error;
  } finally {
    if (stallTimer !== undefined) clearTimeout(stallTimer);
  }
}

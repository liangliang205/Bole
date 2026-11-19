export class ApiError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

/**
 * 统一的 JSON 请求封装。非 2xx、或响应体 `ok === false` 都抛 ApiError。
 * SSE 不走这里（用 EventSource）。
 */
export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(path, {
    headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
    ...init,
  });
  const text = await response.text();
  let payload: unknown = null;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = null;
    }
  }
  if (!response.ok) {
    const message = payload && typeof payload === 'object' && 'error' in payload
      ? String((payload as { error: unknown }).error)
      : `请求失败（HTTP ${response.status}）`;
    throw new ApiError(message, response.status);
  }
  if (payload && typeof payload === 'object' && 'ok' in payload && (payload as { ok: unknown }).ok === false) {
    const message = 'error' in payload ? String((payload as { error: unknown }).error) : '请求失败';
    throw new ApiError(message, response.status);
  }
  return payload as T;
}

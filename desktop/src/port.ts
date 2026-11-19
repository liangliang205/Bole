/** 端口选择：preferred → 默认端口 → 扫描区间，返回第一个空闲端口。 */
export interface PortChoice {
  port: number;
  reused: boolean;
}

export async function choosePort(input: {
  preferred?: number | null;
  defaultPort?: number;
  scanFrom?: number;
  scanTo?: number;
  isFree: (port: number) => Promise<boolean>;
}): Promise<PortChoice> {
  const defaultPort = input.defaultPort ?? 8787;
  const scanFrom = input.scanFrom ?? 8788;
  const scanTo = input.scanTo ?? 8900;

  if (input.preferred && await input.isFree(input.preferred)) {
    return { port: input.preferred, reused: true };
  }
  if (await input.isFree(defaultPort)) {
    return { port: defaultPort, reused: false };
  }
  for (let port = scanFrom; port <= scanTo; port += 1) {
    if (await input.isFree(port)) return { port, reused: false };
  }
  throw new Error('所有候选端口都被占用');
}

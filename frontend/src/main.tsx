import { StrictMode } from 'react';
import type { ReactElement } from 'react';
import { createRoot } from 'react-dom/client';

/**
 * 迁移占位：F0 只验证构建链路与对照工具。
 * 真正的布局壳在 F1（Task F1 Step 1 起）落地。
 */
function App(): ReactElement {
  return (
    <div id="root-placeholder" style={{ padding: 24, fontFamily: 'system-ui, sans-serif' }}>
      <h1>React 迁移占位</h1>
      <p>见实施计划 Task F1：布局壳、会话列表、新建会话页。</p>
    </div>
  );
}

const host = document.getElementById('root');
if (!host) throw new Error('缺少 #root 容器');
createRoot(host).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

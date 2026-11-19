import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { App } from './App.tsx';
import { applyTheme, storedTheme } from './theme.ts';
import './styles/tokens.css';
import './styles/base.css';
import './styles/layout.css';
import './styles/chat.css';
import './styles/panels.css';
import './styles/settings.css';
import './styles/modals.css';

applyTheme(storedTheme(), false);

const queryClient = new QueryClient({
  defaultOptions: { queries: { refetchOnWindowFocus: false, retry: 0 } },
});

const host = document.getElementById('root');
if (!host) throw new Error('缺少 #root 容器');

createRoot(host).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  </StrictMode>,
);

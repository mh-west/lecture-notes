import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.tsx';
import './index.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

// Ask the browser not to evict our notes/recordings under storage pressure.
navigator.storage?.persist?.();

if (import.meta.env.DEV) {
  // Handy for poking at state from devtools / test scripts.
  import('./store').then(({ useStore }) => ((window as unknown as { __store: unknown }).__store = useStore));
}

import React from 'react';
import ReactDOM from 'react-dom/client';
import '@fontsource-variable/inter';
// Bots (Sidebar v3): a friendlier face, larger at the same size.
import '@fontsource-variable/figtree';
import App from './App';
import { AppErrorBoundary } from './app/AppErrorBoundary';
import './index.css';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <AppErrorBoundary>
      <App />
    </AppErrorBoundary>
  </React.StrictMode>
);

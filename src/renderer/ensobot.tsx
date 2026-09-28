import * as React from 'react';
import { createRoot } from 'react-dom/client';
import { EnsobotShell } from '@/components/ensobot/EnsobotShell';
import './styles/globals.css';

createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <EnsobotShell />
  </React.StrictMode>
);

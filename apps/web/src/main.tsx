import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './desk-bridge-bootstrap';
// Design-system tokens (CSS custom properties + Material Symbols font) must load
// once, before app styles, so component vars resolve. There is no ThemeProvider;
// dark mode is opt-in via data-theme="dark" on an ancestor.
import '@schnsrw/design-system/tokens.css';
import './styles.css';
import { App } from './App';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

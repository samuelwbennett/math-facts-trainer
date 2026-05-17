import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.jsx'
import { consumeSessionFragment } from './sessionBridge.js'

// Silent cross-app sign-in: if the user landed here from the VPA
// orchestration layer's "Start Now" button, consume the
// #vpa_session= fragment + set the Supabase session BEFORE React
// mounts so the first render is already signed-in.
async function boot() {
  await consumeSessionFragment();
  createRoot(document.getElementById('root')).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}

boot();

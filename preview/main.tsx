import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import App from '../src/App'
import { AuthProvider } from '../src/context/AuthContext'
import '../src/index.css'

// Isolated from the production entry (src/main.tsx). The rust bar labels
// every screenshot as local example data. It is solid colour, not a blur.
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <div
      style={{
        background: '#3d1a10',
        color: '#fff',
        font: '600 12px/1.4 "Noto Sans Myanmar", system-ui, sans-serif',
        padding: '6px 12px',
        textAlign: 'center',
      }}
    >
      LOCAL EXAMPLE · ဥပမာဒေတာ — production မဟုတ်ပါ
    </div>
    <BrowserRouter>
      <AuthProvider>
        <App />
      </AuthProvider>
    </BrowserRouter>
  </StrictMode>,
)

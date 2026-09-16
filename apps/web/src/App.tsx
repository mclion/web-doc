import { BrowserRouter, Route, Routes } from 'react-router-dom'
import { TooltipProvider } from '@/components/ui/tooltip'
import HomePage from '@/pages/HomePage'
import SharePage from '@/pages/SharePage'
import AdminPage from '@/pages/AdminPage'

// Keep in sync with the Vite build base so the router recognizes prefixed URLs like `/doc/...`.
const ROUTER_BASENAME = (import.meta.env.BASE_URL || '/').replace(/\/+$/, '') || '/'

export default function App() {
  return (
    <TooltipProvider delayDuration={200}>
      <BrowserRouter basename={ROUTER_BASENAME}>
        <Routes>
          <Route path="/" element={<HomePage />} />
          <Route path="/v/:docId" element={<HomePage />} />
          <Route path="/s/:token" element={<SharePage />} />
          <Route path="/admin" element={<AdminPage />} />
        </Routes>
      </BrowserRouter>
    </TooltipProvider>
  )
}

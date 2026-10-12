import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
// Carlito is metric-compatible with Calibri (the usual Visio font), so text wraps
// the same way even on machines without Office. Used after the file's own font.
import '@fontsource/carlito/400.css'
import '@fontsource/carlito/400-italic.css'
import '@fontsource/carlito/700.css'
import '@fontsource/carlito/700-italic.css'
import './index.css'
import App from './App.tsx'

// Text is measured on a canvas to wrap lines, so web fonts must be ready before
// the first render. Don't wait forever if the network is slow.
const fontsReady = Promise.race([
  Promise.all(
    ['normal', 'italic'].flatMap((style) =>
      [400, 700].map((weight) => document.fonts.load(`${style} ${weight} 16px Carlito`, 'Aa')),
    ),
  ).catch(() => undefined),
  new Promise((resolve) => setTimeout(resolve, 2000)),
])

fontsReady.then(() => {
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  )
})

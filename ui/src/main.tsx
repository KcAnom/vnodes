import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { Shell } from './shell/Shell'
import './theme.css'

const root = document.getElementById('root')
if (!root) throw new Error('vnodes ui: no #root to mount into')

// The map used to be the application. It is now one of five views the shell
// routes between, which is why this mounts the shell rather than the canvas.
createRoot(root).render(
  <StrictMode>
    <Shell />
  </StrictMode>,
)

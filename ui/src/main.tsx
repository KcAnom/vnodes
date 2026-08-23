import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './map/App'
import './theme.css'

const root = document.getElementById('root')
if (!root) throw new Error('vnodes map: no #root to mount into')

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
)

import { render } from 'preact'
import { App } from './app.tsx'
import { initTheme } from './theme.ts'
import './styles.css'

initTheme()
render(<App />, document.getElementById('app')!)

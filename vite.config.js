import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// On GitHub Pages this app is served from
// https://<user>.github.io/autorange-lp-vs-hodl-dashboard/, so assets must
// resolve relative to that subpath.
const REPO_BASE = '/autorange-lp-vs-hodl-dashboard/'

export default defineConfig(({ command }) => ({
  plugins: [react()],
  base: command === 'build' ? REPO_BASE : '/',
  server: { port: 3000 },
}))

import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  // GitHub Pages project site:
  // https://monapdx.github.io/folder-structure-generator/
  base: '/folder-structure-generator/',
  plugins: [react()],
})

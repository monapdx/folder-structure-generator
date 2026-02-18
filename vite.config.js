import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// GitHub Pages project site URL:
// https://monapdx.github.io/folder-structure-generator/
export default defineConfig({
  base: '/folder-structure-generator/',
  plugins: [react()],
})

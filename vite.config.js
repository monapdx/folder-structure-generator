import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  base: '/folder-structure-generator/',

  plugins: [react()],

  build: {
    outDir: 'dist',
    sourcemap: false,
  },

  server: {
    port: 5173,
    open: true,
  },
})

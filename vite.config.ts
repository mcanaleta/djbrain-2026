import { resolve } from 'path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  root: 'src/web',
  plugins: [react()],
  server: {
    port: 5178,
    proxy: {
      '/api': 'http://localhost:5179'
    }
  },
  preview: {
    port: 4178
  },
  build: {
    outDir: '../../dist',
    emptyOutDir: true
  },
  resolve: {
    alias: {
      '@web': resolve(__dirname, 'src/web/src')
    }
  }
})

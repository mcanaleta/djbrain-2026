import { resolve } from 'path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  root: 'src/web',
  plugins: [react()],
  server: {
    port: 5180,
    strictPort: true,
    proxy: {
      '/api': 'http://localhost:5181'
    }
  },
  preview: {
    port: 5182
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

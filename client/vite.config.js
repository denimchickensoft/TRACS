import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

const __dirname = dirname(fileURLToPath(import.meta.url))

const backendPort = process.env.BACKEND_PORT ?? 8722

export default defineConfig({
  plugins: [react()],
  build: {
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html'),
      },
    },
  },
  server: {
    proxy: {
      '/api':  `http://localhost:${backendPort}`,
      '/docs': `http://localhost:${backendPort}`,
      '/ws': {
        target: `ws://localhost:${backendPort}`,
        ws: true,
      },
      '/signal': {
        target: `ws://localhost:${backendPort}`,
        ws: true,
      },
    },
  },
})

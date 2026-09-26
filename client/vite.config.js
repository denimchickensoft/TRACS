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
    // 127.0.0.1, not localhost: the backend binds IPv4 loopback only, and
    // "localhost" can resolve to ::1 first.
    proxy: {
      '/api':  `http://127.0.0.1:${backendPort}`,
      '/docs': `http://127.0.0.1:${backendPort}`,
      '/ws': {
        target: `ws://127.0.0.1:${backendPort}`,
        ws: true,
      },
      '/signal': {
        target: `ws://127.0.0.1:${backendPort}`,
        ws: true,
      },
    },
  },
})

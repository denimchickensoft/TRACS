import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

const __dirname = dirname(fileURLToPath(import.meta.url))

// Not 8722: that's the desktop app's port, and the two often run side by side.
const backendPort = process.env.BACKEND_PORT ?? 8721

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
    // "localhost" can resolve to ::1 first. changeOrigin: false keeps the
    // browser's Host header, which the backend's same-origin guard compares
    // with Origin; the string shorthand would rewrite it to the target.
    proxy: {
      '/api': {
        target: `http://127.0.0.1:${backendPort}`,
        changeOrigin: false,
      },
      '/docs': {
        target: `http://127.0.0.1:${backendPort}`,
        changeOrigin: false,
      },
      '/ws': {
        target: `ws://127.0.0.1:${backendPort}`,
        ws: true,
        changeOrigin: false,
      },
      '/signal': {
        target: `ws://127.0.0.1:${backendPort}`,
        ws: true,
        changeOrigin: false,
      },
    },
  },
})

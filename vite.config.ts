import { defineConfig } from 'vite'

export default defineConfig({
  root: 'site',
  publicDir: '../public',
  server: {
    host: '127.0.0.1',
    port: 8788,
    proxy: {
      '/v1': 'http://127.0.0.1:8787',
      '/health': 'http://127.0.0.1:8787',
    },
  },
  build: {
    outDir: '../dist',
    emptyOutDir: true,
  },
})

import { defineConfig } from 'vite'

export default defineConfig({
  root: 'site',
  publicDir: '../public',
  build: {
    outDir: '../dist',
    emptyOutDir: true,
  },
})

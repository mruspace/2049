import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  build: {
    target: 'es2022',
    assetsInlineLimit: 0, // never inline binary catalogue data
    rollupOptions: {
      output: {
        manualChunks: {
          three: ['three/webgpu', 'three/tsl'],
          ephem: ['astronomy-engine'],
        },
      },
    },
  },
  worker: { format: 'es' },
  server: { host: true },
  // stars.bin and the KTX2 transcoder are served from public/ untouched.
})

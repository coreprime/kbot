import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  base: './',
  server: {
    proxy: {
      '/api': {
        target: 'http://localhost:8000',
        ws: true,
      },
      '/raw': 'http://localhost:8000',
      '/gif': 'http://localhost:8000',
      '/png': 'http://localhost:8000',
      '/apng': 'http://localhost:8000',
      '/pcx': 'http://localhost:8000',
      '/video': 'http://localhost:8000',
      '/zrb-thumb': 'http://localhost:8000',
      '/fnt-sheet': 'http://localhost:8000',
      '/fnt-preview': 'http://localhost:8000',
      '/tnt-tile': 'http://localhost:8000',
      '/tnt-tilemap': 'http://localhost:8000',
      '/tnt-minimap': 'http://localhost:8000',
      '/tnt-heightmap': 'http://localhost:8000',
      '/sct-tile': 'http://localhost:8000',
      '/sct-tilemap': 'http://localhost:8000',
      '/sct-heightmap': 'http://localhost:8000',
      '/sct-minimap': 'http://localhost:8000',
      '/cache-stats': 'http://localhost:8000',
    },
  },
})

import { defineConfig } from 'vite'

export default defineConfig({
  server: {
    // The Runway page asks the Python backend (Backend/server.py) for shows.
    proxy: { '/api': 'http://127.0.0.1:8000' },
  },
  build: {
    rollupOptions: {
      input: ['index.html', 'runway.html', 'art-studio.html', 'whiteboard.html'],
    },
  },
})

import { defineConfig, loadEnv } from 'vite'

export default defineConfig(({ mode }) => {
  // One settings file for the whole site: Backend/.env (or the build machine's
  // environment). Only the two public Supabase values are handed to the web
  // pages, so a secret key added to .env later can never end up in them.
  const env = { ...loadEnv(mode, '../Backend', ''), ...process.env }
  const supabaseUrl = env.SUPABASE_URL || ''
  const supabaseKey = env.SUPABASE_PUBLISHABLE_KEY || ''
  if (!supabaseUrl || !supabaseKey) {
    console.warn('\n⚠ SUPABASE_URL / SUPABASE_PUBLISHABLE_KEY are not set: the site builds, but nobody can sign in.\n')
  }
  if (/^sb_secret_|service_role/.test(supabaseKey)) {
    throw new Error('SUPABASE_PUBLISHABLE_KEY holds a secret key. Use the publishable (sb_publishable_…) key.')
  }

  return {
    define: {
      __SUPABASE_URL__: JSON.stringify(supabaseUrl),
      __SUPABASE_PUBLISHABLE_KEY__: JSON.stringify(supabaseKey),
    },
    server: {
      // The Runway page asks the Python backend (Backend/server.py) for shows.
      proxy: { '/api': 'http://127.0.0.1:8000' },
    },
    build: {
      rollupOptions: {
        input: ['index.html', 'runway.html', 'art-studio.html', 'whiteboard.html', 'login.html'],
      },
    },
  }
})

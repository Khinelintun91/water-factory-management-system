import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// Screenshot server only. `npm run dev` and `npm run build` keep using
// the root vite.config.ts, which still boots src/main.tsx and the real
// Supabase client. This config swaps the client and the entry.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const realSupabase = path.join(root, 'src/lib/supabase')
const mockSupabase = path.join(root, 'preview/mockSupabase.ts')

function previewEntry(): Plugin {
  return {
    name: 'preview-entry',
    enforce: 'pre',
    resolveId(source, importer) {
      if (!importer || source.startsWith('\0')) return null
      const abs = path.resolve(path.dirname(importer), source).replace(/\.tsx?$/, '')
      if (abs === realSupabase) return mockSupabase
      return null
    },
    transformIndexHtml(html) {
      return html.replace('/src/main.tsx', '/preview/main.tsx')
    },
  }
}

export default defineConfig({
  root,
  plugins: [react(), tailwindcss(), previewEntry()],
  server: {
    host: '127.0.0.1',
    port: 5174,
    strictPort: true,
  },
})

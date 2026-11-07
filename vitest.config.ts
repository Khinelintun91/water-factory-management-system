import { defineConfig } from 'vitest/config'

// Unit tests for pure client logic (tests/unit/). The dummy Supabase
// env values exist only so src/lib/supabase.ts can construct its
// client at import time — no test talks to a network or a database
// (the SQL suite in tests/sql/ covers the database rules).
export default defineConfig({
  test: {
    include: ['tests/unit/**/*.test.ts'],
    environment: 'node',
    env: {
      VITE_SUPABASE_URL: 'https://example.supabase.co',
      VITE_SUPABASE_PUBLISHABLE_KEY: 'test-publishable-key',
    },
  },
})

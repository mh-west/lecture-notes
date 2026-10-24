import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  // Maps aren't shipped to the device but let us decode stack traces from its log.
  build: { sourcemap: 'hidden' },
})

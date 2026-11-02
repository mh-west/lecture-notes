import react from '@vitejs/plugin-react'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { defineConfig, type Plugin } from 'vite'

// pdf.js loads extra data on demand: character maps for CJK fonts (Korean lecture PDFs), the 14
// standard fonts, and decoders for some image types. Serve them in dev and ship them under /pdfjs/.
const PDFJS = 'node_modules/pdfjs-dist'
const PDFJS_DIRS = ['cmaps', 'standard_fonts', 'wasm']
function pdfjsData(): Plugin {
  return {
    name: 'pdfjs-data',
    configureServer(server) {
      server.middlewares.use('/pdfjs/', (req, res, next) => {
        const path = decodeURIComponent((req.url ?? '').split('?')[0]).replace(/^\/+/, '')
        if (!PDFJS_DIRS.includes(path.split('/')[0]) || path.includes('..')) return next()
        try {
          res.end(readFileSync(join(PDFJS, path)))
        } catch {
          next()
        }
      })
    },
    generateBundle() {
      for (const dir of PDFJS_DIRS) {
        for (const f of readdirSync(join(PDFJS, dir))) {
          this.emitFile({ type: 'asset', fileName: `pdfjs/${dir}/${f}`, source: readFileSync(join(PDFJS, dir, f)) })
        }
      }
    },
  }
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), pdfjsData()],
  // Maps aren't shipped to the device but let us decode stack traces from its log.
  build: { sourcemap: 'hidden' },
})

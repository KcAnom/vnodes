import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

/**
 * Builds to a committed bundle under ../src/view/static.
 *
 * vnodes ships no runtime dependencies and asks nobody to run a build to use
 * it; this tree is the one place that trade is made, and it is made at author
 * time. The output filenames are fixed rather than hashed because the daemon
 * serves them from a hand-written route and a hashed name would need a manifest
 * read on every request to find.
 */
export default defineConfig({
  plugins: [react(), tailwindcss()],
  build: {
    outDir: '../src/view/static',
    emptyOutDir: true,
    // The map is one page behind a local daemon, not a site: a single file
    // loads faster than a graph of chunked imports over localhost.
    modulePreload: false,
    rollupOptions: {
      input: 'src/main.tsx',
      output: {
        entryFileNames: 'map.js',
        assetFileNames: 'map.[ext]',
        inlineDynamicImports: true,
      },
    },
  },
  server: {
    // `npm run dev` renders against a live daemon rather than a fixture, so
    // what is being looked at is the real graph of the real project.
    proxy: { '/ui': 'http://127.0.0.1:7821' },
  },
})

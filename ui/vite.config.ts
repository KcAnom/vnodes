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
    // The map is one page behind a local daemon, not a site, so there is no
    // preload graph worth emitting: everything is a same-host file read.
    modulePreload: false,
    // One stylesheet, always. The daemon serves `map.css` from a hand-written
    // route by that exact name, so a per-chunk split would emit a file nothing
    // asks for and drop half the rules on the floor.
    cssCodeSplit: false,
    rollupOptions: {
      input: 'src/main.tsx',
      output: {
        entryFileNames: 'map.js',
        assetFileNames: 'map.[ext]',
        // React Flow is roughly half the bundle and only one of five pages
        // needs it, so the map is split behind a `lazy()` and lands here as
        // `map-App.js`. The point is not load time on localhost — it is git:
        // the bundle is committed, minified JS does not delta, and before the
        // split every change to a status page rewrote React Flow into history
        // along with it. `chunkFileNames` stays fixed for the same reason
        // `entryFileNames` is: the daemon serves these by basename.
        chunkFileNames: 'map-[name].js',
      },
    },
  },
  server: {
    // `npm run dev` renders against a live daemon rather than a fixture, so
    // what is being looked at is the real graph of the real project.
    proxy: { '/ui': 'http://127.0.0.1:7821' },
  },
})

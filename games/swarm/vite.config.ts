import { defineConfig } from 'vite';

export default defineConfig({
  // Relative base so the same build drops straight into a portal's iframe
  // host, which never serves from the domain root.
  base: './',
  server: {
    host: true, // expose on the LAN so it can be opened on a real phone
    port: 5180,
  },
  build: {
    target: 'es2022',
    // Portals require self-contained builds — nothing may be fetched from a
    // CDN at runtime. Keeping assets inlined/bundled also cuts round trips,
    // which is the whole ballgame for the load-to-playable target.
    assetsInlineLimit: 8192,
    rollupOptions: {
      output: {
        // Pixi in its own chunk so game-code iterations do not bust its cache.
        manualChunks: (id: string) => (id.includes('node_modules/pixi.js') ? 'pixi' : undefined),
      },
    },
  },
});

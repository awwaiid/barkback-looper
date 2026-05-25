import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

// When deployed to GitHub Pages the app lives at /barkback-looper/.
// Dev still serves at /. Override via PUBLIC_BASE env if hosting elsewhere.
const base = process.env.PUBLIC_BASE
  ?? (process.env.GITHUB_ACTIONS ? '/barkback-looper/' : '/');

export default defineConfig({
  base,
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['favicon.svg'],
      manifest: {
        name: 'Barkback Looper',
        short_name: 'Barkback',
        description: 'Touch-screen web looper inspired by the Boss RC-505 mk2',
        theme_color: '#0d0e12',
        background_color: '#0d0e12',
        display: 'standalone',
        orientation: 'any',
        start_url: '.',
        icons: [
          {
            src: 'icon-192.png',
            sizes: '192x192',
            type: 'image/png',
          },
          {
            src: 'icon-512.png',
            sizes: '512x512',
            type: 'image/png',
          },
          {
            src: 'icon-512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'maskable',
          },
        ],
      },
      workbox: {
        // Make sure the AudioWorklet chunk is precached for offline use.
        globPatterns: ['**/*.{js,css,html,svg,png,ico,webp,wasm}'],
        cleanupOutdatedCaches: true,
      },
    }),
  ],
});

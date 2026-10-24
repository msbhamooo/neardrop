import { defineConfig } from 'vite';
import preact from '@preact/preset-vite';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  plugins: [
    preact(),
    VitePWA({
      strategies: 'injectManifest',
      srcDir: 'src',
      filename: 'sw.ts',
      registerType: 'autoUpdate',
      injectRegister: 'script-defer',
      devOptions: { enabled: false, type: 'module' },
      includeAssets: ['icons/icon.svg'],
      manifest: {
        name: 'NearDrop — nearby file sharing',
        short_name: 'NearDrop',
        description: 'AirDrop-style peer-to-peer file sharing. Files never touch a server.',
        start_url: '/',
        scope: '/',
        display: 'standalone',
        background_color: '#0b1220',
        theme_color: '#0b1220',
        orientation: 'any',
        icons: [
          { src: 'icons/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
        share_target: {
          action: '/share-target',
          method: 'POST',
          enctype: 'multipart/form-data',
          params: {
            title: 'title',
            text: 'text',
            files: [{ name: 'files', accept: ['*/*'] }],
          },
        },
      },
      injectManifest: {
        maximumFileSizeToCacheInBytes: 5 * 1024 * 1024,
        globPatterns: ['**/*.{js,css,html,svg,png,webmanifest,woff2}'],
      },
    }),
  ],
  server: {
    port: 3000,
    host: true,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:3001',
      },
      '/ws': {
        target: 'ws://127.0.0.1:3001',
        ws: true,
      },
      '/health': {
        target: 'http://127.0.0.1:3001',
      },
    },
  },
  preview: {
    port: 3000,
    host: true,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:3001',
      },
      '/ws': {
        target: 'ws://127.0.0.1:3001',
        ws: true,
      },
      '/health': {
        target: 'http://127.0.0.1:3001',
      },
    },
  },
  build: {
    target: 'es2022',
    sourcemap: false,
  },
});

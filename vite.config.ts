import { defineConfig } from 'vite';

// The site is served from https://<user>.github.io/corvus/, so every URL is
// built from this base (import.meta.env.BASE_URL in the app).
export default defineConfig({
  base: '/corvus/',
});

import { defineConfig } from 'vite';

// GitHub Pages serves this project site from /daslides/ — set the production
// base accordingly so built asset URLs resolve. Local dev stays at root.
export default defineConfig(({ command }) => ({
  base: command === 'build' ? '/daslides/' : '/',
  server: { host: true, port: 5173 },
  build: { target: 'es2022' },
}));

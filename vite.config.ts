import { execSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { defineConfig, type Plugin } from 'vite';

/**
 * Identify the build. The commit is what actually tells you which code is live
 * — useful because this is served from a CDN behind a service worker, so "did
 * my deploy land?" is otherwise guesswork.
 */
function buildId(): string {
  try {
    const sha = execSync('git rev-parse --short HEAD', { stdio: ['ignore', 'pipe', 'ignore'] })
      .toString().trim();
    const dirty = execSync('git status --porcelain', { stdio: ['ignore', 'pipe', 'ignore'] })
      .toString().trim().length > 0;
    return dirty ? `${sha}+` : sha;
  } catch {
    return 'dev';   // not a git checkout (e.g. a source tarball)
  }
}

/**
 * Emit the service worker with its cache version and precache list filled in,
 * so the hashed filenames don't have to be maintained by hand.
 *
 * The source lives in src/ rather than public/ on purpose: a file in public/ is
 * copied verbatim, and that copy happens after plugin hooks run — patching it
 * afterwards is a race. Emitting it as a build asset is deterministic.
 */
function serviceWorker(base: string): Plugin {
  return {
    name: 'service-worker',
    apply: 'build',
    generateBundle(_options, bundle) {
      const built = Object.keys(bundle).map((f) => base + f);
      // public/ is copied as-is, so read it from disk for the icon list.
      const assets = readdirSync('public')
        .filter((f) => /\.(png|svg|webmanifest)$/.test(f))
        .map((f) => base + f);
      // index.html is emitted by Vite's own HTML plugin and isn't in `bundle`
      // here, but the offline navigation fallback needs it, so add it by name.
      const files = [...new Set([base, `${base}index.html`, ...assets, ...built])];

      // Hash the list so the cache name changes exactly when its contents do.
      let h = 0;
      for (const f of files) {
        for (let i = 0; i < f.length; i++) h = (h * 31 + f.charCodeAt(i)) | 0;
      }

      // replaceAll, not replace: these tokens are also mentioned in sw.js's own
      // doc comment, and replacing only the first occurrence left the real one.
      const source = readFileSync('src/sw.js', 'utf8')
        .replaceAll('__PRECACHE__', JSON.stringify(files))
        .replaceAll('__VERSION__', (h >>> 0).toString(36));

      this.emitFile({ type: 'asset', fileName: 'sw.js', source });
    },
  };
}

// GitHub Pages serves this project site from /daslides/ — set the production
// base accordingly so built asset URLs resolve. Local dev stays at root.
// Keyed on `mode`, not `command`: vite resolves `preview` with command 'serve',
// so keying on command served the built output at / while dist/index.html
// pointed at /daslides/, and every asset 404'd.
export default defineConfig(({ mode }) => {
  const base = mode === 'production' ? '/daslides/' : '/';
  return {
    base,
    server: { port: 5173 },
    build: { target: 'es2022' },
    define: {
      // Read package.json rather than npm_package_version, which is only set
      // when vite is launched through an npm script.
      __APP_VERSION__: JSON.stringify(
        JSON.parse(readFileSync('package.json', 'utf8')).version ?? '0.0.0',
      ),
      __BUILD_ID__: JSON.stringify(buildId()),
    },
    plugins: [serviceWorker(base)],
  };
});

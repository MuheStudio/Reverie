import { UserConfigExport, ConfigEnv, loadEnv } from 'vite';
import type { PluginOption } from 'vite';
import react from '@vitejs/plugin-react-swc';
import { resolve } from 'path';
import { visualizer } from 'rollup-plugin-visualizer';
import autoprefixer from 'autoprefixer';
import { sentryVitePlugin } from '@sentry/vite-plugin';

/** LLM config persistence plugin 閳?reads/writes config to ~/.openroom/config.json */
/**
 * Session data plugin 閳?reads/writes files under ~/.openroom/sessions/
 * API: /api/session-data?path={charId}/{modId}/chat/history.json
 * Supports GET, POST, DELETE.
 */
/** Debug log plugin 閳?writes browser logs to logs/debug-*.log */
/** LLM API proxy plugin 閳?resolves browser CORS restrictions */
/** Generic JSON file persistence plugin factory */
const config = ({ mode }: ConfigEnv): UserConfigExport => {
  const env = loadEnv(mode, process.cwd(), '');
  const isProd = env.NODE_ENV === 'production';
  const isTest = env.NODE_ENV === 'test';
  const isAnalyze = env.ANALYZE === 'analyze';
  const isElectronBuild = env.VITE_ELECTRON_BUILD === 'true';
  const sentryAuthToken = env.SENTRY_AUTH_TOKEN;
  const bizProjectName = env.BIZ_PROJECT_NAME || '';

  // Calculate asset base path
  // - Production: CDN address
  // - Test: sub-path /webuiapps/
  // - Development: /
  const getBase = () => {
    if (isElectronBuild) {
      return './';
    }
    if (isProd && env.CDN_PREFIX) {
      return env.CDN_PREFIX + '/' + bizProjectName;
    }
    if ((isTest || isProd) && bizProjectName) {
      return '/' + bizProjectName + '/';
    }
    return '/';
  };
  const plugins: PluginOption[] = [
    // Legacy OpenRoom middleware deliberately isn't mounted.  It exposed
    // unauthenticated filesystem writes, an arbitrary upstream proxy, and an
    // Agent SDK endpoint with bypassPermissions on the developer's loopback
    // interface.  DreamRoom uses the authenticated Electron/Python bridge;
    // reintroducing one of these endpoints requires a separately reviewed
    // development tool with per-launch authentication and an explicit origin
    // allowlist, not an environment switch around this implementation.
    // Reverie is an Electron desktop application. Electron 42 embeds a modern
    // Chromium runtime, so browser-legacy shims add no supported target. More
    // importantly, Vite's legacy bootstrap injects inline and data: scripts;
    // those are intentionally rejected by the production CSP. Keep one modern
    // module graph instead of weakening the renderer's security boundary.
    react(),
  ];

  /** Only import when running in analyze mode */
  if (isAnalyze) {
    plugins.push(
      // The visualizer ships Rollup 4 hook types while Vite 4 exposes Rollup 3
      // types. Runtime hooks are compatible; contain the type bridge here.
      visualizer({
        gzipSize: true,
        open: true,
        filename: `${env.APP_NAME}-chunk.html`,
      }) as unknown as PluginOption,
    );
  }

  if (isProd && sentryAuthToken) {
    plugins.push(
      sentryVitePlugin({
        authToken: sentryAuthToken,
        org: env.SENTRY_ORG || '',
        project: env.SENTRY_PROJECT || '',
        url: env.SENTRY_URL || undefined,
        sourcemaps: {
          filesToDeleteAfterUpload: ['dist/**/*.js.map'],
        },
      }),
    );
  }

  return {
    plugins,
    css: {
      postcss: {
        plugins: [autoprefixer({})],
      },
      preprocessorOptions: {
        scss: {
          silenceDeprecations: ['legacy-js-api'],
        },
      },
    },
    resolve: {
      alias: {
        '@': resolve(__dirname, './src'),
        '@gui/vibe-container': resolve(__dirname, './src/lib/vibeContainerMock.ts'),
      },
    },
    base: getBase(),
    server: {
      host: '127.0.0.1',
      port: 5173,
    },
    define: {
      __APP__: JSON.stringify(env.APP_ENVIRONMENT),
      __ROUTER_BASE__: JSON.stringify(bizProjectName ? '/' + bizProjectName : ''),
      __ENV__: JSON.stringify(env.NODE_ENV),
    },
    build: {
      outDir: 'dist',
      rollupOptions: {
        output: {
          assetFileNames: (assetInfo) => {
            if (assetInfo.name?.endsWith('.css')) {
              return 'assets/styles/[name]-[hash][extname]'; // Output to /dist/assets/styles directory
            }
            if (/\.(png|jpe?g|gif|svg)$/.test(assetInfo.name || '')) {
              return 'assets/images/[name]-[hash][extname]'; // Output to /dist/assets/images directory
            }

            if (/\.(ttf)$/.test(assetInfo.name || '')) {
              return 'assets/fonts/[name]-[hash][extname]'; // Output to /dist/assets/fonts directory
            }

            return '[name]-[hash][extname]'; // Default output for other assets
          },
        },
      },
      minify: isElectronBuild ? false : true,
      chunkSizeWarningLimit: 1500,
      cssTarget: 'chrome61',
      sourcemap: isProd || isElectronBuild,
      manifest: true,
    },
  };
};

export default config;

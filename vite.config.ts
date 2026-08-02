import { defineConfig } from "vite";
import { svelte, vitePreprocess } from "@sveltejs/vite-plugin-svelte";
import wasm from "vite-plugin-wasm";
import strip from '@rollup/plugin-strip';
import tailwindcss from '@tailwindcss/vite'
import { readFileSync } from 'fs';
import { execSync } from 'child_process';
import { createHash, randomBytes } from 'crypto';

const pkg = JSON.parse(readFileSync('./package.json', 'utf-8'));

// A fresh cryptographic build identity is embedded into the client and emitted
// beside the exact dist bundle produced by this Vite invocation. Including the
// stamp in the compiled client also makes it part of the output content.
const buildHash = createHash('sha256')
  .update(`${pkg.version}\0${Date.now()}\0${process.pid}\0`)
  .update(randomBytes(32))
  .digest('hex');
const clientBuildStamp = `${pkg.version}-${buildHash}`;
const clientBuildManifest = JSON.stringify({
  version: pkg.version,
  stamp: clientBuildStamp,
  hash: buildHash,
}, null, 2) + '\n';

const git = (() => {
  // Hosted release builds unpack a `git archive` tarball, so there is no .git
  // to probe — the builder passes the metadata it already resolved instead.
  if (process.env.APP_BRANCH) {
    return { branch: process.env.APP_BRANCH, commit: process.env.APP_COMMIT ?? '' };
  }
  try {
    return {
      branch: execSync('git rev-parse --abbrev-ref HEAD', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(),
      commit: execSync('git rev-parse --short HEAD', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(),
    };
  } catch {
    // no git available and nothing passed in — badge hides itself
    return { branch: '', commit: '' };
  }
})();

// https://vitejs.dev/config/
export default defineConfig(({command, mode}) => {
  return {
    define: {
      '__APP_VERSION__': JSON.stringify(pkg.version),
      '__APP_BRANCH__': JSON.stringify(git.branch),
      '__APP_COMMIT__': JSON.stringify(git.commit),
      '__CLIENT_BUILD_STAMP__': JSON.stringify(clientBuildStamp),
    },
    plugins: [
      {
        name: 'pocketrisu-client-build-stamp',
        apply: 'build',
        generateBundle() {
          this.emitFile({
            type: 'asset',
            fileName: 'build-stamp.json',
            source: clientBuildManifest,
          });
        },
      },
      svelte({
        preprocess: vitePreprocess(),
        onwarn: (warning, handler) => {
          // disable a11y warnings
          if (warning.code.startsWith("a11y-")) return;
          handler(warning);
        },
      }),
      tailwindcss(),
      wasm(),
      command === 'build' ? strip({
        include: '**/*.(mjs|js|svelte|ts)',
        functions: ['console.log', 'console.debug', 'console.table', 'assert.*'],
      }) : null
    ],

    // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
    // prevent vite from obscuring rust errors
    clearScreen: false,
    // tauri expects a fixed port, fail if that port is not available
    server: {
      host: '0.0.0.0', // listen on all addresses
      port: 5174,
      strictPort: true,
      // hmr: false,
    },
    // to make use of `TAURI_ENV_DEBUG` and other env variables
    // https://v2.tauri.app/reference/environment-variables/
    envPrefix: ["VITE_", "TAURI_"],
    build: {
      target:'baseline-widely-available',
      // don't minify for debug builds
      minify: process.env.TAURI_ENV_DEBUG === 'true' ? false : 'oxc',
      // produce sourcemaps for debug builds
      sourcemap: process.env.TAURI_ENV_DEBUG === 'true',
      chunkSizeWarningLimit: 2000,
    },
    
    optimizeDeps:{
      exclude: [
        "@browsermt/bergamot-translator"
      ],
      needsInterop:[
        "@mlc-ai/web-tokenizers"
      ]
    },

    resolve:{
      alias:{
        'src':'/src',
        '$lib':'/src/lib',
      }
    },
    worker: {
      format: 'es'
    }
}
});

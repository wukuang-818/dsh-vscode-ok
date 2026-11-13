import esbuild from 'esbuild';
import { copyFileSync, mkdirSync } from 'node:fs';

const watch = process.argv.includes('--watch');
const dev = watch || process.argv.includes('--dev');

mkdirSync('dist', { recursive: true });
mkdirSync('dist/webview', { recursive: true });

const shared = {
  bundle: true,
  sourcemap: dev ? 'inline' : false,
  minify: !dev,
  logLevel: 'info',
  legalComments: 'none',
  define: {
    'process.env.NODE_ENV': JSON.stringify(dev ? 'development' : 'production'),
  },
};

/** @type {import('esbuild').BuildOptions} */
const host = {
  ...shared,
  entryPoints: ['src/extension.ts'],
  outfile: 'dist/extension.js',
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  external: ['vscode'],
};

/** @type {import('esbuild').BuildOptions} */
const webview = {
  ...shared,
  entryPoints: ['src/webview/main.tsx'],
  outfile: 'dist/webview/main.js',
  platform: 'browser',
  format: 'iife',
  target: 'es2022',
};

const contexts = await Promise.all([esbuild.context(host), esbuild.context(webview)]);
if (watch) {
  await Promise.all(contexts.map((ctx) => ctx.watch()));
  console.log('DSH extension: watching for changes...');
} else {
  await Promise.all(contexts.map((ctx) => ctx.rebuild()));
  await Promise.all(contexts.map((ctx) => ctx.dispose()));
  copyFileSync('media/chat.html', 'dist/webview/chat.html');
  console.log('DSH extension: build complete.');
}

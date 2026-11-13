/**
 * esbuild turns `import './styles.css'` into a real stylesheet (dist/webview/main.css);
 * TypeScript only needs a module shape so the import type-checks.
 */
declare module '*.css' {
  const stylesheet: string;
  export default stylesheet;
}

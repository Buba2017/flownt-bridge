// Bundles the bridge into dist/bundle.cjs (input for pkg) and inlines the version from
// package.json, so src/version.ts never has to be bumped by hand.
import { build } from 'esbuild';
import { readFileSync } from 'node:fs';

const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf-8'));

await build({
  entryPoints: ['src/index.ts'],
  bundle: true,
  platform: 'node',
  target: 'node18',
  format: 'cjs',
  outfile: 'dist/bundle.cjs',
  logLevel: 'info',
  banner: { js: "const __importMetaUrl=require('url').pathToFileURL(__filename).href;" },
  define: {
    'import.meta.url': '__importMetaUrl',
    __BRIDGE_VERSION__: JSON.stringify(version),
  },
});
console.log(`flownt-bridge ${version} → dist/bundle.cjs`);

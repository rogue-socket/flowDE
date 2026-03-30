import esbuild from 'esbuild';

const isWatch = process.argv.includes('--watch');

const sharedConfig = {
  bundle: true,
  sourcemap: true,
  logLevel: 'info'
};

const extensionConfig = {
  ...sharedConfig,
  entryPoints: ['src/extension.ts'],
  outfile: 'dist/extension.js',
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  external: ['vscode']
};

const webviewConfig = {
  ...sharedConfig,
  entryPoints: ['src/webview/main.ts'],
  outfile: 'media/webview.js',
  platform: 'browser',
  format: 'iife',
  target: 'es2020'
};

async function build() {
  if (isWatch) {
    const extensionContext = await esbuild.context(extensionConfig);
    const webviewContext = await esbuild.context(webviewConfig);
    await Promise.all([extensionContext.watch(), webviewContext.watch()]);
    console.log('Watching extension and webview bundles...');
    return;
  }

  await Promise.all([esbuild.build(extensionConfig), esbuild.build(webviewConfig)]);
}

build().catch((error) => {
  console.error(error);
  process.exit(1);
});

const { spawn } = require('child_process');
const path = require('path');

const tool = process.argv[2];
const args = process.argv.slice(3);

if (!tool) {
  console.error('Usage: node script/run-clean-tool.cjs <tool> [...args]');
  process.exit(1);
}

const frontendRoot = path.resolve(__dirname, '..');
const toolEntrypoints = {
  vite: path.join(frontendRoot, 'node_modules', 'vite', 'bin', 'vite.js'),
  vitest: path.join(frontendRoot, 'node_modules', 'vitest', 'vitest.mjs'),
};
const executable = toolEntrypoints[tool] || path.join(
  frontendRoot,
  'node_modules',
  '.bin',
  process.platform === 'win32' ? `${tool}.cmd` : tool,
);
const command = toolEntrypoints[tool] ? process.execPath : executable;
const commandArgs = toolEntrypoints[tool] ? [executable, ...args] : args;

const child = spawn(command, commandArgs, {
  cwd: frontendRoot,
  env: {
    ...process.env,
    SASS_SILENCE_DEPRECATIONS: 'legacy-js-api',
  },
  stdio: ['inherit', 'inherit', 'pipe'],
});

let stderr = '';

child.stderr.on('data', (chunk) => {
  stderr += chunk.toString();
});

child.on('error', (error) => {
  console.error(error);
  process.exit(1);
});

child.on('close', (code, signal) => {
  const filtered = stderr
    .replace(
      /\r?\n?DEPRECATION WARNING \[legacy-js-api\]: The legacy JS API is deprecated and will be removed in Dart Sass 2\.0\.0\.\r?\n\r?\nMore info: https:\/\/sass-lang\.com\/d\/legacy-js-api\r?\n?/g,
      '',
    )
    .trimEnd();

  if (filtered) {
    console.error(filtered);
  }

  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 0);
});

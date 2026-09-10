import { spawnSync } from 'node:child_process';
import { networkInterfaces } from 'node:os';
import path from 'node:path';
import process from 'node:process';

const rootDir = process.cwd();
const port = 3001;
const host = '0.0.0.0';
const viteBin = path.join(rootDir, 'node_modules', 'vite', 'bin', 'vite.js');

function runNodeScript(relativePath) {
  const result = spawnSync(process.execPath, [path.join(rootDir, relativePath)], {
    cwd: rootDir,
    stdio: 'inherit',
  });

  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

function listLocalUrls() {
  const interfaces = networkInterfaces();
  const urls = new Set([`http://localhost:${port}`]);

  for (const records of Object.values(interfaces)) {
    for (const record of records ?? []) {
      if (record.family === 'IPv4' && !record.internal) {
        urls.add(`http://${record.address}:${port}`);
      }
    }
  }

  return [...urls];
}

function readListeningProcess(targetPort) {
  const lsof = spawnSync('lsof', ['-nP', `-iTCP:${targetPort}`, '-sTCP:LISTEN', '-Fpct'], {
    cwd: rootDir,
    encoding: 'utf8',
  });

  if (lsof.status !== 0 || !lsof.stdout.trim()) {
    return null;
  }

  let pid = '';
  let command = '';

  for (const line of lsof.stdout.trim().split('\n')) {
    if (line.startsWith('p')) {
      pid = line.slice(1);
    }
    if (line.startsWith('c')) {
      command = line.slice(1);
    }
  }

  if (!pid) {
    return null;
  }

  const cwdResult = spawnSync('lsof', ['-a', '-p', pid, '-d', 'cwd', '-Fn'], {
    cwd: rootDir,
    encoding: 'utf8',
  });
  const cwdLine = cwdResult.stdout
    .split('\n')
    .find((line) => line.startsWith('n'));

  const psResult = spawnSync('ps', ['-p', pid, '-o', 'command='], {
    cwd: rootDir,
    encoding: 'utf8',
  });

  return {
    pid,
    command: command || psResult.stdout.trim(),
    cwd: cwdLine ? cwdLine.slice(1) : '',
    fullCommand: psResult.stdout.trim(),
  };
}

function isCurrentProjectDevServer(processInfo) {
  if (!processInfo) {
    return false;
  }

  return processInfo.cwd === rootDir && processInfo.fullCommand.includes('vite');
}

runNodeScript('scripts/generate-model-catalog.mjs');

const listeningProcess = readListeningProcess(port);

if (isCurrentProjectDevServer(listeningProcess)) {
  console.log(`Dev server already running on port ${port}.`);
  listLocalUrls().forEach((url) => console.log(`  ${url}`));
  process.exit(0);
}

if (listeningProcess) {
  console.error(`Port ${port} is already in use by another process.`);
  console.error(`PID: ${listeningProcess.pid}`);
  console.error(`Command: ${listeningProcess.fullCommand || listeningProcess.command}`);
  if (listeningProcess.cwd) {
    console.error(`CWD: ${listeningProcess.cwd}`);
  }
  process.exit(1);
}

const viteProcess = spawnSync(
  process.execPath,
  [viteBin, '--host', host, '--port', String(port), '--strictPort'],
  {
    cwd: rootDir,
    stdio: 'inherit',
  },
);

process.exit(viteProcess.status ?? 0);

import { execFile } from 'node:child_process';
import { mkdir, readFile, rm, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { promisify } from 'node:util';

import { appRoot, executableName, nativeSmokeHome, targetTriple } from './paths.mjs';

const execFileAsync = promisify(execFile);
const target = targetTriple();
const smokeHome = nativeSmokeHome();
const archivePath = resolve(appRoot, 'dist-native', 'artifacts', `tea-code-${target}.zip`);
const extractedDir = resolve(smokeHome, 'release-artifact');
let executablePath;
const packageJson = JSON.parse(await readFile(resolve(appRoot, 'package.json'), 'utf-8'));
const expectedVersion = packageJson.version;
const expectedUpstreamVersion = (await readFile(resolve(appRoot, 'UPSTREAM_VERSION'), 'utf-8')).trim();

function fail(message) {
  console.error(message);
  process.exit(1);
}

async function extractReleaseArtifact() {
  try {
    await stat(archivePath);
  } catch {
    fail(`Native release archive not found at ${archivePath}. Run package:native first.`);
  }

  await rm(extractedDir, { recursive: true, force: true });
  await mkdir(extractedDir, { recursive: true });
  if (process.platform === 'win32') {
    const quote = (value) => `'${value.replaceAll("'", "''")}'`;
    await execFileAsync('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `Expand-Archive -LiteralPath ${quote(archivePath)} -DestinationPath ${quote(extractedDir)} -Force`,
    ]);
  } else {
    await execFileAsync('unzip', ['-q', archivePath, '-d', extractedDir]);
  }

  executablePath = resolve(extractedDir, executableName());
  try {
    await stat(executablePath);
  } catch {
    fail(`Native release archive did not contain ${executableName()}.`);
  }
}

async function runKimi(args) {
  try {
    const { stdout, stderr } = await execFileAsync(executablePath, args, {
      cwd: smokeHome,
      maxBuffer: 1024 * 1024 * 16,
    });
    return `${stdout}${stderr}`;
  } catch (error) {
    const detail = [error.stdout?.trim(), error.stderr?.trim(), error.message]
      .filter(Boolean)
      .join('\n');
    fail(`Native smoke failed: ${executablePath} ${args.join(' ')}\n${detail}`);
  }
}

async function runKimiWithEnv(args, env) {
  try {
    const { stdout, stderr } = await execFileAsync(executablePath, args, {
      cwd: smokeHome,
      env: { ...process.env, ...env },
      maxBuffer: 1024 * 1024 * 16,
    });
    return `${stdout}${stderr}`;
  } catch (error) {
    const detail = [error.stdout?.trim(), error.stderr?.trim(), error.message]
      .filter(Boolean)
      .join('\n');
    fail(`Native smoke failed: ${executablePath} ${args.join(' ')}\n${detail}`);
  }
}

function assertIncludes(output, expected, command) {
  if (!output.includes(expected)) {
    fail(`Native smoke output for "${command}" did not include "${expected}".\n${output}`);
  }
}

await extractReleaseArtifact();

const versionOutput = await runKimi(['--version']);
assertIncludes(versionOutput, expectedVersion, '--version');

const helpOutput = await runKimi(['--help']);
assertIncludes(helpOutput, 'Usage: tea-code', '--help');

const exportHelpOutput = await runKimi(['export', '--help']);
assertIncludes(exportHelpOutput, 'Usage: tea-code export', 'export --help');

const smokeCache = resolve(smokeHome, 'cache');
await rm(smokeCache, { recursive: true, force: true });
await mkdir(smokeCache, { recursive: true });
try {
  const nativeAssetOutput = await runKimiWithEnv(['--version'], {
    KIMI_CODE_CACHE_DIR: smokeCache,
    TEA_CODE_HOME: smokeHome,
    KIMI_CODE_NATIVE_ASSET_SMOKE: '1',
  });
  assertIncludes(nativeAssetOutput, `Native asset smoke passed: ${target}`, 'native asset smoke');
  assertIncludes(
    nativeAssetOutput,
    `upstream identity version ${expectedUpstreamVersion}`,
    'native upstream identity',
  );
  assertIncludes(nativeAssetOutput, 'MiniDb worker build passed', 'MiniDb worker smoke');
  assertIncludes(nativeAssetOutput, 'search worker ready', 'search worker smoke');
} finally {
  await rm(smokeHome, { recursive: true, force: true });
}

console.log(`Native release smoke passed: ${executablePath}`);

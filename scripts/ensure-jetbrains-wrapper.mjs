import { chmodSync, createWriteStream, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import https from 'node:https';
import { spawnSync } from 'node:child_process';

const cwd = process.cwd();
const inferredPluginDir = existsSync(join(cwd, 'settings.gradle.kts')) && existsSync(join(cwd, 'build.gradle.kts'))
  ? cwd
  : join(cwd, 'packages', 'jetbrains-plugin');
const pluginDir = inferredPluginDir;
const gradleHome = join(pluginDir, '.gradle-bootstrap');
const distVersion = '8.10.2';
const archivePath = join(gradleHome, `gradle-${distVersion}-bin.zip`);
const gradleUrl = `https://services.gradle.org/distributions/gradle-${distVersion}-bin.zip`;
const requestedArgs = process.argv.slice(2);

function run(command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

function ensureJava11OrNewer() {
  const result = spawnSync('java', ['-version'], {
    stdio: 'pipe',
    shell: process.platform === 'win32',
    encoding: 'utf8',
  });

  if (result.status !== 0) {
    console.error('JetBrains packaging requires Java 11 or newer. Java was not found in PATH.');
    process.exit(1);
  }

  const versionOutput = `${result.stdout || ''}\n${result.stderr || ''}`;
  const match = versionOutput.match(/version\s+"(\d+)(?:\.(\d+))?/i);
  if (!match) {
    return;
  }

  const major = Number(match[1]);
  const normalizedMajor = major === 1 ? Number(match[2] ?? 0) : major;

  if (normalizedMajor < 11) {
    console.error(`JetBrains packaging requires Java 11 or newer. Detected Java ${normalizedMajor}.`);
    process.exit(1);
  }
}

async function download(url, outFile) {
  await new Promise((resolve, reject) => {
    https.get(url, (res) => {
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        download(res.headers.location, outFile).then(resolve).catch(reject);
        return;
      }
      if (res.statusCode !== 200) {
        reject(new Error(`Failed to download Gradle distribution: HTTP ${res.statusCode}`));
        return;
      }
      const file = createWriteStream(outFile);
      res.pipe(file);
      file.on('finish', () => {
        file.close();
        resolve();
      });
      file.on('error', reject);
    }).on('error', reject);
  });
}

function ensureGradle() {
  mkdirSync(gradleHome, { recursive: true });

  const gradleBin = process.platform === 'win32'
    ? join(gradleHome, `gradle-${distVersion}`, 'bin', 'gradle.bat')
    : join(gradleHome, `gradle-${distVersion}`, 'bin', 'gradle');

  if (existsSync(gradleBin)) {
    return gradleBin;
  }

  console.log(`Downloading Gradle ${distVersion}...`);
  return download(gradleUrl, archivePath).then(() => {
    console.log('Extracting Gradle distribution...');
    const powershellExtract = [
      '-NoProfile',
      '-Command',
      `Expand-Archive -Path "${archivePath}" -DestinationPath "${gradleHome}" -Force`,
    ];

    if (process.platform === 'win32') {
      run('powershell', powershellExtract, pluginDir);
    } else {
      run('unzip', ['-o', archivePath, '-d', gradleHome], pluginDir);
    }

    if (process.platform !== 'win32') {
      chmodSync(gradleBin, 0o755);
    }

    return gradleBin;
  });
}

async function main() {
  ensureJava11OrNewer();
  const gradleBin = await ensureGradle();
  const args = requestedArgs.length > 0 ? requestedArgs : ['buildPlugin'];
  run(gradleBin, args, pluginDir);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const pluginDir = join(process.cwd(), 'packages', 'jetbrains-plugin');
const isWindows = process.platform === 'win32';
const wrapperPath = join(pluginDir, isWindows ? 'gradlew.bat' : 'gradlew');

if (!existsSync(wrapperPath)) {
  console.error('JetBrains plugin packaging requires a Gradle wrapper in packages/jetbrains-plugin.');
  console.error('Add gradlew, gradlew.bat, and gradle/wrapper/* to enable reproducible plugin builds.');
  process.exit(1);
}

const command = isWindows ? 'gradlew.bat' : 'sh';
const args = isWindows ? ['buildPlugin'] : ['gradlew', 'buildPlugin'];
const result = spawnSync(command, args, {
  cwd: pluginDir,
  stdio: 'inherit',
  shell: isWindows,
});

process.exit(result.status ?? 1);

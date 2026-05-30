import { spawnSync } from 'node:child_process';

const target = process.argv[2] ?? 'all';

function run(command, args) {
  return spawnSync(command, args, {
    stdio: 'pipe',
    shell: process.platform === 'win32',
    encoding: 'utf8',
  });
}

function parseNodeMajor(versionText) {
  const match = versionText.trim().match(/^v(\d+)\./i);
  return match ? Number(match[1]) : null;
}

function parseJavaMajor(versionOutput) {
  const match = versionOutput.match(/version\s+"(\d+)(?:\.(\d+))?/i);
  if (!match) {
    return null;
  }

  const major = Number(match[1]);
  return major === 1 ? Number(match[2] ?? 0) : major;
}

function printFixCommands() {
  if (process.platform === 'win32') {
    console.error('Fix commands (Windows):');
    console.error('  winget install OpenJS.NodeJS.LTS');
    console.error('  winget install EclipseAdoptium.Temurin.17.JDK');
    console.error('  setx JAVA_HOME "C:\\Program Files\\Eclipse Adoptium\\jdk-17*"');
  } else if (process.platform === 'darwin') {
    console.error('Fix commands (macOS):');
    console.error('  brew install node@20');
    console.error('  brew install temurin@17');
  } else {
    console.error('Fix commands (Linux):');
    console.error('  sudo apt-get update');
    console.error('  sudo apt-get install -y nodejs npm openjdk-17-jdk');
  }
}

function checkNode() {
  const result = run('node', ['-v']);
  if (result.status !== 0) {
    console.error('Preflight failed: Node.js is not available in PATH.');
    printFixCommands();
    return false;
  }

  const major = parseNodeMajor(result.stdout || '');
  if (major === null || major < 18) {
    console.error(`Preflight failed: Node.js 18+ required, detected ${result.stdout.trim() || 'unknown'}.`);
    printFixCommands();
    return false;
  }

  console.log(`Node.js check passed: ${result.stdout.trim()}`);
  return true;
}

function checkJava() {
  const result = run('java', ['-version']);
  const output = `${result.stdout || ''}\n${result.stderr || ''}`;

  if (result.status !== 0) {
    console.error('Preflight failed: Java is not available in PATH.');
    printFixCommands();
    return false;
  }

  const major = parseJavaMajor(output);
  if (major === null || major < 11) {
    console.error(`Preflight failed: Java 11+ required, detected ${major ?? 'unknown'}.`);
    printFixCommands();
    return false;
  }

  console.log(`Java check passed: major ${major}`);
  return true;
}

const requireJava = target === 'all' || target === 'jetbrains';

let ok = checkNode();
if (requireJava) {
  ok = checkJava() && ok;
}

if (!ok) {
  process.exit(1);
}

console.log(`Packaging preflight passed for target: ${target}`);

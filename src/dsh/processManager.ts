import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import type { ChildProcess } from 'node:child_process';
import { log } from '../log';

export interface ResolvedCommand {
  command: string;
  /** Arguments that must precede transport-specific arguments. */
  baseArgs: string[];
  env: NodeJS.ProcessEnv;
  /** Where the command came from, for logs and the status UI. */
  source: string;
  /** True when `command` is an Electron binary that needs ELECTRON_RUN_AS_NODE. */
  electron?: boolean;
}

export interface SpawnedRuntime {
  child: ChildProcess;
  command: ResolvedCommand;
}

const DESKTOP_EXE = 'DeepSeek Harness.exe';

function uniquePaths(paths: Array<string | undefined>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const path of paths) {
    if (!path) {
      continue;
    }
    const key = path.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    out.push(path);
  }
  return out;
}

function isExecutableFile(path: string): boolean {
  try {
    return existsSync(path);
  } catch {
    return false;
  }
}

/** Find a command on PATH, honouring PATHEXT on Windows. */
export function findOnPath(command: string): string | undefined {
  const pathVar = process.env['PATH'] ?? '';
  const exts =
    process.platform === 'win32'
      ? (process.env['PATHEXT'] ?? '.EXE;.CMD;.BAT;.COM').split(';').filter(Boolean)
      : [''];
  for (const dir of pathVar.split(delimiter)) {
    if (!dir) {
      continue;
    }
    for (const ext of exts) {
      const candidate = join(dir, `${command}${ext}`);
      if (isExecutableFile(candidate)) {
        return candidate;
      }
    }
  }
  return undefined;
}

async function queryRegistryInstallDir(): Promise<string | undefined> {
  if (process.platform !== 'win32') {
    return undefined;
  }
  const output = await new Promise<string>((resolve) => {
    execFile(
      'reg',
      [
        'query',
        'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
        '/s',
        '/f',
        'DeepSeek Harness',
      ],
      { timeout: 4000, windowsHide: true },
      (error, stdout) => {
        resolve(error ? '' : stdout);
      },
    );
  });
  const match = /(?:DisplayIcon|InstallLocation)\s+REG_(?:SZ|EXPAND_SZ)\s+"?([^"\r\n]+)"?/.exec(output);
  if (!match || !match[1]) {
    return undefined;
  }
  const displayIcon = match[1].trim();
  const exeIndex = displayIcon.toLowerCase().lastIndexOf(DESKTOP_EXE.toLowerCase());
  if (exeIndex >= 0) {
    return displayIcon.slice(0, exeIndex).replace(/[\\/]+$/, '');
  }
  return displayIcon.replace(/[\\/]+$/, '');
}

function desktopCliPaths(installDir: string): { cli: string; exe: string } {
  return {
    cli: join(installDir, 'resources', 'runtime', 'cli', 'bin', process.platform === 'win32' ? 'dsh.cmd' : 'dsh'),
    exe: join(installDir, DESKTOP_EXE),
  };
}

function electronCliPath(installDir: string): string {
  return join(installDir, 'resources', 'app.asar', 'dsh', 'node_modules', '@deepseek-ai', 'dsh-desktop-host', 'lib', 'cli.js');
}

export interface ResolveOptions {
  configuredExecutable: string;
  configuredArgs: string[];
  /** Extra args appended when the resolved command is the Desktop CLI. */
  transportArgs: string[];
  dshHome?: string;
  debug?: boolean;
}

/**
 * Resolve how to launch a DSH runtime on this machine. Order:
 * explicit setting, env override, `dsh` on PATH, Desktop install (registry),
 * npm global shim, `npx @deepseek-ai/dsh`.
 */
export async function resolveDshCommand(options: ResolveOptions): Promise<ResolvedCommand> {
  const env: NodeJS.ProcessEnv = { ...process.env };
  if (options.dshHome) {
    env['DSH_HOME'] = options.dshHome;
  }
  if (options.debug) {
    env['DSH_DEBUG'] = '1';
  }

  if (options.configuredExecutable) {
    return {
      command: options.configuredExecutable,
      baseArgs: [...options.configuredArgs],
      env,
      source: 'dsh.executable',
    };
  }

  const envOverride = process.env['DSH_VSCODE_EXECUTABLE'];
  if (envOverride) {
    return { command: envOverride, baseArgs: [], env, source: 'DSH_VSCODE_EXECUTABLE' };
  }

  const onPath = findOnPath('dsh');
  if (onPath) {
    return { command: onPath, baseArgs: [], env, source: 'PATH' };
  }

  const installDir = await queryRegistryInstallDir();
  if (installDir) {
    const paths = desktopCliPaths(installDir);
    if (isExecutableFile(paths.cli)) {
      return { command: paths.cli, baseArgs: [], env, source: `desktop:${installDir}` };
    }
    if (isExecutableFile(paths.exe)) {
      const cli = electronCliPath(installDir);
      if (isExecutableFile(cli)) {
        const electronEnv = { ...env, ELECTRON_RUN_AS_NODE: '1' };
        return {
          command: paths.exe,
          baseArgs: ['--expose-internals', cli],
          env: electronEnv,
          source: `desktop:${installDir}`,
          electron: true,
        };
      }
    }
  }

  const npmGlobal = process.env['APPDATA']
    ? join(process.env['APPDATA'], 'npm', process.platform === 'win32' ? 'dsh.cmd' : 'dsh')
    : undefined;
  if (npmGlobal && isExecutableFile(npmGlobal)) {
    return { command: npmGlobal, baseArgs: [], env, source: 'npm-global' };
  }

  const npx = findOnPath('npx');
  if (npx) {
    return {
      command: npx,
      baseArgs: ['--yes', '@deepseek-ai/dsh@latest'],
      env,
      source: 'npx',
    };
  }

  throw new Error(
    'Cannot find the dsh command. Install DeepSeek Harness, add dsh to PATH, or set "dsh.executable".',
  );
}

function quoteForCmd(arg: string): string {
  if (arg === '') {
    return '""';
  }
  if (!/[\s"&|<>^()]/.test(arg)) {
    return arg;
  }
  return `"${arg.replace(/"/g, '\\"')}"`;
}

export function spawnRuntime(command: ResolvedCommand, args: string[], cwd: string): SpawnedRuntime {
  const { spawn } = require('node:child_process') as typeof import('node:child_process');
  const allArgs = [...command.baseArgs, ...args];
  const isWindowsScript = process.platform === 'win32' && /\.(cmd|bat)$/i.test(command.command);
  let child: ChildProcess;
  if (isWindowsScript) {
    const line = [command.command, ...allArgs].map(quoteForCmd).join(' ');
    child = spawn(process.env['COMSPEC'] ?? 'cmd.exe', ['/d', '/s', '/c', line], {
      cwd,
      env: command.env,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } else {
    child = spawn(command.command, allArgs, {
      cwd,
      env: command.env,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  }
  log(`spawned ${command.command} ${allArgs.join(' ')} (source: ${command.source}, pid ${child.pid ?? '?'})`);
  return { child, command };
}

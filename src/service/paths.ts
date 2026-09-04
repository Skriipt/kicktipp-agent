import os from 'os';
import path from 'path';

export interface ServicePaths {
  configDir: string;
  dataDir: string;
  configFile: string;
  secretsFile: string;
  stateFile: string;
  serviceLockFile: string;
  configurationLockFile: string;
}

function platformConfigDir(env: NodeJS.ProcessEnv): string {
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'kicktipp-agent');
  }
  if (process.platform === 'win32' && env.APPDATA) {
    return path.join(env.APPDATA, 'kicktipp-agent');
  }
  return path.join(env.XDG_CONFIG_HOME ?? path.join(os.homedir(), '.config'), 'kicktipp-agent');
}

function platformDataDir(env: NodeJS.ProcessEnv): string {
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'kicktipp-agent');
  }
  if (process.platform === 'win32' && env.APPDATA) {
    return path.join(env.APPDATA, 'kicktipp-agent');
  }
  return path.join(
    env.XDG_DATA_HOME ?? path.join(os.homedir(), '.local', 'share'),
    'kicktipp-agent',
  );
}

export function servicePaths(env: NodeJS.ProcessEnv = process.env): ServicePaths {
  const configDir = env.KICKTIPP_CONFIG_DIR || platformConfigDir(env);
  const dataDir = env.KICKTIPP_DATA_DIR || platformDataDir(env);
  return {
    configDir,
    dataDir,
    configFile: path.join(configDir, 'service.json'),
    secretsFile: path.join(configDir, 'secrets.ini'),
    stateFile: path.join(dataDir, 'service-state.json'),
    serviceLockFile: path.join(dataDir, 'service.lock'),
    configurationLockFile: path.join(configDir, 'service-config.lock'),
  };
}

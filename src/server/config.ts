// Server configuration, read once from environment variables (nothing is baked into the image).
import { readDatabaseSsl, readDatabaseUrl } from '../store/db.ts';

export interface Config {
  port: number;
  host: string;
  databaseUrl: string;
  databaseSsl: boolean;
  inviteCode: string | undefined;
  publicUrl: string | undefined;
  allowedHosts: string[];
  logLevel: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const port = Number(env.PORT ?? 8765);
  const publicUrl = env.PAIR41_PUBLIC_URL || undefined;
  const allowedHosts = (env.PAIR41_ALLOWED_HOSTS ?? '')
    .split(',')
    .map((h) => h.trim())
    .filter(Boolean);
  allowedHosts.push(`localhost:${port}`, `127.0.0.1:${port}`, 'localhost', '127.0.0.1');
  if (publicUrl) {
    const url = new URL(publicUrl);
    allowedHosts.push(url.host, url.hostname);
  }
  return {
    port,
    host: env.HOST ?? '127.0.0.1',
    databaseUrl: readDatabaseUrl(env),
    databaseSsl: readDatabaseSsl(env),
    inviteCode: env.PAIR41_INVITE_CODE || undefined,
    publicUrl,
    allowedHosts,
    logLevel: env.LOG_LEVEL ?? 'info',
  };
}

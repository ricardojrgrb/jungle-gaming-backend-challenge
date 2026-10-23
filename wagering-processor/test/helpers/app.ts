import { type Subprocess } from 'bun';
import { bootstrap, type BootstrappedApp } from '../../src/bootstrap';
import { testConfig, testEnv } from './env';

/** Instância completa em processo (HTTP + consumidor + workers conforme overrides). */
export async function startApp(overrides: Record<string, string> = {}, tag = 'main'): Promise<BootstrappedApp> {
  return bootstrap(testConfig(overrides, tag));
}

export interface SpawnedApp {
  proc: Subprocess;
  url: string;
  pid: number;
  /** Resolve com o exit code quando o processo morrer. */
  exited: Promise<number>;
  stop(signal?: NodeJS.Signals): Promise<number>;
  logs(): string;
}

/**
 * Sobe uma instância em OUTRO processo (bun run src/main.ts). É o que os testes
 * de múltiplas instâncias e de crash usam: nada de simular concorrência com mocks.
 */
export async function spawnApp(overrides: Record<string, string> = {}, tag = 'main'): Promise<SpawnedApp> {
  const env = { ...process.env, ...testEnv(overrides, tag), LOG_LEVEL: overrides.LOG_LEVEL ?? 'info', LOG_PRETTY: 'false' };
  const proc = Bun.spawn([process.execPath, 'run', 'src/main.ts'], {
    cwd: new URL('../../', import.meta.url).pathname,
    env,
    stdout: 'pipe',
    stderr: 'pipe',
  });

  let buffer = '';
  const chunks: string[] = [];
  let resolveUrl: (url: string) => void;
  let rejectUrl: (e: Error) => void;
  const urlPromise = new Promise<string>((resolve, reject) => {
    resolveUrl = resolve;
    rejectUrl = reject;
  });

  const pump = async (stream: ReadableStream<Uint8Array>) => {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      const text = decoder.decode(value);
      chunks.push(text);
      buffer += text;
      let idx: number;
      while ((idx = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 1);
        if (line.includes('wagering-processor up')) {
          try {
            resolveUrl(JSON.parse(line).url);
          } catch {
            /* ignore */
          }
        }
      }
    }
  };
  void pump(proc.stdout as ReadableStream<Uint8Array>);
  void pump(proc.stderr as ReadableStream<Uint8Array>);

  const exited = proc.exited.then((code) => {
    rejectUrl(new Error(`process exited with ${code} before becoming ready:\n${chunks.join('').slice(-2000)}`));
    return code;
  });

  const url = await Promise.race([
    urlPromise,
    Bun.sleep(30_000).then(() => {
      throw new Error(`process did not become ready in 30s:\n${chunks.join('').slice(-2000)}`);
    }),
  ]);

  return {
    proc,
    url,
    pid: proc.pid,
    exited,
    logs: () => chunks.join(''),
    async stop(signal: NodeJS.Signals = 'SIGTERM') {
      if (proc.exitCode === null && !proc.killed) proc.kill(signal);
      return exited;
    },
  };
}

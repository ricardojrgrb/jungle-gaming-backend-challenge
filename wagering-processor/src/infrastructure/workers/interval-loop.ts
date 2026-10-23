import { AppLogger } from '../../application/ports/logger';

/**
 * Loop de worker com parada limpa: `stop()` espera a iteração corrente terminar.
 * `fn` devolve true quando ainda tem trabalho, aí a próxima rodada é imediata.
 */
export class IntervalLoop {
  private running = false;
  private current: Promise<void> | null = null;
  private wake: (() => void) | null = null;

  constructor(
    private readonly name: string,
    private readonly fn: () => Promise<boolean>,
    private readonly intervalMs: number,
    private readonly logger: AppLogger,
  ) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    this.current = this.run();
  }

  async stop(): Promise<void> {
    this.running = false;
    this.wake?.();
    await this.current;
  }

  /** Acorda o loop antes do intervalo (ex.: testes). */
  poke(): void {
    this.wake?.();
  }

  private async run(): Promise<void> {
    while (this.running) {
      let busy = false;
      try {
        busy = await this.fn();
      } catch (error) {
        this.logger.error({ worker: this.name, error: (error as Error).message }, 'worker iteration failed');
      }
      if (!this.running) break;
      if (!busy) {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(() => {
            this.wake = null;
            resolve();
          }, this.intervalMs);
          this.wake = () => {
            clearTimeout(timer);
            this.wake = null;
            resolve();
          };
        });
      }
    }
  }
}

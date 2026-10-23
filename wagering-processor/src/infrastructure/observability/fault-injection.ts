import { Injectable } from '@nestjs/common';
import { ConfigPort } from '../config/config';

export type FaultPoint = 'sqs:after-commit-before-ack' | 'outbox:after-publish-before-commit';

/**
 * Pontos de falha para os testes de crash (worker morto depois do commit e antes
 * do ack etc.). Só faz algo se FAULT_INJECTION estiver setado — em produção a
 * variável não existe e isto é um no-op. Dispara uma única vez por processo.
 */
@Injectable()
export class FaultInjector {
  private fired = false;

  constructor(private readonly config: ConfigPort) {}

  crashIfArmed(point: FaultPoint): void {
    if (this.fired || this.config.values.FAULT_INJECTION !== point) return;
    this.fired = true;
    // Sem flush de log, sem shutdown hooks: é um crash de verdade.
    process.stderr.write(`[fault-injection] crashing at ${point}\n`);
    process.exit(137);
  }
}

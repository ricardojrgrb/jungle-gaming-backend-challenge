import type { LoggerService } from '@nestjs/common';
import pino from 'pino';
import type { Logger as Pino } from 'pino';
import { AppLogger, type LogFields } from '../../application/ports/logger';
import { requestContext } from './request-context';

export interface LoggerOptions {
  level: string;
  pretty: boolean;
  instanceId: string;
}

// Nada de payload financeiro completo no log: só ids e status. Estes campos são
// redigidos caso alguém, por engano, logue um objeto com eles dentro.
const REDACT_PATHS = ['money', '*.money', 'amount', '*.amount', 'balance', '*.balance', 'initialBalance', 'payload', '*.payload', 'body', 'authorization', 'headers.authorization'];

export function createPino(options: LoggerOptions): Pino {
  return pino({
    level: options.level,
    base: { service: 'wagering-processor', instanceId: options.instanceId, pid: process.pid },
    timestamp: pino.stdTimeFunctions.isoTime,
    redact: { paths: REDACT_PATHS, censor: '[redacted]' },
    // Os campos do contexto (correlationId, walletId...) entram em toda linha,
    // exceto os que a chamada ou o child logger já trouxeram (evita chave repetida).
    mixin: (mergeObject, _level, logger) => {
      const ctx = requestContext.get();
      if (!ctx) return {};
      const bindings = logger.bindings();
      const out: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(ctx)) {
        if (value !== undefined && !(key in bindings) && !(key in mergeObject)) out[key] = value;
      }
      return out;
    },
    ...(options.pretty ? { transport: { target: 'pino-pretty', options: { colorize: true, translateTime: 'SYS:HH:MM:ss.l' } } } : {}),
  });
}

export class PinoAppLogger extends AppLogger {
  constructor(private readonly pino: Pino) {
    super();
  }

  debug(fields: LogFields, message: string): void {
    this.pino.debug(fields, message);
  }
  info(fields: LogFields, message: string): void {
    this.pino.info(fields, message);
  }
  warn(fields: LogFields, message: string): void {
    this.pino.warn(fields, message);
  }
  error(fields: LogFields, message: string): void {
    this.pino.error(fields, message);
  }
  child(bindings: LogFields): AppLogger {
    return new PinoAppLogger(this.pino.child(bindings));
  }
}

/** Faz os logs internos do Nest (bootstrap, rotas) saírem em JSON também. */
export class NestPinoAdapter implements LoggerService {
  constructor(private readonly pino: Pino) {}
  log(message: unknown, context?: string): void {
    this.pino.info({ context }, String(message));
  }
  error(message: unknown, trace?: string, context?: string): void {
    this.pino.error({ context, trace }, String(message));
  }
  warn(message: unknown, context?: string): void {
    this.pino.warn({ context }, String(message));
  }
  debug(message: unknown, context?: string): void {
    this.pino.debug({ context }, String(message));
  }
  verbose(message: unknown, context?: string): void {
    this.pino.trace({ context }, String(message));
  }
}

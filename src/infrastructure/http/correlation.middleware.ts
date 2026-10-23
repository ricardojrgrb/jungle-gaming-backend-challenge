import type { NextFunction, Request, Response } from 'express';
import { newId } from '../../domain/shared/ids';
import { requestContext } from '../observability/request-context';

const HEADER = 'x-correlation-id';

/** Abre o contexto de log da requisição e ecoa o correlationId na resposta. */
export function correlationMiddleware(req: Request, res: Response, next: NextFunction): void {
  const incoming = req.header(HEADER);
  const correlationId = incoming && incoming.length <= 128 ? incoming : newId();
  res.setHeader(HEADER, correlationId);
  requestContext.run({ correlationId, source: 'http' }, () => next());
}

/** correlationId da requisição corrente (aberto pelo middleware acima). */
export function currentCorrelationId(): string {
  return requestContext.get()?.correlationId ?? 'unknown';
}

/**
 * Base de todos os erros de domínio. A `code` é estável e legível por máquina;
 * a camada HTTP e o consumidor SQS usam ela para decidir status/ack/DLQ sem
 * precisar interpretar mensagem de texto.
 */
export class DomainError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

/** Erro de programação: uma transição inválida, estado impossível etc. */
export class InvariantViolationError extends DomainError {
  constructor(message: string, details?: Record<string, unknown>) {
    super('INVARIANT_VIOLATION', message, details);
  }
}

import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Campos que todo log precisa carregar (correlationId, messageId, transactionId,
 * walletId, providerId). Quem entra (HTTP middleware / consumidor SQS / worker)
 * abre um contexto; o logger lê daqui sem ninguém precisar passar parâmetro.
 */
export interface ContextFields {
  correlationId: string;
  messageId?: string;
  transactionId?: string;
  walletId?: string;
  providerId?: string;
  source?: string;
}

const storage = new AsyncLocalStorage<ContextFields>();

export const requestContext = {
  run<T>(fields: ContextFields, fn: () => T): T {
    return storage.run(fields, fn);
  },
  get(): ContextFields | undefined {
    return storage.getStore();
  },
  /** Enriquecer o contexto atual (ex.: transactionId descoberto no meio do caminho). */
  set(fields: Partial<ContextFields>): void {
    const store = storage.getStore();
    if (store) Object.assign(store, fields);
  },
};

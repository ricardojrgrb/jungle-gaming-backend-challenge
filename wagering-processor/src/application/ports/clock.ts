import { type Clock } from '../../domain/shared/clock';

/** Token de injeção para o relógio (testes trocam por um relógio controlado). */
export abstract class ClockPort implements Clock {
  abstract now(): Date;
}

import type { ReferenceRetryPolicy } from '../../domain/wagering/reference-retry-policy';

/** Token para a política de retry de referências pendentes (configurável por env). */
export abstract class ReferenceRetryPolicyPort {
  abstract readonly policy: ReferenceRetryPolicy;
}

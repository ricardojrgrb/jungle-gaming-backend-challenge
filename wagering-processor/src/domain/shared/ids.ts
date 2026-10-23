/**
 * UUID v7: ordenável no tempo, o que ajuda em índices e em cursores.
 * Bun expõe nativamente; se um dia rodar em Node, troca por `uuid`.
 */
export function newId(): string {
  return Bun.randomUUIDv7();
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isUuid(value: string): boolean {
  return UUID_RE.test(value);
}

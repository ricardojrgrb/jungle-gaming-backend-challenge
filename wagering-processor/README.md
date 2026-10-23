# Wagering Processor

Serviço financeiro distribuído que processa transações de apostas (`BET`, `WIN`, `LOSS`, `REFUND`, `ROLLBACK`) vindas de múltiplos provedores, por HTTP e por SQS, mantendo saldo materializado e ledger consistentes mesmo com mensagens duplicadas, fora de ordem ou processadas ao mesmo tempo por várias instâncias.

Este diretório é a minha resposta ao desafio técnico descrito em [`../README.md`](../README.md). As decisões de arquitetura, trade-offs e limitações estão em [`ARCHITECTURE.md`](./ARCHITECTURE.md); o relatório do teste de carga em [`docs/LOAD_TEST.md`](./docs/LOAD_TEST.md).

## Stack

| Item | Escolha |
|---|---|
| Runtime / package manager / test runner | Bun 1.4 |
| Linguagem | TypeScript estrito (`strict`, `exactOptionalPropertyTypes`, `verbatimModuleSyntax`) |
| Framework | NestJS 11 |
| Banco | PostgreSQL 16 |
| ORM | MikroORM 6 (`EntitySchema`, `em.transactional()`, `LockMode`), migrations SQL versionadas |
| Mensageria | AWS SQS (FIFO) via LocalStack |
| Dinheiro | `decimal.js` por baixo de um value object `Money`; `numeric(18,2)` no banco; string na API |
| Validação de borda | zod |
| Logs / métricas | pino (JSON) / prom-client (`/metrics`) |
| Auth (opcional) | guard OIDC via JWKS (`jose`), desligado por padrão |

## Subindo tudo com Docker Compose

Pré-requisito: Docker com Compose v2.

```bash
docker compose up -d --build
```

Isso sobe:

- `postgres` (porta 5432) com os bancos `wagering` e `wagering_test`;
- `localstack` (porta 4566) com as filas `wager-transactions.fifo`, `wager-transactions-dlq.fifo` (redrive após 5 recebimentos) e `wagering-events.fifo` (destino do outbox);
- `migrate`: one-shot que aplica as migrations antes das instâncias subirem;
- `app-1`, `app-2`, `app-3`: três instâncias idênticas (API + consumidor SQS + publisher do outbox + worker de referências pendentes), nas portas 3001–3003;
- `lb`: nginx fazendo round-robin em `http://localhost:3000`.

Verificando:

```bash
curl -s localhost:3000/health/ready
docker compose ps
```

Para acompanhar os logs (JSON, uma linha por evento):

```bash
docker compose logs -f app-1 app-2 app-3
```

## Rodando fora do Docker (desenvolvimento)

Precisa de Bun 1.x (`curl -fsSL https://bun.sh/install | bash`) e dos containers de infra:

```bash
docker compose up -d postgres localstack
bun install
cp .env.example .env            # ajuste se quiser
bun run migration:up
bun run dev                     # bun --watch, logs "pretty"
```

A aplicação sobe em `http://localhost:3000` (`PORT`). Todas as instâncias são iguais; o que cada uma faz é controlado por flags:

| Variável | Default | Efeito |
|---|---|---|
| `ENABLE_SQS_CONSUMER` | `true` | consome `wager-transactions.fifo` |
| `ENABLE_OUTBOX_PUBLISHER` | `true` | publica eventos pendentes em `wagering-events.fifo` |
| `ENABLE_PENDING_REFERENCE_WORKER` | `true` | reprocessa transações `PENDING_REFERENCE` |
| `AUTH_MODE` | `none` | `oidc` liga o guard (ver ARCHITECTURE.md) |

A lista completa está em [`.env.example`](./.env.example) e é validada no boot por [`src/infrastructure/config/config.ts`](./src/infrastructure/config/config.ts) — variável faltando ou inválida derruba o processo com a mensagem do que está errado.

## Comandos

```bash
bun run dev                 # app com reload
bun run start               # app
bun run typecheck           # tsc --noEmit
bun run migration:up        # aplica migrations pendentes
bun run migration:down      # reverte a última
bun run migration:status

bun test                    # tudo (unit + integration + concurrency)
bun run test:unit           # não precisa de infra
bun run test:integration    # precisa de postgres + localstack no ar
bun run test:concurrency    # idem; sobe processos extras da aplicação
bun run test:load           # teste de carga contra o compose (ver docs/LOAD_TEST.md)
```

Os testes de integração e concorrência usam o banco `wagering_test` (criado pelo init do container) e criam filas próprias no LocalStack por execução (`wager-tx-<runId>-<suite>.fifo`), então podem rodar com a aplicação do compose no ar sem interferir.

## API

Todas as respostas de erro têm o mesmo formato:

```json
{ "error": { "code": "WALLET_NOT_FOUND", "message": "...", "details": { } }, "correlationId": "..." }
```

O header `X-Correlation-Id` é aceito na entrada e sempre devolvido na resposta.

### Criar wallet

```bash
curl -s -X POST localhost:3000/wallets -H 'content-type: application/json' -d '{
  "playerId": "0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1",
  "initialBalance": { "amount": "1000.00", "currency": "BRL" }
}'
```

`201` com `{ id, playerId, balance, version: 1, createdAt, updatedAt }`. Saldo inicial maior que zero gera uma transação interna `OPENING` e um lançamento `CREDIT` na mesma transação SQL. Duplicar `playerId + currency` → `409 WALLET_ALREADY_EXISTS`.

### Submeter transação

```bash
curl -s -X POST localhost:3000/wagering/transactions \
  -H 'content-type: application/json' \
  -H 'Idempotency-Key: provider-a:transaction-123' -d '{
  "providerId": "provider-a",
  "externalTransactionId": "transaction-123",
  "playerId": "0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1",
  "walletId": "<id da wallet>",
  "roundId": "round-987",
  "gameId": "fortune-chimp",
  "kind": "BET",
  "money": { "amount": "25.00", "currency": "BRL" }
}'
```

Resposta:

```json
{ "transactionId": "...", "status": "PROCESSED", "balance": { "amount": "975.00", "currency": "BRL" }, "idempotentReplay": false }
```

| HTTP | Significado |
|---|---|
| `200` | `PROCESSED` (inclusive replay idempotente, com `idempotentReplay: true`) |
| `202` | `PENDING_REFERENCE`: aceita, aguardando a transação referenciada |
| `422` | `REJECTED` por regra de negócio; o corpo traz `failureCode` (replay de uma rejeição também é `422`) |
| `400` | payload inválido, header `Idempotency-Key` ausente, `kind: OPENING` |
| `404` | wallet inexistente |
| `409` | mesma `Idempotency-Key` com payload diferente, ou mesmo `externalTransactionId` com outra key |
| `503` | falha transitória (banco/broker); vem com `Retry-After` — pode reenviar com a mesma key |

`REFUND` e `ROLLBACK` exigem `referenceExternalTransactionId`; `WIN` e `LOSS` podem opcionalmente referenciar a `BET` da rodada.

### Consultas

```
GET /wallets/:walletId
GET /wallets/:walletId/ledger?cursor=...&limit=50
GET /wagering/transactions/:transactionId
GET /providers/:providerId/wagering/transactions/:externalTransactionId
POST /wallets/:walletId/reconciliation
```

O cursor do ledger é opaco e estável (base64url da versão da wallet do último item); `nextCursor: null` indica fim.

### Operação

```
GET /health/live      # processo vivo
GET /health/ready     # 200 se Postgres e SQS respondem; 503 com o detalhe de cada check
GET /metrics          # Prometheus
```

## Mensagem SQS

Fila `wager-transactions.fifo`, `MessageGroupId` = `walletId` (recomendado), `MessageDeduplicationId` qualquer coisa única por envio:

```json
{
  "messageId": "msg-123",
  "type": "WagerTransactionRequested",
  "occurredAt": "2026-07-29T15:00:00.000Z",
  "data": {
    "providerId": "provider-a",
    "externalTransactionId": "transaction-123",
    "idempotencyKey": "provider-a:transaction-123",
    "playerId": "0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1",
    "walletId": "...",
    "roundId": "round-987",
    "gameId": "fortune-chimp",
    "kind": "BET",
    "money": { "amount": "25.00", "currency": "BRL" }
  }
}
```

Para testar na mão com o LocalStack do compose:

```bash
docker exec wagering-processor-localstack-1 awslocal sqs send-message \
  --queue-url http://localhost:4566/000000000000/wager-transactions.fifo \
  --message-group-id "<walletId>" --message-deduplication-id "$(uuidgen)" \
  --message-body '<json acima>'

# eventos publicados pelo outbox
docker exec wagering-processor-localstack-1 awslocal sqs receive-message \
  --queue-url http://localhost:4566/000000000000/wagering-events.fifo --max-number-of-messages 10
```

`messageId` do envelope é a chave de deduplicação da inbox (`(consumerName, messageId)`); o `MessageId` que o SQS atribui muda a cada reenvio e não serve para isso.

## Estrutura

```
src/
  domain/            Money, Wallet, WalletLedgerEntry, WagerTransaction, Inbox/Outbox, eventos — sem Nest, sem ORM
  application/       use cases, portas (UnitOfWork, repositórios, publisher, métricas, logger) e erros
  infrastructure/
    persistence/     MikroORM: EntitySchema, migrations SQL, repositórios, UnitOfWork, tradução de erros do Postgres
    sqs/             consumidor da fila de apostas, publisher de eventos, criação de filas
    http/            controllers, schemas zod, filtro de exceções, middleware de correlação, guard OIDC
    workers/         loops do outbox e das referências pendentes
    observability/   pino, prom-client, contexto por requisição, injeção de falhas (testes)
    health/
test/
  unit/              domínio e use case com UnitOfWork em memória
  integration/       Postgres + LocalStack reais: schema, atomicidade, inbox, outbox, retry/DLQ, restart, API, auth
  concurrency/       paralelismo real, 3 processos, crash após commit, kill -9
scripts/load-test.ts
docker/              init do Postgres, criação das filas, nginx
```

## Testes

`bun test` roda 143 testes em ~30s com a infra no ar. Resumo do que é coberto, por suíte:

- **unit** — `Money` (escala, entradas inválidas, moedas), invariantes da `Wallet`, lançamento imutável, transições de `WagerTransaction`, regras de referência, hash canônico, outbox/inbox, cursor, e todas as regras de BET/WIN/LOSS/REFUND/ROLLBACK + idempotência rodando o use case real sobre um `UnitOfWork` em memória.
- **integration** — migrations up/down; cada constraint, índice parcial e trigger do schema; atomicidade (rollback desfaz wallet, ledger, inbox e outbox juntos); update condicionado por versão; inbox com redelivery real pela fila; dois publishers na mesma outbox; crash simulado entre publicar e commitar; falha de publicação com backoff; erro de negócio (ack), permanente (DLQ com motivo) e transitório (backoff → limite → DLQ); SIGTERM devolvendo visibilidade; recuperação após restart; contrato HTTP completo; guard OIDC com JWKS local.
- **concurrency** — a mesma aposta 50× em paralelo (HTTP e SQS); o cenário obrigatório 100/80/80 repetido 10×; hot wallet com 60 operações misturadas; 20 wallets em paralelo; 3 processos reais recebendo HTTP round-robin + SQS com duplicatas; processo morto depois do commit e antes do ack (via `FAULT_INJECTION`); 2 processos publicando a mesma outbox; `REFUND`/`ROLLBACK` antes da referência; `kill -9` com 200 operações em voo seguido de restart.

Todos os testes que tocam saldo terminam com `assertWalletConsistent`: saldo materializado == saldo reconstruído pelo ledger, cadeia `balanceBefore/balanceAfter` fechada e `version` igual à do último lançamento.

## Autor

Ricardo Júnior Abreu da Silva · [github.com/ricardojrgrb](https://github.com/ricardojrgrb) · ricardojras19@gmail.com

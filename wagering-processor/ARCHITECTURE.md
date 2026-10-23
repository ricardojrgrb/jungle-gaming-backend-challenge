# Arquitetura e decisões

Este documento explica *por que* o serviço é do jeito que é. O *como* está no código e no [README](./README.md). Escrevi na ordem em que as decisões pesam na avaliação: correção financeira, concorrência, idempotência, mensageria, e só depois o resto.

## 1. O caminho de uma operação

```
 HTTP POST /wagering/transactions ──┐
                                     ├──► ProcessWagerTransactionUseCase.execute()
 SQS wager-transactions.fifo ────────┘         │
                                               ▼
                 ┌──────────────── uma transação SQL ────────────────┐
                 │ 1. inbox (só SQS): INSERT ... ON CONFLICT DO NOTHING│  duplicata sai aqui
                 │ 2. SELECT wallet ... FOR UPDATE                     │  unidade de concorrência
                 │ 3. re-checagem da idempotency key (agora com lock) │
                 │ 4. regras → PROCESSED | REJECTED | PENDING_REFERENCE│
                 │ 5. INSERT ledger; UPDATE wallet WHERE version = ?   │  lançamento + update condicionado
                 │ 6. INSERT outbox (eventos)                          │
                 └──────────────────────── COMMIT ────────────────────┘
                                               │
                        resposta HTTP / DeleteMessage (ack) só depois daqui
                                               │
          OutboxPublisherWorker ──► wagering-events.fifo   (em outra transação, outro loop)
          PendingReferenceWorker ──► mesmo applyAndPersist, para PENDING_REFERENCE vencidas
```

O ponto central: existe **um** caminho que altera saldo (`applyAndPersist`), e ele só roda com o lock da wallet na mão, dentro de uma transação que também grava a inbox (quando a entrada é a fila), o ledger e o outbox. HTTP, SQS e o worker de referências pendentes são três portas de entrada para o mesmo código.

## 2. Stack e forma do código

- **Bun** como runtime, package manager e test runner, como pedido. Roda TypeScript direto — não há etapa de build; o `tsc --noEmit` é o typecheck (CI). Um detalhe prático: com `emitDecoratorMetadata`, o Bun mantém em runtime qualquer tipo usado em parâmetro de construtor/handler decorado. Por isso o `tsconfig` tem `verbatimModuleSyntax` e todo import só de tipo é `import type` — sem isso o Nest tenta importar `Response` do Express como valor e o processo nem sobe.
- **NestJS** só na borda: controllers, guard, filtro, DI. O domínio não importa nada do Nest. Os *tokens* de injeção são classes abstratas (`UnitOfWork`, `Metrics`, `AppLogger`, `EventPublisher`, `ClockPort`...), então a aplicação depende de portas e a infra entrega as implementações em um único módulo explícito ([`app.module.ts`](./src/app.module.ts)). O projeto é pequeno o suficiente para que a separação em camadas viva nas pastas, não em módulos Nest.
- **Validação com zod** em vez de `class-validator`: o mesmo schema valida o corpo HTTP e o `data` da mensagem SQS, e não depende de metadata de decorators.
- **Três camadas**, sem cerimônia: `domain/` (regras e invariantes, zero dependências), `application/` (use cases + portas), `infrastructure/` (MikroORM, SQS, HTTP, workers, observabilidade).

## 3. Modelo de domínio

Segui os esqueletos do enunciado (construtor privado + `create`/`from`/`open`/`rehydrate`), adaptando assinaturas onde precisei. `rehydrate` nunca revalida transição: reconstrói o que o banco diz que aconteceu.

### Money

- `decimal.js` por baixo, numa instância clonada com 40 dígitos de precisão (soma/subtração de `numeric(18,2)` nunca arredonda).
- Entrada só por string, validada por regex: `^-?\d{1,16}(\.\d{1,2})?$`. Isso barra `NaN`, `Infinity`, notação científica, vírgula, espaço, string vazia e mais de 2 casas. Não há arredondamento: `"10.555"` é rejeitado, não truncado. `"25.5"` vira `"25.50"`.
- O sinal negativo é aceito **no domínio** (resultado de `negate()`, `difference` da reconciliação) e rejeitado **nos contratos de entrada** (regex do zod sem `-`, mais `amount > 0` para transações).
- Instâncias são congeladas (`Object.freeze`); toda operação devolve outra instância. Moedas diferentes lançam `CurrencyMismatchError`.
- Persistência: `amount numeric(18,2)` + `currency char(3)` em colunas separadas; sai do driver como string e volta a ser `Money` no mapper. Nenhum `number` toca dinheiro em lugar nenhum — o `Money.from` rejeita se receber um.

### Wallet (aggregate root)

- `debit()`/`credit()` devolvem o `WalletLedgerEntry` correspondente. É a forma de garantir "toda alteração de saldo tem um lançamento": não há método que mude `_balance` sem produzir a entrada, e o use case persiste os dois na mesma transação.
- `version` começa em 1 e só incrementa em `apply()`. A abertura com saldo inicial **não** incrementa: `Wallet.open()` já nasce com o saldo, e o `OpenWalletUseCase` monta a transação `OPENING` e o lançamento (`balanceBefore 0 → balanceAfter inicial`, `walletVersion 1`) ao lado dela. O enunciado mostra a resposta da criação com `version: 1` e saldo `1000.00`, então foi assim que modelei.
- `canDebit()` é a pergunta de negócio (vira `REJECTED`); `debit()` sem saldo lança `InsufficientFundsError` como última defesa (seria bug).

### WalletLedgerEntry

- Imutável de verdade: sem setters, sem métodos de transição, instância congelada, e no banco um trigger que barra `UPDATE`/`DELETE`.
- Adicionei `walletVersion`: a versão da wallet *depois* do lançamento. Com `UNIQUE (wallet_id, wallet_version)` isso dá uma ordem total por wallet (sem depender de relógio), serve de cursor opaco e amarra "1 lançamento == 1 incremento de versão". A reconciliação confere `wallet.version == walletVersion do último lançamento`.
- `create()` valida `balanceBefore ± money == balanceAfter`, valor positivo, saldos não negativos e moeda única; o banco valida a mesma aritmética com um `CHECK`.

### WagerTransaction

Campos do enunciado mais três que precisei:

- `balanceAfter` — saldo observado no momento em que a transação chegou ao resultado atual. É o que faz um replay devolver "o saldo observado naquele momento" (regra 7) sem ler a wallet de novo. Uma `REJECTED` também guarda o saldo que viu.
- `referenceAttempts` / `nextReferenceRetryAt` — estado do backoff de `PENDING_REFERENCE`.

Transições válidas (qualquer saída de estado terminal lança `InvalidTransactionStateError`):

```
PENDING ──► PROCESSED | REJECTED | FAILED | PENDING_REFERENCE
PENDING_REFERENCE ──► PROCESSED | REJECTED | FAILED | PENDING_REFERENCE (retry agendado)
```

`OPENING` só nasce por `WagerTransaction.opening()`; `create()` recusa o kind, e o enum do zod nem o lista — na API e na fila ele é `400`/DLQ.

### Inbox, Outbox e eventos

Como no enunciado. `OutboxMessage.enqueue(event)` usa o `eventId` como id da linha, então "um evento, uma linha, um id para o consumidor deduplicar". O envelope é a classe abstrata `IntegrationEvent<T>` com uma subclasse por evento (`eventType` e `version` ficam no tipo); `data` carrega `MoneyProps`, nunca `Money`.

Eventos: `WalletOpened`, `WalletBalanceChanged` (só quando o saldo muda), `WagerTransactionProcessed` (inclusive `LOSS`), `WagerTransactionRejected`, `WagerTransactionPendingReference`, `WagerTransactionFailed`. Todos usam `aggregateId = walletId`: a wallet é a unidade de concorrência, então o stream de eventos é particionado por ela (`MessageGroupId` na fila FIFO) e o `transactionId` vai em `data`.

## 4. Persistência

### Schema (migration SQL escrita à mão)

Não confio em DDL gerado para as garantias que o enunciado pede no banco. A migration [`Migration20261023000001_initial_schema.ts`](./src/infrastructure/persistence/migrations/Migration20261023000001_initial_schema.ts) tem `up` e `down` e cria:

| Garantia | Mecanismo |
|---|---|
| uma wallet por `(player_id, currency)` | `UNIQUE` |
| saldo nunca negativo | `CHECK (balance_amount >= 0)` em `wallets`; `CHECK (balance_before >= 0 AND balance_after >= 0)` no ledger |
| `version >= 1` | `CHECK` |
| moeda ISO-4217 | `CHECK (currency ~ '^[A-Z]{3}$')` |
| uma transação por `(provider_id, external_transaction_id)` e por `idempotency_key` | dois `UNIQUE` |
| no máximo um lançamento por transação | `UNIQUE (transaction_id)` |
| ordem total por wallet | `UNIQUE (wallet_id, wallet_version)` |
| aritmética do lançamento | `CHECK ((CREDIT AND after = before + amount) OR (DEBIT AND after = before - amount))` |
| ledger imutável | trigger `BEFORE UPDATE OR DELETE` que lança exceção |
| estados terminais não mudam | trigger `BEFORE UPDATE` que lança se `OLD.status` é terminal e a linha mudou; `BEFORE DELETE` sempre lança |
| uma referência revertida uma só vez | `UNIQUE INDEX ... (reference_transaction_id) WHERE status = 'PROCESSED' AND kind IN ('REFUND','ROLLBACK')` |
| coerência status ↔ campos | `CHECK`s: `REJECTED/FAILED ⇔ failure_code`, `PROCESSED ⇔ processed_at`, reversão ⇒ referência, saldo observado em tudo que saiu de `PENDING` |
| dedup de mensagens | `PRIMARY KEY (consumer_name, message_id)` em `inbox_messages` |

Índices parciais cobrem só o que os workers varrem: `PENDING_REFERENCE` por `next_reference_retry_at`, `PENDING_REFERENCE` por `(provider_id, reference_external_transaction_id)` (para acordar quem espera), e `outbox_messages WHERE published_at IS NULL`.

Os testes de integração exercitam cada uma dessas linhas inserindo dados ruins direto por SQL.

### MikroORM: como uso e como não uso

Escolhi MikroORM (preferencial), com `EntitySchema` em vez de decorators — o domínio não vê o ORM e os registros de persistência (`WalletRecord` etc.) são classes burras mapeadas pelos repositórios.

O que uso dele: `MikroORM.init`, `em.fork()` explícito por unidade de trabalho, `em.transactional()` com nível de isolamento, `findOne`/`find` com `LockMode.PESSIMISTIC_WRITE` (`FOR UPDATE`) e `LockMode.PESSIMISTIC_PARTIAL_WRITE` (`FOR UPDATE SKIP LOCKED`), `nativeUpdate` (que devolve linhas afetadas), `insert`/`insertMany`, `execute` para os poucos statements que o query builder não expressa bem (`ON CONFLICT DO NOTHING ... RETURNING`, o claim com subquery), e o `Migrator`.

O que **não** uso: `persist()` + `flush()` (Unit of Work implícito) no caminho financeiro. Motivo: no caminho que mexe em dinheiro eu quero enxergar a ordem exata dos writes e o momento do `UPDATE ... WHERE version = ?`. O UoW implícito decide a ordem de inserção pelas relações do metadata e esconde o update condicionado atrás do `@Version`; funciona, mas fica mais difícil de ler e de auditar. Statements explícitos custam mais linhas e ganham previsibilidade. Documento isso como trade-off consciente, não como limitação do ORM.

`UnitOfWork.run()` ([`mikro-orm-unit-of-work.ts`](./src/infrastructure/persistence/mikro-orm-unit-of-work.ts)) é a única forma de abrir uma transação: faz o fork, abre `transactional()`, aplica `SET LOCAL lock_timeout` quando pedido, entrega repositórios amarrados àquela transação e traduz qualquer erro do driver para a taxonomia da aplicação ([`pg-errors.ts`](./src/infrastructure/persistence/pg-errors.ts)) antes de sair. Use cases nunca veem um erro do `pg`.

## 5. Concorrência

**Unidade de concorrência: a wallet.** Três camadas, de dentro para fora:

1. **Lock pessimista por linha** — `SELECT ... FOR UPDATE` na wallet no início da transação. Tudo que toca a mesma wallet (HTTP, SQS, worker de referências, em qualquer instância) entra em fila no Postgres; wallets diferentes não se enxergam. Não há lock global. O `lock_timeout` é `5s` por transação: estourou → `55P03` → erro transitório → `503` com `Retry-After` / mensagem devolvida à fila com backoff.
2. **Update condicionado por versão** — `UPDATE wallets SET balance, version = v+1 WHERE id = ? AND version = v`. Com o lock isso nunca deveria falhar; se falhar, alguém alterou a linha sem passar pelo lock e o use case lança `WalletVersionConflictError` (transitório, com até 3 retries curtos e uma métrica `wallet_lock_conflicts_total`). É a prova de ausência de lost update, independente da estratégia de lock.
3. **`CHECK (balance_amount >= 0)`** — se tudo acima falhar, o banco não aceita saldo negativo.

Por que pessimista e não só otimista: a carga real de uma wallet quente é *contenção legítima* (várias apostas da mesma rodada chegando juntas). Com otimista puro, todas leem a mesma versão, uma ganha e as outras repetem — numa wallet com 200 req/s isso vira tempestade de retry. Com `FOR UPDATE` elas esperam na ordem, cada uma vê o saldo já atualizado e decide certo na primeira tentativa. O custo é latência proporcional à fila daquela wallet (visível no teste de carga: p50 de 104 ms na wallet quente contra 10 ms nas frias), e nunca correção.

**Ordem de locks.** Sempre `wallet → transação`. O worker de referências pendentes faz o *claim* em uma transação curta (`UPDATE ... WHERE id IN (SELECT ... FOR UPDATE SKIP LOCKED)` + lease de 60 s) e só depois, em outra transação, trava a wallet e relê a transação `FOR UPDATE`. O caminho principal, ao processar uma transação, "acorda" dependentes com um `UPDATE` em linhas `PENDING_REFERENCE` já segurando o lock da wallet — mesma ordem, sem ciclo. Se mesmo assim o Postgres detectar deadlock (`40P01`), vira erro transitório e repete.

**Leitura dentro da transação.** Em `READ COMMITTED`, cada statement enxerga o que já foi commitado; depois de adquirir o `FOR UPDATE` (que espera a transação concorrente terminar), a re-checagem de idempotência vê a transação que acabou de ser inserida. Por isso a dedup funciona mesmo com 50 requisições idênticas chegando ao mesmo tempo: a primeira insere, as outras 49 encontram.

## 6. Idempotência

- O header `Idempotency-Key` é obrigatório e é a chave (`UNIQUE`). Na fila, `data.idempotencyKey`. O default recomendado é `"{providerId}:{externalTransactionId}"`, mas o par `(providerId, externalTransactionId)` é `UNIQUE` por si só; mandar o mesmo `externalTransactionId` com outra key é `409 IDEMPOTENCY_CONFLICT`.
- **`payloadHash`** = SHA-256 (hex) do JSON canônico dos campos de negócio: `providerId, externalTransactionId, playerId, walletId, roundId, gameId, kind, money{amount,currency}, referenceExternalTransactionId` (omitido se ausente). Canônico = chaves ordenadas recursivamente, sem espaços, `undefined` fora. O `amount` é normalizado para escala 2 antes (`"25.5"` e `"25.50"` são o mesmo payload). Header, `messageId`, `occurredAt` e qualquer metadado de transporte não entram ([`payload-hash.ts`](./src/application/wagering/payload-hash.ts)).
- Mesma key + mesmo hash → replay: devolve o resultado gravado (status, `failureCode`, `balanceAfter`) com `idempotentReplay: true`. Mesma key + hash diferente → `409`, nada é gravado.
- Replay de uma `PENDING_REFERENCE` que depois foi resolvida devolve o estado atual (`PROCESSED`/`REJECTED`). Interpretei "resultado original" como o resultado daquela transação, não a foto do `202` — a transação é a mesma, só avançou.
- O caminho tem um atalho: antes de abrir a transação, consulta a key sem lock. Replay conhecido não disputa o lock da wallet. Se não encontra, entra na transação e **re-checa com o lock** — é essa segunda checagem que fecha a corrida.
- **Inbox**: `(consumerName, messageId)` do envelope, não o `MessageId` do SQS (que muda a cada reenvio). `INSERT ... ON CONFLICT DO NOTHING RETURNING` na mesma transação do efeito; se a transação concorrente ainda não commitou, o `INSERT` espera e então reporta conflito. Marco `processed_at` antes do commit (`InboxMessage.markProcessed`). Duplicata via inbox → ack sem reprocessar; duplicata via idempotency key (messageIds diferentes) → replay + inbox registrada para o próximo redelivery ser barato.
- Nada disso vive em memória. O processo pode morrer e voltar que as respostas continuam as mesmas.

## 7. Regras de negócio e interpretações adotadas

A tabela do enunciado está implementada em [`process-wager-transaction.use-case.ts`](./src/application/wagering/process-wager-transaction.use-case.ts) e [`wager-rules.ts`](./src/application/wagering/wager-rules.ts). Onde o enunciado deixava escolha, decidi assim:

1. **Valor sempre positivo** para qualquer kind submetido (zero é `400`). Um `WIN` de `0.00` é um `LOSS`.
2. **`WIN`/`LOSS` com referência opcional**: se o provedor informa `referenceExternalTransactionId`, ela é validada como qualquer outra (precisa ser `BET` do mesmo player/wallet/rodada/moeda e `PROCESSED`); ausente → `PENDING_REFERENCE`, igual a uma reversão. Sem referência, processa direto. Valor de `WIN` pode diferir da `BET` (não é reversão).
3. **Uma referência só pode ser revertida uma vez, por qualquer tipo.** O enunciado diz "pelo mesmo tipo de operação"; li de forma conservadora: `REFUND` da `BET X` seguido de `ROLLBACK` da mesma `BET X` creditaria duas vezes, então bloqueio (`REFERENCE_ALREADY_REVERSED`). O índice único parcial garante isso no banco. `ROLLBACK` de um `REFUND` continua permitido (é outra referência).
4. **`ROLLBACK` só de `BET`, `WIN` ou `REFUND`**; de `LOSS` ou `ROLLBACK` → `REFERENCE_KIND_NOT_ALLOWED` (não há saldo a desfazer).
5. **Referência `REJECTED`/`FAILED`** → `REFERENCE_NOT_PROCESSED`, imediato. Referência `PENDING`/`PENDING_REFERENCE` → espera.
6. **Reversão que deixaria saldo negativo** (`ROLLBACK` de `WIN`/`REFUND` já gasto) → `REVERSAL_INSUFFICIENT_FUNDS`, distinto de `INSUFFICIENT_FUNDS`, persistida e com evento. É um caso para operações, não para o jogo.
7. **`REJECTED` é persistida** com o saldo observado: audita, replay funciona, evento sai. Não gera ledger nem muda `version`.
8. **`LOSS`** vira `PROCESSED`, sem lançamento, sem `WalletBalanceChanged`, com `WagerTransactionProcessed`.
9. **Wallet inexistente** → `404` e nada é persistido (não há agregado para ancorar a transação; o resultado é determinístico, então reenviar dá a mesma resposta). `playerId` que não é dono da wallet → `REJECTED PLAYER_WALLET_MISMATCH` (a wallet existe, então fica registrado).
10. **Moeda diferente da wallet** → `REJECTED CURRENCY_MISMATCH` (persistida). O sistema aceita qualquer ISO-4217 e um player pode ter uma wallet por moeda; os testes usam BRL e provam o conflito com USD.
11. **`FAILED`** é usado pelo worker de referências pendentes quando o reprocessamento esbarra num erro permanente (constraint inesperada, bug): a transação para em `FAILED INFRASTRUCTURE_FAILURE` com evento `WagerTransactionFailed`, em vez de ficar presa para sempre. No caminho HTTP/SQS um erro permanente antes do commit não deixa transação (rollback), então não há o que marcar.
12. **Quem espera por uma referência é acordado em qualquer desfecho dela** (`PROCESSED` ou `REJECTED`), não só no sucesso — senão um `ROLLBACK` de uma `BET` rejeitada esperaria o backoff inteiro para descobrir que vai ser rejeitado.

### 7.1 Referências fora de ordem

- A transação é persistida como `PENDING_REFERENCE` com `balanceAfter` = saldo observado, evento `WagerTransactionPendingReference`, resposta `202`.
- O `PendingReferenceWorker` roda em todas as instâncias (poll de 1 s): claim com `FOR UPDATE SKIP LOCKED` + lease de 60 s (`next_reference_retry_at = now + 60s`, para outra instância não pegar a mesma enquanto esta processa; se o processo morrer, o lease expira e alguém pega), depois reprocessa cada uma com o lock da wallet, relendo a transação e conferindo que ainda está pendente.
- **Backoff**: `5s · 2^(n-1)`, teto de 300 s, **8 tentativas** → ~15 min de espera total. Justificativa: a referência atrasada legítima vem de reentrega do SQS (visibility 30 s × até 5 recebimentos) ou de uma indisponibilidade curta; o que não apareceu em 15 minutos é muito mais provavelmente um id errado, e o provedor precisa saber. Configurável por env (`PENDING_REFERENCE_*`).
- **Wake-up**: ao processar qualquer transação, o use case faz `UPDATE ... SET next_reference_retry_at = now()` nas pendentes que a referenciam. Na prática a resolução acontece no próximo tick do worker (~1 s), não no próximo passo do backoff. O teste de concorrência prova isso com backoff de 60 s configurado.
- **Esgotou**: `REJECTED REFERENCE_NOT_FOUND` + `WagerTransactionRejected`.

### 7.2 Códigos de falha

Persistidos em `failure_code`, devolvidos no corpo (`422`) e no evento `WagerTransactionRejected`:

| Código | Situação | O que o provedor faz |
|---|---|---|
| `INSUFFICIENT_FUNDS` | `BET` sem saldo | não reenvia |
| `REVERSAL_INSUFFICIENT_FUNDS` | `ROLLBACK` de `WIN`/`REFUND` deixaria a wallet negativa | aciona operações |
| `CURRENCY_MISMATCH` | moeda diferente da wallet | corrige o payload |
| `PLAYER_WALLET_MISMATCH` | wallet não pertence ao player | corrige o payload |
| `REFERENCE_NOT_FOUND` | referência não apareceu dentro do limite | confere o id; reenvia com id correto e novo `externalTransactionId` |
| `REFERENCE_KIND_NOT_ALLOWED` | `REFUND` de não-`BET`, `ROLLBACK` de `LOSS`/`ROLLBACK`... | corrige |
| `REFERENCE_MISMATCH` | referência de outro player/wallet/rodada/moeda | corrige |
| `REFERENCE_NOT_PROCESSED` | referência foi `REJECTED`/`FAILED` | não reenvia |
| `REFERENCE_ALREADY_REVERSED` | já houve reversão `PROCESSED` | não reenvia |
| `REFERENCE_AMOUNT_MISMATCH` | reversão com valor diferente da referência | corrige (reversão parcial fora de escopo) |
| `INFRASTRUCTURE_FAILURE` | status `FAILED` (erro permanente ao reprocessar) | aciona operações |

Erros que **não** viram transação (vão no `error.code` da resposta ou no `failureReason` da DLQ): `VALIDATION_ERROR` (com `details.code = IDEMPOTENCY_KEY_MISSING` quando é o header), `WALLET_NOT_FOUND`, `TRANSACTION_NOT_FOUND`, `WALLET_ALREADY_EXISTS`, `IDEMPOTENCY_CONFLICT`, `SERVICE_UNAVAILABLE`, `INTERNAL_ERROR`, `UNAUTHORIZED`, `PROVIDER_MISMATCH`, `INVALID_MESSAGE`, `RETRIES_EXHAUSTED`.

## 8. HTTP

Mapeamento único em [`app-exception.filter.ts`](./src/infrastructure/http/app-exception.filter.ts), a partir da categoria do erro (`validation | not_found | conflict | transient | permanent`):

| Situação | HTTP |
|---|---|
| payload inválido / header faltando | `400` |
| sem token / token inválido (modo `oidc`) | `401`; provider do token ≠ payload → `403` |
| wallet/transação inexistente | `404` |
| wallet duplicada; idempotency key com payload diferente | `409` |
| transação aceita e pendente de referência | `202` |
| rejeição por regra de negócio | `422` (corpo normal, com `failureCode`) |
| falha transitória (Postgres/SQS, lock timeout) | `503` + `Retry-After: 1` |
| erro permanente / inesperado | `500` |

Rejeição de negócio em `422` e não `200`: a transação **foi** registrada (é um resultado), mas o provedor consegue separar "aplicou" de "não aplicou" pelo status sem ler o corpo. Replay mantém o status original (`422` de novo, `idempotentReplay: true`).

## 9. SQS

[`sqs-wager-consumer.ts`](./src/infrastructure/sqs/sqs-wager-consumer.ts):

- Long polling (`WaitTimeSeconds` 20), lotes de 10, `VisibilityTimeout` 30 s passado por `ReceiveMessage`.
- Mensagens do mesmo `MessageGroupId` são processadas em série; grupos diferentes, em paralelo. Isso respeita a ordem que o provedor escolheu ao usar `walletId` como grupo, mas é **otimização**: a correção vem do lock no banco. Grupo errado ou ausente não quebra nada.
- Chama o mesmo use case da API, com `inbox` no contexto.
- **Ack depois do commit.** O `DeleteMessage` só roda quando `execute()` retornou — e `execute()` só retorna depois do `COMMIT`. O ponto de injeção de falha `sqs:after-commit-before-ack` fica exatamente entre os dois para o teste de crash.
- **Classificação de erros**:
  - *negócio* (`REJECTED`): não é erro — já está no banco, ack;
  - *transitório* (`TransientInfrastructureError`: conexão, `lock_timeout`, deadlock, serialização, conflito de versão, e qualquer erro desconhecido): `ChangeMessageVisibility` para `min(2^recebimentos, 300)` s; ao atingir `SQS_MAX_RECEIVE_COUNT` (5), move para a DLQ com `failureReason = RETRIES_EXHAUSTED`. A redrive policy da fila é o backstop caso o processo nem consiga fazer isso;
  - *permanente* (`validation`, `not_found`, `conflict`, `permanent`, erros de domínio): `SendMessage` na DLQ com `failureReason`/`failureDetail`/`originalMessageId` e então `DeleteMessage`. Se a DLQ falhar, não apaga: a visibilidade expira e tenta de novo.
- **SIGTERM** (`enableShutdownHooks` + `beforeApplicationShutdown`): aborta o long poll, espera as mensagens em andamento até `SHUTDOWN_GRACE_MS` (20 s), e devolve a visibilidade (`VisibilityTimeout: 0`) do que não terminou para outra instância pegar na hora. Os workers de outbox e referências esperam a iteração corrente e param.
- SQS indisponível no `ReceiveMessage`: backoff de 0,5 s a 15 s no loop, sem derrubar o processo; `/health/ready` reporta `sqs: down`.

## 10. Outbox

[`publish-outbox.use-case.ts`](./src/application/outbox/publish-outbox.use-case.ts), rodando no `OutboxPublisherWorker` de todas as instâncias (poll de 500 ms, imediato enquanto houver lote cheio):

```
BEGIN
  SELECT ... FROM outbox_messages WHERE published_at IS NULL AND (next_attempt_at IS NULL OR <= now)
    ORDER BY occurred_at LIMIT 50 FOR UPDATE SKIP LOCKED
  SendMessageBatch (lotes de 10) → wagering-events.fifo
  por mensagem: sucesso → published_at = now; falha → attempts+1, next_attempt_at = now + min(1s·2^(n-1), 5min)
COMMIT
```

- **Múltiplos publishers**: `SKIP LOCKED` faz cada um pegar linhas diferentes. Dois processos dividiram 500 eventos 250/250 no teste, sem repetição.
- **Crash entre publicar e commitar**: a linha volta a ficar pendente e é publicada de novo. É at-least-once por desenho; a defesa contra a duplicata é em camadas: `MessageDeduplicationId = eventId` (o SQS FIFO descarta repetições por 5 min) e o `eventId` no envelope para o consumidor deduplicar sempre. O teste de integração simula exatamente isso.
- **Nunca desiste**: evento financeiro não vai para o lixo porque o broker caiu; o backoff tem teto e a métrica de tentativas/lag é o alarme. `outbox_pending_messages` e `outbox_oldest_pending_age_seconds` são gauges atualizados a cada 5 s; `outbox_lag_seconds` é histograma por evento publicado.
- A transação fica aberta enquanto o `SendMessageBatch` roda (timeout de 10 s no cliente). É simples e correto; o custo é uma conexão do pool presa por até esse tempo quando o SQS está lento. Ver limitações.

## 11. Observabilidade

- **Logs** em JSON (pino), uma linha por evento, com `correlationId`, `messageId`, `transactionId`, `walletId`, `providerId` e `source`. Os campos vêm de um `AsyncLocalStorage` aberto pelo middleware HTTP ou pelo consumidor SQS, e entram automaticamente em toda linha (sem repetir o que já veio do child logger). Nenhum valor monetário nem payload vai para o log: só ids, kind, status, versão. Há uma lista de `redact` como cinto e suspensório.
- **Métricas** (`/metrics`, prom-client): `wager_transactions_total{kind,status,source}`, `wager_idempotent_replays_total{source}`, `wager_inbox_duplicates_total`, `wallet_lock_conflicts_total{reason}`, `wallet_lock_wait_seconds`, `wager_processing_duration_seconds{source,kind}`, `pending_reference_retries_total{outcome}`, `outbox_published_total`, `outbox_publish_failures_total`, `outbox_lag_seconds`, `outbox_pending_messages`, `outbox_oldest_pending_age_seconds`, `sqs_retries_total`, `sqs_dead_lettered_total{reason}`, `sqs_messages_acked_total`, `wallet_reconciliation_divergences_total`, mais as default do processo.
- **Health**: `/health/live` sempre `200`; `/health/ready` faz `SELECT 1` e `GetQueueAttributes` com timeout de 2 s e devolve `503` com o detalhe do que falhou. Nenhum dos dois passa pelo guard de auth.
- **Reconciliação**: `POST /wallets/:id/reconciliation` reconstrói o saldo em `REPEATABLE READ` (snapshot único, sem lock — não atrapalha o processamento), confere a cadeia `balanceBefore/balanceAfter`, a aritmética de cada lançamento e a versão. Divergência: `consistent: false`, `issues[]` (`BALANCE_MISMATCH`, `VERSION_MISMATCH`, `BROKEN_CHAIN`, `UNBALANCED_ENTRY`), log `error`, métrica. Nada é corrigido por baixo dos panos.

## 12. Autenticação

Não vale pontos, então dimensionei para não competir com o resto — mas não deixei um `return true` solto. O que existe:

- [`ProviderAuthGuard`](./src/infrastructure/http/auth/provider-auth.guard.ts) nos controllers de wallets, wagering e providers (health e metrics ficam fora). Com `AUTH_MODE=none` (default) ele passa tudo; com `AUTH_MODE=oidc` exige `Authorization: Bearer <JWT>` emitido por um IdP externo e valida assinatura via **JWKS** (`AUTH_JWKS_URL`), `iss` (`AUTH_ISSUER`) e `aud` (`AUTH_AUDIENCE`), extraindo o provedor de uma claim configurável (`AUTH_PROVIDER_CLAIM`, default `azp`).
- A identidade do token é cruzada com o `providerId` do payload (`403 PROVIDER_MISMATCH` se diferente) e com o `:providerId` das consultas. O token diz quem é; o domínio continua validando o resto.
- Testado de ponta a ponta com um JWKS servido localmente e tokens assinados com `jose` (issuer errado, expirado, scheme errado, provider diferente).

O que **não** fiz: subir o Keycloak no compose. O desenho que adotaria com ele:

- um realm `wagering`; um *client* confidencial por provedor (`provider-a`, `provider-b`...) com *client credentials* (fluxo máquina-a-máquina — provedores de jogo são serviços, não pessoas);
- `azp` (= client id) identifica o provedor; um *audience mapper* coloca `wagering-processor` em `aud`;
- `AUTH_ISSUER=http://keycloak:8080/realms/wagering`, `AUTH_JWKS_URL=.../protocol/openid-connect/certs`, `AUTH_MODE=oidc`. Zero mudança de código.
- Mensagens da fila continuam sendo canal interno confiável (quem publica já foi autenticado antes); o `providerId` da mensagem segue sujeito às mesmas validações de domínio.

Motivo de deixar o Keycloak fora: ele adiciona ~1 min ao boot do compose e um realm JSON para manter, por uma parte que o enunciado explicitamente diz não avaliar. O ponto de extensão está lá e exercitado.

## 13. Testes

- **Unidade** (`test/unit`, sem infra): domínio e o use case completo sobre um `UnitOfWork` em memória com snapshot/rollback. É onde as regras de negócio estão escritas como especificação.
- **Integração** (`test/integration`): Postgres e LocalStack reais. Nada de mock de banco ou de fila. Schema, atomicidade, inbox, outbox, retry/DLQ, SIGTERM, restart, API, auth.
- **Concorrência** (`test/concurrency`): `Promise.all` de requisições HTTP de verdade contra a aplicação, mensagens de verdade na fila, e para "múltiplas instâncias" e "crash" **processos separados** (`Bun.spawn` de `src/main.ts`), inclusive `kill -9`. O ponto de falha "depois do commit, antes do ack" é a variável `FAULT_INJECTION`, que em produção não existe e no código é um `if` que chama `process.exit(137)`.
- Invariante final em tudo que toca saldo: `assertWalletConsistent` (saldo == ledger, cadeia fechada, versão bate).
- Cada suíte cria filas próprias no LocalStack (`<nome>-<runId>-<suite>.fifo`) e as apaga no fim; o banco de teste é truncado por arquivo.

## 14. Operação

- Instâncias são idênticas; escalar é subir mais réplicas. Papéis desligáveis por env se um dia valer separar API de workers.
- Migrations rodam no serviço one-shot `migrate` antes das instâncias (`depends_on: service_completed_successfully`), para três processos não disputarem a tabela de migrations no boot. Reversão: `bun run migration:down`.
- Pool de 10 conexões por instância (`DB_POOL_MAX`). Com `FOR UPDATE` serializando a wallet quente, mais conexões não ajudam a quente e atrapalham as frias; o teste de carga foi feito com esse valor.
- Shutdown gracioso em todos os workers; `restart: unless-stopped` no compose.

## 15. Limitações conhecidas e o que faria depois

Sendo honesto sobre o que ficou de fora ou simplificado:

1. **Outbox segura a transação durante a chamada ao SQS.** Alternativa mais sofisticada: *claim* com lease (como fiz no worker de referências) e commit curto, publicando fora da transação. Preferi a versão simples e provadamente correta; o custo aparece só quando o SQS está lento (conexões presas até 10 s).
2. **Latência da wallet quente cresce com a contenção** (p99 ~400 ms a ~190 req/s numa única wallet no teste de carga). É o preço do lock pessimista. Se uma única wallet precisasse de mais que isso, o próximo passo seria *batching* de operações da mesma wallet dentro de uma transação (processar o lote do mesmo `MessageGroupId` sob um único lock), que o consumidor SQS já deixa encaminhado ao agrupar por grupo.
3. **FIFO do SQS real tem limites** (300 msg/s por grupo sem batching, 3.000 com) que o LocalStack não simula. O desenho não depende da FIFO para correção, então uma fila standard funcionaria; perderia a ordem por wallet como otimização.
4. **Sem OpenTelemetry/tracing distribuído e sem dashboard.** Os logs têm `correlationId` ponta a ponta e as métricas estão expostas; faltaria um collector e um Grafana. Opcionais no enunciado.
5. **Ledger de entrada única, não partidas dobradas.** `WalletLedgerEntry` registra uma perna (a da wallet). Partidas dobradas exigiriam contas do provedor/casa e um lançamento espelho; era diferencial opcional e não entrou.
6. **`FAILED` é pouco exercitado.** Só o worker de referências pendentes produz esse estado, e em testes ele é difícil de provocar sem corromper o banco. A transição e a constraint estão cobertas; o caminho operacional não.
7. **Reconciliação pagina dentro de uma transação `REPEATABLE READ`.** Em uma wallet com milhões de lançamentos isso é uma transação longa; para esse volume eu faria por faixas de `wallet_version` com checkpoints.
8. **Sem rate limiting nem quotas por provedor**, e a DLQ não tem ferramenta de *redrive* (é `awslocal`/console na mão).
9. **Keycloak não está no compose** (seção 12).
10. **Teste de carga é local** (Docker Desktop no mesmo laptop que gera a carga). Os números servem para comparar hot vs. cold e para provar consistência sob pressão, não como capacidade de produção. Metodologia e análise em [`docs/LOAD_TEST.md`](./docs/LOAD_TEST.md).

# Teste de carga

Comando: `bun run test:load` ([`scripts/load-test.ts`](../scripts/load-test.ts)). Resultado bruto da execução descrita aqui: [`load-test-results/2026-10-23-compose-3-instances.json`](./load-test-results/2026-10-23-compose-3-instances.json).

## Ambiente

- MacBook com Apple M4 (10 cores), 16 GB; macOS 26.6.
- Docker Desktop com 10 CPUs e ~8 GB alocados. **Tudo no mesmo laptop**: Postgres 16, LocalStack 3.8, as 3 instâncias da aplicação, o nginx e o gerador de carga. Os números são de ambiente compartilhado — servem para comparar comportamentos (wallet quente vs. frias, lag do outbox), não como capacidade de produção.
- Stack exatamente a do `docker compose up -d --build` (3 instâncias atrás do nginx, cada uma com consumidor SQS, publisher do outbox e worker de referências ligados; pool de 10 conexões por instância).

## Metodologia

- 50 wallets com `10000.00 BRL`; uma delas é a **quente** e recebe 20% de todo o tráfego, as outras 49 dividem os 80% restantes.
- 32 clientes HTTP concorrentes em loop fechado (cada um dispara a próxima requisição assim que a anterior responde), durante 30 s, contra `http://localhost:3000` (nginx round-robin).
- Mix: 70% `BET 1.00`, 25% `WIN 1.00`, 5% `LOSS`; 5% das requisições são **reenvios** de uma operação anterior (mesma `Idempotency-Key`), para medir o caminho de replay junto.
- Latência medida no cliente (inclui nginx). Conflitos de lock, lock wait, lag do outbox e tempo de processamento vêm do `/metrics` das três instâncias (deltas antes/depois).
- No fim: espera o outbox esvaziar (`outbox_pending_messages == 0` nas três instâncias) e chama `POST /wallets/:id/reconciliation` em todas as 50 wallets. O script falha se qualquer uma estiver inconsistente.

## Resultados (2026-10-23, run `load-mvl0lu2p`)

| Métrica | Valor |
|---|---|
| requisições | 26 267 (todas `200 PROCESSED`; 1 303 delas replays idempotentes) |
| throughput | **874 req/s** |
| erro (5xx/transporte) | **0** |
| latência geral p50 / p95 / p99 / max | 12,8 / 183,1 / 287,2 / 621,1 ms |
| wallet quente (5 716 req, ~190 req/s) p50 / p95 / p99 | **103,9 / 277,9 / 406,6 ms** |
| wallets frias (20 551 req) p50 / p95 / p99 | **9,9 / 40,9 / 69,5 ms** |
| `wallet_lock_conflicts_total` | 0 |
| `wallet_lock_wait_seconds` p95 / p99 | 215 / 266 ms |
| `wager_processing_duration_seconds` p95 (servidor) | 243 ms |
| eventos publicados (outbox) | 48 674, 0 falhas |
| `outbox_lag_seconds` p50 / p95 / p99 | 64 / 492 / 892 ms |
| outbox pendente no fim / tempo para esvaziar | 0 / 2,0 s |
| reconciliação | **50/50 consistentes** |

## Análise

- **Correção sob carga**: zero erros, zero conflitos de versão, 50 wallets reconciliadas com o ledger depois de 26 mil operações e 1,3 mil replays distribuídos por três processos. É o resultado que importa.
- **A wallet quente é 10× mais lenta que as frias** (p50 104 ms vs. 10 ms), e isso é o lock pessimista fazendo o trabalho dele: ~190 operações/s numa única linha são serializadas, cada uma segurando o lock por alguns milissegundos (ida e volta ao banco para ler, inserir ledger/transação/outbox e commitar), e o resto espera na fila do `FOR UPDATE`. O `wallet_lock_wait_seconds` p95 de 215 ms é praticamente a latência p95 da wallet quente — a espera é quase toda lock, não CPU. Para uma wallet com esse perfil o próximo passo seria agrupar operações do mesmo grupo numa transação só (ver limitações no ARCHITECTURE.md).
- **Zero conflitos de lock** confirma a tese do desenho: com `FOR UPDATE` as transações esperam em vez de abortar, e o `UPDATE ... WHERE version = ?` nunca falhou — ou seja, ninguém alterou a wallet por fora do lock.
- **Outbox**: 48,7 mil eventos (≈1,85 por operação: `WagerTransactionProcessed` + `WalletBalanceChanged`, menos os `LOSS` e os replays) publicados por três publishers concorrentes com `SKIP LOCKED`, lag p50 de 64 ms e p99 abaixo de 1 s *durante* a carga, backlog zero 2 s depois que ela parou.
- **Latência geral**: p50 de 13 ms com 32 clientes num laptop compartilhado é razoável; o p95/p99 geral é puxado pela wallet quente (20% do tráfego). As frias ficam em 41 ms de p95 mesmo com o banco, o broker e o gerador de carga dividindo os mesmos 10 cores.
- **O que isto não mede**: ingestão pela fila (o teste é só HTTP — a fila é exercitada pelos testes de concorrência), latência de rede real, limites do SQS real (o LocalStack não aplica o throughput por grupo da FIFO), nem comportamento com Postgres em outra máquina.

## Reproduzindo

```bash
docker compose up -d --build
LOAD_DURATION_S=30 LOAD_CONCURRENCY=32 bun run test:load
# variáveis: LOAD_BASE_URL, LOAD_METRICS_URLS, LOAD_WALLETS, LOAD_HOT_RATIO, LOAD_REPLAY_RATIO
```

O JSON gerado fica em `load-test-results/<run>.json` (ignorado pelo git; o desta execução foi copiado para `docs/load-test-results/`).

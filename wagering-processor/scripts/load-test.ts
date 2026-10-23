/**
 * Teste de carga (bun run test:load).
 *
 * Gera tráfego HTTP de apostas contra a API (por padrão o balanceador do
 * docker-compose em :3000, com 3 instâncias atrás), mede latências e taxa de
 * erro no cliente, e lê dos endpoints /metrics das instâncias o que só o
 * servidor sabe: conflitos de lock e lag do outbox. No fim reconcilia todas as
 * wallets — carga sem reconciliação não prova nada.
 *
 * Variáveis:
 *   LOAD_BASE_URL       http://localhost:3000
 *   LOAD_METRICS_URLS   http://localhost:3001,http://localhost:3002,http://localhost:3003
 *   LOAD_DURATION_S     30
 *   LOAD_CONCURRENCY    32      clientes simultâneos
 *   LOAD_WALLETS        50      wallets "frias"
 *   LOAD_HOT_RATIO      0.2     fração do tráfego que cai numa única wallet quente
 *   LOAD_REPLAY_RATIO   0.05    fração de reenvios (mesma idempotency key)
 */
const BASE_URL = process.env.LOAD_BASE_URL ?? 'http://localhost:3000';
const METRICS_URLS = (process.env.LOAD_METRICS_URLS ?? 'http://localhost:3001,http://localhost:3002,http://localhost:3003').split(',').filter(Boolean);
const DURATION_S = Number(process.env.LOAD_DURATION_S ?? 30);
const CONCURRENCY = Number(process.env.LOAD_CONCURRENCY ?? 32);
const WALLETS = Number(process.env.LOAD_WALLETS ?? 50);
const HOT_RATIO = Number(process.env.LOAD_HOT_RATIO ?? 0.2);
const REPLAY_RATIO = Number(process.env.LOAD_REPLAY_RATIO ?? 0.05);

export {};

interface Sample {
  ms: number;
  status: number;
  kind: string;
  replay: boolean;
  outcome: string;
  hot: boolean;
}

interface Wallet {
  index: number;
  playerId: string;
  walletId: string;
  seq: number;
}

const run = `load-${Date.now().toString(36)}`;
const providerId = `load-${run}`;

async function createWallets(n: number): Promise<Wallet[]> {
  const out: Wallet[] = [];
  for (let i = 0; i < n; i++) {
    const playerId = crypto.randomUUID();
    const res = await fetch(`${BASE_URL}/wallets`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ playerId, initialBalance: { amount: '10000.00', currency: 'BRL' } }),
    });
    if (res.status !== 201) throw new Error(`createWallet failed: ${res.status} ${await res.text()}`);
    const body = (await res.json()) as { id: string };
    out.push({ index: i, playerId, walletId: body.id, seq: 0 });
  }
  return out;
}

function pickKind(): string {
  const r = Math.random();
  if (r < 0.7) return 'BET';
  if (r < 0.95) return 'WIN';
  return 'LOSS';
}

async function scrapeMetrics(): Promise<Record<string, number>> {
  const totals: Record<string, number> = {};
  for (const url of METRICS_URLS) {
    try {
      const text = await fetch(`${url}/metrics`).then((r) => r.text());
      for (const line of text.split('\n')) {
        if (!line || line.startsWith('#')) continue;
        const m = /^([a-zA-Z_:][a-zA-Z0-9_:]*)(\{[^}]*\})?\s+([0-9.eE+-]+|NaN)$/.exec(line);
        if (!m) continue;
        const key = m[1]! + (m[2] ?? '');
        totals[key] = (totals[key] ?? 0) + Number(m[3]);
      }
    } catch {
      /* instância fora do ar: ignora */
    }
  }
  return totals;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)]!;
}

/** p-ésimo percentil estimado a partir dos buckets de um histograma Prometheus. */
function histogramPercentile(metrics: Record<string, number>, name: string, p: number): number | null {
  const buckets = Object.entries(metrics)
    .filter(([k]) => k.startsWith(`${name}_bucket{`))
    .map(([k, v]) => ({ le: Number(/le="([^"]+)"/.exec(k)?.[1]?.replace('+Inf', 'Infinity')), count: v }))
    .sort((a, b) => a.le - b.le);
  const total = buckets.find((b) => b.le === Infinity)?.count ?? 0;
  if (!total) return null;
  const target = (p / 100) * total;
  let prevLe = 0;
  let prevCount = 0;
  for (const b of buckets) {
    if (b.count >= target) {
      if (b.le === Infinity) return prevLe;
      const frac = b.count === prevCount ? 1 : (target - prevCount) / (b.count - prevCount);
      return prevLe + (b.le - prevLe) * frac;
    }
    prevLe = b.le;
    prevCount = b.count;
  }
  return prevLe;
}

async function main() {
  console.log(`# load test ${run}`);
  console.log(`target=${BASE_URL} duration=${DURATION_S}s concurrency=${CONCURRENCY} wallets=${WALLETS} hotRatio=${HOT_RATIO} replayRatio=${REPLAY_RATIO}`);

  const health = await fetch(`${BASE_URL}/health/ready`);
  if (health.status !== 200) throw new Error(`target not ready: ${health.status}`);

  const wallets = await createWallets(WALLETS);
  const hot = wallets[0]!;
  const before = await scrapeMetrics();

  const samples: Sample[] = [];
  const sent: { wallet: Wallet; ext: string; kind: string; amount: string }[] = [];
  let transportErrors = 0;
  const deadline = Date.now() + DURATION_S * 1000;
  const startedAt = Date.now();

  async function worker() {
    while (Date.now() < deadline) {
      let replay = false;
      let op: { wallet: Wallet; ext: string; kind: string; amount: string };
      if (sent.length > 100 && Math.random() < REPLAY_RATIO) {
        op = sent[Math.floor(Math.random() * sent.length)]!;
        replay = true;
      } else {
        const wallet = Math.random() < HOT_RATIO ? hot : wallets[Math.floor(Math.random() * wallets.length)]!;
        const kind = pickKind();
        wallet.seq++;
        op = { wallet, ext: `w${wallet.index}-${wallet.seq}`, kind, amount: '1.00' };
        sent.push(op);
      }
      const t0 = performance.now();
      try {
        const res = await fetch(`${BASE_URL}/wagering/transactions`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'idempotency-key': `${providerId}:${op.ext}` },
          body: JSON.stringify({
            providerId,
            externalTransactionId: op.ext,
            playerId: op.wallet.playerId,
            walletId: op.wallet.walletId,
            roundId: `round-${op.ext}`,
            gameId: 'load',
            kind: op.kind,
            money: { amount: op.amount, currency: 'BRL' },
          }),
        });
        const body = (await res.json()) as { status?: string; idempotentReplay?: boolean; error?: { code: string } };
        samples.push({ ms: performance.now() - t0, status: res.status, kind: op.kind, replay: body.idempotentReplay ?? false, outcome: body.status ?? body.error?.code ?? String(res.status), hot: op.wallet === hot });
      } catch {
        transportErrors++;
        samples.push({ ms: performance.now() - t0, status: 0, kind: op.kind, replay, outcome: 'TRANSPORT_ERROR', hot: op.wallet === hot });
      }
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  const elapsedS = (Date.now() - startedAt) / 1000;

  // Espera o outbox esvaziar para medir o lag de ponta a ponta.
  const drainStart = Date.now();
  for (;;) {
    const m = await scrapeMetrics();
    if ((m['outbox_pending_messages'] ?? 0) === 0 || Date.now() - drainStart > 60_000) break;
    await Bun.sleep(500);
  }
  await Bun.sleep(1500);
  const after = await scrapeMetrics();

  const latencies = samples.map((s) => s.ms).sort((a, b) => a - b);
  const hotLatencies = samples.filter((s) => s.hot).map((s) => s.ms).sort((a, b) => a - b);
  const coldLatencies = samples.filter((s) => !s.hot).map((s) => s.ms).sort((a, b) => a - b);
  const byOutcome: Record<string, number> = {};
  for (const s of samples) byOutcome[s.outcome] = (byOutcome[s.outcome] ?? 0) + 1;
  const byStatus: Record<string, number> = {};
  for (const s of samples) byStatus[String(s.status)] = (byStatus[String(s.status)] ?? 0) + 1;
  const errors = samples.filter((s) => s.status >= 500 || s.status === 0).length;
  const delta = (k: string) => (after[k] ?? 0) - (before[k] ?? 0);
  const sumKeys = (prefix: string, obj: Record<string, number>) => Object.entries(obj).filter(([k]) => k.startsWith(prefix)).reduce((a, [, v]) => a + v, 0);

  // Reconciliação de todas as wallets: a parte que importa.
  let inconsistent = 0;
  for (const w of wallets) {
    const r = (await fetch(`${BASE_URL}/wallets/${w.walletId}/reconciliation`, { method: 'POST' }).then((x) => x.json())) as { consistent: boolean };
    if (!r.consistent) inconsistent++;
  }

  const report = {
    run,
    target: BASE_URL,
    instances: METRICS_URLS.length,
    config: { durationS: DURATION_S, concurrency: CONCURRENCY, wallets: WALLETS, hotRatio: HOT_RATIO, replayRatio: REPLAY_RATIO },
    requests: samples.length,
    throughputRps: Number((samples.length / elapsedS).toFixed(1)),
    latencyMs: {
      p50: Number(percentile(latencies, 50).toFixed(1)),
      p95: Number(percentile(latencies, 95).toFixed(1)),
      p99: Number(percentile(latencies, 99).toFixed(1)),
      max: Number((latencies[latencies.length - 1] ?? 0).toFixed(1)),
    },
    // wallet quente vs. frias: o lock por wallet serializa só a quente
    hotWalletLatencyMs: { p50: Number(percentile(hotLatencies, 50).toFixed(1)), p95: Number(percentile(hotLatencies, 95).toFixed(1)), p99: Number(percentile(hotLatencies, 99).toFixed(1)), requests: hotLatencies.length },
    coldWalletLatencyMs: { p50: Number(percentile(coldLatencies, 50).toFixed(1)), p95: Number(percentile(coldLatencies, 95).toFixed(1)), p99: Number(percentile(coldLatencies, 99).toFixed(1)), requests: coldLatencies.length },
    byStatus,
    byOutcome,
    errorRate: Number(((errors / Math.max(1, samples.length)) * 100).toFixed(3)),
    transportErrors,
    replays: samples.filter((s) => s.replay).length,
    server: {
      lockConflicts: sumKeys('wallet_lock_conflicts_total', after) - sumKeys('wallet_lock_conflicts_total', before),
      lockWaitP95Ms: (histogramPercentile(after, 'wallet_lock_wait_seconds', 95) ?? 0) * 1000,
      lockWaitP99Ms: (histogramPercentile(after, 'wallet_lock_wait_seconds', 99) ?? 0) * 1000,
      processingP95Ms: (histogramPercentile(after, 'wager_processing_duration_seconds', 95) ?? 0) * 1000,
      outboxPublished: delta('outbox_published_total'),
      outboxPublishFailures: delta('outbox_publish_failures_total'),
      outboxLagP50Ms: (histogramPercentile(after, 'outbox_lag_seconds', 50) ?? 0) * 1000,
      outboxLagP95Ms: (histogramPercentile(after, 'outbox_lag_seconds', 95) ?? 0) * 1000,
      outboxLagP99Ms: (histogramPercentile(after, 'outbox_lag_seconds', 99) ?? 0) * 1000,
      outboxPendingAtEnd: after['outbox_pending_messages'] ?? 0,
      drainS: Number(((Date.now() - drainStart) / 1000).toFixed(1)),
    },
    reconciliation: { wallets: wallets.length, inconsistent },
  };

  const dir = 'load-test-results';
  await Bun.write(`${dir}/${run}.json`, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  console.log(`\nsaved to ${dir}/${run}.json`);
  if (inconsistent > 0) {
    console.error(`!!! ${inconsistent} wallet(s) inconsistent after load`);
    process.exit(1);
  }
}

await main();

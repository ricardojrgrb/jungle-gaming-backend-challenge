// Preload do bun test. Só define defaults de ambiente; conexões com Postgres e
// LocalStack são abertas sob demanda pelos helpers (os testes de unidade não
// precisam de nada disso).
process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL ??= 'silent';
process.env.TEST_DATABASE_URL ??= 'postgres://wagering:wagering@localhost:5432/wagering_test';
process.env.TEST_SQS_ENDPOINT ??= 'http://localhost:4566';

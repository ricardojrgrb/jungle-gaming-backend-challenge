import { defineConfig } from '@mikro-orm/postgresql';
import { Migrator } from '@mikro-orm/migrations';
import { ALL_SCHEMAS } from './entities/records';

export interface OrmConfigOptions {
  clientUrl: string;
  poolMax?: number;
  debug?: boolean;
}

export function buildOrmConfig(options: OrmConfigOptions) {
  return defineConfig({
    clientUrl: options.clientUrl,
    entities: ALL_SCHEMAS,
    extensions: [Migrator],
    debug: options.debug ?? false,
    pool: { min: 0, max: options.poolMax ?? 10 },
    // Sem metadata por reflexão: tudo vem dos EntitySchema acima.
    discovery: { disableDynamicFileAccess: true, requireEntitiesArray: true },
    migrations: {
      path: new URL('./migrations', import.meta.url).pathname,
      glob: '!(*.d).{js,ts}',
      tableName: 'mikro_orm_migrations',
      transactional: true,
      allOrNothing: true,
      snapshot: false,
      emit: 'ts',
    },
    // Fail fast quando o Postgres não está lá: o retry é de quem chamou.
    driverOptions: { connection: { connectionTimeoutMillis: 5_000 } },
  });
}

import { MikroORM } from '@mikro-orm/postgresql';
import { buildOrmConfig } from '../mikro-orm.config';

// bun run migration:up | migration:down | migration:status
const command = process.argv[2] ?? 'status';
const clientUrl = process.env.DATABASE_URL;
if (!clientUrl) {
  console.error('DATABASE_URL is required');
  process.exit(1);
}

const orm = await MikroORM.init(buildOrmConfig({ clientUrl }));
const migrator = orm.getMigrator();
try {
  if (command === 'up') {
    const applied = await migrator.up();
    console.log(`applied ${applied.length} migration(s): ${applied.map((m) => m.name).join(', ') || '-'}`);
  } else if (command === 'down') {
    const reverted = await migrator.down();
    console.log(`reverted ${reverted.length} migration(s): ${reverted.map((m) => m.name).join(', ') || '-'}`);
  } else if (command === 'status') {
    const pending = await migrator.getPendingMigrations();
    const executed = await migrator.getExecutedMigrations();
    console.log(`executed: ${executed.map((m) => m.name).join(', ') || '-'}`);
    console.log(`pending:  ${pending.map((m) => m.name).join(', ') || '-'}`);
  } else {
    console.error(`unknown command "${command}" (use up | down | status)`);
    process.exitCode = 1;
  }
} finally {
  await orm.close(true);
}

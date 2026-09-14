import { loadConfig } from '../config.js';
import { createLogger } from '../logger.js';
import { migrate } from './migrate.js';
import { openDatabase } from './sqlite.js';

const config = loadConfig();
const logger = createLogger(config);
const db = openDatabase({ url: config.dbUrl });

try {
  const result = await migrate(db);
  logger.info({ ...result, dbUrl: config.dbUrl }, 'migrations applied');
} finally {
  await db.close();
}

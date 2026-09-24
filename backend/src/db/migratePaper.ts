import { createPaperDatabaseContext } from "./DatabaseFactory.js";
import { runMigrations } from "./migrations.js";

const context = createPaperDatabaseContext();

try {
  runMigrations(context);
  console.log(`DB MIGRATE: migrated PAPER database at ${context.path}`);
} finally {
  context.close();
}

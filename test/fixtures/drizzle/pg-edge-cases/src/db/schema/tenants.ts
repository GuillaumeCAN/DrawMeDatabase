import { integer, pgTableCreator, text } from 'drizzle-orm/pg-core';

// Every table of a project prefixed (the multi-project schema of the Drizzle docs)
export const createTable = pgTableCreator((name) => `acme_${name}`);

export const tenants = createTable('tenant', {
  id: integer().primaryKey(),
  name: text().notNull(),
});

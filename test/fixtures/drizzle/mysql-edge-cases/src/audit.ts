import { int, mysqlTable, text, timestamp } from 'drizzle-orm/mysql-core';
import { authors } from './schema';

export const auditLog = mysqlTable('audit_log', {
  id: int().primaryKey().autoincrement(),
  authorId: int().references(() => authors.id),
  message: text().notNull(),
  at: timestamp({ fsp: 3 }).defaultNow(),
});

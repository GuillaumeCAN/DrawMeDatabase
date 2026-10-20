import { pgTable, text, varchar } from 'drizzle-orm/pg-core';
import { id, timestamps } from '@/db/columns';

export const users = pgTable('users', {
  id: id(),
  name: varchar({ length: 120 }).notNull(),
  bio: text(),
  ...timestamps,
});

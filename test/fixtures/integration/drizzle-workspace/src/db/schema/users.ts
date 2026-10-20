import { pgTable, serial, text, varchar } from 'drizzle-orm/pg-core';
import { timestamps } from '../columns';

export const users = pgTable('users', {
  id: serial().primaryKey(),
  email: varchar({ length: 320 }).notNull().unique(),
  displayName: text(),
  ...timestamps,
});

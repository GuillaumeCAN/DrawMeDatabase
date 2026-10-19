import { index, integer, pgTable, serial, varchar } from 'drizzle-orm/pg-core';
import { users } from './users';

export const posts = pgTable('posts', {
  id: serial().primaryKey(),
  title: varchar({ length: 200 }).notNull(),
  authorId: integer().notNull().references(() => users.id, { onDelete: 'cascade' }),
}, (t) => [index('posts_author_idx').on(t.authorId)]);

import { integer, pgTable, text } from 'drizzle-orm/pg-core';
import { id } from '@/db/columns';
import * as schema from './index';

export const comments = pgTable('comments', {
  id: id(),
  post_id: integer().notNull().references(() => schema.posts.id),
  author_id: integer().references(() => schema.users.id, { onDelete: 'set null' }),
  body: text().notNull(),
});

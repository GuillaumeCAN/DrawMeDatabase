import { integer, pgEnum, pgTable, text } from 'drizzle-orm/pg-core';
import * as columns from '../../columns';
import { users } from './users';

export const postStatus = pgEnum('post_status', ['draft', 'published']);

export const posts = pgTable('posts', {
  id: columns.id(),
  author_id: integer().notNull().references(() => users.id, { onDelete: 'cascade' }),
  status: postStatus().default('draft').notNull(),
  body: text(),
  ...columns.timestamps,
});

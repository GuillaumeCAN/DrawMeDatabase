import { integer, pgTable, text } from 'drizzle-orm/pg-core';

export const oldPosts = pgTable('old_posts', {
  id: integer().primaryKey(),
  body: text(),
});

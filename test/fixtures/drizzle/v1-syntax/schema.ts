import { defineRelations } from 'drizzle-orm';
import { camelCase, index, integer, pgTable, pgTableCreator, snakeCase, text, timestamp, uuid } from 'drizzle-orm/pg-core';

// drizzle-orm 1.0: the casing of the column names is set on the table
export const users = snakeCase.table('users', {
  id: uuid().primaryKey().defaultRandom(),
  firstName: text().notNull(),
  createdAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
});

export const posts = pgTable.withRLS('posts', {
  id: integer().primaryKey().generatedAlwaysAsIdentity(),
  authorId: uuid().notNull().references(() => users.id, { onDelete: 'cascade' }),
  tags: text().array('[][]'),
}, (t) => [index().on(t.authorId)]);

const audit = snakeCase.schema('audit');

export const events = audit.table('events', {
  eventId: integer().primaryKey(),
  userId: uuid().references(() => users.id),
});

const createTable = pgTableCreator((name) => `app_${name}`, 'snake_case');

export const settings = createTable('settings', {
  settingKey: text().primaryKey(),
  userId: uuid().notNull().references(() => users.id),
});

export const legacy = camelCase.table('legacy', {
  some_value: text(),
});

// Relations of the ORM, not foreign keys
export const relations = defineRelations({ users, posts }, (r) => ({
  users: { posts: r.many.posts() },
  posts: { author: r.one.users({ from: r.posts.authorId, to: r.users.id }) },
}));

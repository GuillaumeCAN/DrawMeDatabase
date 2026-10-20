import { sql } from 'drizzle-orm';
import {
  bigint,
  binary,
  boolean,
  char,
  datetime,
  decimal,
  double,
  index,
  int,
  json,
  mysqlEnum,
  mysqlSchema,
  mysqlTable,
  mysqlTableCreator,
  primaryKey,
  serial,
  text,
  timestamp,
  tinyint,
  uniqueIndex,
  varbinary,
  varchar,
} from 'drizzle-orm/mysql-core';

export const STATUSES = ['draft', 'published', 'archived'] as const;

export const authors = mysqlTable('authors', {
  id: serial().primaryKey(),
  first_name: varchar({ length: 100 }).notNull(), // camelCase: firstName
  email: varchar('email', { length: 191 }).notNull().unique(),
  age: tinyint({ unsigned: true }),
  rating: double({ precision: 5, scale: 2 }).default(0),
  bio: text(),
  avatar: varbinary({ length: 1024 }),
  active: boolean().default(true),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().onUpdateNow().notNull(),
});

export const posts = mysqlTable('posts', {
  id: int().autoincrement().primaryKey(),
  authorId: bigint('author_id', { mode: 'number', unsigned: true }).notNull().references(() => authors.id, { onDelete: 'cascade', onUpdate: 'no action' }),
  title: varchar({ length: 255 }).notNull(),
  slug: char({ length: 12 }).notNull(),
  status: mysqlEnum('status', STATUSES).default('draft').notNull(),
  visibility: mysqlEnum(['public', 'private']).default('public'),
  price: decimal({ precision: 10, scale: 2, unsigned: true }),
  hash: binary({ length: 32 }),
  meta: json().$type<Record<string, string>>().default({}),
  publishedAt: datetime({ mode: 'date', fsp: 3 }),
  views: int().default(sql`(0)`),
}, (table) => [
  uniqueIndex('posts_slug_idx').on(table.slug),
  index('posts_author_status_idx').on(table.authorId, table.status),
]);

const analytics = mysqlSchema('analytics');

export const pageViews = analytics.table('page_views', {
  postId: int('post_id').notNull().references(() => posts.id),
  day: datetime({ mode: 'string' }).notNull(),
  count: int().default(0).notNull(),
}, (t) => [primaryKey({ columns: [t.postId, t.day] })]);

// Every table prefixed by the creator
const legacyTable = mysqlTableCreator((name) => 'legacy_' + name);

export const legacyUsers = legacyTable('users', {
  id: int().primaryKey(),
  authorId: bigint({ mode: 'number', unsigned: true }).references(() => authors.id, { onDelete: 'set null' }),
});

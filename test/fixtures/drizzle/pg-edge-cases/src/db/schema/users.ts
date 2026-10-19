import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  serial,
  text,
  uniqueIndex,
  varchar,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';
import { publicId, softDelete, timestamps } from '../columns.helpers';
import { auth, Plan, planEnum, providerEnum, roleEnum } from './enums';
import { teams } from './teams';

/* A comment with { braces }, ( parentheses ) and "quotes", */
export const users = pgTable(
  'users',
  {
    id: integer().primaryKey().generatedAlwaysAsIdentity({ startWith: 1000 }),
    publicId: publicId(),
    email: varchar({ length: 320 }).notNull(),
    displayName: text(), // snake_case: display_name
    role: roleEnum().default('member').notNull(),
    plan: planEnum('plan_name').default(Plan.Pro),
    balance: numeric({ precision: 12, scale: 2 }).default('0.00'),
    score: integer().default(-1),
    isActive: boolean('active').default(true).notNull(),
    tags: text().array().default(sql`'{}'::text[]`),
    matrix: integer().array().array(),
    settings: jsonb().$type<{ theme: 'dark' | 'light'; beta?: boolean }>().default({ theme: 'light' }),
    teamId: integer().references((): AnyPgColumn => teams.id, { onDelete: 'set null', onUpdate: 'cascade' }),
    invitedBy: integer('invited_by').references((): AnyPgColumn => users.id),
    ...timestamps,
    ...softDelete(),
  },
  (t) => [
    uniqueIndex('users_email_idx').on(sql`lower(${t.email})`),
    index().on(t.teamId, t.createdAt.desc()),
    check('score_check', sql`${t.score} >= -1`),
  ],
);

// The old form of the extra config: an object
export const sessions = pgTable('sessions', {
  token: varchar('token', { length: 64 }).primaryKey(),
  userId: integer('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  expiresAt: integer('expires_at').notNull(),
}, (table) => ({
  userIdx: index('sessions_user_idx').on(table.userId),
}));

// A table of another schema, its enum in that schema too
export const accounts = auth.table('accounts', {
  provider: providerEnum().notNull(),
  providerAccountId: text().notNull(),
  userId: integer().notNull().references(() => users.id, { onDelete: 'cascade' }),
}, (t) => [primaryKey({ columns: [t.provider, t.providerAccountId], name: 'accounts_pk' })]);

// Not exported: drizzle-kit does not create it
const drafts = pgTable('drafts', {
  id: serial('id').primaryKey(),
});

// Exported under another name: created
const archive = pgTable('archive', {
  id: serial().primaryKey(),
  draftId: integer().references(() => drafts.id),
});
export { archive as archivedItems };

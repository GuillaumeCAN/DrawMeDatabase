import { relations } from 'drizzle-orm';
import { bigserial, foreignKey, integer, pgTable, pgView, primaryKey, text, unique, varchar } from 'drizzle-orm/pg-core';
import { users } from './users';
import { timestamps } from '../columns.helpers';

// Circular references: teams.ownerId → users.id, users.teamId → teams.id
export const teams = pgTable('teams', {
  id: bigserial({ mode: 'number' }).primaryKey(),
  name: varchar({ length: 100 }).notNull(),
  slug: varchar({ length: 100 }).notNull().unique('teams_slug_key'),
  ownerId: integer().notNull().references(() => users.id),
  parentId: integer(),
  ...timestamps,
}, (t) => [
  foreignKey({ columns: [t.parentId], foreignColumns: [t.id], name: 'teams_parent_fk' }).onDelete('cascade'),
]);

export const memberships = pgTable('memberships', {
  teamId: integer('team_id').notNull(),
  userId: integer('user_id').notNull(),
  role: text().default('member'),
}, (t) => [
  primaryKey({ columns: [t.teamId, t.userId] }),
  unique('memberships_role_unique').on(t.teamId, t.role),
  foreignKey({ columns: [t.teamId], foreignColumns: [teams.id] }).onDelete('cascade').onUpdate('restrict'),
  foreignKey({ columns: [t.userId], foreignColumns: [users.id] }),
]);

// The deprecated form: primaryKey(t.a, t.b)
export const favorites = pgTable('favorites', {
  userId: integer('user_id').notNull().references(() => users.id),
  teamId: integer('team_id').notNull().references(() => teams.id),
}, (t) => [primaryKey(t.userId, t.teamId)]);

export const teamsRelations = relations(teams, ({ one, many }) => ({
  owner: one(users, { fields: [teams.ownerId], references: [users.id] }),
  memberships: many(memberships),
}));

export const activeTeams = pgView('active_teams').as((qb) => qb.select().from(teams));

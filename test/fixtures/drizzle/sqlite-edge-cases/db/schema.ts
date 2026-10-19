import { sql } from 'drizzle-orm'
import { blob, foreignKey, index, integer, numeric, primaryKey, real, sqliteTable, sqliteTableCreator, text, unique } from 'drizzle-orm/sqlite-core'

// Without semicolons, columns written with their names
export const users = sqliteTable('users', {
  id: integer('id', { mode: 'number' }).primaryKey({ autoIncrement: true }),
  name: text('name', { length: 80 }).notNull(),
  email: text('email').notNull().unique(),
  role: text('role', { enum: ['user', 'admin'] }).default('user').notNull(),
  settings: text('settings', { mode: 'json' }).$type<{ theme: string }>().default({ theme: 'dark' }),
  avatar: blob('avatar', { mode: 'buffer' }),
  score: real('score').default(1.5),
  balance: numeric('balance'),
  isAdmin: integer('is_admin', { mode: 'boolean' }).notNull().default(false),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).defaultNow(),
  managerId: integer('manager_id'),
}, (t) => [
  foreignKey({ columns: [t.managerId], foreignColumns: [t.id] }).onDelete('set null'),
  index('users_name_idx').on(t.name),
])

export const tags = sqliteTable('tags', {
  name: text('name').primaryKey(),
})

export const postTags = sqliteTable('post_tags', {
  postId: integer('post_id').notNull(),
  tag: text('tag').notNull().references(() => tags.name, { onDelete: 'cascade', onUpdate: 'cascade' }),
  addedBy: integer('added_by').references(() => users.id),
}, (t) => [
  primaryKey({ columns: [t.postId, t.tag] }),
  unique().on(t.tag, t.addedBy),
])

const appTable = sqliteTableCreator((name) => `app_${name}`)

export const settings = appTable('settings', {
  key: text('key').primaryKey(),
  value: text('value'),
  userId: integer('user_id').references(() => users.id).unique(),
})

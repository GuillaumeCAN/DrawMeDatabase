import { timestamp, uuid } from 'drizzle-orm/pg-core';

// Columns shared by the tables, spread in their columns: { ...timestamps }
export const timestamps = {
  createdAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp({ withTimezone: true }).$onUpdate(() => new Date()),
};

export const softDelete = () => ({
  deletedAt: timestamp('deleted_at', { mode: 'string' }),
});

// A builder made by a function
export const publicId = (name?: string) => uuid(name ?? 'public_id').defaultRandom().notNull().unique();

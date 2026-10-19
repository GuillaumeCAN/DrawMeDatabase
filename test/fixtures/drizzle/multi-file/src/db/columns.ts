import { integer, timestamp } from 'drizzle-orm/pg-core';

export const id = () => integer().primaryKey().generatedByDefaultAsIdentity();

export const timestamps = {
  created_at: timestamp().notNull().defaultNow(),
  updated_at: timestamp(),
};

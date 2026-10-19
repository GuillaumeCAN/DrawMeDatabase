import { pgEnum, pgSchema } from 'drizzle-orm/pg-core';

export const ROLES = ['member', 'admin', 'owner'] as const;
export const roleEnum = pgEnum('role', ROLES);

export enum Plan {
  Free = 'free',
  Pro = 'pro',
}
// A TypeScript enum: its values
export const planEnum = pgEnum('plan', Plan);

export const auth = pgSchema('auth');
export const providerEnum = auth.enum('provider', ['github', 'google']);

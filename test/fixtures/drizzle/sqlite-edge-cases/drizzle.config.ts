import type { Config } from 'drizzle-kit';

const config = {
  schema: './db/schema.ts',
  out: './migrations',
  dialect: 'sqlite',
  dbCredentials: { url: 'file:local.db' },
} satisfies Config;

export default config;

import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  dialect: 'postgresql',
  schema: './schema.ts',
  // drizzle-kit 1.0 ignores it: the casing is set on the tables
  casing: 'snake_case',
});

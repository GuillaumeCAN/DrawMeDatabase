import { defineConfig } from 'drizzle-kit';

// The schema folder: every file directly in it (the helpers are one level up)
export default defineConfig({
  dialect: 'postgresql',
  schema: './src/db/schema/*.ts',
  out: './drizzle',
  casing: 'snake_case',
  dbCredentials: { url: process.env.DATABASE_URL! },
});

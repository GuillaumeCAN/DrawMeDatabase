import { defineConfig } from 'drizzle-kit';

// The schema folder: every file directly in it, read without running it
export default defineConfig({
  dialect: 'postgresql',
  schema: './src/db/schema/*.ts',
  casing: 'snake_case',
});

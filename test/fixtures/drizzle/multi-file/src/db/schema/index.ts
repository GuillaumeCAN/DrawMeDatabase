// No drizzle.config.ts: the files of src/db/schema are read, and what they re-export
export * from './tables/users';
export { posts, postStatus } from './tables/posts';
// A namespace object: drizzle-kit does not look into it, old_posts is not created
export * as archive from './tables/archive';

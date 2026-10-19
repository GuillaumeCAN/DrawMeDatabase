import { pgView } from 'drizzle-orm/pg-core';
import { posts } from './tables/posts';

export const published = pgView('published_posts').as((qb) => qb.select().from(posts));

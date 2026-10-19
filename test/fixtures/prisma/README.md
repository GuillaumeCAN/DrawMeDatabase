# Prisma fixtures

Projects read by `test/unit/prisma.test.js`. `expected/<fixture>.json` is the exact output of `parsers/prisma.js` with `{ details: true, columnSources: true, git: false }`: it was written by the parser, then checked against `prisma migrate diff --from-empty --to-schema <schema> --script` (Prisma CLI 6.19.1 for the schemas with a datasource `url`, 7.10.1 for the others): the same tables, columns (order, `NOT NULL`, primary keys), unique columns, indexes, foreign keys (columns, referenced table and columns, `ON DELETE` / `ON UPDATE`), implicit many-to-many join tables, enum values, defaults and declared lengths. The only difference is known: the defaults of scalar lists (`@default([])`) are not given.

## Real schemas

Copied as they are (text only), from the commit given. The `package.json` of each project is reduced to its name and its `prisma` and `@prisma/client` packages, the `prisma.config.ts` files are copied as they are.

| Fixture | Project | Source | License |
|---------|---------|--------|---------|
| `cal-diy/` | Cal.diy (formerly Cal.com), PostgreSQL, 100 models, 2 views | [packages/prisma/schema.prisma](https://github.com/calcom/cal.diy/blob/91341cbba403460fac033f95003ce2e2911d4a4e/packages/prisma/schema.prisma), at the root of the fixture (the package folder) | MIT |
| `dub/` | Dub, MySQL, `relationMode = "prisma"`, a multi-file schema of 37 files | [apps/web/prisma/schema/](https://github.com/dubinc/dub/tree/dff810b69dad25c3ad21429b4a011f6c0b2cf4d3/apps/web/prisma/schema) | AGPL-3.0 ([LICENSE.md](https://github.com/dubinc/dub/blob/dff810b69dad25c3ad21429b4a011f6c0b2cf4d3/LICENSE.md)) |
| `umami/` | Umami, PostgreSQL, `relationMode = "prisma"`, `@map` / `@db.*` on most fields | [prisma/schema.prisma](https://github.com/umami-software/umami/blob/b185837063f4d63ffe01f565e5791c69b3c9c424/prisma/schema.prisma), [prisma.config.ts](https://github.com/umami-software/umami/blob/b185837063f4d63ffe01f565e5791c69b3c9c424/prisma.config.ts) (no schema path) | MIT |
| `hoppscotch/` | Hoppscotch backend, PostgreSQL, Prisma 7 | [packages/hoppscotch-backend/prisma/schema.prisma](https://github.com/hoppscotch/hoppscotch/blob/4789a0f2fae484aa7bc1233603d66b97b8ebfd8b/packages/hoppscotch-backend/prisma/schema.prisma), [prisma.config.ts](https://github.com/hoppscotch/hoppscotch/blob/4789a0f2fae484aa7bc1233603d66b97b8ebfd8b/packages/hoppscotch-backend/prisma.config.ts) | MIT |
| `prisma-examples-sql-server/` | Prisma's SQL Server example, a named implicit many-to-many | [databases/sql-server/prisma/schema.prisma](https://github.com/prisma/prisma-examples/blob/51b3202cae5418b54314a2bb53f70b27c6558573/databases/sql-server/prisma/schema.prisma) | Apache-2.0 |
| `prisma-examples-betterauth/` | Prisma's Better Auth example, PostgreSQL, Prisma 7 | [orm/betterauth-nextjs](https://github.com/prisma/prisma-examples/tree/51b3202cae5418b54314a2bb53f70b27c6558573/orm/betterauth-nextjs): `prisma/schema.prisma`, `prisma.config.ts` | Apache-2.0 |

## Hand-made

| Fixture | What it covers |
|---------|----------------|
| `edge-cases/` | PostgreSQL: `@@map` / `@map`, every scalar type, enums with `@map`, `Unsupported("...")` with an escaped quote, native types, lists, every kind of `@default`, `@updatedAt`, `@ignore` / `@@ignore`, named and self relations (one-to-many, one-to-one, many-to-many), referential actions, composite primary and foreign keys, `@@index` of a field written alone, `//`, `///` and `/* */` comments, a view |
| `multi-schema/` | PostgreSQL with `schemas = ["auth", "public"]`: two tables named `users` in two schemas, a join table in the schema of its first model |

To write `expected/` again after a change of the parser, run the parser on each fixture with the options above and check the differences one by one, then against the Prisma CLI.

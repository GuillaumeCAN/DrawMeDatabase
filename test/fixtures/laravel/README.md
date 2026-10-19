# Laravel fixtures

Projects read by `test/unit/laravel.test.js`. They are hand-made, except the two projects with a schema dump below.

## Schema dumps (real projects)

`php artisan schema:dump` writes the schema of the database to `database/schema/<connection>-schema.sql` (or `.dump`), and can delete the migrations it holds; `php artisan migrate` loads it on a new database, then runs the migrations it does not list. Copied as they are (text only), from the commit given: `database/schema/`, `database/migrations/`, `config/database.php` and `artisan`; `composer.json` is reduced to its `laravel/framework` version. The dumps were applied to MySQL 8.4, PostgreSQL 17 and SQLite: the SQL reader gives the tables of their catalogs (see `test/fixtures/sql/README.md`).

| Fixture | Project | Source | License |
|---------|---------|--------|---------|
| `schema-dump-laravelio/` | laravel.io: a MySQL dump (mysqldump) and the 11 migrations written after it | [database/](https://github.com/laravelio/laravel.io/tree/d119d796abeb6fec17fffa8ff9265e6bf95b24e9/database), [config/database.php](https://github.com/laravelio/laravel.io/blob/d119d796abeb6fec17fffa8ff9265e6bf95b24e9/config/database.php) | MIT ([LICENSE.md](https://github.com/laravelio/laravel.io/blob/d119d796abeb6fec17fffa8ff9265e6bf95b24e9/LICENSE.md)) |
| `schema-dump-linkace/` | LinkAce: three dumps (`mysql-schema.dump`, `pgsql-schema.sql`, `sqlite-schema.dump`), the one of the default connection of `config/database.php` (mysql) is read; the migrations after it drop and rename tables of the dump | [database/](https://github.com/Kovah/LinkAce/tree/b1ef06e8a87074541fe11f21e11f1f10265ff310/database), [config/database.php](https://github.com/Kovah/LinkAce/blob/b1ef06e8a87074541fe11f21e11f1f10265ff310/config/database.php) | GPL-3.0 ([LICENSE.md](https://github.com/Kovah/LinkAce/blob/b1ef06e8a87074541fe11f21e11f1f10265ff310/LICENSE.md)) |

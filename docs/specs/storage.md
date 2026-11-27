# Database configuration

Postgres is the standard database for local development and deployment. Configure `PAIR41_DATABASE_URL` with the app's Postgres connection URL. Server startup and database-backed admin commands fail when that variable is missing. Explicit `sqlite:<path>` URLs remain supported for existing local databases, tests, and benchmarks.

`PAIR41_DATABASE_SSL=true` makes the server and `pair41 migrate` connect to Postgres over TLS that verifies the server's certificate and host name; `ssl*` parameters in the URL are then ignored, so a URL cannot weaken the check. The certificate authorities are Node's plus `NODE_EXTRA_CA_CERTS`; the image sets that to the RDS bundle it ships. When the variable is `false` or unset, the URL alone decides, which suits local Postgres. Any other value is an error. On work-1 the chart sets it to `true` and the Parameter Store URLs carry no `sslmode`.

`pair41 migrate` uses `PAIR41_MIGRATION_DATABASE_URL` when supplied and otherwise uses `PAIR41_DATABASE_URL`. On work-1, give the application and migration job separate Postgres roles. The application starts without applying migrations. For local development, `scripts/dev.sh` runs the migration command before starting the server and requires the app connection URL.

Starting on Postgres requires an empty database or one that already contains the Pair41 schema. The migration command manages schema changes. Existing SQLite records stay in their original database.

-- Postgres users (infrastructure checklist §7): migrations and the app never share credentials, and neither is a
-- superuser. On work-1 you do not run this: infra/terraform's dbinit-lambda (dbinit.tf) sets up the same thing (schema
-- pair41, users pair41_migrate and pair41_app, app limited to data) and writes both URLs to Parameter Store. Elsewhere,
-- run it once as an admin with real passwords, then put the two URLs (with ?schema=pair41) in
-- /hackathon/<namespace>/pair41/database-url (app) and .../migration-database-url (migrations).
CREATE ROLE pair41_migrate LOGIN PASSWORD 'change-me';
CREATE ROLE pair41_app LOGIN PASSWORD 'change-me';
CREATE SCHEMA pair41 AUTHORIZATION pair41_migrate;
ALTER ROLE pair41_migrate SET search_path = pair41;
ALTER ROLE pair41_app SET search_path = pair41;
GRANT USAGE ON SCHEMA pair41 TO pair41_app;
-- Tables and sequences the migration user creates later are usable by the app (data only, no DDL).
ALTER DEFAULT PRIVILEGES FOR ROLE pair41_migrate IN SCHEMA pair41
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO pair41_app;
ALTER DEFAULT PRIVILEGES FOR ROLE pair41_migrate IN SCHEMA pair41
  GRANT USAGE, SELECT ON SEQUENCES TO pair41_app;

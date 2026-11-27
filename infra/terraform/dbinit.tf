# Particle41/dbinit-lambda does on work-1 what deploy/postgres-users.sql does by hand (copied from Particle41/quark-p41):
# schema pair41 (local.db_schema; also the database's search_path), the NOLOGIN group roles mig_grp (DDL, owns the
# objects) and app_grp (DML only), and the login users pair41_migrate and pair41_app from the secrets <prefix>/db/migration
# and <prefix>/db/app (secrets.tf), with default privileges so the app may read and write what migrations create.
# Idempotent: it runs on the first apply and whenever its input changes.

module "dbinit_base" {
  source                  = "git::ssh://git@github.com/Particle41/terraform.git//aws/lambda-base/v1?ref=47dad54a74373728a33a1c2c0de18decd43d91d1"
  name                    = "${local.app}-dbinit"
  vpc_permissions_enabled = true
  log_retention_in_days   = 30
}

module "dbinit_secrets" {
  source = "git::ssh://git@github.com/Particle41/terraform.git//aws/iam-policy-documents-secrets-access/v1?ref=47dad54a74373728a33a1c2c0de18decd43d91d1"
  secret_names = [
    replace(trimprefix(provider::aws::arn_parse(local.db_master_secret_arn).resource, "secret:"), "/-.{6}$/", ""),
    aws_secretsmanager_secret.db["migration"].name,
    aws_secretsmanager_secret.db["app"].name,
  ]
}

module "kms_access" {
  source      = "git::ssh://git@github.com/Particle41/terraform.git//aws/iam-policy-documents-kms-key-access/v1?ref=47dad54a74373728a33a1c2c0de18decd43d91d1"
  kms_key_arn = local.kms_key_arn
}

data "aws_iam_policy_document" "dbinit" {
  source_policy_documents = [module.dbinit_secrets.json, module.kms_access.readonly.json]
}

resource "aws_iam_role_policy" "dbinit" {
  name   = "dbinit-permissions"
  role   = module.dbinit_base.iam_role.id
  policy = data.aws_iam_policy_document.dbinit.json
}

module "dbinit" {
  source     = "git::ssh://git@github.com/Particle41/terraform.git//aws/lambda/v1?ref=47dad54a74373728a33a1c2c0de18decd43d91d1"
  depends_on = [aws_iam_role_policy.dbinit, aws_secretsmanager_secret_version.db]

  name               = "${local.app}-dbinit"
  image_uri          = var.dbinit_image_uri
  iam_role_arn       = module.dbinit_base.iam_role.arn
  log_group_name     = module.dbinit_base.log_group.name
  subnet_ids         = local.subnet_ids
  security_group_ids = [aws_security_group.dbinit.id]

  lambda_env = {
    DB_MIGRATION_SECRET = aws_secretsmanager_secret.db["migration"].arn
    DB_APP_SECRET       = aws_secretsmanager_secret.db["app"].arn
    DB_MIGRATION_ROLE   = "mig_grp"
    DB_APP_ROLE         = "app_grp"
    DB_SCHEMA           = local.db_schema
  }
}

resource "aws_lambda_invocation" "dbinit" {
  function_name = module.dbinit.function.function_name
  qualifier     = module.dbinit.alias.name
  input         = jsonencode({})
}

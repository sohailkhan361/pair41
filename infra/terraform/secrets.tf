# Pair41's database credentials. Passwords are generated here and live only in AWS and the Terraform state: never in
# git or in outputs.
#
# - Secrets Manager hackathon/team-5/pair41/db/{migration,app}: the standard RDS secret JSON that dbinit-lambda reads to
#   create the two users (Particle41/quark-p41's pattern).
# - Parameter Store /hackathon/team-5/pair41/{database-url,migration-database-url,invite-code}: SecureStrings under
#   alias/p41-default, the names the chart's ExternalSecrets read (deploy/helm/pair41/values.yaml, parameters).

locals {
  db_master_secret_arn = module.db.db_instance.master_user_secret[0].secret_arn
  db_secret_common = {
    engine               = module.db.db_instance.engine
    host                 = module.db.db_instance.address
    port                 = module.db.db_instance.port
    dbname               = module.db.db_instance.db_name
    dbInstanceIdentifier = module.db.db_instance.identifier
    masterarn            = local.db_master_secret_arn
  }

  # ?schema= sets each connection's search_path (src/store/db.ts) and makes `pair41 migrate` keep its own tables there.
  # No sslmode: RDS forces TLS, and the chart's PAIR41_DATABASE_SSL=true turns on TLS that checks RDS's certificate
  # against the CA bundle in the image (src/store/db.ts).
  db_url = {
    for user, name in local.db_users : user => format(
      "postgres://%s:%s@%s:%d/%s?schema=%s",
      name, random_password.db[user].result, module.db.db_instance.address, module.db.db_instance.port, local.db_name,
      local.db_schema,
    )
  }
}

resource "random_password" "db" {
  for_each    = local.db_users
  length      = 32
  special     = false # the password goes into a URL as it is
  min_lower   = 1
  min_upper   = 1
  min_numeric = 1
}

resource "aws_secretsmanager_secret" "db" {
  for_each                = local.db_users
  name                    = "${local.secret_prefix}/db/${each.key}"
  kms_key_id              = local.kms_key_arn
  recovery_window_in_days = 0
}

resource "aws_secretsmanager_secret_version" "db" {
  for_each      = local.db_users
  secret_id     = aws_secretsmanager_secret.db[each.key].id
  secret_string = jsonencode(merge(local.db_secret_common, { username = each.value, password = random_password.db[each.key].result }))
}

# PAIR41_DATABASE_URL (the app user) and PAIR41_MIGRATION_DATABASE_URL (the migration user).
resource "aws_ssm_parameter" "database_url" {
  for_each = {
    app       = "database-url"
    migration = "migration-database-url"
  }
  name        = "/${local.secret_prefix}/${each.value}"
  description = "Pair41's Postgres URL as ${local.db_users[each.key]}"
  type        = "SecureString"
  key_id      = local.kms_key_arn
  value       = local.db_url[each.key]

  depends_on = [aws_lambda_invocation.dbinit]
}

# PAIR41_INVITE_CODE: sign-up needs it. Terraform writes a random code once; change it by hand
# (`aws ssm put-parameter --overwrite`), Terraform never writes it again.
resource "random_password" "invite_code" {
  length  = 20
  special = false
}

resource "aws_ssm_parameter" "invite_code" {
  name        = "/${local.secret_prefix}/invite-code"
  description = "The code Pair41's sign-up asks for"
  type        = "SecureString"
  key_id      = local.kms_key_arn
  value       = random_password.invite_code.result

  lifecycle {
    ignore_changes = [value]
  }
}

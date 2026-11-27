# RDS PostgreSQL for Pair41 in p41-internals-dev, the smallest dev size, encrypted with alias/p41-default; the master
# credentials are RDS-managed, and the app and its migrations get their own users from dbinit-lambda (dbinit.tf).
# Copied from Particle41/quark-p41's terraform/modules/app.

module "db_net" {
  source                        = "git::ssh://git@github.com/Particle41/terraform.git//aws/rds-db-net/v1?ref=47dad54a74373728a33a1c2c0de18decd43d91d1"
  subnet_ids                    = local.subnet_ids
  db_subnet_group_name          = local.app
  db_security_group_name        = "${local.app}-db"
  db_security_group_description = "${local.app} database"
}

resource "aws_vpc_security_group_ingress_rule" "db" {
  for_each = {
    pods   = local.cluster_security_group_id
    dbinit = aws_security_group.dbinit.id
  }
  security_group_id            = module.db_net.security_group.id
  ip_protocol                  = "tcp"
  from_port                    = 5432
  to_port                      = 5432
  referenced_security_group_id = each.value
  description                  = each.key == "pods" ? "The pair41 pod and the migrate job" : "dbinit"
}

# RDS creates these when it first exports logs, with no retention and no key: made first, with both.
resource "aws_cloudwatch_log_group" "db" {
  for_each          = toset(["postgresql", "upgrade"])
  name              = "/aws/rds/instance/${local.app}/${each.key}"
  retention_in_days = 30
  kms_key_id        = local.kms_key_arn
}

module "db" {
  source     = "git::ssh://git@github.com/Particle41/terraform.git//aws/rds-postgresql/v1?ref=47dad54a74373728a33a1c2c0de18decd43d91d1"
  depends_on = [aws_cloudwatch_log_group.db]

  instance_identifier         = local.app
  parameter_group_description = "${local.app} database parameters"
  engine_version              = var.postgres_version
  instance_class              = var.db_instance_class
  multi_az                    = false
  allocated_storage_gb        = 20
  max_allocated_storage_gb    = 20
  storage_type                = "gp3"
  db_name                     = local.db_name
  subnet_group_name           = module.db_net.subnet_group.name
  security_group_ids          = [module.db_net.security_group.id]
  monitoring_role_arn         = data.aws_iam_role.rds_monitoring.arn

  kms_key_id                      = local.kms_key_arn
  master_user_secret_kms_key_id   = local.kms_key_arn
  performance_insights_kms_key_id = local.kms_key_arn

  deletion_protection = false
  skip_final_snapshot = true

  cloudwatch_alarm_actions = [data.aws_sns_topic.alerts.arn]
  cloudwatch_ok_actions    = [data.aws_sns_topic.alerts.arn]
}

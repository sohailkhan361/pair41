locals {
  app         = "pair41"
  kms_key_arn = data.aws_kms_alias.default.target_key_arn
  vpc_id      = data.aws_eks_cluster.work.vpc_config[0].vpc_id
  subnet_ids  = module.private_subnets.subnet_ids

  # The pods carry the cluster's primary security group (EKS Auto Mode): eks-cluster-sg-work-1.
  cluster_security_group_id = data.aws_eks_cluster.work.vpc_config[0].cluster_security_group_id

  # deploy/postgres-users.sql's names: database and schema pair41, users pair41_migrate and pair41_app.
  db_name   = local.app
  db_schema = local.app
  db_users = {
    migration = "${local.app}_migrate"
    app       = "${local.app}_app"
  }

  # team-5's External Secrets stores read only parameters under /hackathon/team-5/* and secrets under hackathon/team-5/*.
  secret_prefix = "hackathon/${var.namespace}/${local.app}"
}

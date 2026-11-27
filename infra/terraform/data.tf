# Shared infrastructure, owned by Particle41/aws-infra and only read here.

data "aws_lb" "default" {
  name = "default"
}

data "aws_lb_listener" "https" {
  load_balancer_arn = data.aws_lb.default.arn
  port              = 443
}

data "aws_eks_cluster" "work" {
  name = var.eks_cluster_name
}

data "aws_route53_zone" "apps" {
  name         = "${var.route53_zone_name}."
  private_zone = false
}

data "aws_kms_alias" "default" {
  name = "alias/p41-default"
}

module "private_subnets" {
  source             = "git::ssh://git@github.com/Particle41/terraform.git//aws/subnet-info?ref=47dad54a74373728a33a1c2c0de18decd43d91d1"
  subnet_name_prefix = "main-private-"
}

data "aws_iam_role" "rds_monitoring" {
  name = "rds-monitoring"
}

data "aws_sns_topic" "alerts" {
  name = "alerts-dev"
}

# Only Pair41's own security groups get rules (the database's and dbinit's); the shared groups (cluster and default-alb)
# get none. The database admits the cluster's group (db.tf), which the pod and the migrate Job carry.

resource "aws_security_group" "dbinit" {
  name                   = "${local.app}-dbinit"
  description            = "${local.app} dbinit Lambda"
  vpc_id                 = local.vpc_id
  revoke_rules_on_delete = true

  tags = {
    Name = "${local.app}-dbinit"
  }
}

resource "aws_vpc_security_group_egress_rule" "dbinit_to_db" {
  security_group_id            = aws_security_group.dbinit.id
  ip_protocol                  = "tcp"
  from_port                    = 5432
  to_port                      = 5432
  referenced_security_group_id = module.db_net.security_group.id
  description                  = "The database"
}

# The VPC has no Secrets Manager endpoint: its API is reached over HTTPS through the NAT gateway.
#trivy:ignore:AWS-0104
resource "aws_vpc_security_group_egress_rule" "dbinit_to_secrets_manager" {
  security_group_id = aws_security_group.dbinit.id
  ip_protocol       = "tcp"
  from_port         = 443
  to_port           = 443
  cidr_ipv4         = "0.0.0.0/0"
  description       = "Secrets Manager, through the NAT gateway"
}

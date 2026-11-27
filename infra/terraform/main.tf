# Pair41's place on the shared ALB in p41-internals-dev: one hostname, one rule, one target group. The pod in team-5
# on work-1 joins the group through the chart's TargetGroupBinding (EKS Auto Mode), which manages only target groups
# tagged with the cluster's name. No security group rules: the platform already lets the ALB reach pods on 8080, and
# apps never add rules to shared groups.

resource "aws_lb_target_group" "pair41" {
  name                 = "pair41"
  port                 = 8080
  protocol             = "HTTP"
  target_type          = "ip"
  vpc_id               = data.aws_eks_cluster.work.vpc_config[0].vpc_id
  deregistration_delay = 30

  tags = {
    "eks:eks-cluster-name" = var.eks_cluster_name
  }

  # Readiness: a draining pod (SIGTERM fails /ready first) leaves the rotation.
  health_check {
    path                = "/ready"
    matcher             = "200"
    interval            = 15
    timeout             = 5
    healthy_threshold   = 2
    unhealthy_threshold = 2
  }
}

resource "aws_lb_listener_rule" "pair41" {
  listener_arn = data.aws_lb_listener.https.arn
  priority     = var.listener_priority

  action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.pair41.arn
  }

  condition {
    host_header {
      values = [var.hostname]
    }
  }

  tags = {
    Name = "pair41"
  }
}

resource "aws_route53_record" "pair41" {
  zone_id = data.aws_route53_zone.apps.zone_id
  name    = var.hostname
  type    = "A"

  alias {
    name                   = data.aws_lb.default.dns_name
    zone_id                = data.aws_lb.default.zone_id
    evaluate_target_health = true
  }
}

output "target_group_arn" {
  description = "Goes into the chart as targetGroupBinding.arn (deploy/helm/pair41)."
  value       = aws_lb_target_group.pair41.arn
}

output "url" {
  value = "https://${var.hostname}"
}

output "parameters" {
  description = "The Parameter Store names the chart's ExternalSecrets read (values only in AWS)."
  value = concat(
    [for parameter in aws_ssm_parameter.database_url : parameter.name],
    [aws_ssm_parameter.invite_code.name],
  )
}

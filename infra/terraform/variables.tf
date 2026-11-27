variable "hostname" {
  description = "Public hostname of the app on the shared ALB."
  type        = string
  default     = "pair41.dev.apps.particle41.ninja"
}

variable "route53_zone_name" {
  description = "Public Route 53 zone that holds the hostname's record."
  type        = string
  default     = "dev.apps.particle41.ninja"
}

variable "listener_priority" {
  description = "Priority of the app's rule on the shared ALB's HTTPS listener; must be unique on that listener."
  type        = number
  # TBC by Andre Silva against live ALB
  default = 700
}

variable "eks_cluster_name" {
  description = "EKS cluster the pods run on; its VPC holds the target group, and its name tags the group."
  type        = string
  default     = "work-1"
}

variable "namespace" {
  description = "The team's namespace on the cluster: its External Secrets stores read only hackathon/<namespace>/..."
  type        = string
  default     = "team-5"
}

variable "dbinit_image_uri" {
  description = "Particle41/dbinit-lambda's image (dbinit-lambda.auto.tfvars)."
  type        = string
}

variable "postgres_version" {
  description = "RDS PostgreSQL engine version (x.y)."
  type        = string
  default     = "16.15"
}

variable "db_instance_class" {
  description = "The smallest instance: one replica of a hackathon app."
  type        = string
  default     = "db.t4g.micro"
}

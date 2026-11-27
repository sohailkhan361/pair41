# State in the shared p41-tfstate bucket, one key per app and environment: dev.s3.tfbackend
# (`terraform init -backend-config=dev.s3.tfbackend`).
terraform {
  backend "s3" {}
}

provider "aws" {
  region = "us-east-1"

  assume_role {
    role_arn = "arn:aws:iam::366920167890:role/infrastructure"
  }

  default_tags {
    tags = {
      Application = "pair41"
      Environment = "dev"
      CreatedWith = "terraform"
    }
  }
}

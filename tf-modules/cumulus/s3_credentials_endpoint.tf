module "distribution" {
  source = "../s3-credentials-endpoint"

  api_gateway_stage                              = var.distribution_api_gateway_stage
  deploy_s3_credentials_endpoint                 = var.deploy_distribution_s3_credentials_endpoint
  distribution_url                               = var.distribution_url
  log_api_gateway_to_cloudwatch                  = var.log_api_gateway_to_cloudwatch
  log_destination_arn                            = var.log_destination_arn
  permissions_boundary_arn                       = var.permissions_boundary_arn
  prefix                                         = var.prefix
  public_buckets                                 = local.public_bucket_names
  sts_credentials_lambda_function_arn            = var.sts_credentials_lambda_function_arn
  subnet_ids                                     = var.lambda_subnet_ids
  urs_client_id                                  = var.urs_client_id
  urs_client_password                            = var.urs_client_password
  urs_url                                        = var.urs_url
  vpc_id                                         = var.vpc_id
  tags = var.tags

  rest_api_id = var.distribution_rest_api_id
  rest_api_root_resource_id = var.distribution_rest_api_root_resource_id
  egress_log_group = var.distribution_egress_log_group
}

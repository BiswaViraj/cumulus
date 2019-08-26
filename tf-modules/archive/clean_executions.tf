resource "aws_sqs_queue" "clean_executions_dead_letter_queue" {
  name                       = "${var.prefix}-cleanExecutionsDeadLetterQueue"
  receive_wait_time_seconds  = 20
  visibility_timeout_seconds = 60
}

resource "aws_lambda_function" "clean_executions" {
  function_name    = "${var.prefix}-cleanExecutions"
  filename         = "${path.module}/../../packages/api/dist/cleanExecutions/lambda.zip"
  source_code_hash = filebase64sha256("${path.module}/../../packages/api/dist/cleanExecutions/lambda.zip")
  handler          = "index.handler"
  role             = aws_iam_role.lambda_processing.arn
  runtime          = "nodejs8.10"
  timeout          = 900
  memory_size      = 192
  dead_letter_config {
    target_arn = aws_sqs_queue.clean_executions_dead_letter_queue.arn
  }
  environment {
    variables = {
      CMR_ENVIRONMENT = var.cmr_environment
      ExecutionsTable = var.dynamo_tables.Executions
      stackName       = var.prefix

      completeExecutionPayloadTimeoutDisable = var.complete_execution_payload_timeout_disable
      completeExecutionPayloadTimeout        = var.complete_execution_payload_timeout

      nonCompleteExecutionPayloadTimeoutDisable = var.non_complete_execution_payload_timeout_disable
      nonCompleteExecutionPayloadTimeout        = var.non_complete_execution_payload_timeout
    }
  }
  tags = {
    Project = var.prefix
  }
  vpc_config {
    subnet_ids         = var.lambda_subnet_ids
    security_group_ids = [aws_security_group.no_ingress_all_egress.id]
  }
}

resource "aws_cloudwatch_event_rule" "daily_execution_payload_cleanup" {
  schedule_expression = "cron(0 4 * * ? *)"
}

resource "aws_cloudwatch_event_target" "daily_execution_payload_cleanup" {
  rule = aws_cloudwatch_event_rule.daily_execution_payload_cleanup.name
  arn  = aws_lambda_function.clean_executions.arn
}

resource "aws_lambda_permission" "daily_execution_payload_cleanup" {
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.clean_executions.arn
  principal     = "events.amazonaws.com"
  source_arn    = aws_cloudwatch_event_rule.daily_execution_payload_cleanup.arn
}

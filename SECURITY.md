# Security Policy

Redirector deploys CloudFront distributions, ACM certificates, Route 53 records,
and (optionally) a CodePipeline with IAM roles that can deploy CloudFormation
stacks into your AWS account.

## Reporting a vulnerability

Please report vulnerabilities privately through
[GitHub's private vulnerability reporting](https://github.com/jonathanspiva/redirector/security/advisories/new),
not as a public issue. Include steps to reproduce and the commit you tested.

You can expect an initial response within a week.

## Supported versions

Only the latest commit on `main` receives fixes.

## Scope

In scope: open redirects beyond the configured targets, header or URL injection
through the generated CloudFront Function, IAM permissions broader than the stacks
need, and anything that leaks secrets or account details through logs or outputs.

Out of scope: misconfiguration in your own `redirects.yaml` (for example, pointing
a domain at a target you don't control), and AWS service behavior.

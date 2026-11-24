# Contributing

Bug reports and pull requests are welcome.

## Development

Requires Node.js 24+ (the CodeBuild runtime). Deploying needs an AWS account with
CDK bootstrapped in `us-east-1`; running the tests does not.

```bash
cd cdk
npm ci
npx tsc --noEmit
npm test
npm run validate -- ../redirects.example.yaml
```

## Guidelines

- Add tests for any change. Behavior changes to the generated CloudFront Function
  need a case in the handler tests in `test/redirect-stack.test.ts`; stack changes usually need a snapshot
  update (`npx jest -u`) that you've read line by line.
- Keep `cdk-nag` clean. Fix a finding where possible; otherwise acknowledge it with
  `Validations.of(construct).acknowledge(...)` and a specific reason.
- Don't change logical IDs of existing resources (see `domainLogicalId` in
  `lib/utils/domain.ts`): a changed ID replaces the distribution and certificate
  for every deployed domain.
- Test data must be fictional. Use `example.com`-style domains and the
  `123456789012` placeholder account, never real domains or account IDs.

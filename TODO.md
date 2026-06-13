# Redirector TODO

## Now

No active items.

## Later

### Handle DNS conflicts gracefully (Future Enhancement)

Additional options to consider if pre-flight warnings aren't sufficient:

1. **Import existing records**: Use CloudFormation import or CDK's `fromXxx` methods to adopt existing resources
2. **Overwrite option**: Add a `--force` flag or config option to delete conflicting records before deployment
3. **Better error messaging**: Catch specific CloudFormation errors and provide actionable guidance

## Never

### Smart deploy (skip deployment when redirects already work)

Removed. It ran a full smoke-test pass before deploying and skipped the deploy
when everything passed, but `FORCE_DEPLOY` was defaulted to `true`, so the skip
never happened and the pre-deploy smoke run was wasted build time. The pipeline
now deploys with CDK directly, then runs smoke tests once (non-blocking).

## Done

### Pre-flight checks for DNS conflicts

- [x] Pre-flight validation now checks for existing Route 53 records before deployment
- [x] Checks Route 53 hosted zone exists for each domain
- [x] Checks no conflicting A/AAAA records already exist
- [x] Distinguishes between alias records (likely from previous deployment) and regular records (will cause conflict)
- [x] Usage: `npm run preflight -- ../redirects.yaml` or `PREFLIGHT_MODE=fail npm run preflight -- ../redirects.yaml`

### Deployment Time Optimizations

- [x] Parallelize smoke tests using `Promise.all()`
- [x] Increase CodeBuild compute type to `ComputeType.MEDIUM` with ARM architecture
- [x] Eliminate redundant validation (config validation now only during CDK synthesis)
- [x] ARM-based CodeBuild using `LinuxArmBuildImage.AMAZON_LINUX_2_STANDARD_3_0`

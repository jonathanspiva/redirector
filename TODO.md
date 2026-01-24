# Redirector TODO

## Enhancements

### ~~Pre-flight checks for DNS conflicts~~ ✅ DONE

Pre-flight validation now checks for existing Route 53 records before deployment. See `/cdk/scripts/preflight-check.ts`.

**What it checks:**
- Route 53 hosted zone exists for each domain
- No conflicting A/AAAA records already exist
- Distinguishes between alias records (likely from previous deployment) and regular records (will cause conflict)

**Usage:**
```bash
npm run preflight -- ../redirects.yaml

# To fail build on conflicts (default is warn):
PREFLIGHT_MODE=fail npm run preflight -- ../redirects.yaml
```

---

### Handle DNS conflicts gracefully (Future Enhancement)

Additional options to consider if pre-flight warnings aren't sufficient:

1. **Import existing records**: Use CloudFormation import or CDK's `fromXxx` methods to adopt existing resources
2. **Overwrite option**: Add a `--force` flag or config option to delete conflicting records before deployment
3. **Better error messaging**: Catch specific CloudFormation errors and provide actionable guidance

## Deployment Time Optimizations

### ~~Skip deployment when nothing has changed~~ ✅ DONE

Smart deploy script now runs smoke tests first. If all redirects are working, deployment is skipped entirely.

**How it works:**
1. Run smoke tests against current configuration
2. If all pass → skip `cdk deploy` (unless `FORCE_DEPLOY=true`)
3. If any fail → run `cdk deploy` → re-run smoke tests

**Usage:**
```bash
# Normal (skips deploy if redirects work)
npm run smart-deploy -- ../redirects.yaml

# Force deployment for testing
FORCE_DEPLOY=true npm run smart-deploy -- ../redirects.yaml
```

See `/cdk/scripts/smart-deploy.ts`

---

### ~~Parallelize smoke tests~~ ✅ DONE

~~Current smoke tests run sequentially with a 10-second timeout per domain. For 10 domains, this takes ~100 seconds minimum.~~

Smoke tests now run in parallel using `Promise.all()`. See `/cdk/scripts/smoke-test.ts`.

---

### ~~Increase CodeBuild compute type~~ ✅ DONE

CodeBuild now uses `ComputeType.MEDIUM` with ARM architecture for better price/performance. See `/cdk/lib/pipeline-stack.ts`.

---

### ~~Eliminate redundant validation~~ ✅ DONE

Removed duplicate validation from `buildspec.yml`. Config validation now happens only during CDK synthesis in `redirect-stack.ts`.

---

### ~~Consider ARM-based CodeBuild~~ ✅ DONE

CodeBuild now uses `LinuxArmBuildImage.AMAZON_LINUX_2_STANDARD_3_0` with `MEDIUM` compute type. See `/cdk/lib/pipeline-stack.ts`.

# Redirector TODO

## Enhancements

### Handle existing DNS record conflicts gracefully

When deploying redirects, if Route 53 already has an A/AAAA record for a domain, the CloudFormation stack fails with:

```
Tried to create resource record set [name='example.com.', type='A'] but it already exists
```

**Potential solutions to consider:**

1. **Pre-flight check**: Add a validation step that checks for existing DNS records before deployment and warns the user
2. **Import existing records**: Use CloudFormation import or CDK's `fromXxx` methods to adopt existing resources
3. **Overwrite option**: Add a `--force` flag or config option to delete conflicting records before deployment
4. **Better error messaging**: Catch this specific error and provide actionable guidance (e.g., "Run `npm run cleanup-dns example.com` to remove conflicting records")

**Context**: This commonly happens when migrating domains that already have DNS records pointing elsewhere (e.g., Squarespace, old hosting).

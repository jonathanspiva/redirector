# Domain Redirector

An AWS-native service that manages HTTP redirects for multiple domains using CloudFront and CloudFront Functions. Configuration is managed via a simple YAML file, making it accessible to non-developers.

## Overview

This service reads from a YAML configuration file and automatically provisions **one CloudFront distribution per domain**, each with:

- **CloudFront Distribution** — Dedicated distribution for each source domain
- **ACM Certificate** — Single-domain certificate (no complex multi-domain management)
- **CloudFront Function** — One function per destination target (all domains redirecting to the same target share a function)
- **Route 53 Records** — A/AAAA records pointing each domain to its distribution

Changes to the configuration file trigger automatic deployment via AWS CodePipeline and CodeBuild.

## Architecture

```
┌─────────────────────────────────────────────────────────────────────────┐
│                           Git Repository                                 │
│                                                                          │
│   redirects.yaml  ───▶  CodePipeline  ───▶  CodeBuild                   │
│   (edit this)           (on push)           │                            │
│                                             ├──▶  Validate YAML          │
│                                             │     (syntax, domains, URLs)│
│                                             ├──▶  CDK Deploy             │
│                                             │     (provision resources)  │
│                                             └──▶  Smoke Tests            │
│                                                   (verify redirects)     │
└─────────────────────────────────────────────────────────────────────────┘
                                          │
                                          ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                                 AWS                                      │
│                                                                          │
│  CloudFront Functions (one per destination):                            │
│  ┌──────────────────────────────────────────────────────────────────┐   │
│  │  redirect-to-brand-a           →  https://www.brand-a.com        │   │
│  │  redirect-to-brand-a-acquired  →  https://www.brand-a.com/acquired│   │
│  └──────────────────────────────────────────────────────────────────┘   │
│                                                                          │
│  Per-domain resources:                                                   │
│  ┌────────────────────────────────────────────────────────────────────┐ │
│  │  old-brand.com                                                      │ │
│  │  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐              │ │
│  │  │  CloudFront  │  │     ACM      │  │   Route 53   │              │ │
│  │  │ Distribution │──│ Certificate  │  │   A/AAAA     │              │ │
│  │  └──────┬───────┘  └──────────────┘  └──────────────┘              │ │
│  │         │                                                           │ │
│  │         └──────────▶  redirect-to-brand-a function                  │ │
│  └────────────────────────────────────────────────────────────────────┘ │
│                                                                          │
│  ┌────────────────────────────────────────────────────────────────────┐ │
│  │  *.old-brand.com  (wildcard — same pattern, same function)          │ │
│  └────────────────────────────────────────────────────────────────────┘ │
│                                                                          │
│  ┌────────────────────────────────────────────────────────────────────┐ │
│  │  acquired-company.com  →  redirect-to-brand-a-acquired              │ │
│  └────────────────────────────────────────────────────────────────────┘ │
│                                                                          │
└─────────────────────────────────────────────────────────────────────────┘
```

### Why One Distribution Per Domain?

This architecture creates a dedicated CloudFront distribution for each source domain. While this seems like more resources, it **dramatically simplifies certificate management**:

| Approach | Certificate Complexity | Scaling |
|----------|------------------------|---------|
| Single distribution, multi-domain certs | Complex (max 100 SANs per cert, must track which domain is on which cert, rebuild certs when domains change) | Hits limits quickly |
| **One distribution per domain** | Simple (1 domain = 1 cert, add/remove domains independently) | Linear, predictable |

Benefits:
- **No certificate juggling** — each domain gets its own ACM certificate
- **Isolated changes** — adding domain #51 doesn't touch domains 1-50
- **Clean removal** — deleting a domain removes only its resources
- **Incremental deploys** — CDK only creates/updates changed resources

### How the Redirect Works

Each unique destination target gets its own CloudFront Function. The function is simple—it only needs to know its target URL and redirect type:

```javascript
// Auto-generated: redirect-to-brand-a.js
var defined = {
  target: "https://www.brand-a.com",
  statusCode: 301,
  preservePath: true,
  preserveQuery: true
};

function handler(event) {
  var url = defined.target;
  if (defined.preservePath) {
    url += event.request.uri;
  }
  if (defined.preserveQuery) {
    var qs = Object.keys(event.request.querystring)
      .map(function(k) { return k + "=" + event.request.querystring[k].value; })
      .join("&");
    if (qs) url += "?" + qs;
  }
  return {
    statusCode: defined.statusCode,
    headers: { location: { value: url } }
  };
}
```

Distributions are associated with the appropriate function based on their target. For example:
- `old-brand.com` and `*.old-brand.com` both use `redirect-to-brand-a` function
- `acquired-company.com` uses `redirect-to-brand-a-acquired` function (different target path)

**Benefits of one function per destination:**
- **Simpler function code** — No host header lookup or mapping table needed
- **Clear separation** — Each function has a single responsibility
- **Easier debugging** — Function name tells you exactly what it does
- **Independent updates** — Changing brand-a's target doesn't touch brand-b's function

## Quick Start

### For Non-Developers (Editing Redirects)

1. Open `redirects.yaml` in GitHub
2. Find the appropriate redirect group or create a new one
3. Add your domain to the `domains` list
4. Commit to `main` branch
5. Deployment happens automatically

### For Developers (Initial Setup)

See [Setup Guide](#setup-guide) below.

## Configuration

Edit `redirects.yaml` to manage redirects:

```yaml
redirects:
  # Legacy brand domains → main site
  - target: "https://www.brand-a.com"
    type: permanent
    description: "Legacy consumer brand domains"
    domains:
      - old-brand.com
      - "*.old-brand.com"    # Wildcard catches all subdomains

  # Acquired company domains → landing page (no path preservation)
  - target: "https://www.brand-a.com/acquired"
    type: permanent
    description: "Acquired company domains"
    preservePath: false
    domains:
      - acquired-company.com
      - "*.acquired-company.com"

settings:
  preservePath: true    # Default: old.com/page → target.com/page
  preserveQuery: true   # Default: old.com?ref=x → target.com?ref=x
```

### Redirect Types

| Type | HTTP Code | Use Case |
|------|-----------|----------|
| `permanent` | 301 | Domain is retired forever (recommended) |
| `temporary` | 302 | Rare — only if domain may return to active use |

Most redirects should be `permanent`. This signals to browsers and search engines that the domain is retired and transfers SEO value to the target.

### Path and Query Preservation

By default, redirects preserve the original path and query string:
- `old.com/page?ref=123` → `target.com/page?ref=123`

You can override this per redirect group:

```yaml
  - target: "https://www.brand-a.com/landing"
    preservePath: false   # old.com/anything → target.com/landing
    preserveQuery: false  # Query params are dropped
    domains: [...]
```

| Setting | Default | Effect |
|---------|---------|--------|
| `preservePath` | `true` | Appends original path to target |
| `preserveQuery` | `true` | Appends original query string to target |

Per-rule settings override the global `settings` values.

### Adding a New Domain

```yaml
# Just add the domain under the appropriate target
domains:
  - existing-domain.com
  - new-domain.com        # ← Add here
```

### Wildcard Domains

Use wildcards to catch all subdomains:

```yaml
  - target: "https://www.brand-a.com"
    domains:
      - old-brand.com
      - "*.old-brand.com"   # Catches any subdomain
```

**Important:** Wildcards don't match the apex domain. For full coverage, include both:
- `old-brand.com` — matches `old-brand.com`
- `*.old-brand.com` — matches `www.old-brand.com`, `mail.old-brand.com`, `anything.old-brand.com`

**How it works:**
- ACM issues a wildcard certificate (`*.old-brand.com`)
- CloudFront accepts the wildcard as a CNAME
- Route 53 creates a wildcard A/AAAA record

**Use case:** Defensive domain strategy — redirect any subdomain, including ones you haven't anticipated, without listing each explicitly.

### Creating a New Redirect Group

```yaml
redirects:
  # ... existing groups ...

  # Add a new group
  - target: "https://www.new-destination.com"
    type: permanent
    description: "Describe what these domains are for"
    domains:
      - domain-one.com
      - domain-two.com
```

### Disabling a Redirect

Use the `active` field to disable a redirect without removing it from config:

```yaml
  - target: "https://www.brand-a.com"
    active: false   # Disabled - no resources deployed
    description: "Temporarily disabled for testing"
    domains:
      - old-brand.com
```

| `active` Value | Behavior |
|----------------|----------|
| `true` (default) | Resources are created/maintained |
| `false` | Resources are not created; existing resources are removed |

## Project Structure

```
redirector/
├── README.md                   # This file
├── redirects.yaml              # Redirect configuration (edit this)
├── buildspec.yml               # CodeBuild: validate, deploy, test
└── cdk/
    ├── package.json
    ├── cdk.json
    ├── tsconfig.json
    └── lib/
        ├── redirect-stack.ts       # Per-domain distributions + per-destination functions
        └── pipeline-stack.ts       # CodePipeline + CodeBuild infrastructure
```

## Setup Guide

### Prerequisites

- AWS CLI configured with appropriate credentials
- Node.js 20+
- AWS CDK CLI (`npm install -g aws-cdk`)
- GitHub repository with CodeStar Connection configured

### Initial Deployment

1. **Clone the repository**
   ```bash
   git clone git@github.com:jonathanspiva/redirector.git
   cd redirector
   ```

2. **Install dependencies**
   ```bash
   cd cdk
   npm install
   ```

3. **Configure AWS CodeStar Connection**

   In AWS Console:
   - Go to Developer Tools → Settings → Connections
   - Create connection to GitHub
   - Note the Connection ARN

4. **Set environment variables**
   ```bash
   export CDK_DEFAULT_ACCOUNT=your-aws-account-id
   export CDK_DEFAULT_REGION=us-east-1
   export GITHUB_CONNECTION_ARN=arn:aws:codestar-connections:...
   export GITHUB_OWNER=jonathanspiva
   export GITHUB_REPO=redirector
   ```

5. **Bootstrap CDK (first time only)**
   ```bash
   npx cdk bootstrap
   ```

6. **Deploy the pipeline**
   ```bash
   npx cdk deploy PipelineStack
   ```

7. **Deploy the redirects**
   ```bash
   npx cdk deploy RedirectStack
   ```

After initial setup, all future changes to `redirects.yaml` will be deployed automatically when pushed to `main`.

## Resource Lifecycle

### How CDK Handles Changes

CDK tracks all resources it creates. When you modify `redirects.yaml`, the next deployment automatically:

| Change | CDK Action |
|--------|------------|
| Add a domain | Creates new distribution, certificate, Route 53 records |
| Remove a domain | Deletes distribution, certificate, Route 53 records |
| Set `active: false` | Same as removing — deletes all resources for that group |
| Set `active: true` | Same as adding — creates all resources |
| Change target URL | Updates existing distributions to use different function |
| Add new target | Creates new CloudFront Function |
| Remove last domain using a target | Deletes the orphaned CloudFront Function |

### Cleanup Behavior

When a domain is removed or disabled:

1. **Route 53 records** — Deleted immediately (DNS stops resolving)
2. **CloudFront Distribution** — Disabled, then deleted (may take a few minutes)
3. **ACM Certificate** — Deleted after distribution removal
4. **CloudFront Function** — Deleted only if no other domains reference it

**Important:** Removing a domain means requests to that domain will fail immediately after DNS propagation. Ensure the domain is no longer in use before removing.

### Orphan Prevention

CDK's declarative model ensures no orphaned resources:
- If it's in `redirects.yaml` and `active: true` → resources exist
- If it's not in `redirects.yaml` or `active: false` → resources are removed

You never need to manually clean up AWS resources.

## AWS Service Limits

This architecture stays well within AWS defaults for typical usage (<250 domains).

### CloudFront Distributions

| Quota | Default | Notes |
|-------|---------|-------|
| Distributions per account | 200 | Request increase for more domains |

For most users (under 200 domains), no quota increase is needed.

### ACM Certificates

| Quota | Default | Notes |
|-------|---------|-------|
| Certificates per account | 2,500 | More than sufficient |

With one certificate per domain, you're well under this limit.

### CloudFront Functions

| Resource | Limit |
|----------|-------|
| Functions per account | 25 (default), increasable |
| Code size | 10 KB |
| Execution time | <1 ms typical |

This service creates **one function per unique destination target**. With the default limit of 25 functions, you can have up to 25 different redirect targets. Request a quota increase if you need more destinations. Each function is tiny (~200 bytes), well under the 10KB limit.

## AWS Resources Created

**Per domain:**
| Resource | Description |
|----------|-------------|
| CloudFront Distribution | Dedicated CDN for the domain |
| ACM Certificate | Single-domain SSL/TLS certificate (free) |
| Route 53 Records | A/AAAA records pointing to distribution |

**Per destination target:**
| Resource | Description |
|----------|-------------|
| CloudFront Function | Redirect logic for that target (one function per unique destination) |

**Shared (one total):**
| Resource | Description |
|----------|-------------|
| CodePipeline | CI/CD pipeline |
| CodeBuild | Build environment |

### Cost Estimates

CloudFront pricing is **usage-based, not per-distribution**, so costs scale with traffic, not domain count:

| Traffic Level | Monthly Requests | Estimated Cost |
|---------------|------------------|----------------|
| Low | 100K | ~$2/month |
| Medium | 1M | ~$3/month |
| High | 10M | ~$12/month |

Cost breakdown:
- HTTPS requests: $0.01 per 10,000
- CloudFront Function: $0.10 per 1M invocations
- ACM Certificates: Free
- CodePipeline: $1/month
- Route 53: Included in hosted zone cost

### Cost Tracking with Tags

All resources are tagged for easy cost tracking in AWS Billing Dashboard and Cost Explorer.

**Default tags (applied automatically):**

| Tag | Value | Purpose |
|-----|-------|---------|
| `Project` | `domain-redirector` | Filter all redirector costs |
| `ManagedBy` | `cdk` | Identify IaC-managed resources |

**Optional tags** (configure in `cdk/lib/config.ts`):

| Tag | Example | Purpose |
|-----|---------|---------|
| `Environment` | `production` | Separate prod/staging costs |
| `CostCenter` | `marketing` | Internal accounting |
| `Owner` | `platform-team` | Team responsibility |

**How tags are applied in CDK:**

```typescript
import { Tags } from 'aws-cdk-lib';

// In your stack constructor
Tags.of(this).add('Project', 'domain-redirector');
Tags.of(this).add('ManagedBy', 'cdk');
```

**To view costs by project:**

1. **Activate cost allocation tags** (one-time setup):
   - Go to AWS Billing → Cost Allocation Tags
   - Find `Project` tag and click "Activate"
   - Tags appear in reports within 24 hours

2. **View in Cost Explorer**:
   - Go to AWS Cost Explorer
   - Group by → Tag → `Project`
   - Filter by `Project` = `domain-redirector`

## Pre-Deployment Validation

Before any infrastructure changes, CodeBuild validates `redirects.yaml`:

### YAML Structure

| Check | Example Error |
|-------|---------------|
| Valid YAML syntax | `line 12: mapping values not allowed here` |
| `redirects` is an array | `redirects must be an array` |
| `settings` is an object | `settings must be an object` |

### Required Fields

Each redirect group must have:

| Field | Required | Validation |
|-------|----------|------------|
| `target` | Yes | Must be a valid HTTPS URL |
| `type` | Yes | Must be `permanent` or `temporary` |
| `domains` | Yes | Must be a non-empty array |
| `description` | No | String, for documentation |
| `preservePath` | No | Boolean |
| `preserveQuery` | No | Boolean |
| `active` | No | Boolean (defaults to `true`) |
| `skipTest` | No | Array of domains to skip in smoke tests |

### Domain Validation

| Check | Valid | Invalid |
|-------|-------|---------|
| Format | `example.com`, `sub.example.com` | `http://example.com`, `example` |
| Wildcards | `*.example.com` | `*.*.example.com`, `*example.com` |
| No duplicates | — | Same domain in multiple groups |
| Characters | `my-site.com`, `site123.com` | `my_site.com`, `site!.com` |

### Target URL Validation

| Check | Valid | Invalid |
|-------|-------|---------|
| HTTPS required | `https://example.com` | `http://example.com` |
| Valid URL format | `https://example.com/path` | `example.com` |
| No trailing slash | `https://example.com` | `https://example.com/` |

### Example Validation Errors

```
Validation failed:

  ✗ redirects[0].target: must be HTTPS URL, got "http://example.com"
  ✗ redirects[1].domains[2]: invalid domain format "not a domain"
  ✗ redirects[2].domains[0]: duplicate domain "old-brand.com" (also in redirects[0])
  ✗ redirects[3].type: must be "permanent" or "temporary", got "perm"

Deployment aborted. Fix errors in redirects.yaml and push again.
```

If validation fails, no infrastructure changes are made.

## Post-Deployment Testing

After each deployment, CodeBuild runs smoke tests to verify redirects are working:

```bash
# Example test output in CodeBuild logs
Testing old-brand.com...
  ✓ HTTP 301 Moved Permanently
  ✓ Location: https://www.brand-a.com/
Testing acquired-company.com...
  ✓ HTTP 301 Moved Permanently
  ✓ Location: https://www.brand-a.com/acquired
All 2 redirect tests passed.
```

### What's Tested

For each active domain, the smoke test verifies:

| Check | Expected |
|-------|----------|
| HTTP status code | Matches configured type (301 or 302) |
| Location header | Starts with configured target URL |
| HTTPS works | Certificate is valid and trusted |

### Handling New Domains

New domains may not be immediately testable due to:
- **DNS propagation** — Route 53 changes can take up to 60 seconds
- **Certificate issuance** — ACM DNS validation typically takes 2-5 minutes

The smoke test handles this by:
1. Testing existing domains first (should pass immediately)
2. Retrying new domains with exponential backoff (up to 5 minutes)
3. Logging warnings for domains that aren't ready yet (doesn't fail the build)

### Viewing Test Results

Test output appears in:
- **CodeBuild logs** — Full output in AWS Console → CodeBuild → Build history
- **Pipeline status** — Green/red indicator in CodePipeline

### Skipping Tests for Specific Domains

Add `skipTest: true` to skip smoke testing for a domain (useful for domains with unusual DNS setups):

```yaml
  - target: "https://www.brand-a.com"
    domains:
      - old-brand.com
      - external-dns-domain.com    # Managed outside Route 53
    skipTest:
      - external-dns-domain.com
```

## Troubleshooting

### Deployment Failed

1. Check CodeBuild logs in AWS Console
2. Look for validation errors in the build output
3. Verify YAML syntax in `redirects.yaml`

### Redirect Not Working

1. Verify domain is listed in `redirects.yaml`
2. Check Route 53 for correct A/AAAA records
3. Verify ACM certificate is issued (not pending)
4. Allow up to 15 minutes for DNS propagation

### Certificate Pending Validation

ACM certificates require DNS validation. Ensure the validation CNAME records are created in Route 53.

### Smoke Test Warnings

If smoke tests show warnings for new domains:
1. This is normal — DNS and certificates take a few minutes to propagate
2. Wait 5 minutes and manually test with `curl -I https://your-domain.com`
3. If still failing after 10 minutes, check ACM certificate status in AWS Console

## Security

- All redirects use HTTPS
- CloudFront enforces TLS 1.2+
- No origin servers required (CloudFront Function responds directly at edge)
- IAM roles follow least-privilege principle
- CodeBuild runs in isolated environment
- No sensitive data stored (only domain→target mappings)

## Inspiration & Related Projects

This project was inspired by and builds upon ideas from:

### AWS Official Samples

- **[aws-samples/amazon-cloudfront-redirector](https://github.com/aws-samples/amazon-cloudfront-redirector)**
  CloudFront Functions + KeyValueStore approach for URL redirections at scale. Uses CSV configuration and supports regex redirects, date ranges, and status codes. MIT-0 license.

### Community Projects

- **[spencerbeggs/aws-cdk-domain-redirect](https://github.com/spencerbeggs/aws-cdk-domain-redirect)**
  AWS CDK construct using Lambda@Edge for domain redirects. Good API design for path/query preservation. MIT license.

- **[Cloudar - Enhancing Redirect Strategies with CloudFront Functions and KeyValueStore](https://cloudar.be/awsblog/enhancing-redirect-strategies-with-aws-cloudfront-functions-and-keyvaluestore/)**
  Detailed blog post on implementing redirects with KeyValueStore.

- **[Babbel Engineering - Supercharging URLs with CloudFront Functions and KeyValueStore](https://www.babbel.com/en/magazine/supercharging-url-redirects-with-aws-cloudfront-functions-and-keyvaluestore)**
  Production case study of this architecture pattern.

### Why We Chose This Approach

| Alternative | Why Not |
|-------------|---------|
| Single distribution, multi-domain certs | Complex certificate management — can't add >100 SANs per cert, must rebuild certs when domains change, need state tracking |
| Lambda@Edge | Slower (~5ms vs <1ms), more expensive, region-locked deployment |
| S3 Website Redirect | Requires one bucket per redirect config, no dynamic logic |
| ALB Redirect Rules | Requires running infrastructure, significantly more expensive |
| API Gateway | Overkill for simple redirects, higher latency |

One distribution per domain + one function per destination provides:
- **Simplicity**: Add a domain = create one distribution + one cert. Add a new target = create one function.
- **Performance**: Sub-millisecond redirects at the edge
- **Cost**: Same as single-distribution (~$0.10 per million requests) — CloudFront pricing is usage-based
- **Isolation**: Problems with one domain don't affect others; each function is independent
- **Clean scaling**: Works the same way whether you have 5 domains or 200

## Contributing

1. Create a feature branch
2. Make changes
3. Open a pull request
4. Merge to `main` after approval

## License

Private - Internal use only.

# Domain Redirector

An AWS-native service that manages HTTP redirects for multiple domains using CloudFront and CloudFront Functions. Configuration is managed via a simple YAML file, making it accessible to non-developers.

## Overview

This service reads from a YAML configuration file and automatically provisions **one CloudFront distribution per domain**, each with:

- **CloudFront Distribution** — Dedicated distribution for each source domain
- **ACM Certificate** — Single-domain certificate (no complex multi-domain management)
- **CloudFront Function** — Shared edge function that performs redirects
- **Route 53 Records** — A/AAAA records pointing each domain to its distribution

Changes to the configuration file trigger automatic deployment via AWS CodePipeline and CodeBuild.

## Architecture

```
┌─────────────────────────────────────────────────────────────────────────┐
│                           Git Repository                                 │
│                                                                          │
│   redirects.yaml    ───▶   CodePipeline   ───▶   CodeBuild   ───▶  CDK  │
│   (edit this)              (on push)            (build)          Deploy │
│                                                                          │
└─────────────────────────────────────────────────────────────────────────┘
                                          │
                                          ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                                 AWS                                      │
│                                                                          │
│  For each domain in redirects.yaml:                                     │
│  ┌────────────────────────────────────────────────────────────────────┐ │
│  │  old-brand.com                                                      │ │
│  │  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐              │ │
│  │  │  CloudFront  │  │     ACM      │  │   Route 53   │              │ │
│  │  │ Distribution │──│ Certificate  │  │   A/AAAA     │              │ │
│  │  └──────┬───────┘  └──────────────┘  └──────────────┘              │ │
│  │         │                                                           │ │
│  │         ▼                                                           │ │
│  │  ┌──────────────┐                                                   │ │
│  │  │  CloudFront  │ ◄─── Shared across all distributions              │ │
│  │  │   Function   │      (returns redirect response)                  │ │
│  │  └──────────────┘                                                   │ │
│  └────────────────────────────────────────────────────────────────────┘ │
│                                                                          │
│  ┌────────────────────────────────────────────────────────────────────┐ │
│  │  legacy-site.net  (same pattern...)                                 │ │
│  └────────────────────────────────────────────────────────────────────┘ │
│                                                                          │
│  ┌────────────────────────────────────────────────────────────────────┐ │
│  │  enterprise-old.com  (same pattern...)                              │ │
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

A single CloudFront Function is shared across all distributions. It uses KeyValueStore to look up where each domain should redirect:

```javascript
import cf from 'cloudfront';
const kv = cf.kvs();

async function handler(event) {
  const host = event.request.headers.host.value;
  const redirect = await kv.get(host);  // Sub-ms edge lookup

  if (redirect) {
    const { target, type } = JSON.parse(redirect);
    return {
      statusCode: type === 'permanent' ? 301 : 302,
      headers: { location: { value: target + event.request.uri } }
    };
  }
  // ... fallback handling
}
```

KeyValueStore provides sub-millisecond lookups at the edge and allows updating redirect targets without redeploying the function.

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
  # Permanent redirect (301) - domain is retired forever
  - target: "https://www.brand-a.com"
    type: permanent
    description: "Legacy consumer brand domains"
    domains:
      - old-brand.com
      - www.old-brand.com
      - legacy-site.net

  # Another permanent redirect to a different destination
  - target: "https://www.brand-b.com"
    type: permanent
    description: "Enterprise domains"
    domains:
      - enterprise-old.com
      - b2b-legacy.io

  # Temporary redirect (302) - campaigns, testing, seasonal
  - target: "https://www.brand-a.com/summer-sale"
    type: temporary
    description: "Summer 2024 campaign"
    domains:
      - summer-deals.com
      - hot-sale.com

settings:
  preservePath: true    # old.com/page → target.com/page
  preserveQuery: true   # old.com?ref=x → target.com?ref=x
```

### Redirect Types

| Type | HTTP Code | Use Case | SEO Impact |
|------|-----------|----------|------------|
| `permanent` | 301 | Domain is retired forever | Transfers SEO value to target |
| `temporary` | 302 | Campaigns, testing, seasonal | Original domain keeps SEO value |

### Adding a New Domain

```yaml
# Just add the domain under the appropriate target
domains:
  - existing-domain.com
  - new-domain.com        # ← Add here
```

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

## Project Structure

```
redirector/
├── README.md                   # This file
├── redirects.yaml              # Redirect configuration (edit this)
├── buildspec.yml               # CodeBuild instructions
└── cdk/
    ├── package.json
    ├── cdk.json
    ├── tsconfig.json
    └── lib/
        ├── redirect-stack.ts       # Per-domain distributions + shared function
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

### CloudFront KeyValueStore

| Resource | Limit |
|----------|-------|
| Total size | 5 MB |
| Key size | 512 bytes |
| Value size | 1 KB |

With ~100 bytes per domain entry, KeyValueStore can handle **50,000+ domains**.

### CloudFront Functions

| Resource | Limit |
|----------|-------|
| Functions per account | 25 (default), increasable |
| Code size | 10 KB |
| Execution time | <1 ms typical |

This service uses **one shared function** across all distributions, so the function limit is not a concern.

## AWS Resources Created

**Per domain:**
| Resource | Description |
|----------|-------------|
| CloudFront Distribution | Dedicated CDN for the domain |
| ACM Certificate | Single-domain SSL/TLS certificate (free) |
| Route 53 Records | A/AAAA records pointing to distribution |

**Shared (one total):**
| Resource | Description |
|----------|-------------|
| CloudFront Function | Redirect logic at edge |
| CloudFront KeyValueStore | Redirect target mappings |
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
- KeyValueStore: ~$0.05/month
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

## Validation

The build process validates `redirects.yaml` before deployment:

- YAML syntax check
- Required fields present
- Valid domain format
- No duplicate domains
- Target URLs are valid

If validation fails, the deployment is aborted and an error is reported.

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

One distribution per domain + CloudFront Functions provides:
- **Simplicity**: Add a domain = create one distribution + one cert. No complex certificate management.
- **Performance**: Sub-millisecond redirects at the edge
- **Cost**: Same as single-distribution (~$0.10 per million requests) — CloudFront pricing is usage-based
- **Isolation**: Problems with one domain don't affect others
- **Clean scaling**: Works the same way whether you have 5 domains or 200

## Contributing

1. Create a feature branch
2. Make changes
3. Open a pull request
4. Merge to `main` after approval

## License

Private - Internal use only.

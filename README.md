# Domain Redirector

An AWS-native service that manages HTTP redirects for multiple domains using CloudFront, CloudFront Functions, and KeyValueStore. Configuration is managed via a simple YAML file, making it accessible to non-developers.

## Overview

This service reads from a YAML configuration file and automatically provisions:

- **CloudFront Distribution** — Single distribution handling all domains
- **CloudFront Function** — Edge function that performs redirects based on Host header
- **CloudFront KeyValueStore** — Low-latency datastore for redirect mappings (scales to thousands of domains)
- **ACM Certificates** — SSL/TLS certificates covering all configured domains
- **Route 53 Records** — A/AAAA records pointing domains to CloudFront

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
│  ┌────────────────────────────────────────────────────────────────────┐ │
│  │                    CloudFront Distribution                          │ │
│  │                    (all domains as CNAMEs)                          │ │
│  └─────────────────────────────┬──────────────────────────────────────┘ │
│                                │                                         │
│              ┌─────────────────┼─────────────────┐                      │
│              ▼                 ▼                 ▼                      │
│  ┌─────────────────┐  ┌───────────────┐  ┌─────────────────┐           │
│  │   CloudFront    │  │  KeyValueStore │  │  ACM Certificates│           │
│  │    Function     │◀─│  (redirect     │  │  (up to 100      │           │
│  │  (viewer-request)│  │   mappings)    │  │   domains each)  │           │
│  └─────────────────┘  └───────────────┘  └─────────────────┘           │
│                                                                          │
│  ┌─────────────────┐                                                    │
│  │   Route 53      │  A/AAAA records pointing to CloudFront             │
│  │   Records       │                                                    │
│  └─────────────────┘                                                    │
└─────────────────────────────────────────────────────────────────────────┘
```

### Why KeyValueStore?

CloudFront Functions have a **10 KB code size limit**, which is quickly exceeded when hardcoding hundreds of redirect mappings. CloudFront KeyValueStore solves this:

| Approach | Limit | Best For |
|----------|-------|----------|
| Hardcoded in function | 10 KB code limit | <50 simple redirects |
| **KeyValueStore** | 5 MB total | Hundreds/thousands of redirects |

KeyValueStore provides:
- **Sub-millisecond lookups** at the edge
- **Dynamic updates** without redeploying the function
- **5 MB capacity** — easily handles 1000+ domains

```javascript
// How the CloudFront Function works
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
        ├── redirect-stack.ts       # CloudFront + Function + KeyValueStore
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

### ACM Certificates

| Quota | Default | Maximum |
|-------|---------|---------|
| Domains per certificate | 10 | 100 (request increase via Service Quotas) |

For 250 domains, the service automatically creates multiple certificates (3 certificates for 250 domains).

### CloudFront KeyValueStore

| Resource | Limit |
|----------|-------|
| Total size | 5 MB |
| Key size | 512 bytes |
| Value size | 1 KB |
| Stores per function | 1 |

With an average of ~100 bytes per domain entry, KeyValueStore can handle **50,000+ domains**.

### CloudFront Functions

| Resource | Limit |
|----------|-------|
| Code size | 10 KB |
| Runtime | cloudfront-js-2.0 |
| Execution time | <1 ms typical |

## AWS Resources Created

| Resource | Description | Estimated Cost |
|----------|-------------|----------------|
| CloudFront Distribution | CDN for all domains | ~$1-5/month (traffic dependent) |
| CloudFront Function | Redirect logic at edge | ~$0.10 per 1M requests |
| CloudFront KeyValueStore | Redirect mappings | ~$0.05/month + reads |
| ACM Certificates | SSL/TLS (multiple if >100 domains) | Free |
| Route 53 Records | DNS entries | Included in hosted zone cost |
| CodePipeline | CI/CD pipeline | $1/month |
| CodeBuild | Build environment | ~$0.01 per deploy |

**Total estimated cost: $3-10/month** (depends on traffic volume)

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
| Lambda@Edge | Slower (~5ms vs <1ms), more expensive, region-locked deployment |
| S3 Website Redirect | Requires one bucket per redirect config, no dynamic logic |
| ALB Redirect Rules | Requires running infrastructure, significantly more expensive |
| API Gateway | Overkill for simple redirects, higher latency |

CloudFront Functions + KeyValueStore provides the best combination of:
- **Performance**: Sub-millisecond redirects at the edge
- **Cost**: ~$0.10 per million requests
- **Scale**: Handles thousands of domains
- **Simplicity**: No servers to manage

## Contributing

1. Create a feature branch
2. Make changes
3. Open a pull request
4. Merge to `main` after approval

## License

Private - Internal use only.

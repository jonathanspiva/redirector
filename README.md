# Domain Redirector

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.4-blue.svg)](https://www.typescriptlang.org/)
[![AWS CDK](https://img.shields.io/badge/AWS%20CDK-2.170+-orange.svg)](https://aws.amazon.com/cdk/)
[![Node.js](https://img.shields.io/badge/Node.js-20+-green.svg)](https://nodejs.org/)
[![Security: cdk-nag](https://img.shields.io/badge/Security-cdk--nag-blueviolet.svg)](https://github.com/cdklabs/cdk-nag)
[![AWS Well-Architected](https://img.shields.io/badge/AWS-Well--Architected-FF9900.svg)](https://aws.amazon.com/architecture/well-architected/)

**Manage HTTP redirects for multiple domains with a simple YAML file.**

An AWS-native service that provisions CloudFront distributions and CloudFront Functions to handle domain redirects at the edge. Configuration-driven, fully automated, and built with security best practices.

---

## Features

- **YAML-based configuration** - Add domains by editing a simple config file
- **Automatic deployment** - Push to `main` and resources are provisioned via CodePipeline
- **Edge-based redirects** - Sub-millisecond response times using CloudFront Functions
- **Wildcard support** - Redirect `*.example.com` to catch all subdomains
- **Path & query preservation** - `old.com/page?ref=x` redirects to `new.com/page?ref=x`
- **One distribution per domain** - Isolated, predictable, no certificate juggling
- **Security hardened** - cdk-nag validated, IAM least privilege, encrypted artifacts

---

## Table of Contents

- [Quick Start](#quick-start)
- [How It Works](#how-it-works)
- [Configuration](#configuration)
- [Setup Guide](#setup-guide)
- [Project Structure](#project-structure)
- [Security](#security)
- [AWS Resources & Costs](#aws-resources--costs)
- [Validation & Testing](#validation--testing)
- [Troubleshooting](#troubleshooting)
- [Contributing](#contributing)
- [License](#license)

---

## Quick Start

### For Non-Developers (Editing Redirects)

1. Open `redirects.yaml` in GitHub
2. Add your domain under the appropriate target
3. Commit to `main` branch
4. Deployment happens automatically

```yaml
redirects:
  - target: "https://www.example.com"
    type: permanent
    domains:
      - old-domain.com
      - legacy-site.com    # Add new domains here
```

### For Developers (Initial Setup)

See the full [Setup Guide](#setup-guide) below.

---

## How It Works

### Architecture

```
┌─────────────────────────────────────────────────────────────────────────┐
│                           Git Repository                                 │
│                                                                          │
│   redirects.yaml  ───▶  CodePipeline  ───▶  CodeBuild                   │
│   (edit this)           (on push)           │                            │
│                                             ├──▶  Validate YAML          │
│                                             ├──▶  CDK Deploy             │
│                                             └──▶  Smoke Tests            │
└─────────────────────────────────────────────────────────────────────────┘
                                          │
                                          ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                                 AWS                                      │
│                                                                          │
│  CloudFront Functions (one per destination):                            │
│  ┌──────────────────────────────────────────────────────────────────┐   │
│  │  redirect-to-brand-a           →  https://www.brand-a.com        │   │
│  │  redirect-to-brand-a-acquired  →  https://www.brand-a.com/acquired│  │
│  └──────────────────────────────────────────────────────────────────┘   │
│                                                                          │
│  Per-domain resources:                                                   │
│  ┌────────────────────────────────────────────────────────────────────┐ │
│  │  old-brand.com                                                      │ │
│  │  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐              │ │
│  │  │  CloudFront  │  │     ACM      │  │   Route 53   │              │ │
│  │  │ Distribution │──│ Certificate  │  │   A/AAAA     │              │ │
│  │  └──────┬───────┘  └──────────────┘  └──────────────┘              │ │
│  │         └──────────▶  redirect-to-brand-a function                  │ │
│  └────────────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────────────┘
```

### Why One Distribution Per Domain?

This architecture creates a dedicated CloudFront distribution for each source domain. While this seems like more resources, it **dramatically simplifies certificate management**:

| Approach | Certificate Complexity | Scaling |
|----------|------------------------|---------|
| Single distribution, multi-domain certs | Complex (max 100 SANs per cert, must track which domain is on which cert) | Hits limits quickly |
| **One distribution per domain** | Simple (1 domain = 1 cert, add/remove independently) | Linear, predictable |

**Benefits:**
- **No certificate juggling** - Each domain gets its own ACM certificate
- **Isolated changes** - Adding domain #51 doesn't touch domains 1-50
- **Clean removal** - Deleting a domain removes only its resources
- **Incremental deploys** - CDK only creates/updates changed resources

### The Redirect Function

Each unique destination target gets its own CloudFront Function:

```javascript
// Auto-generated: redirect-to-brand-a.js
function handler(event) {
  var url = "https://www.brand-a.com";
  url += event.request.uri;  // Preserve path
  // ... query string handling
  return {
    statusCode: 301,
    headers: { location: { value: url } }
  };
}
```

---

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

  # Acquired company → landing page (no path preservation)
  - target: "https://www.brand-a.com/acquired"
    type: permanent
    preservePath: false
    domains:
      - acquired-company.com

settings:
  preservePath: true    # Default: old.com/page → target.com/page
  preserveQuery: true   # Default: old.com?ref=x → target.com?ref=x
```

### Configuration Reference

| Field | Required | Default | Description |
|-------|----------|---------|-------------|
| `target` | Yes | - | Destination URL (must be HTTPS) |
| `type` | Yes | - | `permanent` (301) or `temporary` (302) |
| `domains` | Yes | - | Array of source domains |
| `description` | No | - | Documentation comment |
| `preservePath` | No | `true` | Append original path to target |
| `preserveQuery` | No | `true` | Append original query string |
| `active` | No | `true` | Set `false` to disable without removing |
| `skipTest` | No | - | Domains to skip in smoke tests |

### Wildcard Domains

Use wildcards to catch all subdomains:

```yaml
domains:
  - old-brand.com        # Matches: old-brand.com
  - "*.old-brand.com"    # Matches: www.old-brand.com, mail.old-brand.com, etc.
```

**Note:** Wildcards don't match the apex domain. Include both for full coverage.

---

## Setup Guide

### Prerequisites

- AWS CLI configured with credentials for your account
- Node.js 20+
- AWS CDK CLI (`npm install -g aws-cdk`)
- **Source domains must have hosted zones in Route 53** (in the same account)

### Fork and deploy

```bash
# 1. Fork this repo on GitHub, then clone your fork
git clone https://github.com/<your-username>/redirector.git
cd redirector/cdk

# 2. Install dependencies
npm install

# 3. Configure your account (region is always us-east-1)
cp .env.example .env
# Edit .env: set CDK_DEFAULT_ACCOUNT (required).
# Leave the GITHUB_* values blank for now if you just want to deploy by hand.

# 4. Add your domains
cp ../redirects.example.yaml ../redirects.yaml
# Edit ../redirects.yaml with your domains and targets.

# 5. Bootstrap CDK in the account (first time only)
npx cdk bootstrap

# 6. Deploy the redirects
npx cdk deploy RedirectStack
```

That's it for a manual setup: re-run `npx cdk deploy RedirectStack` whenever
you edit `redirects.yaml`.

### Optional: automatic deploys on push

To have a CodePipeline redeploy automatically every time you push to `main`:

1. In the AWS Console, create a GitHub connection
   (**Developer Tools → Settings → Connections → Create connection → GitHub**)
   and authorize it for your fork.
2. Put the connection ARN and your repo details in `.env`
   (`GITHUB_CONNECTION_ARN`, `GITHUB_OWNER`, `GITHUB_REPO`).
3. Deploy the pipeline: `npx cdk deploy PipelineStack`.

The pipeline stack is only created when all three `GITHUB_*` values are set.
After that, edits to `redirects.yaml` on `main` deploy automatically.

### Using as a Submodule (Private Config)

Keep your redirect configuration private while using this open source tool:

```bash
# Create a private repository
mkdir my-redirects && cd my-redirects
git init

# Add this repo as a submodule
git submodule add https://github.com/jonathanspiva/redirector.git tool

# Create your private redirects.yaml
cat > redirects.yaml << 'EOF'
redirects:
  - target: "https://www.mycompany.com"
    type: permanent
    domains:
      - old-domain.com
settings:
  preservePath: true
  preserveQuery: true
EOF
```

**Directory structure:**
```
my-redirects/           # Your private repo
├── redirects.yaml      # Your private config
├── package.json        # Wrapper scripts
└── tool/               # Submodule (this public repo)
```

---

## Project Structure

```
redirector/
├── README.md                   # This file
├── LICENSE                     # MIT License
├── redirects.example.yaml      # Copy to redirects.yaml and edit
├── redirects.yaml              # Your config (commit it, or keep private via submodule)
├── buildspec.yml               # CodeBuild: deploy + smoke test
└── cdk/
    ├── package.json
    ├── .env.example            # Copy to .env and set your account/GitHub values
    ├── bin/
    │   └── app.ts              # CDK app entry point (loads .env)
    ├── lib/
    │   ├── redirect-stack.ts   # Per-domain distributions
    │   ├── pipeline-stack.ts   # CI/CD infrastructure
    │   └── config/
    │       ├── types.ts        # TypeScript types
    │       ├── parser.ts       # YAML parsing
    │       └── validator.ts    # Pre-deployment validation
    ├── scripts/
    │   ├── preflight-check.ts  # Pre-deploy Route 53 conflict checks
    │   └── smoke-test.ts       # Post-deployment verification
    └── test/                   # Jest test suites
```

---

## Security

This project follows AWS security best practices and is validated against industry frameworks.

### Security Features

| Feature | Implementation |
|---------|----------------|
| **IaC Security Scanning** | [cdk-nag](https://github.com/cdklabs/cdk-nag) with AwsSolutionsChecks |
| **IAM Least Privilege** | Policies scoped to specific resources, no `*` where avoidable |
| **Encryption at Rest** | KMS encryption for pipeline artifacts with key rotation |
| **Encryption in Transit** | TLS 1.2+ enforced on all CloudFront distributions |
| **S3 Security** | Public access blocked, versioning enabled, SSL enforced |
| **Dependency Scanning** | npm audit in CI, Dependabot for automated updates |

### Compliance Alignment

- **[AWS Well-Architected Framework](https://aws.amazon.com/architecture/well-architected/)** - Security Pillar
- **[CIS AWS Foundations Benchmark](https://www.cisecurity.org/benchmark/amazon_web_services)** - IAM and S3 controls

### Security Architecture

- All redirects use HTTPS
- CloudFront enforces TLS 1.2+
- No origin servers required (CloudFront Function responds at edge)
- CodeBuild runs in isolated environment
- No sensitive data stored (only domain-to-target mappings)

---

## AWS Resources & Costs

### Resources Created

**Per domain:**
| Resource | Description |
|----------|-------------|
| CloudFront Distribution | Dedicated CDN for the domain |
| ACM Certificate | Single-domain SSL/TLS certificate (free) |
| Route 53 Records | A/AAAA records pointing to distribution |

**Per destination target:**
| Resource | Description |
|----------|-------------|
| CloudFront Function | Redirect logic (~200 bytes each) |

**Shared (pipeline):**
| Resource | Description |
|----------|-------------|
| CodePipeline | CI/CD pipeline |
| CodeBuild | Build environment |
| S3 Bucket | Encrypted artifact storage |
| KMS Key | Artifact encryption (auto-rotating) |

### Cost Estimates

CloudFront pricing is usage-based, not per-distribution:

| Traffic Level | Monthly Requests | Estimated Cost |
|---------------|------------------|----------------|
| Low | 100K | ~$2/month |
| Medium | 1M | ~$3/month |
| High | 10M | ~$12/month |

**Breakdown:**
- HTTPS requests: $0.01 per 10,000
- CloudFront Function: $0.10 per 1M invocations
- ACM Certificates: Free
- CodePipeline: $1/month
- Route 53: Included in hosted zone cost

### Service Limits

| Service | Default Limit | Notes |
|---------|---------------|-------|
| CloudFront Distributions | 200 | Request increase for more domains |
| ACM Certificates | 2,500 | More than sufficient |
| CloudFront Functions | 25 | One per destination target |

---

## Validation & Testing

### Pre-Deployment Validation

Before infrastructure changes, CodeBuild validates `redirects.yaml`:

| Check | Example Error |
|-------|---------------|
| Valid YAML syntax | `line 12: mapping values not allowed here` |
| Target is HTTPS URL | `must be HTTPS URL, got "http://..."` |
| Valid domain format | `invalid domain format "not a domain"` |
| No duplicate domains | `duplicate domain "old.com"` |
| Route 53 hosted zone exists | `no hosted zone found for "old.com"` |

### Post-Deployment Smoke Tests

After each deployment, CodeBuild verifies redirects are working:

```
Testing old-brand.com...
  ✓ HTTP 301 Moved Permanently
  ✓ Location: https://www.brand-a.com/
All redirect tests passed.
```

### Running Tests Locally

```bash
cd cdk

# Run all tests
npm test

# Run with coverage
npm test -- --coverage

# Run specific test file
npm test -- validator.test.ts
```

---

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

### "No Hosted Zone Found" Error

The domain isn't in Route 53. Options:
1. Create a hosted zone in Route 53 and update registrar NS records
2. Migrate DNS to Route 53

### Certificate Pending Validation

ACM certificates require DNS validation. Ensure validation CNAME records exist in Route 53.

---

## Contributing

Contributions are welcome! Please:

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/amazing-feature`)
3. Make your changes
4. Run tests (`npm test`)
5. Commit (`git commit -m 'Add amazing feature'`)
6. Push (`git push origin feature/amazing-feature`)
7. Open a Pull Request

### Development

```bash
cd cdk
npm install
npm run build    # Compile TypeScript
npm test         # Run tests
npx cdk synth    # Synthesize CloudFormation (checks cdk-nag)
```

---

## Inspiration

This project builds upon ideas from:

- **[aws-samples/amazon-cloudfront-redirector](https://github.com/aws-samples/amazon-cloudfront-redirector)** - CloudFront Functions + KeyValueStore approach
- **[spencerbeggs/aws-cdk-domain-redirect](https://github.com/spencerbeggs/aws-cdk-domain-redirect)** - CDK construct with Lambda@Edge
- **[Cloudar Blog](https://cloudar.be/awsblog/enhancing-redirect-strategies-with-aws-cloudfront-functions-and-keyvaluestore/)** - Redirect strategies with KeyValueStore

---

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

---

<p align="center">
  <sub>Built with AWS CDK and CloudFront Functions</sub>
</p>

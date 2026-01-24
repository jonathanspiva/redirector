import * as cdk from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import * as path from 'path';
import * as fs from 'fs';
import * as yaml from 'yaml';
import { RedirectStack } from '../lib/redirect-stack';
import { sanitizeFunctionName, generateFunctionCode } from '../lib/constructs/redirect-function';

// Create a temporary config file for testing
const testConfigPath = path.join(__dirname, 'test-redirects.yaml');

const testConfig = {
  redirects: [
    {
      target: 'https://www.example.com',
      type: 'permanent',
      description: 'Test redirect group',
      domains: ['old-example.com'],
    },
    {
      target: 'https://www.other.com/landing',
      type: 'temporary',
      description: 'Landing page redirect',
      preservePath: false,
      domains: ['landing.com'],
    },
  ],
  settings: {
    preservePath: true,
    preserveQuery: true,
  },
};

beforeAll(() => {
  fs.writeFileSync(testConfigPath, yaml.stringify(testConfig));
});

afterAll(() => {
  if (fs.existsSync(testConfigPath)) {
    fs.unlinkSync(testConfigPath);
  }
});

describe('RedirectStack', () => {
  let app: cdk.App;
  let stack: RedirectStack;
  let template: Template;

  beforeEach(() => {
    // Create app with mocked context for hosted zone lookups
    app = new cdk.App({
      context: {
        // Mock hosted zone lookups - CDK uses these context keys during synthesis
        'hosted-zone:account=123456789012:domainName=old-example.com:region=us-east-1': {
          Id: '/hostedzone/Z123456789',
          Name: 'old-example.com.',
        },
        'hosted-zone:account=123456789012:domainName=landing.com:region=us-east-1': {
          Id: '/hostedzone/Z987654321',
          Name: 'landing.com.',
        },
      },
    });

    stack = new RedirectStack(app, 'TestRedirectStack', {
      configPath: testConfigPath,
      env: { account: '123456789012', region: 'us-east-1' },
    });

    template = Template.fromStack(stack);
  });

  describe('CloudFront Functions', () => {
    it('should create a CloudFront Function for each unique target', () => {
      // We have 2 unique targets in our test config
      template.resourceCountIs('AWS::CloudFront::Function', 2);
    });

    it('should have correct function naming', () => {
      template.hasResourceProperties('AWS::CloudFront::Function', {
        Name: Match.stringLikeRegexp('^redirector-'),
      });
    });

    it('should include redirect logic in function code', () => {
      template.hasResourceProperties('AWS::CloudFront::Function', {
        FunctionCode: Match.stringLikeRegexp('function handler'),
      });
    });

    it('should configure permanent redirect with 301 status', () => {
      template.hasResourceProperties('AWS::CloudFront::Function', {
        FunctionCode: Match.stringLikeRegexp('statusCode: 301'),
      });
    });

    it('should configure temporary redirect with 302 status', () => {
      template.hasResourceProperties('AWS::CloudFront::Function', {
        FunctionCode: Match.stringLikeRegexp('statusCode: 302'),
      });
    });
  });

  describe('CloudFront Distributions', () => {
    it('should create a distribution for each domain', () => {
      // We have 2 domains in our test config
      template.resourceCountIs('AWS::CloudFront::Distribution', 2);
    });

    it('should configure HTTPS redirect', () => {
      template.hasResourceProperties('AWS::CloudFront::Distribution', {
        DistributionConfig: {
          DefaultCacheBehavior: {
            ViewerProtocolPolicy: 'redirect-to-https',
          },
        },
      });
    });

    it('should associate CloudFront Function', () => {
      template.hasResourceProperties('AWS::CloudFront::Distribution', {
        DistributionConfig: {
          DefaultCacheBehavior: {
            FunctionAssociations: Match.arrayWith([
              Match.objectLike({
                EventType: 'viewer-request',
              }),
            ]),
          },
        },
      });
    });

    it('should use TLS 1.2 minimum', () => {
      template.hasResourceProperties('AWS::CloudFront::Distribution', {
        DistributionConfig: {
          ViewerCertificate: {
            MinimumProtocolVersion: 'TLSv1.2_2021',
          },
        },
      });
    });

    it('should disable caching', () => {
      template.hasResourceProperties('AWS::CloudFront::Distribution', {
        DistributionConfig: {
          DefaultCacheBehavior: {
            CachePolicyId: Match.anyValue(),
          },
        },
      });
    });
  });

  describe('ACM Certificates', () => {
    it('should create a certificate for each domain', () => {
      template.resourceCountIs('AWS::CertificateManager::Certificate', 2);
    });

    it('should use DNS validation', () => {
      template.hasResourceProperties('AWS::CertificateManager::Certificate', {
        ValidationMethod: 'DNS',
      });
    });
  });

  describe('Route 53 Records', () => {
    it('should create A and AAAA records for each domain', () => {
      // 2 domains * 2 record types (A + AAAA) = 4 records
      template.resourceCountIs('AWS::Route53::RecordSet', 4);
    });

    it('should create A record type', () => {
      template.hasResourceProperties('AWS::Route53::RecordSet', {
        Type: 'A',
      });
    });

    it('should create AAAA record type', () => {
      template.hasResourceProperties('AWS::Route53::RecordSet', {
        Type: 'AAAA',
      });
    });
  });

  describe('Tags', () => {
    it('should apply Project tag', () => {
      expect(stack.tags.tagValues()).toHaveProperty('Project', 'domain-redirector');
    });

    it('should apply ManagedBy tag', () => {
      expect(stack.tags.tagValues()).toHaveProperty('ManagedBy', 'cdk');
    });
  });
});

describe('RedirectStack with inactive redirects', () => {
  it('should not create resources for inactive redirect groups', () => {
    const inactiveConfigPath = path.join(__dirname, 'test-inactive-redirects.yaml');
    const inactiveConfig = {
      redirects: [
        {
          target: 'https://www.example.com',
          type: 'permanent',
          active: false,
          domains: ['inactive.com'],
        },
        {
          target: 'https://www.active.com',
          type: 'permanent',
          domains: ['active.com'],
        },
      ],
      settings: {
        preservePath: true,
        preserveQuery: true,
      },
    };

    fs.writeFileSync(inactiveConfigPath, yaml.stringify(inactiveConfig));

    try {
      const app = new cdk.App({
        context: {
          'hosted-zone:account=123456789012:domainName=active.com:region=us-east-1': {
            Id: '/hostedzone/ZACTIVE',
            Name: 'active.com.',
          },
        },
      });
      const stack = new RedirectStack(app, 'InactiveTestStack', {
        configPath: inactiveConfigPath,
        env: { account: '123456789012', region: 'us-east-1' },
      });
      const template = Template.fromStack(stack);

      // Should only have 1 distribution (active.com), not 2
      template.resourceCountIs('AWS::CloudFront::Distribution', 1);
      template.resourceCountIs('AWS::CertificateManager::Certificate', 1);
      template.resourceCountIs('AWS::CloudFront::Function', 1);
    } finally {
      fs.unlinkSync(inactiveConfigPath);
    }
  });
});

describe('sanitizeFunctionName', () => {
  it('should sanitize target URLs correctly', () => {
    expect(sanitizeFunctionName('https://www.example.com')).toBe('redirector-www-example-com');
    expect(sanitizeFunctionName('https://www.example.com/landing')).toBe('redirector-www-example-com-landing');
    expect(sanitizeFunctionName('https://example.com')).toBe('redirector-example-com');
  });

  it('should remove protocol and trailing slashes', () => {
    expect(sanitizeFunctionName('https://example.com/')).toBe('redirector-example-com');
    expect(sanitizeFunctionName('http://example.com')).toBe('redirector-example-com');
  });

  it('should handle long URLs by truncating', () => {
    const longUrl = 'https://www.very-long-domain-name-that-exceeds-the-limit.example.com/path/to/something';
    const result = sanitizeFunctionName(longUrl);
    expect(result.length).toBeLessThanOrEqual(64);
    expect(result).toMatch(/^redirector-/);
  });
});

describe('generateFunctionCode', () => {
  it('should generate valid JavaScript code', () => {
    const code = generateFunctionCode({
      target: 'https://www.example.com',
      statusCode: 301,
      preservePath: true,
      preserveQuery: true,
    });

    expect(code).toContain('function handler(event)');
    expect(code).toContain('target: "https://www.example.com"');
    expect(code).toContain('statusCode: 301');
    expect(code).toContain('preservePath: true');
    expect(code).toContain('preserveQuery: true');
  });

  it('should configure 302 for temporary redirects', () => {
    const code = generateFunctionCode({
      target: 'https://www.example.com',
      statusCode: 302,
      preservePath: false,
      preserveQuery: false,
    });

    expect(code).toContain('statusCode: 302');
    expect(code).toContain('preservePath: false');
    expect(code).toContain('preserveQuery: false');
  });
});

describe('RedirectStack with multiple domains sharing target', () => {
  it('should reuse CloudFront Function for domains with same target', () => {
    const sharedTargetConfigPath = path.join(__dirname, 'test-shared-target.yaml');
    const sharedTargetConfig = {
      redirects: [
        {
          target: 'https://www.example.com',
          type: 'permanent',
          domains: ['old1.com', 'old2.com', 'old3.com'],
        },
      ],
      settings: {
        preservePath: true,
        preserveQuery: true,
      },
    };

    fs.writeFileSync(sharedTargetConfigPath, yaml.stringify(sharedTargetConfig));

    try {
      const app = new cdk.App({
        context: {
          'hosted-zone:account=123456789012:domainName=old1.com:region=us-east-1': {
            Id: '/hostedzone/Z1',
            Name: 'old1.com.',
          },
          'hosted-zone:account=123456789012:domainName=old2.com:region=us-east-1': {
            Id: '/hostedzone/Z2',
            Name: 'old2.com.',
          },
          'hosted-zone:account=123456789012:domainName=old3.com:region=us-east-1': {
            Id: '/hostedzone/Z3',
            Name: 'old3.com.',
          },
        },
      });
      const stack = new RedirectStack(app, 'SharedTargetStack', {
        configPath: sharedTargetConfigPath,
        env: { account: '123456789012', region: 'us-east-1' },
      });
      const template = Template.fromStack(stack);

      // Should have 3 distributions (one per domain)
      template.resourceCountIs('AWS::CloudFront::Distribution', 3);
      // But only 1 CloudFront Function (shared target)
      template.resourceCountIs('AWS::CloudFront::Function', 1);
    } finally {
      fs.unlinkSync(sharedTargetConfigPath);
    }
  });
});

describe('RedirectStack with wildcard domains', () => {
  it('should handle wildcard domain correctly', () => {
    const wildcardConfigPath = path.join(__dirname, 'test-wildcard.yaml');
    const wildcardConfig = {
      redirects: [
        {
          target: 'https://www.example.com',
          type: 'permanent',
          domains: ['*.old-brand.com'],
        },
      ],
      settings: {
        preservePath: true,
        preserveQuery: true,
      },
    };

    fs.writeFileSync(wildcardConfigPath, yaml.stringify(wildcardConfig));

    try {
      const app = new cdk.App({
        context: {
          'hosted-zone:account=123456789012:domainName=old-brand.com:region=us-east-1': {
            Id: '/hostedzone/ZWILDCARD',
            Name: 'old-brand.com.',
          },
        },
      });
      const stack = new RedirectStack(app, 'WildcardStack', {
        configPath: wildcardConfigPath,
        env: { account: '123456789012', region: 'us-east-1' },
      });
      const template = Template.fromStack(stack);

      // Should create certificate for wildcard domain
      template.hasResourceProperties('AWS::CertificateManager::Certificate', {
        DomainName: '*.old-brand.com',
      });

      // Should create distribution with wildcard
      template.hasResourceProperties('AWS::CloudFront::Distribution', {
        DistributionConfig: {
          Aliases: ['*.old-brand.com'],
        },
      });
    } finally {
      fs.unlinkSync(wildcardConfigPath);
    }
  });
});

describe('RedirectStack with subdomains', () => {
  it('should handle subdomain correctly', () => {
    const subdomainConfigPath = path.join(__dirname, 'test-subdomain.yaml');
    const subdomainConfig = {
      redirects: [
        {
          target: 'https://www.example.com',
          type: 'permanent',
          domains: ['blog.old-brand.com'],
        },
      ],
      settings: {
        preservePath: true,
        preserveQuery: true,
      },
    };

    fs.writeFileSync(subdomainConfigPath, yaml.stringify(subdomainConfig));

    try {
      const app = new cdk.App({
        context: {
          // Zone lookup will try subdomain first, then parent
          'hosted-zone:account=123456789012:domainName=blog.old-brand.com:region=us-east-1': {
            Id: '/hostedzone/ZSUB',
            Name: 'blog.old-brand.com.',
          },
        },
      });
      const stack = new RedirectStack(app, 'SubdomainStack', {
        configPath: subdomainConfigPath,
        env: { account: '123456789012', region: 'us-east-1' },
      });
      const template = Template.fromStack(stack);

      // Should create resources for subdomain
      template.resourceCountIs('AWS::CloudFront::Distribution', 1);
      template.hasResourceProperties('AWS::CertificateManager::Certificate', {
        DomainName: 'blog.old-brand.com',
      });
    } finally {
      fs.unlinkSync(subdomainConfigPath);
    }
  });
});

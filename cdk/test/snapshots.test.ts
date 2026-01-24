/**
 * Snapshot tests for CDK stacks.
 *
 * These tests capture the synthesized CloudFormation template and compare
 * against stored snapshots to detect unintended infrastructure changes.
 *
 * To update snapshots when intentional changes are made:
 *   npm test -- -u
 */

import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import * as path from 'path';
import * as fs from 'fs';
import * as yaml from 'yaml';
import { RedirectStack } from '../lib/redirect-stack';
import { PipelineStack } from '../lib/pipeline-stack';

describe('RedirectStack Snapshots', () => {
  const snapshotConfigPath = path.join(__dirname, 'snapshot-config.yaml');

  beforeAll(() => {
    // Create a deterministic config for snapshot testing
    const config = {
      redirects: [
        {
          target: 'https://www.primary.com',
          type: 'permanent',
          description: 'Primary domain redirect',
          domains: ['old-primary.com'],
          preservePath: true,
          preserveQuery: true,
        },
        {
          target: 'https://www.secondary.com/landing',
          type: 'temporary',
          description: 'Landing page redirect',
          domains: ['promo.com'],
          preservePath: false,
          preserveQuery: false,
        },
      ],
      settings: {
        preservePath: true,
        preserveQuery: true,
      },
    };

    fs.writeFileSync(snapshotConfigPath, yaml.stringify(config));
  });

  afterAll(() => {
    if (fs.existsSync(snapshotConfigPath)) {
      fs.unlinkSync(snapshotConfigPath);
    }
  });

  it('should match CloudFormation template snapshot', () => {
    const app = new cdk.App({
      context: {
        'hosted-zone:account=123456789012:domainName=old-primary.com:region=us-east-1': {
          Id: '/hostedzone/ZPRIMARY',
          Name: 'old-primary.com.',
        },
        'hosted-zone:account=123456789012:domainName=promo.com:region=us-east-1': {
          Id: '/hostedzone/ZPROMO',
          Name: 'promo.com.',
        },
      },
    });

    const stack = new RedirectStack(app, 'SnapshotRedirectStack', {
      configPath: snapshotConfigPath,
      env: { account: '123456789012', region: 'us-east-1' },
    });

    const template = Template.fromStack(stack);
    const templateJson = template.toJSON();

    // Remove volatile fields that change between runs
    sanitizeTemplate(templateJson);

    expect(templateJson).toMatchSnapshot();
  });

  it('should match resource counts snapshot', () => {
    const app = new cdk.App({
      context: {
        'hosted-zone:account=123456789012:domainName=old-primary.com:region=us-east-1': {
          Id: '/hostedzone/ZPRIMARY',
          Name: 'old-primary.com.',
        },
        'hosted-zone:account=123456789012:domainName=promo.com:region=us-east-1': {
          Id: '/hostedzone/ZPROMO',
          Name: 'promo.com.',
        },
      },
    });

    const stack = new RedirectStack(app, 'CountSnapshotStack', {
      configPath: snapshotConfigPath,
      env: { account: '123456789012', region: 'us-east-1' },
    });

    const template = Template.fromStack(stack);

    const resourceCounts = {
      'AWS::CloudFront::Distribution': countResources(template, 'AWS::CloudFront::Distribution'),
      'AWS::CloudFront::Function': countResources(template, 'AWS::CloudFront::Function'),
      'AWS::CertificateManager::Certificate': countResources(template, 'AWS::CertificateManager::Certificate'),
      'AWS::Route53::RecordSet': countResources(template, 'AWS::Route53::RecordSet'),
    };

    expect(resourceCounts).toMatchSnapshot();
  });
});

describe('PipelineStack Snapshots', () => {
  it('should match CloudFormation template snapshot', () => {
    const app = new cdk.App();

    const stack = new PipelineStack(app, 'SnapshotPipelineStack', {
      connectionArn: 'arn:aws:codestar-connections:us-east-1:123456789012:connection/test-connection-id',
      owner: 'test-owner',
      repo: 'test-repo',
      branch: 'main',
      env: { account: '123456789012', region: 'us-east-1' },
    });

    const template = Template.fromStack(stack);
    const templateJson = template.toJSON();

    // Remove volatile fields
    sanitizeTemplate(templateJson);

    expect(templateJson).toMatchSnapshot();
  });

  it('should match resource counts snapshot', () => {
    const app = new cdk.App();

    const stack = new PipelineStack(app, 'CountPipelineStack', {
      connectionArn: 'arn:aws:codestar-connections:us-east-1:123456789012:connection/test-connection-id',
      owner: 'test-owner',
      repo: 'test-repo',
      env: { account: '123456789012', region: 'us-east-1' },
    });

    const template = Template.fromStack(stack);

    const resourceCounts = {
      'AWS::CodePipeline::Pipeline': countResources(template, 'AWS::CodePipeline::Pipeline'),
      'AWS::CodeBuild::Project': countResources(template, 'AWS::CodeBuild::Project'),
      'AWS::IAM::Role': countResources(template, 'AWS::IAM::Role'),
      'AWS::IAM::Policy': countResources(template, 'AWS::IAM::Policy'),
      'AWS::S3::Bucket': countResources(template, 'AWS::S3::Bucket'),
    };

    expect(resourceCounts).toMatchSnapshot();
  });
});

/**
 * Sanitize template by removing volatile fields that change between synthesis runs.
 * This allows snapshot comparison to focus on meaningful infrastructure changes.
 */
function sanitizeTemplate(template: Record<string, unknown>): void {
  const resources = template.Resources as Record<string, Record<string, unknown>> | undefined;
  if (!resources) return;

  for (const [, resource] of Object.entries(resources)) {
    const properties = resource.Properties as Record<string, unknown> | undefined;
    if (!properties) continue;

    // Remove asset hashes from S3 keys
    if (typeof properties.S3Key === 'string' && properties.S3Key.includes('.zip')) {
      properties.S3Key = 'ASSET_HASH_REMOVED';
    }

    // Remove generated function names (contain timestamps/hashes)
    if (typeof properties.FunctionName === 'string' && properties.FunctionName.includes('-')) {
      // Keep the prefix pattern but normalize the hash part
      properties.FunctionName = properties.FunctionName.replace(/[a-f0-9]{8,}$/i, 'HASH');
    }
  }

  // Remove CDK metadata
  delete template.Rules;
  const params = template.Parameters as Record<string, unknown> | undefined;
  if (params) {
    delete params.BootstrapVersion;
  }
}

/**
 * Count resources of a specific type in the template.
 */
function countResources(template: Template, resourceType: string): number {
  try {
    const resources = template.findResources(resourceType);
    return Object.keys(resources).length;
  } catch {
    return 0;
  }
}

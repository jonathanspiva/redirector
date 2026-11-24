/**
 * cdk-nag compliance tests.
 *
 * cdk-nag v3 runs as a CDK policy validation plugin: synthesis throws if any
 * AwsSolutions rule is violated and not acknowledged with a documented reason.
 */

import { App, Validations } from 'aws-cdk-lib';
import { AwsSolutionsChecks } from 'cdk-nag';
import * as path from 'path';
import { PipelineStack } from '../lib/pipeline-stack';
import { RedirectStack } from '../lib/redirect-stack';

const env = { account: '123456789012', region: 'us-east-1' };

function appWithChecks(): App {
  const app = new App();
  Validations.of(app).addPlugins(new AwsSolutionsChecks(app));
  return app;
}

describe('cdk-nag AwsSolutions compliance', () => {
  it('PipelineStack has no unacknowledged violations', () => {
    const app = appWithChecks();
    new PipelineStack(app, 'TestPipelineStack', {
      connectionArn: 'arn:aws:codestar-connections:us-east-1:123456789012:connection/test-id',
      owner: 'test-owner',
      repo: 'test-repo',
      env,
    });

    expect(() => app.synth()).not.toThrow();
  });

  it('RedirectStack has no unacknowledged violations', () => {
    const app = appWithChecks();
    new RedirectStack(app, 'TestRedirectStack', {
      env,
      configPath: path.join(__dirname, '..', '..', 'redirects.example.yaml'),
    });

    expect(() => app.synth()).not.toThrow();
  });

  it('fails synthesis when a violation is not acknowledged', () => {
    const app = appWithChecks();
    const stack = new PipelineStack(app, 'UnacknowledgedPipelineStack', {
      connectionArn: 'arn:aws:codestar-connections:us-east-1:123456789012:connection/test-id',
      owner: 'test-owner',
      repo: 'test-repo',
      env,
    });
    // An unencrypted, unlogged bucket with no acknowledgment must be flagged
    new (require('aws-cdk-lib/aws-s3').Bucket)(stack, 'UnacknowledgedBucket');

    expect(() => app.synth()).toThrow();
  });
});

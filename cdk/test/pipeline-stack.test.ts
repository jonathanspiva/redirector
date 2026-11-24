import * as cdk from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { PipelineStack } from '../lib/pipeline-stack';

describe('PipelineStack', () => {
  let app: cdk.App;
  let stack: PipelineStack;
  let template: Template;

  beforeEach(() => {
    app = new cdk.App();
    stack = new PipelineStack(app, 'TestPipelineStack', {
      connectionArn: 'arn:aws:codestar-connections:us-east-1:123456789012:connection/test-connection',
      owner: 'test-owner',
      repo: 'test-repo',
      env: { account: '123456789012', region: 'us-east-1' },
    });
    template = Template.fromStack(stack);
  });

  describe('CodePipeline', () => {
    it('should create a pipeline', () => {
      template.resourceCountIs('AWS::CodePipeline::Pipeline', 1);
    });

    it('should have the correct pipeline name', () => {
      template.hasResourceProperties('AWS::CodePipeline::Pipeline', {
        Name: 'domain-redirector',
      });
    });

    it('should have Source and BuildAndDeploy stages', () => {
      template.hasResourceProperties('AWS::CodePipeline::Pipeline', {
        Stages: Match.arrayWith([
          Match.objectLike({ Name: 'Source' }),
          Match.objectLike({ Name: 'BuildAndDeploy' }),
        ]),
      });
    });

    it('should use CodeStar connection for source', () => {
      template.hasResourceProperties('AWS::CodePipeline::Pipeline', {
        Stages: Match.arrayWith([
          Match.objectLike({
            Name: 'Source',
            Actions: Match.arrayWith([
              Match.objectLike({
                ActionTypeId: {
                  Category: 'Source',
                  Provider: 'CodeStarSourceConnection',
                },
              }),
            ]),
          }),
        ]),
      });
    });

    it('should trigger on push', () => {
      template.hasResourceProperties('AWS::CodePipeline::Pipeline', {
        Stages: Match.arrayWith([
          Match.objectLike({
            Name: 'Source',
            Actions: Match.arrayWith([
              Match.objectLike({
                Configuration: Match.objectLike({
                  BranchName: 'main',
                  DetectChanges: true,
                }),
              }),
            ]),
          }),
        ]),
      });
    });
  });

  describe('CodeBuild Project', () => {
    it('should create a CodeBuild project', () => {
      template.resourceCountIs('AWS::CodeBuild::Project', 1);
    });

    it('should use buildspec.yml from source', () => {
      template.hasResourceProperties('AWS::CodeBuild::Project', {
        Source: {
          BuildSpec: 'buildspec.yml',
          Type: 'CODEPIPELINE',
        },
      });
    });

    it('should use ARM environment with medium compute', () => {
      template.hasResourceProperties('AWS::CodeBuild::Project', {
        Environment: {
          Image: Match.stringLikeRegexp('amazonlinux2-aarch64-standard'),
          Type: 'ARM_CONTAINER',
          ComputeType: 'BUILD_GENERAL1_MEDIUM',
        },
      });
    });

    it('should have a 12 minute timeout', () => {
      template.hasResourceProperties('AWS::CodeBuild::Project', {
        TimeoutInMinutes: 12,
      });
    });
  });

  describe('IAM Permissions', () => {
    const allActions = (): string[] =>
      Object.values(template.findResources('AWS::IAM::Policy')).flatMap((policy) =>
        (policy as { Properties: { PolicyDocument: { Statement: Array<{ Action: string | string[] }> } } })
          .Properties.PolicyDocument.Statement.flatMap((st) => (Array.isArray(st.Action) ? st.Action : [st.Action])),
      );

    it('should only allow assuming the CDK bootstrap deploy, publishing and lookup roles', () => {
      template.hasResourceProperties('AWS::IAM::Policy', {
        PolicyDocument: {
          Statement: Match.arrayWith([
            Match.objectLike({
              Sid: 'CdkBootstrapRoleAssumption',
              Action: 'sts:AssumeRole',
              Resource: [
                'arn:aws:iam::123456789012:role/cdk-*-deploy-role-123456789012-*',
                'arn:aws:iam::123456789012:role/cdk-*-file-publishing-role-123456789012-*',
                'arn:aws:iam::123456789012:role/cdk-*-lookup-role-123456789012-*',
              ],
            }),
          ]),
        },
      });
    });

    it('should grant the read-only calls preflight needs', () => {
      const actions = allActions();
      expect(actions).toEqual(expect.arrayContaining([
        'route53:ListHostedZones',
        'route53:ListResourceRecordSets',
        'cloudfront:ListDistributions',
      ]));
    });

    it('should not grant direct write access to deployed services', () => {
      const writes = allActions().filter((action) =>
        /^(cloudformation|acm):|^route53:ChangeResourceRecordSets$|^cloudfront:(Create|Update|Delete|Publish)|^ssm:/.test(action),
      );
      expect(writes).toEqual([]);
    });


    it('should scope CodeStar connection to specific ARN', () => {
      template.hasResourceProperties('AWS::IAM::Policy', {
        PolicyDocument: {
          Statement: Match.arrayWith([
            Match.objectLike({
              Action: 'codestar-connections:UseConnection',
              Effect: 'Allow',
              Resource: 'arn:aws:codestar-connections:us-east-1:123456789012:connection/test-connection',
            }),
          ]),
        },
      });
    });
  });

  describe('Security', () => {
    it('should create KMS key with rotation enabled', () => {
      template.hasResourceProperties('AWS::KMS::Key', {
        EnableKeyRotation: true,
      });
    });

    it('should create S3 bucket with public access blocked', () => {
      template.hasResourceProperties('AWS::S3::Bucket', {
        PublicAccessBlockConfiguration: {
          BlockPublicAcls: true,
          BlockPublicPolicy: true,
          IgnorePublicAcls: true,
          RestrictPublicBuckets: true,
        },
      });
    });

    it('should create S3 bucket with versioning enabled', () => {
      template.hasResourceProperties('AWS::S3::Bucket', {
        VersioningConfiguration: {
          Status: 'Enabled',
        },
      });
    });

    it('should create S3 bucket with KMS encryption', () => {
      template.hasResourceProperties('AWS::S3::Bucket', {
        BucketEncryption: {
          ServerSideEncryptionConfiguration: Match.arrayWith([
            Match.objectLike({
              ServerSideEncryptionByDefault: {
                SSEAlgorithm: 'aws:kms',
              },
            }),
          ]),
        },
      });
    });
  });

  describe('Tags', () => {
    it('should apply Service tag', () => {
      expect(stack.tags.tagValues()).toHaveProperty('Service', 'domain-redirector');
    });

    it('should apply ManagedBy tag', () => {
      expect(stack.tags.tagValues()).toHaveProperty('ManagedBy', 'cdk');
    });
  });

  describe('Custom branch configuration', () => {
    it('should use custom branch when specified', () => {
      const customApp = new cdk.App();
      const customStack = new PipelineStack(customApp, 'CustomBranchStack', {
        connectionArn: 'arn:aws:codestar-connections:us-east-1:123456789012:connection/test',
        owner: 'test-owner',
        repo: 'test-repo',
        branch: 'develop',
        env: { account: '123456789012', region: 'us-east-1' },
      });
      const customTemplate = Template.fromStack(customStack);

      customTemplate.hasResourceProperties('AWS::CodePipeline::Pipeline', {
        Stages: Match.arrayWith([
          Match.objectLike({
            Name: 'Source',
            Actions: Match.arrayWith([
              Match.objectLike({
                Configuration: Match.objectLike({
                  BranchName: 'develop',
                }),
              }),
            ]),
          }),
        ]),
      });
    });
  });
});

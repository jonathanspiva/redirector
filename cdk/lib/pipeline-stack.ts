import * as cdk from 'aws-cdk-lib';
import * as codepipeline from 'aws-cdk-lib/aws-codepipeline';
import * as codepipeline_actions from 'aws-cdk-lib/aws-codepipeline-actions';
import * as codebuild from 'aws-cdk-lib/aws-codebuild';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as kms from 'aws-cdk-lib/aws-kms';
import { NagSuppressions } from 'cdk-nag';
import { Construct } from 'constructs';

export interface PipelineStackProps extends cdk.StackProps {
  /** ARN of the CodeStar connection to GitHub */
  connectionArn: string;

  /** GitHub repository owner (username or organization) */
  owner: string;

  /** GitHub repository name */
  repo: string;

  /** Branch to deploy from (default: main) */
  branch?: string;
}

/**
 * CI/CD Pipeline for the domain redirector service.
 *
 * Deploys automatically when changes are pushed to the main branch:
 * 1. Source: Pull from GitHub via CodeStar connection
 * 2. Build: Validate config, deploy CDK stack, run smoke tests
 *
 * Security features:
 * - S3 artifact bucket with encryption, versioning, and public access blocked
 * - IAM policies scoped to specific resources where possible
 * - cdk-nag compliance with documented suppressions
 */
export class PipelineStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: PipelineStackProps) {
    super(scope, id, props);

    const branch = props.branch ?? 'main';

    // Apply default tags
    cdk.Tags.of(this).add('Service', 'domain-redirector');
    cdk.Tags.of(this).add('ManagedBy', 'cdk');
    cdk.Tags.of(this).add('Environment', 'prod');

    // Create KMS key for artifact encryption with auto-rotation
    const artifactKey = new kms.Key(this, 'ArtifactKey', {
      description: 'KMS key for pipeline artifact encryption',
      enableKeyRotation: true, // CIS/Well-Architected requirement
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    // Create secure artifact bucket (AWS Well-Architected & CIS compliant)
    const artifactBucket = new s3.Bucket(this, 'ArtifactBucket', {
      encryption: s3.BucketEncryption.KMS,
      encryptionKey: artifactKey,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      versioned: true,
      enforceSSL: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      // Lifecycle rules for cost optimization
      lifecycleRules: [{
        expiration: cdk.Duration.days(90),
        noncurrentVersionExpiration: cdk.Duration.days(30),
      }],
    });

    // Source artifact
    const sourceOutput = new codepipeline.Artifact('SourceOutput');

    // Source action - GitHub via CodeStar connection
    const sourceAction = new codepipeline_actions.CodeStarConnectionsSourceAction({
      actionName: 'GitHub',
      owner: props.owner,
      repo: props.repo,
      branch,
      connectionArn: props.connectionArn,
      output: sourceOutput,
      triggerOnPush: true,
    });

    // CodeBuild project for validation, deployment, and testing
    // Using ARM compute for better price/performance ratio
    const buildProject = new codebuild.PipelineProject(this, 'BuildProject', {
      projectName: 'domain-redirector-build',
      description: 'Validate, deploy, and test domain redirector',
      environment: {
        buildImage: codebuild.LinuxArmBuildImage.AMAZON_LINUX_2_STANDARD_3_0,
        computeType: codebuild.ComputeType.MEDIUM,
        privileged: false, // Explicitly disable privileged mode
      },
      buildSpec: codebuild.BuildSpec.fromSourceFilename('buildspec.yml'),
      timeout: cdk.Duration.minutes(12),
      encryptionKey: artifactKey, // Use same KMS key for build artifacts
    });

    // Grant CodeBuild permissions for CDK deployment
    this.grantCdkDeployPermissions(buildProject, props.connectionArn);

    // Build action
    const buildAction = new codepipeline_actions.CodeBuildAction({
      actionName: 'BuildAndDeploy',
      project: buildProject,
      input: sourceOutput,
      environmentVariables: {
        CDK_DEFAULT_ACCOUNT: {
          type: codebuild.BuildEnvironmentVariableType.PLAINTEXT,
          value: this.account,
        },
        CDK_DEFAULT_REGION: {
          type: codebuild.BuildEnvironmentVariableType.PLAINTEXT,
          value: 'us-east-1', // CloudFront requires us-east-1 for certificates
        },
      },
    });

    // Create the pipeline with secure artifact bucket
    const pipeline = new codepipeline.Pipeline(this, 'Pipeline', {
      pipelineName: 'domain-redirector',
      artifactBucket,
      restartExecutionOnUpdate: true,
      stages: [
        {
          stageName: 'Source',
          actions: [sourceAction],
        },
        {
          stageName: 'BuildAndDeploy',
          actions: [buildAction],
        },
      ],
    });

    // Add cdk-nag suppressions for CDK-generated resources that require wildcards
    this.addNagSuppressions(buildProject, pipeline, artifactBucket);

    // Output the pipeline ARN
    new cdk.CfnOutput(this, 'PipelineArn', {
      value: `arn:aws:codepipeline:${this.region}:${this.account}:domain-redirector`,
      description: 'CodePipeline ARN',
    });
  }

  /**
   * Grant the CodeBuild project permissions needed for CDK deployment.
   *
   * Permissions are scoped to specific resource patterns following
   * AWS Well-Architected and CIS benchmark least-privilege requirements.
   */
  private grantCdkDeployPermissions(
    project: codebuild.PipelineProject,
    connectionArn: string
  ): void {
    // Define all IAM permissions in a data-driven format
    const permissions: Array<{ sid: string; actions: string[]; resources: string[] }> = [
      {
        sid: 'CdkRoleAssumption',
        actions: ['sts:AssumeRole'],
        resources: [`arn:aws:iam::${this.account}:role/cdk-*`],
      },
      {
        sid: 'CloudFormationStackManagement',
        actions: [
          'cloudformation:DescribeStacks', 'cloudformation:GetTemplate',
          'cloudformation:CreateChangeSet', 'cloudformation:DescribeChangeSet',
          'cloudformation:ExecuteChangeSet', 'cloudformation:DeleteChangeSet',
          'cloudformation:DescribeStackEvents',
        ],
        resources: [
          `arn:aws:cloudformation:*:${this.account}:stack/RedirectStack/*`,
          `arn:aws:cloudformation:*:${this.account}:stack/CDKToolkit/*`,
        ],
      },
      {
        sid: 'CdkAssetsBucketAccess',
        actions: ['s3:GetObject', 's3:PutObject', 's3:ListBucket', 's3:GetBucketLocation'],
        resources: [
          `arn:aws:s3:::cdk-*-assets-${this.account}-*`,
          `arn:aws:s3:::cdk-*-assets-${this.account}-*/*`,
        ],
      },
      {
        sid: 'CdkBootstrapParameters',
        actions: ['ssm:GetParameter'],
        resources: [`arn:aws:ssm:*:${this.account}:parameter/cdk-bootstrap/*`],
      },
      {
        sid: 'Route53ListOperations',
        actions: ['route53:ListHostedZones', 'route53:ListHostedZonesByName', 'route53:GetHostedZone'],
        resources: ['*'], // Required by AWS API
      },
      {
        sid: 'Route53RecordManagement',
        actions: ['route53:ChangeResourceRecordSets', 'route53:ListResourceRecordSets'],
        resources: ['arn:aws:route53:::hostedzone/*'],
      },
      {
        sid: 'AcmCertificateManagement',
        actions: [
          'acm:RequestCertificate', 'acm:DescribeCertificate', 'acm:DeleteCertificate',
          'acm:ListCertificates', 'acm:AddTagsToCertificate', 'acm:ListTagsForCertificate',
        ],
        resources: [`arn:aws:acm:us-east-1:${this.account}:certificate/*`],
      },
      {
        sid: 'AcmListCertificates',
        actions: ['acm:ListCertificates'],
        resources: ['*'], // Required by AWS API
      },
      {
        sid: 'CloudFrontDistributionManagement',
        actions: [
          'cloudfront:CreateDistribution', 'cloudfront:UpdateDistribution',
          'cloudfront:DeleteDistribution', 'cloudfront:GetDistribution',
          'cloudfront:GetDistributionConfig', 'cloudfront:TagResource',
          'cloudfront:UntagResource', 'cloudfront:ListTagsForResource',
        ],
        resources: [`arn:aws:cloudfront::${this.account}:distribution/*`],
      },
      {
        sid: 'CloudFrontFunctionManagement',
        actions: [
          'cloudfront:CreateFunction', 'cloudfront:UpdateFunction',
          'cloudfront:DeleteFunction', 'cloudfront:DescribeFunction',
          'cloudfront:PublishFunction', 'cloudfront:GetFunction',
        ],
        resources: [`arn:aws:cloudfront::${this.account}:function/*`],
      },
      {
        sid: 'CloudFrontListOperations',
        actions: ['cloudfront:ListDistributions', 'cloudfront:ListFunctions'],
        resources: ['*'], // Required by AWS API
      },
      {
        sid: 'CodeStarConnectionAccess',
        actions: ['codestar-connections:UseConnection'],
        resources: [connectionArn],
      },
    ];

    // Apply all permissions
    for (const perm of permissions) {
      project.addToRolePolicy(new iam.PolicyStatement({
        sid: perm.sid,
        effect: iam.Effect.ALLOW,
        actions: perm.actions,
        resources: perm.resources,
      }));
    }
  }

  /**
   * Add cdk-nag suppressions for acceptable security findings.
   *
   * Each suppression includes documented justification following
   * AWS Well-Architected review practices.
   */
  private addNagSuppressions(
    buildProject: codebuild.PipelineProject,
    pipeline: codepipeline.Pipeline,
    artifactBucket: s3.Bucket
  ): void {
    // Suppress S3 access logging - artifact bucket is internal and encrypted
    NagSuppressions.addResourceSuppressions(
      artifactBucket,
      [{
        id: 'AwsSolutions-S1',
        reason: 'Artifact bucket is internal CI/CD infrastructure with encryption enabled. Access logging not required for build artifacts.',
      }],
    );

    // Suppress wildcard IAM permissions that are required by AWS APIs
    NagSuppressions.addResourceSuppressions(
      buildProject,
      [{
        id: 'AwsSolutions-IAM5',
        reason: 'CDK deployment requires wildcards for: (1) route53:List* requires wildcard per AWS API, (2) cdk-* role pattern for CDK bootstrap roles, (3) cloudformation stack paths with wildcard for stack versions, (4) cdk assets bucket pattern, (5) ssm parameters for CDK bootstrap',
        appliesTo: [
          'Resource::*',
          'Resource::arn:aws:iam::<AWS::AccountId>:role/cdk-*',
          'Resource::arn:aws:cloudformation:*:<AWS::AccountId>:stack/RedirectStack/*',
          'Resource::arn:aws:cloudformation:*:<AWS::AccountId>:stack/CDKToolkit/*',
          'Resource::arn:aws:s3:::cdk-*-assets-<AWS::AccountId>-*',
          'Resource::arn:aws:s3:::cdk-*-assets-<AWS::AccountId>-*/*',
          'Resource::arn:aws:ssm:*:<AWS::AccountId>:parameter/cdk-bootstrap/*',
          'Resource::arn:aws:route53:::hostedzone/*',
          'Resource::arn:aws:acm:us-east-1:<AWS::AccountId>:certificate/*',
          'Resource::arn:aws:cloudfront::<AWS::AccountId>:distribution/*',
          'Resource::arn:aws:cloudfront::<AWS::AccountId>:function/*',
        ],
      }],
      true, // Apply to children (role policies)
    );

    // Suppress CodeBuild wildcards for logs and reports (CDK auto-generated)
    NagSuppressions.addResourceSuppressions(
      buildProject,
      [{
        id: 'AwsSolutions-IAM5',
        reason: 'CodeBuild requires wildcard permissions for CloudWatch Logs and CodeBuild reports. These are auto-generated by CDK and scoped to the specific project.',
        appliesTo: [
          'Resource::arn:<AWS::Partition>:logs:<AWS::Region>:<AWS::AccountId>:log-group:/aws/codebuild/<BuildProjectName>:*',
          'Resource::arn:<AWS::Partition>:codebuild:<AWS::Region>:<AWS::AccountId>:report-group/<BuildProjectName>-*',
        ],
      }],
      true,
    );

    // Suppress pipeline role wildcards (CDK auto-generated for S3 operations)
    NagSuppressions.addResourceSuppressions(
      pipeline,
      [{
        id: 'AwsSolutions-IAM5',
        reason: 'Pipeline role requires S3 wildcards for artifact operations. Actions like s3:GetObject*, s3:List*, s3:DeleteObject* are standard CDK-generated permissions scoped to the artifact bucket.',
        appliesTo: [
          'Action::s3:GetObject*',
          'Action::s3:GetBucket*',
          'Action::s3:List*',
          'Action::s3:DeleteObject*',
          'Action::s3:Abort*',
          'Action::kms:ReEncrypt*',
          'Action::kms:GenerateDataKey*',
          'Resource::<ArtifactBucket.Arn>/*',
        ],
      }],
      true,
    );
  }
}

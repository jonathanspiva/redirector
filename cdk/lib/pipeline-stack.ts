import * as cdk from 'aws-cdk-lib';
import * as codepipeline from 'aws-cdk-lib/aws-codepipeline';
import * as codepipeline_actions from 'aws-cdk-lib/aws-codepipeline-actions';
import * as codebuild from 'aws-cdk-lib/aws-codebuild';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as kms from 'aws-cdk-lib/aws-kms';
import { Validations } from 'aws-cdk-lib';
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
      value: pipeline.pipelineArn,
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
    // Deployment itself runs through the CDK bootstrap roles (deploy, asset
    // publishing, lookup), so the build role only needs to assume them, plus
    // the read-only calls made by the preflight script.
    const permissions: Array<{ sid: string; actions: string[]; resources: string[] }> = [
      {
        sid: 'CdkBootstrapRoleAssumption',
        actions: ['sts:AssumeRole'],
        resources: [
          `arn:aws:iam::${this.account}:role/cdk-*-deploy-role-${this.account}-*`,
          `arn:aws:iam::${this.account}:role/cdk-*-file-publishing-role-${this.account}-*`,
          `arn:aws:iam::${this.account}:role/cdk-*-lookup-role-${this.account}-*`,
        ],
      },
      {
        sid: 'PreflightListOperations',
        actions: ['route53:ListHostedZones', 'cloudfront:ListDistributions'],
        resources: ['*'], // These List APIs don't support resource-level permissions
      },
      {
        sid: 'PreflightRecordReads',
        actions: ['route53:ListResourceRecordSets'],
        resources: ['arn:aws:route53:::hostedzone/*'],
      },
      {
        sid: 'SourceConnectionAccess',
        // The IAM prefix must match the connection ARN's service prefix;
        // older connections use codestar-connections, newer ones codeconnections.
        actions: ['codestar-connections:UseConnection', 'codeconnections:UseConnection'],
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
    // S3 access logging: artifact bucket is internal and encrypted
    Validations.of(artifactBucket).acknowledge({
      id: 'AwsSolutions-S1',
      reason: 'Artifact bucket is internal CI/CD infrastructure with encryption enabled. Access logging not required for build artifacts.',
    });

    // Wildcard IAM permissions. cdk-nag v3 finding IDs embed the resolved account and
    // hashed logical IDs, so these are acknowledged per role rather than per finding.
    Validations.of(buildProject).acknowledge({
      id: 'AwsSolutions-IAM5',
      reason: 'Build role wildcards: CDK bootstrap role names include a qualifier and region; route53:ListHostedZones and '
        + 'cloudfront:ListDistributions need Resource::*; preflight reads records in any hosted zone; plus the CDK-generated '
        + 'CloudWatch Logs, CodeBuild report group and KMS (ReEncrypt*, GenerateDataKey*) grants scoped to this project.',
    });

    Validations.of(pipeline).acknowledge({
      id: 'AwsSolutions-IAM5',
      reason: 'Pipeline role wildcards (s3:GetObject*, s3:GetBucket*, s3:List*, s3:DeleteObject*, s3:Abort*, kms:ReEncrypt*, '
        + 'kms:GenerateDataKey*) are CDK-generated and scoped to the artifact bucket and its KMS key.',
    });
  }
}

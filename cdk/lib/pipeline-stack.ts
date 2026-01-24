import * as cdk from 'aws-cdk-lib';
import * as codepipeline from 'aws-cdk-lib/aws-codepipeline';
import * as codepipeline_actions from 'aws-cdk-lib/aws-codepipeline-actions';
import * as codebuild from 'aws-cdk-lib/aws-codebuild';
import * as iam from 'aws-cdk-lib/aws-iam';
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
 */
export class PipelineStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: PipelineStackProps) {
    super(scope, id, props);

    const branch = props.branch ?? 'main';

    // Apply default tags
    cdk.Tags.of(this).add('Project', 'domain-redirector');
    cdk.Tags.of(this).add('ManagedBy', 'cdk');

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
    const buildProject = new codebuild.PipelineProject(this, 'BuildProject', {
      projectName: 'domain-redirector-build',
      description: 'Validate, deploy, and test domain redirector',
      environment: {
        buildImage: codebuild.LinuxBuildImage.STANDARD_7_0,
        computeType: codebuild.ComputeType.SMALL,
      },
      buildSpec: codebuild.BuildSpec.fromSourceFilename('buildspec.yml'),
      timeout: cdk.Duration.minutes(30),
    });

    // Grant CodeBuild permissions for CDK deployment
    this.grantCdkDeployPermissions(buildProject);

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

    // Create the pipeline
    new codepipeline.Pipeline(this, 'Pipeline', {
      pipelineName: 'domain-redirector',
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

    // Output the pipeline ARN
    new cdk.CfnOutput(this, 'PipelineArn', {
      value: `arn:aws:codepipeline:${this.region}:${this.account}:domain-redirector`,
      description: 'CodePipeline ARN',
    });
  }

  /**
   * Grant the CodeBuild project permissions needed for CDK deployment.
   *
   * CDK needs broad permissions to create/update/delete resources.
   * In production, you may want to scope this down further.
   */
  private grantCdkDeployPermissions(project: codebuild.PipelineProject): void {
    // CDK needs to assume the CDK roles
    project.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['sts:AssumeRole'],
      resources: [
        `arn:aws:iam::${this.account}:role/cdk-*`,
      ],
    }));

    // CloudFormation permissions
    project.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        'cloudformation:DescribeStacks',
        'cloudformation:GetTemplate',
        'cloudformation:CreateChangeSet',
        'cloudformation:DescribeChangeSet',
        'cloudformation:ExecuteChangeSet',
        'cloudformation:DeleteChangeSet',
        'cloudformation:DescribeStackEvents',
      ],
      resources: [
        `arn:aws:cloudformation:*:${this.account}:stack/RedirectStack/*`,
        `arn:aws:cloudformation:*:${this.account}:stack/CDKToolkit/*`,
      ],
    }));

    // S3 permissions for CDK assets
    project.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        's3:GetObject',
        's3:PutObject',
        's3:ListBucket',
        's3:GetBucketLocation',
      ],
      resources: [
        `arn:aws:s3:::cdk-*-assets-${this.account}-*`,
        `arn:aws:s3:::cdk-*-assets-${this.account}-*/*`,
      ],
    }));

    // SSM permissions for CDK context lookups
    project.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        'ssm:GetParameter',
      ],
      resources: [
        `arn:aws:ssm:*:${this.account}:parameter/cdk-bootstrap/*`,
      ],
    }));

    // Route 53 permissions for hosted zone lookups and record management
    project.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        'route53:ListHostedZones',
        'route53:ListHostedZonesByName',
        'route53:GetHostedZone',
        'route53:ChangeResourceRecordSets',
        'route53:ListResourceRecordSets',
      ],
      resources: ['*'],
    }));

    // ACM permissions for certificate management
    project.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        'acm:RequestCertificate',
        'acm:DescribeCertificate',
        'acm:DeleteCertificate',
        'acm:ListCertificates',
        'acm:AddTagsToCertificate',
      ],
      resources: ['*'],
    }));

    // CloudFront permissions
    project.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        'cloudfront:CreateDistribution',
        'cloudfront:UpdateDistribution',
        'cloudfront:DeleteDistribution',
        'cloudfront:GetDistribution',
        'cloudfront:TagResource',
        'cloudfront:CreateFunction',
        'cloudfront:UpdateFunction',
        'cloudfront:DeleteFunction',
        'cloudfront:DescribeFunction',
        'cloudfront:PublishFunction',
        'cloudfront:GetFunction',
        'cloudfront:ListFunctions',
      ],
      resources: ['*'],
    }));
  }
}

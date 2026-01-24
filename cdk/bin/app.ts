#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { RedirectStack } from '../lib/redirect-stack';
import { PipelineStack } from '../lib/pipeline-stack';

const app = new cdk.App();

// Environment configuration
const env = {
  account: process.env.CDK_DEFAULT_ACCOUNT,
  region: 'us-east-1', // CloudFront requires certificates in us-east-1
};

// RedirectStack - the actual redirect infrastructure
new RedirectStack(app, 'RedirectStack', {
  env,
  crossRegionReferences: true,
  description: 'Domain redirector service - manages HTTP redirects for multiple domains',
});

// PipelineStack - CI/CD pipeline (optional, requires GitHub connection)
// Only create if GITHUB_CONNECTION_ARN is provided
const connectionArn = process.env.GITHUB_CONNECTION_ARN;
const githubOwner = process.env.GITHUB_OWNER;
const githubRepo = process.env.GITHUB_REPO;

if (connectionArn && githubOwner && githubRepo) {
  new PipelineStack(app, 'PipelineStack', {
    env,
    connectionArn,
    owner: githubOwner,
    repo: githubRepo,
    branch: process.env.GITHUB_BRANCH ?? 'main',
    description: 'CI/CD pipeline for domain redirector service',
  });
}

app.synth();

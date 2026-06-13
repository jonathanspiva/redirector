#!/usr/bin/env node
import 'source-map-support/register';
import * as fs from 'fs';
import * as path from 'path';
import * as cdk from 'aws-cdk-lib';
import { Aspects } from 'aws-cdk-lib';
import { AwsSolutionsChecks } from 'cdk-nag';
import { RedirectStack } from '../lib/redirect-stack';
import { PipelineStack } from '../lib/pipeline-stack';

/**
 * Load KEY=VALUE pairs from cdk/.env (if present) without overriding variables
 * already set in the environment. Keeps forking friction low: copy
 * .env.example to .env, fill it in, and run `cdk deploy` - no need to export
 * each variable by hand. Anything set in the real environment still wins.
 */
function loadDotEnv(): void {
  const envPath = path.join(__dirname, '..', '.env');
  if (!fs.existsSync(envPath)) {
    return;
  }
  for (const line of fs.readFileSync(envPath, 'utf-8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) {
      continue;
    }
    const eq = trimmed.indexOf('=');
    if (eq === -1) {
      continue;
    }
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (key && process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

loadDotEnv();

const app = new cdk.App();

// Account is required: HostedZone.fromLookup and CloudFront need a concrete
// account/region. Fail early with an actionable message instead of a cryptic
// "environment-agnostic stack" error deep in synthesis.
const account = process.env.CDK_DEFAULT_ACCOUNT;
if (!account) {
  throw new Error(
    'CDK_DEFAULT_ACCOUNT is not set. Set it in cdk/.env (see cdk/.env.example) ' +
    'or export it before running cdk. Region is always us-east-1 (CloudFront requirement).'
  );
}

// Environment configuration
const env = {
  account,
  region: 'us-east-1', // CloudFront requires certificates in us-east-1
};

// RedirectStack - the actual redirect infrastructure
new RedirectStack(app, 'RedirectStack', {
  env,
  crossRegionReferences: true,
  description: 'Domain redirector service - manages HTTP redirects for multiple domains',
});

// PipelineStack - CI/CD pipeline (optional). Created only when all three
// GitHub variables are set; otherwise deploy redirects manually with
// `cdk deploy RedirectStack`. See cdk/.env.example for how to get the
// connection ARN.
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

// Apply cdk-nag security checks (AWS Solutions rule pack)
Aspects.of(app).add(new AwsSolutionsChecks({ verbose: true }));

app.synth();

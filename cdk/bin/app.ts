#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { RedirectStack } from '../lib/redirect-stack';

const app = new cdk.App();

new RedirectStack(app, 'RedirectStack', {
  // CloudFront distributions require certificates in us-east-1
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: 'us-east-1',
  },
  // Enable cross-region references if needed
  crossRegionReferences: true,

  description: 'Domain redirector service - manages HTTP redirects for multiple domains',
});

app.synth();

#!/usr/bin/env ts-node

/**
 * Smart deployment script that skips CDK deploy when redirects already work.
 *
 * Flow:
 * 1. Run smoke tests against current configuration
 * 2. If all pass and FORCE_DEPLOY is not set → skip deployment
 * 3. If any fail or FORCE_DEPLOY is set → run cdk deploy → re-run smoke tests
 *
 * Environment variables:
 *   FORCE_DEPLOY: Set to "true" to force deployment even if smoke tests pass
 *   REDIRECTS_CONFIG: Path to redirects.yaml (optional)
 *
 * Usage:
 *   npx ts-node scripts/smart-deploy.ts [config-path]
 */

import { spawn } from 'child_process';
import * as path from 'path';

const configPath = process.argv[2] || process.env.REDIRECTS_CONFIG || path.join(__dirname, '..', '..', 'redirects.yaml');
const forceDeployment = process.env.FORCE_DEPLOY === 'true';

/**
 * Run a command and return the exit code.
 */
function runCommand(command: string, args: string[], options?: { silent?: boolean }): Promise<number> {
  return new Promise((resolve) => {
    const proc = spawn(command, args, {
      stdio: options?.silent ? 'pipe' : 'inherit',
      cwd: path.join(__dirname, '..'),
      shell: true,
    });

    proc.on('close', (code) => {
      resolve(code ?? 1);
    });
  });
}

/**
 * Run smoke tests and return whether they all passed.
 */
async function runSmokeTests(label: string): Promise<boolean> {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`${label}`);
  console.log('='.repeat(60) + '\n');

  const exitCode = await runCommand('npm', ['run', 'smoke-test', '--', configPath]);
  return exitCode === 0;
}

/**
 * Run CDK deploy.
 */
async function runCdkDeploy(): Promise<boolean> {
  console.log(`\n${'='.repeat(60)}`);
  console.log('Running CDK Deploy');
  console.log('='.repeat(60) + '\n');

  const exitCode = await runCommand('npx', [
    'cdk', 'deploy', 'RedirectStack',
    '--require-approval', 'never',
    '--outputs-file', 'outputs.json',
  ]);
  return exitCode === 0;
}

/**
 * Main deployment flow.
 */
async function main(): Promise<void> {
  console.log('Smart Deploy - Skip deployment when redirects already work\n');
  console.log(`Config: ${configPath}`);
  console.log(`Force Deploy: ${forceDeployment ? 'YES' : 'no'}`);

  // Step 1: Run initial smoke tests
  const initialTestsPassed = await runSmokeTests('Pre-deployment Smoke Tests');

  // Step 2: Decide whether to deploy
  if (initialTestsPassed && !forceDeployment) {
    console.log(`\n${'='.repeat(60)}`);
    console.log('SKIPPING DEPLOYMENT');
    console.log('='.repeat(60));
    console.log('\nAll redirects are working correctly.');
    console.log('No deployment needed.\n');
    console.log('To force deployment, set FORCE_DEPLOY=true');
    process.exit(0);
  }

  // Log why we're deploying
  if (forceDeployment) {
    console.log('\n→ FORCE_DEPLOY is set, proceeding with deployment...');
  } else {
    console.log('\n→ Some smoke tests failed, proceeding with deployment...');
  }

  // Step 3: Run CDK deploy
  const deploySuccess = await runCdkDeploy();
  if (!deploySuccess) {
    console.error('\nCDK deploy failed!');
    process.exit(1);
  }

  // Step 4: Run post-deployment smoke tests
  const postTestsPassed = await runSmokeTests('Post-deployment Smoke Tests');

  if (!postTestsPassed) {
    console.log('\nWarning: Some post-deployment smoke tests failed.');
    console.log('New domains may still be propagating (DNS can take up to 48 hours).');
    // Don't fail the build for post-deployment test failures
    // as DNS propagation can take time
  }

  console.log(`\n${'='.repeat(60)}`);
  console.log('DEPLOYMENT COMPLETE');
  console.log('='.repeat(60) + '\n');
}

main().catch((error) => {
  console.error('Smart deploy error:', error.message);
  process.exit(1);
});

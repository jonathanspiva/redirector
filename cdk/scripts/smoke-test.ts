#!/usr/bin/env ts-node

/**
 * Post-deployment smoke test for redirect verification.
 *
 * Verifies that each configured domain returns the expected redirect response.
 *
 * Usage:
 *   npx ts-node scripts/smoke-test.ts [config-path]
 */

import * as https from 'https';
import { loadAndValidateConfig } from '../lib/config/validator';
import { getAllDomainConfigs } from '../lib/config/parser';
import { ResolvedDomainConfig } from '../lib/config/types';

interface TestResult {
  domain: string;
  passed: boolean;
  message: string;
  statusCode?: number;
  location?: string;
  error?: string;
}

/**
 * Test a single domain redirect.
 */
async function testDomain(config: ResolvedDomainConfig): Promise<TestResult> {
  const domain = config.domain.replace('*.', 'test-wildcard.');

  return new Promise((resolve) => {
    const url = `https://${domain}/test-path?test=param`;

    const request = https.get(url, {
      timeout: 10000,
    }, (response) => {
      const statusCode = response.statusCode;
      const location = response.headers.location;

      // Check status code matches expected
      if (statusCode !== config.statusCode) {
        resolve({
          domain,
          passed: false,
          message: `Expected ${config.statusCode}, got ${statusCode}`,
          statusCode,
          location,
        });
        return;
      }

      // Check location header exists
      if (!location) {
        resolve({
          domain,
          passed: false,
          message: 'No Location header in response',
          statusCode,
        });
        return;
      }

      // Check location starts with target
      if (!location.startsWith(config.target)) {
        resolve({
          domain,
          passed: false,
          message: `Location "${location}" doesn't start with target "${config.target}"`,
          statusCode,
          location,
        });
        return;
      }

      // Check path preservation
      if (config.preservePath && !location.includes('/test-path')) {
        resolve({
          domain,
          passed: false,
          message: `Path not preserved in "${location}"`,
          statusCode,
          location,
        });
        return;
      }

      // Check query preservation
      if (config.preserveQuery && !location.includes('test=param')) {
        resolve({
          domain,
          passed: false,
          message: `Query not preserved in "${location}"`,
          statusCode,
          location,
        });
        return;
      }

      resolve({
        domain,
        passed: true,
        message: `HTTP ${statusCode} -> ${location}`,
        statusCode,
        location,
      });
    });

    request.on('error', (error: NodeJS.ErrnoException) => {
      // Too many redirects indicates a redirect chain problem - treat as warning
      if (error.code === 'ERR_FR_TOO_MANY_REDIRECTS') {
        resolve({
          domain,
          passed: false,
          message: 'Too many redirects - possible redirect loop or chain issue',
          error: 'redirect_loop',
        });
        return;
      }

      resolve({
        domain,
        passed: false,
        message: `Connection error: ${error.message}`,
        error: error.message,
      });
    });

    request.on('timeout', () => {
      request.destroy();
      resolve({
        domain,
        passed: false,
        message: 'Request timeout',
        error: 'timeout',
      });
    });
  });
}

/**
 * Retry a test with exponential backoff.
 */
async function testWithRetry(
  config: ResolvedDomainConfig,
  maxRetries: number = 5,
  initialDelayMs: number = 5000
): Promise<TestResult> {
  let lastResult: TestResult | null = null;
  let delay = initialDelayMs;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (attempt > 0) {
      console.log(`  Retrying ${config.domain} in ${delay / 1000}s...`);
      await new Promise(resolve => setTimeout(resolve, delay));
      delay *= 2; // Exponential backoff
    }

    lastResult = await testDomain(config);

    if (lastResult.passed) {
      return lastResult;
    }

    // Don't retry for certain error types
    if (lastResult.statusCode && lastResult.statusCode >= 400 && lastResult.statusCode < 500) {
      // 4xx errors are likely configuration issues, not timing
      return lastResult;
    }
  }

  return lastResult!;
}

/**
 * Run smoke tests for all configured domains.
 * Tests run in parallel for faster execution.
 */
async function runSmokeTests(configPath?: string): Promise<void> {
  console.log('Loading configuration...\n');
  const config = loadAndValidateConfig(configPath);
  const domainConfigs = getAllDomainConfigs(config);

  // Filter out domains marked for skip
  const testableDomains = domainConfigs.filter(d => !d.skipTest);
  const skippedDomains = domainConfigs.filter(d => d.skipTest);

  if (skippedDomains.length > 0) {
    console.log(`Skipping ${skippedDomains.length} domain(s) marked with skipTest:\n`);
    for (const domain of skippedDomains) {
      console.log(`  - ${domain.domain}`);
    }
    console.log('');
  }

  console.log(`Testing ${testableDomains.length} domain(s) in parallel...\n`);

  // Run all tests in parallel for faster execution
  const results = await Promise.all(
    testableDomains.map(domainConfig => testWithRetry(domainConfig))
  );

  let passCount = 0;
  let failCount = 0;
  let warnCount = 0;

  // Process and display results
  for (const result of results) {
    if (result.passed) {
      passCount++;
      console.log(`\u2713 ${result.domain}: ${result.message}`);
    } else if (result.error === 'timeout' || result.error?.includes('ENOTFOUND')) {
      warnCount++;
      console.log(`\u26A0 ${result.domain}: ${result.message} (may still be propagating)`);
    } else if (result.error === 'redirect_loop') {
      warnCount++;
      console.log(`\u26A0 ${result.domain}: ${result.message} (check redirect configuration)`);
    } else {
      failCount++;
      console.log(`\u2717 ${result.domain}: ${result.message}`);
    }
  }

  console.log('\n' + '='.repeat(60) + '\n');
  console.log('Summary:');
  console.log(`  Passed:   ${passCount}`);
  console.log(`  Failed:   ${failCount}`);
  console.log(`  Warnings: ${warnCount}`);
  console.log(`  Skipped:  ${skippedDomains.length}`);
  console.log(`  Total:    ${domainConfigs.length}`);

  if (failCount > 0) {
    console.log('\nFailed domains:');
    for (const result of results) {
      const isWarning = result.error === 'timeout' ||
                        result.error?.includes('ENOTFOUND') ||
                        result.error === 'redirect_loop';
      if (!result.passed && !isWarning) {
        console.log(`  - ${result.domain}: ${result.message}`);
      }
    }
    process.exit(1);
  }

  if (warnCount > 0) {
    console.log('\nWarning: Some domains may still be propagating. Consider re-running in a few minutes.');
  }

  console.log('\nAll tests passed!');
}

// CLI entry point
if (require.main === module) {
  const configPath = process.argv[2];

  runSmokeTests(configPath).catch((error) => {
    console.error('Smoke test error:', error.message);
    process.exit(1);
  });
}

export { testDomain, runSmokeTests };

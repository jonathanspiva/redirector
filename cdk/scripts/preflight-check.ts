#!/usr/bin/env ts-node

/**
 * Pre-flight checks before CDK deployment.
 *
 * Validates that deployment will succeed by checking:
 * - Route 53 hosted zones exist for all domains
 * - No conflicting DNS records already exist
 *
 * Usage:
 *   npx ts-node scripts/preflight-check.ts [config-path]
 *
 * Environment variables:
 *   PREFLIGHT_MODE: "warn" (default) or "fail"
 *     - warn: Report conflicts but exit 0
 *     - fail: Exit 1 if any conflicts found
 */

import {
  Route53Client,
  ListHostedZonesCommand,
  ListResourceRecordSetsCommand,
  HostedZone,
} from '@aws-sdk/client-route-53';
import { loadAndValidateConfig } from '../lib/config/validator';
import { getAllDomainConfigs } from '../lib/config/parser';

interface PreflightResult {
  domain: string;
  status: 'ok' | 'warning' | 'error';
  message: string;
  details?: string;
}

const route53 = new Route53Client({ region: 'us-east-1' });

/**
 * Cache of hosted zones to avoid repeated API calls.
 */
let hostedZonesCache: HostedZone[] | null = null;

/**
 * Get all hosted zones in the account.
 */
async function getHostedZones(): Promise<HostedZone[]> {
  if (hostedZonesCache) {
    return hostedZonesCache;
  }

  const zones: HostedZone[] = [];
  let marker: string | undefined;

  do {
    const response = await route53.send(
      new ListHostedZonesCommand({ Marker: marker })
    );
    if (response.HostedZones) {
      zones.push(...response.HostedZones);
    }
    marker = response.NextMarker;
  } while (marker);

  hostedZonesCache = zones;
  return zones;
}

/**
 * Find the hosted zone for a domain.
 * Walks up the domain hierarchy to find a matching zone.
 */
async function findHostedZone(domain: string): Promise<HostedZone | null> {
  const zones = await getHostedZones();

  // Remove wildcard prefix if present
  const baseDomain = domain.startsWith('*.') ? domain.substring(2) : domain;
  const parts = baseDomain.split('.');

  // Try each level of the domain hierarchy
  for (let i = 0; i < parts.length - 1; i++) {
    const zoneName = parts.slice(i).join('.') + '.';

    const zone = zones.find(
      (z) => z.Name === zoneName && !z.Config?.PrivateZone
    );
    if (zone) {
      return zone;
    }
  }

  return null;
}

/**
 * Check if A or AAAA records already exist for a domain.
 */
async function checkExistingRecords(
  domain: string,
  hostedZoneId: string
): Promise<{ hasA: boolean; hasAAAA: boolean; isAlias: boolean }> {
  const recordName = domain.endsWith('.') ? domain : domain + '.';

  const response = await route53.send(
    new ListResourceRecordSetsCommand({
      HostedZoneId: hostedZoneId,
      StartRecordName: recordName,
      StartRecordType: 'A',
      MaxItems: 10,
    })
  );

  let hasA = false;
  let hasAAAA = false;
  let isAlias = false;

  for (const record of response.ResourceRecordSets || []) {
    // Only check exact matches
    if (record.Name !== recordName) continue;

    if (record.Type === 'A') {
      hasA = true;
      isAlias = !!record.AliasTarget;
    }
    if (record.Type === 'AAAA') {
      hasAAAA = true;
      isAlias = isAlias || !!record.AliasTarget;
    }
  }

  return { hasA, hasAAAA, isAlias };
}

/**
 * Run pre-flight check for a single domain.
 */
async function checkDomain(domain: string): Promise<PreflightResult> {
  try {
    // Check for hosted zone
    const zone = await findHostedZone(domain);
    if (!zone || !zone.Id) {
      return {
        domain,
        status: 'error',
        message: 'No hosted zone found',
        details: `Create a Route 53 hosted zone for ${domain} or a parent domain`,
      };
    }

    // Check for existing records
    const zoneId = zone.Id.replace('/hostedzone/', '');
    const { hasA, hasAAAA, isAlias } = await checkExistingRecords(domain, zoneId);

    if (hasA || hasAAAA) {
      const recordTypes = [hasA && 'A', hasAAAA && 'AAAA'].filter(Boolean).join(', ');

      if (isAlias) {
        // Alias records might be from a previous deployment - this is usually OK
        return {
          domain,
          status: 'warning',
          message: `Existing alias ${recordTypes} record(s) found`,
          details: 'May be from previous deployment - will be updated',
        };
      }

      return {
        domain,
        status: 'error',
        message: `Existing ${recordTypes} record(s) will cause conflict`,
        details: `Delete existing records or remove domain from config`,
      };
    }

    return {
      domain,
      status: 'ok',
      message: `Ready to deploy (zone: ${zone.Name?.replace(/\.$/, '')})`,
    };
  } catch (error) {
    return {
      domain,
      status: 'error',
      message: `Check failed: ${(error as Error).message}`,
    };
  }
}

/**
 * Run all pre-flight checks.
 */
async function runPreflightChecks(configPath?: string): Promise<void> {
  const mode = process.env.PREFLIGHT_MODE || 'warn';

  console.log('Running pre-flight checks...\n');

  // Load config
  const config = loadAndValidateConfig(configPath);
  const domainConfigs = getAllDomainConfigs(config);

  console.log(`Checking ${domainConfigs.length} domain(s)...\n`);

  // Run checks in parallel
  const results = await Promise.all(
    domainConfigs.map((dc) => checkDomain(dc.domain))
  );

  // Display results
  let okCount = 0;
  let warnCount = 0;
  let errorCount = 0;

  for (const result of results) {
    const icon =
      result.status === 'ok' ? '\u2713' :
      result.status === 'warning' ? '\u26A0' : '\u2717';

    console.log(`${icon} ${result.domain}: ${result.message}`);
    if (result.details) {
      console.log(`    ${result.details}`);
    }

    if (result.status === 'ok') okCount++;
    if (result.status === 'warning') warnCount++;
    if (result.status === 'error') errorCount++;
  }

  // Summary
  console.log('\n' + '='.repeat(60) + '\n');
  console.log('Pre-flight Summary:');
  console.log(`  Ready:    ${okCount}`);
  console.log(`  Warnings: ${warnCount}`);
  console.log(`  Errors:   ${errorCount}`);

  if (errorCount > 0) {
    console.log('\nDomains with errors will cause deployment to fail.');
    console.log('Fix the issues above or remove problematic domains from config.');

    if (mode === 'fail') {
      console.log('\nPre-flight check failed (PREFLIGHT_MODE=fail)');
      process.exit(1);
    } else {
      console.log('\nContinuing despite errors (PREFLIGHT_MODE=warn)');
      console.log('Set PREFLIGHT_MODE=fail to block deployment on errors.');
    }
  } else if (warnCount > 0) {
    console.log('\nWarnings found but deployment should succeed.');
  } else {
    console.log('\nAll checks passed!');
  }
}

// CLI entry point
if (require.main === module) {
  const configPath = process.argv[2];

  runPreflightChecks(configPath).catch((error) => {
    console.error('Pre-flight check error:', error.message);
    process.exit(1);
  });
}

export { checkDomain, runPreflightChecks };

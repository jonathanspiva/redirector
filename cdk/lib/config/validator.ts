import { RedirectConfig, RedirectGroup, ValidationError, ValidationResult } from './types';
import { loadConfig } from './parser';
import { domainLogicalId, stripWildcard } from '../utils/domain';
import { sanitizeFunctionName } from '../constructs/redirect-function';

/**
 * Validate that an optional field is a boolean if present.
 */
function validateOptionalBoolean(
  value: unknown,
  field: string,
  basePath: string
): ValidationError | null {
  if (value !== undefined && typeof value !== 'boolean') {
    return { path: `${basePath}.${field}`, message: `${field} must be a boolean` };
  }
  return null;
}

/**
 * Validate a domain name format.
 * Supports regular domains and wildcards (*.example.com).
 */
function isValidDomain(domain: string): boolean {
  // Wildcard domain pattern: *.example.com
  const wildcardPattern = /^\*\.[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i;

  // Regular domain pattern: example.com or sub.example.com
  const domainPattern = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i;

  return wildcardPattern.test(domain) || domainPattern.test(domain);
}

/**
 * Validate a target URL.
 * Must be HTTPS, valid format, no trailing slash.
 */
function isValidTargetUrl(url: string): { valid: boolean; reason?: string } {
  try {
    const parsed = new URL(url);

    if (parsed.protocol !== 'https:') {
      return { valid: false, reason: 'must be HTTPS' };
    }

    if (url.endsWith('/') && parsed.pathname === '/') {
      return { valid: false, reason: 'should not have trailing slash' };
    }

    // The request path and query are appended to the target, so it can't
    // carry its own query string or fragment.
    if (parsed.search || parsed.hash || url.includes('?') || url.includes('#')) {
      return { valid: false, reason: 'must not include a query string or fragment' };
    }

    return { valid: true };
  } catch {
    return { valid: false, reason: 'invalid URL format' };
  }
}

/**
 * Validate the structure of a redirect group.
 */
function validateRedirectGroup(
  group: RedirectGroup,
  index: number,
  seenDomains: Map<string, string>
): ValidationError[] {
  const errors: ValidationError[] = [];
  const basePath = `redirects[${index}]`;

  // Validate target
  if (!group.target) {
    errors.push({ path: `${basePath}.target`, message: 'target is required' });
  } else {
    const targetValidation = isValidTargetUrl(group.target);
    if (!targetValidation.valid) {
      errors.push({
        path: `${basePath}.target`,
        message: `${targetValidation.reason}, got "${group.target}"`,
      });
    }
  }

  // Validate type
  if (!group.type) {
    errors.push({ path: `${basePath}.type`, message: 'type is required' });
  } else if (group.type !== 'permanent' && group.type !== 'temporary') {
    errors.push({
      path: `${basePath}.type`,
      message: `must be "permanent" or "temporary", got "${group.type}"`,
    });
  }

  // Validate domains
  if (!group.domains) {
    errors.push({ path: `${basePath}.domains`, message: 'domains is required' });
  } else if (!Array.isArray(group.domains)) {
    errors.push({ path: `${basePath}.domains`, message: 'domains must be an array' });
  } else if (group.domains.length === 0) {
    errors.push({ path: `${basePath}.domains`, message: 'domains must not be empty' });
  } else {
    group.domains.forEach((domain, domainIndex) => {
      const domainPath = `${basePath}.domains[${domainIndex}]`;

      if (typeof domain !== 'string') {
        errors.push({ path: domainPath, message: 'domain must be a string' });
        return;
      }

      if (!isValidDomain(domain)) {
        errors.push({
          path: domainPath,
          message: `invalid domain format "${domain}"`,
        });
        return;
      }

      // Check for duplicates (DNS names are case-insensitive)
      const key = domain.toLowerCase();
      const existingPath = seenDomains.get(key);
      if (existingPath) {
        errors.push({
          path: domainPath,
          message: `duplicate domain "${domain}" (also in ${existingPath})`,
        });
      } else {
        seenDomains.set(key, basePath);
      }
    });
  }

  // Validate hostedZone: every domain must be the zone itself or inside it
  if (group.hostedZone !== undefined) {
    const zonePath = `${basePath}.hostedZone`;
    if (typeof group.hostedZone !== 'string' || group.hostedZone.startsWith('*.') || !isValidDomain(group.hostedZone)) {
      errors.push({ path: zonePath, message: `invalid hosted zone "${String(group.hostedZone)}"` });
    } else if (Array.isArray(group.domains)) {
      const zone = group.hostedZone.toLowerCase();
      for (const domain of group.domains) {
        if (typeof domain !== 'string') continue;
        const base = stripWildcard(domain).toLowerCase();
        if (base !== zone && !base.endsWith(`.${zone}`)) {
          errors.push({ path: zonePath, message: `"${domain}" is not in hosted zone "${group.hostedZone}"` });
        }
      }
    }
  }

  // Validate optional boolean fields
  const booleanFields: Array<{ field: string; value: unknown }> = [
    { field: 'preservePath', value: group.preservePath },
    { field: 'preserveQuery', value: group.preserveQuery },
    { field: 'active', value: group.active },
  ];
  for (const { field, value } of booleanFields) {
    const error = validateOptionalBoolean(value, field, basePath);
    if (error) errors.push(error);
  }

  // Validate skipTest
  if (group.skipTest !== undefined) {
    if (!Array.isArray(group.skipTest)) {
      errors.push({
        path: `${basePath}.skipTest`,
        message: 'skipTest must be an array',
      });
    } else {
      group.skipTest.forEach((domain, skipIndex) => {
        if (typeof domain !== 'string') {
          errors.push({
            path: `${basePath}.skipTest[${skipIndex}]`,
            message: 'skipTest entry must be a string',
          });
        } else if (group.domains && !group.domains.includes(domain)) {
          errors.push({
            path: `${basePath}.skipTest[${skipIndex}]`,
            message: `"${domain}" is not in the domains list`,
          });
        }
      });
    }
  }

  return errors;
}

/**
 * Ensure every active group pointing at the same target resolves to identical
 * redirect behavior (status code, path/query preservation). These groups share
 * one CloudFront Function, so divergent settings cannot both be honored.
 */
function validateTargetConsistency(config: RedirectConfig): ValidationError[] {
  const errors: ValidationError[] = [];
  const preservePathDefault = config.settings?.preservePath ?? true;
  const preserveQueryDefault = config.settings?.preserveQuery ?? true;
  const seenTargets = new Map<string, { index: number; signature: string }>();

  config.redirects.forEach((group, index) => {
    if (group.active === false) return;
    if (typeof group.target !== 'string' || group.target === '') return;

    const statusCode = group.type === 'permanent' ? 301 : 302;
    const preservePath = group.preservePath ?? preservePathDefault;
    const preserveQuery = group.preserveQuery ?? preserveQueryDefault;
    const signature = `${statusCode}|${preservePath}|${preserveQuery}`;

    const existing = seenTargets.get(group.target);
    if (!existing) {
      seenTargets.set(group.target, { index, signature });
    } else if (existing.signature !== signature) {
      errors.push({
        path: `redirects[${index}]`,
        message:
          `target "${group.target}" has settings that conflict with redirects[${existing.index}]; ` +
          'groups sharing a target must use the same type, preservePath, and preserveQuery',
      });
    }
  });

  return errors;
}

/**
 * Reject domains or targets whose generated resource names collide
 * (for example `a-b.com` and `ab.com`), which would otherwise fail
 * synthesis with a duplicate construct error.
 */
function validateNameCollisions(config: RedirectConfig): ValidationError[] {
  const errors: ValidationError[] = [];
  const domainIds = new Map<string, string>();
  const functionNames = new Map<string, string>();

  config.redirects.forEach((group, index) => {
    if (group.active === false) return;

    if (typeof group.target === 'string' && group.target !== '') {
      const name = sanitizeFunctionName(group.target);
      const existing = functionNames.get(name);
      if (existing !== undefined && existing !== group.target) {
        errors.push({
          path: `redirects[${index}].target`,
          message: `"${group.target}" and "${existing}" produce the same function name "${name}"`,
        });
      } else {
        functionNames.set(name, group.target);
      }
    }

    if (!Array.isArray(group.domains)) return;
    group.domains.forEach((domain, domainIndex) => {
      if (typeof domain !== 'string') return;
      const id = domainLogicalId(domain);
      const existing = domainIds.get(id);
      if (existing !== undefined && existing.toLowerCase() !== domain.toLowerCase()) {
        errors.push({
          path: `redirects[${index}].domains[${domainIndex}]`,
          message: `"${domain}" and "${existing}" produce the same resource ID "${id}"`,
        });
      } else {
        domainIds.set(id, domain);
      }
    });
  });

  return errors;
}

/**
 * Validate the entire redirect configuration.
 *
 * @param config - The configuration to validate
 * @returns Validation result with any errors found
 */
export function validateConfig(config: RedirectConfig): ValidationResult {
  const errors: ValidationError[] = [];
  const seenDomains = new Map<string, string>();

  // Validate redirects array
  if (!config.redirects) {
    errors.push({ path: 'redirects', message: 'redirects is required' });
  } else if (!Array.isArray(config.redirects)) {
    errors.push({ path: 'redirects', message: 'redirects must be an array' });
  } else {
    config.redirects.forEach((group, index) => {
      const groupErrors = validateRedirectGroup(group, index, seenDomains);
      errors.push(...groupErrors);
    });

    // All domains sharing a target share a single CloudFront Function, whose
    // behavior is built from the first group's settings. If two active groups
    // point at the same target with different type/preserve* settings, one
    // group's intent would be silently dropped, so reject it here.
    errors.push(...validateTargetConsistency(config));
    errors.push(...validateNameCollisions(config));
  }

  // Validate settings
  if (config.settings) {
    if (typeof config.settings !== 'object') {
      errors.push({ path: 'settings', message: 'settings must be an object' });
    } else {
      const settingsFields: Array<{ field: string; value: unknown }> = [
        { field: 'preservePath', value: config.settings.preservePath },
        { field: 'preserveQuery', value: config.settings.preserveQuery },
      ];
      for (const { field, value } of settingsFields) {
        const error = validateOptionalBoolean(value, field, 'settings');
        if (error) errors.push(error);
      }
    }
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

/**
 * Format validation errors for display.
 */
export function formatValidationErrors(result: ValidationResult): string {
  if (result.valid) {
    return 'Configuration is valid.';
  }

  const lines = ['Validation failed:', ''];
  for (const error of result.errors) {
    lines.push(`  \u2717 ${error.path}: ${error.message}`);
  }
  lines.push('');
  lines.push('Deployment aborted. Fix errors in redirects.yaml and push again.');

  return lines.join('\n');
}

/**
 * Load and validate the configuration file.
 * Throws an error if validation fails.
 *
 * @param configPath - Optional path to configuration file
 * @returns Validated configuration
 */
export function loadAndValidateConfig(configPath?: string): RedirectConfig {
  const config = loadConfig(configPath);
  const result = validateConfig(config);

  if (!result.valid) {
    throw new Error(formatValidationErrors(result));
  }

  return config;
}

// CLI entry point
if (require.main === module) {
  try {
    const configPath = process.argv[2];
    const config = loadAndValidateConfig(configPath);
    const domainCount = config.redirects
      .filter(r => r.active !== false)
      .reduce((sum, r) => sum + r.domains.length, 0);
    const targetCount = new Set(
      config.redirects
        .filter(r => r.active !== false)
        .map(r => r.target)
    ).size;

    console.log('\u2713 Configuration is valid');
    console.log(`  ${config.redirects.length} redirect group(s)`);
    console.log(`  ${domainCount} active domain(s)`);
    console.log(`  ${targetCount} unique target(s)`);
  } catch (error) {
    console.error((error as Error).message);
    process.exit(1);
  }
}

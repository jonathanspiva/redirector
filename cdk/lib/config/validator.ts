import { RedirectConfig, RedirectGroup, ValidationError, ValidationResult } from './types';
import { loadConfig } from './parser';

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

      // Check for duplicates
      const existingPath = seenDomains.get(domain);
      if (existingPath) {
        errors.push({
          path: domainPath,
          message: `duplicate domain "${domain}" (also in ${existingPath})`,
        });
      } else {
        seenDomains.set(domain, basePath);
      }
    });
  }

  // Validate optional boolean fields
  if (group.preservePath !== undefined && typeof group.preservePath !== 'boolean') {
    errors.push({
      path: `${basePath}.preservePath`,
      message: 'preservePath must be a boolean',
    });
  }

  if (group.preserveQuery !== undefined && typeof group.preserveQuery !== 'boolean') {
    errors.push({
      path: `${basePath}.preserveQuery`,
      message: 'preserveQuery must be a boolean',
    });
  }

  if (group.active !== undefined && typeof group.active !== 'boolean') {
    errors.push({
      path: `${basePath}.active`,
      message: 'active must be a boolean',
    });
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
  }

  // Validate settings
  if (config.settings) {
    if (typeof config.settings !== 'object') {
      errors.push({ path: 'settings', message: 'settings must be an object' });
    } else {
      if (config.settings.preservePath !== undefined && typeof config.settings.preservePath !== 'boolean') {
        errors.push({
          path: 'settings.preservePath',
          message: 'preservePath must be a boolean',
        });
      }
      if (config.settings.preserveQuery !== undefined && typeof config.settings.preserveQuery !== 'boolean') {
        errors.push({
          path: 'settings.preserveQuery',
          message: 'preserveQuery must be a boolean',
        });
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

import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'yaml';
import { RedirectConfig, RedirectGroup, Settings, ResolvedDomainConfig } from './types';

/**
 * Default settings used when not specified in configuration.
 */
const DEFAULT_SETTINGS: Settings = {
  preservePath: true,
  preserveQuery: true,
};

/**
 * Resolve the configuration file path.
 *
 * Priority:
 * 1. Explicitly passed configPath
 * 2. REDIRECTS_CONFIG environment variable
 * 3. redirects.yaml in current working directory
 * 4. redirects.yaml in parent directory (submodule setup)
 * 5. redirects.example.yaml in repo root (development/demo)
 */
function resolveConfigPath(configPath?: string): string {
  // 1. Explicit path
  if (configPath) {
    return configPath;
  }

  // 2. Environment variable
  if (process.env.REDIRECTS_CONFIG) {
    return process.env.REDIRECTS_CONFIG;
  }

  // 3. Current working directory
  const cwdPath = path.join(process.cwd(), 'redirects.yaml');
  if (fs.existsSync(cwdPath)) {
    return cwdPath;
  }

  // 4. Parent directory (submodule setup: private-repo/tool/cdk)
  const parentPath = path.join(process.cwd(), '..', 'redirects.yaml');
  if (fs.existsSync(parentPath)) {
    return parentPath;
  }

  // 5. Two levels up (submodule setup: private-repo/tool/cdk when running from cdk dir)
  const grandparentPath = path.join(process.cwd(), '..', '..', 'redirects.yaml');
  if (fs.existsSync(grandparentPath)) {
    return grandparentPath;
  }

  // 6. Example config in repo (development/demo)
  const examplePath = path.join(__dirname, '..', '..', '..', 'redirects.example.yaml');
  if (fs.existsSync(examplePath)) {
    return examplePath;
  }

  throw new Error(
    'No configuration file found. Create redirects.yaml or set REDIRECTS_CONFIG environment variable.'
  );
}

/**
 * Load and parse the redirects.yaml configuration file.
 *
 * @param configPath - Path to the YAML configuration file
 * @returns Parsed configuration object
 * @throws Error if file cannot be read or parsed
 */
export function loadConfig(configPath?: string): RedirectConfig {
  const resolvedPath = resolveConfigPath(configPath);

  if (!fs.existsSync(resolvedPath)) {
    throw new Error(`Configuration file not found: ${resolvedPath}`);
  }

  const content = fs.readFileSync(resolvedPath, 'utf-8');
  const parsed = yaml.parse(content);

  if (!parsed) {
    throw new Error('Configuration file is empty');
  }

  // Apply defaults
  const config: RedirectConfig = {
    redirects: parsed.redirects ?? [],
    settings: {
      ...DEFAULT_SETTINGS,
      ...(parsed.settings ?? {}),
    },
  };

  return config;
}

/**
 * Get all active redirect groups from the configuration.
 *
 * @param config - Parsed configuration
 * @returns Array of active redirect groups
 */
export function getActiveRedirects(config: RedirectConfig): RedirectGroup[] {
  return config.redirects.filter(r => r.active !== false);
}

/**
 * Resolve a domain's full configuration by merging group and global settings.
 *
 * @param domain - The domain name
 * @param group - The redirect group containing this domain
 * @param settings - Global settings
 * @returns Fully resolved domain configuration
 */
export function resolveDomainConfig(
  domain: string,
  group: RedirectGroup,
  settings: Settings
): ResolvedDomainConfig {
  return {
    domain,
    target: group.target,
    statusCode: group.type === 'permanent' ? 301 : 302,
    preservePath: group.preservePath ?? settings.preservePath,
    preserveQuery: group.preserveQuery ?? settings.preserveQuery,
    skipTest: group.skipTest?.includes(domain) ?? false,
    description: group.description,
  };
}

/**
 * Get all resolved domain configurations from the config.
 *
 * @param config - Parsed configuration
 * @returns Array of resolved domain configurations for all active domains
 */
export function getAllDomainConfigs(config: RedirectConfig): ResolvedDomainConfig[] {
  const activeRedirects = getActiveRedirects(config);
  const domains: ResolvedDomainConfig[] = [];

  for (const group of activeRedirects) {
    for (const domain of group.domains) {
      domains.push(resolveDomainConfig(domain, group, config.settings));
    }
  }

  return domains;
}

/**
 * Group domains by their target URL.
 * All domains redirecting to the same target will share a CloudFront Function.
 *
 * @param config - Parsed configuration
 * @returns Map of target URL to array of resolved domain configs
 */
export function groupDomainsByTarget(config: RedirectConfig): Map<string, ResolvedDomainConfig[]> {
  const domainConfigs = getAllDomainConfigs(config);
  const grouped = new Map<string, ResolvedDomainConfig[]>();

  for (const domainConfig of domainConfigs) {
    const existing = grouped.get(domainConfig.target) ?? [];
    existing.push(domainConfig);
    grouped.set(domainConfig.target, existing);
  }

  return grouped;
}

/**
 * Get unique targets from the configuration.
 * Each unique target will get one CloudFront Function.
 *
 * @param config - Parsed configuration
 * @returns Array of unique target configurations (first domain's config for each target)
 */
export function getUniqueTargets(config: RedirectConfig): ResolvedDomainConfig[] {
  return Array.from(groupDomainsByTarget(config).values())
    .filter(domains => domains.length > 0)
    .map(domains => domains[0]);
}

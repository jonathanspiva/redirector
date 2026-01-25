/**
 * Shared domain parsing utilities.
 *
 * Used by both CDK stacks (synthesis-time) and runtime scripts (preflight checks).
 */

/**
 * Remove wildcard prefix from a domain.
 *
 * @param domain - Domain that may start with "*."
 * @returns Domain without wildcard prefix
 *
 * @example
 * stripWildcard('*.example.com') // 'example.com'
 * stripWildcard('example.com')   // 'example.com'
 */
export function stripWildcard(domain: string): string {
  return domain.startsWith('*.') ? domain.substring(2) : domain;
}

/**
 * Get the domain hierarchy for hosted zone lookup.
 *
 * Returns an array of domains from most specific to least specific,
 * suitable for finding which hosted zone manages a domain.
 *
 * @param domain - Full domain name (wildcards are stripped)
 * @returns Array of parent domains to try, most specific first
 *
 * @example
 * getDomainHierarchy('sub.example.com')
 * // ['sub.example.com', 'example.com']
 *
 * getDomainHierarchy('*.sub.example.com')
 * // ['sub.example.com', 'example.com']
 */
export function getDomainHierarchy(domain: string): string[] {
  const baseDomain = stripWildcard(domain);
  const parts = baseDomain.split('.');
  const hierarchy: string[] = [];

  // Generate each level: sub.example.com -> example.com
  // Stop before TLD (need at least 2 parts for a valid zone)
  for (let i = 0; i < parts.length - 1; i++) {
    hierarchy.push(parts.slice(i).join('.'));
  }

  return hierarchy;
}

/**
 * Sanitize a string for use in CloudFormation logical IDs.
 *
 * Removes special characters and truncates to 64 characters.
 *
 * @param input - String to sanitize
 * @returns Alphanumeric string suitable for logical IDs
 */
export function sanitizeLogicalId(input: string): string {
  return input
    .replace(/[^a-zA-Z0-9]/g, '')
    .substring(0, 64);
}

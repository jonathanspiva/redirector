/**
 * Configuration for a group of domains that redirect to the same target.
 */
export interface RedirectGroup {
  /** The destination URL (must be HTTPS, no trailing slash) */
  target: string;

  /** Redirect type: permanent (301) or temporary (302) */
  type: 'permanent' | 'temporary';

  /** Human-readable description of this redirect group */
  description?: string;

  /** List of source domains to redirect */
  domains: string[];

  /** Whether to preserve the original path (overrides global setting) */
  preservePath?: boolean;

  /** Whether to preserve the original query string (overrides global setting) */
  preserveQuery?: boolean;

  /** Whether this redirect is active (defaults to true) */
  active?: boolean;

  /** Domains to skip during smoke testing */
  skipTest?: string[];

  /**
   * Route 53 hosted zone that holds this group's domains.
   * Defaults to each domain itself (wildcards stripped), which covers apex
   * domains like example.com and *.example.com. Set it for subdomains such
   * as blog.example.com that live in the example.com zone.
   */
  hostedZone?: string;
}

/**
 * Global settings that apply to all redirects unless overridden.
 */
export interface Settings {
  /** Default: preserve original path in redirect */
  preservePath: boolean;

  /** Default: preserve original query string in redirect */
  preserveQuery: boolean;
}

/**
 * Root configuration loaded from redirects.yaml.
 */
export interface RedirectConfig {
  /** List of redirect groups */
  redirects: RedirectGroup[];

  /** Global settings */
  settings: Settings;
}

/**
 * Resolved configuration for a single domain, with all settings merged.
 */
export interface ResolvedDomainConfig {
  /** Source domain */
  domain: string;

  /** Destination URL */
  target: string;

  /** HTTP status code (301 or 302) */
  statusCode: 301 | 302;

  /** Whether to preserve path */
  preservePath: boolean;

  /** Whether to preserve query string */
  preserveQuery: boolean;

  /** Whether to skip smoke testing for this domain */
  skipTest: boolean;

  /** Route 53 hosted zone name that holds this domain */
  hostedZone: string;

  /** Original redirect group description */
  description?: string;
}

/**
 * Validation error with location information.
 */
export interface ValidationError {
  /** JSON path to the error (e.g., "redirects[0].target") */
  path: string;

  /** Human-readable error message */
  message: string;
}

/**
 * Result of configuration validation.
 */
export interface ValidationResult {
  /** Whether the configuration is valid */
  valid: boolean;

  /** List of errors (empty if valid) */
  errors: ValidationError[];
}

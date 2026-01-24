import { validateConfig, formatValidationErrors } from '../lib/config/validator';
import { RedirectConfig } from '../lib/config/types';

describe('validateConfig', () => {
  const validConfig: RedirectConfig = {
    redirects: [
      {
        target: 'https://www.example.com',
        type: 'permanent',
        domains: ['old-example.com'],
      },
    ],
    settings: {
      preservePath: true,
      preserveQuery: true,
    },
  };

  describe('valid configurations', () => {
    it('should accept a minimal valid configuration', () => {
      const result = validateConfig(validConfig);
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('should accept multiple redirect groups', () => {
      const config: RedirectConfig = {
        redirects: [
          {
            target: 'https://www.example.com',
            type: 'permanent',
            domains: ['old-example.com', 'legacy.com'],
          },
          {
            target: 'https://www.other.com',
            type: 'temporary',
            domains: ['temp.com'],
          },
        ],
        settings: {
          preservePath: true,
          preserveQuery: true,
        },
      };

      const result = validateConfig(config);
      expect(result.valid).toBe(true);
    });

    it('should accept wildcard domains', () => {
      const config: RedirectConfig = {
        redirects: [
          {
            target: 'https://www.example.com',
            type: 'permanent',
            domains: ['*.example.com', '*.sub.example.com'],
          },
        ],
        settings: {
          preservePath: true,
          preserveQuery: true,
        },
      };

      const result = validateConfig(config);
      expect(result.valid).toBe(true);
    });

    it('should accept optional fields', () => {
      const config: RedirectConfig = {
        redirects: [
          {
            target: 'https://www.example.com',
            type: 'permanent',
            description: 'Test redirect',
            domains: ['old-example.com'],
            preservePath: false,
            preserveQuery: false,
            active: false,
            skipTest: ['old-example.com'],
          },
        ],
        settings: {
          preservePath: true,
          preserveQuery: true,
        },
      };

      const result = validateConfig(config);
      expect(result.valid).toBe(true);
    });

    it('should accept target URLs with paths', () => {
      const config: RedirectConfig = {
        redirects: [
          {
            target: 'https://www.example.com/landing/page',
            type: 'permanent',
            domains: ['old.com'],
          },
        ],
        settings: {
          preservePath: true,
          preserveQuery: true,
        },
      };

      const result = validateConfig(config);
      expect(result.valid).toBe(true);
    });
  });

  describe('invalid configurations', () => {
    it('should reject missing target', () => {
      const config = {
        redirects: [
          {
            type: 'permanent',
            domains: ['old.com'],
          },
        ],
        settings: { preservePath: true, preserveQuery: true },
      } as RedirectConfig;

      const result = validateConfig(config);
      expect(result.valid).toBe(false);
      expect(result.errors).toContainEqual({
        path: 'redirects[0].target',
        message: 'target is required',
      });
    });

    it('should reject missing type', () => {
      const config = {
        redirects: [
          {
            target: 'https://www.example.com',
            domains: ['old.com'],
          },
        ],
        settings: { preservePath: true, preserveQuery: true },
      } as RedirectConfig;

      const result = validateConfig(config);
      expect(result.valid).toBe(false);
      expect(result.errors).toContainEqual({
        path: 'redirects[0].type',
        message: 'type is required',
      });
    });

    it('should reject invalid type value', () => {
      const config = {
        redirects: [
          {
            target: 'https://www.example.com',
            type: 'perm' as any,
            domains: ['old.com'],
          },
        ],
        settings: { preservePath: true, preserveQuery: true },
      } as RedirectConfig;

      const result = validateConfig(config);
      expect(result.valid).toBe(false);
      expect(result.errors).toContainEqual({
        path: 'redirects[0].type',
        message: 'must be "permanent" or "temporary", got "perm"',
      });
    });

    it('should reject missing domains', () => {
      const config = {
        redirects: [
          {
            target: 'https://www.example.com',
            type: 'permanent',
          },
        ],
        settings: { preservePath: true, preserveQuery: true },
      } as RedirectConfig;

      const result = validateConfig(config);
      expect(result.valid).toBe(false);
      expect(result.errors).toContainEqual({
        path: 'redirects[0].domains',
        message: 'domains is required',
      });
    });

    it('should reject empty domains array', () => {
      const config: RedirectConfig = {
        redirects: [
          {
            target: 'https://www.example.com',
            type: 'permanent',
            domains: [],
          },
        ],
        settings: { preservePath: true, preserveQuery: true },
      };

      const result = validateConfig(config);
      expect(result.valid).toBe(false);
      expect(result.errors).toContainEqual({
        path: 'redirects[0].domains',
        message: 'domains must not be empty',
      });
    });

    it('should reject HTTP target URLs', () => {
      const config: RedirectConfig = {
        redirects: [
          {
            target: 'http://www.example.com',
            type: 'permanent',
            domains: ['old.com'],
          },
        ],
        settings: { preservePath: true, preserveQuery: true },
      };

      const result = validateConfig(config);
      expect(result.valid).toBe(false);
      expect(result.errors.some(e =>
        e.path === 'redirects[0].target' && e.message.includes('must be HTTPS')
      )).toBe(true);
    });

    it('should reject target URLs with trailing slash', () => {
      const config: RedirectConfig = {
        redirects: [
          {
            target: 'https://www.example.com/',
            type: 'permanent',
            domains: ['old.com'],
          },
        ],
        settings: { preservePath: true, preserveQuery: true },
      };

      const result = validateConfig(config);
      expect(result.valid).toBe(false);
      expect(result.errors.some(e =>
        e.path === 'redirects[0].target' && e.message.includes('trailing slash')
      )).toBe(true);
    });

    it('should reject invalid domain format', () => {
      const config: RedirectConfig = {
        redirects: [
          {
            target: 'https://www.example.com',
            type: 'permanent',
            domains: ['not a domain', 'http://example.com', 'invalid_domain.com'],
          },
        ],
        settings: { preservePath: true, preserveQuery: true },
      };

      const result = validateConfig(config);
      expect(result.valid).toBe(false);
      expect(result.errors.length).toBeGreaterThanOrEqual(3);
    });

    it('should reject duplicate domains', () => {
      const config: RedirectConfig = {
        redirects: [
          {
            target: 'https://www.example.com',
            type: 'permanent',
            domains: ['old.com'],
          },
          {
            target: 'https://www.other.com',
            type: 'permanent',
            domains: ['old.com'],
          },
        ],
        settings: { preservePath: true, preserveQuery: true },
      };

      const result = validateConfig(config);
      expect(result.valid).toBe(false);
      expect(result.errors.some(e =>
        e.message.includes('duplicate domain')
      )).toBe(true);
    });

    it('should reject invalid wildcard domains', () => {
      const config: RedirectConfig = {
        redirects: [
          {
            target: 'https://www.example.com',
            type: 'permanent',
            domains: ['*.*.example.com', '*example.com'],
          },
        ],
        settings: { preservePath: true, preserveQuery: true },
      };

      const result = validateConfig(config);
      expect(result.valid).toBe(false);
    });

    it('should reject skipTest domains not in domains list', () => {
      const config: RedirectConfig = {
        redirects: [
          {
            target: 'https://www.example.com',
            type: 'permanent',
            domains: ['old.com'],
            skipTest: ['not-in-list.com'],
          },
        ],
        settings: { preservePath: true, preserveQuery: true },
      };

      const result = validateConfig(config);
      expect(result.valid).toBe(false);
      expect(result.errors.some(e =>
        e.message.includes('not in the domains list')
      )).toBe(true);
    });
  });

  describe('domain format validation', () => {
    const testDomains = (domains: string[], expectValid: boolean) => {
      const config: RedirectConfig = {
        redirects: [
          {
            target: 'https://www.example.com',
            type: 'permanent',
            domains,
          },
        ],
        settings: { preservePath: true, preserveQuery: true },
      };

      const result = validateConfig(config);
      return result.valid === expectValid;
    };

    it('should accept standard domains', () => {
      expect(testDomains(['example.com'], true)).toBe(true);
      expect(testDomains(['sub.example.com'], true)).toBe(true);
      expect(testDomains(['my-site.example.com'], true)).toBe(true);
      expect(testDomains(['site123.com'], true)).toBe(true);
    });

    it('should accept wildcard domains', () => {
      expect(testDomains(['*.example.com'], true)).toBe(true);
      expect(testDomains(['*.sub.example.com'], true)).toBe(true);
    });

    it('should reject invalid domains', () => {
      expect(testDomains(['single'], false)).toBe(true);
      expect(testDomains(['my_site.com'], false)).toBe(true);
      expect(testDomains(['site!.com'], false)).toBe(true);
      expect(testDomains(['-site.com'], false)).toBe(true);
    });
  });
});

describe('formatValidationErrors', () => {
  it('should format valid result correctly', () => {
    const result = formatValidationErrors({ valid: true, errors: [] });
    expect(result).toBe('Configuration is valid.');
  });

  it('should format errors correctly', () => {
    const result = formatValidationErrors({
      valid: false,
      errors: [
        { path: 'redirects[0].target', message: 'must be HTTPS' },
        { path: 'redirects[1].domains[0]', message: 'invalid format' },
      ],
    });

    expect(result).toContain('Validation failed');
    expect(result).toContain('redirects[0].target: must be HTTPS');
    expect(result).toContain('redirects[1].domains[0]: invalid format');
    expect(result).toContain('Deployment aborted');
  });
});

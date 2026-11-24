import { stripWildcard, getDomainHierarchy, sanitizeLogicalId, domainLogicalId } from '../lib/utils/domain';

describe('domain utilities', () => {
  describe('stripWildcard', () => {
    it('should remove wildcard prefix', () => {
      expect(stripWildcard('*.example.com')).toBe('example.com');
    });

    it('should leave non-wildcard domains unchanged', () => {
      expect(stripWildcard('example.com')).toBe('example.com');
      expect(stripWildcard('sub.example.com')).toBe('sub.example.com');
    });

    it('should only remove leading wildcard', () => {
      expect(stripWildcard('example.*.com')).toBe('example.*.com');
    });
  });

  describe('getDomainHierarchy', () => {
    it('should return hierarchy for simple domain', () => {
      expect(getDomainHierarchy('example.com')).toEqual(['example.com']);
    });

    it('should return hierarchy for subdomain', () => {
      expect(getDomainHierarchy('sub.example.com')).toEqual([
        'sub.example.com',
        'example.com',
      ]);
    });

    it('should return hierarchy for deep subdomain', () => {
      expect(getDomainHierarchy('a.b.c.example.com')).toEqual([
        'a.b.c.example.com',
        'b.c.example.com',
        'c.example.com',
        'example.com',
      ]);
    });

    it('should handle wildcard domains by stripping wildcard', () => {
      expect(getDomainHierarchy('*.example.com')).toEqual(['example.com']);
      expect(getDomainHierarchy('*.sub.example.com')).toEqual([
        'sub.example.com',
        'example.com',
      ]);
    });

    it('should not include TLD only', () => {
      // 'com' alone is not a valid hosted zone
      expect(getDomainHierarchy('example.com')).not.toContain('com');
    });
  });

  describe('sanitizeLogicalId', () => {
    it('should remove special characters', () => {
      expect(sanitizeLogicalId('my-domain.com')).toBe('mydomaincom');
    });

    it('should preserve alphanumeric characters', () => {
      expect(sanitizeLogicalId('Example123')).toBe('Example123');
    });

    it('should truncate to 64 characters', () => {
      const longInput = 'a'.repeat(100);
      expect(sanitizeLogicalId(longInput).length).toBe(64);
    });

    it('should handle mixed case', () => {
      expect(sanitizeLogicalId('MyDomain.COM')).toBe('MyDomainCOM');
    });

    it('should handle URLs', () => {
      expect(sanitizeLogicalId('https://example.com/path')).toBe('httpsexamplecompath');
    });
  });

  describe('domainLogicalId', () => {
    it('should match sanitizeLogicalId for non-wildcard domains', () => {
      expect(domainLogicalId('my-domain.com')).toBe('mydomaincom');
    });

    it('should prefix wildcard domains', () => {
      expect(domainLogicalId('*.my-domain.com')).toBe('Wildcardmydomaincom');
    });

    it('should not collide for a wildcard and its apex', () => {
      expect(domainLogicalId('*.example.com')).not.toBe(domainLogicalId('example.com'));
    });
  });
});

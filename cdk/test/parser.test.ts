import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'yaml';
import {
  loadConfig,
  getActiveRedirects,
  resolveDomainConfig,
  getAllDomainConfigs,
  groupDomainsByTarget,
  getUniqueTargets,
} from '../lib/config/parser';
import { RedirectConfig, RedirectGroup, Settings } from '../lib/config/types';

// Store original env and cwd for restoration
const originalEnv = process.env;
const originalCwd = process.cwd;

describe('loadConfig', () => {
  const testDir = path.join(__dirname, 'parser-test-fixtures');
  const validConfigPath = path.join(testDir, 'valid-config.yaml');
  const emptyConfigPath = path.join(testDir, 'empty-config.yaml');
  const minimalConfigPath = path.join(testDir, 'minimal-config.yaml');

  beforeAll(() => {
    // Create test directory and fixtures
    if (!fs.existsSync(testDir)) {
      fs.mkdirSync(testDir, { recursive: true });
    }

    // Valid config
    fs.writeFileSync(validConfigPath, yaml.stringify({
      redirects: [
        {
          target: 'https://www.example.com',
          type: 'permanent',
          domains: ['old.com'],
        },
      ],
      settings: {
        preservePath: false,
        preserveQuery: false,
      },
    }));

    // Empty config (just whitespace/comments)
    fs.writeFileSync(emptyConfigPath, '# Empty config\n');

    // Minimal config (no settings)
    fs.writeFileSync(minimalConfigPath, yaml.stringify({
      redirects: [
        {
          target: 'https://example.com',
          type: 'temporary',
          domains: ['temp.com'],
        },
      ],
    }));
  });

  afterAll(() => {
    // Clean up test fixtures
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true });
    }
  });

  afterEach(() => {
    // Restore environment
    process.env = originalEnv;
    process.cwd = originalCwd;
  });

  describe('explicit config path', () => {
    it('should load config from explicit path', () => {
      const config = loadConfig(validConfigPath);
      expect(config.redirects).toHaveLength(1);
      expect(config.redirects[0].target).toBe('https://www.example.com');
    });

    it('should throw error for non-existent explicit path', () => {
      expect(() => loadConfig('/nonexistent/path/config.yaml'))
        .toThrow('Configuration file not found');
    });

    it('should throw error for empty config file', () => {
      expect(() => loadConfig(emptyConfigPath))
        .toThrow('Configuration file is empty');
    });
  });

  describe('default settings', () => {
    it('should apply default settings when not specified', () => {
      const config = loadConfig(minimalConfigPath);
      expect(config.settings.preservePath).toBe(true);
      expect(config.settings.preserveQuery).toBe(true);
    });

    it('should override defaults with explicit settings', () => {
      const config = loadConfig(validConfigPath);
      expect(config.settings.preservePath).toBe(false);
      expect(config.settings.preserveQuery).toBe(false);
    });

    it('should handle missing redirects array gracefully', () => {
      const noRedirectsPath = path.join(testDir, 'no-redirects.yaml');
      fs.writeFileSync(noRedirectsPath, yaml.stringify({ settings: {} }));

      const config = loadConfig(noRedirectsPath);
      expect(config.redirects).toEqual([]);

      fs.unlinkSync(noRedirectsPath);
    });
  });

  describe('environment variable config path', () => {
    it('should use REDIRECTS_CONFIG env var when no explicit path', () => {
      process.env = { ...originalEnv, REDIRECTS_CONFIG: validConfigPath };

      const config = loadConfig();
      expect(config.redirects[0].target).toBe('https://www.example.com');
    });

    it('should prefer explicit path over env var', () => {
      process.env = { ...originalEnv, REDIRECTS_CONFIG: '/wrong/path.yaml' };

      const config = loadConfig(validConfigPath);
      expect(config.redirects[0].target).toBe('https://www.example.com');
    });
  });
});

describe('getActiveRedirects', () => {
  it('should return only active redirect groups', () => {
    const config: RedirectConfig = {
      redirects: [
        { target: 'https://a.com', type: 'permanent', domains: ['a.com'], active: true },
        { target: 'https://b.com', type: 'permanent', domains: ['b.com'], active: false },
        { target: 'https://c.com', type: 'permanent', domains: ['c.com'] }, // undefined = active
      ],
      settings: { preservePath: true, preserveQuery: true },
    };

    const active = getActiveRedirects(config);
    expect(active).toHaveLength(2);
    expect(active.map(r => r.target)).toEqual(['https://a.com', 'https://c.com']);
  });

  it('should return all redirects when none are explicitly inactive', () => {
    const config: RedirectConfig = {
      redirects: [
        { target: 'https://a.com', type: 'permanent', domains: ['a.com'] },
        { target: 'https://b.com', type: 'temporary', domains: ['b.com'] },
      ],
      settings: { preservePath: true, preserveQuery: true },
    };

    const active = getActiveRedirects(config);
    expect(active).toHaveLength(2);
  });

  it('should return empty array when all redirects are inactive', () => {
    const config: RedirectConfig = {
      redirects: [
        { target: 'https://a.com', type: 'permanent', domains: ['a.com'], active: false },
      ],
      settings: { preservePath: true, preserveQuery: true },
    };

    const active = getActiveRedirects(config);
    expect(active).toHaveLength(0);
  });
});

describe('resolveDomainConfig', () => {
  const baseGroup: RedirectGroup = {
    target: 'https://www.example.com',
    type: 'permanent',
    domains: ['old.com'],
  };

  const settings: Settings = {
    preservePath: true,
    preserveQuery: true,
  };

  it('should resolve basic domain config', () => {
    const resolved = resolveDomainConfig('old.com', baseGroup, settings);

    expect(resolved.domain).toBe('old.com');
    expect(resolved.target).toBe('https://www.example.com');
    expect(resolved.statusCode).toBe(301);
    expect(resolved.preservePath).toBe(true);
    expect(resolved.preserveQuery).toBe(true);
    expect(resolved.skipTest).toBe(false);
  });

  it('should use 302 for temporary redirects', () => {
    const tempGroup: RedirectGroup = { ...baseGroup, type: 'temporary' };
    const resolved = resolveDomainConfig('old.com', tempGroup, settings);

    expect(resolved.statusCode).toBe(302);
  });

  it('should prefer group settings over global settings', () => {
    const groupWithSettings: RedirectGroup = {
      ...baseGroup,
      preservePath: false,
      preserveQuery: false,
    };

    const resolved = resolveDomainConfig('old.com', groupWithSettings, settings);

    expect(resolved.preservePath).toBe(false);
    expect(resolved.preserveQuery).toBe(false);
  });

  it('should handle skipTest correctly', () => {
    const groupWithSkip: RedirectGroup = {
      ...baseGroup,
      domains: ['old.com', 'other.com'],
      skipTest: ['old.com'],
    };

    const skipped = resolveDomainConfig('old.com', groupWithSkip, settings);
    const notSkipped = resolveDomainConfig('other.com', groupWithSkip, settings);

    expect(skipped.skipTest).toBe(true);
    expect(notSkipped.skipTest).toBe(false);
  });

  it('should include description when present', () => {
    const groupWithDesc: RedirectGroup = {
      ...baseGroup,
      description: 'Test description',
    };

    const resolved = resolveDomainConfig('old.com', groupWithDesc, settings);
    expect(resolved.description).toBe('Test description');
  });
});

describe('getAllDomainConfigs', () => {
  it('should return configs for all domains in active groups', () => {
    const config: RedirectConfig = {
      redirects: [
        { target: 'https://a.com', type: 'permanent', domains: ['a1.com', 'a2.com'] },
        { target: 'https://b.com', type: 'temporary', domains: ['b1.com'] },
      ],
      settings: { preservePath: true, preserveQuery: true },
    };

    const domainConfigs = getAllDomainConfigs(config);

    expect(domainConfigs).toHaveLength(3);
    expect(domainConfigs.map(d => d.domain)).toEqual(['a1.com', 'a2.com', 'b1.com']);
  });

  it('should exclude domains from inactive groups', () => {
    const config: RedirectConfig = {
      redirects: [
        { target: 'https://a.com', type: 'permanent', domains: ['active.com'] },
        { target: 'https://b.com', type: 'permanent', domains: ['inactive.com'], active: false },
      ],
      settings: { preservePath: true, preserveQuery: true },
    };

    const domainConfigs = getAllDomainConfigs(config);

    expect(domainConfigs).toHaveLength(1);
    expect(domainConfigs[0].domain).toBe('active.com');
  });
});

describe('groupDomainsByTarget', () => {
  it('should group domains by their target URL', () => {
    const config: RedirectConfig = {
      redirects: [
        { target: 'https://target1.com', type: 'permanent', domains: ['a.com', 'b.com'] },
        { target: 'https://target2.com', type: 'permanent', domains: ['c.com'] },
        { target: 'https://target1.com', type: 'permanent', domains: ['d.com'] }, // Same target
      ],
      settings: { preservePath: true, preserveQuery: true },
    };

    const grouped = groupDomainsByTarget(config);

    expect(grouped.size).toBe(2);
    expect(grouped.get('https://target1.com')).toHaveLength(3);
    expect(grouped.get('https://target2.com')).toHaveLength(1);
  });

  it('should return empty map for empty config', () => {
    const config: RedirectConfig = {
      redirects: [],
      settings: { preservePath: true, preserveQuery: true },
    };

    const grouped = groupDomainsByTarget(config);
    expect(grouped.size).toBe(0);
  });
});

describe('getUniqueTargets', () => {
  it('should return one config per unique target', () => {
    const config: RedirectConfig = {
      redirects: [
        { target: 'https://target1.com', type: 'permanent', domains: ['a.com', 'b.com'] },
        { target: 'https://target2.com', type: 'temporary', domains: ['c.com'] },
        { target: 'https://target1.com', type: 'permanent', domains: ['d.com'] },
      ],
      settings: { preservePath: true, preserveQuery: true },
    };

    const targets = getUniqueTargets(config);

    expect(targets).toHaveLength(2);
    expect(targets.map(t => t.target)).toContain('https://target1.com');
    expect(targets.map(t => t.target)).toContain('https://target2.com');
  });

  it('should return first domain config for each target', () => {
    const config: RedirectConfig = {
      redirects: [
        { target: 'https://example.com', type: 'permanent', domains: ['first.com', 'second.com'] },
      ],
      settings: { preservePath: true, preserveQuery: true },
    };

    const targets = getUniqueTargets(config);

    expect(targets).toHaveLength(1);
    expect(targets[0].domain).toBe('first.com');
  });
});

describe('config path resolution (mocked)', () => {
  const testDir = path.join(__dirname, 'parser-resolution-test');
  const mockCwdConfig = path.join(testDir, 'cwd', 'redirects.yaml');
  const mockParentConfig = path.join(testDir, 'redirects.yaml');

  beforeAll(() => {
    // Create nested directory structure for resolution testing
    fs.mkdirSync(path.join(testDir, 'cwd'), { recursive: true });

    // Config in "parent" directory
    fs.writeFileSync(mockParentConfig, yaml.stringify({
      redirects: [{ target: 'https://parent.com', type: 'permanent', domains: ['parent.com'] }],
    }));

    // Config in "cwd" directory
    fs.writeFileSync(mockCwdConfig, yaml.stringify({
      redirects: [{ target: 'https://cwd.com', type: 'permanent', domains: ['cwd.com'] }],
    }));
  });

  afterAll(() => {
    fs.rmSync(testDir, { recursive: true });
  });

  it('should find config in current working directory', () => {
    // When a config exists in cwd, it should be found
    const config = loadConfig(mockCwdConfig);
    expect(config.redirects[0].target).toBe('https://cwd.com');
  });

  it('should find config in parent directory structure', () => {
    // Directly test parent config loading
    const config = loadConfig(mockParentConfig);
    expect(config.redirects[0].target).toBe('https://parent.com');
  });

  it('should throw for non-existent explicit config path', () => {
    // When given a non-existent explicit path, should throw
    const nonExistentPath = '/definitely/does/not/exist/redirects.yaml';
    expect(() => loadConfig(nonExistentPath)).toThrow('Configuration file not found');
  });
});

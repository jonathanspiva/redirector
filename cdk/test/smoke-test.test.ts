import * as https from 'https';
import * as http from 'http';
import { EventEmitter } from 'events';
import { testDomain } from '../scripts/smoke-test';
import { ResolvedDomainConfig } from '../lib/config/types';

// Mock https module
jest.mock('https');

const mockedHttps = https as jest.Mocked<typeof https>;

describe('testDomain', () => {
  let mockRequest: EventEmitter & { destroy: jest.Mock };
  let mockResponse: EventEmitter & {
    statusCode?: number;
    headers: Record<string, string | undefined>;
  };

  beforeEach(() => {
    jest.clearAllMocks();

    mockRequest = Object.assign(new EventEmitter(), {
      destroy: jest.fn(),
    });

    mockResponse = Object.assign(new EventEmitter(), {
      statusCode: 301,
      headers: {
        location: 'https://www.example.com/test-path?test=param',
      },
    });

    // Default mock implementation
    mockedHttps.get.mockImplementation((_url, _options, callback) => {
      if (typeof callback === 'function') {
        process.nextTick(() => callback(mockResponse as unknown as http.IncomingMessage));
      }
      return mockRequest as unknown as http.ClientRequest;
    });
  });

  const createConfig = (overrides: Partial<ResolvedDomainConfig> = {}): ResolvedDomainConfig => ({
    domain: 'old.example.com',
    target: 'https://www.example.com',
    statusCode: 301,
    preservePath: true,
    preserveQuery: true,
    skipTest: false,
    hostedZone: 'old.example.com',
    ...overrides,
  });

  describe('successful redirects', () => {
    it('should pass for correct 301 redirect', async () => {
      const config = createConfig();
      const result = await testDomain(config);

      expect(result.passed).toBe(true);
      expect(result.domain).toBe('old.example.com');
      expect(result.statusCode).toBe(301);
      expect(result.location).toBe('https://www.example.com/test-path?test=param');
    });

    it('should pass for correct 302 redirect', async () => {
      mockResponse.statusCode = 302;
      mockResponse.headers.location = 'https://www.temp.com/test-path?test=param';

      const config = createConfig({
        target: 'https://www.temp.com',
        statusCode: 302,
      });

      const result = await testDomain(config);

      expect(result.passed).toBe(true);
      expect(result.statusCode).toBe(302);
    });

    it('should handle wildcard domains by replacing with test-wildcard', async () => {
      const config = createConfig({ domain: '*.example.com' });

      await testDomain(config);

      expect(mockedHttps.get).toHaveBeenCalledWith(
        'https://test-wildcard.example.com/test-path?test=param',
        expect.any(Object),
        expect.any(Function)
      );
    });
  });

  describe('status code validation', () => {
    it('should fail when status code does not match expected', async () => {
      mockResponse.statusCode = 302;

      const config = createConfig({ statusCode: 301 });
      const result = await testDomain(config);

      expect(result.passed).toBe(false);
      expect(result.message).toContain('Expected 301, got 302');
    });
  });

  describe('location header validation', () => {
    it('should fail when location header is missing', async () => {
      mockResponse.headers.location = undefined;

      const config = createConfig();
      const result = await testDomain(config);

      expect(result.passed).toBe(false);
      expect(result.message).toBe('No Location header in response');
    });

    it('should fail when location does not start with target', async () => {
      mockResponse.headers.location = 'https://www.wrong.com/path';

      const config = createConfig({ target: 'https://www.example.com' });
      const result = await testDomain(config);

      expect(result.passed).toBe(false);
      expect(result.message).toContain("doesn't start with target");
    });
  });

  describe('path preservation', () => {
    it('should fail when path not preserved but required', async () => {
      mockResponse.headers.location = 'https://www.example.com?test=param';

      const config = createConfig({ preservePath: true });
      const result = await testDomain(config);

      expect(result.passed).toBe(false);
      expect(result.message).toContain('Path not preserved');
    });

    it('should pass when path not preserved and not required', async () => {
      mockResponse.headers.location = 'https://www.example.com';

      const config = createConfig({ preservePath: false, preserveQuery: false });
      const result = await testDomain(config);

      expect(result.passed).toBe(true);
    });
  });

  describe('query preservation', () => {
    it('should fail when query not preserved but required', async () => {
      mockResponse.headers.location = 'https://www.example.com/test-path';

      const config = createConfig({ preserveQuery: true });
      const result = await testDomain(config);

      expect(result.passed).toBe(false);
      expect(result.message).toContain('Query not preserved');
    });

    it('should pass when query not preserved and not required', async () => {
      mockResponse.headers.location = 'https://www.example.com/test-path';

      const config = createConfig({ preserveQuery: false });
      const result = await testDomain(config);

      expect(result.passed).toBe(true);
    });
  });

  describe('error handling', () => {
    it('should handle connection errors', async () => {
      mockedHttps.get.mockImplementation((_url, _options, _callback) => {
        process.nextTick(() => {
          mockRequest.emit('error', new Error('Connection refused'));
        });
        return mockRequest as unknown as http.ClientRequest;
      });

      const config = createConfig();
      const result = await testDomain(config);

      expect(result.passed).toBe(false);
      expect(result.message).toContain('Connection error');
      expect(result.error).toBe('Connection refused');
    });

    it('should handle timeout', async () => {
      mockedHttps.get.mockImplementation((_url, _options, _callback) => {
        process.nextTick(() => {
          mockRequest.emit('timeout');
        });
        return mockRequest as unknown as http.ClientRequest;
      });

      const config = createConfig();
      const result = await testDomain(config);

      expect(result.passed).toBe(false);
      expect(result.message).toBe('Request timeout');
      expect(result.error).toBe('timeout');
      expect(mockRequest.destroy).toHaveBeenCalled();
    });

    it('should handle ERR_FR_TOO_MANY_REDIRECTS as warning', async () => {
      const redirectError = new Error('Too many redirects') as NodeJS.ErrnoException;
      redirectError.code = 'ERR_FR_TOO_MANY_REDIRECTS';

      mockedHttps.get.mockImplementation((_url, _options, _callback) => {
        process.nextTick(() => {
          mockRequest.emit('error', redirectError);
        });
        return mockRequest as unknown as http.ClientRequest;
      });

      const config = createConfig();
      const result = await testDomain(config);

      expect(result.passed).toBe(false);
      expect(result.error).toBe('redirect_loop');
      expect(result.message).toContain('Too many redirects');
    });
  });

  describe('request configuration', () => {
    it('should use correct URL format', async () => {
      const config = createConfig({ domain: 'test.example.com' });

      await testDomain(config);

      expect(mockedHttps.get).toHaveBeenCalledWith(
        'https://test.example.com/test-path?test=param',
        expect.objectContaining({ timeout: 10000 }),
        expect.any(Function)
      );
    });
  });

  describe('edge cases', () => {
    it('should handle ECONNREFUSED error', async () => {
      const connError = new Error('connect ECONNREFUSED') as NodeJS.ErrnoException;
      connError.code = 'ECONNREFUSED';

      mockedHttps.get.mockImplementation((_url, _options, _callback) => {
        process.nextTick(() => {
          mockRequest.emit('error', connError);
        });
        return mockRequest as unknown as http.ClientRequest;
      });

      const config = createConfig();
      const result = await testDomain(config);

      expect(result.passed).toBe(false);
      expect(result.message).toContain('Connection error');
    });

    it('should handle ENOTFOUND error', async () => {
      const dnsError = new Error('getaddrinfo ENOTFOUND') as NodeJS.ErrnoException;
      dnsError.code = 'ENOTFOUND';

      mockedHttps.get.mockImplementation((_url, _options, _callback) => {
        process.nextTick(() => {
          mockRequest.emit('error', dnsError);
        });
        return mockRequest as unknown as http.ClientRequest;
      });

      const config = createConfig();
      const result = await testDomain(config);

      expect(result.passed).toBe(false);
      expect(result.error).toContain('ENOTFOUND');
    });

    it('should handle response with non-redirect status code', async () => {
      mockResponse.statusCode = 200;

      const config = createConfig();
      const result = await testDomain(config);

      expect(result.passed).toBe(false);
      expect(result.message).toContain('Expected 301, got 200');
    });

    it('should handle 302 status code for temporary redirect', async () => {
      mockResponse.statusCode = 302;
      mockResponse.headers.location = 'https://www.example.com/test-path?test=param';

      const config = createConfig({ statusCode: 302 });
      const result = await testDomain(config);

      expect(result.passed).toBe(true);
    });

    it('should pass when path preservation not required and not present', async () => {
      mockResponse.headers.location = 'https://www.example.com';

      const config = createConfig({ preservePath: false, preserveQuery: false });
      const result = await testDomain(config);

      expect(result.passed).toBe(true);
    });
  });
});

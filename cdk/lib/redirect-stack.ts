import * as cdk from 'aws-cdk-lib';
import { Validations } from 'aws-cdk-lib';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as route53Targets from 'aws-cdk-lib/aws-route53-targets';
import { Construct } from 'constructs';
import * as path from 'path';
import { loadAndValidateConfig } from './config/validator';
import { getAllDomainConfigs, getUniqueTargets } from './config/parser';
import { ResolvedDomainConfig } from './config/types';
import { RedirectFunction } from './constructs/redirect-function';
import { domainLogicalId, getDomainHierarchy, sanitizeLogicalId } from './utils/domain';

export interface RedirectStackProps extends cdk.StackProps {
  /** Optional path to the redirects.yaml configuration file */
  configPath?: string;
}

/**
 * Main stack for the domain redirector service.
 *
 * Creates:
 * - One CloudFront Function per unique destination target
 * - One CloudFront Distribution per source domain
 * - One ACM Certificate per source domain
 * - Route 53 A/AAAA records for each source domain
 */
export class RedirectStack extends cdk.Stack {
  /** Map of target URL to CloudFront Function */
  private readonly redirectFunctions: Map<string, cloudfront.Function> = new Map();

  /** Cache of hosted zone lookups to avoid duplicate lookups */
  private readonly hostedZoneCache: Map<string, route53.IHostedZone> = new Map();

  constructor(scope: Construct, id: string, props?: RedirectStackProps) {
    super(scope, id, props);

    // Load and validate configuration
    const configPath = props?.configPath ?? path.join(__dirname, '..', '..', 'redirects.yaml');
    const config = loadAndValidateConfig(configPath);

    // Apply default tags
    cdk.Tags.of(this).add('Service', 'domain-redirector');
    cdk.Tags.of(this).add('ManagedBy', 'cdk');
    cdk.Tags.of(this).add('Environment', 'prod');

    // Create CloudFront Functions for each unique target
    const uniqueTargets = getUniqueTargets(config);
    for (const targetConfig of uniqueTargets) {
      this.createRedirectFunction(targetConfig);
    }

    // Create resources for each active domain
    const domainConfigs = getAllDomainConfigs(config);
    for (const domainConfig of domainConfigs) {
      this.createDomainResources(domainConfig);
    }

    this.acknowledgeNagRules();
  }

  /**
   * Acknowledge cdk-nag rules that don't apply to redirect-only distributions.
   * The CloudFront Function answers every request; there is no content or reachable origin.
   */
  private acknowledgeNagRules(): void {
    const acknowledgements: Array<[string, string]> = [
      ['AwsSolutions-CFR1', 'Redirect-only distribution serves no content, so geo restrictions add nothing.'],
      ['AwsSolutions-CFR2', 'Redirect-only distribution serves no content; WAF would add per-ACL cost with no protected resource.'],
      ['AwsSolutions-CFR3', 'Access logs for redirect-only distributions are not needed; smoke tests verify behavior.'],
    ];
    for (const [id, reason] of acknowledgements) {
      Validations.of(this).acknowledge({ id, reason });
    }
  }

  /**
   * Create a CloudFront Function for a redirect target.
   */
  private createRedirectFunction(config: ResolvedDomainConfig): void {
    const functionId = sanitizeLogicalId(`RedirectFn${config.target}`);

    const redirectFunction = new RedirectFunction(this, functionId, {
      target: config.target,
      statusCode: config.statusCode,
      preservePath: config.preservePath,
      preserveQuery: config.preserveQuery,
    });

    this.redirectFunctions.set(config.target, redirectFunction.function);
  }

  /**
   * Create all resources for a single domain.
   */
  private createDomainResources(config: ResolvedDomainConfig): void {
    const domainId = domainLogicalId(config.domain);

    // Look up the hosted zone
    const hostedZone = this.lookupHostedZone(config.domain);

    // Create ACM certificate
    const certificate = this.createCertificate(domainId, config.domain, hostedZone);

    // Get the redirect function for this target
    const redirectFunction = this.redirectFunctions.get(config.target);
    if (!redirectFunction) {
      throw new Error(`No redirect function found for target: ${config.target}`);
    }

    // Create CloudFront distribution
    const distribution = this.createDistribution(
      domainId,
      config.domain,
      certificate,
      redirectFunction
    );

    // Create Route 53 records
    this.createDnsRecords(domainId, config.domain, hostedZone, distribution);
  }

  /**
   * Look up the Route 53 hosted zone for a domain.
   * Walks up the domain hierarchy to find the appropriate zone, caching
   * results so multiple domains in the same zone reuse a single lookup.
   */
  private lookupHostedZone(domain: string): route53.IHostedZone {
    const hierarchy = getDomainHierarchy(domain);

    // Try each level of the domain hierarchy
    for (const zoneName of hierarchy) {
      // Check cache first
      if (this.hostedZoneCache.has(zoneName)) {
        return this.hostedZoneCache.get(zoneName)!;
      }

      // Try to look up the zone
      try {
        const zone = route53.HostedZone.fromLookup(this, `Zone${sanitizeLogicalId(zoneName)}`, {
          domainName: zoneName,
        });

        // Cache for future lookups
        this.hostedZoneCache.set(zoneName, zone);
        return zone;
      } catch {
        // Zone not found at this level, try parent
        continue;
      }
    }

    throw new Error(
      `No Route 53 hosted zone found for ${domain}. ` +
      `Please ensure a hosted zone exists for this domain or one of its parent domains.`
    );
  }

  /**
   * Create an ACM certificate for a domain.
   */
  private createCertificate(
    domainId: string,
    domain: string,
    hostedZone: route53.IHostedZone
  ): acm.ICertificate {
    return new acm.Certificate(this, `Cert${domainId}`, {
      domainName: domain,
      validation: acm.CertificateValidation.fromDns(hostedZone),
    });
  }

  /**
   * Create a CloudFront distribution for a domain.
   */
  private createDistribution(
    domainId: string,
    domain: string,
    certificate: acm.ICertificate,
    redirectFunction: cloudfront.Function
  ): cloudfront.Distribution {
    return new cloudfront.Distribution(this, `Dist${domainId}`, {
      domainNames: [domain],
      certificate,
      defaultBehavior: {
        origin: new DummyOrigin(),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        functionAssociations: [{
          function: redirectFunction,
          eventType: cloudfront.FunctionEventType.VIEWER_REQUEST,
        }],
        cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
      },
      minimumProtocolVersion: cloudfront.SecurityPolicyProtocol.TLS_V1_2_2025,
      comment: `Redirect ${domain}`,
    });
  }

  /**
   * Create Route 53 A and AAAA records for a domain.
   */
  private createDnsRecords(
    domainId: string,
    domain: string,
    hostedZone: route53.IHostedZone,
    distribution: cloudfront.Distribution
  ): void {
    // A record (IPv4)
    new route53.ARecord(this, `ARecord${domainId}`, {
      zone: hostedZone,
      recordName: domain,
      target: route53.RecordTarget.fromAlias(
        new route53Targets.CloudFrontTarget(distribution)
      ),
    });

    // AAAA record (IPv6)
    new route53.AaaaRecord(this, `AAAARecord${domainId}`, {
      zone: hostedZone,
      recordName: domain,
      target: route53.RecordTarget.fromAlias(
        new route53Targets.CloudFrontTarget(distribution)
      ),
    });
  }
}

/**
 * A dummy origin for CloudFront distributions.
 *
 * CloudFront requires an origin, but our CloudFront Function handles
 * all requests before they reach the origin. This provides a minimal
 * origin configuration that will never be reached.
 */
class DummyOrigin implements cloudfront.IOrigin {
  bind(_scope: Construct, _options: cloudfront.OriginBindOptions): cloudfront.OriginBindConfig {
    return {
      originProperty: {
        domainName: 'dummy-origin.example.com',
        id: 'dummy-origin',
        customOriginConfig: {
          originProtocolPolicy: 'https-only',
          originSslProtocols: ['TLSv1.2'],
          httpPort: 80,
          httpsPort: 443,
        },
      },
    };
  }
}

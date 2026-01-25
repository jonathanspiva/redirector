import { Construct } from 'constructs';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Properties for the RedirectFunction construct.
 */
export interface RedirectFunctionProps {
  /** Destination URL for the redirect */
  target: string;

  /** HTTP status code (301 or 302) */
  statusCode: 301 | 302;

  /** Whether to preserve the original path */
  preservePath: boolean;

  /** Whether to preserve the original query string */
  preserveQuery: boolean;
}

/**
 * Sanitize a target URL into a valid CloudFront Function name.
 *
 * Rules:
 * - Prefix with 'redirector-'
 * - Lowercase
 * - Replace non-alphanumeric characters with '-'
 * - Strip protocol and trailing slashes
 * - Truncate to 64 characters (CloudFront limit)
 */
export function sanitizeFunctionName(target: string): string {
  const sanitized = target
    .replace(/^https?:\/\//, '')  // Remove protocol
    .replace(/\/$/, '')           // Remove trailing slash
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '-')   // Replace non-alphanumeric with dash
    .replace(/-+/g, '-')          // Collapse multiple dashes
    .replace(/^-|-$/g, '');       // Remove leading/trailing dashes

  const name = `redirector-${sanitized}`;

  // CloudFront Function names are limited to 64 characters
  if (name.length <= 64) {
    return name;
  }

  // Truncate and add a simple hash suffix for uniqueness
  const hash = simpleHash(target).toString(16).substring(0, 6);
  return `${name.substring(0, 57)}-${hash}`;
}

/**
 * Simple hash function for generating unique suffixes.
 */
function simpleHash(str: string): number {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash; // Convert to 32bit integer
  }
  return Math.abs(hash);
}

/** Cached template content */
let templateCache: string | null = null;

/**
 * Load the CloudFront Function template.
 */
function loadTemplate(): string {
  if (templateCache === null) {
    const templatePath = path.join(__dirname, 'redirect-function.template.js');
    templateCache = fs.readFileSync(templatePath, 'utf-8');
  }
  return templateCache;
}

/**
 * Generate the CloudFront Function code for a redirect.
 *
 * Loads the template from redirect-function.template.js and replaces placeholders.
 * This approach provides better IDE support with syntax highlighting.
 */
export function generateFunctionCode(props: RedirectFunctionProps): string {
  const template = loadTemplate();

  return template
    .replace('{{TARGET}}', props.target)
    .replace('{{STATUS_CODE}}', String(props.statusCode))
    .replace('{{PRESERVE_PATH}}', String(props.preservePath))
    .replace('{{PRESERVE_QUERY}}', String(props.preserveQuery));
}

/**
 * A CloudFront Function that redirects requests to a target URL.
 *
 * One function is created per unique destination target. Multiple domains
 * redirecting to the same target share the same function.
 */
export class RedirectFunction extends Construct {
  /** The underlying CloudFront Function */
  public readonly function: cloudfront.Function;

  constructor(scope: Construct, id: string, props: RedirectFunctionProps) {
    super(scope, id);

    const functionName = sanitizeFunctionName(props.target);
    const code = generateFunctionCode(props);

    this.function = new cloudfront.Function(this, 'Function', {
      functionName,
      code: cloudfront.FunctionCode.fromInline(code),
      comment: `Redirect to ${props.target}`,
      runtime: cloudfront.FunctionRuntime.JS_2_0,
    });
  }
}

/**
 * CloudFront Function template for HTTP redirects.
 *
 * This is ES5-compatible JavaScript as required by CloudFront Functions.
 * The {{PLACEHOLDER}} values are replaced at CDK synthesis time.
 *
 * @see https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/functions-javascript-runtime-features.html
 */

var config = {
  target: '{{TARGET}}',
  statusCode: {{STATUS_CODE}},
  preservePath: {{PRESERVE_PATH}},
  preserveQuery: {{PRESERVE_QUERY}}
};

function handler(event) {
  var url = config.target;

  if (config.preservePath) {
    url += event.request.uri;
  }

  if (config.preserveQuery) {
    var qs = Object.keys(event.request.querystring)
      .map(function(k) {
        return k + '=' + event.request.querystring[k].value;
      })
      .join('&');
    if (qs) {
      url += '?' + qs;
    }
  }

  return {
    statusCode: config.statusCode,
    headers: {
      location: { value: url }
    }
  };
}

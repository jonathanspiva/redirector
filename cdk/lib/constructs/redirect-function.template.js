/**
 * CloudFront Function template for HTTP redirects.
 *
 * This is ES5-compatible JavaScript as required by CloudFront Functions.
 * The {{PLACEHOLDER}} values are replaced at CDK synthesis time.
 *
 * @see https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/functions-javascript-runtime-features.html
 */

var config = {
  target: {{TARGET}},
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
        var entry = event.request.querystring[k];
        // A repeated key (?a=1&a=2) exposes its extra values in multiValue.
        var values = entry.multiValue
          ? entry.multiValue.map(function(mv) { return mv.value; })
          : [entry.value];
        return values.map(function(v) { return k + '=' + v; }).join('&');
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

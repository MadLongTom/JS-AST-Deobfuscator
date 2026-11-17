'use strict';

class DeobfuscationError extends Error {
  constructor(code, message, details = {}) {
    super(message, details.cause ? { cause: details.cause } : undefined);
    this.name = 'DeobfuscationError';
    this.code = code;
    if (details.passName) this.passName = details.passName;
    if (details.location) this.location = details.location;
  }
}

module.exports = { DeobfuscationError };

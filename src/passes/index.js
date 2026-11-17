'use strict';
module.exports = [
  require('./normalize-literals'),
  require('./string-arrays'),
  require('./substituted-hex'),
  require('./normalize-statements'),
  require('./inline-constants'),
  require('./inline-aliases'),
  require('./inline-objects'),
  require('./inline-wrappers'),
  require('./constant-fold'),
  require('./neutralize-self-defense'),
  require('./control-flow'),
  require('./dead-code'),
  require('./cleanup-decoders'),
];

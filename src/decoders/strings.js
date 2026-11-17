'use strict';

// These are implementations of known encodings, not interpreters for input code.
function decodeBase64(value, alphabet, budget = () => {}, mode = 'strict') {
  if (typeof value !== 'string' || typeof alphabet !== 'string' ||
      ![64, 65].includes(alphabet.length) || new Set(alphabet.slice(0, 64)).size !== 64 ||
      alphabet.slice(0, 64).includes('=') || alphabet.length === 65 && alphabet[64] !== '=') {
    throw new Error('Invalid base64 input or alphabet');
  }
  if (mode === 'byte-loop') {
    // This known obfuscator loop ignores characters outside the alphabet, but
    // treats its 65th entry as a digit. Keep that behavior separate from the
    // usual padded base64 helper, rather than silently conflating the two.
    let count = 0, bits = 0;
    const bytes = [];
    for (let index = 0; index < value.length; index++) {
      budget();
      const digit = alphabet.indexOf(value.charAt(index));
      if (digit < 0) continue;
      bits = count % 4 ? bits * 64 + digit : digit;
      if (count++ % 4) bytes.push(255 & bits >> (-2 * count & 6));
    }
    return decodeURIComponent(bytes.map(byte => '%' + byte.toString(16).padStart(2, '0')).join(''));
  }
  if (mode !== 'strict') throw new Error('Unsupported base64 helper mode');
  let bits = 0, count = 0;
  const bytes = [];
  for (const character of value) {
    budget();
    const digit = alphabet.indexOf(character);
    if (digit === 64 || character === '=') break;
    if (digit < 0 || digit > 63) throw new Error('Invalid base64 character');
    bits = (bits << 6) | digit;
    count += 6;
    if (count >= 8) {
      count -= 8;
      bytes.push((bits >>> count) & 255);
    }
  }
  // javascript-obfuscator uses decodeURIComponent on percent-encoded bytes.
  return decodeURIComponent(bytes.map(byte => '%' + byte.toString(16).padStart(2, '0')).join(''));
}

function decodeRc4(value, key, alphabet, budget) {
  const input = decodeBase64(value, alphabet, budget);
  if (typeof key !== 'string' || key.length === 0) throw new Error('RC4 key must be a nonempty string');
  const state = Array.from({ length: 256 }, (_, index) => index);
  let j = 0;
  for (let i = 0; i < 256; i++) {
    budget();
    j = (j + state[i] + key.charCodeAt(i % key.length)) % 256;
    [state[i], state[j]] = [state[j], state[i]];
  }
  let output = '', i = 0;
  j = 0;
  for (let k = 0; k < input.length; k++) {
    budget();
    i = (i + 1) % 256;
    j = (j + state[i]) % 256;
    [state[i], state[j]] = [state[j], state[i]];
    output += String.fromCharCode(input.charCodeAt(k) ^ state[(state[i] + state[j]) % 256]);
  }
  return output;
}

module.exports = { decodeBase64, decodeRc4 };

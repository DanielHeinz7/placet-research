'use strict';

const crypto = require('node:crypto');
const { normalizeText } = require('./canvas');

// Binds an acceptance to the text it was given for (§4.4). Whitespace-
// insensitive so a reflow does not invalidate an acceptance; any wording
// change does.
function textHash(text) {
  return crypto.createHash('sha256').update(normalizeText(text), 'utf8').digest('hex').slice(0, 8);
}

module.exports = { textHash };

const core = require('shazamio-core');
const fs = require('fs');

console.log(core);
if (core.DecodedSignature) {
    console.log('DecodedSignature methods:', Object.getOwnPropertyNames(core.DecodedSignature.prototype));
}

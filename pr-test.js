const { exec } = require('child_process');
const SECRET = 'hardcoded-secret-123'; // bad
function ping(host){ exec('ping -c 1 ' + host, (e,o)=>console.log(o)); } // command injection
"
@"
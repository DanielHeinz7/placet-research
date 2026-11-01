'use strict';
// Records which hosts a program tries to reach through HTTPS_PROXY and
// refuses every request, so nothing leaves the machine during a check.
const http = require('node:http');

function startLoggingProxy() {
  const hosts = [];
  const server = http.createServer((req, res) => { hosts.push(new URL(req.url).host); res.writeHead(403); res.end(); });
  server.on('connect', (req, socket) => { hosts.push(req.url); socket.end('HTTP/1.1 403 Forbidden\r\n\r\n'); });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({
    url: `http://127.0.0.1:${server.address().port}`,
    hosts,
    close: () => new Promise((r) => { server.closeAllConnections(); server.close(r); }),
  })));
}

module.exports = { startLoggingProxy };

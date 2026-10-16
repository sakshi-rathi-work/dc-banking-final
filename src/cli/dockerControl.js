// src/cli/dockerControl.js: Docker Engine API Container Control
// Specification: PROJECT.md Section 22.2

const http = require('http');

const ALLOWED_PREFIXES = ['bank-node-', 'postgres-'];
const SOCKET_PATH = process.env.DOCKER_SOCKET || '/var/run/docker.sock';

function isAllowedContainer(containerName) {
  const clean = containerName.replace(/^\/+/, '');
  return ALLOWED_PREFIXES.some(prefix => clean.startsWith(prefix));
}

function callDockerApi(method, path) {
  return new Promise((resolve, reject) => {
    const options = {
      socketPath: SOCKET_PATH,
      path,
      method,
      headers: {
        'Content-Type': 'application/json'
      }
    };

    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          try {
            resolve(data ? JSON.parse(data) : { status: 'ok', code: res.statusCode });
          } catch (_) {
            resolve({ status: 'ok', code: res.statusCode, raw: data });
          }
        } else {
          reject(new Error(`Docker API error ${res.statusCode}: ${data || res.statusMessage}`));
        }
      });
    });

    req.on('error', (err) => {
      reject(new Error(`Failed to connect to Docker socket at ${SOCKET_PATH}: ${err.message}`));
    });

    req.end();
  });
}

async function stopContainer(name, timeoutSec = 5) {
  if (!isAllowedContainer(name)) {
    throw new Error(`Container "${name}" is not in the allow-list (must start with bank-node- or postgres-)`);
  }
  return callDockerApi('POST', `/containers/${name}/stop?t=${timeoutSec}`);
}

async function killContainer(name, signal = 'SIGKILL') {
  if (!isAllowedContainer(name)) {
    throw new Error(`Container "${name}" is not in the allow-list (must start with bank-node- or postgres-)`);
  }
  return callDockerApi('POST', `/containers/${name}/kill?signal=${signal}`);
}

async function startContainer(name) {
  if (!isAllowedContainer(name)) {
    throw new Error(`Container "${name}" is not in the allow-list (must start with bank-node- or postgres-)`);
  }
  return callDockerApi('POST', `/containers/${name}/start`);
}

async function restartContainer(name, timeoutSec = 5) {
  if (!isAllowedContainer(name)) {
    throw new Error(`Container "${name}" is not in the allow-list (must start with bank-node- or postgres-)`);
  }
  return callDockerApi('POST', `/containers/${name}/restart?t=${timeoutSec}`);
}

module.exports = {
  isAllowedContainer,
  stopContainer,
  killContainer,
  startContainer,
  restartContainer
};

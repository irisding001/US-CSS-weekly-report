#!/usr/bin/env node
// Wrapper: load .env_run then spawn run.js with those env vars
const fs = require('fs');
const { spawnSync } = require('child_process');

const envFile = __dirname + '/.env_run';
const lines = fs.readFileSync(envFile, 'utf8').split('\n');
const env = { ...process.env };
for (const line of lines) {
  const eq = line.indexOf('=');
  if (eq > 0) env[line.slice(0, eq).trim()] = line.slice(eq + 1);
}

const args = process.argv.slice(2);
const result = spawnSync('node', [__dirname + '/run.js', ...args], {
  env,
  stdio: 'inherit',
  windowsHide: true,
});
process.exit(result.status || 0);

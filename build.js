// Build: inlines the shared core into the web app and copies it to the Apps Script backend.
// Usage: node build.js
const fs = require('fs'), path = require('path');
const root = __dirname;
const core = fs.readFileSync(path.join(root, 'src/core.js'), 'utf8');
const app = fs.readFileSync(path.join(root, 'src/app.html'), 'utf8').replace('/*__CORE__*/', () => core);
fs.mkdirSync(path.join(root, 'docs/app'), { recursive: true });
fs.writeFileSync(path.join(root, 'docs/app/index.html'), app);
fs.writeFileSync(path.join(root, 'backend/Core.gs'), core);
console.log('Built docs/app/index.html and backend/Core.gs');

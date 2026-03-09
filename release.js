const fs = require('fs');

if (fs.existsSync('.env')) {
    fs.readFileSync('.env', 'utf8').split('\n').forEach(line => {
        const [k, v] = line.split('=');
        if (k && v) process.env[k.trim()] = v.trim();
    });
}

const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
const v = pkg.version.split('.');
v[2] = parseInt(v[2]) + 1;
pkg.version = v.join('.');
fs.writeFileSync('package.json', JSON.stringify(pkg, null, 2));
console.log('Version bumped to ' + pkg.version);

// Build and publish
const { execSync } = require('child_process');
execSync('npm run dist', { stdio: 'inherit', env: process.env });
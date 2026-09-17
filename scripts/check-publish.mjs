// Runs before every `npm publish` (prepublishOnly) and refuses the publish if
// the package would carry anything it should not: a file outside the known
// list, code that reads the environment, or anything shaped like a secret.
// Checked on the exact file list npm is about to upload, and on where the
// publish runs.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const ALLOWED = new Set([
	'README.md', 'LICENSE', 'index.js', 'package.json',
	'dist/credentials/BlurwerkApi.credentials.js',
	'dist/nodes/Blurwerk/Blurwerk.node.js', 'dist/nodes/Blurwerk/Blurwerk.node.json',
	'dist/nodes/Blurwerk/blurwerk.svg', 'dist/nodes/Blurwerk/client.js',
	'dist/nodes/Blurwerk/properties.js', 'dist/nodes/Blurwerk/transport.js',
	'dist/nodes/Blurwerk/BlurwerkTrigger.node.js', 'dist/nodes/Blurwerk/BlurwerkTrigger.node.json', 'dist/nodes/Blurwerk/vendor/probe.js',
	'dist/nodes/Blurwerk/vendor/probe-stream.js',
]);
const SECRETS = [
	[/\bsk_(live|test)_[A-Za-z0-9]{8,}/, 'a Stripe key'],
	[/\bwhsec_[A-Za-z0-9]{8,}/, 'a Stripe webhook secret'],
	[/\bbw_[A-Za-z0-9]{16,}/, 'a blurwerk credit token'],
	[/npm_[A-Za-z0-9]{20,}/, 'an npm token'],
	[/_authToken/, 'npm login configuration'],
	[/-----BEGIN [A-Z ]*PRIVATE KEY-----/, 'a private key'],
	[/\bprocess\.env\b/, 'code reading the environment'],
	[/\/(Users|home)\/[A-Za-z]/, 'a local home directory'],
];

const pack = JSON.parse(execFileSync('npm', ['pack', '--dry-run', '--json'], { encoding: 'utf8' }));
// npm 11 prints a list, npm 12 an object keyed by package name.
const entry = Array.isArray(pack) ? pack[0] : pack[JSON.parse(readFileSync('package.json', 'utf8')).name];
if (!entry || !Array.isArray(entry.files)) {
	console.error('Refusing to publish: could not read the file list from `npm pack --json`');
	process.exit(1);
}
const files = entry.files.map((f) => f.path);
const problems = files.filter((f) => !ALLOWED.has(f)).map((f) => `unexpected file: ${f}`);
for (const f of files) {
	const text = readFileSync(f, 'utf8');
	for (const [re, what] of SECRETS) if (re.test(text)) problems.push(`${f}: ${what}`);
}
for (const f of ALLOWED) if (!files.includes(f)) problems.push(`missing file: ${f}`);
// Only from GitHub Actions, with provenance. n8n verifies nothing else, and a
// publish from a laptop also writes that account's e-mail into the public
// version record (`_npmUser`) — which is how 0.1.0 went out with a personal
// address. From Actions the publisher recorded is GitHub's own identity.
// Reading the environment is fine HERE: this script is never packed.
if (!process.env.GITHUB_ACTIONS || process.env.NPM_CONFIG_PROVENANCE !== 'true') {
	problems.push('publish only from the GitHub workflow (npm run release there), which adds ' +
		'provenance; see integrations/README.md');
}
if (problems.length) {
	console.error('Refusing to publish:\n  ' + problems.join('\n  '));
	process.exit(1);
}
console.log(`publish check: ${files.length} files, nothing that should not be public`);

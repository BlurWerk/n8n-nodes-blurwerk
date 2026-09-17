// A whole order through the n8n node's client, against a fake blurwerk.
//
// What matters is what the SERVER sees: the extension and not the filename,
// the figures read from the file's own header, the token on the payment and
// nowhere else it is not needed, every byte of the file in the right part, and
// no order at all without both declarations.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { BlurwerkClient, BlurwerkError } = require('../dist/nodes/Blurwerk/client.js');
const { Blurwerk } = require('../dist/nodes/Blurwerk/Blurwerk.node.js');
const { BlurwerkTrigger } = require('../dist/nodes/Blurwerk/BlurwerkTrigger.node.js');

const dir = mkdtempSync(join(tmpdir(), 'bw-n8n-'));
const clip = join(dir, 'Familie Strand 2019.mp4');
execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=25',
	'-t', '3', '-pix_fmt', 'yuv420p', clip]);
const VIDEO = readFileSync(clip);
const TOKEN = 'bw_test_token';
const PART = 4096;               // small, so a 3 s clip needs several parts

let server, base, seen, polls;
const acct = { balance: 45, spent: 0 };

function reset() {
	seen = { quote: null, checkout: null, auth: [], parts: {}, complete: null, credits: null };
	polls = 0;
}

before(async () => {
	server = createServer(async (req, res) => {
		const chunks = [];
		for await (const c of req) chunks.push(c);
		const raw = Buffer.concat(chunks);
		const body = raw.length && req.headers['content-type']?.includes('json') ? JSON.parse(raw) : null;
		const send = (status, obj, headers = {}) => {
			res.writeHead(status, { 'content-type': 'application/json', ...headers });
			res.end(JSON.stringify(obj));
		};
		const url = new URL(req.url, base);
		seen.auth.push([url.pathname, req.headers.authorization || '']);
		if (url.pathname === '/api/quote') {
			seen.quote = body;
			return send(200, { job: { id: 'j1', state: 'quoted', quote: { total: 5, units: 1 } } });
		}
		if (url.pathname === '/api/job/j1/checkout') {
			seen.checkout = body;
			if (req.headers.authorization !== `Bearer ${TOKEN}`) return send(401, { error: 'unknown token' });
			return send(200, { provider: 'credits', paid: true, charged: 5, balance: 45 });
		}
		if (url.pathname === '/api/job/j1/upload/start')
			return send(200, { upload_id: 'u1', part_size: PART, max_parts: 10000 });
		if (url.pathname === '/api/job/j1/upload/sign')
			return send(200, { parts: Object.fromEntries(body.parts.map((n) => [n, `${base}/part/${n}`])) });
		if (url.pathname.startsWith('/part/')) {
			const n = Number(url.pathname.split('/')[2]);
			seen.parts[n] = raw;
			res.writeHead(200, { etag: `"e${n}"` });
			return res.end();
		}
		if (url.pathname === '/api/job/j1/upload/complete') {
			seen.complete = body;
			return send(200, { job: { id: 'j1', state: 'uploaded' } });
		}
		if (url.pathname === '/api/job/j1') {
			polls++;
			if (polls < 3) return send(200, { job: { id: 'j1', state: 'processing' } });
			return send(200, { job: { id: 'j1', state: 'done' }, download_url: `${base}/dl/abc123.mp4`,
				expires_in: 604800 });
		}
		if (url.pathname === '/dl/abc123.mp4') {
			res.writeHead(200, { 'content-type': 'video/mp4' });
			return res.end(Buffer.from('ANONYMIZED'));
		}
		if (url.pathname === '/api/credits/balance') {
			if (req.headers.authorization !== `Bearer ${TOKEN}`) return send(401, { error: 'unknown token' });
			return send(200, { ...acct, currency: 'EUR' });
		}
		if (url.pathname === '/api/credits' && req.method === 'POST') {
			seen.credits = { body, auth: req.headers.authorization };
			return send(200, { url: 'https://checkout.stripe.test/cs_7', reference: 'cs_7',
				amount: body.amount, currency: 'EUR', top_up: true });
		}
		send(404, { error: 'no such route' });
	});
	await new Promise((r) => server.listen(0, '127.0.0.1', r));
	base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

const http = async (req) => {
	const r = await fetch(req.url, {
		method: req.method,
		headers: { ...(req.headers || {}), ...(req.json !== undefined ? { 'content-type': 'application/json' } : {}) },
		body: req.raw ?? (req.json !== undefined ? JSON.stringify(req.json) : undefined),
	});
	const headers = Object.fromEntries(r.headers.entries());
	const body = req.binary ? Buffer.from(await r.arrayBuffer())
		: (headers['content-type'] || '').includes('json') ? await r.json() : await r.text();
	return { status: r.status, headers, body };
};
const nap = async () => {};
const OPTS = { audio: 'robot', faces: true, sensitivity: 'medium', coverage: 'large', lang: 'de' };

test('a whole order: measured, quoted, paid, uploaded in parts', async () => {
	reset();
	const api = new BlurwerkClient(http, base + '/', TOKEN, nap);
	const out = await api.order({ file: VIDEO, fileName: 'Familie Strand 2019.mp4', options: OPTS,
		consentWithdrawal: true, consentCheck: true, email: 'a@example.com' });
	assert.equal(out.jobId, 'j1');
	assert.equal(out.measured, true, 'the header was read');
	const q = seen.quote;
	assert.equal(q.ext, '.mp4');
	assert.ok(!JSON.stringify(q).includes('Strand'), 'the filename never leaves the machine');
	assert.deepEqual([q.width, q.height, q.fps], [320, 240, 25]);
	assert.ok(Math.abs(q.duration_s - 3) < 0.1, `duration read from the file (${q.duration_s})`);
	assert.equal(q.size_bytes, VIDEO.length);
	assert.equal(q.stated, false);
	assert.equal(q.audio, 'robot');
	assert.equal(q.plates, false, 'plates are not sold yet');
	assert.deepEqual(seen.checkout, { provider: 'credits', withdrawal_consent: true,
		check_before_publish: true, lang: 'de', email: 'a@example.com' });
	const partCount = Math.ceil(VIDEO.length / PART);
	assert.ok(partCount > 1, 'the clip needs more than one part');
	assert.deepEqual(Buffer.concat(Object.keys(seen.parts).sort((a, b) => a - b).map((n) => seen.parts[n])), VIDEO,
		'every byte arrives, in order');
	assert.deepEqual(seen.complete.parts.map((p) => p.PartNumber), [...Array(partCount)].map((_, i) => i + 1));
	assert.equal(seen.complete.parts[0].ETag, '"e1"');
	const authed = seen.auth.filter(([, a]) => a).map(([p]) => p);
	assert.deepEqual(authed, ['/api/job/j1/checkout'], 'the token goes only where it is needed');
});

test('no order without both declarations, and nothing is sent', async () => {
	reset();
	const api = new BlurwerkClient(http, base, TOKEN, nap);
	for (const [w, c] of [[false, true], [true, false]]) {
		await assert.rejects(api.order({ file: VIDEO, fileName: 'x.mp4', options: OPTS,
			consentWithdrawal: w, consentCheck: c }), /declarations are required/);
	}
	assert.equal(seen.quote, null);
});

test('an unreadable file needs stated figures, and says so', async () => {
	reset();
	const api = new BlurwerkClient(http, base, TOKEN, nap);
	const junk = Buffer.from('not a video at all, not even close to one');
	await assert.rejects(api.order({ file: junk, fileName: 'x.mov', options: OPTS,
		consentWithdrawal: true, consentCheck: true }), /File Details/);
	assert.equal(seen.quote, null, 'nothing was quoted on a guess');
	await api.order({ file: junk, fileName: 'x.mov', options: OPTS, consentWithdrawal: true,
		consentCheck: true, stated: { duration: 60, width: 1920, height: 1080 } });
	assert.deepEqual([seen.quote.duration_s, seen.quote.width, seen.quote.fps, seen.quote.stated],
		[60, 1920, 25, true]);
	assert.equal(seen.quote.ext, '.mov');
});

test("the server's refusal is surfaced with its status and words", async () => {
	reset();
	const api = new BlurwerkClient(http, base, 'bw_wrong', nap);
	await assert.rejects(api.order({ file: VIDEO, fileName: 'x.mp4', options: OPTS,
		consentWithdrawal: true, consentCheck: true }), (e) =>
		e instanceof BlurwerkError && e.status === 401 && /unknown token/.test(e.message));
	assert.deepEqual(seen.parts, {}, 'nothing is uploaded for an unpaid job');
});

test('waiting: polls until done, or gives up on time', async () => {
	reset();
	const api = new BlurwerkClient(http, base, TOKEN, nap);
	const done = await api.waitFor('j1', 60_000, 1);
	assert.equal(done.job.state, 'done');
	assert.equal(polls, 3);
	reset();
	assert.equal(await api.waitFor('j1', 0, 10), null, 'a wait shorter than one poll gives up');
	assert.equal((await api.download(`${base}/dl/abc123.mp4`)).toString(), 'ANONYMIZED');
});

// --- the node itself, with a stand-in for n8n's execution context ------------
function context(params, binary) {
	const out = {};
	return {
		out,
		getInputData: () => [{ json: {}, binary: { data: binary } }],
		getNodeParameter: (name, _i, fallback) => (name in params ? params[name] : fallback),
		getCredentials: async () => ({ token: TOKEN, baseUrl: base }),
		continueOnFail: () => false,
		getNode: () => ({ name: 'blurwerk', type: 'blurwerk', typeVersion: 1 }),
		helpers: {
			assertBinaryData: () => binary,
			getBinaryDataBuffer: async () => VIDEO,
			prepareBinaryData: async (buf, name) => ({ data: buf.toString('base64'), fileName: name }),
			httpRequest: async (o) => {
				const r = await http({ method: o.method, url: o.url, headers: o.headers,
					json: o.json && o.body !== undefined ? o.body : undefined,
					raw: Buffer.isBuffer(o.body) ? o.body : undefined, binary: o.encoding === 'arraybuffer' });
				return { statusCode: r.status, headers: r.headers, body: r.body };
			},
		},
	};
}

test('the node: anonymize, wait, and hand back the video', async () => {
	reset();
	const ctx = context({ operation: 'anonymize', binaryPropertyName: 'data', consentWithdrawal: true,
		consentCheck: true, wait: true, maxWait: 1, pollEvery: 0, download: true,
		options: { audio: 'mute' } }, { fileName: 'Familie Strand 2019.mp4' });
	const [[item]] = await new Blurwerk().execute.call(ctx);
	assert.equal(item.json.jobId, 'j1');
	assert.equal(item.json.state, 'done');
	assert.equal(Buffer.from(item.binary.data.data, 'base64').toString(), 'ANONYMIZED');
	assert.equal(item.binary.data.fileName, 'Familie Strand 2019_anonymized.mp4',
		'the result keeps its name locally; the server never had it');
	assert.equal(seen.quote.audio, 'mute');
	assert.equal(seen.quote.sensitivity, 'medium', 'unset options are the documented defaults');
});

test('the node: balance, and a failing item stops the run unless told otherwise', async () => {
	reset();
	const [[bal]] = await new Blurwerk().execute.call(context({ operation: 'balance' }, {}));
	assert.equal(bal.json.balance, 45);
	const bad = context({ operation: 'anonymize', binaryPropertyName: 'data', consentWithdrawal: false,
		consentCheck: true, wait: false }, { fileName: 'x.mp4' });
	await assert.rejects(new Blurwerk().execute.call(bad), /declarations are required/);
	bad.continueOnFail = () => true;
	const [[err]] = await new Blurwerk().execute.call(bad);
	assert.match(err.json.error, /declarations are required/);
});

test('without a wait passed in, the client waits with n8n\'s own helper', async () => {
	// Every other test passes `nap`; this is the default the node itself uses.
	reset();
	const api = new BlurwerkClient(http, base, TOKEN);
	const started = Date.now();
	const s = await api.waitFor('j1', 10_000, 40);
	assert.equal(s.job.state, 'done');
	assert.ok(Date.now() - started >= 70, 'it really waited between polls');
});

test('the node: a top-up link for the token in the credential', async () => {
	reset();
	const [[item]] = await new Blurwerk().execute.call(
		context({ operation: 'topUp', topUpAmount: 50, receiptEmail: 'pay@example.com' }, {}));
	assert.deepEqual([item.json.url, item.json.top_up], ['https://checkout.stripe.test/cs_7', true]);
	assert.deepEqual(seen.credits, { body: { amount: 50, email: 'pay@example.com' }, auth: `Bearer ${TOKEN}` },
		'the token names what is topped up, and the amount is a number');
});

// --- the trigger: once per low spell ---------------------------------------------
function pollContext(threshold, mode = 'trigger', store = {}) {
	return {
		store,
		getMode: () => mode,
		getWorkflowStaticData: () => store,
		getNodeParameter: (name, fallback) => (name === 'threshold' ? threshold : fallback),
		getCredentials: async () => ({ token: TOKEN, baseUrl: base }),
		helpers: context({}, {}).helpers,
	};
}

test('credit running low: fires once per low spell, and again after a top-up', async () => {
	const store = {};
	const poll = () => new BlurwerkTrigger().poll.call(pollContext(10, 'trigger', store));
	Object.assign(acct, { balance: 45, spent: 0 });
	assert.equal(await poll(), null, 'plenty of credit: nothing');
	Object.assign(acct, { balance: 8, spent: 37 });
	const fired = await poll();
	assert.deepEqual([fired[0][0].json.balance, fired[0][0].json.low, fired[0][0].json.threshold], [8, true, 10]);
	assert.equal(await poll(), null, 'still low: not again');
	Object.assign(acct, { balance: 3, spent: 42 });
	assert.equal(await poll(), null, 'spending further in the same spell: not again');
	Object.assign(acct, { balance: 53, spent: 42 });
	assert.equal(await poll(), null, 'topped up: nothing');
	Object.assign(acct, { balance: 5, spent: 90 });
	assert.ok(await poll(), 'low again after the top-up: fires');
	assert.equal(await poll(), null);
	Object.assign(acct, { balance: 45, spent: 0 });
});

test('credit running low: a manual test shows the balance, low or not', async () => {
	const [[item]] = await new BlurwerkTrigger().poll.call(pollContext(10, 'manual'));
	assert.deepEqual([item.json.balance, item.json.low], [45, false]);
	const store = {};
	await new BlurwerkTrigger().poll.call(pollContext(100, 'manual', store));
	assert.deepEqual(store, {}, 'and does not use up the next real alert');
});

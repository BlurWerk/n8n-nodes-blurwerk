/* The whole order, as the API guide (docs/API.md) describes it, with no n8n in it.

   Kept apart from the node so it can be driven against a fake server in a
   plain `node --test` run: the node only turns n8n parameters into a call
   here and the result back into items.

   The file is priced from its own header, read locally by the same parser the
   website uses (vendor/probe.js, copied from web/static — a test fails if the
   copies drift). Nothing is uploaded to price a job, and the server measures
   the file again on arrival: cheaper refunds the difference to the token,
   dearer is refused and refunded whole. */

import { sleep as pause } from 'n8n-workflow';

export interface HttpRequest {
	method: 'GET' | 'POST' | 'PUT';
	url: string;
	headers?: Record<string, string>;
	json?: unknown;
	raw?: Buffer;
	binary?: boolean;
}

export interface HttpResponse {
	status: number;
	headers: Record<string, string>;
	body: unknown;
}

/* What the API returns, as far as this client reads it (docs/API.md). The
   rest of each object is passed on to the workflow untouched. */
export type ApiObject = Record<string, unknown>;
interface Quoted { job: { id: string; quote: ApiObject } }
interface Paid { charged: number; balance: number }
interface UploadStart { upload_id: string; part_size: number; max_parts: number }
interface Signed { parts: Record<string, string> }
export interface JobStatus extends ApiObject {
	job?: ApiObject & { state?: string };
	expired?: boolean;
}

export type Http = (req: HttpRequest) => Promise<HttpResponse>;

export interface Meta {
	duration: number;
	width: number;
	height: number;
	fps: number;
}

export interface Options {
	audio: 'keep' | 'mute' | 'robot';
	faces: boolean;
	sensitivity: 'low' | 'medium' | 'high';
	coverage: 'small' | 'medium' | 'large';
	lang: 'de' | 'en';
}

export interface OrderInput {
	file: Buffer;
	fileName: string;
	options: Options;
	consentWithdrawal: boolean;
	consentCheck: boolean;
	email?: string;
	stated?: Partial<Meta>;
}

export class BlurwerkError extends Error {
	constructor(
		message: string,
		public status = 0,
	) {
		super(message);
	}
}

// vendor.mjs writes the parser's declaration beside it.
import PROBE from './vendor/probe.js';

export class BlurwerkClient {
	constructor(
		private http: Http,
		private base: string,
		private token = '',
		private sleep: (ms: number) => Promise<void> = pause,
	) {
		this.base = base.replace(/\/+$/, '');
	}

	private async call<T = ApiObject>(method: 'GET' | 'POST', path: string, json?: unknown,
		auth = false): Promise<T> {
		const headers: Record<string, string> = { Accept: 'application/json' };
		if (auth) headers.Authorization = `Bearer ${this.token}`;
		const res = await this.http({ method, url: this.base + path, headers, json });
		if (res.status >= 400) {
			const body = res.body as { error?: string; detail?: string } | null;
			const said = body && (body.error || body.detail);
			throw new BlurwerkError(`${method} ${path}: ${res.status} ${said || ''}`.trim(), res.status);
		}
		return res.body as T;
	}

	/** Duration, size and framerate from the file's own header, or null. */
	static async probe(file: Buffer): Promise<Meta | null> {
		// A cast, not a copy: Node's Blob takes the Buffer as-is, and copying a
		// multi-gigabyte video to satisfy a type would double the memory.
		const blob = new Blob([file as unknown as ArrayBuffer]);
		try {
			return await PROBE.read(blob);
		} catch {
			return null;
		}
	}

	static extension(name: string): string {
		const m = /\.[A-Za-z0-9]{1,5}$/.exec(name || '');
		return m ? m[0].toLowerCase() : '.mp4';
	}

	async quote(meta: Meta, options: Options, ext: string, size: number, stated: boolean) {
		// The extension only — a filename is the customer's word for their own
		// footage and is never sent (docs/API.md § 2).
		return this.call<Quoted>('POST', '/api/quote', {
			ext,
			duration_s: meta.duration,
			width: meta.width,
			height: meta.height,
			fps: meta.fps,
			size_bytes: size,
			stated,
			...options,
			plates: false,
		});
	}

	async balance() {
		return this.call('GET', '/api/credits/balance', undefined, true);
	}

	async status(jobId: string) {
		return this.call<JobStatus>('GET', `/api/job/${encodeURIComponent(jobId)}`);
	}

	async reportProblem(jobId: string, reason: string, email: string) {
		return this.call('POST', `/api/job/${encodeURIComponent(jobId)}/problem`, { reason, email });
	}

	/** Measure, quote, pay with credit and upload. Returns the paid job. */
	async order(input: OrderInput) {
		if (!input.consentWithdrawal || !input.consentCheck) {
			throw new BlurwerkError(
				'Both declarations are required: that work may start at once (German Civil Code, § 356(4)) ' +
					'and that the result will be checked before it is published.',
			);
		}
		if (!this.token) throw new BlurwerkError('No API token: buy credit at https://blurwerk.de/credit');
		const read = await BlurwerkClient.probe(input.file);
		const stated = input.stated || {};
		const meta = read || {
			duration: Number(stated.duration),
			width: Number(stated.width),
			height: Number(stated.height),
			fps: Number(stated.fps) || 25,
		};
		if (!(meta.duration > 0 && meta.width > 0 && meta.height > 0)) {
			throw new BlurwerkError(
				'Could not read duration and size from this file. Set them under ' +
					'"File Details" — the server measures the file again and refunds any difference.',
			);
		}
		const q = await this.quote(meta, input.options, BlurwerkClient.extension(input.fileName),
			input.file.length, !read);
		const jobId: string = q.job.id;
		const paid = await this.call<Paid>('POST', `/api/job/${jobId}/checkout`, {
			provider: 'credits',
			withdrawal_consent: true,
			check_before_publish: true,
			lang: input.options.lang,
			email: input.email || '',
		}, true);
		await this.upload(jobId, input.file);
		return { jobId, quote: q.job.quote, charged: paid.charged, balance: paid.balance, measured: !!read };
	}

	/** Multipart, straight to object storage (docs/API.md § 4). */
	async upload(jobId: string, file: Buffer) {
		const start = await this.call<UploadStart>('POST', `/api/job/${jobId}/upload/start`);
		const size: number = start.part_size;
		const count = Math.max(1, Math.ceil(file.length / size));
		if (count > start.max_parts) throw new BlurwerkError('file is too large for one order');
		const etags: { PartNumber: number; ETag: string }[] = [];
		for (let first = 1; first <= count; first += 10) {
			const numbers = Array.from({ length: Math.min(10, count - first + 1) }, (_, i) => first + i);
			const signed = await this.call<Signed>('POST', `/api/job/${jobId}/upload/sign`, {
				upload_id: start.upload_id,
				parts: numbers,
			});
			for (const n of numbers) {
				const chunk = file.subarray((n - 1) * size, n * size);
				etags.push({ PartNumber: n, ETag: await this.putPart(signed.parts[String(n)], chunk) });
			}
		}
		return this.call('POST', `/api/job/${jobId}/upload/complete`, {
			upload_id: start.upload_id,
			parts: etags,
		});
	}

	private async putPart(url: string, chunk: Buffer, tries = 3): Promise<string> {
		for (let attempt = 1; ; attempt++) {
			const res = await this.http({ method: 'PUT', url, raw: chunk });
			const etag = res.headers.etag || res.headers.ETag;
			if (res.status < 300 && etag) return etag;
			if (attempt >= tries) throw new BlurwerkError(`part upload failed (${res.status})`, res.status);
			await this.sleep(1000 * attempt);
		}
	}

	/** Poll until done or failed; null if `maxWaitMs` passes first. */
	async waitFor(jobId: string, maxWaitMs: number, everyMs: number) {
		const until = Date.now() + maxWaitMs;
		for (;;) {
			const s = await this.status(jobId);
			const state = s.job && s.job.state;
			if (state === 'done' || state === 'failed' || s.expired) return s;
			if (Date.now() + everyMs > until) return null;
			await this.sleep(everyMs);
		}
	}

	async download(url: string): Promise<Buffer> {
		const res = await this.http({ method: 'GET', url, binary: true });
		if (res.status >= 400) throw new BlurwerkError(`download failed (${res.status})`, res.status);
		return Buffer.from(res.body as ArrayBuffer);
	}
}

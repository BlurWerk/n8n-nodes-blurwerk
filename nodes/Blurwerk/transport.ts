import type { IDataObject, IHttpRequestOptions } from 'n8n-workflow';

import type { Http } from './client';

/** Anything with n8n's request helper: an action's context or a trigger's. */
export interface HasHttp {
	helpers: { httpRequest(options: IHttpRequestOptions): Promise<unknown> };
}

// n8n's own request helper, so the instance's proxy and TLS settings apply.
export function httpFor(ctx: HasHttp): Http {
	return async (req) => {
		const options: IHttpRequestOptions = {
			method: req.method,
			url: req.url,
			headers: req.headers,
			returnFullResponse: true,
			ignoreHttpStatusErrors: true,
			json: !req.raw && !req.binary,
		};
		if (req.json !== undefined) options.body = req.json as IDataObject;
		if (req.raw) options.body = req.raw;
		if (req.binary) options.encoding = 'arraybuffer';
		const res = (await ctx.helpers.httpRequest(options)) as {
			statusCode: number;
			headers: Record<string, string>;
			body: unknown;
		};
		return { status: res.statusCode, headers: res.headers || {}, body: res.body };
	};
}

import type {
	IDataObject,
	IExecuteFunctions,
	INodeExecutionData,
	INodeType,
	INodeTypeDescription,
} from 'n8n-workflow';
import { NodeApiError, NodeConnectionTypes, NodeOperationError } from 'n8n-workflow';

import { BlurwerkClient, BlurwerkError, type Options } from './client';
import { properties } from './properties';
import { httpFor } from './transport';

// A finished job becomes an item carrying the video, when there is one.
async function finish(ctx: IExecuteFunctions, api: BlurwerkClient, jobId: string,
	s: IDataObject, i: number, sourceName?: string): Promise<INodeExecutionData> {
	const job = (s.job || {}) as IDataObject;
	const json: IDataObject = {
		jobId, state: job.state, expiresIn: s.expires_in, expired: !!s.expired,
		voice: job.voice, error: job.error,
	};
	const item: INodeExecutionData = { json, pairedItem: i };
	const url = s.download_url as string | undefined;
	if (url && (ctx.getNodeParameter('download', i, true) as boolean)) {
		const video = await api.download(url);
		const ext = BlurwerkClient.extension(new URL(url).pathname);
		const name = `${(sourceName || jobId).replace(/\.[^.]+$/, '')}_anonymized${ext}`;
		item.binary = { data: await ctx.helpers.prepareBinaryData(video, name) };
	} else if (url) {
		json.downloadUrl = url;
	}
	return item;
}

async function anonymize(ctx: IExecuteFunctions, api: BlurwerkClient, i: number) {
	const prop = ctx.getNodeParameter('binaryPropertyName', i) as string;
	const binary = ctx.helpers.assertBinaryData(i, prop);
	const file = await ctx.helpers.getBinaryDataBuffer(i, prop);
	const opts = ctx.getNodeParameter('options', i, {}) as IDataObject;
	const details = ctx.getNodeParameter('fileDetails', i, {}) as IDataObject;
	const options: Options = {
		audio: (opts.audio as Options['audio']) || 'keep',
		faces: true,
		sensitivity: (opts.sensitivity as Options['sensitivity']) || 'medium',
		coverage: (opts.coverage as Options['coverage']) || 'medium',
		lang: (opts.lang as Options['lang']) || 'en',
	};
	const placed = await api.order({
		file,
		fileName: binary.fileName || 'video.mp4',
		options,
		consentWithdrawal: ctx.getNodeParameter('consentWithdrawal', i) as boolean,
		consentCheck: ctx.getNodeParameter('consentCheck', i) as boolean,
		email: (opts.email as string) || '',
		stated: {
			duration: details.duration as number,
			width: details.width as number,
			height: details.height as number,
			fps: details.fps as number,
		},
	});
	const wait = ctx.getNodeParameter('wait', i) as boolean;
	if (!wait) return { json: { ...placed, state: 'uploaded' }, pairedItem: i };
	const done = await api.waitFor(placed.jobId,
		(ctx.getNodeParameter('maxWait', i) as number) * 60_000,
		(ctx.getNodeParameter('pollEvery', i) as number) * 1000);
	if (!done) {
		return { json: { ...placed, state: 'processing',
			note: 'Still processing. Fetch it later with the "Get Result" operation.' }, pairedItem: i };
	}
	const item = await finish(ctx, api, placed.jobId, done as IDataObject, i, binary.fileName);
	item.json = { ...placed, ...item.json };
	return item;
}

export class Blurwerk implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'blurwerk',
		name: 'blurwerk',
		icon: 'file:blurwerk.svg',
		group: ['transform'],
		version: 1,
		subtitle: '={{$parameter["operation"]}}',
		description:
			'Anonymize video: every face mosaiced, voices disguised or muted, metadata removed. Processed in Germany.',
		defaults: { name: 'blurwerk' },
		inputs: [NodeConnectionTypes.Main],
		outputs: [NodeConnectionTypes.Main],
		usableAsTool: true,
		credentials: [{ name: 'blurwerkApi', required: true }],
		properties,
	};

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const items = this.getInputData();
		const out: INodeExecutionData[] = [];
		const creds = await this.getCredentials('blurwerkApi');
		const api = new BlurwerkClient(httpFor(this),
			String(creds.baseUrl || 'https://blurwerk.de'), String(creds.token || ''));

		for (let i = 0; i < items.length; i++) {
			try {
				const op = this.getNodeParameter('operation', i) as string;
				if (op === 'balance') {
					out.push({ json: (await api.balance()) as IDataObject, pairedItem: i });
				} else if (op === 'topUp') {
					out.push({
						json: (await api.topUpLink(this.getNodeParameter('topUpAmount', i) as number,
							this.getNodeParameter('receiptEmail', i, '') as string)) as IDataObject,
						pairedItem: i,
					});
				} else if (op === 'status') {
					const jobId = this.getNodeParameter('jobId', i) as string;
					out.push(await finish(this, api, jobId, (await api.status(jobId)) as IDataObject, i));
				} else if (op === 'problem') {
					out.push({
						json: (await api.reportProblem(this.getNodeParameter('jobId', i) as string,
							this.getNodeParameter('reason', i) as string,
							this.getNodeParameter('email', i) as string)) as IDataObject,
						pairedItem: i,
					});
				} else {
					out.push(await anonymize(this, api, i));
				}
			} catch (error) {
				if (this.continueOnFail()) {
					out.push({ json: { error: (error as Error).message }, pairedItem: i });
					continue;
				}
				if (error instanceof BlurwerkError && error.status) {
					throw new NodeApiError(this.getNode(), { message: error.message },
						{ httpCode: String(error.status), itemIndex: i });
				}
				throw new NodeOperationError(this.getNode(), error as Error, { itemIndex: i });
			}
		}
		return [out];
	}
}

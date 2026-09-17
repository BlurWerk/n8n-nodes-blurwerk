import type {
	IDataObject,
	INodeExecutionData,
	INodeType,
	INodeTypeDescription,
	IPollFunctions,
} from 'n8n-workflow';
import { NodeConnectionTypes } from 'n8n-workflow';

import { BlurwerkClient } from './client';
import { httpFor } from './transport';

/* Polls the token's balance and starts the workflow when it falls below a
   threshold — once per low spell, not once per poll.

   "Once" is keyed on what the token has ever been credited: balance + spent.
   Spending moves money between the two and a refund moves it back, so the sum
   changes only when credit is BOUGHT. After a top-up the next low spell fires
   again; until then, however many polls see the low balance, it fires once. */
export class BlurwerkTrigger implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'blurwerk Trigger',
		name: 'blurwerkTrigger',
		icon: 'file:blurwerk.svg',
		group: ['trigger'],
		version: 1,
		subtitle: '={{"Credit below " + $parameter["threshold"] + " EUR"}}',
		description: 'Starts the workflow when blurwerk credit runs low',
		defaults: { name: 'blurwerk Trigger' },
		polling: true,
		inputs: [],
		outputs: [NodeConnectionTypes.Main],
		credentials: [{ name: 'blurwerkApi', required: true }],
		properties: [
			{
				displayName: 'Event',
				name: 'event',
				type: 'options',
				noDataExpression: true,
				default: 'creditLow',
				options: [
					{
						name: 'Credit Running Low',
						value: 'creditLow',
						description: 'Once each time the balance falls below the threshold, until credit is added',
					},
				],
			},
			{
				displayName: 'Threshold (EUR)',
				name: 'threshold',
				type: 'number',
				default: 10,
				typeOptions: { minValue: 0 },
				description: 'Start the workflow when the balance is below this amount',
			},
		],
	};

	async poll(this: IPollFunctions): Promise<INodeExecutionData[][] | null> {
		const creds = await this.getCredentials('blurwerkApi');
		const api = new BlurwerkClient(httpFor(this),
			String(creds.baseUrl || 'https://blurwerk.de'), String(creds.token || ''));
		const b = (await api.balance()) as IDataObject;
		const balance = Number(b.balance);
		const threshold = this.getNodeParameter('threshold', 10) as number;
		const credited = Math.round((balance + Number(b.spent || 0)) * 100);
		const item = { ...b, threshold, low: balance < threshold };
		// A manual test shows the current state whatever it is.
		if (this.getMode() === 'manual') return [[{ json: item }]];
		const state = this.getWorkflowStaticData('node');
		if (!item.low || state.firedFor === credited) return null;
		state.firedFor = credited;
		return [[{ json: item }]];
	}
}

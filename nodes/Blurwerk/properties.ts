import type { INodeProperties } from 'n8n-workflow';

const on = (...operation: string[]) => ({ displayOptions: { show: { operation } } });

export const properties: INodeProperties[] = [
	{
		displayName: 'Operation',
		name: 'operation',
		type: 'options',
		noDataExpression: true,
		default: 'anonymize',
		options: [
			{ name: 'Anonymize Video', value: 'anonymize', action: 'Anonymize a video',
				description: 'Mosaic every face, optionally disguise or mute voices, and return the file' },
			{ name: 'Get Result', value: 'status', action: 'Get the result of a job',
				description: 'State of an order, and the anonymized video once it is done' },
			{ name: 'Get Balance', value: 'balance', action: 'Get the credit balance' },
			{ name: 'Report Problem', value: 'problem', action: 'Report a problem and get a refund',
				description: 'A delivered result that is not usable is refunded and deleted' },
		],
	},

	// --- anonymize -----------------------------------------------------------
	{
		displayName: 'Input Binary Field',
		name: 'binaryPropertyName',
		type: 'string',
		default: 'data',
		required: true,
		hint: 'The video to anonymize. Its filename is never sent — only the extension.',
		...on('anonymize'),
	},
	{
		displayName: 'Work May Start Immediately',
		name: 'consentWithdrawal',
		type: 'boolean',
		default: false,
		required: true,
		description:
			'Whether the person you act for asked for work to begin at once and accepts losing the 14-day right of withdrawal (German Civil Code, § 356(4)). Required.',
		...on('anonymize'),
	},
	{
		displayName: 'Result Will Be Checked Before Publishing',
		name: 'consentCheck',
		type: 'boolean',
		default: false,
		required: true,
		description:
			'Whether the result will be looked at before it is published. Detection is automatic and no rate is guaranteed; an unusable result is refunded. Required.',
		...on('anonymize'),
	},
	{
		displayName: 'Wait for Result',
		name: 'wait',
		type: 'boolean',
		default: true,
		description:
			'Whether to wait until the video is done and output it. Processing takes about twice the video length at 1080p and about eleven times at 4K.',
		...on('anonymize'),
	},
	{
		displayName: 'Max Wait (Minutes)',
		name: 'maxWait',
		type: 'number',
		default: 120,
		typeOptions: { minValue: 1 },
		displayOptions: { show: { operation: ['anonymize'], wait: [true] } },
	},
	{
		displayName: 'Poll Every (Seconds)',
		name: 'pollEvery',
		type: 'number',
		default: 30,
		typeOptions: { minValue: 5 },
		displayOptions: { show: { operation: ['anonymize'], wait: [true] } },
	},
	{
		displayName: 'Options',
		name: 'options',
		type: 'collection',
		placeholder: 'Add Option',
		default: {},
		...on('anonymize'),
		options: [
			{
				displayName: 'Audio',
				name: 'audio',
				type: 'options',
				default: 'keep',
				options: [
					{ name: 'Keep Original', value: 'keep', description: 'Speakers stay recognisable. Free.' },
					{ name: 'Disguise Voice', value: 'robot',
						description: 'Pitch-shifted: words stay clear, the speaker does not. Can add units.' },
					{ name: 'Mute', value: 'mute', description: 'Removes the audio track. Free.' },
				],
			},
			{
				displayName: 'E-Mail for the Download Link',
				name: 'email',
				type: 'string',
				placeholder: 'name@email.com',
				default: '',
			},
			{
				displayName: 'Language',
				name: 'lang',
				type: 'options',
				default: 'en',
				options: [
					{ name: 'English', value: 'en' },
					{ name: 'German', value: 'de' },
				],
			},
			{
				displayName: 'Mosaic Size',
				name: 'coverage',
				type: 'options',
				default: 'medium',
				options: [
					{ name: 'Tight', value: 'small' },
					{ name: 'Normal', value: 'medium' },
					{ name: 'Generous', value: 'large' },
				],
			},
			{
				displayName: 'Sensitivity',
				name: 'sensitivity',
				type: 'options',
				default: 'medium',
				options: [
					{ name: 'Confirmed Only', value: 'low', description: 'Two of three detectors must agree' },
					{ name: 'Balanced', value: 'medium', description: 'Two agree, or one is sure' },
					{ name: 'Everything', value: 'high', description: 'Any detector that sees a face' },
				],
			},
		],
	},
	{
		displayName: 'File Details',
		name: 'fileDetails',
		type: 'collection',
		placeholder: 'Add Detail',
		default: {},
		description:
			"Only needed when the file's header cannot be read. The server measures the file again: cheaper is refunded, dearer is refused and refunded.",
		...on('anonymize'),
		options: [
			{ displayName: 'Duration (Seconds)', name: 'duration', type: 'number', default: 0 },
			{ displayName: 'Width (Px)', name: 'width', type: 'number', default: 0 },
			{ displayName: 'Height (Px)', name: 'height', type: 'number', default: 0 },
			{ displayName: 'Frames per Second', name: 'fps', type: 'number', default: 25 },
		],
	},

	// --- result / problem ----------------------------------------------------
	{
		displayName: 'Job ID',
		name: 'jobId',
		type: 'string',
		default: '',
		required: true,
		...on('status', 'problem'),
	},
	{
		displayName: 'Download Video',
		name: 'download',
		type: 'boolean',
		default: true,
		description: 'Whether to output the finished video as binary data, rather than only its link',
		displayOptions: { show: { operation: ['status', 'anonymize'] } },
	},
	{
		displayName: 'Reason',
		name: 'reason',
		type: 'string',
		typeOptions: { rows: 3 },
		default: '',
		required: true,
		...on('problem'),
	},
	{
		displayName: 'E-Mail on the Order',
		name: 'email',
		type: 'string',
		placeholder: 'name@email.com',
		default: '',
		required: true,
		...on('problem'),
	},
];

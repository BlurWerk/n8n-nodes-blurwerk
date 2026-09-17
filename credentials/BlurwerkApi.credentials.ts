import type {
	IAuthenticateGeneric,
	ICredentialTestRequest,
	ICredentialType,
	INodeProperties,
} from 'n8n-workflow';

export class BlurwerkApi implements ICredentialType {
	name = 'blurwerkApi';

	displayName = 'Blurwerk API';

	icon = 'file:../nodes/Blurwerk/blurwerk.svg' as const;

	documentationUrl = 'https://blurwerk.de/docs';

	properties: INodeProperties[] = [
		{
			displayName: 'API Token',
			name: 'token',
			type: 'string',
			typeOptions: { password: true },
			default: '',
			placeholder: 'bw_...',
			description:
				'A prepaid credit token. Buy credit once at https://blurwerk.de/credit — the token is shown once, store it here.',
		},
		{
			displayName: 'Base URL',
			name: 'baseUrl',
			type: 'string',
			default: 'https://blurwerk.de',
		},
	];

	authenticate: IAuthenticateGeneric = {
		type: 'generic',
		properties: {
			headers: { Authorization: '=Bearer {{$credentials.token}}' },
		},
	};

	test: ICredentialTestRequest = {
		request: {
			baseURL: '={{$credentials.baseUrl}}',
			url: '/api/credits/balance',
		},
	};
}

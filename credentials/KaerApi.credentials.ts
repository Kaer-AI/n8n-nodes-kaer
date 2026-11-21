import type {
	IAuthenticateGeneric,
	Icon,
	ICredentialTestRequest,
	ICredentialType,
	INodeProperties,
} from 'n8n-workflow';

export class KaerApi implements ICredentialType {
	name = 'kaerApi';

	displayName = 'Kaer API';

	icon: Icon = { light: 'file:../nodes/Kaer/kaer.svg', dark: 'file:../nodes/Kaer/kaer.dark.svg' };

	documentationUrl = 'https://github.com/Kaer-AI/n8n-nodes-kaer?tab=readme-ov-file#credentials';

	properties: INodeProperties[] = [
		{
			displayName: 'API Key',
			name: 'apiKey',
			type: 'string',
			typeOptions: { password: true },
			required: true,
			default: '',
			description:
				'A Kaer API key with the search scope. Create one under API keys at https://api.kaer.ai.',
		},
		{
			displayName: 'Base URL',
			name: 'baseUrl',
			type: 'string',
			required: true,
			default: 'https://api.kaer.ai/v1',
			description: 'Leave as it is unless Kaer gave you another address to test against',
		},
	];

	authenticate: IAuthenticateGeneric = {
		type: 'generic',
		properties: {
			headers: {
				Authorization: '=Bearer {{$credentials.apiKey}}',
			},
		},
	};

	// GET /me is free and only reads the calling key, so testing the
	// credential never runs (or bills) a search.
	test: ICredentialTestRequest = {
		request: {
			baseURL: '={{$credentials.baseUrl}}',
			url: '/me',
			method: 'GET',
		},
		rules: [
			{
				type: 'responseCode',
				properties: {
					value: 401,
					message:
						'Kaer did not accept this API key. Check it, or create a new key at https://api.kaer.ai.',
				},
			},
			{
				type: 'responseCode',
				properties: {
					value: 403,
					message:
						"403 from GET /v1/me: check the key's IP allow-list and that the Kaer account is active. If this key is search-only and the IP list is fine, save it anyway: searches still run.",
				},
			},
		],
	};
}

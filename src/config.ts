import 'dotenv/config';

function require(key: string): string {
  const val = process.env[key];
  if (!val) throw new Error(`Missing required env var: ${key}`);
  return val;
}

export const config = {
  flowntAuthToken:   require('FLOWNT_AUTH_TOKEN'),
  flowntEdgeUrl:     require('FLOWNT_EDGE_URL'),
  adapterType:       (process.env.ADAPTER_TYPE ?? 'moonraker') as 'moonraker',
  adapterUrl:        require('ADAPTER_URL'),
  adapterApiKey:     process.env.ADAPTER_API_KEY ?? '',
  pollingIntervalMs: (parseInt(process.env.POLLING_INTERVAL_S ?? '30') * 1000),
};

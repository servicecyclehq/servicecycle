/**
 * cloudConnectors/index.js
 *
 * Dispatcher — maps a provider string to its module.
 * All callers import from here rather than requiring individual provider files.
 */

const aws   = require('./aws');
const azure = require('./azure');
const gcp   = require('./gcp');

const PROVIDERS = { aws, azure, gcp };

const VALID_PROVIDERS = Object.keys(PROVIDERS);

/**
 * Get the module for a given provider string.
 * Throws if the provider is unknown.
 */
function getProvider(provider) {
  const mod = PROVIDERS[provider];
  if (!mod) throw new Error(`Unknown cloud provider: "${provider}". Valid values: ${VALID_PROVIDERS.join(', ')}`);
  return mod;
}

/**
 * Metadata shown in the "add connector" UI for each provider.
 * Separate from the per-provider FIELDS so the listing card doesn't need to
 * load the full module.
 */
const PROVIDER_META = {
  aws: {
    id:          'aws',
    name:        'Amazon Web Services',
    shortName:   'AWS',
    description: 'Import software subscriptions and Marketplace purchases from your AWS account.',
    color:       '#FF9900',
    bgColor:     '#fff8f0',
    borderColor: '#f5d08a',
  },
  azure: {
    id:          'azure',
    name:        'Microsoft Azure',
    shortName:   'Azure',
    description: 'Import Azure Marketplace purchases and software subscriptions from your Microsoft tenant.',
    color:       '#0078d4',
    bgColor:     '#eff6ff',
    borderColor: '#bfdbfe',
  },
  gcp: {
    id:          'gcp',
    name:        'Google Cloud',
    shortName:   'GCP',
    description: 'Import Google Cloud Marketplace purchases and entitlements from your GCP billing account.',
    color:       '#4285f4',
    bgColor:     '#f0f4ff',
    borderColor: '#c7d7fd',
  },
};

module.exports = { getProvider, VALID_PROVIDERS, PROVIDER_META };

export {};

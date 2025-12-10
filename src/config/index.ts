import dotenv from 'dotenv';

dotenv.config();

export const config = {
  server: {
    port: parseInt(process.env.PORT || '3051', 10),
    host: process.env.HOST || '127.0.0.1',
  },
  socket: {
    path: process.env.SOCKET_PATH || '/socket.io',
    corsOrigin: process.env.CORS_ORIGIN || 'http://localhost:3050',
  },
  database: {
    host: process.env.POSTGRES_HOST || 'localhost',
    port: parseInt(process.env.POSTGRES_PORT || '5432', 10),
    database: process.env.POSTGRES_DB || 'blockchess_db',
    user: process.env.POSTGRES_USER || 'postgres',
    password: process.env.POSTGRES_PASSWORD || 'password',
    ssl: process.env.POSTGRES_SSL === 'true',
  },
  sui: {
    network: process.env.SUI_NETWORK || 'localnet',
    networkUrl: process.env.SUI_NETWORK_URL,
    packageIds: {
      localnet: process.env.SUI_NETWORK_LOCALNET_PACKAGE_ID || '',
      testnet: process.env.SUI_NETWORK_TESTNET_PACKAGE_ID || '',
      mainnet: process.env.SUI_NETWORK_MAINNET_PACKAGE_ID || '',
    },
    badgeRegistryIds: {
      localnet: process.env.SUI_NETWORK_LOCALNET_BADGE_REGISTRY_ID || '',
      testnet: process.env.SUI_NETWORK_TESTNET_BADGE_REGISTRY_ID || '',
      mainnet: process.env.SUI_NETWORK_MAINNET_BADGE_REGISTRY_ID || '',
    },
    sponsor: {
      privateKey: process.env.SUI_SPONSOR_PRIVATE_KEY || '',
      address: process.env.SUI_SPONSOR_ADDRESS || '',
      gasBudget: BigInt(process.env.SUI_GAS_BUDGET || '100000000'),
    },
  },
  queue: {
    processingIntervalMs: parseInt(process.env.QUEUE_PROCESSING_INTERVAL_MS || '1000', 10),
    maxRetries: parseInt(process.env.QUEUE_MAX_RETRIES || '3', 10),
    retryDelayMs: parseInt(process.env.QUEUE_RETRY_DELAY_MS || '5000', 10),
  },
  logging: {
    level: process.env.LOG_LEVEL || 'info',
  },
};

export function getPackageId(): string {
  const packageId = config.sui.packageIds[config.sui.network as keyof typeof config.sui.packageIds];
  if (!packageId) {
    throw new Error(`Package ID not set for network: ${config.sui.network}`);
  }
  return packageId;
}

export function getBadgeRegistryId(): string {
  const registryId = config.sui.badgeRegistryIds[config.sui.network as keyof typeof config.sui.badgeRegistryIds];
  if (!registryId) {
    throw new Error(`Badge Registry ID not set for network: ${config.sui.network}`);
  }
  return registryId;
}


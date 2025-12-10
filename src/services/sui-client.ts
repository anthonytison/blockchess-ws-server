import { SuiClient, getFullnodeUrl } from '@mysten/sui/client';
import { Transaction } from '@mysten/sui/transactions';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { fromHEX } from '@mysten/sui/utils';
import { decodeSuiPrivateKey } from '@mysten/sui/cryptography';
import { config, getPackageId, getBadgeRegistryId } from '../config/index.js';
import { logger } from '../utils/logger.js';
import {
  CreateGameTransactionData,
  MakeMoveTransactionData,
  EndGameTransactionData,
  MintNftTransactionData,
} from '../types/index.js';

let suiClient: SuiClient | null = null;
let sponsorKeypair: Ed25519Keypair | null = null;

export function getSuiClient(): SuiClient {
  if (!suiClient) {
    const url = config.sui.networkUrl || getFullnodeUrl(config.sui.network as any);
    suiClient = new SuiClient({ url });
    logger.info(`Initialized Sui client for network: ${config.sui.network}`);
  }
  return suiClient;
}

export function getSponsorKeypair(): Ed25519Keypair {
  if (!sponsorKeypair) {
    let privateKey = config.sui.sponsor.privateKey;
    if (!privateKey) {
      throw new Error('SUI_SPONSOR_PRIVATE_KEY environment variable is required');
    }

    // Strip whitespace
    privateKey = privateKey.trim();

    try {
      // Check if it's a mnemonic phrase (12 or 24 words separated by spaces)
      const words = privateKey.split(/\s+/);
      if (words.length === 12 || words.length === 24) {
        // Derive keypair from mnemonic phrase
        sponsorKeypair = Ed25519Keypair.deriveKeypair(privateKey);
        logger.info(`Initialized sponsor keypair from mnemonic phrase for address: ${sponsorKeypair.toSuiAddress()}`);
      }
      // Check if it's a Bech32 format (starts with "suiprivkey")
      else if (privateKey.startsWith('suiprivkey')) {
        // Decode Bech32 format using Sui SDK
        const { secretKey } = decodeSuiPrivateKey(privateKey);
        sponsorKeypair = Ed25519Keypair.fromSecretKey(secretKey);
        logger.info(`Initialized sponsor keypair from Bech32 format for address: ${sponsorKeypair.toSuiAddress()}`);
      }
      // Handle hex format
      else {
        let privateKeyHex = privateKey;
        
        // Remove "0x" prefix if present
        if (privateKeyHex.startsWith('0x') || privateKeyHex.startsWith('0X')) {
          privateKeyHex = privateKeyHex.slice(2);
        }

        // Validate hex string format (should be 64 characters for Ed25519 private key)
        if (!/^[0-9a-fA-F]{64}$/.test(privateKeyHex)) {
          throw new Error(
            'Invalid SUI_SPONSOR_PRIVATE_KEY format. Expected one of:\n' +
            '  - Mnemonic phrase (12 or 24 words)\n' +
            '  - 64-character hex string (with or without 0x prefix)\n' +
            '  - Bech32 format (suiprivkey...)\n' +
            `Got ${privateKeyHex.length} characters.`
          );
        }

        const privateKeyBytes = fromHEX(privateKeyHex);
        sponsorKeypair = Ed25519Keypair.fromSecretKey(privateKeyBytes);
        logger.info(`Initialized sponsor keypair from hex format for address: ${sponsorKeypair.toSuiAddress()}`);
      }
    } catch (error) {
      logger.error('Failed to initialize sponsor keypair', error);
      throw new Error(
        `Invalid SUI_SPONSOR_PRIVATE_KEY format: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }
  return sponsorKeypair;
}

export function buildCreateGameTransaction(data: CreateGameTransactionData): Transaction {
  const packageId = getPackageId();
  const tx = new Transaction();

  tx.moveCall({
    target: `${packageId}::game::create_game`,
    arguments: [
      tx.pure.u8(data.mode),
      tx.pure.u8(data.difficulty),
      tx.object('0x6'), // Sui Clock object
    ],
  });

  return tx;
}

export function buildMakeMoveTransaction(data: MakeMoveTransactionData): Transaction {
  const packageId = getPackageId();
  const tx = new Transaction();

  tx.moveCall({
    target: `${packageId}::game::make_move`,
    arguments: [
      tx.object(data.gameObjectId),
      tx.pure.bool(data.isComputer),
      tx.pure.string(data.moveSan),
      tx.pure.string(data.fen),
      tx.pure.string(data.moveHash),
      tx.object('0x6'), // Sui Clock object
    ],
  });

  return tx;
}

export function buildEndGameTransaction(data: EndGameTransactionData): Transaction {
  const packageId = getPackageId();
  const tx = new Transaction();

  const winnerArg = data.winner
    ? tx.pure.vector('address', [data.winner])
    : tx.pure.vector('address', []);

  tx.moveCall({
    target: `${packageId}::game::end_game`,
    arguments: [
      tx.object(data.gameObjectId),
      winnerArg,
      tx.pure.string(data.result),
      tx.pure.string(data.finalFen),
      tx.object('0x6'), // Sui Clock object
    ],
  });

  return tx;
}

export function buildMintNftTransaction(data: MintNftTransactionData): Transaction {
  const packageId = getPackageId();
  const registryId = data.registryObjectId || getBadgeRegistryId();
  const tx = new Transaction();

  if (!registryId) {
    throw new Error('BadgeRegistry object ID is required');
  }

  logger.info('Building mint_badge transaction', {
    packageId,
    registryId,
    recipientAddress: data.recipientAddress,
    badgeType: data.badgeType,
  });

  // BadgeRegistry is a shared object - tx.object() will automatically get the latest version
  tx.moveCall({
    target: `${packageId}::badge::mint_badge`,
    arguments: [
      tx.object(registryId),
      tx.pure.address(data.recipientAddress),
      tx.pure.string(data.badgeType),
      tx.pure.string(data.name),
      tx.pure.string(data.description),
      tx.pure.string(data.sourceUrl),
    ],
  });

  return tx;
}

export function buildSetAuthorizedMinterTransaction(
  registryId: string,
  newMinterAddress: string
): Transaction {
  const packageId = getPackageId();
  const tx = new Transaction();

  tx.moveCall({
    target: `${packageId}::badge::set_authorized_minter`,
    arguments: [
      tx.object(registryId),
      tx.pure.address(newMinterAddress),
    ],
  });

  return tx;
}

export async function executeTransactionWithKeypair(
  transaction: Transaction,
  keypair: Ed25519Keypair
): Promise<{
  digest: string;
  objectId?: string;
}> {
  const client = getSuiClient();
  const signerAddress = keypair.toSuiAddress();

  try {
    // Get gas coins from signer account for transaction payment
    const gasCoins = await client.getCoins({
      owner: signerAddress,
      coinType: '0x2::sui::SUI',
    });

    if (gasCoins.data.length === 0) {
      throw new Error(
        `No SUI coins found for address ${signerAddress}. ` +
        `Please fund the account with SUI tokens to pay for gas fees.`
      );
    }

    const gasCoin = gasCoins.data[0];
    
    const coinObject = await client.getObject({
      id: gasCoin.coinObjectId,
      options: {
        showType: true,
        showOwner: true,
        showPreviousTransaction: true,
      },
    });

    if (!coinObject.data) {
      throw new Error(`Failed to fetch coin object ${gasCoin.coinObjectId}`);
    }

    transaction.setGasBudget(config.sui.sponsor.gasBudget);
    transaction.setGasPayment([
      {
        objectId: coinObject.data.objectId,
        version: coinObject.data.version,
        digest: coinObject.data.digest,
      },
    ]);

    const result = await client.signAndExecuteTransaction({
      signer: keypair,
      transaction,
      options: {
        showEffects: true,
        showObjectChanges: true,
        showEvents: true,
      },
    });

    // Check if transaction actually succeeded
    if (result.effects?.status?.status !== 'success') {
      const errorMessage = result.effects?.status?.error || 'Transaction failed';
      logger.error(`Transaction failed: ${errorMessage}`, {
        digest: result.digest,
        effects: result.effects,
      });
      throw new Error(`Transaction execution failed: ${errorMessage}`);
    }

    logger.info(`Transaction executed successfully: ${result.digest}`, {
      objectChanges: result.objectChanges?.length || 0,
      events: result.events?.length || 0,
    });

    return {
      digest: result.digest,
    };
  } catch (error) {
    logger.error('Failed to execute transaction', error);
    throw error;
  }
}

export async function executeTransaction(transaction: Transaction): Promise<{
  digest: string;
  objectId?: string;
}> {
  const keypair = getSponsorKeypair();
  return executeTransactionWithKeypair(transaction, keypair);
}

export async function waitForTransactionAndExtractObjectId(
  digest: string,
  objectType: string
): Promise<string | null> {
  const client = getSuiClient();
  const maxRetries = 15;
  const delay = 1000;

  for (let i = 0; i < maxRetries; i++) {
    try {
      const txResponse = await client.getTransactionBlock({
        digest,
        options: {
          showEffects: true,
          showObjectChanges: true,
          showEvents: true,
        },
      });

      if (txResponse.effects && txResponse.effects.status.status !== 'success') {
        throw new Error(`Transaction failed: ${txResponse.effects.status.status}`);
      }

      logger.debug(`[waitForTransactionAndExtractObjectId] Attempt ${i + 1}/${maxRetries} for ${objectType}`, {
        digest,
        objectChangesCount: txResponse.objectChanges?.length || 0,
        eventsCount: txResponse.events?.length || 0,
      });

      // Log all object changes for debugging
      if (txResponse.objectChanges && txResponse.objectChanges.length > 0) {
        logger.debug(`[waitForTransactionAndExtractObjectId] Object changes:`, 
          txResponse.objectChanges.map((change: any) => ({
            type: change.type,
            objectType: change.objectType,
            objectId: change.objectId,
          }))
        );
      }

      const createdChange = txResponse.objectChanges?.find(
        (change: any) => {
          if (change.type !== 'created' || !change.objectType) {
            return false;
          }
          // More flexible matching: check if objectType contains the key parts
          const objectTypeStr = change.objectType.toLowerCase();
          const searchType = objectType.toLowerCase();
          return (
            objectTypeStr.includes(searchType) ||
            objectTypeStr.endsWith(searchType) ||
            (searchType.includes('badge') && objectTypeStr.includes('badge')) ||
            (searchType.includes('game') && objectTypeStr.includes('game'))
          );
        }
      );

      if (createdChange && 'objectId' in createdChange) {
        logger.info(`[waitForTransactionAndExtractObjectId] Found object ID from objectChanges: ${createdChange.objectId}`);
        return createdChange.objectId as string;
      }

      if (objectType.includes('Game')) {
        const gameCreatedEvent = txResponse.events?.find(
          (event: any) => event.type?.includes('GameCreated')
        );
        if (gameCreatedEvent && gameCreatedEvent.parsedJson && typeof gameCreatedEvent.parsedJson === 'object' && 'game_id' in gameCreatedEvent.parsedJson) {
          return (gameCreatedEvent.parsedJson as { game_id: string }).game_id;
        }
      }

      // Check for BadgeMinted event if looking for badge
      if (objectType.includes('badge') || objectType.includes('Badge')) {
        // Log all events for debugging
        if (txResponse.events && txResponse.events.length > 0) {
          logger.debug(`[waitForTransactionAndExtractObjectId] Events:`, 
            txResponse.events.map((event: any) => ({
              type: event.type,
              parsedJson: event.parsedJson,
            }))
          );
        }
        
        const badgeMintedEvent = txResponse.events?.find(
          (event: any) => event.type?.includes('BadgeMinted')
        );
        if (badgeMintedEvent && badgeMintedEvent.parsedJson && typeof badgeMintedEvent.parsedJson === 'object' && 'badge_id' in badgeMintedEvent.parsedJson) {
          const badgeId = (badgeMintedEvent.parsedJson as { badge_id: string }).badge_id;
          logger.info(`[waitForTransactionAndExtractObjectId] Extracted badge ID from BadgeMinted event: ${badgeId}`);
          return badgeId;
        }
      }
    } catch (error) {
      if (i === maxRetries - 1) {
        logger.error(`Failed to extract object_id after ${maxRetries} retries`, error);
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  return null;
}


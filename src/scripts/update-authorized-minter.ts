#!/usr/bin/env tsx

/**
 * Script to update the authorized minter in BadgeRegistry
 * 
 * This script updates the authorized_minter field in the BadgeRegistry
 * to match the sponsor address from the environment configuration.
 * 
 * Usage:
 *   tsx src/scripts/update-authorized-minter.ts
 * 
 * Required Environment Variables:
 *   - SUI_DEPLOYER_PRIVATE_KEY: Private key of the current authorized_minter (deployer)
 *   - SUI_SPONSOR_PRIVATE_KEY: Private key of the sponsor (new authorized_minter)
 * 
 * Note: The transaction must be signed by the current authorized_minter
 * (usually the deployer address). If you don't have access to that key,
 * you'll need to redeploy the package with the sponsor keypair.
 */

import dotenv from 'dotenv';
import { getSuiClient, getSponsorKeypair, buildSetAuthorizedMinterTransaction, executeTransactionWithKeypair } from '../services/sui-client.js';
import { logger } from '../utils/logger.js';
import { getBadgeRegistryId } from '../config/index.js';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { fromHEX } from '@mysten/sui/utils';
import { decodeSuiPrivateKey } from '@mysten/sui/cryptography';

dotenv.config();

function getDeployerKeypair(): Ed25519Keypair {
  let privateKey = process.env.SUI_DEPLOYER_PRIVATE_KEY;
  if (!privateKey) {
    throw new Error('SUI_DEPLOYER_PRIVATE_KEY environment variable is required. This should be the private key of the current authorized_minter (deployer).');
  }

  privateKey = privateKey.trim();

  try {
    // Check if it's a mnemonic phrase
    const words = privateKey.split(/\s+/);
    if (words.length === 12 || words.length === 24) {
      return Ed25519Keypair.deriveKeypair(privateKey);
    }
    // Check if it's Bech32 format
    else if (privateKey.startsWith('suiprivkey')) {
      const { secretKey } = decodeSuiPrivateKey(privateKey);
      return Ed25519Keypair.fromSecretKey(secretKey);
    }
    // Handle hex format
    else {
      let privateKeyHex = privateKey;
      if (privateKeyHex.startsWith('0x') || privateKeyHex.startsWith('0X')) {
        privateKeyHex = privateKeyHex.slice(2);
      }
      if (!/^[0-9a-fA-F]{64}$/.test(privateKeyHex)) {
        throw new Error('Invalid SUI_DEPLOYER_PRIVATE_KEY format');
      }
      const privateKeyBytes = fromHEX(privateKeyHex);
      return Ed25519Keypair.fromSecretKey(privateKeyBytes);
    }
  } catch (error) {
    throw new Error(`Invalid SUI_DEPLOYER_PRIVATE_KEY format: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
}

async function updateAuthorizedMinter() {
  try {
    const client = getSuiClient();
    const sponsorKeypair = getSponsorKeypair();
    const sponsorAddress = sponsorKeypair.toSuiAddress();
    const deployerKeypair = getDeployerKeypair();
    const deployerAddress = deployerKeypair.toSuiAddress();
    const registryId = getBadgeRegistryId();

    logger.info(`Deployer Address (signer): ${deployerAddress}`);
    logger.info(`Sponsor Address (new minter): ${sponsorAddress}`);
    logger.info(`Using BadgeRegistry: ${registryId}`);

    // First, let's check the current authorized minter
    let currentMinter: string;
    try {
      const registryObject = await client.getObject({
        id: registryId,
        options: {
          showContent: true,
        },
      });

      if (registryObject.data?.content && 'fields' in registryObject.data.content) {
        const fields = registryObject.data.content.fields as any;
        currentMinter = fields.authorized_minter;
        logger.info(`Current authorized minter: ${currentMinter}`);
        
        if (currentMinter === sponsorAddress) {
          logger.info('✅ Authorized minter already matches sponsor address. No update needed.');
          return;
        }

        // Verify deployer is the current minter
        if (currentMinter !== deployerAddress) {
          logger.error(`❌ ERROR: Deployer address (${deployerAddress}) does not match current authorized_minter (${currentMinter})`);
          logger.error('You must use the keypair that matches the current authorized_minter to update it.');
          process.exit(1);
        }

        logger.info(`Will update from ${currentMinter} to ${sponsorAddress}`);
      } else {
        throw new Error('Invalid BadgeRegistry object format');
      }
    } catch (error) {
      logger.error('Failed to fetch BadgeRegistry object', error);
      throw error;
    }

    // Build transaction
    const tx = buildSetAuthorizedMinterTransaction(registryId, sponsorAddress);
    
    // Execute with deployer keypair (not sponsor)
    const result = await executeTransactionWithKeypair(tx, deployerKeypair);

    logger.info(`Successfully updated authorized minter! Transaction digest: ${result.digest}`);
    logger.info(`Authorized minter is now: ${sponsorAddress}`);
  } catch (error) {
    logger.error('Failed to update authorized minter', error);
    if (error instanceof Error) {
      if (error.message.includes('MoveAbort') && error.message.includes('2')) {
        logger.error('Error: Unauthorized. The transaction must be signed by the current authorized minter.');
        logger.error('Solution: Either use the deployer keypair, or redeploy the package with the sponsor keypair.');
      }
    }
    process.exit(1);
  }
}

updateAuthorizedMinter();


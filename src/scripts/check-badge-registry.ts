#!/usr/bin/env tsx

/**
 * Diagnostic script to check BadgeRegistry status
 * 
 * This script checks:
 * 1. Current authorized_minter address
 * 2. Sponsor address (from config)
 * 3. Whether they match
 * 4. Provides instructions on how to fix if they don't match
 * 
 * Usage:
 *   tsx src/scripts/check-badge-registry.ts
 */

import dotenv from 'dotenv';
import { getSuiClient, getSponsorKeypair } from '../services/sui-client.js';
import { logger } from '../utils/logger.js';
import { getBadgeRegistryId } from '../config/index.js';

dotenv.config();

async function checkBadgeRegistry() {
  try {
    const client = getSuiClient();
    const sponsorKeypair = getSponsorKeypair();
    const sponsorAddress = sponsorKeypair.toSuiAddress();
    const registryId = getBadgeRegistryId();

    logger.info('=== BadgeRegistry Diagnostic ===');
    logger.info(`BadgeRegistry ID: ${registryId}`);
    logger.info(`Sponsor Address: ${sponsorAddress}`);

    // Fetch BadgeRegistry object
    const registryObject = await client.getObject({
      id: registryId,
      options: {
        showContent: true,
      },
    });

    if (!registryObject.data?.content || !('fields' in registryObject.data.content)) {
      logger.error('Failed to fetch BadgeRegistry object or invalid format');
      return;
    }

    const fields = registryObject.data.content.fields as any;
    const authorizedMinter = fields.authorized_minter;

    logger.info(`Authorized Minter: ${authorizedMinter}`);
    logger.info('');

    // Check if they match
    if (authorizedMinter === sponsorAddress) {
      logger.info('✅ SUCCESS: Authorized minter matches sponsor address!');
      logger.info('NFT minting should work correctly.');
      return;
    }

    // They don't match - provide instructions
    logger.error('❌ PROBLEM: Authorized minter does NOT match sponsor address!');
    logger.error('');
    logger.error('This is why NFT minting is failing with MoveAbort error code 1.');
    logger.error('');
    logger.error('=== Solutions ===');
    logger.error('');
    logger.error('OPTION 1: Update authorized_minter (if you have deployer keypair)');
    logger.error('  1. Set SUI_DEPLOYER_PRIVATE_KEY environment variable to the deployer keypair');
    logger.error('  2. Run: tsx src/scripts/update-authorized-minter.ts');
    logger.error('');
    logger.error('OPTION 2: Redeploy package with sponsor keypair (Recommended)');
    logger.error('  1. cd ../blockchess');
    logger.error('  2. Make sure SUI_SPONSOR_PRIVATE_KEY is set in your environment');
    logger.error('  3. sui move build');
    logger.error('  4. sui client publish --gas-budget 100000000');
    logger.error('  5. Update SUI_NETWORK_*_BADGE_REGISTRY_ID with the new registry ID');
    logger.error('');
    logger.error('OPTION 3: Use deployer keypair as sponsor (if deployer = sponsor)');
    logger.error('  Set SUI_SPONSOR_PRIVATE_KEY to the deployer private key');
    logger.error('');
  } catch (error) {
    logger.error('Failed to check BadgeRegistry', error);
    if (error instanceof Error) {
      logger.error(`Error: ${error.message}`);
    }
    process.exit(1);
  }
}

checkBadgeRegistry();


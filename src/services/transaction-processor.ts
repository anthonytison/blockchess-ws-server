/**
 * Transaction Processor - Executes blockchain transactions and handles results
 * 
 * This module processes transactions from the queue by:
 * 1. Building the appropriate Sui transaction based on type
 * 2. Executing it on the blockchain (with transaction sponsoring)
 * 3. Extracting object IDs from transaction results
 * 4. Updating the database with the results
 * 5. Notifying the frontend via Socket.IO
 */

import { Server as SocketIOServer } from 'socket.io';
import { Transaction } from '@mysten/sui/transactions';
import { logger } from '../utils/logger.js';
import {
  TransactionQueueItem,
  TransactionType,
} from '../types/index.js';
import {
  buildCreateGameTransaction,
  buildMakeMoveTransaction,
  buildEndGameTransaction,
  buildMintNftTransaction,
  executeTransaction,
  waitForTransactionAndExtractObjectId,
  getSponsorKeypair,
} from './sui-client.js';
import {
  updateGameObjectId,
  createOrUpdateReward,
  getWaitingTransactionsForGame,
  updateWaitingTransactionWithObjectId,
} from './database.js';

/**
 * Processes a single transaction from the queue
 * 
 * This function:
 * - Builds the appropriate Sui transaction based on type
 * - Executes it on-chain (gas is paid by sponsor account)
 * - Extracts object IDs from transaction results
 * - Updates database with the results
 * - Sends notifications to the frontend
 * 
 * @param transaction - The transaction queue item to process
 * @param io - Socket.IO server instance for sending notifications
 */
export async function processTransaction(
  transaction: TransactionQueueItem,
  io: SocketIOServer
): Promise<void> {
  logger.info(
    `[processTransaction] Processing transaction: id=${transaction.id}, type=${transaction.transaction_type}, player=${transaction.player_sui_address}`
  );

  let tx: Transaction;

  // Build the transaction based on its type
  switch (transaction.transaction_type) {
    case 'create_game':
      logger.debug(`[processTransaction] Building create_game transaction: ${transaction.id}`);
      tx = buildCreateGameTransaction(transaction.transaction_data as any);
      break;
    case 'make_move':
      logger.debug(`[processTransaction] Building make_move transaction: ${transaction.id}`);
      tx = buildMakeMoveTransaction(transaction.transaction_data as any);
      break;
    case 'end_game':
      logger.debug(`[processTransaction] Building end_game transaction: ${transaction.id}`);
      tx = buildEndGameTransaction(transaction.transaction_data as any);
      break;
    case 'mint_nft':
      try {
        logger.debug(`[processTransaction] Building mint_nft transaction: ${transaction.id}`);
        const mintData = transaction.transaction_data as any;
        // Get sponsor keypair - this is the account that will pay for gas
        // For NFT minting, the sponsor address must match the authorized_minter
        // in the BadgeRegistry, or the recipient must be the sponsor (self-mint)
        const sponsorKeypair = getSponsorKeypair();
        const sponsorAddress = sponsorKeypair.toSuiAddress();
        logger.info(
          `[processTransaction] Minting NFT: badgeType=${mintData.badgeType}, recipient=${mintData.recipientAddress}, playerId=${transaction.player_id}, sponsorAddress=${sponsorAddress}`
        );
        logger.info(
          `[processTransaction] Authorization check: sponsor=${sponsorAddress}, recipient=${mintData.recipientAddress}, isSelfMint=${sponsorAddress === mintData.recipientAddress}`
        );
        tx = buildMintNftTransaction(transaction.transaction_data as any);
      } catch (error) {
        logger.error(`[processTransaction] Failed to build mint_nft transaction: ${transaction.id}`, error);
        throw error;
      }
      break;
    default:
      const error = `Unknown transaction type: ${transaction.transaction_type}`;
      logger.error(`[processTransaction] ${error}`);
      throw new Error(error);
  }

  // Execute the transaction on the Sui blockchain
  // All transactions are sponsored (gas paid by server) for better user experience
  let result;
  try {
    logger.info(`[processTransaction] Executing transaction: ${transaction.id}`);
    result = await executeTransaction(tx);
    logger.info(`[processTransaction] Transaction executed successfully: ${transaction.id}, digest=${result.digest}`);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Transaction execution failed';
    logger.error(`[processTransaction] Transaction ${transaction.id} execution failed: ${errorMessage}`, error);
    
    // Special handling for NFT minting authorization errors
    // Error code 1 in badge.move means InvalidRecipient - usually means sponsor doesn't match authorized_minter
    if (transaction.transaction_type === 'mint_nft') {
      const errorStr = errorMessage.toLowerCase();
      if (errorStr.includes('moveabort') && errorStr.includes('1')) {
        logger.error('[processTransaction] NFT minting failed: authorized_minter mismatch. The sponsor address does not match the authorized_minter in BadgeRegistry.');
        logger.error('[processTransaction] Solution: Either redeploy the package with the sponsor keypair, or call set_authorized_minter to update it.');
        logger.error('[processTransaction] To update: Run the update-authorized-minter script with the deployer keypair.');
      }
    }
    
    throw new Error(`Transaction execution failed: ${errorMessage}`);
  }

  // Extract object IDs from transaction results and update database
  let objectId: string | undefined;

  if (transaction.transaction_type === 'create_game') {
    try {
      logger.debug(`[processTransaction] Extracting game object ID from transaction: ${transaction.id}`);
      objectId = await waitForTransactionAndExtractObjectId(result.digest, '::game::Game');
      if (objectId && transaction.game_id) {
        logger.info(`[processTransaction] Game object ID extracted: ${objectId} for game ${transaction.game_id}`);
        await updateGameObjectId(transaction.game_id, objectId);
        
        // Process any waiting moves for this game
        await processWaitingMovesForGame(transaction.game_id, objectId, io);
      }
    } catch (error) {
      logger.error(`[processTransaction] Failed to update game object_id (transaction succeeded): ${transaction.id}`, error);
    }
  } else if (transaction.transaction_type === 'mint_nft') {
    try {
      const data = transaction.transaction_data as any;
      logger.info(`[processTransaction] Processing mint_nft transaction: ${transaction.id}`, {
        playerId: transaction.player_id,
        playerSuiAddress: transaction.player_sui_address,
        badgeType: data.badgeType,
        transactionDigest: result.digest,
      });
      
      logger.debug(`[processTransaction] Extracting badge object ID from transaction: ${transaction.id}, digest: ${result.digest}`);
      objectId = await waitForTransactionAndExtractObjectId(result.digest, 'badge::Badge');
      
      if (!objectId) {
        logger.error(`[processTransaction] Failed to extract badge object ID from transaction: ${transaction.id}`, {
          digest: result.digest,
          playerId: transaction.player_id,
          badgeType: data.badgeType,
        });
      } else if (!transaction.player_id) {
        logger.error(`[processTransaction] Missing player_id for mint_nft transaction: ${transaction.id}`, {
          objectId,
          playerSuiAddress: transaction.player_sui_address,
          badgeType: data.badgeType,
        });
      } else {
        logger.info(
          `[processTransaction] Badge object ID extracted: ${objectId} for player ${transaction.player_id}, badgeType=${data.badgeType}`
        );
        
        try {
          await createOrUpdateReward(transaction.player_id, data.badgeType, objectId);
          logger.info(`[processTransaction] ✅ Reward saved to database: playerId=${transaction.player_id}, badgeType=${data.badgeType}, objectId=${objectId}`);
        } catch (dbError) {
          logger.error(`[processTransaction] ❌ Database error saving reward: ${transaction.id}`, {
            error: dbError,
            playerId: transaction.player_id,
            badgeType: data.badgeType,
            objectId,
          });
          throw dbError; // Re-throw to be caught by outer catch
        }
      }
    } catch (error) {
      logger.error(`[processTransaction] Failed to create/update reward (transaction succeeded): ${transaction.id}`, {
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
        playerId: transaction.player_id,
        objectId,
      });
      // Don't throw - transaction succeeded on blockchain, just DB update failed
    }
  }

  const playerAddress = transaction.player_sui_address;
  if (playerAddress) {
    logger.info(`[processTransaction] Emitting transaction result to player: ${playerAddress}, transactionId=${transaction.id}`);
    
    // Include reward name for mint_nft transactions
    const transactionResult: any = {
      transactionId: transaction.id,
      status: 'success',
      digest: result.digest,
      objectId,
      timestamp: new Date().toISOString(),
    };
    
    if (transaction.transaction_type === 'mint_nft') {
      const data = transaction.transaction_data as any;
      transactionResult.rewardName = data.name;
      transactionResult.badgeType = data.badgeType;
    }
    
    io.to(`player:${playerAddress}`).emit('transaction:result', transactionResult);
  }

  logger.info(`[processTransaction] Transaction ${transaction.id} processed successfully`);
}

/**
 * Processes moves that were waiting for the game object ID
 * 
 * When a move transaction arrives before the game is created on-chain,
 * it's stored with status 'waiting_for_object_id'. Once the game is created
 * and we have the object ID, this function updates those waiting transactions
 * so they can be processed.
 * 
 * @param gameId - The database game ID
 * @param objectId - The Sui blockchain game object ID
 * @param io - Socket.IO server for notifications
 */
async function processWaitingMovesForGame(
  gameId: string,
  objectId: string,
  io: SocketIOServer
): Promise<void> {
  try {
    // Get all move transactions that were waiting for this game's object ID
    const waitingTransactions = await getWaitingTransactionsForGame(gameId);
    
    if (waitingTransactions.length === 0) {
      return;
    }
    
    logger.info(`Processing ${waitingTransactions.length} waiting transactions for game ${gameId}`);
    
    // Update each waiting transaction with the game object ID
    for (const transaction of waitingTransactions) {
      try {
        // Update transaction with object_id and change status to pending
        // The queue processor will then pick it up and execute it
        await updateWaitingTransactionWithObjectId(transaction.id, objectId);
        
        logger.info(`Updated waiting transaction ${transaction.id} for game ${gameId}`);
      } catch (error) {
        logger.error(`Failed to update waiting transaction ${transaction.id}`, error);
      }
    }
  } catch (error) {
    logger.error(`Failed to process waiting moves for game ${gameId}`, error);
  }
}


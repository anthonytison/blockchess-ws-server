import { z } from 'zod';
import {
  CreateGameTransactionData,
  MakeMoveTransactionData,
  EndGameTransactionData,
  MintNftTransactionData,
} from '../types/index.js';

export const createGameSchema = z.object({
  transactionId: z.string().min(1),
  gameId: z.string().min(1),
  playerAddress: z.string().min(1),
  data: z.object({
    mode: z.number().int().min(0).max(1),
    difficulty: z.number().int().min(0).max(2),
  }),
});

export const makeMoveSchema = z.object({
  transactionId: z.string().min(1),
  playerAddress: z.string().min(1),
  status: z.enum(['pending', 'waiting_for_object_id']).optional(),
  data: z.object({
    gameObjectId: z.string(), // Allow empty string for waiting moves
    isComputer: z.boolean(),
    moveSan: z.string().min(1),
    fen: z.string().min(1),
    moveHash: z.string().min(1),
    gameId: z.string().optional(), // Add gameId for waiting moves
  }),
});

export const endGameSchema = z.object({
  transactionId: z.string().min(1),
  playerAddress: z.string().min(1),
  data: z.object({
    gameObjectId: z.string().min(1),
    winner: z.string().nullable(),
    result: z.enum(['1-0', '0-1', '1/2-1/2']),
    finalFen: z.string().min(1),
  }),
});

export const mintNftSchema = z.object({
  transactionId: z.string().min(1),
  playerAddress: z.string().min(1),
  playerId: z.string().min(1),
  data: z.object({
    recipientAddress: z.string().min(1),
    badgeType: z.string().min(1),
    name: z.string().min(1),
    description: z.string().min(1),
    sourceUrl: z.string().url(),
    registryObjectId: z.string().optional(),
  }),
});

export function validateCreateGame(data: unknown): {
  transactionId: string;
  gameId: string;
  playerAddress: string;
  data: CreateGameTransactionData;
} {
  return createGameSchema.parse(data);
}

export function validateMakeMove(data: unknown): {
  transactionId: string;
  playerAddress: string;
  data: MakeMoveTransactionData;
} {
  return makeMoveSchema.parse(data);
}

export function validateEndGame(data: unknown): {
  transactionId: string;
  playerAddress: string;
  data: EndGameTransactionData;
} {
  return endGameSchema.parse(data);
}

export function validateMintNft(data: unknown): {
  transactionId: string;
  playerAddress: string;
  playerId: string;
  data: MintNftTransactionData;
} {
  return mintNftSchema.parse(data);
}


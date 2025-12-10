export type TransactionType = 'create_game' | 'make_move' | 'end_game' | 'mint_nft';

export type TransactionStatus = 'pending' | 'processing' | 'completed' | 'failed' | 'waiting_for_object_id';

export interface TransactionQueueItem {
  id: string;
  transaction_type: TransactionType;
  player_sui_address: string | null;
  game_id: string | null;
  player_id: string | null;
  status: TransactionStatus;
  transaction_data: Record<string, unknown>;
  error_message: string | null;
  created_at: Date;
  updated_at: Date;
  processed_at: Date | null;
  retries: number;
}

export interface CreateGameTransactionData {
  mode: number;
  difficulty: number;
}

export interface MakeMoveTransactionData {
  gameObjectId: string;
  isComputer: boolean;
  moveSan: string;
  fen: string;
  moveHash: string;
}

export interface EndGameTransactionData {
  gameObjectId: string;
  winner: string | null;
  result: '1-0' | '0-1' | '1/2-1/2';
  finalFen: string;
}

export interface MintNftTransactionData {
  recipientAddress: string;
  badgeType: string;
  name: string;
  description: string;
  sourceUrl: string;
  registryObjectId?: string;
}

export interface TransactionResult {
  transactionId: string;
  status: 'success' | 'error';
  digest?: string;
  objectId?: string;
  error?: string;
  timestamp: string;
}

export interface TransactionQueuedEvent {
  transactionId: string;
  status: 'queued';
  timestamp: string;
}

export interface TransactionProcessingEvent {
  transactionId: string;
  status: 'processing';
  timestamp: string;
}


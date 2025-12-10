# BlockChess WebSocket Server

Standalone Socket.IO server for handling all BlockChess blockchain transactions with transaction sponsoring. This server processes all blockchain operations via a queue system and handles transaction sponsoring so users don't need to pay gas fees.

## Features

- **Real-time Communication**: Socket.IO for bidirectional communication with front-end
- **Transaction Queue**: PostgreSQL-backed queue system for reliable transaction processing
- **Transaction Sponsoring**: All transactions are sponsored (gas paid by server)
- **Database Integration**: Automatic updates to PostgreSQL with object_ids after successful transactions
- **Transaction Types**: Supports create_game, make_move, end_game, and mint_nft transactions
- **Error Handling**: Comprehensive error handling with automatic retries
- **Scalable**: Designed for sequential processing per player

## Architecture

### Transaction Flow

```
Front-End (Socket.IO Client)
    ↓ Socket.IO Event
Socket.IO Server (Fastify)
    ↓ Add to Queue (PostgreSQL)
Queue System
    ↓ Process Sequentially
Sui Blockchain (with sponsoring)
    ↓ Transaction Response
Database Update (object_id)
    ↓ Socket.IO Event
Front-End (Notification)
```

### Queue System

- **Storage**: PostgreSQL table `transaction_queue`
- **Processing**: Sequential processing per player
- **Status**: `pending`, `processing`, `completed`, `failed`
- **Retry**: Automatic retry on failure with exponential backoff
- **Ordering**: Process transactions in order (FIFO per player)

## Installation

1. Clone the repository and navigate to the server directory:
```bash
cd back/ws-server
```

2. Install dependencies:
```bash
npm install
# or
pnpm install
```

3. Set up environment variables:
```bash
cp .env.example .env
# Edit .env with your configuration
```

4. Ensure PostgreSQL is running and the database exists

5. Build the project:
```bash
npm run build
```

6. Start the server:
```bash
npm start
# or for development
npm run dev
```

## Configuration

### Environment Variables

See `.env.example` for all available configuration options. Key variables:

- **Server**: `PORT`, `HOST`
- **Socket.IO**: `SOCKET_PATH`, `CORS_ORIGIN`
- **PostgreSQL**: `POSTGRES_HOST`, `POSTGRES_PORT`, `POSTGRES_DB`, etc.
- **Sui Network**: `SUI_NETWORK`, package IDs, badge registry IDs
- **Sponsoring**: `SUI_SPONSOR_PRIVATE_KEY`, `SUI_SPONSOR_ADDRESS`, `SUI_GAS_BUDGET`
- **Queue**: `QUEUE_PROCESSING_INTERVAL_MS`, `QUEUE_MAX_RETRIES`, `QUEUE_RETRY_DELAY_MS`

### Database Schema

The server automatically creates the `transaction_queue` table on startup. The schema includes:

- `id`: Unique transaction identifier
- `transaction_type`: Type of transaction (create_game, make_move, end_game, mint_nft)
- `player_sui_address`: Player's Sui address
- `game_id`: Database game ID (for create_game updates)
- `player_id`: Database player ID (for mint_nft updates)
- `status`: Transaction status (pending, processing, completed, failed)
- `transaction_data`: JSONB field with full transaction data
- `error_message`: Error message if transaction failed
- `retries`: Number of retry attempts
- Timestamps: `created_at`, `updated_at`, `processed_at`

## Socket.IO Events

### Client → Server Events

#### `transaction:create_game`
```typescript
{
  transactionId: string;
  gameId: string;
  playerAddress: string;
  data: {
    mode: number;        // 0 = solo, 1 = versus
    difficulty: number;  // 0 = easy, 1 = intermediate, 2 = hard
  }
}
```

#### `transaction:make_move`
```typescript
{
  transactionId: string;
  playerAddress: string;
  data: {
    gameObjectId: string;
    isComputer: boolean;
    moveSan: string;
    fen: string;
    moveHash: string;
  }
}
```

#### `transaction:end_game`
```typescript
{
  transactionId: string;
  playerAddress: string;
  data: {
    gameObjectId: string;
    winner: string | null;
    result: '1-0' | '0-1' | '1/2-1/2';
    finalFen: string;
  }
}
```

#### `transaction:mint_nft`
```typescript
{
  transactionId: string;
  playerAddress: string;
  playerId: string;
  data: {
    recipientAddress: string;
    badgeType: string;
    name: string;
    description: string;
    sourceUrl: string;
    registryObjectId?: string;
  }
}
```

#### `join-player-room`
```typescript
playerSuiAddress: string;
```

#### `leave-player-room`
```typescript
playerSuiAddress: string;
```

### Server → Client Events

#### `transaction:queued`
```typescript
{
  transactionId: string;
  status: 'queued';
  timestamp: string;
}
```

#### `transaction:processing`
```typescript
{
  transactionId: string;
  status: 'processing';
  timestamp: string;
}
```

#### `transaction:result`
```typescript
{
  transactionId: string;
  status: 'success' | 'error';
  digest?: string;        // Transaction digest (on success)
  objectId?: string;      // Extracted object_id (for create_game, mint_nft)
  error?: string;         // Error message (on error)
  timestamp: string;
}
```

#### `error`
```typescript
{
  error: string;
  transactionId?: string;
}
```

## Transaction Sponsoring

All transactions are sponsored by the server, meaning the server pays for gas fees on behalf of users. This provides a better user experience as users don't need to manage SUI tokens or approve transactions.

### How It Works

1. **Server Account**: The server uses `SUI_SPONSOR_PRIVATE_KEY` to sign and pay for all transactions
2. **Gas Payment**: The sponsor account must have sufficient SUI tokens for gas fees
3. **Authorization**: For NFT minting, the sponsor address must match `authorized_minter` in BadgeRegistry

### Badge Registry Authorization

For NFT badge minting to work, the sponsor address (derived from `SUI_SPONSOR_PRIVATE_KEY`) must match the `authorized_minter` in the `BadgeRegistry` on-chain object.

**If authorization errors occur**:
1. Check that `SUI_SPONSOR_ADDRESS` matches the `authorized_minter` in BadgeRegistry
2. If they don't match, use the `update-authorized-minter.ts` script to update it:
   ```bash
   npm run update-authorized-minter -- --registry-id <REGISTRY_ID> --new-minter <SPONSOR_ADDRESS>
   ```
3. Or redeploy the package with the sponsor keypair as the deployer

### Sponsor Account Setup

1. Create or import a keypair for the sponsor account
2. Fund it with SUI tokens (for gas fees)
3. Set `SUI_SPONSOR_PRIVATE_KEY` in `.env`
4. Optionally set `SUI_SPONSOR_ADDRESS` for validation
5. Ensure it matches `authorized_minter` in BadgeRegistry for NFT minting

## Transaction Processing

### Create Game
1. Transaction is queued
2. Transaction is built and executed on Sui blockchain
3. Game `object_id` is extracted from transaction response
4. `games.object_id` is updated in PostgreSQL
5. Front-end is notified of completion

### Make Move
1. Transaction is queued
2. Transaction is built and executed on Sui blockchain
3. Front-end is notified of completion
4. No database update needed

### End Game
1. Transaction is queued
2. Transaction is built and executed on Sui blockchain
3. Front-end is notified of completion
4. No database update needed

### Mint NFT
1. Transaction is queued
2. Transaction is built and executed on Sui blockchain
3. Badge `object_id` is extracted from transaction response
4. Record is created/updated in `rewards` table
5. Front-end is notified of completion

## Error Handling

- **Validation Errors**: Transactions are rejected with clear error messages
- **Transaction Failures**: Automatic retry with exponential backoff (max 3 retries)
- **Database Errors**: Logged but don't fail transaction processing (transaction already succeeded on blockchain)
- **Network Errors**: Retried automatically
- **Permanent Failures**: Marked as failed after max retries

## Development

### Project Structure

```
back/ws-server/
├── src/
│   ├── index.ts                 # Main entry point
│   ├── config/
│   │   └── index.ts             # Configuration management
│   ├── services/
│   │   ├── socket-server.ts     # Socket.IO server setup
│   │   ├── queue-service.ts     # Queue management
│   │   ├── transaction-processor.ts  # Process transactions
│   │   ├── sui-client.ts        # Sui blockchain client with sponsoring
│   │   └── database.ts          # PostgreSQL connection
│   ├── types/
│   │   └── index.ts             # TypeScript types
│   └── utils/
│       ├── validation.ts        # Transaction validation
│       └── logger.ts            # Logging utility
├── package.json
├── tsconfig.json
└── README.md
```

### Scripts

- `npm run dev`: Start development server with hot reload
- `npm run build`: Build TypeScript to JavaScript
- `npm start`: Start production server
- `npm run typecheck`: Type check without building
- `npm test`: Run tests

## Testing

```bash
npm test
```

## Deployment

### Docker (Optional)

Create a `Dockerfile`:

```dockerfile
FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --only=production
COPY dist ./dist
EXPOSE 3051
CMD ["node", "dist/index.js"]
```

### Environment Setup

Ensure all environment variables are set correctly for your deployment environment. The sponsor private key must be kept secure and never exposed.

## Security Considerations

- **Private Key Security**: The sponsor private key is stored in environment variables. Never commit it to version control.
- **CORS Configuration**: Configure `CORS_ORIGIN` to only allow requests from your front-end domain.
- **Database Security**: Use SSL connections for PostgreSQL in production.
- **Network Security**: Use HTTPS/WSS in production environments.

## Monitoring

The server provides a health check endpoint:

```bash
curl http://localhost:3051/health
```

Returns:
```json
{
  "status": "ok",
  "timestamp": "2024-01-01T00:00:00.000Z"
}
```

## Troubleshooting

### Common Issues

1. **Database Connection Failed**
   - Check PostgreSQL is running
   - Verify database credentials in `.env`
   - Ensure database exists

2. **Transaction Sponsoring Failed**
   - Verify `SUI_SPONSOR_PRIVATE_KEY` is set correctly
   - Check sponsor address has sufficient SUI for gas
   - Verify network configuration matches

3. **Package ID Not Found**
   - Ensure correct network type is set
   - Verify package ID for the network is correct
   - Check package is published to the network

4. **Object ID Not Extracted**
   - Transaction may have succeeded but object_id extraction failed
   - Check transaction digest in Sui explorer
   - Verify object type matches expected pattern

5. **NFT Authorization Errors**
   - Check that `SUI_SPONSOR_ADDRESS` matches `authorized_minter` in BadgeRegistry
   - Use `update-authorized-minter.ts` script to update if needed
   - Ensure BadgeRegistry object ID is correct in configuration

6. **Version Mismatch Errors**
   - Common with Sui shared objects when multiple transactions try to use the same version
   - Queue system automatically retries with longer delays
   - These errors are usually transient and resolve on retry

## License

MIT

